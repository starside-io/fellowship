import type { Silo } from "../storage/client.js";
import { searchPeople } from "../storage/search.js";

/*
 * A name to one person, or to a question.
 *
 * Every write tool takes a personId, and a caller handed a name has to turn it
 * into one. Search returns a ranked list with nothing in it that says "two
 * people answer to this", so a model reading the first hit picks Sam Rivera
 * when the owner meant Sam Okonkwo, and the wrong record gets an email
 * attached to it.
 *
 * This resolves the name and refuses to choose: one match is a match, several
 * matches come back as candidates with the facts that tell them apart, and the
 * caller has to ask the owner which one. Nothing here writes.
 */

export type ResolveStatus = "unique" | "ambiguous" | "none";

export type PersonCandidate = {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  isSelf: boolean;
  archived: boolean;
  location: string | null;
  howWeMet: string | null;
  circles: string[];
  /** Enough of the contact rows to recognise someone by, never the whole card. */
  contacts: Array<{ kind: string; platform: string | null; value: string }>;
  occasionCount: number;
  lastOccasionAt: string | null;
  /**
   * The one line to put in front of the owner when asking which person was
   * meant. Empty when a record holds nothing that would tell it apart, which
   * is itself worth seeing.
   */
  detail: string;
};

export type ResolveResult = {
  query: string;
  status: ResolveStatus;
  /** Set only when the status is unique. */
  match: PersonCandidate | null;
  candidates: PersonCandidate[];
  /** What the caller is expected to do next. */
  hint: string;
};

const MAX_LIMIT = 10;
const CONTACTS_SHOWN = 4;

/** Case and accent folded, so "Hélène" and "helene" are the same name. */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function givenAndFamily(person: { firstName: string | null; lastName: string | null }): string {
  return [person.firstName, person.lastName].filter(Boolean).join(" ");
}

function detailOf(candidate: Omit<PersonCandidate, "detail">): string {
  const parts: string[] = [];
  if (candidate.isSelf) parts.push("your own record");
  if (candidate.archived) parts.push("archived");
  if (candidate.location) parts.push(candidate.location);
  if (candidate.howWeMet) parts.push(`met ${candidate.howWeMet}`);
  if (candidate.circles.length > 0) parts.push(candidate.circles.join(", "));
  if (candidate.lastOccasionAt) {
    parts.push(`last occasion ${candidate.lastOccasionAt.slice(0, 10)}`);
  }
  for (const contact of candidate.contacts.slice(0, 2)) {
    parts.push(contact.platform ? `${contact.platform} ${contact.value}` : contact.value);
  }
  return parts.join(" · ");
}

function hintFor(status: ResolveStatus, query: string, count: number): string {
  if (status === "unique") {
    return "One person answers to that name. Use match.id.";
  }
  if (status === "ambiguous") {
    return `${count} people answer to "${query}". Ask the owner which one, naming the detail on each, and use the id they pick. Do not choose for them.`;
  }
  return `Nobody here answers to "${query}". people.create adds them, and nothing else should be written against a guessed id.`;
}

/**
 * Finds everyone a name could mean.
 *
 * Two passes, because they miss different things. FTS5 over the names is what
 * makes an accented name findable from the way it is typed, but it matches
 * whole tokens only, so a half typed "riv" finds nobody. A contains scan
 * catches that, and costs nothing at the size of one person's fellowship.
 */
export async function resolvePeopleByName(
  db: Silo,
  name: string,
  options: { limit?: number; includeArchived?: boolean } = {},
): Promise<ResolveResult> {
  const query = name.trim();
  const limit = Math.min(Math.max(options.limit ?? 8, 1), MAX_LIMIT);
  const includeArchived = options.includeArchived ?? false;

  const ranked = await searchPeople(db, query, { limit: MAX_LIMIT, includeArchived });
  const rankedIds = ranked.map((hit) => hit.id);

  const scanned = await db.person.findMany({
    where: {
      ...(includeArchived ? {} : { archived: false }),
      ...(rankedIds.length > 0 ? { NOT: { id: { in: rankedIds } } } : {}),
      OR: [
        { displayName: { contains: query } },
        { firstName: { contains: query } },
        { lastName: { contains: query } },
      ],
    },
    select: { id: true },
    take: MAX_LIMIT,
  });

  const ids = [...rankedIds, ...scanned.map((row) => row.id)];
  if (ids.length === 0) {
    return { query, status: "none", match: null, candidates: [], hint: hintFor("none", query, 0) };
  }

  const rows = await db.person.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      displayName: true,
      firstName: true,
      lastName: true,
      isSelf: true,
      archived: true,
      location: true,
      howWeMet: true,
      circles: { select: { name: true }, orderBy: { name: "asc" } },
      contacts: {
        select: { kind: true, platform: true, value: true },
        orderBy: [{ isPrimary: "desc" }, { kind: "asc" }],
        take: CONTACTS_SHOWN,
      },
      events: {
        select: { event: { select: { occurredAt: true } } },
        orderBy: { event: { occurredAt: "desc" } },
        take: 1,
      },
      _count: { select: { events: true } },
    },
  });

  // The FTS order is the relevance order, and the scan appends what it alone
  // found, so the row order is restored from the id list rather than the query.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const candidates: PersonCandidate[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const base = {
      id: row.id,
      displayName: row.displayName,
      firstName: row.firstName,
      lastName: row.lastName,
      isSelf: row.isSelf,
      archived: row.archived,
      location: row.location,
      howWeMet: row.howWeMet,
      circles: row.circles.map((circle) => circle.name),
      contacts: row.contacts,
      occasionCount: row._count.events,
      lastOccasionAt: row.events[0]?.event.occurredAt.toISOString() ?? null,
    };
    candidates.push({ ...base, detail: detailOf(base) });
  }

  // An exact name beats a fuzzy one: with a Sam Rivera and a Samantha Rivers
  // on file, "Sam Rivera" is not ambiguous, it is the first of the two.
  const wanted = fold(query);
  const exact = candidates.filter(
    (candidate) =>
      fold(candidate.displayName) === wanted ||
      (givenAndFamily(candidate) !== "" && fold(givenAndFamily(candidate)) === wanted),
  );

  const pool = (exact.length > 0 ? exact : candidates).slice(0, limit);
  const status: ResolveStatus =
    pool.length === 0 ? "none" : pool.length === 1 ? "unique" : "ambiguous";

  return {
    query,
    status,
    match: status === "unique" ? pool[0] : null,
    candidates: pool,
    hint: hintFor(status, query, pool.length),
  };
}
