import type { Silo } from "../storage/client.js";
import type { GraphPayload } from "./graph-types.js";

/**
 * Everything the graph needs in one round trip. Links carry both the derived
 * score and the manual override so the client decides which one wins; events
 * carry enough raw data to replay scores over a date range.
 */
export async function getGraphData(db: Silo): Promise<GraphPayload> {
  const [people, events, links] = await Promise.all([
    db.person.findMany({
      where: { archived: false },
      select: {
        id: true,
        displayName: true,
        avatarColor: true,
        isSelf: true,
        circles: {
          select: { id: true, name: true, colour: true },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { displayName: "asc" },
    }),
    db.event.findMany({
      select: {
        id: true,
        occurredAt: true,
        type: true,
        sentiment: true,
        weight: true,
        participants: {
          where: { person: { archived: false } },
          select: { personId: true, sentiment: true },
        },
      },
      orderBy: { occurredAt: "asc" },
    }),
    db.link.findMany({
      where: {
        personA: { archived: false },
        personB: { archived: false },
      },
      select: {
        aPersonId: true,
        bPersonId: true,
        tie: true,
        pinned: true,
        manualScore: true,
        stat: true,
      },
    }),
  ]);

  const selfId = people.find((person) => person.isSelf)?.id ?? null;

  // Closeness is the effective score of the link with the self person.
  const closenessByPerson = new Map<string, number>();
  if (selfId) {
    for (const link of links) {
      const other =
        link.aPersonId === selfId
          ? link.bPersonId
          : link.bPersonId === selfId
            ? link.aPersonId
            : null;
      if (!other) continue;
      closenessByPerson.set(other, link.manualScore ?? link.stat?.score ?? 0);
    }
  }

  const payloadLinks = links.map((link) => ({
    aPersonId: link.aPersonId,
    bPersonId: link.bPersonId,
    tie: link.tie,
    score: link.stat?.score ?? 0,
    eventCount: link.stat?.eventCount ?? 0,
    lastEventAt: link.stat?.lastEventAt ?? null,
    pinned: link.pinned,
    manualScore: link.manualScore,
    implicit: false,
  }));

  // The user knows everyone in their own database, so every person without a
  // real link to self gets a synthesized acquaintance thread. Payload only,
  // nothing is written back to the database.
  if (selfId) {
    const linkedToSelf = new Set<string>();
    for (const link of links) {
      if (link.aPersonId === selfId) linkedToSelf.add(link.bPersonId);
      else if (link.bPersonId === selfId) linkedToSelf.add(link.aPersonId);
    }
    for (const person of people) {
      if (person.id === selfId) continue;
      if (linkedToSelf.has(person.id)) continue;
      payloadLinks.push({
        aPersonId: selfId,
        bPersonId: person.id,
        tie: "KNOWS_OF",
        score: 0,
        eventCount: 0,
        lastEventAt: null,
        pinned: false,
        manualScore: null,
        implicit: true,
      });
    }
  }

  return {
    people: people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      avatarColor: person.avatarColor,
      isSelf: person.isSelf,
      circles: person.circles,
      closeness: closenessByPerson.get(person.id) ?? 0,
    })),
    events: events.map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt,
      type: event.type,
      sentiment: event.sentiment,
      weight: event.weight,
      participants: event.participants.map((participant) => ({
        personId: participant.personId,
        sentiment: participant.sentiment,
      })),
    })),
    links: payloadLinks,
  };
}
