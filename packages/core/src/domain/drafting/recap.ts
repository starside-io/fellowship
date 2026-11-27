import { randomUUID } from "node:crypto";

import type { ModuleConfig } from "../../config/index.js";
import type { TieType } from "../../schemas/enums.js";
import type { Proposal, QueuedProposal, ReviewPort } from "../../ports.js";
import type { Silo } from "../../storage/client.js";
import { computePairScore, type PairEvent } from "../scoring.js";
import type { DraftOutcome } from "./mapping.js";
import { jsonSchemaFor } from "./mapping.js";
import { recapPrompt } from "./prompts.js";
import type { RecapDraft, RecapEvent, RecapPreference } from "./schemas.js";

/**
 * The chat recap: what happened over a stretch of one chat, and what the
 * people in it turned out to like, dislike or be allergic to.
 *
 * The model reads the window and drafts. Everything after that is checked
 * here, in code, because a model told "skip what is already logged" mostly
 * does, and mostly is not good enough for a record the owner reads as true.
 * Each event and each preference is matched against the silo and against the
 * review queue, pending and discarded alike, so a thing the owner already
 * logged or already said no to does not come back.
 *
 * Every survivor is its own proposal, under one group whose heading carries
 * the score each affected link would have if all of it were confirmed. The
 * score itself is never proposed: it is computed from events, and it moves
 * when the events are confirmed, by the same recompute as any other event.
 *
 * Where the last recap stopped is read back from the review queue rather than
 * kept in the silo, because proposing writes nothing to the silo. Should the
 * queue be emptied, the next recap starts from the top again and the
 * duplicate checks against the silo still hold.
 */

export interface RecapTarget {
  job: "recap";
  conversationId: string;
  /** Read messages after this instant. Defaults to where the last recap stopped. */
  since?: string;
  /** Read messages up to and including this instant. Set from the context. */
  through?: string;
  /** How many messages to read in one window. */
  messageLimit?: number;
}

export const RECAP_DEFAULT_MESSAGES = 800;

const DAY_MS = 86_400_000;
/**
 * Within a day, the same kind of thing with the same people is the same
 * thing. Two dinners on consecutive days are two dinners: people who see each
 * other often do exactly that, and a wider window drops real occasions.
 */
const SAME_TYPE_DAYS = 1;
/** Within this many days, the same title with the same people is the same thing. */
const SAME_TITLE_DAYS = 2;
/** Within this many days, a similar title with the same people is worth a second look. */
const NEAR_EVENT_DAYS = 7;
/** An event recalled from before the window ("last weekend") is still fine this far back. */
const LOOKBACK_DAYS = 14;

/* ------------------------------------------------------------ text checks */

/** Lower case, no accents, no punctuation: "Crème brûlée!" and "creme brulee" are one tag. */
export function normaliseTag(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/s$/, "");
}

/** Words that say nothing about which occasion it was. Titles are full of them. */
const STOP_WORDS = new Set(
  (
    "a an the and or but with without at to of in on for by from into onto out up down over " +
    "after before during since about than then there here this that these those it its " +
    "is was were be been being has had have do did done get got go went come came " +
    "i me my we us our you your he him his she her they them their " +
    "not no so very just really again some all one two first last new"
  ).split(" "),
);

function titleWords(title: string): Set<string> {
  return new Set(
    normaliseTag(title)
      .split(" ")
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

/**
 * Two titles name the same thing when they share two meaningful words making
 * up at least half of the shorter one, or the one word of a one word title.
 * One shared word is not enough: "Drinks at the harbour" and "Drinks at the rooftop"
 * are two evenings. Pronouns and filler do not count, or every long title
 * about the same two people would match every other.
 */
export function similarTitles(first: string, second: string): boolean {
  const a = titleWords(first);
  const b = titleWords(second);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const smaller = Math.min(a.size, b.size);
  return smaller === 1 ? shared === 1 : shared >= 2 && shared / smaller >= 0.5;
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** A date alone is noon UTC, so it lands on the same day in every timezone the owner is likely in. */
export function parseOccurredAt(value: string): Date | null {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00.000Z`)
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* ------------------------------------------------------------ the window */

function recapGroups(proposals: QueuedProposal[], conversationId: string) {
  return proposals.filter(
    (proposal) =>
      proposal.group?.meta?.["job"] === "recap" &&
      proposal.group.meta["conversationId"] === conversationId,
  );
}

/** Where the last recap of this chat stopped, from the queue. */
async function lastRecapThrough(
  review: ReviewPort,
  conversationId: string,
): Promise<Date | null> {
  let latest: Date | null = null;
  for (const proposal of recapGroups(await review.list("all"), conversationId)) {
    const through = proposal.group?.meta?.["through"];
    if (typeof through !== "string") continue;
    const at = new Date(through);
    if (!Number.isNaN(at.getTime()) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

interface RecapWindow {
  conversation: {
    id: string;
    title: string | null;
    isGroup: boolean;
    participants: Array<{ senderName: string; personId: string | null; isSelf: boolean }>;
  };
  owner: { id: string; displayName: string } | null;
  /** The people mapped in this chat, the owner included when mapped. */
  people: Map<string, { id: string; displayName: string; isSelf: boolean; senderNames: string[] }>;
  messages: Array<{ sentAt: Date; senderName: string; body: string }>;
  /** Exclusive lower bound, or null for the start of the chat. */
  since: Date | null;
  /** Inclusive upper bound: the last message read. Null when there was nothing to read. */
  through: Date | null;
  remaining: number;
}

async function loadWindow(
  db: Silo,
  review: ReviewPort,
  target: RecapTarget,
): Promise<RecapWindow> {
  const conversation = await db.conversation.findUnique({
    where: { id: target.conversationId },
    select: {
      id: true,
      title: true,
      isGroup: true,
      participants: { select: { senderName: true, personId: true, isSelf: true } },
    },
  });
  if (!conversation) throw new RecapError("No conversation with that id.");

  const owner = await db.person.findFirst({
    where: { isSelf: true },
    select: { id: true, displayName: true },
  });

  const mappedIds = [
    ...new Set(
      conversation.participants
        .map((participant) => participant.personId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const rows = await db.person.findMany({
    where: { id: { in: mappedIds } },
    select: { id: true, displayName: true, isSelf: true },
  });
  const people = new Map(
    rows.map((row) => [
      row.id,
      {
        ...row,
        senderNames: conversation.participants
          .filter((participant) => participant.personId === row.id)
          .map((participant) => participant.senderName),
      },
    ]),
  );

  // A target with through is a window the context already fixed: its start is
  // the since it carries, or the start of the chat. Only an open target reads
  // the watermark, or proposing a window would move it past itself.
  const since = target.since
    ? new Date(target.since)
    : target.through
      ? null
      : await lastRecapThrough(review, conversation.id);
  if (since && Number.isNaN(since.getTime())) throw new RecapError("since is not a date.");
  const through = target.through ? new Date(target.through) : null;
  if (through && Number.isNaN(through.getTime())) throw new RecapError("through is not a date.");

  const sentAt = {
    ...(since ? { gt: since } : {}),
    ...(through ? { lte: through } : {}),
  };
  const messages = await db.message.findMany({
    where: {
      conversationId: conversation.id,
      isSystem: false,
      ...(since || through ? { sentAt } : {}),
    },
    select: { sentAt: true, senderName: true, body: true },
    orderBy: { sentAt: "asc" },
    take: target.messageLimit ?? RECAP_DEFAULT_MESSAGES,
  });

  const last = messages.at(-1)?.sentAt ?? null;
  const remaining = last
    ? await db.message.count({
        where: { conversationId: conversation.id, isSystem: false, sentAt: { gt: last } },
      })
    : 0;

  return {
    conversation,
    owner,
    people,
    messages,
    since,
    through: last,
    remaining,
  };
}

export class RecapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecapError";
  }
}

/* ------------------------------------------------------------ the context */

async function knownEventsNear(db: Silo, personIds: string[], from: Date, to: Date) {
  if (personIds.length === 0) return [];
  return db.event.findMany({
    where: {
      occurredAt: { gte: from, lte: to },
      participants: { some: { personId: { in: personIds } } },
    },
    select: {
      id: true,
      title: true,
      type: true,
      occurredAt: true,
      participants: { select: { personId: true } },
    },
    orderBy: { occurredAt: "asc" },
    take: 300,
  });
}

async function knownTags(db: Silo, personIds: string[]) {
  return db.person.findMany({
    where: { id: { in: personIds } },
    select: {
      id: true,
      displayName: true,
      interests: { select: { name: true } },
      dislikes: { select: { name: true } },
      allergies: { select: { name: true } },
    },
  });
}

export async function buildRecapContext(
  db: Silo,
  review: ReviewPort,
  target: RecapTarget,
) {
  const window = await loadWindow(db, review, target);
  const people = [...window.people.values()];
  const personIds = people.map((person) => person.id);
  const others = people.filter((person) => !person.isSelf);

  const first = window.messages[0]?.sentAt ?? null;
  const events =
    first && window.through
      ? await knownEventsNear(
          db,
          others.map((person) => person.id),
          new Date(first.getTime() - LOOKBACK_DAYS * DAY_MS),
          new Date(window.through.getTime() + NEAR_EVENT_DAYS * DAY_MS),
        )
      : [];
  const nameOf = new Map(people.map((person) => [person.id, person.displayName]));
  if (window.owner) nameOf.set(window.owner.id, window.owner.displayName);

  const tags = await knownTags(db, personIds);
  const senderLabel = new Map(
    window.conversation.participants.map((participant) => [
      participant.senderName,
      participant.personId
        ? `${participant.senderName} (${nameOf.get(participant.personId) ?? "unknown"})`
        : `${participant.senderName} (not identified)`,
    ]),
  );

  const prompt = recapPrompt({
    conversationTitle: window.conversation.title,
    from: first ? day(first) : "nothing new",
    through: window.through ? day(window.through) : "nothing new",
    remaining: window.remaining,
    owner: window.owner,
    people: people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      senderNames: person.senderNames,
    })),
    knownEvents: events.map((event) => ({
      occurredAt: day(event.occurredAt),
      type: event.type,
      title: event.title,
      people: event.participants.map((row) => nameOf.get(row.personId) ?? "someone else"),
    })),
    knownPreferences: tags.map((person) => ({
      displayName: person.displayName,
      interests: person.interests.map((tag) => tag.name),
      dislikes: person.dislikes.map((tag) => tag.name),
      allergies: person.allergies.map((tag) => tag.name),
    })),
    messages: window.messages.map((message) => ({
      sentAt: message.sentAt.toISOString().slice(0, 16).replace("T", " "),
      sender: senderLabel.get(message.senderName) ?? message.senderName,
      body: message.body.slice(0, 400),
    })),
  });

  return {
    job: "recap" as const,
    ...prompt,
    schema: jsonSchemaFor("recap"),
    material: {
      messages: window.messages.length,
      remaining: window.remaining,
      knownEvents: events.length,
      people: people.length,
    },
    /** The exact target to hand back to people.propose_draft, so the window cannot drift. */
    target: {
      job: "recap" as const,
      conversationId: window.conversation.id,
      ...(window.since ? { since: window.since.toISOString() } : {}),
      ...(window.through ? { through: window.through.toISOString() } : {}),
      ...(target.messageLimit === undefined ? {} : { messageLimit: target.messageLimit }),
    },
  };
}

/* ------------------------------------------------------------ the outcome */

interface EventShape {
  title: string;
  type: string;
  occurredAt: Date;
  personIds: string[];
}

/** Close in time, with someone other than the owner in both. */
function sameEvent(a: EventShape, b: EventShape, ownerId: string | null, days: number) {
  // Strictly inside the window: two dates a whole day apart are two days.
  if (Math.abs(a.occurredAt.getTime() - b.occurredAt.getTime()) >= days * DAY_MS) return false;
  const others = (ids: string[]) => ids.filter((id) => id !== ownerId);
  const aSide = others(a.personIds).length > 0 ? others(a.personIds) : a.personIds;
  const bSide = new Set(others(b.personIds).length > 0 ? others(b.personIds) : b.personIds);
  return aSide.some((id) => bSide.has(id));
}

function queuedEvents(proposals: QueuedProposal[]): Array<EventShape & { state: string }> {
  const shapes: Array<EventShape & { state: string }> = [];
  for (const proposal of proposals) {
    if (proposal.tool !== "people.log_interaction" || proposal.state === "confirmed") continue;
    const payload = proposal.payload as Record<string, unknown> | null;
    if (!payload) continue;
    const occurredAt = new Date(String(payload["occurredAt"] ?? ""));
    if (Number.isNaN(occurredAt.getTime())) continue;
    const participants = Array.isArray(payload["participants"]) ? payload["participants"] : [];
    shapes.push({
      title: String(payload["title"] ?? ""),
      type: String(payload["type"] ?? ""),
      occurredAt,
      personIds: participants
        .map((row) => (row as Record<string, unknown>)["personId"])
        .filter((id): id is string => typeof id === "string"),
      state: proposal.state,
    });
  }
  return shapes;
}

type PreferenceKind = RecapPreference["kind"];
const PAYLOAD_KEY: Record<PreferenceKind, "interests" | "dislikes" | "allergies"> = {
  interest: "interests",
  dislike: "dislikes",
  allergy: "allergies",
};

function queuedPreferences(proposals: QueuedProposal[]) {
  const seen = new Map<string, string>();
  for (const proposal of proposals) {
    if (proposal.tool !== "people.set_tags" || proposal.state === "confirmed") continue;
    const payload = proposal.payload as Record<string, unknown> | null;
    const personId = payload?.["personId"];
    if (typeof personId !== "string") continue;
    for (const kind of Object.keys(PAYLOAD_KEY) as PreferenceKind[]) {
      const names = payload?.[PAYLOAD_KEY[kind]];
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        seen.set(`${personId}|${kind}|${normaliseTag(String(name))}`, proposal.state);
      }
    }
  }
  return seen;
}

function quoteDoc(lines: string[]) {
  return {
    type: "doc",
    content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
  };
}

const SENTIMENT_WORD: Record<number, string> = {
  [-2]: "bad",
  [-1]: "tense",
  0: "neutral",
  1: "good",
  2: "great",
};

async function pairEvents(db: Silo, a: string, b: string): Promise<PairEvent[]> {
  const rows = await db.event.findMany({
    where: {
      AND: [{ participants: { some: { personId: a } } }, { participants: { some: { personId: b } } }],
    },
    select: {
      occurredAt: true,
      sentiment: true,
      weight: true,
      durationDays: true,
      type: true,
      participants: { select: { personId: true, sentiment: true } },
    },
  });
  return rows.map((row) => ({
    occurredAt: row.occurredAt,
    sentiment: row.sentiment,
    weight: row.weight,
    durationDays: row.durationDays,
    type: row.type,
    overrideA: row.participants.find((p) => p.personId === a)?.sentiment ?? null,
    overrideB: row.participants.find((p) => p.personId === b)?.sentiment ?? null,
  }));
}

export interface ScorePreview {
  personIds: [string, string];
  label: string;
  current: number;
  projected: number;
  added: number;
  /** A pinned score overrides the computed one wherever the score is read. */
  manualScore: number | null;
}

export async function recapProposals(
  db: Silo,
  review: ReviewPort,
  config: ModuleConfig,
  now: Date,
  target: RecapTarget,
  draft: RecapDraft,
): Promise<DraftOutcome> {
  const window = await loadWindow(db, review, target);
  if (!window.through) {
    return {
      proposals: [],
      rejected: [{ reason: "there are no messages in that window to recap" }],
    };
  }

  const rejected: DraftOutcome["rejected"] = [];
  const ownerId = window.owner?.id ?? null;
  const nameOf = new Map([...window.people.values()].map((p) => [p.id, p.displayName]));
  if (window.owner) nameOf.set(window.owner.id, window.owner.displayName);
  const allowed = new Set(nameOf.keys());
  const scoring = { halfLifeDays: config.halfLifeDays, scoreScale: config.scoreScale };

  const first = window.messages[0]?.sentAt ?? window.through;
  const earliest = new Date(first.getTime() - LOOKBACK_DAYS * DAY_MS);
  const latest = new Date(window.through.getTime() + DAY_MS);

  const queue = await review.list("all");
  const silo = await knownEventsNear(
    db,
    [...allowed].filter((id) => id !== ownerId),
    new Date(earliest.getTime() - NEAR_EVENT_DAYS * DAY_MS),
    new Date(latest.getTime() + NEAR_EVENT_DAYS * DAY_MS),
  );
  const logged: EventShape[] = silo.map((event) => ({
    title: event.title,
    type: event.type,
    occurredAt: event.occurredAt,
    personIds: event.participants.map((row) => row.personId),
  }));
  const proposed = queuedEvents(queue);

  /* events */

  const accepted: Array<{ event: RecapEvent; shape: EventShape; flag: string | null }> = [];

  for (const event of draft.events) {
    if (event.confidence === "low") {
      rejected.push({ reason: "too low a confidence", detail: { title: event.title } });
      continue;
    }
    const occurredAt = parseOccurredAt(event.occurredAt);
    if (!occurredAt) {
      rejected.push({ reason: "that date does not parse", detail: { title: event.title } });
      continue;
    }
    if (occurredAt < earliest || occurredAt > latest) {
      rejected.push({
        reason:
          occurredAt > latest
            ? "it had not happened yet by the end of this window"
            : "that date is well before this window",
        detail: { title: event.title, occurredAt: event.occurredAt },
      });
      continue;
    }
    const unknown = event.participantIds.filter((id) => !allowed.has(id));
    if (unknown.length > 0) {
      rejected.push({
        reason: "a participant is not one of the people in this chat",
        detail: { title: event.title, personIds: unknown },
      });
      continue;
    }

    const shape: EventShape = {
      title: event.title,
      type: event.type,
      occurredAt,
      personIds: [...new Set(event.participantIds)],
    };
    const exact = (other: EventShape) =>
      (sameEvent(shape, other, ownerId, SAME_TYPE_DAYS) && other.type === shape.type) ||
      (sameEvent(shape, other, ownerId, SAME_TITLE_DAYS) && similarTitles(other.title, shape.title));

    const inSilo = logged.find(exact);
    if (inSilo) {
      rejected.push({
        reason: `already logged: "${inSilo.title}" on ${day(inSilo.occurredAt)}`,
        detail: { title: event.title },
      });
      continue;
    }
    const inQueue = proposed.find(exact);
    if (inQueue) {
      rejected.push({
        reason: `already proposed and ${inQueue.state}: "${inQueue.title}" on ${day(inQueue.occurredAt)}`,
        detail: { title: event.title },
      });
      continue;
    }
    // Within one draft the model has already told its events apart, so two
    // of the same kind on one day (drinks at midnight, a morning at his place)
    // stay two. Only the same occasion named twice is dropped.
    const twice = (other: EventShape) =>
      sameEvent(shape, other, ownerId, SAME_TITLE_DAYS) && similarTitles(other.title, shape.title);
    if (accepted.some((entry) => twice(entry.shape))) {
      rejected.push({ reason: "the draft lists this event twice", detail: { title: event.title } });
      continue;
    }

    const near = logged.find(
      (other) =>
        sameEvent(shape, other, ownerId, NEAR_EVENT_DAYS) && similarTitles(other.title, shape.title),
    );
    accepted.push({
      event,
      shape,
      flag: near ? `possibly the same as "${near.title}" on ${day(near.occurredAt)}` : null,
    });
  }

  /* score preview */

  const pairs = new Map<string, [string, string]>();
  for (const { shape } of accepted) {
    const ids = [...shape.personIds].sort();
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        pairs.set(`${ids[i]}|${ids[j]}`, [ids[i] as string, ids[j] as string]);
      }
    }
  }

  const toPairEvent = (entry: (typeof accepted)[number]): PairEvent => ({
    occurredAt: entry.shape.occurredAt,
    sentiment: entry.event.sentiment,
    weight: entry.event.weight,
    durationDays: entry.event.durationDays,
    type: entry.event.type,
  });

  const pairLabel = (a: string, b: string) => {
    if (a === ownerId) return nameOf.get(b) ?? b;
    if (b === ownerId) return nameOf.get(a) ?? a;
    return `${nameOf.get(a) ?? a} and ${nameOf.get(b) ?? b}`;
  };

  const previews: ScorePreview[] = [];
  const existingByPair = new Map<string, PairEvent[]>();
  const tieByPair = new Map<string, TieType>();
  for (const [key, [a, b]] of pairs) {
    const existing = await pairEvents(db, a, b);
    existingByPair.set(key, existing);
    const added = accepted.filter(
      (entry) => entry.shape.personIds.includes(a) && entry.shape.personIds.includes(b),
    );
    const link = await db.link.findUnique({
      where: { aPersonId_bPersonId: { aPersonId: a, bPersonId: b } },
      select: { manualScore: true, tie: true },
    });
    const tie = (link?.tie ?? "ACQUAINTANCE") as TieType;
    tieByPair.set(key, tie);
    previews.push({
      personIds: [a, b],
      label: pairLabel(a, b),
      current: computePairScore(existing, now, scoring, tie),
      projected: computePairScore([...existing, ...added.map(toPairEvent)], now, scoring, tie),
      added: added.length,
      manualScore: link?.manualScore ?? null,
    });
  }
  // The owner's own links first: those are the ones the owner reads.
  previews.sort(
    (x, y) =>
      Number(y.personIds.includes(ownerId ?? "")) - Number(x.personIds.includes(ownerId ?? "")) ||
      Math.abs(y.projected - y.current) - Math.abs(x.projected - x.current),
  );

  /* preferences */

  const tagRows = await knownTags(db, [...allowed]);
  const recorded = new Map<string, PreferenceKind>();
  for (const person of tagRows) {
    for (const tag of person.interests) recorded.set(`${person.id}|${normaliseTag(tag.name)}`, "interest");
    for (const tag of person.dislikes) recorded.set(`${person.id}|${normaliseTag(tag.name)}`, "dislike");
    for (const tag of person.allergies) recorded.set(`${person.id}|${normaliseTag(tag.name)}`, "allergy");
  }
  const queuedTags = queuedPreferences(queue);
  const preferences: Array<{ preference: RecapPreference; flag: string | null }> = [];
  const draftSeen = new Set<string>();

  for (const preference of draft.preferences) {
    if (preference.confidence === "low") {
      rejected.push({ reason: "too low a confidence", detail: { value: preference.value } });
      continue;
    }
    if (!allowed.has(preference.personId)) {
      rejected.push({
        reason: "that person is not in this chat",
        detail: { value: preference.value, personId: preference.personId },
      });
      continue;
    }
    const norm = normaliseTag(preference.value);
    const known = recorded.get(`${preference.personId}|${norm}`);
    if (known === preference.kind) {
      rejected.push({ reason: `already recorded as ${known}`, detail: { value: preference.value } });
      continue;
    }
    const queued = queuedTags.get(`${preference.personId}|${preference.kind}|${norm}`);
    if (queued) {
      rejected.push({ reason: `already proposed and ${queued}`, detail: { value: preference.value } });
      continue;
    }
    const draftKey = `${preference.personId}|${preference.kind}|${norm}`;
    if (draftSeen.has(draftKey)) {
      rejected.push({ reason: "the draft lists this twice", detail: { value: preference.value } });
      continue;
    }
    draftSeen.add(draftKey);
    preferences.push({
      preference,
      flag: known ? `already recorded as ${known}, so one of them is wrong` : null,
    });
  }

  /* proposals */

  const from = day(first);
  const through = day(window.through);
  const chat = window.conversation.title ?? "an untitled chat";
  const recapLine = `From the recap of ${chat}, ${from} to ${through}.`;
  const proposals: Proposal[] = [];

  const notePerson = window.conversation.isGroup
    ? ownerId
    : ([...window.people.values()].find((person) => !person.isSelf)?.id ?? ownerId);
  // Proposing the same window again, to pick up what an earlier run missed,
  // adds the missing items and not a second copy of the recap note.
  const noteQueued = recapGroups(queue, window.conversation.id).some(
    (proposal) =>
      proposal.tool === "people.add_note" &&
      proposal.state !== "discarded" &&
      proposal.group?.meta?.["through"] === window.through?.toISOString(),
  );
  if (notePerson && !noteQueued) {
    proposals.push({
      tool: "people.add_note",
      personId: notePerson,
      payload: {
        personId: notePerson,
        occurredAt: window.through.toISOString(),
        body: quoteDoc([`Recap of ${chat}, ${from} to ${through}.`, draft.summary]),
      },
      summary: `Recap note: ${draft.summary.slice(0, 160)}${draft.summary.length > 160 ? "…" : ""}`,
    });
  }

  for (const entry of accepted) {
    const { event, shape } = entry;
    const names = shape.personIds.map((id) => nameOf.get(id) ?? id).join(", ");
    const moves = previews
      .filter((preview) => preview.personIds.every((id) => shape.personIds.includes(id)))
      .filter((preview) => preview.personIds.includes(ownerId ?? "") || !ownerId)
      .map((preview) => {
        const pair = `${preview.personIds[0]}|${preview.personIds[1]}`;
        const existing = existingByPair.get(pair) ?? [];
        const alone = computePairScore(
          [...existing, toPairEvent(entry)],
          now,
          scoring,
          tieByPair.get(pair) ?? "ACQUAINTANCE",
        );
        return `${preview.label} ${preview.current} → ${alone}`;
      });
    proposals.push({
      tool: "people.log_interaction",
      payload: {
        title: event.title,
        type: event.type,
        occurredAt: shape.occurredAt.toISOString(),
        ...(event.location ? { location: event.location } : {}),
        sentiment: event.sentiment,
        weight: event.weight,
        durationDays: event.durationDays,
        participants: shape.personIds.map((personId) => ({ personId })),
        description: quoteDoc([`"${event.quote}"`, recapLine]),
      },
      summary: [
        `${day(shape.occurredAt)} ${event.type}: ${event.title} (${names}), ${
          SENTIMENT_WORD[event.sentiment] ?? event.sentiment
        }`,
        moves.length > 0 ? `on its own: ${moves.join(", ")}` : "",
        entry.flag ? `check: ${entry.flag}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  for (const { preference, flag } of preferences) {
    const name = nameOf.get(preference.personId) ?? preference.personId;
    const verb =
      preference.kind === "interest"
        ? "likes"
        : preference.kind === "dislike"
          ? "dislikes"
          : "is allergic to";
    proposals.push({
      tool: "people.set_tags",
      personId: preference.personId,
      payload: {
        personId: preference.personId,
        mode: "add",
        [PAYLOAD_KEY[preference.kind]]: [preference.value],
      },
      summary: [`${name} ${verb} ${preference.value}: "${preference.quote}"`, flag ? `check: ${flag}` : ""]
        .filter(Boolean)
        .join(" · "),
    });
  }

  const moved = previews.filter((preview) => preview.projected !== preview.current);
  const detail =
    accepted.length === 0
      ? "No new events, so no score moves."
      : moved.length === 0
        ? `${accepted.length} new ${accepted.length === 1 ? "event" : "events"}, no score moves.`
        : `If all confirmed: ${moved
            .map(
              (preview) =>
                `${preview.label} ${preview.current} → ${preview.projected}${
                  preview.manualScore === null ? "" : ` (pinned at ${preview.manualScore})`
                }`,
            )
            .join(", ")}`;

  const group = {
    id: randomUUID(),
    title: `Chat recap: ${chat}, ${from} to ${through}`,
    detail,
    meta: {
      job: "recap",
      conversationId: window.conversation.id,
      since: window.since?.toISOString() ?? null,
      through: window.through.toISOString(),
      remaining: window.remaining,
      preview: previews,
    },
  };

  return {
    proposals: proposals.map((proposal) => ({ ...proposal, group })),
    rejected,
  };
}
