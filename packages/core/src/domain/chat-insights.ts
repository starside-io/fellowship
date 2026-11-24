// What an imported chat actually says about one relationship. Plain data, no
// prose: every figure ships with the sample it came from, and a sample too thin
// to mean anything is reported as insufficient rather than dressed up as a
// number.
//
// The maths lives in pure exported functions taking plain arrays.
// getPersonChatInsights only loads rows and hands them over.

import { idSchema } from "../schemas/common.js";
import type { Silo } from "../storage/client.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** A silence this long makes the next message an opener rather than a reply. */
export const INITIATION_GAP_HOURS = 6;
/** Past this, a message answers nothing. It opens a new stretch of talking. */
export const REPLY_WINDOW_HOURS = 12;
export const TREND_WINDOW_DAYS = 90;

/** Below this a window pair reads as steady rather than as a direction. */
const TREND_EPSILON = 0.2;

/**
 * Sample sizes below which a figure is noise. Reported, never guessed at.
 *
 * Every function that consults them takes them as a trailing argument, because
 * they are config: see chatThresholds in docs/SPEC.md section 8. The shipped
 * values are the default, so a caller that does not care passes nothing.
 */
export interface ChatThresholds {
  messages: number;
  lengths: number;
  openers: number;
  replies: number;
  p90Replies: number;
  trendMessages: number;
  sessions: number;
}

export const THRESHOLDS: ChatThresholds = {
  messages: 20,
  lengths: 10,
  openers: 6,
  replies: 8,
  p90Replies: 12,
  trendMessages: 10,
  sessions: 5,
};

/** One message as the two sided stream sees it. */
export interface ChatMessage {
  sentAt: Date;
  /** True when the owner sent it, false when the other person did. */
  isFromSelf: boolean;
  /** Characters in the body. */
  length: number;
}

/** A derived figure with the sample behind it. value is null when too thin. */
export interface Measure {
  value: number | null;
  count: number;
  sufficient: boolean;
}

export interface SideVolume {
  messages: number;
  medianLength: Measure;
  meanLength: Measure;
}

export interface VolumeInsight {
  total: number;
  self: SideVolume;
  them: SideVolume;
  /** Your messages over theirs. Above 1 means you send more than you get. */
  ratio: Measure;
}

export interface InitiationSide {
  count: number;
  percent: number | null;
}

export interface InitiationInsight {
  gapHours: number;
  /** Openers found: the first message, and every one after a long silence. */
  total: number;
  self: InitiationSide;
  them: InitiationSide;
  sufficient: boolean;
}

export interface SideLatency {
  /** Genuine reply pairs: a message answering the other side inside the window. */
  replies: number;
  medianMinutes: Measure;
  p90Minutes: Measure;
}

export interface LatencyInsight {
  windowHours: number;
  /** How fast you answer them. */
  self: SideLatency;
  /** How fast they answer you. */
  them: SideLatency;
}

export interface WeeklyPoint {
  /** Monday of that week, UTC. */
  weekStart: string;
  total: number;
  self: number;
  them: number;
}

export interface SilenceGap {
  hours: number | null;
  days: number | null;
  from: string | null;
  to: string | null;
}

export interface CadenceWindow {
  count: number;
  perWeek: number;
}

export type CadenceDirection = "busier" | "quieter" | "steady" | "insufficient";

export interface CadenceTrend {
  windowDays: number;
  recent: CadenceWindow;
  previous: CadenceWindow;
  /** Relative change against the previous window. Null when there is no pair. */
  change: number | null;
  direction: CadenceDirection;
}

export interface CadenceInsight {
  totalMessages: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  daysSinceLastMessage: number | null;
  spanDays: number;
  /** Calendar days carrying at least one message. */
  activeDays: number;
  messagesPerWeek: Measure;
  weekly: WeeklyPoint[];
  longestSilence: SilenceGap;
  trend: CadenceTrend;
}

export interface HourBucket {
  hour: number;
  self: number;
  them: number;
  total: number;
}

export interface WeekdayBucket {
  /** 0 is Monday. */
  weekday: number;
  self: number;
  them: number;
  total: number;
}

export interface LastWordInsight {
  /** Stretches of talking, split by the same silence the openers use. */
  sessions: number;
  self: number;
  them: number;
  selfPercent: number | null;
  sufficient: boolean;
}

export interface RhythmInsight {
  /** Minutes added to UTC before bucketing, so hours read as local hours. */
  offsetMinutes: number;
  byHour: HourBucket[];
  byWeekday: WeekdayBucket[];
  lastWord: LastWordInsight;
  sufficient: boolean;
}

export interface ChatConversationSummary {
  id: string;
  title: string | null;
  isGroup: boolean;
  source: string;
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export interface PersonChatInsights {
  personId: string;
  displayName: string;
  computedAt: string;
  conversations: ChatConversationSummary[];
  /** Messages counted here: theirs plus yours, system notices dropped. */
  messageCount: number;
  volume: VolumeInsight;
  initiation: InitiationInsight;
  latency: LatencyInsight;
  cadence: CadenceInsight;
  rhythm: RhythmInsight;
  /** False when the whole history is too thin for any of this to mean much. */
  sufficient: boolean;
  thresholds: ChatThresholds;
}

function round(value: number, places = 2): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function measure(
  value: number | null,
  count: number,
  minimum: number,
  places = 2,
): Measure {
  const enough =
    count >= minimum && value !== null && Number.isFinite(value);
  return { value: enough ? round(value, places) : null, count, sufficient: enough };
}

function ordered(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
}

/** Plain median. Empty input is null, never NaN. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest rank percentile, fraction between 0 and 1. Empty input is null. */
export function percentileOf(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/** Plain mean. Empty input is null, never NaN. */
export function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function sideVolume(messages: ChatMessage[], thresholds: ChatThresholds): SideVolume {
  const lengths = messages.map((message) => message.length);
  return {
    messages: messages.length,
    medianLength: measure(medianOf(lengths), lengths.length, thresholds.lengths, 1),
    meanLength: measure(meanOf(lengths), lengths.length, thresholds.lengths, 1),
  };
}

/** How much each side says, and how long their messages run. */
export function computeVolume(
  messages: ChatMessage[],
  thresholds: ChatThresholds = THRESHOLDS,
): VolumeInsight {
  const self = messages.filter((message) => message.isFromSelf);
  const them = messages.filter((message) => !message.isFromSelf);

  const ratio = them.length > 0 ? self.length / them.length : null;

  return {
    total: messages.length,
    self: sideVolume(self, thresholds),
    them: sideVolume(them, thresholds),
    ratio: measure(ratio, messages.length, thresholds.messages),
  };
}

/**
 * Who breaks the silence. The first message counts, and so does every message
 * sent at least gapHours after the one before it. This is the reciprocity
 * signal: an even split is two people reaching out, a lopsided one is not.
 */
export function countInitiations(
  messages: ChatMessage[],
  gapHours: number = INITIATION_GAP_HOURS,
  thresholds: ChatThresholds = THRESHOLDS,
): InitiationInsight {
  const rows = ordered(messages);
  const gap = gapHours * MS_PER_HOUR;

  let self = 0;
  let them = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const isOpener =
      previous === undefined ||
      rows[index].sentAt.getTime() - previous.sentAt.getTime() >= gap;
    if (!isOpener) continue;
    if (rows[index].isFromSelf) self += 1;
    else them += 1;
  }

  const total = self + them;
  const sufficient = total >= thresholds.openers;

  return {
    gapHours,
    total,
    self: { count: self, percent: total > 0 ? round((self / total) * 100, 1) : null },
    them: { count: them, percent: total > 0 ? round((them / total) * 100, 1) : null },
    sufficient,
  };
}

/**
 * Time to reply, counted only on genuine pairs: a message from one side
 * directly following a message from the other, inside windowHours. Runs of
 * consecutive messages from the same sender are not reply pairs and are
 * skipped, so a chatty monologue does not read as a fast answer.
 */
export function computeReplyLatency(
  messages: ChatMessage[],
  windowHours: number = REPLY_WINDOW_HOURS,
  thresholds: ChatThresholds = THRESHOLDS,
): LatencyInsight {
  const rows = ordered(messages);
  const window = windowHours * MS_PER_HOUR;

  const selfDelays: number[] = [];
  const themDelays: number[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (current.isFromSelf === previous.isFromSelf) continue;

    const delay = current.sentAt.getTime() - previous.sentAt.getTime();
    if (delay < 0 || delay > window) continue;

    const minutes = delay / MS_PER_MINUTE;
    if (current.isFromSelf) selfDelays.push(minutes);
    else themDelays.push(minutes);
  }

  const side = (delays: number[]): SideLatency => ({
    replies: delays.length,
    medianMinutes: measure(
      medianOf(delays),
      delays.length,
      thresholds.replies,
      1,
    ),
    p90Minutes: measure(
      percentileOf(delays, 0.9),
      delays.length,
      thresholds.p90Replies,
      1,
    ),
  });

  return { windowHours, self: side(selfDelays), them: side(themDelays) };
}

function weekStartOf(time: number): number {
  const date = new Date(time);
  const midnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  const weekday = (date.getUTCDay() + 6) % 7;
  return midnight - weekday * MS_PER_DAY;
}

/** Messages per week from the first message to the last, gaps kept as zeros. */
export function weeklySeries(messages: ChatMessage[]): WeeklyPoint[] {
  const rows = ordered(messages);
  if (rows.length === 0) return [];

  const buckets = new Map<number, { self: number; them: number }>();
  for (const message of rows) {
    const key = weekStartOf(message.sentAt.getTime());
    const bucket = buckets.get(key) ?? { self: 0, them: 0 };
    if (message.isFromSelf) bucket.self += 1;
    else bucket.them += 1;
    buckets.set(key, bucket);
  }

  const first = weekStartOf(rows[0].sentAt.getTime());
  const last = weekStartOf(rows[rows.length - 1].sentAt.getTime());

  const points: WeeklyPoint[] = [];
  for (let week = first; week <= last; week += MS_PER_WEEK) {
    const bucket = buckets.get(week) ?? { self: 0, them: 0 };
    points.push({
      weekStart: new Date(week).toISOString(),
      total: bucket.self + bucket.them,
      self: bucket.self,
      them: bucket.them,
    });
  }

  return points;
}

/** The longest stretch with nothing sent either way. */
export function longestSilence(messages: ChatMessage[]): SilenceGap {
  const rows = ordered(messages);
  const empty: SilenceGap = { hours: null, days: null, from: null, to: null };
  if (rows.length < 2) return empty;

  let widest = -1;
  let from: Date | null = null;
  let to: Date | null = null;

  for (let index = 1; index < rows.length; index += 1) {
    const gap =
      rows[index].sentAt.getTime() - rows[index - 1].sentAt.getTime();
    if (gap > widest) {
      widest = gap;
      from = rows[index - 1].sentAt;
      to = rows[index].sentAt;
    }
  }

  if (widest < 0) return empty;

  return {
    hours: round(widest / MS_PER_HOUR, 1),
    days: round(widest / MS_PER_DAY, 2),
    from: iso(from),
    to: iso(to),
  };
}

/**
 * The last window against the window before it, counted in messages. A window
 * pair only reads as a direction when both sides are covered by the history and
 * there is enough traffic to compare.
 */
export function computeCadenceTrend(
  messages: ChatMessage[],
  now: Date = new Date(),
  windowDays: number = TREND_WINDOW_DAYS,
  thresholds: ChatThresholds = THRESHOLDS,
): CadenceTrend {
  const span = windowDays * MS_PER_DAY;
  const recentFrom = now.getTime() - span;
  const previousFrom = recentFrom - span;
  const perWeekFactor = windowDays / 7;

  let recent = 0;
  let previous = 0;
  let earliest: number | null = null;

  for (const message of messages) {
    const time = message.sentAt.getTime();
    if (earliest === null || time < earliest) earliest = time;
    if (time >= recentFrom) recent += 1;
    else if (time >= previousFrom) previous += 1;
  }

  const recentWindow: CadenceWindow = {
    count: recent,
    perWeek: round(recent / perWeekFactor),
  };
  const previousWindow: CadenceWindow = {
    count: previous,
    perWeek: round(previous / perWeekFactor),
  };

  // A previous window reaching back before the first message ever sent is not
  // a quiet window, it is a window with no history in it.
  const covered = earliest !== null && earliest <= previousFrom;
  const enough = recent + previous >= thresholds.trendMessages;

  if (!covered || !enough) {
    return {
      windowDays,
      recent: recentWindow,
      previous: previousWindow,
      change: null,
      direction: "insufficient",
    };
  }

  const change =
    previous === 0 ? (recent > 0 ? 1 : 0) : (recent - previous) / previous;

  const direction: CadenceDirection =
    change > TREND_EPSILON ? "busier" : change < -TREND_EPSILON ? "quieter" : "steady";

  return {
    windowDays,
    recent: recentWindow,
    previous: previousWindow,
    change: round(change),
    direction,
  };
}

export function computeCadence(
  messages: ChatMessage[],
  now: Date = new Date(),
  windowDays: number = TREND_WINDOW_DAYS,
  thresholds: ChatThresholds = THRESHOLDS,
): CadenceInsight {
  const rows = ordered(messages);

  if (rows.length === 0) {
    return {
      totalMessages: 0,
      firstMessageAt: null,
      lastMessageAt: null,
      daysSinceLastMessage: null,
      spanDays: 0,
      activeDays: 0,
      messagesPerWeek: measure(null, 0, thresholds.messages),
      weekly: [],
      longestSilence: longestSilence(rows),
      trend: computeCadenceTrend(rows, now, windowDays),
    };
  }

  const first = rows[0].sentAt;
  const last = rows[rows.length - 1].sentAt;
  const spanMs = last.getTime() - first.getTime();

  const days = new Set(
    rows.map((message) => message.sentAt.toISOString().slice(0, 10)),
  );

  const spanWeeks = Math.max(spanMs / MS_PER_WEEK, 1);

  return {
    totalMessages: rows.length,
    firstMessageAt: iso(first),
    lastMessageAt: iso(last),
    daysSinceLastMessage: Math.max(
      0,
      Math.floor((now.getTime() - last.getTime()) / MS_PER_DAY),
    ),
    spanDays: round(spanMs / MS_PER_DAY, 1),
    activeDays: days.size,
    messagesPerWeek: measure(
      rows.length / spanWeeks,
      rows.length,
      thresholds.messages,
    ),
    weekly: weeklySeries(rows),
    longestSilence: longestSilence(rows),
    trend: computeCadenceTrend(rows, now, windowDays),
  };
}

/**
 * Who says the last thing before the talking stops. Sessions are split by the
 * same silence that defines an opener.
 */
export function computeLastWord(
  messages: ChatMessage[],
  gapHours: number = INITIATION_GAP_HOURS,
  thresholds: ChatThresholds = THRESHOLDS,
): LastWordInsight {
  const rows = ordered(messages);
  const gap = gapHours * MS_PER_HOUR;

  let self = 0;
  let them = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const next = rows[index + 1];
    const isLast =
      next === undefined ||
      next.sentAt.getTime() - rows[index].sentAt.getTime() >= gap;
    if (!isLast) continue;
    if (rows[index].isFromSelf) self += 1;
    else them += 1;
  }

  const sessions = self + them;

  return {
    sessions,
    self,
    them,
    selfPercent: sessions > 0 ? round((self / sessions) * 100, 1) : null,
    sufficient: sessions >= thresholds.sessions,
  };
}

/** When the talking happens, by hour and by weekday, plus who closes it out. */
export function computeRhythm(
  messages: ChatMessage[],
  offsetMinutes = 0,
  gapHours: number = INITIATION_GAP_HOURS,
  thresholds: ChatThresholds = THRESHOLDS,
): RhythmInsight {
  const byHour: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    self: 0,
    them: 0,
    total: 0,
  }));
  const byWeekday: WeekdayBucket[] = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    self: 0,
    them: 0,
    total: 0,
  }));

  for (const message of messages) {
    const shifted = new Date(message.sentAt.getTime() + offsetMinutes * MS_PER_MINUTE);
    const hour = byHour[shifted.getUTCHours()];
    const weekday = byWeekday[(shifted.getUTCDay() + 6) % 7];

    hour.total += 1;
    weekday.total += 1;
    if (message.isFromSelf) {
      hour.self += 1;
      weekday.self += 1;
    } else {
      hour.them += 1;
      weekday.them += 1;
    }
  }

  return {
    offsetMinutes,
    byHour,
    byWeekday,
    lastWord: computeLastWord(messages, gapHours, thresholds),
    sufficient: messages.length >= thresholds.messages,
  };
}

export interface ChatInsightOptions {
  now?: Date;
  /** Minutes added to UTC before bucketing hours and weekdays. */
  offsetMinutes?: number;
  /** Overrides the shipped sample sizes. Comes from the module config. */
  thresholds?: ChatThresholds;
}

/**
 * Everything the imported chats say about one person. Null when no such person.
 *
 * The stream is two sided on purpose: their messages plus yours, taken from
 * every conversation they are a mapped participant of. In a group chat that
 * reads as "you and them in the same room" rather than as a private thread, so
 * the conversation list is returned alongside the figures.
 */
export async function getPersonChatInsights(
  db: Silo,
  personId: string,
  options: ChatInsightOptions = {},
): Promise<PersonChatInsights | null> {
  const id = idSchema.parse(personId);
  const now = options.now ?? new Date();
  const offsetMinutes = options.offsetMinutes ?? 0;
  const thresholds = options.thresholds ?? THRESHOLDS;

  const person = await db.person.findUnique({
    where: { id },
    select: { id: true, displayName: true },
  });

  if (!person) return null;

  const conversations = await db.conversation.findMany({
    where: { participants: { some: { personId: id } } },
    select: {
      id: true,
      title: true,
      isGroup: true,
      source: true,
      messageCount: true,
      firstMessageAt: true,
      lastMessageAt: true,
    },
    orderBy: { lastMessageAt: "desc" },
  });

  const conversationIds = conversations.map((conversation) => conversation.id);

  const rows =
    conversationIds.length === 0
      ? []
      : await db.message.findMany({
          where: {
            conversationId: { in: conversationIds },
            isSystem: false,
            OR: [{ personId: id }, { isFromSelf: true }],
          },
          select: { sentAt: true, isFromSelf: true, body: true },
          orderBy: { sentAt: "asc" },
        });

  const messages: ChatMessage[] = rows.map((row) => ({
    sentAt: row.sentAt,
    isFromSelf: row.isFromSelf,
    length: row.body.length,
  }));

  return {
    personId: person.id,
    displayName: person.displayName,
    computedAt: now.toISOString(),
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      isGroup: conversation.isGroup,
      source: conversation.source,
      messageCount: conversation.messageCount,
      firstMessageAt: iso(conversation.firstMessageAt),
      lastMessageAt: iso(conversation.lastMessageAt),
    })),
    messageCount: messages.length,
    volume: computeVolume(messages, thresholds),
    initiation: countInitiations(messages, INITIATION_GAP_HOURS, thresholds),
    latency: computeReplyLatency(messages, REPLY_WINDOW_HOURS, thresholds),
    cadence: computeCadence(messages, now, TREND_WINDOW_DAYS, thresholds),
    rhythm: computeRhythm(messages, offsetMinutes, INITIATION_GAP_HOURS, thresholds),
    sufficient: messages.length >= thresholds.messages,
    thresholds,
  };
}
