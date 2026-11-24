import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ENUM_COLUMNS } from "../../src/schemas/enums.js";
import { enumCheckConstraints } from "../../src/storage/enum-checks.js";
import { throwawaySilo } from "./throwaway.js";

let silo: ReturnType<typeof throwawaySilo>;

beforeAll(() => {
  silo = throwawaySilo();
});

afterAll(() => {
  silo.db.close();
});

function tableSql(name: string): string {
  const row = silo.db
    .prepare(`SELECT "sql" FROM sqlite_master WHERE "type" = 'table' AND "name" = ?`)
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? "";
}

function insertPerson(id: string): void {
  silo.db
    .prepare(
      `INSERT INTO "Person" ("id", "displayName", "avatarColor", "commStyle", "updatedAt")
       VALUES (?, ?, '#888888', '[]', '2026-01-01 00:00:00')`,
    )
    .run(id, `Person ${id}`);
}

describe("the migrated schema", () => {
  it("creates every table the silo owns", () => {
    const names = (
      silo.db
        .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    for (const table of [
      "Person",
      "PersonAvatar",
      "ContactChannel",
      "Tag",
      "Circle",
      "FieldDefinition",
      "CustomValue",
      "Favour",
      "Event",
      "EventParticipant",
      "Note",
      "Link",
      "LinkStat",
      "Conversation",
      "ConversationParticipant",
      "Message",
      "PersonProfile",
      "person_fts",
      "note_fts",
      "message_fts",
    ]) {
      expect(names, table).toContain(table);
    }
  });

  it("keeps the avatar bytes out of Person", () => {
    expect(tableSql("Person")).not.toContain("avatarImage");
    expect(tableSql("PersonAvatar")).toContain('"image" BLOB NOT NULL');
  });

  it("drops AppSetting, which belongs behind the settings port", () => {
    expect(tableSql("AppSetting")).toBe("");
  });
});

describe("enum CHECK constraints", () => {
  it("carries one per enum column, with the values zod allows", () => {
    for (const constraint of enumCheckConstraints()) {
      expect(tableSql(constraint.table), constraint.name).toContain(constraint.name);
      expect(tableSql(constraint.table), constraint.name).toContain(constraint.sql);
    }
  });

  it("refuses a value outside the zod enum", () => {
    insertPerson("p-enum");
    expect(() =>
      silo.db
        .prepare(
          `INSERT INTO "ContactChannel" ("id", "personId", "kind", "value", "source")
           VALUES ('c-bad', 'p-enum', 'CARRIER_PIGEON', 'x', 'MANUAL')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("accepts every value the zod enum allows", () => {
    insertPerson("p-ok");
    for (const value of ENUM_COLUMNS.find((entry) => entry.table === "ContactChannel" && entry.column === "kind")!
      .values) {
      silo.db
        .prepare(
          `INSERT INTO "ContactChannel" ("id", "personId", "kind", "value", "source")
           VALUES (?, 'p-ok', ?, 'x', 'MANUAL')`,
        )
        .run(`c-${value}`, value);
    }
    const count = silo.db
      .prepare(`SELECT COUNT(*) AS n FROM "ContactChannel" WHERE "personId" = 'p-ok'`)
      .get() as { n: number };
    expect(Number(count.n)).toBe(4);
  });

  it("lets a nullable enum column stay null", () => {
    insertPerson("p-null");
    silo.db
      .prepare(
        `INSERT INTO "ContactChannel" ("id", "personId", "kind", "value", "source", "confidence")
         VALUES ('c-null', 'p-null', 'EMAIL', 'x', 'MANUAL', NULL)`,
      )
      .run();
    const row = silo.db
      .prepare(`SELECT "confidence" FROM "ContactChannel" WHERE "id" = 'c-null'`)
      .get() as { confidence: string | null };
    expect(row.confidence).toBeNull();
  });
});

describe("foreign keys", () => {
  it("cascades a person delete into the rows that hang off them", () => {
    insertPerson("p-cascade");
    silo.db
      .prepare(
        `INSERT INTO "PersonAvatar" ("personId", "image", "mime", "source", "fetchedAt")
         VALUES ('p-cascade', X'00', 'image/png', 'MANUAL', '2026-01-01 00:00:00')`,
      )
      .run();
    silo.db.prepare(`DELETE FROM "Person" WHERE "id" = 'p-cascade'`).run();

    const left = silo.db
      .prepare(`SELECT COUNT(*) AS n FROM "PersonAvatar" WHERE "personId" = 'p-cascade'`)
      .get() as { n: number };
    expect(Number(left.n)).toBe(0);
  });

  it("refuses a row that points at a person who does not exist", () => {
    expect(() =>
      silo.db
        .prepare(
          `INSERT INTO "Favour" ("id", "personId", "direction", "description", "createdAt", "updatedAt")
           VALUES ('f-orphan', 'nobody', 'I_OWE_THEM', 'x', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("FTS5", () => {
  it("indexes a person through its trigger, diacritics folded", () => {
    silo.db
      .prepare(
        `INSERT INTO "Person" ("id", "displayName", "firstName", "avatarColor", "commStyle", "updatedAt")
         VALUES ('p-fts', 'Hélène Dupré', 'Hélène', '#888888', '[]', '2026-01-01 00:00:00')`,
      )
      .run();

    const hits = silo.db
      .prepare(`SELECT "rowid" FROM "person_fts" WHERE "person_fts" MATCH 'Helene'`)
      .all();
    expect(hits.length).toBe(1);
  });

  it("drops a person back out of the index when they are deleted", () => {
    insertPerson("p-gone");
    silo.db
      .prepare(`UPDATE "Person" SET "displayName" = 'Zelophehad' WHERE "id" = 'p-gone'`)
      .run();
    expect(
      silo.db.prepare(`SELECT "rowid" FROM "person_fts" WHERE "person_fts" MATCH 'Zelophehad'`).all()
        .length,
    ).toBe(1);

    silo.db.prepare(`DELETE FROM "Person" WHERE "id" = 'p-gone'`).run();
    expect(
      silo.db.prepare(`SELECT "rowid" FROM "person_fts" WHERE "person_fts" MATCH 'Zelophehad'`).all()
        .length,
    ).toBe(0);
  });

  it("indexes message bodies", () => {
    silo.db
      .prepare(
        `INSERT INTO "Conversation" ("id", "source", "importedAt", "messageCount")
         VALUES ('conv-1', 'WHATSAPP', '2026-01-01 00:00:00', 1)`,
      )
      .run();
    silo.db
      .prepare(
        `INSERT INTO "Message" ("id", "conversationId", "senderName", "sentAt", "body")
         VALUES ('m-1', 'conv-1', 'Someone', '2026-01-01 00:00:00', 'the ramen place on Tuesday')`,
      )
      .run();

    const hits = silo.db
      .prepare(`SELECT "rowid" FROM "message_fts" WHERE "message_fts" MATCH 'ramen'`)
      .all();
    expect(hits.length).toBe(1);
  });
});
