import { z } from "zod";

/**
 * SQLite has no enum type and Prisma does not model one for it, so every column
 * that was a Postgres enum in the reference implementation is a String here.
 * These zod enums are the single source of truth for the allowed values: they
 * validate every tool input, they generate the TypeScript unions below, and
 * `ENUM_COLUMNS` drives the CHECK constraints in the migration so the database
 * refuses a bad value even when a write bypasses zod.
 */

export const ContactKind = z.enum(["EMAIL", "PHONE", "SOCIAL", "OTHER"]);
export type ContactKind = z.infer<typeof ContactKind>;

export const ContactSource = z.enum(["MANUAL", "IMPORT", "ASSISTANT"]);
export type ContactSource = z.infer<typeof ContactSource>;

export const ContactConfidence = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type ContactConfidence = z.infer<typeof ContactConfidence>;

export const TagKind = z.enum(["INTEREST", "ALLERGY", "DISLIKE"]);
export type TagKind = z.infer<typeof TagKind>;

export const FieldType = z.enum([
  "TEXT",
  "LONGTEXT",
  "DATE",
  "NUMBER",
  "URL",
  "TAGS",
  "SELECT",
  "BOOLEAN",
]);
export type FieldType = z.infer<typeof FieldType>;

export const FieldScope = z.enum(["STANDARD", "CUSTOM"]);
export type FieldScope = z.infer<typeof FieldScope>;

export const EventType = z.enum([
  "HANGOUT",
  "MEAL",
  "CALL",
  "TRIP",
  "PARTY",
  "WORK",
  "FAVOUR",
  "CONFLICT",
  "MILESTONE",
  "OTHER",
]);
export type EventType = z.infer<typeof EventType>;

export const TieType = z.enum([
  "FRIEND",
  "CLOSE_FRIEND",
  "PARTNER",
  "FAMILY",
  "COLLEAGUE",
  "ACQUAINTANCE",
  "KNOWS_OF",
  "ESTRANGED",
]);
export type TieType = z.infer<typeof TieType>;

export const ChatSource = z.enum(["WHATSAPP", "OTHER"]);
export type ChatSource = z.infer<typeof ChatSource>;

export const AvatarSource = z.enum(["MANUAL", "RESOLVER", "ASSISTANT"]);
export type AvatarSource = z.infer<typeof AvatarSource>;

export const ProfileSource = z.enum(["MANUAL", "ASSISTANT"]);
export type ProfileSource = z.infer<typeof ProfileSource>;

export const FavourDirection = z.enum(["THEY_OWE_ME", "I_OWE_THEM"]);
export type FavourDirection = z.infer<typeof FavourDirection>;

/** Every string column that carries an enumerated value, by table and column. */
export const ENUM_COLUMNS = [
  { table: "ContactChannel", column: "kind", values: ContactKind.options, nullable: false },
  { table: "ContactChannel", column: "source", values: ContactSource.options, nullable: false },
  {
    table: "ContactChannel",
    column: "confidence",
    values: ContactConfidence.options,
    nullable: true,
  },
  { table: "Tag", column: "kind", values: TagKind.options, nullable: false },
  { table: "FieldDefinition", column: "type", values: FieldType.options, nullable: false },
  { table: "FieldDefinition", column: "scope", values: FieldScope.options, nullable: false },
  { table: "Event", column: "type", values: EventType.options, nullable: false },
  { table: "Link", column: "tie", values: TieType.options, nullable: false },
  { table: "Conversation", column: "source", values: ChatSource.options, nullable: false },
  { table: "PersonAvatar", column: "source", values: AvatarSource.options, nullable: false },
  { table: "PersonProfile", column: "source", values: ProfileSource.options, nullable: false },
  { table: "Favour", column: "direction", values: FavourDirection.options, nullable: false },
] as const satisfies ReadonlyArray<{
  table: string;
  column: string;
  values: readonly string[];
  nullable: boolean;
}>;

/** The SQL fragment a CHECK constraint on one enum column needs. */
export function enumCheckSql(entry: (typeof ENUM_COLUMNS)[number]): string {
  const list = entry.values.map((value) => `'${value}'`).join(", ");
  const inList = `"${entry.column}" IN (${list})`;
  return entry.nullable ? `"${entry.column}" IS NULL OR ${inList}` : inList;
}
