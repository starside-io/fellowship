// Link derivation. Links are stored with aPersonId < bPersonId to match the
// schema unique constraint. LinkStat caches the derived score; manualScore is
// applied by readers and never written over the derived value.
//
// Every function that reads or writes takes the silo as its first argument.
// Core owns no connection: the host hands one over through the storage port.

import type { TieType } from "../schemas/enums.js";
import type { Silo } from "../storage/client.js";
import {
  DEFAULT_SCORING,
  computePairScore,
  pairEffectiveSentiment,
  type PairEvent,
  type ScoringConfig,
} from "./scoring.js";

export interface PairKey {
  aPersonId: string;
  bPersonId: string;
}

export interface PairAggregate extends PairKey {
  score: number;
  eventCount: number;
  lastEventAt: Date | null;
  positiveCount: number;
  negativeCount: number;
}

export interface RecomputeResult {
  pairsProcessed: number;
  linksUpserted: number;
  linksCleared: number;
  linksDeleted: number;
}

type EventRow = {
  occurredAt: Date;
  sentiment: number;
  weight: number;
  durationDays: number;
  type: string;
  participants: { personId: string; sentiment: number | null }[];
};

const eventRowSelect = {
  occurredAt: true,
  sentiment: true,
  weight: true,
  durationDays: true,
  type: true,
  participants: { select: { personId: true, sentiment: true } },
} as const;

/** Orders two person ids into the canonical pair key. */
export function pairKey(first: string, second: string): PairKey {
  return first < second
    ? { aPersonId: first, bPersonId: second }
    : { aPersonId: second, bPersonId: first };
}

function pairToken(key: PairKey): string {
  return `${key.aPersonId}|${key.bPersonId}`;
}

/** Every unordered pair of the given people, deduplicated. */
export function pairsFromPeople(personIds: string[]): PairKey[] {
  const unique = [...new Set(personIds)];
  const pairs: PairKey[] = [];

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      pairs.push(pairKey(unique[i], unique[j]));
    }
  }

  return pairs;
}

function dedupePairs(pairs: PairKey[]): Map<string, PairKey> {
  const map = new Map<string, PairKey>();
  for (const pair of pairs) {
    map.set(pairToken(pair), pair);
  }
  return map;
}

function emptyAggregate(key: PairKey): PairAggregate {
  return {
    ...key,
    score: 0,
    eventCount: 0,
    lastEventAt: null,
    positiveCount: 0,
    negativeCount: 0,
  };
}

/**
 * Walks every event, expands its participants into pairs, and folds the shared
 * events of each pair into a cached stat row.
 */
function aggregateEvents(
  events: EventRow[],
  now: Date,
  config: ScoringConfig,
  ties: Map<string, TieType>,
): Map<string, PairAggregate> {
  const buckets = new Map<string, { key: PairKey; events: PairEvent[] }>();

  for (const event of events) {
    const participants = event.participants;

    for (let i = 0; i < participants.length; i += 1) {
      for (let j = i + 1; j < participants.length; j += 1) {
        const first = participants[i];
        const second = participants[j];
        const key = pairKey(first.personId, second.personId);
        const firstIsA = key.aPersonId === first.personId;

        const token = pairToken(key);
        let bucket = buckets.get(token);
        if (!bucket) {
          bucket = { key, events: [] };
          buckets.set(token, bucket);
        }

        bucket.events.push({
          occurredAt: event.occurredAt,
          sentiment: event.sentiment,
          weight: event.weight,
          durationDays: event.durationDays,
          type: event.type,
          overrideA: firstIsA ? first.sentiment : second.sentiment,
          overrideB: firstIsA ? second.sentiment : first.sentiment,
        });
      }
    }
  }

  const aggregates = new Map<string, PairAggregate>();

  for (const [token, bucket] of buckets) {
    let positiveCount = 0;
    let negativeCount = 0;
    let lastEventAt: Date | null = null;

    for (const pairEvent of bucket.events) {
      const effective = pairEffectiveSentiment(
        pairEvent.sentiment,
        pairEvent.overrideA,
        pairEvent.overrideB,
      );
      if (effective > 0) positiveCount += 1;
      if (effective < 0) negativeCount += 1;
      if (!lastEventAt || pairEvent.occurredAt > lastEventAt) {
        lastEventAt = pairEvent.occurredAt;
      }
    }

    aggregates.set(token, {
      ...bucket.key,
      score: computePairScore(bucket.events, now, config, ties.get(token) ?? DEFAULT_TIE),
      eventCount: bucket.events.length,
      lastEventAt,
      positiveCount,
      negativeCount,
    });
  }

  return aggregates;
}

type LinkRow = {
  id: string;
  aPersonId: string;
  bPersonId: string;
  // A String column in SQLite, validated as a TieType by the zod schema.
  tie: string;
  manualScore: number | null;
  pinned: boolean;
  notes: string | null;
};

/** The tie a derived link gets when nobody has said otherwise. */
const DEFAULT_TIE: TieType = "ACQUAINTANCE";

/** Each existing link's tie, by pair. A pair with no link yet is an acquaintance. */
function tiesOf(links: Iterable<LinkRow>): Map<string, TieType> {
  const ties = new Map<string, TieType>();
  for (const link of links) ties.set(pairToken(link), link.tie as TieType);
  return ties;
}

/** A link with no shared events survives only if a human touched it. */
function isCurated(link: LinkRow): boolean {
  return (
    link.pinned ||
    link.tie !== DEFAULT_TIE ||
    link.manualScore !== null ||
    (link.notes !== null && link.notes.trim() !== "")
  );
}

async function writeStat(db: Silo, linkId: string, aggregate: PairAggregate) {
  const values = {
    score: aggregate.score,
    eventCount: aggregate.eventCount,
    lastEventAt: aggregate.lastEventAt,
    positiveCount: aggregate.positiveCount,
    negativeCount: aggregate.negativeCount,
  };

  await db.linkStat.upsert({
    where: { linkId },
    update: values,
    create: { linkId, ...values },
  });
}

/**
 * Applies one aggregate. Pairs with shared events get their link created when
 * missing (tie defaults to ACQUAINTANCE) and their stat refreshed. Pairs with
 * no shared events lose the link unless a human curated it.
 */
async function applyAggregate(
  db: Silo,
  aggregate: PairAggregate,
  existing: LinkRow | null,
): Promise<Pick<RecomputeResult, "linksUpserted" | "linksCleared" | "linksDeleted">> {
  if (aggregate.eventCount === 0) {
    if (!existing) return { linksUpserted: 0, linksCleared: 0, linksDeleted: 0 };

    if (isCurated(existing)) {
      await writeStat(db, existing.id, aggregate);
      return { linksUpserted: 0, linksCleared: 1, linksDeleted: 0 };
    }

    await db.link.delete({ where: { id: existing.id } });
    return { linksUpserted: 0, linksCleared: 0, linksDeleted: 1 };
  }

  const link =
    existing ??
    (await db.link.upsert({
      where: {
        aPersonId_bPersonId: {
          aPersonId: aggregate.aPersonId,
          bPersonId: aggregate.bPersonId,
        },
      },
      // Existing tie, manualScore, pinned and notes are never touched.
      update: {},
      create: {
        aPersonId: aggregate.aPersonId,
        bPersonId: aggregate.bPersonId,
      },
      select: { id: true },
    }));

  await writeStat(db, link.id, aggregate);
  return { linksUpserted: 1, linksCleared: 0, linksDeleted: 0 };
}

async function findLinks(db: Silo, pairs: PairKey[]): Promise<Map<string, LinkRow>> {
  if (pairs.length === 0) return new Map();

  const rows = await db.link.findMany({
    where: {
      OR: pairs.map((pair) => ({
        aPersonId: pair.aPersonId,
        bPersonId: pair.bPersonId,
      })),
    },
    select: {
      id: true,
      aPersonId: true,
      bPersonId: true,
      tie: true,
      manualScore: true,
      pinned: true,
      notes: true,
    },
  });

  return new Map(rows.map((row) => [pairToken(row), row]));
}

/**
 * Recomputes the cached stats of the given pairs. Pairs that no longer share
 * an event are zeroed out or dropped.
 */
export async function recomputePairs(
  db: Silo,
  pairs: PairKey[],
  now: Date = new Date(),
  config: ScoringConfig = DEFAULT_SCORING,
): Promise<RecomputeResult> {
  const wanted = dedupePairs(pairs);
  const result: RecomputeResult = {
    pairsProcessed: wanted.size,
    linksUpserted: 0,
    linksCleared: 0,
    linksDeleted: 0,
  };

  if (wanted.size === 0) return result;

  const personIds = [
    ...new Set(
      [...wanted.values()].flatMap((pair) => [pair.aPersonId, pair.bPersonId]),
    ),
  ];

  const events = await db.event.findMany({
    where: { participants: { some: { personId: { in: personIds } } } },
    select: {
      ...eventRowSelect,
      participants: {
        where: { personId: { in: personIds } },
        select: { personId: true, sentiment: true },
      },
    },
  });

  // The tie of each pair sets how fast its closeness fades, so links come first.
  const existing = await findLinks(db, [...wanted.values()]);
  const aggregates = aggregateEvents(events, now, config, tiesOf(existing.values()));

  for (const [token, key] of wanted) {
    const aggregate = aggregates.get(token) ?? emptyAggregate(key);
    const counts = await applyAggregate(db, aggregate, existing.get(token) ?? null);
    result.linksUpserted += counts.linksUpserted;
    result.linksCleared += counts.linksCleared;
    result.linksDeleted += counts.linksDeleted;
  }

  return result;
}

/** Recomputes every pair among the given people. */
export async function recomputeForPeople(
  db: Silo,
  personIds: string[],
  now: Date = new Date(),
  config: ScoringConfig = DEFAULT_SCORING,
): Promise<RecomputeResult> {
  return recomputePairs(db, pairsFromPeople(personIds), now, config);
}

/**
 * Recomputes every pair among an event's current participants. Update and
 * delete flows pass the union of previous and current participants to
 * recomputeForPeople instead, so dropped pairs get recomputed too.
 */
export async function recomputeForEvent(
  db: Silo,
  eventId: string,
  now: Date = new Date(),
  config: ScoringConfig = DEFAULT_SCORING,
): Promise<RecomputeResult> {
  const participants = await db.eventParticipant.findMany({
    where: { eventId },
    select: { personId: true },
  });

  return recomputeForPeople(
    db,
    participants.map((participant) => participant.personId),
    now,
    config,
  );
}

/** Rebuilds every stat in the database from the full event history. */
export async function recomputeAll(
  db: Silo,
  now: Date = new Date(),
  config: ScoringConfig = DEFAULT_SCORING,
): Promise<RecomputeResult> {
  const events = await db.event.findMany({ select: eventRowSelect });

  const links = await db.link.findMany({
    select: {
      id: true,
      aPersonId: true,
      bPersonId: true,
      tie: true,
      manualScore: true,
      pinned: true,
      notes: true,
    },
  });

  const existing = new Map(links.map((link) => [pairToken(link), link]));
  const aggregates = aggregateEvents(events, now, config, tiesOf(links));
  const result: RecomputeResult = {
    pairsProcessed: 0,
    linksUpserted: 0,
    linksCleared: 0,
    linksDeleted: 0,
  };

  const targets = new Map<string, PairAggregate>(aggregates);

  // Links whose pair no longer shares an event still need their stat zeroed.
  for (const [token, link] of existing) {
    if (targets.has(token)) continue;
    targets.set(
      token,
      emptyAggregate({ aPersonId: link.aPersonId, bPersonId: link.bPersonId }),
    );
  }

  for (const [token, aggregate] of targets) {
    result.pairsProcessed += 1;
    const counts = await applyAggregate(db, aggregate, existing.get(token) ?? null);
    result.linksUpserted += counts.linksUpserted;
    result.linksCleared += counts.linksCleared;
    result.linksDeleted += counts.linksDeleted;
  }

  return result;
}
