import { describe, expect, it } from "vitest";

import { seedPerson, seedSelf, testHost, type TestHost } from "./harness.js";

/**
 * Gate: any model, the same gates.
 *
 * In these tests the test is the model. Nothing calls an endpoint: the tests
 * ask for the context, write the answer an assistant would write, and hand it
 * back, which is exactly what Claude, GPT or a local model behind any MCP
 * client does. If the gates hold here, they hold for every one of them,
 * because the module never knows which model it is talking to.
 */

async function withChat(host: TestHost) {
  await seedSelf(host, "Me");
  const personId = await seedPerson(host, "Sam Rivera");
  const imported = (await host.api.invoke("people.import_chat", {
    text: [
      "01/05/2026, 08:00 - Sam: the ramen place on Tuesday",
      "01/05/2026, 08:05 - Me: works for me",
      "01/05/2026, 09:00 - Rivs: i'll be late",
      "",
    ].join("\n"),
    selfName: "Me",
    personIdBySender: { Sam: personId },
  })) as { conversation: { id: string } };
  return { personId, conversationId: imported.conversation.id };
}

describe("people.draft_context", () => {
  it("hands over the material, the rules and the schema, and writes nothing", async () => {
    const host = await testHost();
    try {
      const { personId } = await withChat(host);
      const before = host.proposals.length;

      const context = (await host.api.invoke("people.draft_context", {
        job: "sketch",
        personId,
      })) as {
        job: string;
        system: string;
        prompt: string;
        schema: { required: string[]; properties: { sources: { minItems: number } } };
        material: { messages: number };
        next: string;
      };

      expect(context.job).toBe("sketch");
      expect(context.system).toContain("No diagnosis");
      expect(context.prompt).toContain("Sam Rivera");
      expect(context.prompt).toContain("ramen");
      // The grammar rule, carried to whichever model reads it.
      expect(context.schema.required).toEqual(["summary", "sources"]);
      expect(context.schema.properties.sources.minItems).toBe(1);
      expect(context.material.messages).toBeGreaterThan(0);
      expect(context.next).toContain("people.propose_draft");

      expect(host.proposals.length).toBe(before);
      expect(host.completions).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("refuses a target that does not exist", async () => {
    const host = await testHost();
    try {
      await expect(
        host.api.invoke("people.draft_context", {
          job: "sketch",
          personId: "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await host.close();
    }
  });
});

describe("people.propose_draft", () => {
  it("queues a sketch any model wrote, and writes nothing", async () => {
    const host = await testHost();
    try {
      const { personId } = await withChat(host);

      const result = (await host.api.invoke("people.propose_draft", {
        target: { job: "sketch", personId },
        draft: {
          summary:
            "Answers within the hour in the morning, plans concretely: named the ramen place and the day.",
          sources: ["imported chats, 3 messages"],
        },
      })) as { queued: Array<{ id: string; tool: string }>; written: boolean };

      expect(result.written).toBe(false);
      expect(result.queued.map((entry) => entry.tool)).toEqual(["people.write_sketch"]);
      expect(await host.db.personProfile.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("refuses an answer that is not in the schema's shape", async () => {
    const host = await testHost();
    try {
      const { personId } = await withChat(host);

      await expect(
        host.api.invoke("people.propose_draft", {
          target: { job: "sketch", personId },
          draft: { summary: "Nice person, warm energy, a joy to be around generally.", sources: [] },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(host.proposals).toHaveLength(0);
    } finally {
      await host.close();
    }
  });

  it("drops a diagnosis, whichever model wrote it", async () => {
    const host = await testHost();
    try {
      const { personId } = await withChat(host);

      const result = (await host.api.invoke("people.propose_draft", {
        target: { job: "sketch", personId },
        draft: {
          summary: "Classic avoidant: replies late, keeps plans vague, goes quiet after friction.",
          sources: ["imported chats"],
        },
      })) as { queued: unknown[]; rejected: Array<{ reason: string }> };

      expect(result.queued).toEqual([]);
      expect(result.rejected[0]?.reason).toContain("diagnosis");
    } finally {
      await host.close();
    }
  });

  it("drops a sender match onto a person who does not exist", async () => {
    const host = await testHost();
    try {
      const { conversationId } = await withChat(host);

      const result = (await host.api.invoke("people.propose_draft", {
        target: { job: "senders", conversationId },
        draft: {
          matches: [
            {
              senderName: "Rivs",
              personId: "11111111-1111-4111-8111-111111111111",
              confidence: "high",
              evidence: "An id the model made up, which must never reach the queue.",
            },
          ],
        },
      })) as { queued: unknown[]; rejected: Array<{ reason: string }> };

      expect(result.queued).toEqual([]);
      expect(result.rejected[0]?.reason).toContain("not in this silo");
    } finally {
      await host.close();
    }
  });
});

describe("people.review and people.decide", () => {
  it("lists what is waiting, and a yes is what writes", async () => {
    const host = await testHost();
    try {
      const { personId } = await withChat(host);

      await host.api.invoke("people.propose_draft", {
        target: { job: "sketch", personId },
        draft: {
          summary:
            "Answers within the hour in the morning, plans concretely: named the ramen place and the day.",
          sources: ["imported chats, 3 messages"],
        },
      });

      const waiting = (await host.api.invoke("people.review", {})) as {
        proposals: Array<{ id: string; tool: string; state: string }>;
      };
      expect(waiting.proposals).toHaveLength(1);
      const id = waiting.proposals[0]!.id;

      // Without the owner's yes, nothing.
      await expect(
        host.api.invoke("people.decide", { proposalId: id, decision: "confirm" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await host.db.personProfile.count()).toBe(0);

      const decided = (await host.api.invoke("people.decide", {
        proposalId: id,
        decision: "confirm",
        confirmedByUser: true,
      })) as { state: string; written: boolean };

      expect(decided).toMatchObject({ state: "confirmed", written: true });
      const profile = await host.db.personProfile.findUniqueOrThrow({ where: { personId } });
      expect(profile.source).toBe("ASSISTANT");
      expect(profile.confirmedAt).toBeNull();

      // Decided once, so a second yes is a conflict, not a second write.
      await expect(
        host.api.invoke("people.decide", {
          proposalId: id,
          decision: "confirm",
          confirmedByUser: true,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await host.close();
    }
  });

  it("discards without running anything", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      const { id } = await host.ports.review.propose({
        tool: "people.update",
        personId,
        payload: { personId, patch: { location: "Lisbon" } },
      });

      await host.api.invoke("people.decide", {
        proposalId: id,
        decision: "discard",
        confirmedByUser: true,
      });

      const person = await host.db.person.findUniqueOrThrow({ where: { id: personId } });
      expect(person.location).toBeNull();
    } finally {
      await host.close();
    }
  });

  it("leaves a proposal pending when the write it names is refused", async () => {
    const host = await testHost();
    try {
      const { id } = await host.ports.review.propose({
        tool: "people.update",
        payload: {
          personId: "11111111-1111-4111-8111-111111111111",
          patch: { location: "Lisbon" },
        },
      });

      await expect(
        host.api.invoke("people.decide", {
          proposalId: id,
          decision: "confirm",
          confirmedByUser: true,
        }),
      ).rejects.toMatchObject({ code: "refused", detail: { code: "not_found" } });

      const still = (await host.api.invoke("people.review", {})) as {
        proposals: Array<{ id: string }>;
      };
      expect(still.proposals.map((row) => row.id)).toEqual([id]);
    } finally {
      await host.close();
    }
  });

  it("will not run a proposal that would decide or propose another", async () => {
    const host = await testHost();
    try {
      const { id } = await host.ports.review.propose({
        tool: "people.decide",
        payload: { proposalId: "anything", decision: "confirm" },
      });

      await expect(
        host.api.invoke("people.decide", {
          proposalId: id,
          decision: "confirm",
          confirmedByUser: true,
        }),
      ).rejects.toMatchObject({ code: "refused" });
    } finally {
      await host.close();
    }
  });
});
