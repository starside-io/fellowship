import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The standalone shell.
 *
 * In development this serves the SPA and proxies the three paths the host
 * owns, so the UI talks to the same POST /rpc it will talk to in production
 * and never to a mock. The build goes to dist, which the host serves.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\/(.*)$/,
        replacement: `${fileURLToPath(new URL("./src", import.meta.url))}/$1`,
      },
      {
        find: /^@fellowship\/graph$/,
        replacement: fileURLToPath(new URL("../graph/src/index.ts", import.meta.url)),
      },
      {
        find: /^@fellowship\/core\/scoring$/,
        replacement: fileURLToPath(
          new URL("../core/src/domain/scoring.ts", import.meta.url),
        ),
      },
    ],
  },
  server: {
    port: 4320,
    proxy: Object.fromEntries(
      ["/rpc", "/media", "/host", "/health"].map((path) => [
        path,
        { target: "http://localhost:4319", changeOrigin: false },
      ]),
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
