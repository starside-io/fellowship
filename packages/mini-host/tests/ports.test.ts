import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { seedPerson, seedSelf, throwawayHost } from "./harness.js";

/**
 * The ports, and the two that carry a rule rather than a lookup: the settings
 * recompute hook, and a privacy port that stays the identity function.
 */

describe("the settings port", () => {
  it("hands back the defaults until something is stored", async () => {
    const host = await throwawayHost();
    try {
      const config = await host.ports.settings.get();
      expect(config.halfLifeDays).toBe(180);
      expect(config.scoreScale).toBe(5);
      expect(config.messageChunk).toBe(500);
      expect(config.avatarResolvers.map((resolver) => resolver.id)).toEqual([
        "linkedin-unavatar",
        "tiktok-unavatar",
        "youtube-unavatar",
        "github",
        "gravatar",
        "instagram-unavatar",
      ]);
    } finally {
      await host.close();
    }
  });

  it("persists a change in host.db, not in the silo", async () => {
    const host = await throwawayHost();
    try {
      await host.ports.settings.set({ messageChunk: 250 });
      expect((await host.ports.settings.get()).messageChunk).toBe(250);
      expect(host.store.readSetting("module.config")).toMatchObject({ messageChunk: 250 });

      const siloTables = (
        await host.silo.$queryRawUnsafe<Array<{ name: string }>>(
          `SELECT "name" FROM sqlite_master WHERE "type" = 'table'`,
        )
      ).map((row) => row.name);
      expect(siloTables).not.toContain("setting");
    } finally {
      await host.close();
    }
  });

  it("refuses a value outside the declared range", async () => {
    const host = await throwawayHost();
    try {
      await expect(host.ports.settings.set({ halfLifeDays: 5 })).rejects.toThrow();
      expect((await host.ports.settings.get()).halfLifeDays).toBe(180);
    } finally {
      await host.close();
    }
  });

  it("recomputes every cached score before a half life change counts", async () => {
    const host = await throwawayHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Sam Rivera");

      const now = new Date("2026-07-31T12:00:00.000Z");
      await host.api.invoke(
        "people.log_interaction",
        {
          title: "Dinner",
          type: "MEAL",
          occurredAt: new Date(now.getTime() - 180 * 86_400_000).toISOString(),
          sentiment: 2,
          weight: 2,
          participants: [{ personId: selfId }, { personId }],
        },
        { now },
      );

      const before = await host.silo.linkStat.findFirstOrThrow();
      expect(before.score).toBe(10);

      await host.ports.settings.set({ halfLifeDays: 360 });

      // The recompute uses the real clock, so the figure moves with it: what
      // matters is that the cache no longer holds the old half life's answer.
      const after = await host.silo.linkStat.findFirstOrThrow();
      expect(after.score).not.toBe(before.score);
      expect((await host.ports.settings.get()).halfLifeDays).toBe(360);
    } finally {
      await host.close();
    }
  });
});

describe("the privacy port", () => {
  it("is the identity function, and says so rather than pretending", async () => {
    const host = await throwawayHost();
    try {
      const text = "ありがとう 🙏 see you at 8";
      expect(host.ports.privacy.redact(text)).toBe(text);
    } finally {
      await host.close();
    }
  });
});

describe("the refs port", () => {
  it("resolves a person in this silo and nothing else", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      expect(await host.ports.refs.resolve(`module://people/person/${personId}`)).toMatchObject({
        status: "resolved",
        label: "Sam Rivera",
      });

      expect(
        await host.ports.refs.resolve("module://people/person/11111111-1111-4111-8111-111111111111"),
      ).toMatchObject({ status: "unavailable" });

      // Another module's ref is Locked here, because there is no other module.
      expect(await host.ports.refs.resolve("module://memory/note/1")).toMatchObject({
        status: "unavailable",
      });
    } finally {
      await host.close();
    }
  });
});

describe("the chat-export connector", () => {
  it("hands over what is in the inbox, once, and remembers where it stopped", async () => {
    const inbox = mkdtempSync(join(tmpdir(), "fellowship-inbox-"));
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, "sam.txt"),
      "01/05/2026, 08:00 - Sam: morning\n01/05/2026, 08:05 - Me: morning\n",
    );

    const host = await throwawayHost({ inbox });
    try {
      const first = await host.ports.connectors.pull("chat-export");
      expect(first.items).toHaveLength(1);
      expect(first.items[0]!.id).toBe("sam.txt");
      expect((first.items[0]!.payload as { text: string }).text).toContain("morning");

      // The cursor is in host.db, so the same file is not replayed.
      const second = await host.ports.connectors.pull("chat-export");
      expect(second.items).toHaveLength(0);
      expect(host.store.readCursor("chat-export")).toBe(first.cursor);
    } finally {
      await host.close();
    }
  });

  it("treats a missing inbox as nothing to do", async () => {
    const host = await throwawayHost({ inbox: join(tmpdir(), "fellowship-no-such-inbox") });
    try {
      expect((await host.ports.connectors.pull("chat-export")).items).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("has one connector and refuses the name of another", async () => {
    const host = await throwawayHost();
    try {
      await expect(host.ports.connectors.pull("email")).rejects.toThrow(/one connector/);
    } finally {
      await host.close();
    }
  });
});

describe("the review and bus ports", () => {
  it("write to host.db, and the bus records after the fact", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      // people.create emits, and the feed carries it.
      const events = host.store.listEvents();
      expect(events.map((event) => event.name)).toContain("people.person.created");

      const { id } = await host.ports.review.propose({
        tool: "people.set_picture",
        personId,
        payload: { url: "https://example.test/a.png" },
        summary: "A picture for Sam Rivera",
      });
      expect(host.store.listProposals("pending")[0]!.id).toBe(id);
    } finally {
      await host.close();
    }
  });
});
