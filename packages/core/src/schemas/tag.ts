import { z } from "zod";

// The allowed values live in enums.ts, which the CHECK constraints are
// generated from. Aliased to the name this module was written with.
import {
  TagKind as tagKindSchema,
} from "./enums.js";
import { hexColourSchema } from "./common.js";

export const tagBaseSchema = z.object({
  kind: tagKindSchema,
  name: z.string().trim().min(1, "A name is required").max(80),
  colour: hexColourSchema.optional(),
});

export const tagCreateSchema = tagBaseSchema;

export const tagUpdateSchema = tagBaseSchema.partial();

export type TagCreateInput = z.input<typeof tagCreateSchema>;
export type TagUpdateInput = z.input<typeof tagUpdateSchema>;
