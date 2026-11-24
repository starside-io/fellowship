import { z } from "zod";

// The allowed values live in enums.ts, which the CHECK constraints are
// generated from. Aliased to the name this module was written with.
import {
  FavourDirection as favourDirectionSchema,
} from "./enums.js";
import { idSchema } from "./common.js";

export const favourDescriptionSchema = z
  .string()
  .trim()
  .min(1, "A description is required")
  .max(280);

export const favourCreateSchema = z.object({
  personId: idSchema,
  direction: favourDirectionSchema,
  description: favourDescriptionSchema,
});

export const favourUpdateSchema = z.object({
  description: favourDescriptionSchema.optional(),
  direction: favourDirectionSchema.optional(),
  settled: z.boolean().optional(),
});

export type FavourCreateInput = z.input<typeof favourCreateSchema>;
export type FavourUpdateInput = z.input<typeof favourUpdateSchema>;
