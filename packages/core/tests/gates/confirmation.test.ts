import { describe, expect, it } from "vitest";

import { registry } from "../../src/tools/index.js";
import { ToolError } from "../../src/tools/registry.js";
import { seedPerson, seedSelf, testHost } from "./harness.js";

/**
 * Gate: confirmation enforced.
 *
 * Each needs-OK tool refuses without confirmedByUser: true, and no other path
 * writes a sketch, a handle or a picture.
 */

const NEEDS_OK = [
  "people.attach_socials",
  "people.write_sketch",
  "people.set_personality",
  "people.set_picture",
  "people.import",
  "people.decide",
];

describe("the needs-OK tools", () => {
  it("are exactly the six the spec names", () => {
    const declared = registry.tools
      .filter((tool) => tool.kind === "needs-ok")
      .map((tool) => tool.name)
      .sort();
    expect(declared).toEqual([...NEEDS_OK].sort());
  });

  it("refuse a call with the flag missing", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      const calls: Array<[string, Record<string, unknown>]> = [
        ["people.attach_socials", { personId, candidates: [], checkToken: "x" }],
        ["people.write_sketch", { personId, summary: "Replies at night.", sources: ["history"] }],
        ["people.set_picture", { personId, url: "https://example.test/a.png" }],
        ["people.import", { snapshot: {}, mode: "merge" }],
        ["people.decide", { proposalId: "proposal-1", decision: "confirm" }],
      ];

      for (const [name, input] of calls) {
        await expect(host.api.invoke(name, input), name).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    } finally {
      await host.close();
    }
  });

  it("refuse a call with the flag set to false", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await expect(
        host.api.invoke("people.write_sketch", {
          personId,
          summary: "Replies at night.",
          sources: ["history"],
          confirmedByUser: false,
        }),
      ).rejects.toBeInstanceOf(ToolError);
    } finally {
      await host.close();
    }
  });

  it("write nothing when they refuse", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await host.api
        .invoke("people.write_sketch", { personId, summary: "x", sources: ["history"] })
        .catch(() => undefined);
      await host.api
        .invoke("people.set_picture", { personId, url: "https://example.test/a.png" })
        .catch(() => undefined);

      expect(await host.db.personProfile.count()).toBe(0);
      expect(await host.db.personAvatar.count()).toBe(0);
      expect(host.mediaCalls).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("no other path writes what they write", () => {
  it("leaves the sketch, the picture and the citations to them", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Sam Rivera");

      // Every write tool, called with something plausible.
      await host.api.invoke("people.update", {
        personId,
        patch: { location: "Lisbon" },
      });
      await host.api.invoke("people.set_contacts", {
        personId,
        contacts: [{ kind: "SOCIAL", platform: "github", value: "sam" }],
      });
      await host.api.invoke("people.set_tags", { personId, interests: ["ramen"] });
      await host.api.invoke("people.set_circles", { personId, circles: ["Climbing"] });
      await host.api.invoke("people.set_favour", {
        personId,
        direction: "I_OWE_THEM",
        description: "dinner",
      });
      await host.api.invoke("people.set_link", {
        aPersonId: selfId,
        bPersonId: personId,
        tie: "FRIEND",
      });
      await host.api.invoke("people.log_interaction", {
        title: "Dinner",
        type: "MEAL",
        occurredAt: "2026-06-01T12:00:00.000Z",
        participants: [{ personId: selfId }, { personId }],
      });

      expect(await host.db.personProfile.count()).toBe(0);
      expect(await host.db.personAvatar.count()).toBe(0);

      // A contact written through the plain path carries no verification.
      const contacts = await host.db.contactChannel.findMany();
      expect(contacts).toHaveLength(1);
      expect(contacts[0]!.verifiedAt).toBeNull();
    } finally {
      await host.close();
    }
  });

  it("exposes no way to set verifiedAt or confirmedAt", () => {
    // The flags that mean "the user stood behind this" are not inputs.
    for (const tool of registry.tools) {
      const shape = JSON.stringify(Object.keys(describeInput(tool.input)));
      expect(shape, tool.name).not.toContain("verifiedAt");
      expect(shape, tool.name).not.toContain("confirmedAt");
    }
  });
});

/** The top level keys of a zod object schema, as far as one can be read. */
function describeInput(schema: unknown): Record<string, unknown> {
  const candidate = schema as { _def?: { shape?: () => Record<string, unknown> } };
  const shape = candidate._def?.shape;
  return typeof shape === "function" ? shape() : {};
}
