import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { serveMiniHost } from "../src/server.js";

/**
 * The host answers on loopback and nowhere else unless told to. A single user
 * app has no auth, so an interface it listens on is an interface the silo is
 * readable from.
 */

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

describe("serveMiniHost", () => {
  it("listens on 127.0.0.1 by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fellowship-serve-"));
    const running = await serveMiniHost({
      dbPath: join(dir, "fellowship.db"),
      hostDbPath: join(dir, "host.db"),
      port: 0,
    });

    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const local = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(local.status).toBe(200);

      // From the machine's own network address, nothing answers.
      const lan = lanAddress();
      if (lan) {
        await expect(
          fetch(`http://${lan}:${running.port}/health`, {
            signal: AbortSignal.timeout(1500),
          }),
        ).rejects.toThrow();
      }
    } finally {
      await running.close();
    }
  });
});
