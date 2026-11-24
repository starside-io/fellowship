import type { ExportSnapshot } from "./snapshot.js";

/**
 * Comparing two snapshots row by row.
 *
 * This is the regression test the transfer layer has needed twice. Version 1
 * quietly dropped sketches, favours, contact provenance and avatars while
 * replace mode deleted them first, and the chat tables shipped with no
 * transfer layer at all. Both would have been caught by exporting, importing
 * and comparing, so that comparison lives here rather than in a shell history.
 *
 * Rows are matched by identity rather than by position, because the two
 * exporters are allowed to order a collection differently. Arrays of ids are
 * compared as sets for the same reason.
 */

export interface FieldDifference {
  /** Dotted path from the row, for example "contacts.<id>.verifiedAt". */
  path: string;
  before: unknown;
  after: unknown;
}

export interface RowDifference {
  key: string;
  fields: FieldDifference[];
}

export interface CollectionDiff {
  collection: string;
  before: number;
  after: number;
  /** Present before, gone after. Data loss, every time. */
  missing: string[];
  /** Absent before, present after. */
  extra: string[];
  changed: RowDifference[];
}

export interface SnapshotDiff {
  /** True when nothing at all moved, appSettings included. */
  identical: boolean;
  collections: CollectionDiff[];
  /** The collections with something to report, for a short summary. */
  problems: CollectionDiff[];
}

type Row = Record<string, unknown>;

/** How each collection is identified, and which of its arrays nest. */
const COLLECTIONS: Array<{
  name: keyof ExportSnapshot & string;
  key: (row: Row) => string;
  /** Nested collections, keyed the same way. */
  nested?: Array<{ field: string; key: (row: Row) => string }>;
  /** Arrays of plain values compared as sets. */
  sets?: string[];
}> = [
  {
    name: "people",
    key: (row) => String(row["id"]),
    nested: [
      { field: "contacts", key: (row) => String(row["id"]) },
      { field: "customValues", key: (row) => String(row["id"]) },
    ],
    sets: ["circleIds", "interestIds", "allergyIds", "dislikeIds", "commStyle"],
  },
  { name: "tags", key: (row) => String(row["id"]) },
  { name: "circles", key: (row) => String(row["id"]) },
  { name: "fieldDefinitions", key: (row) => String(row["id"]), sets: ["options"] },
  { name: "notes", key: (row) => String(row["id"]), sets: ["tagIds"] },
  {
    name: "events",
    key: (row) => String(row["id"]),
    nested: [{ field: "participants", key: (row) => String(row["personId"]) }],
  },
  { name: "links", key: (row) => `${String(row["aPersonId"])}|${String(row["bPersonId"])}` },
  { name: "personProfiles", key: (row) => String(row["personId"]), sets: ["sources"] },
  { name: "favours", key: (row) => String(row["id"]) },
  { name: "appSettings", key: (row) => String(row["key"]) },
  {
    name: "conversations",
    key: (row) => String(row["id"]),
    nested: [{ field: "participants", key: (row) => String(row["senderName"]) }],
  },
  { name: "messages", key: (row) => String(row["id"]) },
];

function rowsOf(snapshot: ExportSnapshot, name: string): Row[] {
  const value = (snapshot as unknown as Record<string, unknown>)[name];
  return Array.isArray(value) ? (value as Row[]) : [];
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object") return false;
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

/** Object keys in a stable order, so a key order difference is not a change. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Row)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sorted(entry)]));
}

function asSet(value: unknown): string[] {
  return Array.isArray(value) ? [...value].map((entry) => JSON.stringify(entry)).sort() : [];
}

function compareRow(
  before: Row,
  after: Row,
  options: { nested?: Array<{ field: string; key: (row: Row) => string }>; sets?: string[] },
  prefix = "",
): FieldDifference[] {
  const differences: FieldDifference[] = [];
  const nestedFields = new Set((options.nested ?? []).map((entry) => entry.field));
  const setFields = new Set(options.sets ?? []);
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const field of fields) {
    if (nestedFields.has(field)) continue;

    if (setFields.has(field)) {
      const left = asSet(before[field]);
      const right = asSet(after[field]);
      if (left.join("\u0000") !== right.join("\u0000")) {
        differences.push({ path: `${prefix}${field}`, before: before[field], after: after[field] });
      }
      continue;
    }

    if (!sameValue(before[field], after[field])) {
      differences.push({ path: `${prefix}${field}`, before: before[field], after: after[field] });
    }
  }

  for (const nested of options.nested ?? []) {
    const left = new Map(
      (Array.isArray(before[nested.field]) ? (before[nested.field] as Row[]) : []).map((row) => [
        nested.key(row),
        row,
      ]),
    );
    const right = new Map(
      (Array.isArray(after[nested.field]) ? (after[nested.field] as Row[]) : []).map((row) => [
        nested.key(row),
        row,
      ]),
    );

    for (const [key, row] of left) {
      const other = right.get(key);
      if (!other) {
        differences.push({
          path: `${prefix}${nested.field}.${key}`,
          before: row,
          after: undefined,
        });
        continue;
      }
      differences.push(
        ...compareRow(row, other, {}, `${prefix}${nested.field}.${key}.`),
      );
    }

    for (const [key, row] of right) {
      if (left.has(key)) continue;
      differences.push({
        path: `${prefix}${nested.field}.${key}`,
        before: undefined,
        after: row,
      });
    }
  }

  return differences;
}

export interface DiffOptions {
  /** Collections whose contents are not expected to survive the round trip. */
  ignore?: string[];
  /** Cap on reported rows per collection, so a report stays readable. */
  maxRowsReported?: number;
}

export function diffSnapshots(
  before: ExportSnapshot,
  after: ExportSnapshot,
  options: DiffOptions = {},
): SnapshotDiff {
  const ignore = new Set(options.ignore ?? []);
  const cap = options.maxRowsReported ?? 20;
  const collections: CollectionDiff[] = [];

  for (const collection of COLLECTIONS) {
    const beforeRows = rowsOf(before, collection.name);
    const afterRows = rowsOf(after, collection.name);

    const diff: CollectionDiff = {
      collection: collection.name,
      before: beforeRows.length,
      after: afterRows.length,
      missing: [],
      extra: [],
      changed: [],
    };

    if (ignore.has(collection.name)) {
      collections.push(diff);
      continue;
    }

    const left = new Map(beforeRows.map((row) => [collection.key(row), row]));
    const right = new Map(afterRows.map((row) => [collection.key(row), row]));

    for (const [key, row] of left) {
      const other = right.get(key);
      if (!other) {
        if (diff.missing.length < cap) diff.missing.push(key);
        continue;
      }

      const fields = compareRow(row, other, {
        ...(collection.nested ? { nested: collection.nested } : {}),
        ...(collection.sets ? { sets: collection.sets } : {}),
      });
      if (fields.length > 0 && diff.changed.length < cap) {
        diff.changed.push({ key, fields });
      }
    }

    for (const key of right.keys()) {
      if (!left.has(key) && diff.extra.length < cap) diff.extra.push(key);
    }

    collections.push(diff);
  }

  const problems = collections.filter(
    (diff) =>
      diff.before !== diff.after ||
      diff.missing.length > 0 ||
      diff.extra.length > 0 ||
      diff.changed.length > 0,
  );

  return { identical: problems.length === 0, collections, problems };
}

/** A report a human reads, one line per collection. */
export function formatDiff(diff: SnapshotDiff): string {
  const lines = [
    "collection          before    after  verdict",
    "------------------------------------------------",
  ];

  for (const collection of diff.collections) {
    const verdict =
      collection.before === collection.after &&
      collection.missing.length === 0 &&
      collection.extra.length === 0 &&
      collection.changed.length === 0
        ? "same"
        : [
            collection.missing.length > 0 ? `${collection.missing.length} missing` : "",
            collection.extra.length > 0 ? `${collection.extra.length} extra` : "",
            collection.changed.length > 0 ? `${collection.changed.length} changed` : "",
            collection.before !== collection.after ? "count moved" : "",
          ]
            .filter(Boolean)
            .join(", ");

    lines.push(
      `${collection.collection.padEnd(18)} ${String(collection.before).padStart(6)} ${String(
        collection.after,
      ).padStart(8)}  ${verdict}`,
    );
  }

  for (const collection of diff.problems) {
    for (const row of collection.changed.slice(0, 5)) {
      for (const field of row.fields.slice(0, 5)) {
        lines.push(
          `  ${collection.collection} ${row.key} ${field.path}: ${JSON.stringify(
            field.before,
          )} -> ${JSON.stringify(field.after)}`,
        );
      }
    }
    for (const key of collection.missing.slice(0, 5)) {
      lines.push(`  ${collection.collection} ${key} is gone`);
    }
    for (const key of collection.extra.slice(0, 5)) {
      lines.push(`  ${collection.collection} ${key} appeared`);
    }
  }

  return lines.join("\n");
}
