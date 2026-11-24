import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The formula, from source, without the rest of core coming with it. */
const scoring = fileURLToPath(new URL("../core/src/domain/scoring.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@fellowship\/core\/scoring$/, replacement: scoring }],
  },
  test: { environment: "node", globals: false, include: ["tests/**/*.test.ts"] },
});
