import { describe, expect, it } from "vitest";

import { seedPerson, seedSelf, testHost } from "./harness.js";

/**
 * Closeness follows time together and the kind of relationship: a stay counts
 * for more than an evening, the tie sets how fast it fades, and every change
 * that moves the score rescores the pair at once.
 */

const NOW = new Date("2026-11-27T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

async function ownerScore(host: Awaited<ReturnType<typeof testHost>>, personId: string) {
  const stat = await host.db.linkStat.findFirstOrThrow({
    where: { link: { OR: [{ aPersonId: personId }, { bPersonId: personId }] } },
  });
  return stat.score;
}

describe("relationship and time together", () => {
  it("sets the tie when a person is added with a relationship", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const created = (await host.api.invoke("people.create", {
        displayName: "Jane Doe",
        relationship: "FAMILY",
      })) as { person: { id: string }; relationship: string | null };

      expect(created.relationship).toBe("FAMILY");
      const link = await host.db.link.findFirstOrThrow({
        where: { OR: [{ aPersonId: selfId }, { bPersonId: selfId }] },
      });
      expect(link.tie).toBe("FAMILY");
    } finally {
      await host.close();
    }
  });

  it("rescores a pair the moment its tie changes", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Jane Doe");
      await host.api.invoke(
        "people.log_interaction",
        {
          title: "Weekend away",
          type: "TRIP",
          occurredAt: daysAgo(200),
          sentiment: 2,
          weight: 2,
          participants: [{ personId: selfId }, { personId }],
        },
        { now: NOW },
      );
      const asAcquaintance = await ownerScore(host, personId);

      await host.api.invoke(
        "people.set_link",
        { aPersonId: selfId, bPersonId: personId, tie: "FAMILY" },
        { now: NOW },
      );
      expect(await ownerScore(host, personId)).toBeGreaterThan(asAcquaintance);
    } finally {
      await host.close();
    }
  });

  it("edits an occasion's length and attendees, and rescores everyone it touched", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const jane = await seedPerson(host, "Jane Doe");
      const john = await seedPerson(host, "John Doe");
      const logged = (await host.api.invoke(
        "people.log_interaction",
        {
          title: "Visit home",
          type: "TRIP",
          occurredAt: daysAgo(60),
          sentiment: 2,
          weight: 2,
          participants: [{ personId: selfId }, { personId: jane }],
        },
        { now: NOW },
      )) as { event: { id: string } };
      const oneDay = await ownerScore(host, jane);

      const edited = (await host.api.invoke(
        "people.update_event",
        {
          eventId: logged.event.id,
          durationDays: 14,
          participants: [{ personId: selfId }, { personId: jane }, { personId: john }],
        },
        { now: NOW },
      )) as { event: { durationDays: number; participants: unknown[] } };

      expect(edited.event.durationDays).toBe(14);
      expect(edited.event.participants).toHaveLength(3);
      expect(await ownerScore(host, jane)).toBeGreaterThan(oneDay * 3);
      // John is on it now, so he has a link too.
      expect(await ownerScore(host, john)).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  });

  it("refuses an occasion that does not exist, and an impossible length", async () => {
    const host = await testHost();
    try {
      await expect(
        host.api.invoke("people.update_event", {
          eventId: "00000000-0000-4000-8000-000000000000",
          title: "Nothing",
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      const selfId = await seedSelf(host);
      await expect(
        host.api.invoke("people.log_interaction", {
          title: "Forever",
          type: "TRIP",
          occurredAt: daysAgo(1),
          durationDays: 400,
          participants: [{ personId: selfId }],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      await host.close();
    }
  });
});
