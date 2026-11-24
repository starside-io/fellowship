/**
 * Writes the constrained decoding schemas into adapters/grammars.
 *
 * They are generated from the zod schemas rather than written beside them, so
 * the shape the model is forced into and the shape core validates against
 * cannot drift. Run it after changing a draft schema:
 *
 *   pnpm --filter @fellowship/core grammars
 *
 * An OpenAI compatible endpoint takes one as response_format.json_schema.
 * llama.cpp takes the same file with --json-schema and builds the GBNF
 * itself, which is why there is no hand written grammar here to go stale.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DRAFT_JOBS, jsonSchemaFor } from "../src/domain/drafting/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = join(root, "adapters", "grammars");

mkdirSync(out, { recursive: true });

for (const job of DRAFT_JOBS) {
  const file = join(out, `${job}.schema.json`);
  writeFileSync(file, `${JSON.stringify(jsonSchemaFor(job), null, 2)}\n`);
  process.stdout.write(`Wrote ${file}\n`);
}
