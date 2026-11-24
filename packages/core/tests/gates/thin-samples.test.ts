import { describe, expect, it } from "vitest";

import { seedPerson, seedSelf, testHost } from "./harness.js";

/**
 * Gate: thin samples.
 *
 * Below-threshold input returns a null value with the count beside it and
 * sufficient false, and a trend with an empty window reads as insufficient.
 * Never a number: a confident figure over four messages is the horoscope this
 * whole feature exists to avoid.
 */

const CHAT = `01/05/2026, 08:00 - Sam: morning
01/05/2026, 08:05 - Me: morning
01/05/2026, 09:00 - Sam: ramen later?
01/05/2026, 09:30 - Me: yes
`;

async function importedChat(thresholds?: Record<string, number>) {
  const host = await testHost(
    thresholds ? { chatThresholds: { ...defaults(), ...thresholds } } : {},
  );
  const selfId = await seedSelf(host, "Me");
  const personId = await seedPerson(host, "Sam");

  await host.api.invoke("people.import_chat", {
    text: CHAT,
    fileName: "chat.txt",
    selfName: "Me",
    personIdBySender: { Sam: personId },
  });

  return { host, personId, selfId };
}

function defaults() {
  return {
    messages: 20,
    lengths: 10,
    openers: 6,
    replies: 8,
    p90Replies: 12,
    trendMessages: 10,
    sessions: 5,
  };
}

describe("a chat too thin to mean anything", () => {
  it("says so rather than putting a number on it", async () => {
    const { host, personId } = await importedChat();
    try {
      const insights = (await host.api.invoke("people.chat_insights", {
        personId,
      })) as {
        messageCount: number;
        sufficient: boolean;
        volume: { ratio: { value: number | null; count: number; sufficient: boolean } };
        latency: { self: { medianMinutes: { value: number | null; sufficient: boolean } } };
        initiation: { sufficient: boolean };
        cadence: { trend: { direction: string } };
        thresholds: { messages: number };
      };

      expect(insights.messageCount).toBe(4);
      expect(insights.sufficient).toBe(false);

      expect(insights.volume.ratio.value).toBeNull();
      expect(insights.volume.ratio.count).toBe(4);
      expect(insights.volume.ratio.sufficient).toBe(false);

      expect(insights.latency.self.medianMinutes.value).toBeNull();
      expect(insights.latency.self.medianMinutes.sufficient).toBe(false);
      expect(insights.initiation.sufficient).toBe(false);

      // One window of history is not a direction.
      expect(insights.cadence.trend.direction).toBe("insufficient");

      // And the thresholds it judged itself against come back with it.
      expect(insights.thresholds.messages).toBe(20);
    } finally {
      await host.close();
    }
  });

  it("judges itself against the configured thresholds, not a constant", async () => {
    const { host, personId } = await importedChat({ messages: 3, lengths: 2 });
    try {
      const insights = (await host.api.invoke("people.chat_insights", {
        personId,
      })) as {
        sufficient: boolean;
        volume: { ratio: { value: number | null; sufficient: boolean } };
        thresholds: { messages: number };
      };

      expect(insights.thresholds.messages).toBe(3);
      expect(insights.sufficient).toBe(true);
      expect(insights.volume.ratio.sufficient).toBe(true);
      expect(insights.volume.ratio.value).not.toBeNull();
    } finally {
      await host.close();
    }
  });
});

describe("a history too thin for a trend", () => {
  it("reports insufficient rather than steady", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Sam Rivera");

      await host.api.invoke("people.log_interaction", {
        title: "Dinner",
        type: "MEAL",
        occurredAt: "2026-06-01T12:00:00.000Z",
        sentiment: 2,
        participants: [{ personId: selfId }, { personId }],
      });

      const insights = (await host.api.invoke(
        "people.insights",
        { personId },
        { now: new Date("2026-06-02T12:00:00.000Z") },
      )) as {
        sentiment: { trend: { direction: string; delta: number | null } };
        cadence: { totalEvents: number };
      };

      expect(insights.cadence.totalEvents).toBe(1);
      expect(insights.sentiment.trend.direction).toBe("insufficient");
      expect(insights.sentiment.trend.delta).toBeNull();
    } finally {
      await host.close();
    }
  });
});
