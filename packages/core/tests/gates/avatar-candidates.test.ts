import { describe, expect, it } from "vitest";

import { DEFAULT_AVATAR_RESOLVERS } from "../../src/config/avatar-resolvers.js";
import { seedPerson, testHost } from "./harness.js";

/**
 * The picture candidates a person's own handles produce.
 *
 * The gate is that this is a reading and nothing more: it fetches nothing,
 * stores nothing, and offers only URLs built from handles already on the
 * record. Storing one is people.set_picture, which needs the owner's yes.
 */

type Candidates = {
  candidates: Array<{ resolverId: string; platform: string; url: string; handle: string | null }>;
  hint: string;
  picture: { source: string } | null;
};

const WITH_INSTAGRAM = DEFAULT_AVATAR_RESOLVERS.map((resolver) =>
  resolver.id === "instagram-unavatar" ? { ...resolver, enabled: true } : resolver,
);

describe("people.avatar_candidates", () => {
  it("builds a URL from each handle an enabled resolver matches", async () => {
    const host = await testHost({ avatarResolvers: WITH_INSTAGRAM });
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await host.api.invoke("people.set_contacts", {
        personId,
        contacts: [
          { kind: "SOCIAL", platform: "instagram", value: "@Sam.Rivera" },
          { kind: "SOCIAL", platform: "github", value: "sam" },
          // Snapchat has no resolver, so it contributes nothing.
          { kind: "SOCIAL", platform: "snapchat", value: "samrivera" },
        ],
      });

      const result = (await host.api.invoke("people.avatar_candidates", {
        personId,
      })) as Candidates;

      expect(result.candidates.map((candidate) => candidate.url)).toEqual([
        "https://github.com/sam.png?size=400",
        "https://unavatar.io/instagram/sam.rivera?fallback=false",
      ]);
      // The handle is the cleaned one that was stored, not what was typed.
      expect(result.candidates.at(-1)?.handle).toBe("sam.rivera");
      expect(result.picture).toBeNull();
    } finally {
      await host.close();
    }
  });

  it("says why there is nothing to try", async () => {
    const host = await testHost({ avatarResolvers: WITH_INSTAGRAM });
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      const bare = (await host.api.invoke("people.avatar_candidates", {
        personId,
      })) as Candidates;
      expect(bare.candidates).toEqual([]);
      expect(bare.hint).toMatch(/no contact channels/i);

      await host.api.invoke("people.set_contacts", {
        personId,
        contacts: [{ kind: "SOCIAL", platform: "snapchat", value: "samrivera" }],
      });
      const unmatched = (await host.api.invoke("people.avatar_candidates", {
        personId,
      })) as Candidates;
      expect(unmatched.hint).toMatch(/no enabled resolver matches/i);
    } finally {
      await host.close();
    }
  });

  it("offers nothing at all while every resolver is off", async () => {
    const host = await testHost({
      avatarResolvers: DEFAULT_AVATAR_RESOLVERS.map((resolver) => ({
        ...resolver,
        enabled: false,
      })),
    });
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await host.api.invoke("people.set_contacts", {
        personId,
        contacts: [{ kind: "SOCIAL", platform: "github", value: "sam" }],
      });

      const result = (await host.api.invoke("people.avatar_candidates", {
        personId,
      })) as Candidates;
      expect(result.candidates).toEqual([]);
      expect(result.hint).toMatch(/no resolver is enabled/i);
    } finally {
      await host.close();
    }
  });

  it("fetches nothing and stores nothing", async () => {
    const host = await testHost({ avatarResolvers: WITH_INSTAGRAM });
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await host.api.invoke("people.set_contacts", {
        personId,
        contacts: [{ kind: "SOCIAL", platform: "github", value: "sam" }],
      });
      await host.api.invoke("people.avatar_candidates", { personId });

      expect(host.mediaCalls).toEqual([]);
      expect(await host.db.personAvatar.count()).toBe(0);
      expect(host.audit.at(-1)).toMatchObject({
        tool: "people.avatar_candidates",
        kind: "read",
      });
    } finally {
      await host.close();
    }
  });

  it("reports a picture that is already stored, so keeping one is a replacement", async () => {
    const host = await testHost({ avatarResolvers: WITH_INSTAGRAM });
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await host.api.invoke("people.set_picture", {
        personId,
        url: "https://example.test/picture.png",
        source: "RESOLVER",
        confirmedByUser: true,
      });

      const result = (await host.api.invoke("people.avatar_candidates", {
        personId,
      })) as Candidates;
      expect(result.picture).toMatchObject({ source: "RESOLVER" });
    } finally {
      await host.close();
    }
  });

  it("refuses a person who is not there", async () => {
    const host = await testHost();
    try {
      await expect(
        host.api.invoke("people.avatar_candidates", {
          personId: "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await host.close();
    }
  });
});
