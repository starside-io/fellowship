import { z } from "zod";

import {
  dateTimeSchema,
  hexColourSchema,
  idSchema,
  jsonValueSchema,
  optionalDate,
  type JsonValue,
} from "../../schemas/common.js";
// The zod enums are the single source of truth for the allowed values, and the
// snapshot validates against the same ones the database is constrained to.
// Aliased to the names this module was written with.
import {
  AvatarSource as avatarSourceSchema,
  ChatSource as chatSourceSchema,
  ContactConfidence as contactConfidenceSchema,
  ContactKind as contactKindSchema,
  ContactSource as contactSourceSchema,
  EventType as eventTypeSchema,
  FavourDirection as favourDirectionSchema,
  FieldScope as fieldScopeSchema,
  FieldType as fieldTypeSchema,
  ProfileSource as profileSourceSchema,
  TagKind as tagKindSchema,
  TieType as tieTypeSchema,
} from "../../schemas/enums.js";

/**
 * Bumped whenever the snapshot shape stops being readable by the importer.
 *
 * Version 2 added the tables and columns version 1 quietly dropped: person
 * sketches, favours, app settings, contact channel provenance, and the stored
 * avatar picture. Version 3 added the chat imports: conversations, their
 * participants, and every message. Older files still import, and every later
 * addition stays absent rather than defaulting, so reading an old file never
 * writes a null over a column the file knew nothing about.
 */
export const SNAPSHOT_VERSION = 3;

export const SUPPORTED_SNAPSHOT_VERSIONS = [1, 2, 3] as const;

const optionalString = z.string().nullish().transform((value) => value ?? null);

/**
 * A value that may be null, or missing altogether. Absent survives as undefined
 * so the importer can tell "the file says there is nothing here" from "the file
 * does not cover this column", and only the first one writes a null.
 */
const absentableString = z.string().nullable().optional();

const jsonObjectSchema = z.record(jsonValueSchema);

/**
 * A rich text column, which is a Tiptap document.
 *
 * A string is accepted and wrapped in one paragraph. The live akai-ito data has
 * 20 event descriptions that are strings rather than documents, each one
 * starting with the literal "[object Object] ": somewhere a document was
 * concatenated into a string instead of being stored. The document behind
 * those rows is already gone and this importer cannot bring it back, but the
 * text that is there is real, and refusing the whole file over 20 rows would
 * lose the other 73,000 as well. So the text is kept, as a document, and the
 * round trip reports it as normalized rather than as unchanged.
 */
const tiptapColumnSchema = z.union([
  jsonObjectSchema,
  z
    .string()
    .transform((text) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          ...(text.trim().length > 0
            ? { content: [{ type: "text", text }] }
            : {}),
        },
      ],
    })),
]);

/**
 * Avatar pictures are capped at 5 MiB on the way in, so their base64 form is
 * capped at four characters per three bytes. Mirrored here rather than imported
 * because this module is read by a client component.
 */
export const MAX_AVATAR_BASE64_LENGTH = Math.ceil((5 * 1024 * 1024) / 3) * 4;

/**
 * A linear check rather than a grouped pattern: the input runs to megabytes,
 * and a repeated group over it is enough to exhaust the regex stack.
 */
function isBase64(value: string): boolean {
  if (value.length > MAX_AVATAR_BASE64_LENGTH) return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

const base64Schema = z
  .string()
  .max(MAX_AVATAR_BASE64_LENGTH, "That avatar picture is too large")
  .refine(isBase64, "Expected base64 encoded bytes");

/* ------------------------------------------------------------------ */
/* Export side: what buildExportSnapshot produces. Dates are strings so */
/* the object survives JSON.stringify without surprises.                */
/* ------------------------------------------------------------------ */

export type SnapshotCircle = {
  id: string;
  name: string;
  colour: string;
};

export type SnapshotTag = {
  id: string;
  kind: z.infer<typeof tagKindSchema>;
  name: string;
  colour: string;
};

export type SnapshotFieldDefinition = {
  id: string;
  key: string;
  label: string;
  type: z.infer<typeof fieldTypeSchema>;
  options: string[];
  scope: z.infer<typeof fieldScopeSchema>;
  order: number;
};

export type SnapshotContact = {
  id: string;
  kind: z.infer<typeof contactKindSchema>;
  platform: string | null;
  value: string;
  url: string | null;
  isPrimary: boolean;
  label: string | null;
  source: z.infer<typeof contactSourceSchema>;
  sourceUrl: string | null;
  confidence: z.infer<typeof contactConfidenceSchema> | null;
  verifiedAt: string | null;
};

export type SnapshotCustomValue = {
  id: string;
  fieldDefinitionId: string;
  value: JsonValue;
};

export type SnapshotPerson = {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  isSelf: boolean;
  avatarColor: string;
  /** The stored picture, base64 encoded. Null when the person has none. */
  avatarImage: string | null;
  avatarMime: string | null;
  avatarSource: z.infer<typeof avatarSourceSchema> | null;
  avatarSourceUrl: string | null;
  avatarFetchedAt: string | null;
  birthday: string | null;
  location: string | null;
  howWeMet: string | null;
  metOn: string | null;
  commStyle: string[];
  /** Absent in a file written before the personality migration. */
  mbti?: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  circleIds: string[];
  interestIds: string[];
  allergyIds: string[];
  dislikeIds: string[];
  contacts: SnapshotContact[];
  customValues: SnapshotCustomValue[];
};

export type SnapshotPersonProfile = {
  id: string;
  personId: string;
  summary: string | null;
  whatLands: string | null;
  whatToAvoid: string | null;
  opener: string | null;
  traits: JsonValue | null;
  personality?: JsonValue | null;
  personalityAt?: string | null;
  sources: string[];
  source: z.infer<typeof profileSourceSchema>;
  generatedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SnapshotFavour = {
  id: string;
  personId: string;
  direction: z.infer<typeof favourDirectionSchema>;
  description: string;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SnapshotAppSetting = {
  key: string;
  value: JsonValue;
  updatedAt: string;
};

export type SnapshotNote = {
  id: string;
  personId: string | null;
  eventId: string | null;
  body: Record<string, JsonValue>;
  occurredAt: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  tagIds: string[];
};

export type SnapshotEventParticipant = {
  personId: string;
  role: string | null;
  sentiment: number | null;
};

export type SnapshotEvent = {
  id: string;
  title: string;
  type: z.infer<typeof eventTypeSchema>;
  occurredAt: string;
  location: string | null;
  description: Record<string, JsonValue> | null;
  sentiment: number;
  weight: number;
  durationDays: number;
  createdAt: string;
  updatedAt: string;
  participants: SnapshotEventParticipant[];
};

export type SnapshotLinkStat = {
  score: number;
  eventCount: number;
  lastEventAt: string | null;
  positiveCount: number;
  negativeCount: number;
};

export type SnapshotLink = {
  id: string;
  aPersonId: string;
  bPersonId: string;
  tie: z.infer<typeof tieTypeSchema>;
  manualScore: number | null;
  pinned: boolean;
  notes: string | null;
  stat: SnapshotLinkStat | null;
};

/**
 * A sender in an export. Nested inside its conversation, which supplies the
 * other half of the composite key, the way an event participant is nested and
 * takes its event id from the parent.
 */
export type SnapshotConversationParticipant = {
  senderName: string;
  personId: string | null;
  isSelf: boolean;
  messageCount: number;
};

export type SnapshotConversation = {
  id: string;
  source: z.infer<typeof chatSourceSchema>;
  title: string | null;
  isGroup: boolean;
  fileName: string | null;
  importedAt: string;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  participants: SnapshotConversationParticipant[];
};

/**
 * Messages stay a flat top level collection rather than nesting under their
 * conversation. A real import runs to tens of thousands of rows, and a flat
 * list is what both the chunked bulk insert and the bulk upsert consume.
 */
export type SnapshotMessage = {
  id: string;
  conversationId: string;
  senderName: string;
  personId: string | null;
  sentAt: string;
  body: string;
  isFromSelf: boolean;
  isSystem: boolean;
};

export type ExportSnapshot = {
  version: number;
  exportedAt: string;
  people: SnapshotPerson[];
  tags: SnapshotTag[];
  circles: SnapshotCircle[];
  fieldDefinitions: SnapshotFieldDefinition[];
  notes: SnapshotNote[];
  events: SnapshotEvent[];
  links: SnapshotLink[];
  personProfiles: SnapshotPersonProfile[];
  favours: SnapshotFavour[];
  appSettings: SnapshotAppSetting[];
  conversations: SnapshotConversation[];
  messages: SnapshotMessage[];
};

/* ------------------------------------------------------------------ */
/* Import side: the same shape, validated, with dates back as Dates.    */
/* ------------------------------------------------------------------ */

const circleSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  colour: hexColourSchema,
});

const tagSchema = z.object({
  id: idSchema,
  kind: tagKindSchema,
  name: z.string().trim().min(1).max(80),
  colour: hexColourSchema,
});

const fieldDefinitionSchema = z.object({
  id: idSchema,
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  type: fieldTypeSchema,
  options: z.array(z.string()).default([]),
  scope: fieldScopeSchema,
  order: z.number().int().default(0),
});

const contactSchema = z.object({
  id: idSchema,
  kind: contactKindSchema,
  platform: optionalString,
  value: z.string().min(1).max(320),
  url: optionalString,
  isPrimary: z.boolean().default(false),
  label: optionalString,
  // Version 2. Absent in a version 1 file, and left alone on the way in.
  source: contactSourceSchema.optional(),
  sourceUrl: absentableString,
  confidence: contactConfidenceSchema.nullable().optional(),
  verifiedAt: optionalDate,
});

const customValueSchema = z.object({
  id: idSchema,
  fieldDefinitionId: idSchema,
  value: jsonValueSchema,
});

const personSchema = z.object({
  id: idSchema,
  displayName: z.string().trim().min(1).max(120),
  firstName: optionalString,
  lastName: optionalString,
  isSelf: z.boolean().default(false),
  avatarColor: hexColourSchema,
  // Version 2. Absent in a version 1 file, and left alone on the way in.
  avatarImage: base64Schema.nullable().optional(),
  avatarMime: absentableString,
  avatarSource: avatarSourceSchema.nullable().optional(),
  avatarSourceUrl: absentableString,
  avatarFetchedAt: optionalDate,
  birthday: optionalDate,
  location: optionalString,
  howWeMet: optionalString,
  metOn: optionalDate,
  commStyle: z.array(z.string()).default([]),
  // Absent before the personality migration, and left alone on the way in.
  mbti: z.string().trim().max(10).nullable().optional(),
  archived: z.boolean().default(false),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  circleIds: z.array(idSchema).default([]),
  interestIds: z.array(idSchema).default([]),
  allergyIds: z.array(idSchema).default([]),
  dislikeIds: z.array(idSchema).default([]),
  contacts: z.array(contactSchema).default([]),
  customValues: z.array(customValueSchema).default([]),
});

const personProfileSchema = z.object({
  id: idSchema,
  personId: idSchema,
  summary: optionalString,
  whatLands: optionalString,
  whatToAvoid: optionalString,
  opener: optionalString,
  traits: jsonValueSchema.nullish().transform((value) => value ?? null),
  personality: jsonValueSchema.nullable().optional(),
  personalityAt: optionalDate,
  sources: z.array(z.string()).default([]),
  source: profileSourceSchema.default("MANUAL"),
  generatedAt: optionalDate,
  confirmedAt: optionalDate,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

const favourSchema = z.object({
  id: idSchema,
  personId: idSchema,
  direction: favourDirectionSchema,
  description: z.string().trim().min(1).max(280),
  settledAt: optionalDate,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

const appSettingSchema = z.object({
  key: z.string().trim().min(1).max(200),
  value: jsonValueSchema,
  updatedAt: dateTimeSchema.optional(),
});

const noteSchema = z.object({
  id: idSchema,
  personId: idSchema.nullish().transform((value) => value ?? null),
  eventId: idSchema.nullish().transform((value) => value ?? null),
  body: tiptapColumnSchema,
  occurredAt: dateTimeSchema,
  pinned: z.boolean().default(false),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  tagIds: z.array(idSchema).default([]),
});

const eventParticipantSchema = z.object({
  personId: idSchema,
  role: optionalString,
  sentiment: z.number().int().nullish().transform((value) => value ?? null),
});

const eventSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  type: eventTypeSchema,
  occurredAt: dateTimeSchema,
  location: optionalString,
  description: tiptapColumnSchema.nullish().transform((value) => value ?? null),
  sentiment: z.number().int().default(0),
  weight: z.number().int().default(1),
  /** Snapshots written before durations existed hold one day per occasion. */
  durationDays: z.number().int().min(1).max(365).default(1),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  participants: z.array(eventParticipantSchema).default([]),
});

/**
 * Sender names are the other half of a participant's primary key and the join
 * back to a message, so they travel exactly as stored. No trim, no case fold,
 * and no floor: the system notices a chat export carries (joins, leaves, the
 * encryption banner) have no sender at all and sit in the table as an empty
 * string. A snapshot that refused those could not read the app's own backup.
 */
const senderNameSchema = z.string().max(200);

/** Far past any real chat line, and short of anything that stalls the parse. */
const MAX_MESSAGE_BODY_LENGTH = 100_000;

const conversationParticipantSchema = z.object({
  senderName: senderNameSchema,
  personId: idSchema.nullish().transform((value) => value ?? null),
  isSelf: z.boolean().default(false),
  messageCount: z.number().int().default(0),
});

const conversationSchema = z.object({
  id: idSchema,
  source: chatSourceSchema.default("WHATSAPP"),
  title: optionalString,
  isGroup: z.boolean().default(false),
  fileName: optionalString,
  importedAt: dateTimeSchema,
  firstMessageAt: optionalDate,
  lastMessageAt: optionalDate,
  messageCount: z.number().int().default(0),
  participants: z.array(conversationParticipantSchema).default([]),
});

const messageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  senderName: senderNameSchema,
  personId: idSchema.nullish().transform((value) => value ?? null),
  sentAt: dateTimeSchema,
  // Empty bodies exist, so the floor is zero rather than one.
  body: z.string().max(MAX_MESSAGE_BODY_LENGTH),
  isFromSelf: z.boolean().default(false),
  isSystem: z.boolean().default(false),
});

const linkStatSchema = z.object({
  score: z.number().default(0),
  eventCount: z.number().int().default(0),
  lastEventAt: optionalDate,
  positiveCount: z.number().int().default(0),
  negativeCount: z.number().int().default(0),
});

const linkSchema = z.object({
  id: idSchema,
  aPersonId: idSchema,
  bPersonId: idSchema,
  tie: tieTypeSchema,
  manualScore: z.number().nullish().transform((value) => value ?? null),
  pinned: z.boolean().default(false),
  notes: optionalString,
  stat: linkStatSchema.nullish().transform((value) => value ?? null),
});

export const snapshotSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    exportedAt: z.string().optional(),
    people: z.array(personSchema).default([]),
    tags: z.array(tagSchema).default([]),
    circles: z.array(circleSchema).default([]),
    fieldDefinitions: z.array(fieldDefinitionSchema).default([]),
    notes: z.array(noteSchema).default([]),
    events: z.array(eventSchema).default([]),
    links: z.array(linkSchema).default([]),
    // Version 2 collections. No default: a version 1 file leaves them
    // undefined, which reads as "this file has nothing to say about them"
    // rather than as an empty table.
    personProfiles: z.array(personProfileSchema).optional(),
    favours: z.array(favourSchema).optional(),
    appSettings: z.array(appSettingSchema).optional(),
    // Version 3 collections, absent in anything older for the same reason.
    conversations: z.array(conversationSchema).optional(),
    messages: z.array(messageSchema).optional(),
  })
  .superRefine((value, ctx) => {
    const selves = value.people.filter((person) => person.isSelf);
    if (selves.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["people"],
        message: "The snapshot marks more than one person as self",
      });
    }

    const keys = new Set<string>();
    for (const [index, setting] of (value.appSettings ?? []).entries()) {
      if (keys.has(setting.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appSettings", index, "key"],
          message: `Duplicate setting key "${setting.key}"`,
        });
      }
      keys.add(setting.key);
    }

    const profilePeople = new Set<string>();
    for (const [index, profile] of (value.personProfiles ?? []).entries()) {
      if (profilePeople.has(profile.personId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["personProfiles", index, "personId"],
          message: "Two sketches point at the same person",
        });
      }
      profilePeople.add(profile.personId);
    }

    const conversationIds = new Set<string>();
    for (const [index, conversation] of (value.conversations ?? []).entries()) {
      if (conversationIds.has(conversation.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conversations", index, "id"],
          message: "Two conversations share an id",
        });
      }
      conversationIds.add(conversation.id);

      const senders = new Set<string>();
      for (const [at, participant] of conversation.participants.entries()) {
        if (senders.has(participant.senderName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["conversations", index, "participants", at, "senderName"],
            message: `Duplicate sender "${participant.senderName}" in one conversation`,
          });
        }
        senders.add(participant.senderName);
      }
    }

    if (value.messages !== undefined && value.conversations === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conversations"],
        message: "The file carries messages but no conversations to hang them on",
      });
    }

    // One pass over what can be tens of thousands of rows, so both checks
    // share it rather than walking the list twice.
    const messageIds = new Set<string>();
    for (const [index, message] of (value.messages ?? []).entries()) {
      if (messageIds.has(message.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messages", index, "id"],
          message: "Two messages share an id",
        });
      }
      messageIds.add(message.id);

      if (
        value.conversations !== undefined &&
        !conversationIds.has(message.conversationId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messages", index, "conversationId"],
          message: "A message points at a conversation the file does not carry",
        });
      }
    }
  });

export type ParsedSnapshot = z.infer<typeof snapshotSchema>;
export type ParsedPerson = ParsedSnapshot["people"][number];
export type ParsedContact = ParsedPerson["contacts"][number];

/* ------------------------------------------------------------------ */
/* Client side dry read: counts without validating every field.         */
/* ------------------------------------------------------------------ */

export type SnapshotSummary = {
  version: number;
  exportedAt: string | null;
  people: number;
  circles: number;
  tags: number;
  fieldDefinitions: number;
  notes: number;
  events: number;
  links: number;
  /** Null when the file's version does not cover them at all. */
  personProfiles: number | null;
  favours: number | null;
  appSettings: number | null;
  avatars: number | null;
  conversations: number | null;
  messages: number | null;
};

function countOf(value: unknown, key: string): number {
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list) ? list.length : 0;
}

function countOrNull(value: Record<string, unknown>, key: string): number | null {
  const list = value[key];
  return Array.isArray(list) ? list.length : null;
}

/** People carry their picture inline, so the count comes from the person rows. */
function countAvatars(value: Record<string, unknown>): number | null {
  const people = value.people;
  if (!Array.isArray(people)) return null;

  let seen = false;
  let stored = 0;
  for (const person of people) {
    if (!person || typeof person !== "object") continue;
    if (!("avatarImage" in person)) continue;
    seen = true;
    const image = (person as { avatarImage?: unknown }).avatarImage;
    if (typeof image === "string" && image.length > 0) stored += 1;
  }

  return seen ? stored : null;
}

function isSupportedVersion(value: unknown): value is 1 | 2 | 3 {
  return SUPPORTED_SNAPSHOT_VERSIONS.some((version) => version === value);
}

/**
 * Cheap read of a parsed JSON file, used by the import form to describe a file
 * before anything is sent. Returns null when it is not a snapshot this build
 * knows how to read.
 */
export function summariseSnapshot(value: unknown): SnapshotSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (!isSupportedVersion(record.version)) return null;

  return {
    version: record.version,
    exportedAt:
      typeof record.exportedAt === "string" ? record.exportedAt : null,
    people: countOf(record, "people"),
    circles: countOf(record, "circles"),
    tags: countOf(record, "tags"),
    fieldDefinitions: countOf(record, "fieldDefinitions"),
    notes: countOf(record, "notes"),
    events: countOf(record, "events"),
    links: countOf(record, "links"),
    personProfiles: countOrNull(record, "personProfiles"),
    favours: countOrNull(record, "favours"),
    appSettings: countOrNull(record, "appSettings"),
    avatars: countAvatars(record),
    conversations: countOrNull(record, "conversations"),
    messages: countOrNull(record, "messages"),
  };
}
