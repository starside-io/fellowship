# grammars

The shapes a model must answer in, generated from the zod schemas in
`packages/core/src/domain/drafting/schemas.ts`:

```bash
pnpm --filter @fellowship/core grammars
```

They are generated rather than written by hand so the shape the model is
forced into and the shape core validates against cannot drift. The one rule
they exist to enforce is in `sketch.schema.json`: `sources` is required and
has `minItems: 1`, because a sketch with no stated sources is a horoscope and a
grammar enforces what a prompt only requests.

An OpenAI compatible endpoint takes one as `response_format.json_schema`.
llama.cpp takes the same file with `--json-schema` and builds the GBNF itself.
