import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Core is consumed from source in this repo, so a test never waits on a build.
// The published entry points at dist, which is what the MCP server runs from.
const coreSrc = fileURLToPath(new URL("../core/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@fellowship\/core$/, replacement: `${coreSrc}/index.ts` },
      {
        find: /^@fellowship\/core\/drafting$/,
        replacement: `${coreSrc}/domain/drafting/index.ts`,
      },
      { find: /^@fellowship\/core\/(.*)$/, replacement: `${coreSrc}/$1` },
    ],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
  },
});
