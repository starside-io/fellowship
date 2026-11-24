import { ENUM_COLUMNS, enumCheckSql } from "../schemas/enums.js";

/**
 * Prisma cannot model a CHECK constraint, so the enum guards are added to the
 * migration SQL after Prisma writes it. The values come from the zod enums, so
 * the database and the validation layer cannot disagree: the test in
 * tests/storage/enum-checks.test.ts re-derives these from the same source and
 * compares them against what the migrations actually built.
 */

export interface EnumCheckConstraint {
  table: string;
  column: string;
  name: string;
  sql: string;
}

export function enumCheckConstraints(): EnumCheckConstraint[] {
  return ENUM_COLUMNS.map((entry) => ({
    table: entry.table,
    column: entry.column,
    name: `${entry.table}_${entry.column}_check`,
    sql: enumCheckSql(entry),
  }));
}

/** The line as it appears inside a CREATE TABLE statement. */
export function constraintLine(constraint: EnumCheckConstraint): string {
  return `    CONSTRAINT "${constraint.name}" CHECK (${constraint.sql})`;
}

/**
 * Add every enum CHECK to the CREATE TABLE statements of a migration script.
 * A table the script does not create is skipped, so this is safe to run over a
 * later migration that only touches one table.
 */
export function injectEnumChecks(sql: string): string {
  let out = sql;
  for (const constraint of enumCheckConstraints()) {
    const line = constraintLine(constraint);
    if (out.includes(`"${constraint.name}"`)) continue;

    const opening = `CREATE TABLE "${constraint.table}" (`;
    const start = out.indexOf(opening);
    if (start === -1) continue;

    const end = out.indexOf("\n);", start);
    if (end === -1) continue;

    out = `${out.slice(0, end)},\n${line}${out.slice(end)}`;
  }
  return out;
}
