import { describe, expect, it } from "vitest";
import {
  computeCadence,
  computeSentimentTrend,
  decayedMeanSentiment,
  effectiveSentiment,
  meanSentiment,
  summariseEventTypes,
  summariseSentiment,
  type InsightEvent,
} from "../../src/domain/insights.js";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-07-31T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function event(
  days: number,
  sentiment: number,
  type = "HANGOUT",
  weight = 1,
): InsightEvent {
  return { type, occurredAt: daysAgo(days), sentiment, weight };
}

describe("effectiveSentiment", () => {
  it("falls back to the event sentiment when the person logged none", () => {
    expect(effectiveSentiment(2, null)).toBe(2);
    expect(effectiveSentiment(-1, undefined)).toBe(-1);
  });

  it("treats an override of 0 as a real override", () => {
    expect(effectiveSentiment(2, 0)).toBe(0);
  });
});

describe("meanSentiment", () => {
  it("is 0 for no events rather than NaN", () => {
    expect(meanSentiment([])).toBe(0);
    expect(Number.isNaN(meanSentiment([]))).toBe(false);
  });

  it("averages the sentiments", () => {
    expect(meanSentiment([event(1, 2), event(2, 0), event(3, -2)])).toBe(0);
    expect(meanSentiment([event(1, 2), event(2, 1)])).toBe(1.5);
  });
});

describe("decayedMeanSentiment", () => {
  it("is 0 for no events rather than NaN", () => {
    expect(decayedMeanSentiment([], NOW)).toBe(0);
    expect(Number.isNaN(decayedMeanSentiment([], NOW))).toBe(false);
  });

  it("matches the plain mean when every event is the same age", () => {
    const events = [event(30, 2), event(30, -1)];
    expect(decayedMeanSentiment(events, NOW)).toBe(meanSentiment(events));
  });

  it("leans towards the recent event when old and new disagree", () => {
    // +2 last week against -2 three years ago. The plain mean is 0, the
    // decayed one is close to the recent event because 0.5^3 is 0.125.
    const events = [event(7, 2), event(3 * 365, -2)];

    expect(meanSentiment(events)).toBe(0);
    expect(decayedMeanSentiment(events, NOW)).toBeGreaterThan(1.4);
  });

  it("leans towards the recent event when the recent one is the bad one", () => {
    const events = [event(7, -2), event(3 * 365, 2)];

    expect(meanSentiment(events)).toBe(0);
    expect(decayedMeanSentiment(events, NOW)).toBeLessThan(-1.4);
  });

  it("weights an event at one half life at half the weight of a fresh one", () => {
    // Fresh +2 with decay 1, six months old 0 with decay 0.5.
    // Weighted mean = (2 * 1 + 0 * 0.5) / 1.5 = 1.333...
    const events = [event(0, 2), event(180, 0)];
    expect(decayedMeanSentiment(events, NOW)).toBeCloseTo(1.33, 2);
  });

  it("depends on the gaps between events, not on how old they all are", () => {
    // It is a ratio, so aging the whole history scales both sides alike.
    // How stale the history is lives in the cadence figures instead.
    const events = [event(0, 2), event(700, -2)];
    const today = decayedMeanSentiment(events, NOW);
    const laterOn = decayedMeanSentiment(
      events,
      new Date(NOW.getTime() + 700 * DAY_MS),
    );

    expect(laterOn).toBeCloseTo(today, 6);
  });
});

describe("summariseEventTypes", () => {
  it("returns nothing for no events", () => {
    expect(summariseEventTypes([], NOW)).toEqual([]);
  });

  it("splits the revealed preference by type and keeps the counts", () => {
    const events = [
      event(10, 2, "TRIP"),
      event(40, 2, "TRIP"),
      event(20, -1, "PARTY"),
    ];

    const summary = summariseEventTypes(events, NOW);
    const trip = summary.find((entry) => entry.type === "TRIP");
    const party = summary.find((entry) => entry.type === "PARTY");

    expect(trip).toMatchObject({ count: 2, meanSentiment: 2 });
    expect(party).toMatchObject({ count: 1, meanSentiment: -1 });
    expect(trip?.decayedMeanSentiment).toBeGreaterThan(0);
    expect(party?.decayedMeanSentiment).toBeLessThan(0);
  });

  it("orders by count, then by type name", () => {
    const events = [
      event(1, 1, "MEAL"),
      event(2, 1, "CALL"),
      event(3, 1, "CALL"),
      event(4, 1, "HANGOUT"),
    ];

    expect(summariseEventTypes(events, NOW).map((entry) => entry.type)).toEqual([
      "CALL",
      "HANGOUT",
      "MEAL",
    ]);
  });

  it("reports the latest date per type", () => {
    const events = [event(10, 1, "MEAL"), event(400, 1, "MEAL")];
    expect(summariseEventTypes(events, NOW)[0].lastAt).toBe(
      daysAgo(10).toISOString(),
    );
  });
});

describe("computeCadence", () => {
  it("returns zeros and nulls for an empty history", () => {
    expect(computeCadence([], NOW)).toEqual({
      totalEvents: 0,
      firstEventAt: null,
      lastEventAt: null,
      daysSinceLastEvent: null,
      eventsLastYear: 0,
      eventsPerMonthLastYear: 0,
    });
  });

  it("bounds the history and counts the gap since the last event", () => {
    const cadence = computeCadence(
      [event(400, 1), event(5, 1), event(200, 1)],
      NOW,
    );

    expect(cadence.totalEvents).toBe(3);
    expect(cadence.firstEventAt).toBe(daysAgo(400).toISOString());
    expect(cadence.lastEventAt).toBe(daysAgo(5).toISOString());
    expect(cadence.daysSinceLastEvent).toBe(5);
  });

  it("counts events per month from the last year only", () => {
    const events = [
      ...Array.from({ length: 12 }, (_, index) => event(index * 25, 1)),
      event(500, 1),
      event(900, 1),
    ];

    const cadence = computeCadence(events, NOW);
    expect(cadence.totalEvents).toBe(14);
    expect(cadence.eventsLastYear).toBe(12);
    expect(cadence.eventsPerMonthLastYear).toBe(1);
  });

  it("never reports a negative gap for an event logged ahead of today", () => {
    const future: InsightEvent = {
      type: "TRIP",
      occurredAt: new Date(NOW.getTime() + 30 * DAY_MS),
      sentiment: 1,
      weight: 1,
    };
    expect(computeCadence([future], NOW).daysSinceLastEvent).toBe(0);
  });
});

describe("computeSentimentTrend", () => {
  it("is insufficient with no events at all", () => {
    const trend = computeSentimentTrend([], NOW);

    expect(trend).toMatchObject({
      windowDays: 90,
      recent: { count: 0, mean: 0 },
      previous: { count: 0, mean: 0 },
      delta: null,
      direction: "insufficient",
    });
  });

  it("does not call a single event a trend", () => {
    const trend = computeSentimentTrend([event(3, 2)], NOW);

    expect(trend.recent).toEqual({ count: 1, mean: 2 });
    expect(trend.previous).toEqual({ count: 0, mean: 0 });
    expect(trend.delta).toBeNull();
    expect(trend.direction).toBe("insufficient");
  });

  it("does not call a full recent window a trend when the older one is empty", () => {
    const trend = computeSentimentTrend(
      [event(3, 2), event(10, 2), event(80, 1)],
      NOW,
    );

    expect(trend.recent.count).toBe(3);
    expect(trend.previous.count).toBe(0);
    expect(trend.direction).toBe("insufficient");
  });

  it("reads a warming stretch", () => {
    const trend = computeSentimentTrend(
      [event(10, 2), event(40, 2), event(100, -1), event(150, 0)],
      NOW,
    );

    expect(trend.recent).toEqual({ count: 2, mean: 2 });
    expect(trend.previous).toEqual({ count: 2, mean: -0.5 });
    expect(trend.delta).toBe(2.5);
    expect(trend.direction).toBe("warming");
  });

  it("reads a cooling stretch", () => {
    const trend = computeSentimentTrend(
      [event(10, -2), event(120, 2), event(170, 1)],
      NOW,
    );

    expect(trend.delta).toBeLessThan(0);
    expect(trend.direction).toBe("cooling");
  });

  it("reads an unchanged stretch as steady", () => {
    const trend = computeSentimentTrend([event(10, 1), event(120, 1)], NOW);

    expect(trend.delta).toBe(0);
    expect(trend.direction).toBe("steady");
  });

  it("ignores anything older than the two windows", () => {
    const trend = computeSentimentTrend(
      [event(10, 1), event(120, 1), event(900, -2)],
      NOW,
    );

    expect(trend.recent.count).toBe(1);
    expect(trend.previous.count).toBe(1);
    expect(trend.direction).toBe("steady");
  });

  it("honours a custom window length", () => {
    const events = [event(10, 2), event(40, -2)];

    // At 30 days the older event lands in the previous window and a trend
    // appears, at 90 both sit in the recent window and there is nothing to say.
    expect(computeSentimentTrend(events, NOW, 30).direction).toBe("warming");
    expect(computeSentimentTrend(events, NOW, 90).direction).toBe("insufficient");
  });
});

describe("summariseSentiment", () => {
  it("returns zeros for an empty history", () => {
    const summary = summariseSentiment([], NOW);

    expect(summary).toMatchObject({
      count: 0,
      mean: 0,
      decayedMean: 0,
      positive: 0,
      neutral: 0,
      negative: 0,
    });
    expect(summary.trend.direction).toBe("insufficient");
  });

  it("splits the counts by sign and keeps both means", () => {
    const events = [event(5, 2), event(6, 0), event(7, -1), event(8, 1)];
    const summary = summariseSentiment(events, NOW);

    expect(summary).toMatchObject({
      count: 4,
      positive: 2,
      neutral: 1,
      negative: 1,
      mean: 0.5,
    });
    expect(summary.decayedMean).toBeCloseTo(0.5, 2);
  });
});
