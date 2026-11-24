import { enumCheckConstraints } from "./enum-checks.js";
import { resolveDbPath } from "./paths.js";
import { openSilo } from "./client.js";
import { readPragma } from "./pragmas.js";

export interface SiloReport {
  path: string;
  foreignKeys: unknown;
  journalMode: unknown;
  synchronous: unknown;
  busyTimeout: unknown;
  tables: string[];
  missingEnumChecks: string[];
}

/**
 * Open the silo, read the pragmas back, and list what is in it. The boot check
 * refuses a file where foreign_keys reads 0, so reaching the end of this means
 * the file is usable.
 */
export async function checkSilo(path: string = resolveDbPath()): Promise<SiloReport> {
  const db = await openSilo({ path });
  try {
    const rows = await db.$queryRawUnsafe<Array<{ name: string; sql: string | null }>>(
      `SELECT "name", "sql" FROM sqlite_master WHERE "type" IN ('table', 'view') ORDER BY "name"`,
    );
    const definitions = new Map(rows.map((row) => [row.name, row.sql ?? ""]));

    const missingEnumChecks = enumCheckConstraints()
      .filter((constraint) => !(definitions.get(constraint.table) ?? "").includes(constraint.name))
      .map((constraint) => constraint.name);

    return {
      path,
      foreignKeys: await readPragma(db, "foreign_keys"),
      journalMode: await readPragma(db, "journal_mode"),
      synchronous: await readPragma(db, "synchronous"),
      busyTimeout: await readPragma(db, "busy_timeout"),
      tables: [...definitions.keys()].filter((name) => !name.startsWith("sqlite_")),
      missingEnumChecks,
    };
  } finally {
    await db.$disconnect();
  }
}
