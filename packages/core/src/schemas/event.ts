import { z } from "zod";

// The allowed values live in enums.ts, which the CHECK constraints are
// generated from. Aliased to the name this module was written with.
import {
  EventType as eventTypeSchema,
} from "./enums.js";
import {
  dateTimeSchema,
  idSchema,
  optionalDate,
  optionalText,
  tiptapDocSchema,
} from "./common.js";

/** Accepts numbers or the numeric strings that form controls hand back. */
const intFromInput = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a whole number" });
    return z.NEVER;
  }
  return parsed;
});

/** -2 bad, -1 tense, 0 neutral, +1 good, +2 great. */
export const sentimentSchema = intFromInput.refine(
  (value) => value >= -2 && value <= 2,
  "Sentiment runs from -2 to 2",
);

export const weightSchema = intFromInput.refine(
  (value) => value >= 1 && value <= 3,
  "Weight runs from 1 to 3",
);

/**
 * How many days an occasion lasted. A coffee is 1; two weeks staying with
 * someone is 14. Closeness grows with it, with diminishing returns.
 */
export const durationDaysSchema = intFromInput.refine(
  (value) => value >= 1 && value <= 365,
  "Duration runs from 1 to 365 days",
);

export const eventParticipantInputSchema = z
  .object({
    personId: idSchema.optional(),
    name: optionalText,
    role: optionalText,
    sentiment: sentimentSchema.nullish(),
  })
  .refine((value) => Boolean(value.personId) || Boolean(value.name), {
    message: "Each participant needs a person or a name",
    path: ["name"],
  });

export const eventBaseSchema = z.object({
  title: z.string().trim().min(1, "A title is required").max(200),
  type: eventTypeSchema,
  occurredAt: dateTimeSchema,
  location: optionalText,
  description: tiptapDocSchema.nullish(),
  sentiment: sentimentSchema.default(0),
  weight: weightSchema.default(1),
  durationDays: durationDaysSchema.default(1),
  participants: z.array(eventParticipantInputSchema).default([]),
});

export const eventCreateSchema = eventBaseSchema;

export const eventUpdateSchema = eventBaseSchema;

export const listEventsParamsSchema = z
  .object({
    type: eventTypeSchema.optional(),
    sentiment: sentimentSchema.optional(),
    from: optionalDate,
    to: optionalDate,
    personId: idSchema.optional(),
  })
  .default({});

export type EventParticipantInput = z.input<typeof eventParticipantInputSchema>;
export type EventCreateInput = z.input<typeof eventCreateSchema>;
export type EventUpdateInput = z.input<typeof eventUpdateSchema>;
export type ListEventsParams = z.input<typeof listEventsParamsSchema>;
