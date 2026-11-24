import { describe, expect, it } from "vitest";

import { seedPerson, seedSelf, testHost } from "./harness.js";

/**
 * Gate: no invented people.
 *
 * log_interaction returns unmatched names instead of creating rows. Inventing
 * a person from a name in a sentence is how a tracker fills up with ghosts,
 * and the reference implementation did exactly that from its event form.
 */

describe("people.log_interaction", () => {
  it("returns an unmatched name and writes nothing at all", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const before = await host.db.person.count();

      const result = (await host.api.invoke("people.log_interaction", {
        title: "Dinner at Kanji",
        type: "MEAL",
        occurredAt: "2026-06-01T12:00:00.000Z",
        participants: [{ personId: selfId }, { name: "Nobody I Know" }],
      })) as { written: boolean; unmatched: Array<{ name: string }> };

      expect(result.written).toBe(false);
      expect(result.unmatched.map((entry) => entry.name)).toEqual(["Nobody I Know"]);

      expect(await host.db.person.count()).toBe(before);
      expect(await host.db.event.count()).toBe(0);
      expect(await host.db.eventParticipant.count()).toBe(0);
      expect(await host.db.link.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("offers the near misses it did find", async () => {
    const host = await testHost();
    try {
      await seedSelf(host);
      await seedPerson(host, "Sam Rivera");

      const result = (await host.api.invoke("people.log_interaction", {
        title: "Coffee",
        type: "HANGOUT",
        occurredAt: "2026-06-01T12:00:00.000Z",
        participants: [{ name: "Sam" }],
      })) as {
        written: boolean;
        unmatched: Array<{ name: string; candidates: Array<{ displayName: string }> }>;
      };

      expect(result.written).toBe(false);
      expect(result.unmatched[0]!.candidates.map((person) => person.displayName)).toEqual([
        "Sam Rivera",
      ]);
    } finally {
      await host.close();
    }
  });

  it("logs the event once every name resolves", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      await seedPerson(host, "Sam Rivera");

      const result = (await host.api.invoke("people.log_interaction", {
        title: "Dinner at Kanji",
        type: "MEAL",
        occurredAt: "2026-06-01T12:00:00.000Z",
        sentiment: 2,
        participants: [{ personId: selfId }, { name: "Sam Rivera" }],
      })) as { written: boolean; personIds: string[] };

      expect(result.written).toBe(true);
      expect(result.personIds).toHaveLength(2);
      expect(await host.db.event.count()).toBe(1);

      // The link between the two of them is derived on the way out.
      const links = await host.db.link.findMany({ include: { stat: true } });
      expect(links).toHaveLength(1);
      expect(links[0]!.stat?.eventCount).toBe(1);
      expect(links[0]!.stat!.score).toBeGreaterThan(0);

      // And the event is announced after the write, not before.
      expect(host.events.map((event) => event.name)).toContain("people.interaction.logged");
    } finally {
      await host.close();
    }
  });

  it("refuses a participant id that is not a person", async () => {
    const host = await testHost();
    try {
      await expect(
        host.api.invoke("people.log_interaction", {
          title: "Coffee",
          type: "HANGOUT",
          occurredAt: "2026-06-01T12:00:00.000Z",
          participants: [{ personId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await host.db.event.count()).toBe(0);
    } finally {
      await host.close();
    }
  });
});
