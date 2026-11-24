import { z } from "zod";

import { Prisma } from "../../../generated/prisma/index.js";
import { DEFAULT_CONFIG } from "../../config/index.js";
import { noteSearchText } from "../../storage/search.js";
import type { Silo } from "../../storage/client.js";
import { decodeBytes } from "./bytes.js";
import {
  snapshotSchema,
  type ParsedContact,
  type ParsedSnapshot,
  type ParsedPerson,
} from "./snapshot.js";

export const importModeSchema = z.enum(["merge", "replace"]);
export type ImportMode = z.infer<typeof importModeSchema>;

/** A refusal the user can act on, as opposed to an unexpected failure. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export type ImportCounts = {
  people: number;
  circles: number;
  tags: number;
  fieldDefinitions: number;
  contacts: number;
  customValues: number;
  notes: number;
  events: number;
  eventParticipants: number;
  links: number;
  personProfiles: number;
  favours: number;
  /**
   * Rows the file carried for the old AppSetting table, which this silo does
   * not have: the one setting it held is module config, kept by the host behind
   * the settings port. Counted so an import of an akai-ito file says out loud
   * what it did not write.
   */
  appSettingsIgnored: number;
  conversations: number;
  conversationParticipants: number;
  messages: number;
};

export type ImportResult = {
  mode: ImportMode;
  counts: ImportCounts;
};

type Tx = Prisma.TransactionClient;

/** Ids that had to be redirected onto an existing row during a merge. */
type IdMap = Map<string, string>;

function remap(map: IdMap, id: string): string {
  return map.get(id) ?? id;
}

function remapAll(map: IdMap, ids: string[]): string[] {
  return ids.map((id) => remap(map, id));
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Prisma needs the JsonNull sentinel rather than a bare null. */
function jsonOrNull(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined
    ? Prisma.JsonNull
    : jsonInput(value);
}

function personScalars(person: ParsedPerson) {
  return {
    displayName: person.displayName,
    firstName: person.firstName,
    lastName: person.lastName,
    isSelf: person.isSelf,
    avatarColor: person.avatarColor,
    birthday: person.birthday ?? null,
    location: person.location,
    howWeMet: person.howWeMet,
    metOn: person.metOn ?? null,
    commStyle: person.commStyle,
    ...(person.mbti === undefined ? {} : { mbti: person.mbti }),
    archived: person.archived,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };
}

/**
 * The picture, which is a PersonAvatar row here rather than five columns on
 * Person. Three states, and the difference between the last two is the whole
 * reason the snapshot distinguishes absent from null:
 *
 *   undefined  the file knows nothing about pictures (a version 1 file).
 *              Leave whatever is stored alone.
 *   null       the file says this person has no picture. Delete the row.
 *   a string   base64 bytes. Write them.
 *
 * mime, source and fetchedAt are NOT NULL on PersonAvatar while the snapshot
 * allows them to be null beside a picture, so a file that carries bytes with no
 * metadata is normalized rather than refused: an octet-stream mime, a MANUAL
 * source, and the person's own updatedAt as the fetch time. Deterministic, so
 * exporting again gives the same file back.
 */
type AvatarIntent =
  | { action: "ignore" }
  | { action: "clear" }
  | {
      action: "write";
      image: Uint8Array<ArrayBuffer>;
      mime: string;
      source: string;
      sourceUrl: string | null;
      fetchedAt: Date;
    };

function avatarIntent(person: ParsedPerson): AvatarIntent {
  if (person.avatarImage === undefined) return { action: "ignore" };
  if (person.avatarImage === null) return { action: "clear" };

  return {
    action: "write",
    image: decodeBytes(person.avatarImage),
    mime: person.avatarMime ?? "application/octet-stream",
    source: person.avatarSource ?? "MANUAL",
    sourceUrl: person.avatarSourceUrl ?? null,
    fetchedAt: person.avatarFetchedAt ?? person.updatedAt,
  };
}

/** Applies one intent. Used by both the replace path and the merge path. */
async function writeAvatar(tx: Tx, personId: string, intent: AvatarIntent) {
  if (intent.action === "ignore") return;

  if (intent.action === "clear") {
    await tx.personAvatar.deleteMany({ where: { personId } });
    return;
  }

  const data = {
    image: intent.image,
    mime: intent.mime,
    source: intent.source,
    sourceUrl: intent.sourceUrl,
    fetchedAt: intent.fetchedAt,
  };

  await tx.personAvatar.upsert({
    where: { personId },
    create: { personId, ...data },
    update: data,
  });
}

/** Provenance follows the same rule: absent means leave the column as it is. */
function contactScalars(contact: ParsedContact) {
  return {
    kind: contact.kind,
    platform: contact.platform,
    value: contact.value,
    url: contact.url,
    isPrimary: contact.isPrimary,
    label: contact.label,
    source: contact.source,
    sourceUrl: contact.sourceUrl,
    confidence: contact.confidence,
    verifiedAt: contact.verifiedAt,
  };
}

type ParsedProfile = NonNullable<ParsedSnapshot["personProfiles"]>[number];
type ParsedFavour = NonNullable<ParsedSnapshot["favours"]>[number];
type ParsedConversation = NonNullable<ParsedSnapshot["conversations"]>[number];
type ParsedMessage = NonNullable<ParsedSnapshot["messages"]>[number];

/**
 * A real chat import runs to tens of thousands of messages, so they move in
 * batches, which cuts the round trips by three orders of magnitude.
 *
 * 500 rather than the 1000 this was measured at against Postgres: 500 rows
 * across 8 columns binds 4000 parameters, well under the 32766 ceiling of a
 * modern SQLite and clear of the 999 of an older one. Overridable through the
 * messageChunk config key.
 */
const DEFAULT_MESSAGE_CHUNK = DEFAULT_CONFIG.messageChunk;

function chunked<T>(rows: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    batches.push(rows.slice(start, start + size));
  }
  return batches;
}

function conversationScalars(conversation: ParsedConversation) {
  return {
    source: conversation.source,
    title: conversation.title,
    isGroup: conversation.isGroup,
    fileName: conversation.fileName,
    importedAt: conversation.importedAt,
    firstMessageAt: conversation.firstMessageAt ?? null,
    lastMessageAt: conversation.lastMessageAt ?? null,
    messageCount: conversation.messageCount,
  };
}

/** Participants are nested, so the conversation supplies half their key. */
function participantRows(conversation: ParsedConversation) {
  return conversation.participants.map((participant) => ({
    conversationId: conversation.id,
    senderName: participant.senderName,
    personId: participant.personId,
    isSelf: participant.isSelf,
    messageCount: participant.messageCount,
  }));
}

function messageRow(message: ParsedMessage) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderName: message.senderName,
    personId: message.personId,
    sentAt: message.sentAt,
    body: message.body,
    isFromSelf: message.isFromSelf,
    isSystem: message.isSystem,
  };
}

function profileScalars(profile: ParsedProfile) {
  return {
    summary: profile.summary,
    whatLands: profile.whatLands,
    whatToAvoid: profile.whatToAvoid,
    opener: profile.opener,
    traits: jsonOrNull(profile.traits),
    ...(profile.personality === undefined
      ? {}
      : { personality: jsonOrNull(profile.personality) }),
    ...(profile.personalityAt === undefined
      ? {}
      : { personalityAt: profile.personalityAt ?? null }),
    sources: profile.sources,
    source: profile.source,
    generatedAt: profile.generatedAt ?? null,
    confirmedAt: profile.confirmedAt ?? null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function favourScalars(favour: ParsedFavour) {
  return {
    personId: favour.personId,
    direction: favour.direction,
    description: favour.description,
    settledAt: favour.settledAt ?? null,
    createdAt: favour.createdAt,
    updatedAt: favour.updatedAt,
  };
}

function emptyCounts(): ImportCounts {
  return {
    people: 0,
    circles: 0,
    tags: 0,
    fieldDefinitions: 0,
    contacts: 0,
    customValues: 0,
    notes: 0,
    events: 0,
    eventParticipants: 0,
    links: 0,
    personProfiles: 0,
    favours: 0,
    appSettingsIgnored: 0,
    conversations: 0,
    conversationParticipants: 0,
    messages: 0,
  };
}

/**
 * Exactly one person carries isSelf. The snapshot decides when it names one,
 * otherwise whatever the database already had has to be enough.
 */
async function enforceSingleSelf(tx: Tx, selfId: string | null) {
  if (selfId) {
    await tx.person.updateMany({
      where: { isSelf: true, id: { not: selfId } },
      data: { isSelf: false },
    });
    // updateMany leaves updatedAt alone when nothing matches, so a re-import
    // of the same file does not churn the timestamps.
    await tx.person.updateMany({
      where: { id: selfId, isSelf: false },
      data: { isSelf: true },
    });
    return;
  }

  const count = await tx.person.count({ where: { isSelf: true } });
  if (count !== 1) {
    throw new ImportError(
      "After the import no single person is marked as self. Add the self person to the file and try again.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Replace                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cascades would cover most of this, the explicit order keeps it obvious.
 *
 * Chats are only wiped when the file carries them. Sketches, favours and
 * pictures hang off a person and go with it either way, but a conversation
 * stands alone, and an older file has no opinion about them worth acting on.
 * Wiping chats on a file that cannot restore them is exactly the loss this
 * version exists to stop.
 *
 * Messages and participants go before people: their person id is SetNull, so
 * clearing the chats first spares the database a pass that nulls every one of
 * them on the way out.
 */
async function deleteEverything(tx: Tx, options: { chats: boolean }) {
  if (options.chats) {
    await tx.message.deleteMany();
    await tx.conversationParticipant.deleteMany();
    await tx.conversation.deleteMany();
  }
  await tx.linkStat.deleteMany();
  await tx.link.deleteMany();
  await tx.eventParticipant.deleteMany();
  await tx.note.deleteMany();
  await tx.customValue.deleteMany();
  await tx.contactChannel.deleteMany();
  await tx.favour.deleteMany();
  await tx.personProfile.deleteMany();
  await tx.event.deleteMany();
  await tx.person.deleteMany();
  await tx.tag.deleteMany();
  await tx.circle.deleteMany();
  await tx.fieldDefinition.deleteMany();
}

async function insertAll(
  tx: Tx,
  snapshot: ParsedSnapshot,
  messageChunk: number,
): Promise<ImportCounts> {
  const counts = emptyCounts();

  await tx.circle.createMany({ data: snapshot.circles });
  counts.circles = snapshot.circles.length;

  await tx.tag.createMany({ data: snapshot.tags });
  counts.tags = snapshot.tags.length;

  await tx.fieldDefinition.createMany({ data: snapshot.fieldDefinitions });
  counts.fieldDefinitions = snapshot.fieldDefinitions.length;

  for (const person of snapshot.people) {
    await tx.person.create({
      data: {
        id: person.id,
        ...personScalars(person),
        circles: { connect: person.circleIds.map((id) => ({ id })) },
        interests: { connect: person.interestIds.map((id) => ({ id })) },
        allergies: { connect: person.allergyIds.map((id) => ({ id })) },
        dislikes: { connect: person.dislikeIds.map((id) => ({ id })) },
        contacts: {
          create: person.contacts.map((contact) => ({
            id: contact.id,
            ...contactScalars(contact),
          })),
        },
        customValues: {
          create: person.customValues.map((entry) => ({
            id: entry.id,
            fieldDefinitionId: entry.fieldDefinitionId,
            value: jsonOrNull(entry.value),
          })),
        },
      },
    });

    await writeAvatar(tx, person.id, avatarIntent(person));

    counts.people += 1;
    counts.contacts += person.contacts.length;
    counts.customValues += person.customValues.length;
  }

  for (const profile of snapshot.personProfiles ?? []) {
    await tx.personProfile.create({
      data: {
        id: profile.id,
        personId: profile.personId,
        ...profileScalars(profile),
      },
    });
    counts.personProfiles += 1;
  }

  for (const favour of snapshot.favours ?? []) {
    await tx.favour.create({
      data: { id: favour.id, ...favourScalars(favour) },
    });
    counts.favours += 1;
  }

  counts.appSettingsIgnored = (snapshot.appSettings ?? []).length;

  // After the people, because a message and a participant both point at one.
  const conversations = snapshot.conversations ?? [];

  if (conversations.length > 0) {
    await tx.conversation.createMany({
      data: conversations.map((conversation) => ({
        id: conversation.id,
        ...conversationScalars(conversation),
      })),
    });
    counts.conversations = conversations.length;

    const participants = conversations.flatMap(participantRows);
    if (participants.length > 0) {
      await tx.conversationParticipant.createMany({ data: participants });
      counts.conversationParticipants = participants.length;
    }
  }

  for (const batch of chunked(snapshot.messages ?? [], messageChunk)) {
    await tx.message.createMany({ data: batch.map(messageRow) });
    counts.messages += batch.length;
  }

  for (const event of snapshot.events) {
    await tx.event.create({
      data: {
        id: event.id,
        title: event.title,
        type: event.type,
        occurredAt: event.occurredAt,
        location: event.location,
        description: jsonOrNull(event.description),
        sentiment: event.sentiment,
        weight: event.weight,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        participants: {
          create: event.participants.map((participant) => ({
            personId: participant.personId,
            role: participant.role,
            sentiment: participant.sentiment,
          })),
        },
      },
    });

    counts.events += 1;
    counts.eventParticipants += event.participants.length;
  }

  for (const note of snapshot.notes) {
    await tx.note.create({
      data: {
        id: note.id,
        personId: note.personId,
        eventId: note.eventId,
        body: jsonInput(note.body),
        searchText: noteSearchText(note.body),
        occurredAt: note.occurredAt,
        pinned: note.pinned,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        tags: { connect: note.tagIds.map((id) => ({ id })) },
      },
    });

    counts.notes += 1;
  }

  for (const link of snapshot.links) {
    await tx.link.create({
      data: {
        id: link.id,
        aPersonId: link.aPersonId,
        bPersonId: link.bPersonId,
        tie: link.tie,
        manualScore: link.manualScore,
        pinned: link.pinned,
        notes: link.notes,
        stat: link.stat
          ? {
              create: {
                score: link.stat.score,
                eventCount: link.stat.eventCount,
                lastEventAt: link.stat.lastEventAt ?? null,
                positiveCount: link.stat.positiveCount,
                negativeCount: link.stat.negativeCount,
              },
            }
          : undefined,
      },
    });

    counts.links += 1;
  }

  return counts;
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Circles, tags, and field definitions carry natural unique keys. When the
 * snapshot brings a row whose id is new but whose name is taken, the existing
 * row wins and the incoming id is remapped onto it.
 */
async function mergeCircles(tx: Tx, snapshot: ParsedSnapshot, map: IdMap) {
  for (const circle of snapshot.circles) {
    const byId = await tx.circle.findUnique({ where: { id: circle.id } });
    if (byId) {
      await tx.circle.update({
        where: { id: circle.id },
        data: { name: circle.name, colour: circle.colour },
      });
      continue;
    }

    const byName = await tx.circle.findUnique({ where: { name: circle.name } });
    if (byName) {
      await tx.circle.update({
        where: { id: byName.id },
        data: { colour: circle.colour },
      });
      map.set(circle.id, byName.id);
      continue;
    }

    await tx.circle.create({ data: circle });
  }
}

async function mergeTags(tx: Tx, snapshot: ParsedSnapshot, map: IdMap) {
  for (const tag of snapshot.tags) {
    const byId = await tx.tag.findUnique({ where: { id: tag.id } });
    if (byId) {
      await tx.tag.update({
        where: { id: tag.id },
        data: { kind: tag.kind, name: tag.name, colour: tag.colour },
      });
      continue;
    }

    const byName = await tx.tag.findUnique({
      where: { kind_name: { kind: tag.kind, name: tag.name } },
    });
    if (byName) {
      await tx.tag.update({
        where: { id: byName.id },
        data: { colour: tag.colour },
      });
      map.set(tag.id, byName.id);
      continue;
    }

    await tx.tag.create({ data: tag });
  }
}

async function mergeFieldDefinitions(
  tx: Tx,
  snapshot: ParsedSnapshot,
  map: IdMap,
) {
  for (const definition of snapshot.fieldDefinitions) {
    const byId = await tx.fieldDefinition.findUnique({
      where: { id: definition.id },
    });
    if (byId) {
      await tx.fieldDefinition.update({
        where: { id: definition.id },
        data: {
          key: definition.key,
          label: definition.label,
          type: definition.type,
          options: definition.options,
          scope: definition.scope,
          order: definition.order,
        },
      });
      continue;
    }

    const byKey = await tx.fieldDefinition.findUnique({
      where: { key: definition.key },
    });
    if (byKey) {
      await tx.fieldDefinition.update({
        where: { id: byKey.id },
        data: {
          label: definition.label,
          type: definition.type,
          options: definition.options,
          scope: definition.scope,
          order: definition.order,
        },
      });
      map.set(definition.id, byKey.id);
      continue;
    }

    await tx.fieldDefinition.create({ data: definition });
  }
}

/** A conversation is identified by its id, a participant by its composite key. */
async function mergeConversations(
  tx: Tx,
  snapshot: ParsedSnapshot,
  counts: ImportCounts,
) {
  for (const conversation of snapshot.conversations ?? []) {
    const data = conversationScalars(conversation);

    await tx.conversation.upsert({
      where: { id: conversation.id },
      create: { id: conversation.id, ...data },
      update: data,
    });
    counts.conversations += 1;

    for (const row of participantRows(conversation)) {
      const { conversationId, senderName, ...rest } = row;

      await tx.conversationParticipant.upsert({
        where: { conversationId_senderName: { conversationId, senderName } },
        create: row,
        update: rest,
      });
      counts.conversationParticipants += 1;
    }
  }
}

/**
 * Messages arrive by the tens of thousands, so one upsert per row is not an
 * option: that is a round trip each, measured at about 9 seconds for 21k rows
 * against a database on this machine and linear in the size of the chat. The
 * same rows in batched INSERT ... ON CONFLICT statements take about half a
 * second. This is the only raw SQL in the importer, and it is here because
 * Prisma has no bulk upsert: createMany inserts but never updates.
 */
async function mergeMessages(
  tx: Tx,
  messages: readonly ParsedMessage[],
  messageChunk: number,
) {
  for (const batch of chunked(messages, messageChunk)) {
    const rows = batch.map(
      (message) =>
        Prisma.sql`(${message.id}, ${message.conversationId}, ${message.senderName}, ${message.personId}, ${message.sentAt}, ${message.body}, ${message.isFromSelf}, ${message.isSystem})`,
    );

    // Composed with Prisma.sql and passed as a finished statement. Written as
    // a tagged template directly on $executeRaw the row list comes out bound as
    // one parameter rather than spliced into the text, and Postgres rejects the
    // result as a syntax error.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "Message" ("id", "conversationId", "senderName", "personId", "sentAt", "body", "isFromSelf", "isSystem")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("id") DO UPDATE SET
        "conversationId" = EXCLUDED."conversationId",
        "senderName" = EXCLUDED."senderName",
        "personId" = EXCLUDED."personId",
        "sentAt" = EXCLUDED."sentAt",
        "body" = EXCLUDED."body",
        "isFromSelf" = EXCLUDED."isFromSelf",
        "isSystem" = EXCLUDED."isSystem"
    `);
  }
}

async function mergeAll(
  tx: Tx,
  snapshot: ParsedSnapshot,
  messageChunk: number,
): Promise<ImportCounts> {
  const counts = emptyCounts();
  const circleMap: IdMap = new Map();
  const tagMap: IdMap = new Map();
  const fieldMap: IdMap = new Map();

  await mergeCircles(tx, snapshot, circleMap);
  counts.circles = snapshot.circles.length;

  await mergeTags(tx, snapshot, tagMap);
  counts.tags = snapshot.tags.length;

  await mergeFieldDefinitions(tx, snapshot, fieldMap);
  counts.fieldDefinitions = snapshot.fieldDefinitions.length;

  for (const person of snapshot.people) {
    const circles = remapAll(circleMap, person.circleIds).map((id) => ({ id }));
    const interests = remapAll(tagMap, person.interestIds).map((id) => ({ id }));
    const allergies = remapAll(tagMap, person.allergyIds).map((id) => ({ id }));
    const dislikes = remapAll(tagMap, person.dislikeIds).map((id) => ({ id }));

    await tx.person.upsert({
      where: { id: person.id },
      create: {
        id: person.id,
        ...personScalars(person),
        circles: { connect: circles },
        interests: { connect: interests },
        allergies: { connect: allergies },
        dislikes: { connect: dislikes },
      },
      // set replaces the membership so a re-import never doubles anything up.
      update: {
        ...personScalars(person),
        circles: { set: circles },
        interests: { set: interests },
        allergies: { set: allergies },
        dislikes: { set: dislikes },
      },
    });

    await writeAvatar(tx, person.id, avatarIntent(person));
    counts.people += 1;

    for (const contact of person.contacts) {
      const data = { personId: person.id, ...contactScalars(contact) };

      await tx.contactChannel.upsert({
        where: { id: contact.id },
        create: { id: contact.id, ...data },
        update: data,
      });
      counts.contacts += 1;
    }

    for (const entry of person.customValues) {
      const fieldDefinitionId = remap(fieldMap, entry.fieldDefinitionId);
      const value = jsonOrNull(entry.value);

      await tx.customValue.upsert({
        where: {
          personId_fieldDefinitionId: { personId: person.id, fieldDefinitionId },
        },
        create: { id: entry.id, personId: person.id, fieldDefinitionId, value },
        update: { value },
      });
      counts.customValues += 1;
    }
  }

  // A person has at most one sketch, so personId is the identity, not the id.
  for (const profile of snapshot.personProfiles ?? []) {
    const data = profileScalars(profile);

    await tx.personProfile.upsert({
      where: { personId: profile.personId },
      create: { id: profile.id, personId: profile.personId, ...data },
      update: data,
    });
    counts.personProfiles += 1;
  }

  for (const favour of snapshot.favours ?? []) {
    const data = favourScalars(favour);

    await tx.favour.upsert({
      where: { id: favour.id },
      create: { id: favour.id, ...data },
      update: data,
    });
    counts.favours += 1;
  }

  counts.appSettingsIgnored = (snapshot.appSettings ?? []).length;

  await mergeConversations(tx, snapshot, counts);

  const messages = snapshot.messages ?? [];
  await mergeMessages(tx, messages, messageChunk);
  counts.messages = messages.length;

  for (const event of snapshot.events) {
    const data = {
      title: event.title,
      type: event.type,
      occurredAt: event.occurredAt,
      location: event.location,
      description: jsonOrNull(event.description),
      sentiment: event.sentiment,
      weight: event.weight,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };

    await tx.event.upsert({
      where: { id: event.id },
      create: { id: event.id, ...data },
      update: data,
    });
    counts.events += 1;

    for (const participant of event.participants) {
      const participantData = {
        role: participant.role,
        sentiment: participant.sentiment,
      };

      await tx.eventParticipant.upsert({
        where: {
          eventId_personId: {
            eventId: event.id,
            personId: participant.personId,
          },
        },
        create: {
          eventId: event.id,
          personId: participant.personId,
          ...participantData,
        },
        update: participantData,
      });
      counts.eventParticipants += 1;
    }
  }

  for (const note of snapshot.notes) {
    const tags = remapAll(tagMap, note.tagIds).map((id) => ({ id }));
    const data = {
      personId: note.personId,
      eventId: note.eventId,
      body: jsonInput(note.body),
      searchText: noteSearchText(note.body),
      occurredAt: note.occurredAt,
      pinned: note.pinned,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };

    await tx.note.upsert({
      where: { id: note.id },
      create: { id: note.id, ...data, tags: { connect: tags } },
      update: { ...data, tags: { set: tags } },
    });
    counts.notes += 1;
  }

  for (const link of snapshot.links) {
    const data = {
      tie: link.tie,
      manualScore: link.manualScore,
      pinned: link.pinned,
      notes: link.notes,
    };

    // The pair is the real identity of a link, the id is only a handle.
    const existing = await tx.link.findUnique({
      where: {
        aPersonId_bPersonId: {
          aPersonId: link.aPersonId,
          bPersonId: link.bPersonId,
        },
      },
    });

    let linkId = link.id;

    if (existing) {
      linkId = existing.id;
      await tx.link.update({ where: { id: existing.id }, data });
    } else {
      const idTaken = await tx.link.findUnique({ where: { id: link.id } });
      const created = await tx.link.create({
        data: {
          ...(idTaken ? {} : { id: link.id }),
          aPersonId: link.aPersonId,
          bPersonId: link.bPersonId,
          ...data,
        },
      });
      linkId = created.id;
    }

    counts.links += 1;

    if (link.stat) {
      const statData = {
        score: link.stat.score,
        eventCount: link.stat.eventCount,
        lastEventAt: link.stat.lastEventAt ?? null,
        positiveCount: link.stat.positiveCount,
        negativeCount: link.stat.negativeCount,
      };

      await tx.linkStat.upsert({
        where: { linkId },
        create: { linkId, ...statData },
        update: statData,
      });
    }
  }

  return counts;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * The whole import is one interactive transaction, so the timeout has to cover
 * the largest table in the file. Measured on a 21k message export: under a
 * second of database time either way round, well inside the 180s budget, and
 * batched it stays there as the chat corpus grows.
 */
const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 180_000 };

/**
 * Reads a snapshot back into the database. merge keeps whatever is already
 * there and lets the file win row by row, replace wipes first.
 */
export interface ImportOptions {
  /** Rows per batch. Defaults to the shipped messageChunk. */
  messageChunk?: number;
}

export async function importSnapshot(
  db: Silo,
  input: unknown,
  mode: ImportMode,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const snapshot = snapshotSchema.parse(input);
  const messageChunk = options.messageChunk ?? DEFAULT_MESSAGE_CHUNK;

  if (mode === "replace" && snapshot.people.length === 0) {
    throw new ImportError(
      "Refusing to replace everything with a file that holds no people.",
    );
  }

  const self = snapshot.people.find((person) => person.isSelf) ?? null;

  const counts = await db.$transaction(async (tx) => {
    let written: ImportCounts;

    if (mode === "replace") {
      await deleteEverything(tx, {
        chats: snapshot.conversations !== undefined,
      });
      written = await insertAll(tx, snapshot, messageChunk);
    } else {
      written = await mergeAll(tx, snapshot, messageChunk);
    }

    await enforceSingleSelf(tx, self ? self.id : null);
    return written;
  }, TRANSACTION_OPTIONS);

  return { mode, counts };
}
