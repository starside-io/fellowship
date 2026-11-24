import { z } from "zod";

// The allowed values live in enums.ts, which the CHECK constraints are
// generated from. Aliased to the name this module was written with.
import {
  ContactKind as contactKindSchema,
} from "./enums.js";
import { idSchema, optionalText, optionalUrl } from "./common.js";

export const contactChannelBaseSchema = z.object({
  kind: contactKindSchema,
  platform: optionalText,
  value: z.string().trim().min(1, "A value is required").max(320),
  url: optionalUrl,
  isPrimary: z.boolean().default(false),
  label: optionalText,
});

export const contactChannelCreateSchema = contactChannelBaseSchema.extend({
  personId: idSchema,
});

export const contactChannelUpdateSchema = contactChannelBaseSchema.partial();

export type ContactChannelCreateInput = z.input<typeof contactChannelCreateSchema>;
export type ContactChannelUpdateInput = z.input<typeof contactChannelUpdateSchema>;
