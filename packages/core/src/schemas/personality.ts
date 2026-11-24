import { z } from "zod";

/**
 * The personality radar and the Myers-Briggs type.
 *
 * The radar is a fixed set of axes, scored from what the chats and the logged
 * history show, so every person is drawn on the same chart and two people can
 * be compared at a glance. Each axis is a behaviour with two ends, not a
 * clinical trait: the score says where someone sits between the ends, and the
 * evidence says what in the messages put them there.
 *
 * The Myers-Briggs type is the owner's to type. A draft never sets it.
 */

export const PERSONALITY_AXES = [
  {
    key: "curiosity",
    label: "Curiosity",
    left: "Routine",
    right: "Curious",
    hint: "Seeks out new places, food, ideas and plans, or sticks with what they know.",
  },
  {
    key: "planning",
    label: "Planning",
    left: "Spontaneous",
    right: "Organised",
    hint: "Fixes times and follows through, or decides on the day.",
  },
  {
    key: "energy",
    label: "Energy",
    left: "Reserved",
    right: "Outgoing",
    hint: "Draws energy from groups and going out, or from small and quiet.",
  },
  {
    key: "warmth",
    label: "Warmth",
    left: "Cool",
    right: "Warm",
    hint: "Checks in, encourages, says nice things unprompted.",
  },
  {
    key: "composure",
    label: "Composure",
    left: "Excitable",
    right: "Composed",
    hint: "How they handle friction and bad news in the messages.",
  },
  {
    key: "playfulness",
    label: "Playfulness",
    left: "Serious",
    right: "Playful",
    hint: "Jokes, teasing, memes, emoji.",
  },
  {
    key: "initiative",
    label: "Initiative",
    left: "Follows",
    right: "Initiates",
    hint: "Who starts conversations and plans after a silence.",
  },
  {
    key: "expressiveness",
    label: "Expressiveness",
    left: "Brief",
    right: "Expressive",
    hint: "Message length, voice notes, how much they share about themselves.",
  },
] as const;

export type PersonalityAxisKey = (typeof PERSONALITY_AXES)[number]["key"];

const AXIS_KEYS = PERSONALITY_AXES.map((axis) => axis.key) as [
  PersonalityAxisKey,
  ...PersonalityAxisKey[],
];

export const personalityAxisKeySchema = z.enum(AXIS_KEYS);

export const personalityScoreSchema = z.object({
  key: personalityAxisKeySchema,
  /** 0 is all the way to the left end, 100 all the way to the right. */
  value: z.number().int().min(0).max(100),
  /** What in the material says so: a quote, a count, a habit. */
  evidence: z.string().trim().min(10).max(300),
  confidence: z.enum(["high", "medium", "low"]),
});

/**
 * At least four axes, each one once. An axis the material says nothing about
 * is left out rather than set to 50, because 50 drawn on a chart reads as
 * "middling", not as "unknown".
 */
export const personalityScoresSchema = z
  .array(personalityScoreSchema)
  .min(4, "Score at least four axes")
  .max(PERSONALITY_AXES.length)
  .refine(
    (scores) => new Set(scores.map((score) => score.key)).size === scores.length,
    "Each axis once",
  );

export type PersonalityScore = z.infer<typeof personalityScoreSchema>;

/** Reads the stored JSON, dropping anything that no longer validates. */
export function parsePersonality(value: unknown): PersonalityScore[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const score = personalityScoreSchema.safeParse(entry);
    if (!score.success || seen.has(score.data.key)) return [];
    seen.add(score.data.key);
    return [score.data];
  });
}

/**
 * The sixteen types, with the optional identity suffix (-A assertive, -T
 * turbulent) some tests add. Stored upper case.
 */
export const mbtiSchema = z
  .union([z.string(), z.null()])
  .transform((value, ctx) => {
    if (value === null) return null;
    const trimmed = value.trim().toUpperCase();
    if (trimmed.length === 0) return null;
    if (!/^[EI][SN][TF][JP](-[AT])?$/.test(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a Myers-Briggs type such as INTJ or ENFP-A",
      });
      return z.NEVER;
    }
    return trimmed;
  })
  .optional();
