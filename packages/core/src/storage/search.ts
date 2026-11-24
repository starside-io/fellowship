import type { Silo } from "./client.js";

/**
 * FTS5, and the one job that matters before any of it: turning what a person
 * typed into a MATCH expression that cannot do anything surprising.
 *
 * FTS5 has a query language. Bare user input is not in it: a stray quote is a
 * syntax error, a colon is a column filter, and AND, OR, NOT and NEAR are
 * operators. Every token is therefore quoted into a literal, which is what
 * makes `people.search` safe to hand a search box, and the last token gets a
 * prefix star so the results move while someone is still typing.
 *
 * Why FTS5 at all, when `contains` already matched a substring: SQLite's LIKE
 * is case insensitive for ASCII only. "helene" never found "Hélène", and the
 * silo holds 73,000 message bodies that no LIKE should ever scan.
 */

/** Characters that mean something to FTS5 and nothing to a person. */
const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

export interface MatchQuery {
  /** The expression to hand to MATCH. */
  expression: string;
  /** The words behind it, for a caller that wants to fall back to LIKE. */
  tokens: string[];
}

/**
 * A search box's contents as an FTS5 expression, or null when there is nothing
 * to search for. Every token is double quoted, so an operator typed by a human
 * is matched as the word it looks like rather than obeyed.
 */
export function toMatchQuery(raw: string, options: { prefix?: boolean } = {}): MatchQuery | null {
  const tokens = raw
    .trim()
    .split(TOKEN_SPLIT)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return null;

  const prefix = options.prefix !== false;
  const quoted = tokens.map((token, index) => {
    const literal = `"${token.replace(/"/g, '""')}"`;
    // Only the last token is a prefix: the others are words the person finished
    // typing, and treating them as prefixes makes "sam ri" match "sam rivers"
    // and "sam richard" equally, which is noise rather than help.
    return prefix && index === tokens.length - 1 ? `${literal}*` : literal;
  });

  return { expression: quoted.join(" "), tokens };
}

export interface PersonHit {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  isSelf: boolean;
  avatarColor: string;
  archived: boolean;
}

export interface NoteHit {
  id: string;
  personId: string | null;
  eventId: string | null;
  occurredAt: Date;
  /** The matching stretch of the note, with the hit marked. */
  snippet: string;
}

export interface MessageHit {
  id: string;
  conversationId: string;
  personId: string | null;
  senderName: string;
  sentAt: Date;
  isFromSelf: boolean;
  body: string;
  snippet: string;
}

/** What a snippet is wrapped in, so a caller can render or strip it. */
export const SNIPPET_OPEN = "‹";
export const SNIPPET_CLOSE = "›";
const SNIPPET_ELLIPSIS = "…";

export async function searchPeople(
  db: Silo,
  query: string,
  options: { limit?: number; includeArchived?: boolean } = {},
): Promise<PersonHit[]> {
  const match = toMatchQuery(query);
  if (!match) return [];

  const limit = options.limit ?? 8;

  // displayName is weighted over the given and family names, which are often
  // the same words again and should not double a row's score.
  return db.$queryRawUnsafe<PersonHit[]>(
    `SELECT p."id", p."displayName", p."firstName", p."lastName",
            p."isSelf", p."avatarColor", p."archived"
     FROM "person_fts" f
     JOIN "Person" p ON p."rowid" = f."rowid"
     WHERE "person_fts" MATCH ?
       ${options.includeArchived ? "" : 'AND p."archived" = 0'}
     ORDER BY bm25("person_fts", 10.0, 4.0, 4.0)
     LIMIT ?`,
    match.expression,
    limit,
  );
}

export async function searchNotes(
  db: Silo,
  query: string,
  options: { limit?: number; personId?: string } = {},
): Promise<NoteHit[]> {
  const match = toMatchQuery(query);
  if (!match) return [];

  const limit = options.limit ?? 8;
  const personId = options.personId;

  return db.$queryRawUnsafe<NoteHit[]>(
    `SELECT n."id", n."personId", n."eventId", n."occurredAt",
            snippet("note_fts", 0, ?, ?, ?, 14) AS "snippet"
     FROM "note_fts" f
     JOIN "Note" n ON n."rowid" = f."rowid"
     WHERE "note_fts" MATCH ?
       ${personId ? 'AND n."personId" = ?' : ""}
     ORDER BY rank
     LIMIT ?`,
    ...[
      SNIPPET_OPEN,
      SNIPPET_CLOSE,
      SNIPPET_ELLIPSIS,
      match.expression,
      ...(personId ? [personId] : []),
      limit,
    ],
  );
}

export interface MessageSearchOptions {
  limit?: number;
  offset?: number;
  /** Both sides of the threads this person is in, as read_messages scopes them. */
  conversationIds?: string[];
  personId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Message bodies. This is the half of the search that `contains` could not do
 * at all: scanning 73,000 rows with LIKE for every keystroke is not a search
 * box, it is a table scan with a text field in front of it.
 */
export async function searchMessages(
  db: Silo,
  query: string,
  options: MessageSearchOptions = {},
): Promise<MessageHit[]> {
  const match = toMatchQuery(query);
  if (!match) return [];

  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const ids = options.conversationIds;
  if (ids && ids.length === 0) return [];

  const conditions: string[] = [];
  const parameters: unknown[] = [
    SNIPPET_OPEN,
    SNIPPET_CLOSE,
    SNIPPET_ELLIPSIS,
    match.expression,
  ];

  if (ids) {
    conditions.push(`m."conversationId" IN (${ids.map(() => "?").join(", ")})`);
    parameters.push(...ids);
  }
  if (options.personId) {
    // Both sides of the conversation, which is what makes it read as one.
    conditions.push(`(m."personId" = ? OR m."isFromSelf" = 1)`);
    parameters.push(options.personId);
  }
  if (options.from) {
    conditions.push(`m."sentAt" >= ?`);
    parameters.push(options.from);
  }
  if (options.to) {
    conditions.push(`m."sentAt" <= ?`);
    parameters.push(options.to);
  }

  parameters.push(limit, offset);

  return db.$queryRawUnsafe<MessageHit[]>(
    `SELECT m."id", m."conversationId", m."personId", m."senderName",
            m."sentAt", m."isFromSelf", m."body",
            snippet("message_fts", 0, ?, ?, ?, 14) AS "snippet"
     FROM "message_fts" f
     JOIN "Message" m ON m."rowid" = f."rowid"
     WHERE "message_fts" MATCH ?
       AND m."isSystem" = 0
       ${conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""}
     ORDER BY rank
     LIMIT ? OFFSET ?`,
    ...parameters,
  );
}

export async function countMessageMatches(
  db: Silo,
  query: string,
  options: Omit<MessageSearchOptions, "limit" | "offset"> = {},
): Promise<number> {
  const match = toMatchQuery(query);
  if (!match) return 0;

  const ids = options.conversationIds;
  if (ids && ids.length === 0) return 0;

  const conditions: string[] = [];
  const parameters: unknown[] = [match.expression];

  if (ids) {
    conditions.push(`m."conversationId" IN (${ids.map(() => "?").join(", ")})`);
    parameters.push(...ids);
  }
  if (options.personId) {
    conditions.push(`(m."personId" = ? OR m."isFromSelf" = 1)`);
    parameters.push(options.personId);
  }
  if (options.from) {
    conditions.push(`m."sentAt" >= ?`);
    parameters.push(options.from);
  }
  if (options.to) {
    conditions.push(`m."sentAt" <= ?`);
    parameters.push(options.to);
  }

  const rows = await db.$queryRawUnsafe<Array<{ total: bigint | number }>>(
    `SELECT COUNT(*) AS "total"
     FROM "message_fts" f
     JOIN "Message" m ON m."rowid" = f."rowid"
     WHERE "message_fts" MATCH ?
       AND m."isSystem" = 0
       ${conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""}`,
    ...parameters,
  );

  return Number(rows[0]?.total ?? 0);
}

/**
 * Rebuilds all three indexes from the rows they shadow.
 *
 * The triggers keep them current, so this is not part of any write path. It is
 * here for the case the triggers could not cover: a file restored from a
 * backup taken mid write, or an index that predates a tokenizer change.
 */
export async function rebuildSearchIndex(db: Silo): Promise<void> {
  for (const table of ["person_fts", "note_fts", "message_fts"]) {
    await db.$executeRawUnsafe(`INSERT INTO "${table}"("${table}") VALUES ('rebuild')`);
  }
}

/** The plain text of a Tiptap document, which is what note_fts indexes. */
export function noteSearchText(body: unknown): string {
  const node = body as { text?: unknown; content?: unknown } | null | undefined;
  if (!node || typeof node !== "object") return "";

  const own = typeof node.text === "string" ? node.text : "";
  const children = Array.isArray(node.content)
    ? node.content.map((child) => noteSearchText(child)).join("\n")
    : "";

  return [own, children].filter((part) => part.length > 0).join("\n");
}
