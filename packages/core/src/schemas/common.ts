import { z } from "zod";

export const idSchema = z.string().uuid("Expected a valid id");

export const hexColourSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Expected a hex colour such as #6366f1");

/** Trims text, turns blanks coming from form inputs into null. */
const nullableText = z.union([z.string(), z.null()]).transform((value) => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
});

export const optionalText = nullableText.optional();

const nullableUrl = z.union([z.string(), z.null()]).transform((value, ctx) => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!z.string().url().safeParse(trimmed).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a valid URL" });
    return z.NEVER;
  }
  return trimmed;
});

export const optionalUrl = nullableUrl.optional();

const nullableDate = z
  .union([z.string(), z.date(), z.null()])
  .transform((value, ctx) => {
    if (value === null) return null;
    if (value instanceof Date) return value;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // Date only inputs are pinned to UTC midnight so they survive the round trip.
    const parsed = new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed,
    );
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a valid date" });
      return z.NEVER;
    }
    return parsed;
  });

export const optionalDate = nullableDate.optional();

/** Required point in time, accepts a Date or an ISO / datetime-local string. */
export const dateTimeSchema = z
  .union([z.string(), z.date()])
  .transform((value, ctx) => {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a valid date" });
        return z.NEVER;
      }
      return value;
    }
    const trimmed = value.trim();
    const parsed = new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed,
    );
    if (trimmed.length === 0 || Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a valid date" });
      return z.NEVER;
    }
    return parsed;
  });

type JsonLiteral = string | number | boolean | null;

export type JsonValue = JsonLiteral | JsonValue[] | { [key: string]: JsonValue };

const jsonLiteralSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonLiteralSchema,
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

/** A Tiptap document: a plain JSON object whose root type is "doc". */
export const tiptapDocSchema = z
  .record(jsonValueSchema)
  .refine((value) => value.type === "doc", {
    message: "Expected a Tiptap document",
  });

export type TiptapDoc = z.infer<typeof tiptapDocSchema>;

/** Lowercase snake_case key, used for field definition keys. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
