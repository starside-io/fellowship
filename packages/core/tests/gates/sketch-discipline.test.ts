import { describe, expect, it } from "vitest";

import { checkSketch } from "../../src/domain/sketch-discipline.js";
import { seedPerson, testHost } from "./harness.js";

/**
 * Gate: sketch discipline.
 *
 * A fixture set of diagnosis-shaped drafts is rejected, and sources must be
 * non-empty. The rule is that a sketch holds observable behaviour with a quote
 * or a number behind it. "Slow to reply" is an observation; "avoidant" is a
 * diagnosis wearing an observation's clothes.
 */

/** Drafts that must never land, each one shaped like something real. */
const DIAGNOSES: Array<[string, Record<string, unknown>]> = [
  [
    "an attachment style",
    { summary: "Warm but hard to pin down. Classic anxious attachment." },
  ],
  [
    "a bare clinical label",
    { summary: "Replies in bursts, then nothing for a week. Avoidant." },
  ],
  [
    "a Myers-Briggs type",
    { summary: "Reads as an INFJ: deep one to one, drained by groups." },
  ],
  [
    "an enneagram number",
    { summary: "Enneagram type 2w1, so praise lands better than advice." },
  ],
  [
    "a mental health inference",
    { summary: "The scattered replies look like undiagnosed ADHD." },
  ],
  [
    "inferred psychology",
    { whatToAvoid: "Do not bring up their father, clear abandonment issues there." },
  ],
  [
    "a diagnosis hidden in a trait label",
    {
      summary: "Quick to answer, slow to commit.",
      traits: [
        { key: "attach", label: "Attachment style", left: "Secure", right: "Avoidant", value: 70 },
      ],
    },
  ],
  [
    "a label in the opener",
    { opener: "Ask how the narcissistic ex is doing" },
  ],
];

describe("checkSketch", () => {
  it.each(DIAGNOSES)("flags %s", (_name, draft) => {
    const findings = checkSketch(draft);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("passes a draft that only says what happened", () => {
    expect(
      checkSketch({
        summary:
          "Replies within the hour on weekday evenings, 40 messages a week over the last three months. Opens about half the conversations.",
        whatLands: "A specific plan with a time in it. Sent two counter-proposals in April.",
        whatToAvoid: "Open ended maybes. Three went unanswered.",
        opener: "Ask about the route they were projecting at the gym.",
        traits: [
          { key: "pace", label: "Reply pace", left: "Slow", right: "Fast", value: 70 },
        ],
      }),
    ).toEqual([]);
  });
});

describe("people.write_sketch", () => {
  it("refuses every diagnosis-shaped draft, writing nothing", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      for (const [name, draft] of DIAGNOSES) {
        await expect(
          host.api.invoke("people.write_sketch", {
            personId,
            ...draft,
            sources: ["fellowship logged history, 14 events"],
            confirmedByUser: true,
          }),
          name,
        ).rejects.toMatchObject({ code: "refused" });
      }

      expect(await host.db.personProfile.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("refuses a sketch with no sources", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      await expect(
        host.api.invoke("people.write_sketch", {
          personId,
          summary: "Replies within the hour.",
          sources: [],
          confirmedByUser: true,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      await expect(
        host.api.invoke("people.write_sketch", {
          personId,
          summary: "Replies within the hour.",
          confirmedByUser: true,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(await host.db.personProfile.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("lands a clean sketch unconfirmed, with its sources and its provenance", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      await host.api.invoke("people.write_sketch", {
        personId,
        summary: "Replies within the hour on weekday evenings.",
        whatLands: "A specific plan with a time in it.",
        sources: ["fellowship logged history, 14 events", "https://github.com/sam"],
        confirmedByUser: true,
      });

      const profile = await host.db.personProfile.findUniqueOrThrow({
        where: { personId },
      });
      expect(profile.source).toBe("ASSISTANT");
      expect(profile.generatedAt).not.toBeNull();
      // Nothing confirms itself. That is the user's own action in the app.
      expect(profile.confirmedAt).toBeNull();
      expect(profile.sources).toEqual([
        "fellowship logged history, 14 events",
        "https://github.com/sam",
      ]);

      expect(host.events.map((event) => event.name)).toContain("people.sketch.written");
    } finally {
      await host.close();
    }
  });
});
