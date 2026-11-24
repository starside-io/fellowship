import { z } from "zod";
import { hexColourSchema, idSchema, optionalDate, optionalText } from "./common.js";
import { mbtiSchema } from "./personality.js";

export const personBaseSchema = z.object({
  displayName: z.string().trim().min(1, "A display name is required").max(120),
  firstName: optionalText,
  lastName: optionalText,
  birthday: optionalDate,
  location: optionalText,
  howWeMet: optionalText,
  metOn: optionalDate,
  commStyle: z.array(z.string().trim().min(1)).default([]),
  /** INTJ, ENFP-A and so on. Typed by the owner. */
  mbti: mbtiSchema,
  avatarColor: hexColourSchema.optional(),
});

export const personCreateSchema = personBaseSchema;

export const personUpdateSchema = personBaseSchema.partial();

export const listPeopleParamsSchema = z
  .object({
    search: z.string().trim().optional(),
    circleId: idSchema.optional(),
    tagId: idSchema.optional(),
    archived: z.boolean().default(false),
    includeSelf: z.boolean().default(false),
  })
  .default({});

// The self record is pinned to the top of the people list, so it only takes the
// filters that would make showing it dishonest: the archived view and a search.
export const selfPersonParamsSchema = z
  .object({
    search: z.string().trim().optional(),
    archived: z.boolean().default(false),
  })
  .default({});

export type PersonCreateInput = z.input<typeof personCreateSchema>;
export type PersonUpdateInput = z.input<typeof personUpdateSchema>;
export type ListPeopleParams = z.input<typeof listPeopleParamsSchema>;
export type SelfPersonParams = z.input<typeof selfPersonParamsSchema>;
