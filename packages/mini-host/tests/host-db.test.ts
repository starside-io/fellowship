import { mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupHostDb, openHostDb } from "../src/host-db.js";
import { HostStore } from "../src/ports/host-store.js";

/** host.db: the second file, and the three things the host keeps in it. */

function throwaway() {
  const dir = mkdtempSync(join(tmpdir(), "fellowship-hostdb-"));
  const host = openHostDb(join(dir, "host.db"));
  return { host, store: new HostStore(host), dir };
}

describe("host.db", () => {
  it("adds the group column to a file an older host wrote, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "fellowship-hostdb-"));
    const path = join(dir, "host.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE "proposal" (
      "id" TEXT PRIMARY KEY, "tool" TEXT NOT NULL, "personId" TEXT, "payload" TEXT NOT NULL,
      "summary" TEXT, "state" TEXT NOT NULL DEFAULT 'pending', "createdAt" TEXT NOT NULL, "decidedAt" TEXT
    )`);
    old.exec(`INSERT INTO "proposal" ("id", "tool", "payload", "createdAt")
      VALUES ('kept', 'people.update', '{}', '2026-01-01T00:00:00.000Z')`);
    old.exec("PRAGMA user_version = 1");
    old.close();

    const host = openHostDb(path);
    try {
      const store = new HostStore(host);
      expect(store.getProposal("kept")?.group).toBeNull();

      const group = { id: "g1", title: "Chat recap", detail: "Sam 10 → 14", meta: { job: "recap" } };
      const { id } = store.propose({ tool: "people.add_note", payload: {}, group });
      expect(store.getProposal(id)?.group).toEqual(group);

      const version = host.db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
      expect(Number(Object.values(version)[0])).toBe(2);
    } finally {
      host.close();
    }
  });

  it("creates its tables and asserts the same pragmas as the silo", () => {
    const { host } = throwaway();
    try {
      const names = (
        host.db
          .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name);

      for (const table of ["proposal", "audit", "setting", "event", "cursor"]) {
        expect(names).toContain(table);
      }

      const journal = host.db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
      expect(String(Object.values(journal)[0]).toLowerCase()).toBe("wal");

      const keys = host.db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
      expect(Number(Object.values(keys)[0])).toBe(1);
    } finally {
      host.close();
    }
  });

  it("holds nothing from the silo", () => {
    const { host } = throwaway();
    try {
      const names = (
        host.db
          .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name);

      // One file per owner: no people tables in here, ever.
      for (const table of ["Person", "Message", "Event", "PersonAvatar"]) {
        expect(names).not.toContain(table);
      }
    } finally {
      host.close();
    }
  });

  it("round trips a proposal, and decides it once", () => {
    const { host, store } = throwaway();
    try {
      const { id } = store.propose({
        tool: "people.write_sketch",
        personId: "11111111-1111-4111-8111-111111111111",
        payload: { summary: "Replies at night." },
        summary: "A sketch for Sam",
      });

      const pending = store.listProposals("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.tool).toBe("people.write_sketch");
      expect(pending[0]!.payload).toEqual({ summary: "Replies at night." });

      expect(store.decideProposal(id, "confirmed")).toBe(true);
      // A decided proposal is not decided twice.
      expect(store.decideProposal(id, "discarded")).toBe(false);
      expect(store.listProposals("pending")).toHaveLength(0);
      expect(store.listProposals("confirmed")).toHaveLength(1);
    } finally {
      host.close();
    }
  });

  it("appends to the audit log and never rewrites it", () => {
    const { host, store } = throwaway();
    try {
      store.logAudit({
        tool: "people.read_messages",
        kind: "read",
        personId: "11111111-1111-4111-8111-111111111111",
        at: new Date("2026-07-31T12:00:00.000Z"),
        detail: { returned: 12, total: 400 },
      });
      store.logAudit({
        tool: "people.get",
        kind: "read",
        at: new Date("2026-07-31T12:00:01.000Z"),
      });

      const entries = store.listAudit();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.tool).toBe("people.get");
      expect(entries[1]!.detail).toEqual({ returned: 12, total: 400 });
    } finally {
      host.close();
    }
  });

  it("keeps settings, events and connector cursors", () => {
    const { host, store } = throwaway();
    try {
      store.writeSetting("module.config", { halfLifeDays: 90 });
      expect(store.readSetting("module.config")).toEqual({ halfLifeDays: 90 });
      store.writeSetting("module.config", { halfLifeDays: 365 });
      expect(store.readSetting("module.config")).toEqual({ halfLifeDays: 365 });
      expect(store.readSetting("nothing.here")).toBeUndefined();

      store.recordEvent("people.person.created", { personId: "x" });
      expect(store.listEvents()[0]).toMatchObject({
        name: "people.person.created",
        payload: { personId: "x" },
      });

      expect(store.readCursor("chat-export")).toBeNull();
      store.writeCursor("chat-export", "2026-07-31T12:00:00.000Z");
      expect(store.readCursor("chat-export")).toBe("2026-07-31T12:00:00.000Z");
    } finally {
      host.close();
    }
  });

  it("backs itself up with VACUUM INTO rather than a file copy", () => {
    const { host, store, dir } = throwaway();
    try {
      store.writeSetting("module.config", { messageChunk: 500 });
      const copy = join(dir, "backup", "host.db");
      backupHostDb(host, copy);

      // A real file, and a readable one.
      expect(readFileSync(copy).byteLength).toBeGreaterThan(0);
      const reopened = openHostDb(copy);
      try {
        expect(new HostStore(reopened).readSetting("module.config")).toEqual({
          messageChunk: 500,
        });
      } finally {
        reopened.close();
      }
    } finally {
      host.close();
    }
  });
});
