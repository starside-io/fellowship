import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { domain, storage } from "@fellowship/core";
import type { Silo } from "@fellowship/core";

/**
 * The round trip, as a command rather than as a shell history.
 *
 * Import a snapshot into a throwaway silo, export it back out, and compare the
 * two files row by row. This is how an akai-ito export is checked before it
 * goes anywhere near the live file, and how it stays checked afterwards: the
 * rule is that a table or a column added to the schema goes into the snapshot,
 * the exporter and the importer in the same commit, and this is what makes that
 * rule bite.
 */

export interface VerifyChecks {
  /** Exactly one person carries isSelf, as the invariant requires. */
  singleSelf: boolean;
  selfCount: number;
  /** Messages whose person survived the trip, against the file's own count. */
  messagesInFile: number;
  messagesStored: number;
  messagesAttachedInFile: number;
  messagesAttachedStored: number;
  /** Pictures in the file, and rows in PersonAvatar afterwards. */
  picturesInFile: number;
  picturesStored: number;
}

/**
 * A difference the round trip is allowed to have, with the reason. Every one
 * of these is a value this silo stores in a shape the file did not, and the
 * content is still there: a string rich text column becomes a one paragraph
 * document, and a picture with no metadata beside it gets the defaults the
 * NOT NULL columns need.
 *
 * Anything that is not on this list and is not identical counts as loss.
 */
export interface Normalization {
  collection: string;
  key: string;
  path: string;
  reason: string;
}

export interface Classified {
  normalized: Normalization[];
  unexplained: Normalization[];
  lost: Normalization[];
}

export interface VerifyResult {
  file: string;
  version: number;
  siloPath: string;
  importMs: number;
  exportMs: number;
  counts: domain.transfer.ImportCounts;
  diff: domain.transfer.SnapshotDiff;
  classified: Classified;
  checks: VerifyChecks;
  /** True when nothing was lost and every invariant holds. */
  ok: boolean;
}

export interface VerifyOptions {
  /** Keep the throwaway silo instead of deleting it, to look inside. */
  keep?: boolean;
  /** Collections not expected to survive. appSettings never does. */
  ignore?: string[];
}

/**
 * appSettings is the one collection that cannot come back: this silo has no
 * settings table, because the only setting akai-ito kept there is module config
 * and lives behind the host's settings port now.
 */
export const EXPECTED_LOSS = ["appSettings"];

export async function verifySnapshot(
  file: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const source = JSON.parse(readFileSync(file, "utf8")) as domain.transfer.ExportSnapshot;
  const dir = mkdtempSync(join(tmpdir(), "fellowship-verify-"));
  const siloPath = join(dir, "fellowship.db");

  storage.migrateSilo(siloPath);
  const db: Silo = await storage.openSilo({ path: siloPath });

  try {
    const importStarted = Date.now();
    const imported = await domain.transfer.importSnapshot(db, source, "replace");
    const importMs = Date.now() - importStarted;

    const exportStarted = Date.now();
    const exported = await domain.transfer.buildExportSnapshot(db);
    const exportMs = Date.now() - exportStarted;

    const diff = domain.transfer.diffSnapshots(source, exported, {
      ignore: options.ignore ?? EXPECTED_LOSS,
    });

    const checks = await runChecks(db, source);
    const classified = classify(diff);

    return {
      file,
      version: source.version,
      siloPath,
      importMs,
      exportMs,
      counts: imported.counts,
      diff,
      classified,
      checks,
      ok:
        classified.lost.length === 0 &&
        classified.unexplained.length === 0 &&
        checks.singleSelf &&
        checks.messagesStored === checks.messagesInFile &&
        checks.messagesAttachedStored === checks.messagesAttachedInFile &&
        checks.picturesStored === checks.picturesInFile,
    };
  } finally {
    await db.$disconnect();
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
  }
}

/** The plain text of a Tiptap document, so a wrapped string can be recognised. */
function tiptapText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const node = value as { text?: unknown; content?: unknown };
  const own = typeof node.text === "string" ? node.text : "";
  const children = Array.isArray(node.content)
    ? node.content.map((child) => tiptapText(child)).join("")
    : "";
  return `${own}${children}`;
}

const RICH_TEXT_PATHS = new Set(["description", "body"]);

/**
 * Picture metadata the file may leave null beside real bytes. The columns are
 * NOT NULL here, so the importer fills them in, deterministically.
 */
const AVATAR_DEFAULTS: Record<string, unknown> = {
  avatarMime: "application/octet-stream",
  avatarSource: "MANUAL",
};

export function classify(diff: domain.transfer.SnapshotDiff): Classified {
  const normalized: Normalization[] = [];
  const unexplained: Normalization[] = [];
  const lost: Normalization[] = [];

  for (const collection of diff.problems) {
    for (const key of collection.missing) {
      lost.push({
        collection: collection.collection,
        key,
        path: "",
        reason: "the row did not come back",
      });
    }

    for (const row of collection.changed) {
      for (const field of row.fields) {
        const entry = {
          collection: collection.collection,
          key: row.key,
          path: field.path,
        };

        const gone =
          (field.before !== null && field.before !== undefined) &&
          (field.after === null || field.after === undefined);
        if (gone) {
          lost.push({ ...entry, reason: "the value did not come back" });
          continue;
        }

        if (
          RICH_TEXT_PATHS.has(field.path) &&
          typeof field.before === "string" &&
          tiptapText(field.after).includes(field.before)
        ) {
          normalized.push({
            ...entry,
            reason: "a string rich text column became a one paragraph document, text kept",
          });
          continue;
        }

        if (
          field.before === null &&
          field.path in AVATAR_DEFAULTS &&
          field.after === AVATAR_DEFAULTS[field.path]
        ) {
          normalized.push({
            ...entry,
            reason: `the column is NOT NULL here, so it took its default (${String(field.after)})`,
          });
          continue;
        }

        if (field.before === undefined && field.after === null) {
          normalized.push({
            ...entry,
            reason: "the file predates this column, so it came back empty",
          });
          continue;
        }

        if (field.path === "avatarFetchedAt" && field.before === null && field.after !== null) {
          normalized.push({
            ...entry,
            reason: "no fetch time beside the bytes, so the person's updatedAt was used",
          });
          continue;
        }

        unexplained.push({ ...entry, reason: "not a known normalization" });
      }
    }

    for (const key of collection.extra) {
      unexplained.push({
        collection: collection.collection,
        key,
        path: "",
        reason: "a row appeared that the file did not carry",
      });
    }
  }

  return { normalized, unexplained, lost };
}

async function runChecks(
  db: Silo,
  source: domain.transfer.ExportSnapshot,
): Promise<VerifyChecks> {
  const [selfCount, messagesStored, attachedStored, picturesStored] = await Promise.all([
    db.person.count({ where: { isSelf: true } }),
    db.message.count(),
    db.message.count({ where: { personId: { not: null } } }),
    db.personAvatar.count(),
  ]);

  const messages = source.messages ?? [];

  return {
    singleSelf: selfCount === 1,
    selfCount,
    messagesInFile: messages.length,
    messagesStored,
    messagesAttachedInFile: messages.filter((message) => message.personId !== null).length,
    messagesAttachedStored: attachedStored,
    picturesInFile: source.people.filter((person) => person.avatarImage).length,
    picturesStored,
  };
}

/** One line per reason, with how many rows carried it. */
function summarise(entries: Normalization[]): string[] {
  const byReason = new Map<string, number>();
  for (const entry of entries) {
    const label = `${entry.collection}.${entry.path || "row"}: ${entry.reason}`;
    byReason.set(label, (byReason.get(label) ?? 0) + 1);
  }
  return [...byReason.entries()].map(([label, count]) => `  ${count} x ${label}`);
}

/** The report the CLI prints. */
export function formatVerify(result: VerifyResult): string {
  const { checks } = result;
  return [
    `file            ${result.file}`,
    `version         ${result.version}`,
    `import          ${result.importMs}ms`,
    `export          ${result.exportMs}ms`,
    "",
    domain.transfer.formatDiff(result.diff),
    "",
    `normalized      ${result.classified.normalized.length}`,
    ...summarise(result.classified.normalized),
    `unexplained     ${result.classified.unexplained.length}`,
    ...summarise(result.classified.unexplained),
    `lost            ${result.classified.lost.length}`,
    ...summarise(result.classified.lost),
    "",
    `self records    ${checks.selfCount} ${checks.singleSelf ? "" : "(expected exactly 1)"}`.trim(),
    `messages        ${checks.messagesStored} of ${checks.messagesInFile} stored`,
    `  attached      ${checks.messagesAttachedStored} of ${checks.messagesAttachedInFile} still point at a person`,
    `pictures        ${checks.picturesStored} of ${checks.picturesInFile} stored`,
    "",
    result.ok
      ? "No data loss. Every invariant holds."
      : "Something did not survive the round trip. See the lines above.",
    "",
  ].join("\n");
}
