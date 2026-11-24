import { z } from "zod";

// The allowed values live in enums.ts, which the CHECK constraints are
// generated from. Aliased to the name this module was written with.
import {
  ChatSource as chatSourceSchema,
} from "./enums.js";
import { idSchema, optionalDate, optionalText } from "./common.js";

/** Exports get large, so the ceiling is generous rather than absent. */
const MAX_EXPORT_CHARS = 20_000_000;

export const senderNameSchema = z
  .string()
  .trim()
  .min(1, "A sender name is required")
  .max(200);

export const importChatSchema = z.object({
  text: z
    .string()
    .min(1, "Expected the exported chat text")
    .max(MAX_EXPORT_CHARS, "That export is too large to import"),
  fileName: optionalText,
  source: chatSourceSchema.default("WHATSAPP"),
  /** The name the owner appears under in the export, when it is not obvious. */
  selfName: optionalText,
  /** Forces the date order when the export is ambiguous. */
  dayFirst: z.boolean().optional(),
  /** Sender name to person id. Senders left out stay unmapped. */
  personIdBySender: z.record(senderNameSchema, idSchema).optional(),
});

export const mapSenderSchema = z.object({
  senderName: senderNameSchema,
  personId: idSchema,
});

const MAX_PAGE = 500;
const DEFAULT_PAGE = 50;

/** Accepts numbers or the numeric strings a query string hands back. */
const pageSize = z
  .union([z.number(), z.string()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return DEFAULT_PAGE;
    const parsed = typeof value === "number" ? value : Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a whole number of rows, at least 1",
      });
      return z.NEVER;
    }
    return Math.min(parsed, MAX_PAGE);
  });

const offsetValue = z
  .union([z.number(), z.string()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return 0;
    const parsed = typeof value === "number" ? value : Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a whole number of rows to skip",
      });
      return z.NEVER;
    }
    return parsed;
  });

export const conversationPageSchema = z
  .object({ limit: pageSize, offset: offsetValue })
  .default({});

export const personMessagesSchema = z
  .object({
    from: optionalDate,
    to: optionalDate,
    limit: pageSize,
    offset: offsetValue,
    conversationId: idSchema.optional(),
  })
  .default({});

export type ImportChatInput = z.input<typeof importChatSchema>;
export type MapSenderInput = z.input<typeof mapSenderSchema>;
export type ConversationPageParams = z.input<typeof conversationPageSchema>;
export type PersonMessagesParams = z.input<typeof personMessagesSchema>;
