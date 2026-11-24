import { z } from "zod";
import { dateTimeSchema, idSchema, tiptapDocSchema } from "./common.js";

export const noteCreateSchema = z
  .object({
    personId: idSchema.optional(),
    eventId: idSchema.optional(),
    body: tiptapDocSchema,
    occurredAt: dateTimeSchema.default(() => new Date()),
    pinned: z.boolean().default(false),
    tagIds: z.array(idSchema).default([]),
  })
  .refine((value) => Boolean(value.personId) !== Boolean(value.eventId), {
    message: "Attach the note to either a person or an event, not both",
    path: ["personId"],
  });

export const noteUpdateSchema = z.object({
  body: tiptapDocSchema.optional(),
  occurredAt: dateTimeSchema.optional(),
  pinned: z.boolean().optional(),
  tagIds: z.array(idSchema).optional(),
});

export type NoteCreateInput = z.input<typeof noteCreateSchema>;
export type NoteUpdateInput = z.input<typeof noteUpdateSchema>;
