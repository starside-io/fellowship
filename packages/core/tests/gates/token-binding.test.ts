import { afterEach, describe, expect, it, vi } from "vitest";

import { seedPerson, testHost } from "./harness.js";

/**
 * Gate: token binding.
 *
 * attach_socials refuses a token issued for a different candidate set, and one
 * over 15 minutes old. The flag says a human said yes; the token says the
 * human said yes to this. A host that renders a stale or substituted proposal
 * cannot get a write through, and the module does not have to trust that the
 * host showed the truth.
 */

const SAM = {
  platform: "github",
  handle: "sam",
  sourceUrl: "https://github.com/sam",
  evidence: "Their GitHub profile links the same site as their bio.",
  confidence: "high",
} as const;

const OTHER = {
  platform: "instagram",
  handle: "sam.rivera",
  sourceUrl: "https://instagram.com/sam.rivera",
  evidence: "The bio names the climbing gym they posted about.",
  confidence: "high",
} as const;

afterEach(() => {
  vi.useRealTimers();
});

async function checked(host: Awaited<ReturnType<typeof testHost>>, personId: string, candidates: unknown[]) {
  return (await host.api.invoke("people.check_socials", {
    personId,
    candidates,
  })) as { checkToken: string };
}

describe("attach_socials", () => {
  it("attaches when the token matches the candidate set", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      const { checkToken } = await checked(host, personId, [SAM]);

      await host.api.invoke("people.attach_socials", {
        personId,
        candidates: [SAM],
        checkToken,
        confirmedByUser: true,
      });

      const contacts = await host.db.contactChannel.findMany();
      expect(contacts).toHaveLength(1);
      expect(contacts[0]!.value).toBe("sam");
      // Written by an assistant, so it keeps its provenance and no verification.
      expect(contacts[0]!.source).toBe("ASSISTANT");
      expect(contacts[0]!.verifiedAt).toBeNull();
    } finally {
      await host.close();
    }
  });

  it("refuses a token issued for a different candidate set", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      const { checkToken } = await checked(host, personId, [SAM]);

      await expect(
        host.api.invoke("people.attach_socials", {
          personId,
          candidates: [OTHER],
          checkToken,
          confirmedByUser: true,
        }),
      ).rejects.toMatchObject({ code: "refused" });

      expect(await host.db.contactChannel.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("refuses a token issued for a different person", async () => {
    const host = await testHost();
    try {
      const sam = await seedPerson(host, "Sam Rivera");
      const other = await seedPerson(host, "Ada Vance");
      const { checkToken } = await checked(host, sam, [SAM]);

      await expect(
        host.api.invoke("people.attach_socials", {
          personId: other,
          candidates: [SAM],
          checkToken,
          confirmedByUser: true,
        }),
      ).rejects.toMatchObject({ code: "refused" });

      expect(await host.db.contactChannel.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("refuses a token over fifteen minutes old", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      const { checkToken } = await checked(host, personId, [SAM]);

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 16 * 60_000));

      await expect(
        host.api.invoke("people.attach_socials", {
          personId,
          candidates: [SAM],
          checkToken,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/expired/i);

      vi.useRealTimers();
      expect(await host.db.contactChannel.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("refuses a token that is not one of ours", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await checked(host, personId, [SAM]);

      await expect(
        host.api.invoke("people.attach_socials", {
          personId,
          candidates: [SAM],
          checkToken: "v1.1750000000.0000000000000000000000000000000",
          confirmedByUser: true,
        }),
      ).rejects.toMatchObject({ code: "refused" });
    } finally {
      await host.close();
    }
  });
});
