import { z } from "zod";

// The allowed values live in enums.ts, which the CHECK constraints are
// generated from. Aliased to the name this module was written with.
import {
  ProfileSource as profileSourceSchema,
} from "./enums.js";
import { optionalText } from "./common.js";

/** optionalText with a length cap, so a sketch stays a sketch. */
function boundedText(max: number) {
  return optionalText.refine(
    (value) => value === null || value === undefined || value.length <= max,
    `Expected at most ${max} characters`,
  );
}

/** Accepts numbers or the numeric strings a slider hands back. */
const traitValueSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === "number" ? value : Number(value.trim());
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A trait value runs from 0 to 100",
      });
      return z.NEVER;
    }
    return Math.round(parsed);
  });

/** One practical axis, for example quiet at 30 on a Quiet to Loud setting. */
export const profileTraitSchema = z.object({
  key: z.string().trim().min(1, "A trait key is required").max(60),
  label: z.string().trim().min(1, "A trait label is required").max(80),
  left: z.string().trim().min(1, "The left end needs a name").max(40),
  right: z.string().trim().min(1, "The right end needs a name").max(40),
  value: traitValueSchema,
});

export const profileTraitsSchema = z
  .array(profileTraitSchema)
  .max(12, "At most 12 traits")
  .refine(
    (traits) => new Set(traits.map((trait) => trait.key)).size === traits.length,
    "Trait keys must be unique",
  );

const nullableTraits = z
  .union([profileTraitsSchema, z.null()])
  .optional();

const sourcesSchema = z
  .array(z.string().trim().min(1).max(500))
  .max(20, "At most 20 sources")
  .optional();

/** Every field of a sketch, all optional so a caller can write one at a time. */
export const personProfileInputSchema = z.object({
  summary: boundedText(2000),
  whatLands: boundedText(1000),
  whatToAvoid: boundedText(1000),
  opener: boundedText(500),
  traits: nullableTraits,
  sources: sourcesSchema,
});

export type ProfileTrait = z.infer<typeof profileTraitSchema>;
export type PersonProfileInput = z.input<typeof personProfileInputSchema>;
export type PersonProfileFields = z.infer<typeof personProfileInputSchema>;

/** Reads the stored traits JSON, dropping anything that no longer validates. */
export function parseProfileTraits(value: unknown): ProfileTrait[] {
  if (!Array.isArray(value)) return [];
  const parsed = profileTraitsSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  return value.flatMap((entry) => {
    const trait = profileTraitSchema.safeParse(entry);
    return trait.success ? [trait.data] : [];
  });
}
