import { describe, expect, it } from "vitest";

import { normaliseTag, similarTitles } from "../../src/domain/drafting/recap.js";
import { seedPerson, seedSelf, testHost, type TestHost } from "./harness.js";

/**
 * Gate: the chat recap.
 *
 * The test is the model, as in drafting.test.ts. What is under test is what
 * happens to its answer: a thing already logged, already proposed or already
 * discarded does not come back, a person who was only mentioned is not put
 * at the table, and the score the owner is shown is the score they get.
 */

const FIRST = [
  "01/05/2026, 08:00 - Jane: dinner at the ramen place was so good last night",
  "01/05/2026, 08:05 - M: best ramen in town",
  "02/05/2026, 19:00 - Jane: i can't stand coriander, it ruined my lunch",
  "03/05/2026, 10:00 - Jane: Sam says hi from Bali",
  "",
].join("\n");

const LATER = [
  "10/05/2026, 09:00 - Jane: that hike yesterday wrecked me",
  "10/05/2026, 09:10 - M: worth it for the view",
  "",
].join("\n");

async function withChat(host: TestHost) {
  const selfId = await seedSelf(host, "Me");
  const jane = await seedPerson(host, "Jane");
  const sam = await seedPerson(host, "Sam");
  const imported = (await host.api.invoke("people.import_chat", {
    text: FIRST,
    personIdBySender: { M: selfId, Jane: jane },
  })) as { conversation: { id: string } };
  return { selfId, jane, sam, conversationId: imported.conversation.id };
}

type Context = {
  job: string;
  system: string;
  prompt: string;
  material: { messages: number; remaining: number };
  target: { job: "recap"; conversationId: string; since?: string; through?: string };
};

type Proposed = {
  queued: Array<{ id: string; tool: string; summary: string | null }>;
  rejected: Array<{ reason: string }>;
  group: { id: string; title: string; detail: string | null } | null;
};

function dinner(selfId: string, jane: string) {
  return {
    title: "Ramen dinner",
    type: "MEAL",
    occurredAt: "2026-04-30",
    participantIds: [selfId, jane],
    sentiment: 2,
    weight: 1,
    quote: "dinner at the ramen place was so good last night",
    confidence: "high",
  };
}

describe("recap context", () => {
  it("hands over the window, the people and the target, and writes nothing", async () => {
    const host = await testHost();
    try {
      const { conversationId, jane, selfId } = await withChat(host);
      const before = host.proposals.length;

      const context = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;

      expect(context.job).toBe("recap");
      expect(context.system).toContain("A mention is not presence");
      expect(context.prompt).toContain(jane);
      expect(context.prompt).toContain(selfId);
      expect(context.prompt).toContain("coriander");
      expect(context.material.messages).toBe(4);
      expect(context.material.remaining).toBe(0);
      expect(context.target.through).toBe("2026-05-03T10:00:00.000Z");
      expect(host.proposals.length).toBe(before);
    } finally {
      await host.close();
    }
  });
});

describe("recap proposals", () => {
  it("queues a note, the events and the preferences under one group with the score they would reach", async () => {
    const host = await testHost();
    try {
      const { conversationId, jane, selfId } = await withChat(host);
      const context = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;

      const result = (await host.api.invoke("people.propose_draft", {
        target: context.target,
        draft: {
          summary: "A good ramen dinner, a coriander complaint, and news from Sam.",
          events: [dinner(selfId, jane)],
          preferences: [
            {
              kind: "dislike",
              personId: jane,
              value: "coriander",
              quote: "i can't stand coriander",
              confidence: "high",
            },
          ],
        },
      })) as Proposed;

      expect(result.rejected).toEqual([]);
      expect(result.queued.map((row) => row.tool)).toEqual([
        "people.add_note",
        "people.log_interaction",
        "people.set_tags",
      ]);
      expect(result.group?.title).toContain("2026-05-01 to 2026-05-03");
      expect(result.group?.detail).toMatch(/^If all confirmed: Jane 0 → \d+/);

      // Nothing is written by proposing.
      expect(await host.db.event.count()).toBe(0);

      const groupIds = new Set(host.proposals.map((row) => row.group?.id));
      expect(groupIds.size).toBe(1);
    } finally {
      await host.close();
    }
  });

  it("drops what is logged, proposed or discarded already, and flags a contradiction", async () => {
    const host = await testHost();
    try {
      const { conversationId, jane, selfId } = await withChat(host);

      // Logged already, the same evening, under another name.
      await host.api.invoke("people.log_interaction", {
        title: "Dinner with Jane",
        type: "MEAL",
        occurredAt: "2026-04-30T20:00:00.000Z",
        participants: [{ personId: selfId }, { personId: jane }],
      });
      // Recorded already, with an accent and a capital.
      await host.api.invoke("people.set_tags", {
        personId: jane,
        interests: ["Crème brûlée", "Coriander"],
      });
      // Proposed before and discarded.
      host.proposals.push({
        id: "old",
        tool: "people.set_tags",
        personId: jane,
        payload: { personId: jane, mode: "add", interests: ["hiking"] },
        state: "discarded",
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
      });

      const context = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;
      const pref = (kind: string, value: string) => ({
        kind,
        personId: jane,
        value,
        quote: "it ruined my lunch",
        confidence: "high",
      });

      const result = (await host.api.invoke("people.propose_draft", {
        target: context.target,
        draft: {
          summary: "Ramen again, and a few things about food.",
          events: [dinner(selfId, jane)],
          preferences: [
            pref("interest", "creme brulee"),
            pref("interest", "Hiking"),
            pref("dislike", "coriander"),
          ],
        },
      })) as Proposed;

      const reasons = result.rejected.map((row) => row.reason);
      expect(reasons).toContain('already logged: "Dinner with Jane" on 2026-04-30');
      expect(reasons).toContain("already recorded as interest");
      expect(reasons).toContain("already proposed and discarded");

      const tags = result.queued.filter((row) => row.tool === "people.set_tags");
      expect(tags).toHaveLength(1);
      expect(tags[0]?.summary).toContain("check: already recorded as interest");
      expect(result.group?.detail).toBe("No new events, so no score moves.");
    } finally {
      await host.close();
    }
  });

  it("keeps two meetups on consecutive days, and does not repeat the note on a second run", async () => {
    const host = await testHost();
    try {
      const { conversationId, jane, selfId } = await withChat(host);
      const context = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;
      const hangout = (occurredAt: string, title: string) => ({
        ...dinner(selfId, jane),
        type: "HANGOUT",
        occurredAt,
        title,
      });

      const first = (await host.api.invoke("people.propose_draft", {
        target: context.target,
        draft: {
          summary: "Two evenings out, one after the other.",
          events: [
            hangout("2026-05-01", "Drinks at the harbour"),
            hangout("2026-05-02", "Drinks at the rooftop"),
          ],
        },
      })) as Proposed;
      expect(first.rejected).toEqual([]);
      expect(first.queued.map((row) => row.tool)).toEqual([
        "people.add_note",
        "people.log_interaction",
        "people.log_interaction",
      ]);

      const again = (await host.api.invoke("people.propose_draft", {
        target: context.target,
        draft: {
          summary: "Two evenings out, one after the other.",
          events: [
            hangout("2026-05-01", "Drinks at the harbour"),
            hangout("2026-05-03", "Brunch"),
          ],
        },
      })) as Proposed;
      expect(again.queued.map((row) => row.tool)).toEqual(["people.log_interaction"]);
      expect(again.rejected.map((row) => row.reason)).toEqual([
        'already proposed and pending: "Drinks at the harbour" on 2026-05-01',
      ]);
    } finally {
      await host.close();
    }
  });

  it("keeps two of a kind on one day within a draft, and drops the same one named twice", async () => {
    const host = await testHost();
    try {
      const { conversationId, jane, selfId } = await withChat(host);
      const context = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;
      const hangout = (title: string) => ({
        ...dinner(selfId, jane),
        type: "HANGOUT",
        occurredAt: "2026-05-02",
        title,
      });

      const result = (await host.api.invoke("people.propose_draft", {
        target: context.target,
        draft: {
          summary: "Late drinks, then the morning together.",
          events: [
            hangout("Late drinks at the Lantern"),
            hangout("Morning at his place"),
            hangout("Drinks at the Lantern, late"),
          ],
        },
      })) as Proposed;

      expect(result.queued.filter((row) => row.tool === "people.log_interaction")).toHaveLength(2);
      expect(result.rejected.map((row) => row.reason)).toEqual([
        "the draft lists this event twice",
      ]);
    } finally {
      await host.close();
    }
  });

  it("refuses a bystander, a stranger, a plan that has not happened, and a guess", async () => {
    const host = await testHost();
    try {
      const { conversationId, jane, selfId, sam } = await withChat(host);
      const context = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;

      const result = (await host.api.invoke("people.propose_draft", {
        target: context.target,
        draft: {
          summary: "Sam is in Bali, and there is talk of a trip.",
          events: [
            // Sam was only mentioned, and is not in this chat.
            { ...dinner(selfId, jane), participantIds: [selfId, sam], title: "Bali" },
            { ...dinner(selfId, jane), occurredAt: "2026-07-01", title: "Trip" },
            { ...dinner(selfId, jane), confidence: "low", title: "Maybe" },
          ],
        },
      })) as Proposed;

      expect(result.rejected.map((row) => row.reason)).toEqual([
        "a participant is not one of the people in this chat",
        "it had not happened yet by the end of this window",
        "too low a confidence",
      ]);
      expect(result.queued.map((row) => row.tool)).toEqual(["people.add_note"]);
    } finally {
      await host.close();
    }
  });

  it("starts the next recap where the last one stopped", async () => {
    const host = await testHost();
    try {
      const { conversationId, jane, selfId } = await withChat(host);
      const first = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;
      await host.api.invoke("people.propose_draft", {
        target: first.target,
        draft: { summary: "Ramen and coriander.", events: [dinner(selfId, jane)] },
      });

      const nothing = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;
      expect(nothing.material.messages).toBe(0);

      await host.api.invoke("people.import_chat", {
        text: FIRST + LATER,
        personIdBySender: { M: selfId, Jane: jane },
      });
      const next = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;
      expect(next.material.messages).toBe(2);
      expect(next.prompt).toContain("hike");
      expect(next.prompt).not.toContain("coriander, it ruined");
      expect(next.target.since).toBe(first.target.through);
    } finally {
      await host.close();
    }
  });

  it("confirming lands the score the preview showed, and adds tags without wiping any", async () => {
    const host = await testHost();
    try {
      const { conversationId, jane, selfId } = await withChat(host);
      await host.api.invoke("people.set_tags", { personId: jane, interests: ["ramen"] });

      const context = (await host.api.invoke("people.draft_context", {
        job: "recap",
        conversationId,
      })) as Context;
      const result = (await host.api.invoke("people.propose_draft", {
        target: context.target,
        draft: {
          summary: "Ramen and a coriander complaint.",
          events: [dinner(selfId, jane)],
          preferences: [
            {
              kind: "dislike",
              personId: jane,
              value: "coriander",
              quote: "i can't stand coriander",
              confidence: "high",
            },
          ],
        },
      })) as Proposed;

      const projected = Number(/→ (-?\d+)/.exec(result.group?.detail ?? "")?.[1]);
      for (const row of result.queued) {
        await host.api.invoke("people.decide", {
          proposalId: row.id,
          decision: "confirm",
          confirmedByUser: true,
        });
      }

      const stat = await host.db.linkStat.findFirstOrThrow({
        where: { link: { OR: [{ aPersonId: jane }, { bPersonId: jane }] } },
      });
      expect(stat.score).toBe(projected);

      const person = await host.db.person.findUniqueOrThrow({
        where: { id: jane },
        select: {
          interests: { select: { name: true } },
          dislikes: { select: { name: true } },
          notes: { select: { searchText: true } },
        },
      });
      expect(person.interests.map((tag) => tag.name)).toEqual(["ramen"]);
      expect(person.dislikes.map((tag) => tag.name)).toEqual(["coriander"]);
      expect(person.notes[0]?.searchText).toContain("Ramen and a coriander complaint");
    } finally {
      await host.close();
    }
  });
});

describe("recap text checks", () => {
  it("treats case, accents and a plural as the same tag", () => {
    expect(normaliseTag("Crème Brûlée")).toBe(normaliseTag("creme brulee"));
    expect(normaliseTag("Dumplings")).toBe(normaliseTag("dumpling"));
  });

  it("calls two titles similar on shared meaningful words, not pronouns and filler", () => {
    expect(similarTitles("Ramen dinner", "Dinner at the ramen place")).toBe(true);
    expect(similarTitles("Hike", "Ramen dinner")).toBe(false);
    expect(similarTitles("Drinks at the harbour", "Drinks at the rooftop")).toBe(false);
    expect(similarTitles("Brunch", "Sunday brunch")).toBe(true);
    expect(
      similarTitles(
        "Small disagreement about meeting after her shift",
        "Picked her up near the station after her shift, then dinner",
      ),
    ).toBe(false);
    expect(
      similarTitles("Lent her a book from his shelf", "Late drinks, night at his place with her"),
    ).toBe(false);
  });
});
