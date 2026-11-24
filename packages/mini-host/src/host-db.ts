import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { storage } from "@fellowship/core";

/**
 * host.db: the second file.
 *
 * The review queue, the audit log, the settings values, the event feed and the
 * connector cursors are the host's, not the module's. They live beside the
 * silo rather than inside it, so a module uninstall or a silo export never
 * entangles them. One file per owner.
 *
 * Plain node:sqlite rather than Prisma. Five tables, no relations worth
 * modelling, and a second generated client to keep in step would cost more
 * than it buys.
 */

export const HOST_DB_FILE_NAME = "host.db";

/** Bumped when the statements below stop describing the file. */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "proposal" (
  "id"         TEXT PRIMARY KEY,
  "tool"       TEXT NOT NULL,
  "personId"   TEXT,
  "payload"    TEXT NOT NULL,
  "summary"    TEXT,
  "group"      TEXT,
  "state"      TEXT NOT NULL DEFAULT 'pending'
               CHECK ("state" IN ('pending', 'confirmed', 'discarded')),
  "createdAt"  TEXT NOT NULL,
  "decidedAt"  TEXT
);
CREATE INDEX IF NOT EXISTS "proposal_state_idx" ON "proposal" ("state", "createdAt");

CREATE TABLE IF NOT EXISTS "audit" (
  "id"       INTEGER PRIMARY KEY AUTOINCREMENT,
  "tool"     TEXT NOT NULL,
  "kind"     TEXT NOT NULL,
  "personId" TEXT,
  "at"       TEXT NOT NULL,
  "detail"   TEXT
);
CREATE INDEX IF NOT EXISTS "audit_at_idx" ON "audit" ("at");

CREATE TABLE IF NOT EXISTS "setting" (
  "key"       TEXT PRIMARY KEY,
  "value"     TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "event" (
  "id"      INTEGER PRIMARY KEY AUTOINCREMENT,
  "name"    TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "at"      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "event_at_idx" ON "event" ("at");

CREATE TABLE IF NOT EXISTS "cursor" (
  "connector" TEXT PRIMARY KEY,
  "value"     TEXT,
  "updatedAt" TEXT NOT NULL
);
`;

/** The env var that overrides where host.db lives. */
export const HOST_DB_PATH_ENV = "FELLOWSHIP_HOST_DB_PATH";

/**
 * Beside the silo by default, so the two files move together, and separately
 * overridable because a test wants a throwaway pair.
 */
export function resolveHostDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOST_DB_PATH_ENV]?.trim();
  if (override) return override;
  return join(dirname(storage.resolveDbPath(env)), HOST_DB_FILE_NAME);
}

export interface HostDb {
  readonly path: string;
  readonly db: DatabaseSync;
  close(): void;
}

/** Opens host.db, with the same pragmas the silo gets, and asserts them. */
export function openHostDb(path: string = resolveHostDbPath()): HostDb {
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
  if (Number(Object.values(foreignKeys)[0]) !== 1) {
    db.close();
    throw new Error(
      "PRAGMA foreign_keys reads 0 on host.db. Refusing to start: the same rule as the silo.",
    );
  }

  db.exec(SCHEMA);
  upgrade(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  return {
    path,
    db,
    close: () => db.close(),
  };
}

/**
 * Brings a file written by an older host up to the statements above. CREATE
 * TABLE IF NOT EXISTS leaves an existing table alone, so a column added since
 * is added here. Each step only adds: nothing a step does loses a row.
 */
function upgrade(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info("proposal")`).all() as Array<{ name: string }>;
  // Version 2: proposals drafted together share a group.
  if (!columns.some((column) => column.name === "group")) {
    db.exec(`ALTER TABLE "proposal" ADD COLUMN "group" TEXT`);
  }
}

/** A consistent copy of a live file, which `cp` of a WAL database is not. */
export function backupHostDb(host: HostDb, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  host.db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
}
