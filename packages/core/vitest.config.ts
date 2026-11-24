import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The connector is consumed from source in this repo, so a test never waits on
 * a build of it. The published entry points at dist, which is what the host
 * loads.
 */
const connectorSrc = fileURLToPath(
  new URL("../connector-chat-export/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [{ find: /^@fellowship\/connector-chat-export$/, replacement: connectorSrc }],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
  },
});
