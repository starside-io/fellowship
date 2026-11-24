import type { Silo } from "../storage/client.js";
import { daysUntil, nextOccurrence, turning } from "./birthday.js";

/**
 * The landing page in one round trip: what is coming up, and what the last
 * year looked like. Counts only, with the sample behind every figure, so the
 * page never shows a mean that two occasions produced without saying so.
 */

export interface UpcomingOccasion {
  kind: "birthday" | "met";
  personId: string;
  displayName: string;
  avatarColor: string;
  /** The day it falls on, YYYY-MM-DD. */
  date: string;
  daysAway: number;
  /** The age they turn, or the years since you met. Null when unknown. */
  years: number | null;
}

export interface DashboardData {
  generatedAt: string;
  upcoming: UpcomingOccasion[];
  /** People with no birthday recorded, so the page can say how complete the list is. */
  missingBirthdays: number;
  /** The last twelve calendar months, oldest first, the current month last. */
  months: Array<{
    month: string;
    occasions: number;
    people: number;
    messages: number;
    /** Mean sentiment over the month's occasions, null when there were none. */
    meanSentiment: number | null;
  }>;
  types: Array<{ type: string; count: number }>;
  /** The most occasions shared over the last 90 days. */
  topPeople: Array<{
    personId: string;
    displayName: string;
    avatarColor: string;
    occasions: number;
  }>;
  circles: Array<{ name: string; colour: string; people: number }>;
  totals: {
    people: number;
    occasions: number;
    messages: number;
    conversations: number;
    occasionsLast30: number;
  };
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export async function getDashboardData(
  db: Silo,
  now: Date,
  options: { horizonDays: number },
): Promise<DashboardData> {
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const last90 = new Date(now.getTime() - 90 * 86_400_000);
  const last30 = new Date(now.getTime() - 30 * 86_400_000);

  const [people, events, messages, occasions, messageTotal, conversations, circles] =
    await Promise.all([
      db.person.findMany({
        where: { archived: false, isSelf: false },
        select: {
          id: true,
          displayName: true,
          avatarColor: true,
          birthday: true,
          metOn: true,
        },
      }),
      db.event.findMany({
        where: { occurredAt: { gte: yearStart } },
        select: {
          occurredAt: true,
          type: true,
          sentiment: true,
          participants: { select: { personId: true, person: { select: { isSelf: true } } } },
        },
      }),
      db.message.findMany({
        where: { sentAt: { gte: yearStart }, isSystem: false },
        select: { sentAt: true },
      }),
      db.event.count(),
      db.message.count({ where: { isSystem: false } }),
      db.conversation.count(),
      db.circle.findMany({
        select: {
          name: true,
          colour: true,
          _count: { select: { people: { where: { archived: false } } } },
        },
      }),
    ]);

  const upcoming: UpcomingOccasion[] = [];
  for (const person of people) {
    for (const [kind, day] of [
      ["birthday", person.birthday],
      ["met", person.metOn],
    ] as const) {
      if (!day) continue;
      const next = nextOccurrence(day, now);
      const away = daysUntil(next, now);
      if (away > options.horizonDays) continue;
      const years =
        kind === "birthday"
          ? turning(day, next)
          : next.getUTCFullYear() - day.getUTCFullYear() > 0
            ? next.getUTCFullYear() - day.getUTCFullYear()
            : null;
      // Meeting someone this year is not an anniversary yet.
      if (kind === "met" && years === null) continue;
      upcoming.push({
        kind,
        personId: person.id,
        displayName: person.displayName,
        avatarColor: person.avatarColor,
        date: next.toISOString().slice(0, 10),
        daysAway: away,
        years,
      });
    }
  }
  upcoming.sort((a, b) => a.daysAway - b.daysAway || a.displayName.localeCompare(b.displayName));

  const months = new Map<
    string,
    { occasions: number; people: Set<string>; messages: number; sentiment: number }
  >();
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    months.set(monthKey(date), { occasions: 0, people: new Set(), messages: 0, sentiment: 0 });
  }

  const types = new Map<string, number>();
  const shared = new Map<string, number>();
  let occasionsLast30 = 0;

  for (const event of events) {
    const bucket = months.get(monthKey(event.occurredAt));
    if (bucket) {
      bucket.occasions += 1;
      bucket.sentiment += event.sentiment;
      for (const participant of event.participants) {
        if (!participant.person.isSelf) bucket.people.add(participant.personId);
      }
    }
    types.set(event.type, (types.get(event.type) ?? 0) + 1);
    if (event.occurredAt >= last30) occasionsLast30 += 1;
    if (event.occurredAt >= last90) {
      for (const participant of event.participants) {
        if (participant.person.isSelf) continue;
        shared.set(participant.personId, (shared.get(participant.personId) ?? 0) + 1);
      }
    }
  }

  for (const message of messages) {
    const bucket = months.get(monthKey(message.sentAt));
    if (bucket) bucket.messages += 1;
  }

  const byId = new Map(people.map((person) => [person.id, person]));

  return {
    generatedAt: now.toISOString(),
    upcoming,
    missingBirthdays: people.filter((person) => person.birthday === null).length,
    months: [...months.entries()].map(([month, bucket]) => ({
      month,
      occasions: bucket.occasions,
      people: bucket.people.size,
      messages: bucket.messages,
      meanSentiment:
        bucket.occasions === 0
          ? null
          : Math.round((bucket.sentiment / bucket.occasions) * 100) / 100,
    })),
    types: [...types.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    topPeople: [...shared.entries()]
      .flatMap(([personId, count]) => {
        const person = byId.get(personId);
        return person
          ? [
              {
                personId,
                displayName: person.displayName,
                avatarColor: person.avatarColor,
                occasions: count,
              },
            ]
          : [];
      })
      .sort((a, b) => b.occasions - a.occasions)
      .slice(0, 8),
    circles: circles
      .map((circle) => ({ name: circle.name, colour: circle.colour, people: circle._count.people }))
      .filter((circle) => circle.people > 0)
      .sort((a, b) => b.people - a.people),
    totals: {
      people: people.length,
      occasions,
      messages: messageTotal,
      conversations,
      occasionsLast30,
    },
  };
}
