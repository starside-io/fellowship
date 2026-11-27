import { describe, expect, it } from "vitest";

import { registry } from "../../src/tools/index.js";
import { seedPerson, seedSelf, testHost } from "./harness.js";

/**
 * The surface itself: the registry's shape, and every tool run at least once.
 *
 * The count matters: 43, of which four are the model agnostic drafting tools
 * that let any model behind any assistant propose a draft for review.
 */

const EXPECTED = {
  read: [
    "people.search",
    "people.get",
    "people.self",
    "people.fields",
    "people.activity",
    "people.timeline",
    "people.insights",
    "people.chat_insights",
    "people.read_messages",
    "people.graph",
    "people.social_platforms",
    "people.check_socials",
    "people.avatar_candidates",
    "people.resolve_person",
    "people.export",
    "people.dashboard",
    "people.personality_status",
    "people.vcard",
    "people.draft_context",
    "people.review",
  ],
  write: [
    "people.create",
    "people.update",
    "people.archive",
    "people.add_note",
    "people.log_interaction",
    "people.update_event",
    "people.set_contacts",
    "people.set_tags",
    "people.set_circles",
    "people.set_custom_values",
    "people.set_fields",
    "people.set_favour",
    "people.set_link",
    "people.import_chat",
    "people.map_sender",
    "people.set_resolvers",
    "people.propose_draft",
  ],
  "needs-ok": [
    "people.attach_socials",
    "people.write_sketch",
    "people.set_personality",
    "people.set_picture",
    "people.import",
    "people.decide",
  ],
} as const;

describe("the registry", () => {
  it("holds the tools the spec's tables list, by kind", () => {
    for (const [kind, names] of Object.entries(EXPECTED)) {
      const declared = registry.tools
        .filter((tool) => tool.kind === kind)
        .map((tool) => tool.name)
        .sort();
      expect(declared, kind).toEqual([...names].sort());
    }
    expect(registry.tools).toHaveLength(43);
  });

  it("namespaces every tool and gives each a title and a line of its own", () => {
    for (const tool of registry.tools) {
      expect(tool.name, tool.name).toMatch(/^people\.[a-z_]+$/);
      expect(tool.title.length, tool.name).toBeGreaterThan(3);
      expect(tool.summary.length, tool.name).toBeGreaterThan(20);
    }
  });

  it("refuses a name it does not have", async () => {
    const host = await testHost();
    try {
      await expect(host.api.invoke("people.delete_everything", {})).rejects.toMatchObject({
        code: "unknown_tool",
      });
      expect(host.api.describe()).toHaveLength(43);
    } finally {
      await host.close();
    }
  });
});

describe("every tool runs", () => {
  it("covers the rest of the surface end to end", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Sam Rivera");

      // Field definitions, then a value against one.
      const fields = (await host.api.invoke("people.set_fields", {
        fields: [{ label: "Coffee order", type: "TEXT" }],
      })) as { fields: Array<{ key: string }> };
      expect(fields.fields[0]!.key).toBe("coffee_order");

      expect(await host.api.invoke("people.fields", {})).toMatchObject({
        fields: [{ key: "coffee_order" }],
      });

      await host.api.invoke("people.set_custom_values", {
        personId,
        values: [{ key: "coffee_order", value: "flat white" }],
      });
      expect(await host.db.customValue.count()).toBe(1);

      // An unknown key is refused rather than invented.
      await expect(
        host.api.invoke("people.set_custom_values", {
          personId,
          values: [{ key: "shoe_size", value: 44 }],
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      // Clearing one removes the row.
      await host.api.invoke("people.set_custom_values", {
        personId,
        values: [{ key: "coffee_order", value: null }],
      });
      expect(await host.db.customValue.count()).toBe(0);

      // Facts, then the archive flag.
      await host.api.invoke("people.update", {
        personId,
        patch: { location: "Lisbon", howWeMet: "Climbing gym" },
      });
      await host.api.invoke("people.archive", { personId, archived: true });
      await host.api.invoke("people.archive", { personId, archived: false });

      // The owner's own record is not archivable.
      await expect(
        host.api.invoke("people.archive", { personId: selfId }),
      ).rejects.toMatchObject({ code: "refused" });

      // A note, an event, then the timeline that joins them.
      await host.api.invoke("people.add_note", {
        personId,
        body: { type: "doc", content: [] },
        occurredAt: "2026-06-03T00:00:00.000Z",
      });
      await host.api.invoke("people.log_interaction", {
        title: "Dinner at Kanji",
        type: "MEAL",
        occurredAt: "2026-06-02T12:00:00.000Z",
        participants: [{ personId: selfId }, { personId }],
      });

      const timeline = (await host.api.invoke("people.timeline", { personId })) as {
        entries: Array<{ kind: string }>;
      };
      expect(timeline.entries.map((entry) => entry.kind)).toEqual(["note", "event"]);

      const activity = (await host.api.invoke(
        "people.activity",
        { days: 3650 },
        { now: new Date("2026-06-04T00:00:00.000Z") },
      )) as { events: Array<{ title: string }>; quietPeople: unknown[] };
      expect(activity.events.map((event) => event.title)).toEqual(["Dinner at Kanji"]);

      // A chat, then binding a sender to a person after the fact.
      const imported = (await host.api.invoke("people.import_chat", {
        text: "01/05/2026, 08:00 - Sam: morning\n01/05/2026, 08:05 - Me: morning\n",
        fileName: "chat.txt",
        selfName: "Me",
      })) as {
        ok: boolean;
        conversation: { id: string };
        unmappedSenders: Array<{ senderName: string }>;
      };
      expect(imported.ok).toBe(true);
      expect(imported.unmappedSenders.map((sender) => sender.senderName)).toEqual(["Sam"]);

      const mapped = (await host.api.invoke("people.map_sender", {
        conversationId: imported.conversation.id,
        senderName: "Sam",
        personId,
      })) as { messagesUpdated: number };
      expect(mapped.messagesUpdated).toBe(1);

      // The resolver list, which lives in the host's settings.
      const resolvers = (await host.api.invoke("people.set_resolvers", {
        resolvers: [
          {
            id: "github",
            label: "GitHub",
            platform: "github",
            urlTemplate: "https://github.com/{handle}.png?size=400",
            enabled: true,
          },
        ],
      })) as { resolvers: Array<{ id: string }> };
      expect(resolvers.resolvers.map((resolver) => resolver.id)).toEqual(["github"]);
      expect(host.config.avatarResolvers).toHaveLength(1);

      // A template that could be downgraded to cleartext is refused.
      await expect(
        host.api.invoke("people.set_resolvers", {
          resolvers: [
            {
              id: "bad",
              label: "Bad",
              platform: "github",
              urlTemplate: "http://example.test/{handle}.png",
              enabled: true,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      // Export, then a dry run import that names what a replace would destroy.
      const snapshot = await host.api.invoke("people.export", {});
      const dryRun = (await host.api.invoke("people.import", {
        snapshot,
        mode: "replace",
        dryRun: true,
        confirmedByUser: true,
      })) as { written: boolean; wouldDestroy: { people: number; messages: number } };

      expect(dryRun.written).toBe(false);
      expect(dryRun.wouldDestroy.people).toBe(2);
      expect(dryRun.wouldDestroy.messages).toBe(2);

      const imports = (await host.api.invoke("people.import", {
        snapshot,
        mode: "replace",
        confirmedByUser: true,
      })) as { written: boolean; counts: { people: number } };
      expect(imports.written).toBe(true);
      expect(imports.counts.people).toBe(2);
      expect(await host.db.person.count()).toBe(2);
    } finally {
      await host.close();
    }
  });
});

describe("search, once FTS5 is behind it", () => {
  it("finds a person by a name typed without its accents", async () => {
    const host = await testHost();
    try {
      await host.api.invoke("people.create", { displayName: "Hélène Dupré" });

      const result = (await host.api.invoke("people.search", {
        query: "helene",
      })) as { people: Array<{ displayName: string }> };

      expect(result.people.map((person) => person.displayName)).toEqual([
        "Hélène Dupré",
      ]);
    } finally {
      await host.close();
    }
  });

  it("finds message text, and says how many matched beyond the page", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host, "Me");
      const personId = await seedPerson(host, "Sam");

      await host.api.invoke("people.import_chat", {
        text: [
          "01/05/2026, 08:00 - Sam: the ramen place on Tuesday",
          "01/05/2026, 08:05 - Me: ramen again?",
          "01/05/2026, 09:00 - Sam: café after",
          "",
        ].join("\n"),
        selfName: "Me",
        personIdBySender: { Sam: personId },
      });

      const result = (await host.api.invoke("people.search", {
        query: "ramen",
        limit: 1,
      })) as {
        messages: Array<{ body: string; snippet: string }>;
        messageTotal: number;
      };

      expect(result.messages).toHaveLength(1);
      expect(result.messageTotal).toBe(2);
      expect(result.messages[0]!.snippet).toContain("‹");

      // An accent in a body is as findable as one in a name.
      const accented = (await host.api.invoke("people.search", {
        query: "cafe",
      })) as { messages: unknown[] };
      expect(accented.messages).toHaveLength(1);

      // And the search can be told to leave message text alone.
      const quiet = (await host.api.invoke("people.search", {
        query: "ramen",
        includeMessages: false,
      })) as { messages: unknown[]; messageTotal: number };
      expect(quiet.messages).toEqual([]);
      expect(quiet.messageTotal).toBe(0);

      void selfId;
    } finally {
      await host.close();
    }
  });

  it("searches one person's thread through read_messages", async () => {
    const host = await testHost();
    try {
      await seedSelf(host, "Me");
      const personId = await seedPerson(host, "Sam");

      await host.api.invoke("people.import_chat", {
        text: [
          "01/05/2026, 08:00 - Sam: the ramen place on Tuesday",
          "01/05/2026, 08:05 - Me: sounds good",
          "01/05/2026, 09:00 - Sam: or sushi",
          "",
        ].join("\n"),
        selfName: "Me",
        personIdBySender: { Sam: personId },
      });

      const hits = (await host.api.invoke("people.read_messages", {
        personId,
        query: "ramen",
      })) as {
        query: string;
        messages: Array<{ body: string }>;
        page: { total: number };
      };

      expect(hits.query).toBe("ramen");
      expect(hits.messages).toHaveLength(1);
      expect(hits.page.total).toBe(1);

      // Without a query it is still the whole thread, newest first.
      const thread = (await host.api.invoke("people.read_messages", {
        personId,
      })) as { messages: Array<{ body: string }> };
      expect(thread.messages).toHaveLength(3);
      expect(thread.messages[0]!.body.trim()).toBe("or sushi");

      // And a read of a search is audited with what it handed over.
      const audited = host.audit.filter(
        (entry) => entry.tool === "people.read_messages",
      );
      expect(audited.some((entry) => entry.detail?.["returned"] === 1)).toBe(true);
    } finally {
      await host.close();
    }
  });
});
