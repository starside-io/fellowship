import { z } from "zod";
import { hexColourSchema } from "./common.js";

export const circleBaseSchema = z.object({
  name: z.string().trim().min(1, "A name is required").max(80),
  colour: hexColourSchema.optional(),
});

export const circleCreateSchema = circleBaseSchema;

export const circleUpdateSchema = circleBaseSchema.partial();

export type CircleCreateInput = z.input<typeof circleCreateSchema>;
export type CircleUpdateInput = z.input<typeof circleUpdateSchema>;
