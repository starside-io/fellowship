import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { seedPerson, seedSelf, testHost, SAMPLE_IMAGE_BYTES } from "./harness.js";

/**
 * Gates: silo isolation, no avatar bytes in a response, pragmas, and the
 * single writer.
 *
 * The module reaches nothing by itself. Its one outbound fetch and its one
 * disk read are the host's, through ports, which is what makes the install
 * time permission summary read honestly.
 */

const realFetch = globalThis.fetch;
let fetches: string[];

beforeEach(() => {
  fetches = [];
  globalThis.fetch = (async (input: unknown) => {
    fetches.push(String(input));
    throw new Error("A tool reached the network.");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("the module by itself", () => {
  it("reaches no network, whatever it is asked to do", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Sam Rivera");

      await host.api.invoke("people.search", { query: "Sam" });
      await host.api.invoke("people.get", { personId });
      await host.api.invoke("people.self", {});
      await host.api.invoke("people.activity", {});
      await host.api.invoke("people.timeline", { personId });
      await host.api.invoke("people.insights", { personId });
      await host.api.invoke("people.chat_insights", { personId });
      await host.api.invoke("people.graph", {});
      await host.api.invoke("people.social_platforms", {});
      await host.api.invoke("people.fields", {});
      await host.api.invoke("people.read_messages", { personId });
      await host.api.invoke("people.export", {});
      await host.api.invoke("people.set_link", {
        aPersonId: selfId,
        bPersonId: personId,
        tie: "FRIEND",
      });

      // Even the one tool whose whole job is an image goes through the port.
      await host.api.invoke("people.set_picture", {
        personId,
        url: "https://example.test/picture.png",
        confirmedByUser: true,
      });

      expect(fetches).toEqual([]);
      expect(host.mediaCalls).toEqual(["https://example.test/picture.png"]);
    } finally {
      await host.close();
    }
  });

  it("audits every call, refusals included", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      host.audit.length = 0;

      await host.api.invoke("people.get", { personId });
      await host.api.invoke("people.read_messages", { personId });
      await host.api
        .invoke("people.write_sketch", { personId, summary: "x", sources: ["y"] })
        .catch(() => undefined);

      const names = host.audit.map((entry) => entry.tool);
      expect(names).toContain("people.get");
      expect(names).toContain("people.read_messages");
      expect(names).toContain("people.write_sketch");

      const refused = host.audit.find((entry) => entry.tool === "people.write_sketch");
      expect(refused?.detail).toMatchObject({ refused: "invalid_input" });

      // read_messages carries the count, which is the part worth reading back.
      const read = host.audit.filter((entry) => entry.tool === "people.read_messages");
      expect(read.some((entry) => typeof entry.detail?.["returned"] === "number")).toBe(true);
    } finally {
      await host.close();
    }
  });
});

describe("avatar bytes", () => {
  it("are in no tool response, not even the one that stores them", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      const stored = await host.api.invoke("people.set_picture", {
        personId,
        url: "https://example.test/picture.png",
        confirmedByUser: true,
      });
      const person = await host.api.invoke("people.get", { personId });
      const graph = await host.api.invoke("people.graph", {});
      const search = await host.api.invoke("people.search", { query: "Sam" });

      // The bytes are in the table.
      const row = await host.db.personAvatar.findUniqueOrThrow({ where: { personId } });
      expect(row.image).toEqual(SAMPLE_IMAGE_BYTES);

      // And in none of the payloads, in any encoding.
      const base64 = Buffer.from(SAMPLE_IMAGE_BYTES).toString("base64");
      for (const payload of [stored, person, graph, search]) {
        const printed = JSON.stringify(payload);
        expect(printed).not.toContain(base64);
        expect(printed).not.toContain("\"image\"");
      }

      // The metadata is there, so a caller can still say what it did.
      expect(stored).toMatchObject({
        picture: { mime: "image/png", bytes: SAMPLE_IMAGE_BYTES.byteLength },
      });
    } finally {
      await host.close();
    }
  });

  it("travels only in the snapshot, which is the user's own backup", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await host.api.invoke("people.set_picture", {
        personId,
        url: "https://example.test/picture.png",
        confirmedByUser: true,
      });

      const snapshot = (await host.api.invoke("people.export", {})) as {
        people: Array<{ avatarImage: string | null }>;
      };
      expect(snapshot.people[0]!.avatarImage).toBe(
        Buffer.from(SAMPLE_IMAGE_BYTES).toString("base64"),
      );
    } finally {
      await host.close();
    }
  });
});

describe("the silo it was handed", () => {
  it("has its pragmas asserted before a tool runs", async () => {
    const host = await testHost();
    try {
      const rows = await host.db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        "PRAGMA foreign_keys",
      );
      expect(Number(Object.values(rows[0]!)[0])).toBe(1);

      const journal = await host.db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        "PRAGMA journal_mode",
      );
      expect(String(Object.values(journal[0]!)[0]).toLowerCase()).toBe("wal");
    } finally {
      await host.close();
    }
  });

  it("serializes two concurrent writes rather than throwing SQLITE_BUSY", async () => {
    const host = await testHost();
    try {
      const selfId = await seedSelf(host);
      const personId = await seedPerson(host, "Sam Rivera");

      const writes = await Promise.all([
        host.api.invoke("people.log_interaction", {
          title: "Dinner",
          type: "MEAL",
          occurredAt: "2026-06-01T12:00:00.000Z",
          participants: [{ personId: selfId }, { personId }],
        }),
        host.api.invoke("people.log_interaction", {
          title: "Climbing",
          type: "HANGOUT",
          occurredAt: "2026-06-02T12:00:00.000Z",
          participants: [{ personId: selfId }, { personId }],
        }),
        host.api.invoke("people.set_favour", {
          personId,
          direction: "THEY_OWE_ME",
          description: "a coffee",
        }),
        host.api.invoke("people.add_note", {
          personId,
          body: { type: "doc", content: [] },
        }),
      ]);

      expect(writes).toHaveLength(4);
      expect(await host.db.event.count()).toBe(2);
      expect(await host.db.favour.count()).toBe(1);
      expect(await host.db.note.count()).toBe(1);
    } finally {
      await host.close();
    }
  });
});

describe("a host with nothing optional wired", () => {
  it("resolves a ref as unavailable rather than failing", async () => {
    const host = await testHost();
    try {
      const resolution = await host.ports.refs.resolve("module://memory/note/1");
      expect(resolution.status).toBe("unavailable");
    } finally {
      await host.close();
    }
  });

  it("never calls the model from any tool in this milestone", async () => {
    const host = await testHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await host.api.invoke("people.insights", { personId });
      await host.api.invoke("people.chat_insights", { personId });
      expect(host.completions).toBe(0);
    } finally {
      await host.close();
    }
  });
});
