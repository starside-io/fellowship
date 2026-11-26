import { z, type ZodTypeAny } from "zod";

/**
 * The object schema a tool is advertised with over MCP.
 *
 * The MCP SDK lists a tool's parameters only when its input is a plain
 * z.object. Anything else, such as an object with a refine, a default, an
 * intersection or a discriminated union, goes out as an empty parameter list,
 * and an assistant then has no way to know what to send. Calls still worked
 * when it guessed, because the registry validates against the real schema.
 *
 * This flattens a tool's input into the one object that names every field it
 * can take. It only describes: the registry still validates each call against
 * the tool's own schema, refines and all, before anything runs.
 */
export function advertisedSchema(schema: ZodTypeAny): z.AnyZodObject {
  return flatten(schema) ?? z.object({}).passthrough();
}

function typeName(schema: ZodTypeAny): string {
  return (schema._def as { typeName?: string }).typeName ?? "";
}

function flatten(schema: ZodTypeAny): z.AnyZodObject | null {
  const def = schema._def as Record<string, unknown>;
  switch (typeName(schema)) {
    case "ZodObject":
      return schema as z.AnyZodObject;
    case "ZodEffects":
      return flatten(def["schema"] as ZodTypeAny);
    case "ZodDefault":
    case "ZodOptional":
    case "ZodNullable":
    case "ZodReadonly":
    case "ZodBranded":
    case "ZodCatch":
      return flatten(def["innerType"] as ZodTypeAny);
    case "ZodPipeline":
      return flatten(def["in"] as ZodTypeAny);
    case "ZodLazy":
      return flatten((def["getter"] as () => ZodTypeAny)());
    case "ZodIntersection": {
      const left = flatten(def["left"] as ZodTypeAny);
      const right = flatten(def["right"] as ZodTypeAny);
      if (!left || !right) return left ?? right;
      return left.merge(right);
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const raw = def["options"] as ZodTypeAny[] | Map<unknown, ZodTypeAny>;
      const options = (Array.isArray(raw) ? raw : [...raw.values()])
        .map(flatten)
        .filter((option): option is z.AnyZodObject => option !== null);
      return options.length > 0 ? unionOfObjects(options) : null;
    }
    default:
      return null;
  }
}

/**
 * Every field any branch takes. A field is required only when every branch
 * requires it, as the discriminator is; one that differs between branches is
 * advertised as either.
 */
function unionOfObjects(options: z.AnyZodObject[]): z.AnyZodObject {
  const fields = new Map<string, ZodTypeAny[]>();
  for (const option of options) {
    for (const [key, field] of Object.entries(option.shape as Record<string, ZodTypeAny>)) {
      fields.set(key, [...(fields.get(key) ?? []), field]);
    }
  }

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, variants] of fields) {
    const merged =
      variants.length === 1
        ? variants[0]!
        : z.union(variants as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    const required =
      variants.length === options.length && variants.every((variant) => !variant.isOptional());
    shape[key] = required ? merged : merged.optional();
  }
  return z.object(shape);
}
