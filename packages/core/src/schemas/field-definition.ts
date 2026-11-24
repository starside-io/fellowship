import { z } from "zod";

// The allowed values live in enums.ts, which the CHECK constraints are
// generated from. Aliased to the name this module was written with.
import {
  FieldScope as fieldScopeSchema,
  FieldType as fieldTypeSchema,
} from "./enums.js";
import { idSchema, slugify } from "./common.js";

export const fieldDefinitionBaseSchema = z.object({
  key: z.string().trim().min(1).max(80).optional(),
  label: z.string().trim().min(1, "A label is required").max(120),
  type: fieldTypeSchema,
  options: z.array(z.string().trim().min(1)).default([]),
  scope: fieldScopeSchema.default("CUSTOM"),
  order: z.number().int().min(0).default(0),
});

export const fieldDefinitionCreateSchema = fieldDefinitionBaseSchema
  .superRefine((value, ctx) => {
    if (value.type === "SELECT" && value.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Select fields need at least one option",
      });
    }
  })
  .transform((value) => ({
    ...value,
    key: slugify(value.key ?? value.label),
  }));

export const fieldDefinitionUpdateSchema = fieldDefinitionBaseSchema
  .partial()
  .transform((value) => ({
    ...value,
    key: value.key ? slugify(value.key) : undefined,
  }));

export const reorderFieldDefinitionsSchema = z.array(idSchema).min(1);

export type FieldDefinitionCreateInput = z.input<typeof fieldDefinitionCreateSchema>;
export type FieldDefinitionUpdateInput = z.input<typeof fieldDefinitionUpdateSchema>;
