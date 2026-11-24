import { describe, expect, it } from "vitest";

import type { CompletionRequest } from "@fellowship/core";

import { DraftError, draftFacts, draftSenders, draftSketch } from "../src/specialist.js";
import { createApp } from "../src/server.js";
import { seedPerson, seedSelf, throwawayHost } from "./harness.js";
import type { MiniHost } from "../src/host.js";

/**
 * The specialist, with a model that answers whatever a test tells it to.
 *
 * What is being checked is not whether a model is any good. It is that a
 * draft, however it comes back, reaches the review queue and nowhere else,
 * that a confirmation is what makes it a write, and that an answer naming a
 * person who does not exist, a field that is not defined, or a diagnosis is
 * dropped here rather than handed to the owner.
 */

/** Replaces the model port with one that answers from a script. */
function scriptModel(host: MiniHost, answers: unknown[]) {
  const asked: CompletionRequest[] = [];
  let index = 0;

  host.ports.models.complete = async (request) => {
    asked.push(request);
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return { text: typeof answer === "string" ? answer : JSON.stringify(answer) };
  };

  return asked;
}

async function withChat(host: MiniHost, personId: string) {
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

  return imported.conversation.id;
}

describe("drafting a sketch", () => {
  it("puts it in the review queue and writes nothing", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      const asked = scriptModel(host, [
        {
          summary:
            "Replies within the hour on weekday evenings, 40 messages a week over three months. Opens about half of the conversations.",
          whatLands: "A specific plan with a time in it.",
          whatToAvoid: "Open ended maybes. Three went unanswered.",
          opener: "Ask about the route they were projecting.",
          sources: ["fellowship logged history, 0 occasions"],
        },
      ]);

      const result = await draftSketch(host, personId);

      expect(result.queued).toHaveLength(1);
      expect(result.queued[0]!.tool).toBe("people.write_sketch");
      expect(result.rejected).toEqual([]);

      // The model was handed the schema, not just asked nicely.
      expect(asked[0]?.schema).toMatchObject({ required: ["summary", "sources"] });

      // Nothing reached the silo.
      expect(await host.silo.personProfile.count()).toBe(0);

      const pending = host.store.listProposals("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.summary).toContain("A sketch of Sam Rivera");
    } finally {
      await host.close();
    }
  });

  it("refuses a diagnosis before the owner ever reads it", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      scriptModel(host, [
        {
          summary:
            "Warm but hard to pin down, which reads as classic anxious attachment given the gaps.",
          sources: ["fellowship logged history"],
        },
      ]);

      const result = await draftSketch(host, personId);

      expect(result.queued).toEqual([]);
      expect(result.rejected[0]?.reason).toContain("diagnosis");
      expect(host.store.listProposals("pending")).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("refuses an answer with no sources, whatever the endpoint claimed", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      scriptModel(host, [
        { summary: "Replies quickly and makes plans that actually happen, mostly.", sources: [] },
      ]);

      await expect(draftSketch(host, personId)).rejects.toBeInstanceOf(DraftError);
      expect(host.store.listProposals("pending")).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("says so plainly when the answer is not JSON at all", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      scriptModel(host, ["Sure! Here is a lovely sketch of Sam."]);

      await expect(draftSketch(host, personId)).rejects.toThrow(/did not answer with JSON/);
    } finally {
      await host.close();
    }
  });

  it("reads JSON back out of a fenced block", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      scriptModel(host, [
        '```json\n{"summary":"Answers in the evening, in paragraphs, over four months of messages.","sources":["history"]}\n```',
      ]);

      const result = await draftSketch(host, personId);
      expect(result.queued).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});

describe("drafting sender matches", () => {
  it("queues one proposal per confident match", async () => {
    const host = await throwawayHost();
    try {
      await seedSelf(host, "Me");
      const personId = await seedPerson(host, "Sam Rivera");
      const conversationId = await withChat(host, personId);

      scriptModel(host, [
        {
          matches: [
            {
              senderName: "Rivs",
              personId,
              confidence: "high",
              evidence: "They answer to the same plans and use the same nickname for the gym.",
            },
          ],
        },
      ]);

      const result = await draftSenders(host, conversationId);

      expect(result.queued).toHaveLength(1);
      expect(result.queued[0]!.tool).toBe("people.map_sender");
      expect(host.store.getProposal(result.queued[0]!.id)?.payload).toMatchObject({
        senderName: "Rivs",
        personId,
      });

      // Still unmapped in the silo: a proposal is not a write.
      const participant = await host.silo.conversationParticipant.findFirstOrThrow({
        where: { conversationId, senderName: "Rivs" },
      });
      expect(participant.personId).toBeNull();
    } finally {
      await host.close();
    }
  });

  it("drops a match onto a person who does not exist", async () => {
    const host = await throwawayHost();
    try {
      await seedSelf(host, "Me");
      const personId = await seedPerson(host, "Sam Rivera");
      const conversationId = await withChat(host, personId);

      scriptModel(host, [
        {
          matches: [
            {
              senderName: "Rivs",
              personId: "11111111-1111-4111-8111-111111111111",
              confidence: "high",
              evidence: "This id was invented, which is the thing that must not get through.",
            },
          ],
        },
      ]);

      const result = await draftSenders(host, conversationId);
      expect(result.queued).toEqual([]);
      expect(result.rejected[0]?.reason).toContain("not in this silo");
    } finally {
      await host.close();
    }
  });

  it("drops a guess, and a sender that is not in the chat", async () => {
    const host = await throwawayHost();
    try {
      await seedSelf(host, "Me");
      const personId = await seedPerson(host, "Sam Rivera");
      const conversationId = await withChat(host, personId);

      scriptModel(host, [
        {
          matches: [
            {
              senderName: "Rivs",
              personId,
              confidence: "low",
              evidence: "Both names start with the same letter, which is not evidence.",
            },
            {
              senderName: "Somebody Else",
              personId,
              confidence: "high",
              evidence: "This sender does not appear anywhere in that conversation at all.",
            },
          ],
        },
      ]);

      const result = await draftSenders(host, conversationId);
      expect(result.queued).toEqual([]);
      expect(result.rejected.map((entry) => entry.reason)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("not in this conversation"),
          expect.stringContaining("too low a confidence"),
        ]),
      );
    } finally {
      await host.close();
    }
  });
});

describe("drafting facts", () => {
  it("splits what it found by the tool that would write it", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      scriptModel(host, [
        {
          facts: [
            {
              kind: "update",
              field: "location",
              value: "Lisbon",
              quote: "moved back to Lisbon in March",
              confidence: "high",
            },
            {
              kind: "allergy",
              value: "peanuts",
              quote: "cannot do peanuts, it is serious",
              confidence: "high",
            },
            {
              kind: "interest",
              value: "bouldering",
              quote: "at the climbing gym most evenings",
              confidence: "medium",
            },
            {
              kind: "update",
              field: "favourite_colour",
              value: "green",
              quote: "loves green",
              confidence: "high",
            },
            {
              kind: "interest",
              value: "maybe cycling",
              quote: "might have mentioned a bike once",
              confidence: "low",
            },
          ],
          unplaced: ["Their sister is called Chloe."],
        },
      ]);

      const result = await draftFacts(host, personId, "Some pasted text about Sam.");

      const tools = result.queued.map((entry) => entry.tool);
      expect(tools).toEqual(["people.update", "people.set_tags"]);

      const tags = host.store.getProposal(result.queued[1]!.id)!.payload as {
        allergies: string[];
        interests: string[];
      };
      expect(tags.allergies).toEqual(["peanuts"]);
      expect(tags.interests).toEqual(["bouldering"]);

      // An allergy is named first in the summary, because it is the half that
      // can hurt someone.
      expect(result.queued[1]!.summary).toMatch(/^allergies/);

      const reasons = result.rejected.map((entry) => entry.reason);
      expect(reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('no field called "favourite_colour"'),
          expect.stringContaining("too low a confidence"),
          expect.stringContaining("nothing in the records takes this"),
        ]),
      );

      // And nothing was written.
      const person = await host.silo.person.findUniqueOrThrow({ where: { id: personId } });
      expect(person.location).toBeNull();
      expect(await host.silo.tag.count()).toBe(0);
    } finally {
      await host.close();
    }
  });
});

describe("confirming a proposal", () => {
  it("is what makes it a write, and only then", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      scriptModel(host, [
        {
          summary:
            "Replies within the hour on weekday evenings, over three months of messages.",
          sources: ["fellowship logged history, 0 occasions"],
        },
      ]);

      const draft = await draftSketch(host, personId);
      const id = draft.queued[0]!.id;

      expect(await host.silo.personProfile.count()).toBe(0);

      const response = await app.request(`/host/review/${id}/confirm`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, state: "confirmed", written: true });

      const profile = await host.silo.personProfile.findUniqueOrThrow({
        where: { personId },
      });
      expect(profile.source).toBe("ASSISTANT");
      // Written, and still not confirmed as true by the owner: those are two
      // different acts and only the first one just happened.
      expect(profile.confirmedAt).toBeNull();

      // A second confirmation is refused rather than writing twice.
      const again = await app.request(`/host/review/${id}/confirm`, { method: "POST" });
      expect(again.status).toBe(409);
    } finally {
      await host.close();
    }
  });

  it("leaves a proposal pending when the tool refuses it", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const { id } = await host.ports.review.propose({
        tool: "people.write_sketch",
        personId: "11111111-1111-4111-8111-111111111111",
        payload: {
          personId: "11111111-1111-4111-8111-111111111111",
          summary: "About a person who does not exist.",
          sources: ["nowhere"],
        },
        summary: "A sketch of nobody",
      });

      const response = await app.request(`/host/review/${id}/confirm`, { method: "POST" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "refused", detail: { code: "not_found" } },
      });

      // Still waiting, because a refusal is not a decision the owner made.
      expect(host.store.listProposals("pending").map((row) => row.id)).toEqual([id]);
    } finally {
      await host.close();
    }
  });

  it("discards without running anything", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      const { id } = await host.ports.review.propose({
        tool: "people.update",
        personId,
        payload: { personId, patch: { location: "Lisbon" } },
        summary: "Set location",
      });

      const response = await app.request(`/host/review/${id}/discard`, { method: "POST" });
      expect(response.status).toBe(200);

      const person = await host.silo.person.findUniqueOrThrow({ where: { id: personId } });
      expect(person.location).toBeNull();
      expect(host.store.listProposals("discarded")).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});

describe("the draft routes", () => {
  it("say the endpoint is not there rather than failing as a bug", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      host.ports.models.complete = async () => {
        throw new Error("Could not reach the model endpoint at http://localhost:11434/v1");
      };

      const response = await app.request(`/host/draft/sketch/${personId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: expect.stringContaining("model endpoint"),
      });
    } finally {
      await host.close();
    }
  });

  it("wants text before it reads any", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      const response = await app.request(`/host/draft/facts/${personId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      });
      expect(response.status).toBe(400);
    } finally {
      await host.close();
    }
  });
});
