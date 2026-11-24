import { describe, expect, it } from "vitest";

import { seedPerson, seedSelf, testHost } from "./harness.js";

/**
 * A name resolves to one person or to a question. It never resolves to a guess.
 *
 * This is the gate in front of every write that was asked for by name: two
 * people called Sam means the caller has to ask which one, and the tool has to
 * hand over enough to ask with.
 */

type Resolved = {
  status: "unique" | "ambiguous" | "none";
  match: { id: string; displayName: string } | null;
  candidates: Array<{ id: string; displayName: string; detail: string }>;
  hint: string;
};

describe("people.resolve_person", () => {
  it("resolves a name only one person answers to", async () => {
    const host = await testHost();
    try {
      await seedSelf(host);
      const samId = await seedPerson(host, "Sam Rivera");
      await seedPerson(host, "Alex Okonkwo");

      const result = (await host.api.invoke("people.resolve_person", {
        name: "Sam Rivera",
      })) as Resolved;

      expect(result.status).toBe("unique");
      expect(result.match?.id).toBe(samId);
      expect(result.candidates).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  it("refuses to choose between two people of the same name", async () => {
    const host = await testHost();
    try {
      await seedSelf(host);
      const first = await seedPerson(host, "Sam Rivera");
      const second = await seedPerson(host, "Sam Rivera");

      await host.api.invoke("people.update", {
        personId: first,
        patch: { location: "Geneva", howWeMet: "climbing" },
      });
      await host.api.invoke("people.update", {
        personId: second,
        patch: { location: "Lisbon", howWeMet: "work" },
      });

      const result = (await host.api.invoke("people.resolve_person", {
        name: "Sam Rivera",
      })) as Resolved;

      expect(result.status).toBe("ambiguous");
      expect(result.match).toBeNull();
      expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual(
        [first, second].sort(),
      );
      // Enough to ask the owner a question they can answer.
      expect(result.candidates.map((candidate) => candidate.detail)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Geneva"),
          expect.stringContaining("Lisbon"),
        ]),
      );
      expect(result.hint).toMatch(/ask the owner/i);
    } finally {
      await host.close();
    }
  });

  it("prefers the exact name over the ones that merely look like it", async () => {
    const host = await testHost();
    try {
      await seedSelf(host);
      const exact = await seedPerson(host, "Sam Rivera");
      await seedPerson(host, "Samantha Riveras");

      const result = (await host.api.invoke("people.resolve_person", {
        name: "sam rivera",
      })) as Resolved;

      expect(result.status).toBe("unique");
      expect(result.match?.id).toBe(exact);
    } finally {
      await host.close();
    }
  });

  it("finds an accented name from the way it is typed, and a part of one", async () => {
    const host = await testHost();
    try {
      await seedSelf(host);
      const id = await seedPerson(host, "Hélène Dupré");

      const typed = (await host.api.invoke("people.resolve_person", {
        name: "helene dupre",
      })) as Resolved;
      expect(typed.match?.id).toBe(id);

      const partial = (await host.api.invoke("people.resolve_person", {
        name: "Dupr",
      })) as Resolved;
      expect(partial.candidates.map((candidate) => candidate.id)).toContain(id);
    } finally {
      await host.close();
    }
  });

  it("says nobody rather than offering the nearest person", async () => {
    const host = await testHost();
    try {
      await seedSelf(host);
      await seedPerson(host, "Sam Rivera");

      const result = (await host.api.invoke("people.resolve_person", {
        name: "Gandalf",
      })) as Resolved;

      expect(result.status).toBe("none");
      expect(result.match).toBeNull();
      expect(result.candidates).toHaveLength(0);
      expect(result.hint).toMatch(/people\.create/);
    } finally {
      await host.close();
    }
  });

  it("writes nothing", async () => {
    const host = await testHost();
    try {
      await seedSelf(host);
      await seedPerson(host, "Sam Rivera");
      await host.api.invoke("people.resolve_person", { name: "Sam" });

      const line = host.audit.at(-1);
      expect(line?.tool).toBe("people.resolve_person");
      expect(line?.kind).toBe("read");
    } finally {
      await host.close();
    }
  });
});

describe("people.set_contacts", () => {
  it("stores the canonical value and the URL derived from it", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      const result = (await host.api.invoke("people.set_contacts", {
        personId,
        contacts: [
          { kind: "EMAIL", value: " Sam@Example.COM " },
          { kind: "PHONE", value: "+41 79 123 45 67" },
          { kind: "SOCIAL", platform: "instagram", value: "@Sam.Rivera" },
        ],
      })) as { contacts: Array<{ kind: string; value: string; url: string | null }> };

      const byKind = new Map(result.contacts.map((row) => [row.kind, row]));
      expect(byKind.get("EMAIL")).toMatchObject({
        value: "Sam@example.com",
        url: "mailto:Sam@example.com",
      });
      expect(byKind.get("PHONE")).toMatchObject({
        value: "+41791234567",
        url: "tel:+41791234567",
      });
      expect(byKind.get("SOCIAL")).toMatchObject({
        value: "sam.rivera",
        url: "https://instagram.com/sam.rivera",
      });
    } finally {
      await host.close();
    }
  });

  it("refuses a value that is not an address on its kind", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      await expect(
        host.api.invoke("people.set_contacts", {
          personId,
          contacts: [{ kind: "EMAIL", value: "sam@@example.com" }],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      await expect(
        host.api.invoke("people.set_contacts", {
          personId,
          contacts: [
            { kind: "SOCIAL", platform: "instagram", value: "https://instagram.com/p/Cxyz1234/" },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(await host.db.contactChannel.count({ where: { personId } })).toBe(0);
    } finally {
      await host.close();
    }
  });
});
