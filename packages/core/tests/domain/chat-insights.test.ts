import { describe, expect, it } from "vitest";
import {
  computeCadence,
  computeCadenceTrend,
  computeLastWord,
  computeReplyLatency,
  computeRhythm,
  computeVolume,
  countInitiations,
  longestSilence,
  medianOf,
  percentileOf,
  THRESHOLDS,
  type ChatMessage,
} from "../../src/domain/chat-insights.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = new Date("2026-07-31T12:00:00.000Z");

/** A message sent `minutes` after the anchor, from you or from them. */
function at(base: Date, minutes: number, isFromSelf: boolean, length = 40): ChatMessage {
  return {
    sentAt: new Date(base.getTime() + minutes * MINUTE_MS),
    isFromSelf,
    length,
  };
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe("medianOf and percentileOf", () => {
  it("are null for no values rather than NaN", () => {
    expect(medianOf([])).toBeNull();
    expect(percentileOf([], 0.9)).toBeNull();
  });

  it("take the middle value, averaging an even sample", () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 2, 3])).toBe(2.5);
  });

  it("takes the nearest rank for a percentile", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileOf(values, 0.9)).toBe(9);
    expect(percentileOf(values, 1)).toBe(10);
  });
});

describe("countInitiations", () => {
  const start = new Date("2026-01-01T09:00:00.000Z");

  it("counts the first message and every one after a six hour silence", () => {
    // Three stretches of talking. You open the first and the third, they open
    // the second. The gaps inside a stretch are minutes, the gaps between are
    // seven hours and a day.
    const messages: ChatMessage[] = [
      at(start, 0, true),
      at(start, 3, false),
      at(start, 9, true),
      at(start, 7 * 60, false),
      at(start, 7 * 60 + 4, true),
      at(start, 31 * 60, true),
      at(start, 31 * 60 + 20, false),
    ];

    const result = countInitiations(messages);

    expect(result.total).toBe(3);
    expect(result.self.count).toBe(2);
    expect(result.them.count).toBe(1);
    expect(result.self.percent).toBeCloseTo(66.7, 1);
    expect(result.them.percent).toBeCloseTo(33.3, 1);
  });

  it("does not count a message five hours and 59 minutes after the last", () => {
    const messages: ChatMessage[] = [
      at(start, 0, true),
      at(start, 6 * 60 - 1, false),
    ];
    expect(countInitiations(messages).total).toBe(1);

    const wider: ChatMessage[] = [at(start, 0, true), at(start, 6 * 60, false)];
    const result = countInitiations(wider);
    expect(result.total).toBe(2);
    expect(result.them.count).toBe(1);
  });

  it("orders the input itself, so a shuffled array counts the same", () => {
    const messages: ChatMessage[] = [
      at(start, 7 * 60, false),
      at(start, 0, true),
      at(start, 3, false),
    ];
    const result = countInitiations(messages);
    expect(result.total).toBe(2);
    expect(result.self.count).toBe(1);
    expect(result.them.count).toBe(1);
  });

  it("reports too few openers as insufficient", () => {
    const messages: ChatMessage[] = [at(start, 0, true), at(start, 2, false)];
    expect(countInitiations(messages).sufficient).toBe(false);
  });

  it("is zeros for no messages rather than NaN", () => {
    const result = countInitiations([]);
    expect(result.total).toBe(0);
    expect(result.self.count).toBe(0);
    expect(result.them.count).toBe(0);
    expect(result.self.percent).toBeNull();
    expect(result.sufficient).toBe(false);
  });
});

describe("computeReplyLatency", () => {
  const start = new Date("2026-02-10T08:00:00.000Z");

  it("ignores consecutive messages from the same sender", () => {
    // They send three in a row, then you answer 10 minutes after the last of
    // them. The only reply pair is that 10 minute one.
    const messages: ChatMessage[] = [
      at(start, 0, false),
      at(start, 1, false),
      at(start, 2, false),
      at(start, 12, true),
    ];

    const result = computeReplyLatency(messages);

    expect(result.self.replies).toBe(1);
    expect(result.them.replies).toBe(0);
    expect(result.self.medianMinutes.count).toBe(1);
    expect(result.self.medianMinutes.value).toBeNull();
    expect(result.self.medianMinutes.sufficient).toBe(false);
  });

  it("times each direction separately once there are enough pairs", () => {
    // Ten clean back and forth pairs: you answer in 2 minutes, they in 30.
    const messages: ChatMessage[] = [];
    let cursor = 0;
    for (let round = 0; round < 10; round += 1) {
      messages.push(at(start, cursor, false));
      cursor += 2;
      messages.push(at(start, cursor, true));
      cursor += 30;
    }

    const result = computeReplyLatency(messages);

    expect(result.self.replies).toBe(10);
    expect(result.them.replies).toBe(9);
    expect(result.self.medianMinutes.value).toBe(2);
    expect(result.them.medianMinutes.value).toBe(30);
    expect(result.self.medianMinutes.sufficient).toBe(true);
  });

  it("drops a pair wider than the reply window, it opens rather than answers", () => {
    const messages: ChatMessage[] = [
      at(start, 0, false),
      at(start, 13 * 60, true),
    ];
    const result = computeReplyLatency(messages);
    expect(result.self.replies).toBe(0);
    expect(result.windowHours).toBe(12);
  });

  it("is zeros for no messages rather than NaN", () => {
    const result = computeReplyLatency([]);
    expect(result.self.replies).toBe(0);
    expect(result.them.replies).toBe(0);
    expect(result.self.medianMinutes.value).toBeNull();
    expect(result.them.p90Minutes.value).toBeNull();
  });
});

describe("longestSilence", () => {
  const start = new Date("2026-03-01T00:00:00.000Z");

  it("finds the widest gap and the messages either side of it", () => {
    const messages: ChatMessage[] = [
      at(start, 0, true),
      at(start, 60, false),
      { sentAt: new Date(start.getTime() + 20 * DAY_MS), isFromSelf: true, length: 10 },
      { sentAt: new Date(start.getTime() + 21 * DAY_MS), isFromSelf: false, length: 10 },
    ];

    const gap = longestSilence(messages);

    expect(gap.days).toBeCloseTo(19.96, 1);
    expect(gap.hours).toBeCloseTo(479, 0);
    expect(gap.from).toBe(new Date(start.getTime() + 60 * MINUTE_MS).toISOString());
    expect(gap.to).toBe(new Date(start.getTime() + 20 * DAY_MS).toISOString());
  });

  it("is null for a single message, there is no gap to measure", () => {
    expect(longestSilence([at(start, 0, true)])).toEqual({
      hours: null,
      days: null,
      from: null,
      to: null,
    });
    expect(longestSilence([]).hours).toBeNull();
  });
});

describe("computeCadenceTrend", () => {
  function spread(from: number, to: number, count: number): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      const day = from - ((from - to) * index) / Math.max(count - 1, 1);
      messages.push({ sentAt: daysAgo(day), isFromSelf: index % 2 === 0, length: 20 });
    }
    return messages;
  }

  it("reads a heavier recent window as busier", () => {
    const messages = [
      ...spread(300, 200, 10),
      ...spread(179, 91, 10),
      ...spread(89, 1, 40),
    ];

    const trend = computeCadenceTrend(messages, NOW);

    expect(trend.windowDays).toBe(90);
    expect(trend.recent.count).toBe(40);
    expect(trend.previous.count).toBe(10);
    expect(trend.change).toBe(3);
    expect(trend.direction).toBe("busier");
  });

  it("reads a lighter recent window as quieter", () => {
    const messages = [
      ...spread(300, 200, 10),
      ...spread(179, 91, 40),
      ...spread(89, 1, 10),
    ];

    const trend = computeCadenceTrend(messages, NOW);

    expect(trend.recent.count).toBe(10);
    expect(trend.previous.count).toBe(40);
    expect(trend.direction).toBe("quieter");
  });

  it("reads two even windows as steady", () => {
    const messages = [
      ...spread(300, 200, 10),
      ...spread(179, 91, 20),
      ...spread(89, 1, 21),
    ];

    expect(computeCadenceTrend(messages, NOW).direction).toBe("steady");
  });

  it("refuses to call a direction when history does not cover both windows", () => {
    // Busy, but the chat only started 100 days ago, so the older window is
    // empty for want of history rather than for want of talking.
    const messages = spread(100, 1, 60);

    const trend = computeCadenceTrend(messages, NOW);

    expect(trend.direction).toBe("insufficient");
    expect(trend.change).toBeNull();
    expect(trend.recent.count).toBeGreaterThan(0);
  });

  it("refuses to call a direction on a handful of messages", () => {
    const messages = [...spread(300, 200, 4), ...spread(179, 1, 5)];

    const trend = computeCadenceTrend(messages, NOW);

    expect(trend.recent.count + trend.previous.count).toBeLessThan(
      THRESHOLDS.trendMessages,
    );
    expect(trend.direction).toBe("insufficient");
  });

  it("is zeros for no messages rather than NaN", () => {
    const trend = computeCadenceTrend([], NOW);
    expect(trend.recent).toEqual({ count: 0, perWeek: 0 });
    expect(trend.previous).toEqual({ count: 0, perWeek: 0 });
    expect(trend.change).toBeNull();
    expect(trend.direction).toBe("insufficient");
  });
});

describe("computeCadence", () => {
  it("is zeros for no messages rather than NaN", () => {
    const cadence = computeCadence([], NOW);

    expect(cadence.totalMessages).toBe(0);
    expect(cadence.firstMessageAt).toBeNull();
    expect(cadence.lastMessageAt).toBeNull();
    expect(cadence.daysSinceLastMessage).toBeNull();
    expect(cadence.spanDays).toBe(0);
    expect(cadence.activeDays).toBe(0);
    expect(cadence.messagesPerWeek).toEqual({
      value: null,
      count: 0,
      sufficient: false,
    });
    expect(cadence.weekly).toEqual([]);
    expect(JSON.stringify(cadence)).not.toContain("NaN");
  });

  it("counts active days, the span, and days since the last message", () => {
    const messages: ChatMessage[] = [
      { sentAt: daysAgo(30), isFromSelf: true, length: 10 },
      { sentAt: daysAgo(30), isFromSelf: false, length: 10 },
      { sentAt: daysAgo(9), isFromSelf: true, length: 10 },
      { sentAt: daysAgo(2), isFromSelf: false, length: 10 },
    ];

    const cadence = computeCadence(messages, NOW);

    expect(cadence.totalMessages).toBe(4);
    expect(cadence.activeDays).toBe(3);
    expect(cadence.spanDays).toBe(28);
    expect(cadence.daysSinceLastMessage).toBe(2);
    expect(cadence.firstMessageAt).toBe(daysAgo(30).toISOString());
    expect(cadence.lastMessageAt).toBe(daysAgo(2).toISOString());
  });

  it("keeps quiet weeks in the weekly series as zeros", () => {
    const base = new Date("2026-01-05T10:00:00.000Z");
    const messages: ChatMessage[] = [
      { sentAt: base, isFromSelf: true, length: 10 },
      { sentAt: new Date(base.getTime() + 21 * DAY_MS), isFromSelf: false, length: 10 },
    ];

    const cadence = computeCadence(messages, NOW);

    expect(cadence.weekly).toHaveLength(4);
    expect(cadence.weekly.map((point) => point.total)).toEqual([1, 0, 0, 1]);
    expect(cadence.weekly[0].weekStart).toBe("2026-01-05T00:00:00.000Z");
    expect(cadence.weekly[0].self).toBe(1);
    expect(cadence.weekly[3].them).toBe(1);
  });
});

describe("computeVolume", () => {
  it("is zeros for no messages rather than NaN", () => {
    const volume = computeVolume([]);

    expect(volume.total).toBe(0);
    expect(volume.self.messages).toBe(0);
    expect(volume.them.messages).toBe(0);
    expect(volume.self.medianLength.value).toBeNull();
    expect(volume.them.meanLength.value).toBeNull();
    expect(volume.ratio).toEqual({ value: null, count: 0, sufficient: false });
    expect(JSON.stringify(volume)).not.toContain("NaN");
  });

  it("splits the counts and lengths by side once the sample is deep enough", () => {
    const start = new Date("2026-04-01T09:00:00.000Z");
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 15; index += 1) {
      messages.push(at(start, index * 10, true, 100));
    }
    for (let index = 0; index < 10; index += 1) {
      messages.push(at(start, index * 10 + 5, false, 20));
    }

    const volume = computeVolume(messages);

    expect(volume.total).toBe(25);
    expect(volume.self.messages).toBe(15);
    expect(volume.them.messages).toBe(10);
    expect(volume.self.medianLength.value).toBe(100);
    expect(volume.them.meanLength.value).toBe(20);
    expect(volume.ratio.value).toBe(1.5);
    expect(volume.ratio.sufficient).toBe(true);
  });

  it("holds the ratio back until there are enough messages", () => {
    const start = new Date("2026-04-01T09:00:00.000Z");
    const messages = [at(start, 0, true), at(start, 5, false)];

    expect(computeVolume(messages).ratio.value).toBeNull();
  });
});

describe("computeRhythm and computeLastWord", () => {
  const start = new Date("2026-05-04T22:00:00.000Z");

  it("buckets by hour and weekday, shifting off UTC when asked", () => {
    const messages: ChatMessage[] = [at(start, 0, true), at(start, 30, false)];

    const utc = computeRhythm(messages);
    expect(utc.byHour).toHaveLength(24);
    expect(utc.byWeekday).toHaveLength(7);
    expect(utc.byHour[22].total).toBe(2);
    expect(utc.byHour[22].self).toBe(1);
    expect(utc.byWeekday[0].total).toBe(2);

    // Two hours ahead of UTC pushes both into the next day, just past midnight.
    const shifted = computeRhythm(messages, 120);
    expect(shifted.byHour[0].total).toBe(2);
    expect(shifted.byWeekday[1].total).toBe(2);
  });

  it("gives the last word to whoever closes each stretch of talking", () => {
    const messages: ChatMessage[] = [
      at(start, 0, true),
      at(start, 5, false),
      at(start, 8 * 60, true),
      at(start, 8 * 60 + 2, true),
      at(start, 40 * 60, false),
    ];

    const lastWord = computeLastWord(messages);

    expect(lastWord.sessions).toBe(3);
    expect(lastWord.them).toBe(2);
    expect(lastWord.self).toBe(1);
    expect(lastWord.selfPercent).toBeCloseTo(33.3, 1);
    expect(lastWord.sufficient).toBe(false);
  });

  it("is zeros for no messages rather than NaN", () => {
    const rhythm = computeRhythm([]);

    expect(rhythm.byHour.every((bucket) => bucket.total === 0)).toBe(true);
    expect(rhythm.byWeekday.every((bucket) => bucket.total === 0)).toBe(true);
    expect(rhythm.lastWord.sessions).toBe(0);
    expect(rhythm.lastWord.selfPercent).toBeNull();
    expect(JSON.stringify(rhythm)).not.toContain("NaN");
  });
});
