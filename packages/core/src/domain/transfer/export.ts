import type { z } from "zod";

import type { JsonValue } from "../../schemas/common.js";
import {
  AvatarSource,
  ChatSource,
  ContactConfidence,
  ContactKind,
  ContactSource,
  EventType,
  FavourDirection,
  FieldScope,
  FieldType,
  ProfileSource,
  TagKind,
  TieType,
} from "../../schemas/enums.js";
import type { Silo } from "../../storage/client.js";
import { encodeBytes } from "./bytes.js";
import { SNAPSHOT_VERSION, type ExportSnapshot } from "./snapshot.js";

/**
 * An enum column on the way out. SQLite hands these back as plain strings, so
 * they are checked against the zod enum rather than trusted: the CHECK
 * constraints should make a bad value impossible, and a snapshot is the worst
 * place to find out they did not.
 */
function enumValue<T extends string>(
  schema: z.ZodEnum<[T, ...T[]]>,
  value: string,
  column: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${column} holds "${value}", which is not one of its allowed values`);
  }
  return parsed.data;
}

function enumOrNull<T extends string>(
  schema: z.ZodEnum<[T, ...T[]]>,
  value: string | null | undefined,
  column: string,
): T | null {
  return value === null || value === undefined ? null : enumValue(schema, value, column);
}

/** A Json column holding a string array. Empty when the row predates it. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Date only columns are exported as YYYY-MM-DD, timestamps as full ISO. */
function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function timestamp(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function asJsonObject(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

/**
 * The whole database as one JSON object. Ids are preserved so a snapshot can
 * be imported back over the same database without duplicating anything.
 *
 * Avatar pictures travel inline as base64, which is about a third larger than
 * the stored bytes. A collection with pictures makes for a heavy file, and so
 * does a chat import: every message is in here, one row per line.
 */
export async function buildExportSnapshot(db: Silo): Promise<ExportSnapshot> {
  const [
    people,
    tags,
    circles,
    fieldDefinitions,
    notes,
    events,
    links,
    personProfiles,
    favours,
    conversations,
    messages,
  ] = await Promise.all([
    db.person.findMany({
      orderBy: { displayName: "asc" },
      include: {
        circles: { select: { id: true } },
        interests: { select: { id: true } },
        allergies: { select: { id: true } },
        dislikes: { select: { id: true } },
        contacts: { orderBy: { value: "asc" } },
        customValues: { orderBy: { fieldDefinitionId: "asc" } },
        avatar: true,
      },
    }),
    db.tag.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] }),
    db.circle.findMany({ orderBy: { name: "asc" } }),
    db.fieldDefinition.findMany({ orderBy: { order: "asc" } }),
    db.note.findMany({
      orderBy: { occurredAt: "asc" },
      include: { tags: { select: { id: true } } },
    }),
    db.event.findMany({
      orderBy: { occurredAt: "asc" },
      include: { participants: true },
    }),
    db.link.findMany({
      orderBy: [{ aPersonId: "asc" }, { bPersonId: "asc" }],
      include: { stat: true },
    }),
    db.personProfile.findMany({ orderBy: { personId: "asc" } }),
    db.favour.findMany({
      orderBy: [{ personId: "asc" }, { createdAt: "asc" }],
    }),
    db.conversation.findMany({
      orderBy: { importedAt: "asc" },
      include: { participants: { orderBy: { senderName: "asc" } } },
    }),
    db.message.findMany({
      orderBy: [{ conversationId: "asc" }, { sentAt: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    people: people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      firstName: person.firstName,
      lastName: person.lastName,
      isSelf: person.isSelf,
      avatarColor: person.avatarColor,
      // Flattened back onto the person, which is the shape the snapshot has
      // carried since version 2. PersonAvatar is a storage detail of this
      // silo, not a change to the file format.
      avatarImage: person.avatar ? encodeBytes(person.avatar.image) : null,
      avatarMime: person.avatar?.mime ?? null,
      avatarSource: enumOrNull(AvatarSource, person.avatar?.source, "PersonAvatar.source"),
      avatarSourceUrl: person.avatar?.sourceUrl ?? null,
      avatarFetchedAt: timestamp(person.avatar?.fetchedAt ?? null),
      birthday: dateOnly(person.birthday),
      location: person.location,
      howWeMet: person.howWeMet,
      metOn: dateOnly(person.metOn),
      commStyle: asStringArray(person.commStyle),
      mbti: person.mbti,
      archived: person.archived,
      createdAt: person.createdAt.toISOString(),
      updatedAt: person.updatedAt.toISOString(),
      circleIds: person.circles.map((circle) => circle.id),
      interestIds: person.interests.map((tag) => tag.id),
      allergyIds: person.allergies.map((tag) => tag.id),
      dislikeIds: person.dislikes.map((tag) => tag.id),
      contacts: person.contacts.map((contact) => ({
        id: contact.id,
        kind: enumValue(ContactKind, contact.kind, "ContactChannel.kind"),
        platform: contact.platform,
        value: contact.value,
        url: contact.url,
        isPrimary: contact.isPrimary,
        label: contact.label,
        source: enumValue(ContactSource, contact.source, "ContactChannel.source"),
        sourceUrl: contact.sourceUrl,
        confidence: enumOrNull(ContactConfidence, contact.confidence, "ContactChannel.confidence"),
        verifiedAt: timestamp(contact.verifiedAt),
      })),
      customValues: person.customValues.map((entry) => ({
        id: entry.id,
        fieldDefinitionId: entry.fieldDefinitionId,
        value: asJson(entry.value),
      })),
    })),
    tags: tags.map((tag) => ({
      id: tag.id,
      kind: enumValue(TagKind, tag.kind, "Tag.kind"),
      name: tag.name,
      colour: tag.colour,
    })),
    circles: circles.map((circle) => ({
      id: circle.id,
      name: circle.name,
      colour: circle.colour,
    })),
    fieldDefinitions: fieldDefinitions.map((definition) => ({
      id: definition.id,
      key: definition.key,
      label: definition.label,
      type: enumValue(FieldType, definition.type, "FieldDefinition.type"),
      options: asStringArray(definition.options),
      scope: enumValue(FieldScope, definition.scope, "FieldDefinition.scope"),
      order: definition.order,
    })),
    notes: notes.map((note) => ({
      id: note.id,
      personId: note.personId,
      eventId: note.eventId,
      body: asJsonObject(note.body),
      occurredAt: note.occurredAt.toISOString(),
      pinned: note.pinned,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
      tagIds: note.tags.map((tag) => tag.id),
    })),
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      type: enumValue(EventType, event.type, "Event.type"),
      occurredAt: event.occurredAt.toISOString(),
      location: event.location,
      description: event.description ? asJsonObject(event.description) : null,
      sentiment: event.sentiment,
      weight: event.weight,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
      participants: event.participants.map((participant) => ({
        personId: participant.personId,
        role: participant.role,
        sentiment: participant.sentiment,
      })),
    })),
    links: links.map((link) => ({
      id: link.id,
      aPersonId: link.aPersonId,
      bPersonId: link.bPersonId,
      tie: enumValue(TieType, link.tie, "Link.tie"),
      manualScore: link.manualScore,
      pinned: link.pinned,
      notes: link.notes,
      stat: link.stat
        ? {
            score: link.stat.score,
            eventCount: link.stat.eventCount,
            lastEventAt: timestamp(link.stat.lastEventAt),
            positiveCount: link.stat.positiveCount,
            negativeCount: link.stat.negativeCount,
          }
        : null,
    })),
    personProfiles: personProfiles.map((profile) => ({
      id: profile.id,
      personId: profile.personId,
      summary: profile.summary,
      whatLands: profile.whatLands,
      whatToAvoid: profile.whatToAvoid,
      opener: profile.opener,
      traits: profile.traits === null ? null : asJson(profile.traits),
      personality: profile.personality === null ? null : asJson(profile.personality),
      personalityAt: timestamp(profile.personalityAt),
      sources: asStringArray(profile.sources),
      source: enumValue(ProfileSource, profile.source, "PersonProfile.source"),
      generatedAt: timestamp(profile.generatedAt),
      confirmedAt: timestamp(profile.confirmedAt),
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    })),
    favours: favours.map((favour) => ({
      id: favour.id,
      personId: favour.personId,
      direction: enumValue(FavourDirection, favour.direction, "Favour.direction"),
      description: favour.description,
      settledAt: timestamp(favour.settledAt),
      createdAt: favour.createdAt.toISOString(),
      updatedAt: favour.updatedAt.toISOString(),
    })),
    // Always empty. The silo has no settings table: the avatar resolver list
    // is module config, held by the host behind the settings port. The key
    // stays in the file so an older reader still parses it.
    appSettings: [],
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      source: enumValue(ChatSource, conversation.source, "Conversation.source"),
      title: conversation.title,
      isGroup: conversation.isGroup,
      fileName: conversation.fileName,
      importedAt: conversation.importedAt.toISOString(),
      firstMessageAt: timestamp(conversation.firstMessageAt),
      lastMessageAt: timestamp(conversation.lastMessageAt),
      messageCount: conversation.messageCount,
      participants: conversation.participants.map((participant) => ({
        senderName: participant.senderName,
        personId: participant.personId,
        isSelf: participant.isSelf,
        messageCount: participant.messageCount,
      })),
    })),
    messages: messages.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      senderName: message.senderName,
      personId: message.personId,
      sentAt: message.sentAt.toISOString(),
      body: message.body,
      isFromSelf: message.isFromSelf,
      isSystem: message.isSystem,
    })),
  };
}

const CSV_COLUMNS = [
  "displayName",
  "firstName",
  "lastName",
  "location",
  "birthday",
  "circles",
  "interests",
  "allergies",
  "dislikes",
  "primaryContact",
  "howWeMet",
] as const;

/** RFC 4180 quoting: wrap when needed, double up embedded quotes. */
function csvCell(value: string | null): string {
  const text = value ?? "";
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvRow(cells: Array<string | null>): string {
  return cells.map(csvCell).join(",");
}

/** A flat, spreadsheet friendly view of the people. Not a backup format. */
export async function buildPeopleCsv(db: Silo): Promise<string> {
  const people = await db.person.findMany({
    orderBy: { displayName: "asc" },
    include: {
      circles: { select: { name: true }, orderBy: { name: "asc" } },
      interests: { select: { name: true }, orderBy: { name: "asc" } },
      allergies: { select: { name: true }, orderBy: { name: "asc" } },
      dislikes: { select: { name: true }, orderBy: { name: "asc" } },
      contacts: { orderBy: [{ isPrimary: "desc" }, { value: "asc" }] },
    },
  });

  const rows = people.map((person) => {
    const primary =
      person.contacts.find((contact) => contact.isPrimary) ??
      person.contacts[0] ??
      null;

    return csvRow([
      person.displayName,
      person.firstName,
      person.lastName,
      person.location,
      dateOnly(person.birthday),
      person.circles.map((circle) => circle.name).join(";"),
      person.interests.map((tag) => tag.name).join(";"),
      person.allergies.map((tag) => tag.name).join(";"),
      person.dislikes.map((tag) => tag.name).join(";"),
      primary ? primary.value : "",
      person.howWeMet,
    ]);
  });

  return `${[csvRow([...CSV_COLUMNS]), ...rows].join("\r\n")}\r\n`;
}

/** Local calendar date, used to name the downloaded files. */
export function fileStamp(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
