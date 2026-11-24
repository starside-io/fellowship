import { randomUUID } from "node:crypto";

import type { AuditEntry, ModuleEventName, Proposal, ProposalGroup } from "@fellowship/core";

import type { HostDb } from "../host-db.js";

/**
 * The three tables the host writes on the module's behalf, and the reads the
 * standalone UI needs over them. Nothing here is in the silo.
 */

export interface ProposalRow {
  id: string;
  tool: string;
  personId: string | null;
  payload: unknown;
  summary: string | null;
  group: ProposalGroup | null;
  state: "pending" | "confirmed" | "discarded";
  createdAt: string;
  decidedAt: string | null;
}

export interface AuditRow {
  id: number;
  tool: string;
  kind: string;
  personId: string | null;
  at: string;
  detail: unknown;
}

export interface EventRow {
  id: number;
  name: string;
  payload: unknown;
  at: string;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class HostStore {
  constructor(private readonly host: HostDb) {}

  /** A write an assistant wants, waiting for the user to confirm or discard. */
  propose(proposal: Proposal, at: Date = new Date()): { id: string } {
    const id = randomUUID();
    this.host.db
      .prepare(
        `INSERT INTO "proposal" ("id", "tool", "personId", "payload", "summary", "group", "state", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        proposal.tool,
        proposal.personId ?? null,
        JSON.stringify(proposal.payload ?? null),
        proposal.summary ?? null,
        proposal.group ? JSON.stringify(proposal.group) : null,
        at.toISOString(),
      );
    return { id };
  }

  getProposal(id: string): ProposalRow | null {
    const row = this.host.db
      .prepare(`SELECT * FROM "proposal" WHERE "id" = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toProposal(row) : null;
  }

  private toProposal(row: Record<string, unknown>): ProposalRow {
    return {
      id: String(row["id"]),
      tool: String(row["tool"]),
      personId: row["personId"] === null ? null : String(row["personId"]),
      payload: parseJson(row["payload"]),
      summary: row["summary"] === null ? null : String(row["summary"]),
      group: (row["group"] ?? null) === null ? null : (parseJson(row["group"]) as ProposalGroup | null),
      state: String(row["state"]) as ProposalRow["state"],
      createdAt: String(row["createdAt"]),
      decidedAt: row["decidedAt"] === null ? null : String(row["decidedAt"]),
    };
  }

  listProposals(state: ProposalRow["state"] | "all" = "pending"): ProposalRow[] {
    const rows =
      state === "all"
        ? (this.host.db
            .prepare(`SELECT * FROM "proposal" ORDER BY "createdAt" DESC, rowid DESC`)
            .all() as Record<string, unknown>[])
        : (this.host.db
            .prepare(
              `SELECT * FROM "proposal" WHERE "state" = ? ORDER BY "createdAt" DESC, rowid DESC`,
            )
            .all(state) as Record<string, unknown>[]);

    return rows.map((row) => this.toProposal(row));
  }

  decideProposal(
    id: string,
    state: "confirmed" | "discarded",
    at: Date = new Date(),
  ): boolean {
    const result = this.host.db
      .prepare(
        `UPDATE "proposal" SET "state" = ?, "decidedAt" = ? WHERE "id" = ? AND "state" = 'pending'`,
      )
      .run(state, at.toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** Append only. Never updated, never deleted by the app. */
  logAudit(entry: AuditEntry): void {
    this.host.db
      .prepare(
        `INSERT INTO "audit" ("tool", "kind", "personId", "at", "detail") VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tool,
        entry.kind,
        entry.personId ?? null,
        entry.at.toISOString(),
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      );
  }

  listAudit(limit = 100): AuditRow[] {
    const rows = this.host.db
      .prepare(`SELECT * FROM "audit" ORDER BY "id" DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row["id"]),
      tool: String(row["tool"]),
      kind: String(row["kind"]),
      personId: row["personId"] === null ? null : String(row["personId"]),
      at: String(row["at"]),
      detail: parseJson(row["detail"]),
    }));
  }

  recordEvent(
    name: ModuleEventName,
    payload: Record<string, unknown>,
    at: Date = new Date(),
  ): void {
    this.host.db
      .prepare(`INSERT INTO "event" ("name", "payload", "at") VALUES (?, ?, ?)`)
      .run(name, JSON.stringify(payload), at.toISOString());
  }

  listEvents(limit = 100): EventRow[] {
    const rows = this.host.db
      .prepare(`SELECT * FROM "event" ORDER BY "id" DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row["id"]),
      name: String(row["name"]),
      payload: parseJson(row["payload"]) as Record<string, unknown>,
      at: String(row["at"]),
    }));
  }

  readSetting(key: string): unknown {
    const row = this.host.db
      .prepare(`SELECT "value" FROM "setting" WHERE "key" = ?`)
      .get(key) as Record<string, unknown> | undefined;
    return row ? parseJson(row["value"]) : undefined;
  }

  writeSetting(key: string, value: unknown, at: Date = new Date()): void {
    this.host.db
      .prepare(
        `INSERT INTO "setting" ("key", "value", "updatedAt") VALUES (?, ?, ?)
         ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"`,
      )
      .run(key, JSON.stringify(value ?? null), at.toISOString());
  }

  readCursor(connector: string): string | null {
    const row = this.host.db
      .prepare(`SELECT "value" FROM "cursor" WHERE "connector" = ?`)
      .get(connector) as Record<string, unknown> | undefined;
    const value = row?.["value"];
    return value === undefined || value === null ? null : String(value);
  }

  writeCursor(connector: string, value: string | null, at: Date = new Date()): void {
    this.host.db
      .prepare(
        `INSERT INTO "cursor" ("connector", "value", "updatedAt") VALUES (?, ?, ?)
         ON CONFLICT ("connector") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"`,
      )
      .run(connector, value, at.toISOString());
  }
}
