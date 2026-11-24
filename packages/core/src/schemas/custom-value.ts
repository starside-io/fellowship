import { z } from "zod";
import { idSchema, jsonValueSchema } from "./common.js";

export const customValueUpsertSchema = z.object({
  personId: idSchema,
  fieldDefinitionId: idSchema,
  value: jsonValueSchema,
});

export const customValueDeleteSchema = z.object({
  personId: idSchema,
  fieldDefinitionId: idSchema,
});

export type CustomValueUpsertInput = z.input<typeof customValueUpsertSchema>;
export type CustomValueDeleteInput = z.input<typeof customValueDeleteSchema>;
