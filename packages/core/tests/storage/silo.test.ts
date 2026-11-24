import { describe, expect, it } from "vitest";

import { checkSilo } from "../../src/storage/check.js";
import { openSilo } from "../../src/storage/client.js";
import { PragmaError, readPragma } from "../../src/storage/pragmas.js";
import { throwawaySilo } from "./throwaway.js";

/** A silo built by the migrations, then closed so Prisma can open it alone. */
function freshPath(): string {
  const silo = throwawaySilo();
  silo.db.close();
  return silo.path;
}

describe("openSilo", () => {
  it("sets the pragmas the spec lists and reads foreign_keys back as 1", async () => {
    const db = await openSilo({ path: freshPath() });
    try {
      expect(Number(await readPragma(db, "foreign_keys"))).toBe(1);
      expect(String(await readPragma(db, "journal_mode")).toLowerCase()).toBe("wal");
      expect(Number(await readPragma(db, "synchronous"))).toBe(1);
      expect(Number(await readPragma(db, "busy_timeout"))).toBe(5000);
    } finally {
      await db.$disconnect();
    }
  });

  it("enforces the cascade through Prisma, not just through raw SQL", async () => {
    const db = await openSilo({ path: freshPath() });
    try {
      await db.person.create({
        data: { id: "p-1", displayName: "Someone", avatarColor: "#888888", commStyle: [] },
      });
      await db.favour.create({
        data: { personId: "p-1", direction: "I_OWE_THEM", description: "a coffee" },
      });
      await db.person.delete({ where: { id: "p-1" } });
      expect(await db.favour.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });

  it("refuses an enum value the zod schema does not allow", async () => {
    const db = await openSilo({ path: freshPath() });
    try {
      await db.person.create({
        data: { id: "p-2", displayName: "Someone", avatarColor: "#888888", commStyle: [] },
      });
      await expect(
        db.favour.create({
          data: { personId: "p-2", direction: "MAYBE_SOMEDAY", description: "x" },
        }),
      ).rejects.toThrow(/CHECK constraint failed/);
    } finally {
      await db.$disconnect();
    }
  });

  it("refuses to hand over a client when foreign keys cannot be turned on", async () => {
    const path = freshPath();
    const db = await openSilo({ path });
    await db.$disconnect();

    // A stand-in for a connection that silently ignores the pragma.
    const deaf = {
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async <T>() => [{ foreign_keys: 0n }] as unknown as T,
    };
    const { applyPragmas } = await import("../../src/storage/pragmas.js");
    await expect(applyPragmas(deaf)).rejects.toBeInstanceOf(PragmaError);
  });
});

describe("checkSilo", () => {
  it("reports the pragmas, the tables and no missing enum checks", async () => {
    const report = await checkSilo(freshPath());
    expect(Number(report.foreignKeys)).toBe(1);
    expect(String(report.journalMode).toLowerCase()).toBe("wal");
    expect(report.missingEnumChecks).toEqual([]);
    expect(report.tables).toContain("Person");
    expect(report.tables).toContain("person_fts");
  });
});
