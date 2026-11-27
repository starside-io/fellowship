// Link scoring per README section 4. Pure functions, safe on client and server.
//
// contribution = effectiveSentiment * weight * length * kind * routine * decay
//   length  = 1 + log2(durationDays)        a weekend 2x, two weeks 4.8x
//   kind    = 0.25 for WORK, else 1         a meeting is contact, not a bond
//   routine = for work occasions, and everything with a colleague: 1 for the
//             first 3 in 30 days, then (3 / n)^2. Everyone else counts in full.
//   decay   = 0.5 ^ (daysSinceItEnded / (halfLifeDays * tieFade))
// score = clamp(round(scoreScale * sum(contribution)), -100, 100)

import type { TieType } from "../schemas/enums.js";

const MS_PER_DAY = 86_400_000;
// Six months, not a year. A friendship that went quiet or turned sour last
// month should read differently from one that did so last summer. This is the
// pace for a FRIEND; the other ties fade relative to it.
const HALF_LIFE_DAYS = 180;
// At 20 the ceiling was reached by roughly five net sentiment points, so every
// dense relationship pinned to 100 and the ordering between them was lost.
const SCORE_SCALE = 5;
export const SCORE_MIN = -100;
export const SCORE_MAX = 100;

/**
 * Bumped whenever the formula changes, so a host can tell its cached scores
 * were computed by an older one and rebuild them.
 */
export const SCORING_VERSION = 3;

/**
 * How slowly closeness fades, as a multiple of the configured half life.
 *
 * The kind of relationship does not add points: a relative you never see is
 * not close by virtue of the label. It changes how long shared time keeps
 * counting. Two weeks at your parents' still matters a year on; a coffee with
 * a colleague is gone in weeks.
 */
export const TIE_FADE: Record<TieType, number> = {
  FAMILY: 2,
  PARTNER: 2,
  CLOSE_FRIEND: 4 / 3,
  FRIEND: 1,
  ESTRANGED: 1,
  ACQUAINTANCE: 2 / 3,
  KNOWS_OF: 2 / 3,
  COLLEAGUE: 1 / 2,
};

/** Work occasions count a quarter: seeing someone at work is contact, not closeness. */
export const WORK_FACTOR = 0.25;

/**
 * Routine is what seeing someone because you have to looks like: work, and a
 * colleague. Only that levels off. Seeing a partner or a friend every few days
 * is the closeness itself, so it counts in full however often it happens.
 */
export function isRoutine(tie: TieType, type: string | undefined): boolean {
  return tie === "COLLEAGUE" || type === "WORK";
}

/** Occasions within this many days of each other count as one routine. */
export const ROUTINE_WINDOW_DAYS = 30;
/** How many occasions in a window count in full before routine sets in. */
export const ROUTINE_FREE = 3;

/**
 * The two config keys the score depends on. LinkStat.score is a cache of this
 * formula, so a change to either one invalidates every cached score: see
 * src/config/index.ts.
 */
export interface ScoringConfig {
  halfLifeDays: number;
  scoreScale: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  halfLifeDays: HALF_LIFE_DAYS,
  scoreScale: SCORE_SCALE,
};

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / MS_PER_DAY);
}

export function decay(
  daysSince: number,
  halfLifeDays: number = HALF_LIFE_DAYS,
): number {
  return Math.pow(0.5, daysSince / halfLifeDays);
}

/** The half life for a pair with this tie. */
export function tieHalfLife(tie: TieType, halfLifeDays: number = HALF_LIFE_DAYS): number {
  return halfLifeDays * (TIE_FADE[tie] ?? 1);
}

/** 1 for a single day, 2 for a weekend, about 4.8 for two weeks. */
export function lengthFactor(durationDays: number = 1): number {
  return 1 + Math.log2(Math.max(1, durationDays));
}

/** The nth occasion with someone inside one routine window. */
export function routineFactor(nthInWindow: number): number {
  return nthInWindow <= ROUTINE_FREE ? 1 : Math.pow(ROUTINE_FREE / nthInWindow, 2);
}

/** The last day of an occasion: where its decay starts from. */
export function endOf(occurredAt: Date, durationDays: number = 1): Date {
  return new Date(occurredAt.getTime() + (Math.max(1, durationDays) - 1) * MS_PER_DAY);
}

// For a pair, each side uses its participant override when present,
// otherwise the event sentiment; the pair value is their mean.
export function pairEffectiveSentiment(
  eventSentiment: number,
  overrideA: number | null | undefined,
  overrideB: number | null | undefined,
): number {
  const a = overrideA ?? eventSentiment;
  const b = overrideB ?? eventSentiment;
  return (a + b) / 2;
}

export function contribution(
  effectiveSentiment: number,
  weight: number,
  daysSince: number,
  halfLifeDays: number = HALF_LIFE_DAYS,
): number {
  return effectiveSentiment * weight * decay(daysSince, halfLifeDays);
}

export function scoreFromContributionSum(
  sum: number,
  scoreScale: number = SCORE_SCALE,
): number {
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, Math.round(scoreScale * sum)));
}

export interface PairEvent {
  occurredAt: Date;
  sentiment: number;
  weight: number;
  /** Days it lasted. 1 when not given. */
  durationDays?: number;
  /** The event type. Only WORK changes the score. */
  type?: string;
  overrideA?: number | null;
  overrideB?: number | null;
}

/**
 * Score for one link given every event both people attended, and the kind of
 * relationship they have. FRIEND, the default here, fades at the configured
 * half life.
 */
export function computePairScore(
  events: PairEvent[],
  now: Date = new Date(),
  config: ScoringConfig = DEFAULT_SCORING,
  tie: TieType = "FRIEND",
): number {
  const halfLife = tieHalfLife(tie, config.halfLifeDays);
  const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const windowMs = ROUTINE_WINDOW_DAYS * MS_PER_DAY;

  // Only routine occasions count toward the window, and only they level off.
  const routine: number[] = [];
  let sum = 0;
  ordered.forEach((event) => {
    let nth = 1;
    if (isRoutine(tie, event.type)) {
      const at = event.occurredAt.getTime();
      while (routine.length > 0 && at - routine[0]! >= windowMs) routine.shift();
      routine.push(at);
      nth = routine.length;
    }

    const effective = pairEffectiveSentiment(event.sentiment, event.overrideA, event.overrideB);
    const kind = event.type === "WORK" ? WORK_FACTOR : 1;
    const days = daysBetween(endOf(event.occurredAt, event.durationDays), now);
    sum +=
      contribution(effective, event.weight, days, halfLife) *
      lengthFactor(event.durationDays) *
      kind *
      routineFactor(nth);
  });

  return scoreFromContributionSum(sum, config.scoreScale);
}
