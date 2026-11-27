import { describe, expect, it } from "vitest";
import {
  SCORE_MAX,
  SCORE_MIN,
  computePairScore,
  contribution,
  daysBetween,
  decay,
  endOf,
  lengthFactor,
  pairEffectiveSentiment,
  routineFactor,
  scoreFromContributionSum,
  tieHalfLife,
  type PairEvent,
} from "../../src/domain/scoring.js";

// The contract under test, transcribed from README section 4:
//   contribution = effectiveSentiment * weight * decay(daysSince)
//   decay(d)     = 0.5 ^ (d / 180)
//   score        = clamp(round(5 * sum(contribution)), -100, 100)
const HALF_LIFE_DAYS = 180;
const SCORE_SCALE = 5;
const DAY_MS = 86_400_000;

function readmeDecay(days: number): number {
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

function readmeScore(contributions: number[]): number {
  const sum = contributions.reduce((acc, value) => acc + value, 0);
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, Math.round(SCORE_SCALE * sum)));
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

const NOW = new Date("2026-07-31T12:00:00.000Z");

describe("decay", () => {
  it("is 1 the day the event happens", () => {
    expect(decay(0)).toBe(1);
  });

  it("halves after six months", () => {
    expect(decay(180)).toBeCloseTo(0.5, 12);
  });

  it("quarters after a year", () => {
    expect(decay(360)).toBeCloseTo(0.25, 12);
  });

  it("is monotonically decreasing", () => {
    expect(decay(10)).toBeGreaterThan(decay(11));
    expect(decay(1000)).toBeGreaterThan(decay(1001));
  });
});

describe("pairEffectiveSentiment", () => {
  it("uses the event sentiment when neither side overrode it", () => {
    expect(pairEffectiveSentiment(2, null, null)).toBe(2);
    expect(pairEffectiveSentiment(-1, undefined, undefined)).toBe(-1);
  });

  it("averages a single override with the event sentiment", () => {
    // The side without an override falls back to the event value, so the
    // pair value is the mean of the override and the event sentiment.
    expect(pairEffectiveSentiment(2, 1, null)).toBe(1.5);
    expect(pairEffectiveSentiment(2, null, -2)).toBe(0);
  });

  it("averages the two overrides and ignores the event sentiment", () => {
    expect(pairEffectiveSentiment(2, 1, -1)).toBe(0);
    expect(pairEffectiveSentiment(-2, 2, 1)).toBe(1.5);
  });

  it("treats an override of 0 as a real override, not as absent", () => {
    expect(pairEffectiveSentiment(2, 0, null)).toBe(1);
  });
});

describe("contribution", () => {
  it("is sentiment times weight on the day of the event", () => {
    expect(contribution(2, 3, 0)).toBe(6);
  });

  it("halves after one half life", () => {
    expect(contribution(2, 3, HALF_LIFE_DAYS)).toBeCloseTo(3, 12);
  });

  it("matches the README formula for an arbitrary age", () => {
    expect(contribution(1.5, 2, 200)).toBeCloseTo(1.5 * 2 * readmeDecay(200), 12);
  });

  it("keeps the sign of a negative sentiment", () => {
    expect(contribution(-2, 2, 0)).toBe(-4);
  });
});

describe("scoreFromContributionSum", () => {
  it("scales the sum by 5", () => {
    expect(scoreFromContributionSum(1)).toBe(5);
    // Math.round is half up, so -7.5 lands on -7.
    expect(scoreFromContributionSum(-1.5)).toBe(-7);
  });

  it("clamps at the documented bounds", () => {
    expect(scoreFromContributionSum(20)).toBe(SCORE_MAX);
    expect(scoreFromContributionSum(500)).toBe(SCORE_MAX);
    expect(scoreFromContributionSum(-20)).toBe(SCORE_MIN);
    expect(scoreFromContributionSum(-500)).toBe(SCORE_MIN);
  });

  it("holds exactly at the bounds without overshooting", () => {
    expect(scoreFromContributionSum(SCORE_MAX / SCORE_SCALE)).toBe(SCORE_MAX);
    expect(scoreFromContributionSum(SCORE_MIN / SCORE_SCALE)).toBe(SCORE_MIN);
  });

  it("rounds to a whole score", () => {
    expect(scoreFromContributionSum(0.47)).toBe(2);
    expect(scoreFromContributionSum(0.44)).toBe(2);
    // Math.round is half up, so a negative half rounds towards zero.
    expect(scoreFromContributionSum(0.5)).toBe(3);
    expect(scoreFromContributionSum(-0.5)).toBe(-2);
  });
});

describe("daysBetween", () => {
  it("counts whole and fractional days", () => {
    expect(daysBetween(daysAgo(NOW, 30), NOW)).toBe(30);
    expect(daysBetween(daysAgo(NOW, 0.5), NOW)).toBe(0.5);
  });

  it("never returns a negative count for a future event", () => {
    const future = new Date(NOW.getTime() + 400 * DAY_MS);
    expect(daysBetween(future, NOW)).toBe(0);
  });
});

describe("computePairScore", () => {
  it("scores a worked two event example exactly as the README formula does", () => {
    // A 30 day old +2 sentiment, weight 1 event where one side logged +1,
    // plus a three year old -2 sentiment, weight 2 event with no overrides.
    const events: PairEvent[] = [
      {
        occurredAt: daysAgo(NOW, 30),
        sentiment: 2,
        weight: 1,
        overrideA: 1,
        overrideB: null,
      },
      {
        occurredAt: daysAgo(NOW, 3 * 180),
        sentiment: -2,
        weight: 2,
      },
    ];

    // Expectation derived from the formula, not from the implementation.
    const recentEffective = (1 + 2) / 2;
    const recentContribution = recentEffective * 1 * readmeDecay(30);
    const oldContribution = -2 * 2 * readmeDecay(3 * 180);
    const expected = readmeScore([recentContribution, oldContribution]);

    // Sanity check on the hand maths: 0.5^3 is exactly 0.125, so the old
    // event contributes -0.5 while the recent one contributes just over 1.3.
    expect(oldContribution).toBeCloseTo(-0.5, 12);
    expect(recentContribution).toBeGreaterThan(1.3);
    expect(recentContribution).toBeLessThan(1.4);
    expect(expected).toBe(4);

    expect(computePairScore(events, NOW)).toBe(expected);
  });

  it("sums several events rather than taking the latest", () => {
    const single: PairEvent[] = [
      { occurredAt: NOW, sentiment: 1, weight: 1 },
    ];
    const triple: PairEvent[] = [
      { occurredAt: NOW, sentiment: 1, weight: 1 },
      { occurredAt: NOW, sentiment: 1, weight: 1 },
      { occurredAt: NOW, sentiment: 1, weight: 1 },
    ];

    expect(computePairScore(single, NOW)).toBe(5);
    expect(computePairScore(triple, NOW)).toBe(15);
  });

  it("lets positive and negative events cancel", () => {
    const events: PairEvent[] = [
      { occurredAt: NOW, sentiment: 2, weight: 2 },
      { occurredAt: NOW, sentiment: -2, weight: 2 },
    ];
    expect(computePairScore(events, NOW)).toBe(0);
  });

  it("clamps a pile of great events at the maximum", () => {
    const events: PairEvent[] = Array.from({ length: 20 }, () => ({
      occurredAt: NOW,
      sentiment: 2,
      weight: 3,
    }));
    expect(computePairScore(events, NOW)).toBe(SCORE_MAX);
  });

  it("clamps a pile of bad events at the minimum", () => {
    const events: PairEvent[] = Array.from({ length: 20 }, () => ({
      occurredAt: NOW,
      sentiment: -2,
      weight: 3,
    }));
    expect(computePairScore(events, NOW)).toBe(SCORE_MIN);
  });

  it("weakens a positive event as time passes", () => {
    const events: PairEvent[] = [
      { occurredAt: daysAgo(NOW, 10), sentiment: 2, weight: 1 },
    ];
    const today = computePairScore(events, NOW);
    const aHalfLifeLater = computePairScore(
      events,
      new Date(NOW.getTime() + HALF_LIFE_DAYS * DAY_MS),
    );

    expect(today).toBeGreaterThan(0);
    expect(aHalfLifeLater).toBeGreaterThan(0);
    expect(aHalfLifeLater).toBeLessThan(today);
    // A half life apart, so the later reading is about half the earlier one.
    expect(Math.abs(aHalfLifeLater - today / 2)).toBeLessThanOrEqual(1);
  });

  it("weakens a negative event as time passes", () => {
    const events: PairEvent[] = [
      { occurredAt: daysAgo(NOW, 10), sentiment: -2, weight: 2 },
    ];
    const today = computePairScore(events, NOW);
    const aYearLater = computePairScore(
      events,
      new Date(NOW.getTime() + 365 * DAY_MS),
    );

    expect(today).toBeLessThan(0);
    expect(Math.abs(aYearLater)).toBeLessThan(Math.abs(today));
  });

  it("is 0 with no events", () => {
    expect(computePairScore([], NOW)).toBe(0);
  });

  it("treats a future event as if it happened today", () => {
    const future = new Date(NOW.getTime() + 90 * DAY_MS);
    const events: PairEvent[] = [
      { occurredAt: future, sentiment: 1, weight: 1 },
    ];
    // No negative day count, so decay stays at 1 rather than amplifying.
    expect(computePairScore(events, NOW)).toBe(5);
  });
});

describe("time together, the kind of tie, and routine", () => {
  const NOW = new Date("2026-11-27T00:00:00Z");
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
  const visit = (daysAgo: number, extra: Partial<PairEvent> = {}): PairEvent => ({
    occurredAt: ago(daysAgo),
    sentiment: 2,
    weight: 2,
    ...extra,
  });

  it("counts a long stay for more than an evening, with diminishing returns", () => {
    expect(lengthFactor(1)).toBe(1);
    expect(lengthFactor(2)).toBe(2);
    expect(lengthFactor(14)).toBeCloseTo(4.807, 3);
    expect(lengthFactor(30)).toBeCloseTo(5.907, 3);

    const evening = computePairScore([visit(30)], NOW);
    const fortnight = computePairScore([visit(30 + 13, { durationDays: 14 })], NOW);
    expect(fortnight).toBeGreaterThan(evening * 4);
  });

  it("starts the fade from the last day of a stay, not the first", () => {
    const started = ago(20);
    expect(endOf(started, 14).getTime()).toBe(ago(7).getTime());
    // Still going: nothing has faded yet.
    expect(computePairScore([visit(5, { durationDays: 14 })], NOW)).toBe(
      computePairScore([visit(0, { durationDays: 14 })], NOW),
    );
  });

  it("lets family closeness last, and a colleague's fade fast", () => {
    const once = [visit(180)];
    const family = computePairScore(once, NOW, undefined, "FAMILY");
    const friend = computePairScore(once, NOW, undefined, "FRIEND");
    const colleague = computePairScore(once, NOW, undefined, "COLLEAGUE");
    expect(tieHalfLife("FAMILY")).toBe(360);
    expect(tieHalfLife("COLLEAGUE")).toBe(90);
    expect(family).toBeGreaterThan(friend);
    expect(friend).toBeGreaterThan(colleague);
    // The label adds nothing on its own: no shared time, no closeness.
    expect(computePairScore([], NOW, undefined, "FAMILY")).toBe(0);
  });

  it("counts work at a quarter", () => {
    const dinner = computePairScore([visit(1, { weight: 1 })], NOW);
    const meeting = computePairScore([visit(1, { weight: 1, type: "WORK" })], NOW);
    expect(dinner).toBe(10);
    expect(meeting).toBe(2);
  });

  it("levels routine off: twenty lunches in a month count about like five", () => {
    const lunches = (count: number) =>
      Array.from({ length: count }, (_, index) => visit(1 + index, { weight: 1, sentiment: 1 }));
    const twenty = computePairScore(lunches(20), NOW);
    const five = computePairScore(lunches(5), NOW);
    const three = computePairScore(lunches(3), NOW);
    expect(routineFactor(3)).toBe(1);
    expect(routineFactor(6)).toBeCloseTo(0.25, 5);
    expect(three).toBe(15);
    expect(twenty).toBeLessThan(three * 2);
    expect(Math.abs(twenty - five)).toBeLessThanOrEqual(10);
  });

  it("scores the worked example: two weeks home and a weekend in Lyon, as family", () => {
    // From the owner's question: 22 under the old formula, about 95 under this one.
    const events = [
      visit(44 + 13, { durationDays: 14 }),
      visit(377 + 1, { durationDays: 2 }),
    ];
    expect(computePairScore([visit(44), visit(377)], NOW)).toBe(22);
    expect(computePairScore(events, NOW, undefined, "FAMILY")).toBeGreaterThanOrEqual(90);
  });
});
