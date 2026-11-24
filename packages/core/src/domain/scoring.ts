// Link scoring per README section 4. Pure functions, safe on client and server.
// contribution = effectiveSentiment * weight * decay(daysSince)
// decay(d)     = 0.5 ^ (d / 180)
// score        = clamp(round(5 * sum(contribution)), -100, 100)

const MS_PER_DAY = 86_400_000;
// Six months, not a year. A friendship that went quiet or turned sour last
// month should read differently from one that did so last summer.
const HALF_LIFE_DAYS = 180;
// At 20 the ceiling was reached by roughly five net sentiment points, so every
// dense relationship pinned to 100 and the ordering between them was lost.
const SCORE_SCALE = 5;
export const SCORE_MIN = -100;
export const SCORE_MAX = 100;

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
  overrideA?: number | null;
  overrideB?: number | null;
}

// Score for one link given every event both people attended.
export function computePairScore(
  events: PairEvent[],
  now: Date = new Date(),
  config: ScoringConfig = DEFAULT_SCORING,
): number {
  const sum = events.reduce((acc, event) => {
    const effective = pairEffectiveSentiment(
      event.sentiment,
      event.overrideA,
      event.overrideB,
    );
    return (
      acc +
      contribution(
        effective,
        event.weight,
        daysBetween(event.occurredAt, now),
        config.halfLifeDays,
      )
    );
  }, 0);
  return scoreFromContributionSum(sum, config.scoreScale);
}
