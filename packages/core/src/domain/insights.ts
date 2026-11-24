// What the logged history actually says about one person. Plain data, no prose:
// a sketch gets written from this, so every figure ships with the count behind
// it and thin history reads as thin rather than as a conclusion.
//
// The aggregation maths lives in pure exported functions taking plain arrays.
// getPersonInsights only loads rows and hands them over.

import { idSchema } from "../schemas/common.js";
import type { FavourDirection } from "../schemas/enums.js";
import type { Silo } from "../storage/client.js";
import { pairKey } from "./link-engine.js";
import { daysBetween, decay } from "./scoring.js";

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365;
const MONTHS_PER_YEAR = 12;
const TREND_WINDOW_DAYS = 90;
/** Below this a window pair reads as steady rather than as a direction. */
const TREND_EPSILON = 0.25;

/** One event as this person experienced it, their override already applied. */
export interface InsightEvent {
  type: string;
  occurredAt: Date;
  sentiment: number;
  weight: number;
}

export interface EventTypeInsight {
  type: string;
  count: number;
  meanSentiment: number;
  /** Same mean with the scoring decay applied, so recent events count more. */
  decayedMeanSentiment: number;
  lastAt: string | null;
}

export interface CadenceInsight {
  totalEvents: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  daysSinceLastEvent: number | null;
  eventsLastYear: number;
  eventsPerMonthLastYear: number;
}

export type TrendDirection = "warming" | "cooling" | "steady" | "insufficient";

export interface SentimentWindow {
  count: number;
  mean: number;
}

export interface SentimentTrend {
  windowDays: number;
  recent: SentimentWindow;
  previous: SentimentWindow;
  /** Null when either window is empty, so one event is never a trend. */
  delta: number | null;
  direction: TrendDirection;
}

export interface SentimentInsight {
  count: number;
  mean: number;
  decayedMean: number;
  positive: number;
  neutral: number;
  negative: number;
  trend: SentimentTrend;
}

export interface TagInsight {
  id: string;
  name: string;
  colour: string;
}

export interface ClosenessInsight {
  /** True when a link row exists between this person and the self record. */
  linked: boolean;
  score: number | null;
  tie: string | null;
  sharedEventCount: number;
  lastSharedEventAt: string | null;
}

export interface FavourCount {
  open: number;
  settled: number;
}

export interface PersonInsights {
  personId: string;
  displayName: string;
  isSelf: boolean;
  computedAt: string;
  cadence: CadenceInsight;
  eventTypes: EventTypeInsight[];
  sentiment: SentimentInsight;
  tags: {
    interests: TagInsight[];
    allergies: TagInsight[];
    dislikes: TagInsight[];
  };
  circles: TagInsight[];
  noteCount: number;
  closeness: ClosenessInsight | null;
  favours: {
    theyOweMe: FavourCount;
    iOweThem: FavourCount;
  };
}

function round(value: number, places = 2): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** The sentiment this person recorded, falling back to the event's own. */
export function effectiveSentiment(
  eventSentiment: number,
  override: number | null | undefined,
): number {
  return override ?? eventSentiment;
}

/** Plain mean. Empty input is 0, never NaN. */
export function meanSentiment(events: InsightEvent[]): number {
  if (events.length === 0) return 0;
  const sum = events.reduce((acc, event) => acc + event.sentiment, 0);
  return round(sum / events.length);
}

/**
 * Mean weighted by the scoring decay, so a good run last month outweighs a bad
 * one three years ago. Empty input is 0, never NaN.
 */
export function decayedMeanSentiment(
  events: InsightEvent[],
  now: Date = new Date(),
): number {
  if (events.length === 0) return 0;

  let weighted = 0;
  let total = 0;
  for (const event of events) {
    const factor = decay(daysBetween(event.occurredAt, now));
    weighted += event.sentiment * factor;
    total += factor;
  }

  if (total === 0) return 0;
  return round(weighted / total);
}

/**
 * Per event type: how many, the plain mean and the decayed mean. This is the
 * revealed preference signal, so it stays split by type and keeps the counts.
 */
export function summariseEventTypes(
  events: InsightEvent[],
  now: Date = new Date(),
): EventTypeInsight[] {
  const byType = new Map<string, InsightEvent[]>();
  for (const event of events) {
    const bucket = byType.get(event.type);
    if (bucket) bucket.push(event);
    else byType.set(event.type, [event]);
  }

  return [...byType.entries()]
    .map(([type, bucket]) => {
      const last = bucket.reduce<Date | null>(
        (latest, event) =>
          latest === null || event.occurredAt > latest ? event.occurredAt : latest,
        null,
      );
      return {
        type,
        count: bucket.length,
        meanSentiment: meanSentiment(bucket),
        decayedMeanSentiment: decayedMeanSentiment(bucket, now),
        lastAt: iso(last),
      };
    })
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function computeCadence(
  events: InsightEvent[],
  now: Date = new Date(),
): CadenceInsight {
  if (events.length === 0) {
    return {
      totalEvents: 0,
      firstEventAt: null,
      lastEventAt: null,
      daysSinceLastEvent: null,
      eventsLastYear: 0,
      eventsPerMonthLastYear: 0,
    };
  }

  const times = events.map((event) => event.occurredAt.getTime());
  const first = new Date(Math.min(...times));
  const last = new Date(Math.max(...times));
  const yearAgo = now.getTime() - DAYS_PER_YEAR * MS_PER_DAY;
  const eventsLastYear = times.filter((time) => time >= yearAgo).length;

  return {
    totalEvents: events.length,
    firstEventAt: iso(first),
    lastEventAt: iso(last),
    daysSinceLastEvent: Math.floor(daysBetween(last, now)),
    eventsLastYear,
    eventsPerMonthLastYear: round(eventsLastYear / MONTHS_PER_YEAR),
  };
}

/**
 * Mean sentiment over the last window against the window before it. Both sides
 * need at least one event, otherwise there is nothing to compare and the
 * direction is "insufficient".
 */
export function computeSentimentTrend(
  events: InsightEvent[],
  now: Date = new Date(),
  windowDays: number = TREND_WINDOW_DAYS,
): SentimentTrend {
  const span = windowDays * MS_PER_DAY;
  const recentFrom = now.getTime() - span;
  const previousFrom = recentFrom - span;

  const recent: InsightEvent[] = [];
  const previous: InsightEvent[] = [];
  for (const event of events) {
    const time = event.occurredAt.getTime();
    if (time >= recentFrom) recent.push(event);
    else if (time >= previousFrom) previous.push(event);
  }

  const recentWindow = { count: recent.length, mean: meanSentiment(recent) };
  const previousWindow = { count: previous.length, mean: meanSentiment(previous) };

  if (recent.length === 0 || previous.length === 0) {
    return {
      windowDays,
      recent: recentWindow,
      previous: previousWindow,
      delta: null,
      direction: "insufficient",
    };
  }

  const delta = round(recentWindow.mean - previousWindow.mean);
  const direction: TrendDirection =
    delta > TREND_EPSILON ? "warming" : delta < -TREND_EPSILON ? "cooling" : "steady";

  return {
    windowDays,
    recent: recentWindow,
    previous: previousWindow,
    delta,
    direction,
  };
}

export function summariseSentiment(
  events: InsightEvent[],
  now: Date = new Date(),
  windowDays: number = TREND_WINDOW_DAYS,
): SentimentInsight {
  return {
    count: events.length,
    mean: meanSentiment(events),
    decayedMean: decayedMeanSentiment(events, now),
    positive: events.filter((event) => event.sentiment > 0).length,
    neutral: events.filter((event) => event.sentiment === 0).length,
    negative: events.filter((event) => event.sentiment < 0).length,
    trend: computeSentimentTrend(events, now, windowDays),
  };
}

const tagSelect = { id: true, name: true, colour: true } as const;

/** Everything the history says about one person. Null when no such person. */
export async function getPersonInsights(
  db: Silo,
  personId: string,
  now: Date = new Date(),
): Promise<PersonInsights | null> {
  const id = idSchema.parse(personId);

  const person = await db.person.findUnique({
    where: { id },
    select: {
      id: true,
      displayName: true,
      isSelf: true,
      interests: { select: tagSelect, orderBy: { name: "asc" } },
      allergies: { select: tagSelect, orderBy: { name: "asc" } },
      dislikes: { select: tagSelect, orderBy: { name: "asc" } },
      circles: { select: tagSelect, orderBy: { name: "asc" } },
      _count: { select: { notes: true } },
      events: {
        select: {
          sentiment: true,
          event: {
            select: { type: true, occurredAt: true, sentiment: true, weight: true },
          },
        },
      },
      favours: { select: { direction: true, settledAt: true } },
    },
  });

  if (!person) return null;

  const events: InsightEvent[] = person.events.map((participation) => ({
    type: participation.event.type,
    occurredAt: participation.event.occurredAt,
    sentiment: effectiveSentiment(
      participation.event.sentiment,
      participation.sentiment,
    ),
    weight: participation.event.weight,
  }));

  const self = person.isSelf
    ? null
    : await db.person.findFirst({
        where: { isSelf: true },
        select: { id: true },
      });

  const link = self
    ? await db.link.findUnique({
        where: { aPersonId_bPersonId: pairKey(self.id, person.id) },
        select: {
          tie: true,
          manualScore: true,
          stat: { select: { score: true, eventCount: true, lastEventAt: true } },
        },
      })
    : null;

  const closeness: ClosenessInsight | null = self
    ? {
        linked: link !== null,
        score: link ? (link.manualScore ?? link.stat?.score ?? 0) : null,
        tie: link?.tie ?? null,
        sharedEventCount: link?.stat?.eventCount ?? 0,
        lastSharedEventAt: iso(link?.stat?.lastEventAt),
      }
    : null;

  const countFavours = (direction: FavourDirection): FavourCount => {
    const rows = person.favours.filter((favour) => favour.direction === direction);
    return {
      open: rows.filter((favour) => favour.settledAt === null).length,
      settled: rows.filter((favour) => favour.settledAt !== null).length,
    };
  };

  return {
    personId: person.id,
    displayName: person.displayName,
    isSelf: person.isSelf,
    computedAt: now.toISOString(),
    cadence: computeCadence(events, now),
    eventTypes: summariseEventTypes(events, now),
    sentiment: summariseSentiment(events, now),
    tags: {
      interests: person.interests,
      allergies: person.allergies,
      dislikes: person.dislikes,
    },
    circles: person.circles,
    noteCount: person._count.notes,
    closeness,
    favours: {
      theyOweMe: countFavours("THEY_OWE_ME"),
      iOweThem: countFavours("I_OWE_THEM"),
    },
  };
}
