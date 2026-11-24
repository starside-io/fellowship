import { describe, expect, it } from "vitest";

import { seedPerson, seedSelf, testHost, type TestHost } from "./harness.js";

/**
 * Whose messages are whose.
 *
 * Every chat figure is split by side: volume each way, who opens after a
 * silence, how fast each answers, who gets the last word. Get the owner's side
 * wrong and every one of them is inside out. A real re-import did exactly
 * that: the export called the owner "M", the record says "Me", the mapping
 * carried across, and 29,333 of the owner's messages were counted as the
 * other person's.
 */

/** The owner appears as "M" in the export, which matches no name on record. */
const EXPORT = [
  "01/05/2026, 08:00 - Jane: morning",
  "01/05/2026, 08:05 - M: morning, coffee?",
  "01/05/2026, 08:06 - Jane: yes",
  "",
].join("\n");

async function sideCounts(host: TestHost, conversationId: string) {
  const rows = await host.db.message.groupBy({
    by: ["isFromSelf"],
    where: { conversationId },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((row) => [String(row.isFromSelf), row._count._all]));
}

describe("import_chat", () => {
  it("treats a sender mapped to the owner's record as the owner", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host, "Me");
      const jane = await seedPerson(host, "Jane");

      const imported = (await host.api.invoke("people.import_chat", {
        text: EXPORT,
        personIdBySender: { M: selfId, Jane: jane },
      })) as { conversation: { id: string; title: string | null } };

      const participant = await host.db.conversationParticipant.findFirstOrThrow({
        where: { conversationId: imported.conversation.id, senderName: "M" },
      });
      expect(participant.isSelf).toBe(true);
      expect(await sideCounts(host, imported.conversation.id)).toEqual({
        true: 1,
        false: 2,
      });

      // Titled after the other person, never after the owner.
      expect(imported.conversation.title).toBe("Jane");
    } finally {
      await host.close();
    }
  });

  it("keeps the owner's side through a re-import that carries the mapping", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host, "Me");
      const jane = await seedPerson(host, "Jane");

      await host.api.invoke("people.import_chat", {
        text: EXPORT,
        personIdBySender: { M: selfId, Jane: jane },
      });

      // The same chat, extended, imported with no mapping at all: the way
      // the UI imports it. The mapping comes from the stored conversation.
      const again = (await host.api.invoke("people.import_chat", {
        text: `${EXPORT}01/05/2026, 09:00 - M: see you there\n`,
      })) as { replaced: boolean; conversation: { id: string; title: string | null } };

      expect(again.replaced).toBe(true);
      expect(again.conversation.title).toBe("Jane");
      expect(await sideCounts(host, again.conversation.id)).toEqual({
        true: 2,
        false: 2,
      });

      const insights = (await host.api.invoke("people.chat_insights", {
        personId: jane,
      })) as { volume: { self: { messages: number }; them: { messages: number } } };
      expect(insights.volume.self.messages).toBe(2);
      expect(insights.volume.them.messages).toBe(2);
    } finally {
      await host.close();
    }
  });

  it("lets an explicit mapping win over a name that looks like the owner", async () => {
    const host = await testHost();
    try {
      await seedSelf(host, "Me");
      const friend = await seedPerson(host, "Maria");

      const imported = (await host.api.invoke("people.import_chat", {
        text: EXPORT,
        selfName: "M",
        personIdBySender: { M: friend },
      })) as { conversation: { id: string } };

      const participant = await host.db.conversationParticipant.findFirstOrThrow({
        where: { conversationId: imported.conversation.id, senderName: "M" },
      });
      expect(participant.isSelf).toBe(false);
    } finally {
      await host.close();
    }
  });
});

describe("map_sender", () => {
  it("makes a sender the owner when mapped to the owner, and not when mapped away", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host, "Me");
      const jane = await seedPerson(host, "Jane");

      const imported = (await host.api.invoke("people.import_chat", {
        text: EXPORT,
        personIdBySender: { Jane: jane },
      })) as { conversation: { id: string } };
      const conversationId = imported.conversation.id;

      // Unmapped and unnamed, so not the owner yet.
      expect(await sideCounts(host, conversationId)).toEqual({ false: 3 });

      await host.api.invoke("people.map_sender", {
        conversationId,
        senderName: "M",
        personId: selfId,
      });
      expect(await sideCounts(host, conversationId)).toEqual({ true: 1, false: 2 });

      // Mapped to someone else instead, the messages stop being the owner's.
      const maria = await seedPerson(host, "Maria");
      await host.api.invoke("people.map_sender", {
        conversationId,
        senderName: "M",
        personId: maria,
      });
      expect(await sideCounts(host, conversationId)).toEqual({ false: 3 });
    } finally {
      await host.close();
    }
  });
});
