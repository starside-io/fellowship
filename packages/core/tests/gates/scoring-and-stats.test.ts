import { describe, expect, it } from "vitest";

import { computePairScore } from "../../src/domain/scoring.js";
import { recomputeAll } from "../../src/domain/link-engine.js";
import { registry } from "../../src/tools/index.js";
import { seedPerson, seedSelf, testHost } from "./harness.js";

/**
 * Gates: scoring fixtures, LinkStat.score unwritable, and config recompute.
 *
 * LinkStat.score is a cache of a formula over two config keys. No tool writes
 * it, and a change to either key has to recompute every link before the new
 * value counts as applied, or a pair with no new events keeps a wrong score
 * forever.
 */

const NOW = new Date("2026-07-31T12:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

describe("the scoring formula", () => {
  it("gives known event sets known scores, decay included", () => {
    // One perfect evening today: 2 sentiment, weight 2, no decay yet.
    expect(computePairScore([{ occurredAt: NOW, sentiment: 2, weight: 2 }], NOW)).toBe(20);

    // The same evening one half life ago counts half.
    expect(computePairScore([{ occurredAt: daysAgo(180), sentiment: 2, weight: 2 }], NOW)).toBe(10);

    // And two half lives ago, a quarter.
    expect(computePairScore([{ occurredAt: daysAgo(360), sentiment: 2, weight: 2 }], NOW)).toBe(5);

    // A row bad enough to go negative stays negative.
    expect(computePairScore([{ occurredAt: NOW, sentiment: -2, weight: 3 }], NOW)).toBe(-30);

    // The clamp holds at both ends.
    const many = Array.from({ length: 50 }, () => ({
      occurredAt: NOW,
      sentiment: 2,
      weight: 3,
    }));
    expect(computePairScore(many, NOW)).toBe(100);
  });

  it("follows the config rather than a constant", () => {
    const event = [{ occurredAt: daysAgo(180), sentiment: 2, weight: 2 }];

    expect(computePairScore(event, NOW, { halfLifeDays: 180, scoreScale: 5 })).toBe(10);
    // A longer half life keeps more of it.
    expect(computePairScore(event, NOW, { halfLifeDays: 360, scoreScale: 5 })).toBe(14);
    // A bigger scale spreads the same history further up the range.
    expect(computePairScore(event, NOW, { halfLifeDays: 180, scoreScale: 20 })).toBe(40);
  });
});

describe("LinkStat.score", () => {
  it("is not an input of any tool", () => {
    for (const tool of registry.tools) {
      const printed = JSON.stringify(Object.keys(shapeOf(tool.input)));
      expect(printed, tool.name).not.toContain("score\"");
      expect(printed, tool.name).not.toContain("eventCount");
      expect(printed, tool.name).not.toContain("stat");
    }
  });

  it("survives a curation untouched", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Sam Rivera");

      await host.api.invoke("people.log_interaction", {
        title: "Dinner",
        type: "MEAL",
        occurredAt: NOW.toISOString(),
        sentiment: 2,
        weight: 2,
        participants: [{ personId: selfId }, { personId }],
      }, { now: NOW });

      const derived = await host.db.linkStat.findFirstOrThrow();
      expect(derived.score).toBe(20);

      // A manual score is an override readers apply. It does not overwrite the
      // derivation, so dropping it hands the score back.
      await host.api.invoke("people.set_link", {
        aPersonId: selfId,
        bPersonId: personId,
        tie: "CLOSE_FRIEND",
        manualScore: -99,
        notes: "curated by hand",
      }, { now: NOW });

      const after = await host.db.linkStat.findFirstOrThrow();
      expect(after.score).toBe(20);

      const link = await host.db.link.findFirstOrThrow();
      expect(link.manualScore).toBe(-99);
      expect(link.tie).toBe("CLOSE_FRIEND");
    } finally {
      await host.close();
    }
  });
});

describe("a change to halfLifeDays", () => {
  it("leaves no stale cached score once the recompute runs", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Sam Rivera");

      await host.api.invoke("people.log_interaction", {
        title: "Dinner",
        type: "MEAL",
        occurredAt: daysAgo(180).toISOString(),
        sentiment: 2,
        weight: 2,
        participants: [{ personId: selfId }, { personId }],
      }, { now: NOW });

      const before = await host.db.linkStat.findFirstOrThrow();
      expect(before.score).toBe(10);

      // The hook the host owns: recompute every link, then the new value
      // counts as applied.
      await recomputeAll(host.db, NOW, { halfLifeDays: 360, scoreScale: 5 });

      const after = await host.db.linkStat.findFirstOrThrow();
      expect(after.score).toBe(14);
    } finally {
      await host.close();
    }
  });
});

/** The top level keys of a zod object schema, as far as one can be read. */
function shapeOf(schema: unknown): Record<string, unknown> {
  const candidate = schema as { _def?: { shape?: () => Record<string, unknown> } };
  const shape = candidate._def?.shape;
  return typeof shape === "function" ? shape() : {};
}
