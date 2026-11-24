import { describe, expect, it } from "vitest";

import { createApp } from "../src/server.js";
import { seedPerson, throwawayHost } from "./harness.js";

/**
 * POST /host/avatar/preview fetches a candidate picture and shows it without
 * storing it, so the owner can see what a resolver returns before saying yes.
 *
 * The gate here is that it is not a fetch anything proxy. A URL that is not
 * one of that person's own candidates is refused before the media port is
 * reached, which is what keeps the browser from steering the host at an
 * address of its choosing. Every case below is refused without a request
 * leaving the machine.
 */

async function preview(
  app: ReturnType<typeof createApp>,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request("/host/avatar/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the picture preview route", () => {
  it("refuses a URL that is not one of this person's candidates", async () => {
    const host = await throwawayHost();
    try {
      const app = createApp(host);
      const personId = await seedPerson(host, "Sam Rivera");
      await host.api.invoke("people.set_contacts", {
        personId,
        contacts: [{ kind: "SOCIAL", platform: "github", value: "sam" }],
      });

      for (const url of [
        "https://example.test/anything.png",
        "http://127.0.0.1:4319/health",
        "https://github.com/someone-else.png?size=400",
      ]) {
        const result = await preview(app, { personId, url });
        expect(result.status, url).toBe(400);
        expect(result.body.ok, url).toBe(false);
      }

      expect(await host.silo.personAvatar.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("refuses a body with no personId or no url", async () => {
    const host = await throwawayHost();
    try {
      const app = createApp(host);
      expect((await preview(app, {})).status).toBe(400);
      expect((await preview(app, { personId: "x" })).status).toBe(400);
      expect((await preview(app, { url: "https://example.test/a.png" })).status).toBe(400);
    } finally {
      await host.close();
    }
  });

  it("refuses a person who is not there", async () => {
    const host = await throwawayHost();
    try {
      const result = await preview(createApp(host), {
        personId: "11111111-1111-4111-8111-111111111111",
        url: "https://github.com/sam.png?size=400",
      });
      expect(result.status).toBe(404);
      expect(result.body.ok).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("has nothing to offer for a person with no handles, so every URL is refused", async () => {
    const host = await throwawayHost();
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      // No contact channels means no candidates, which means the match can
      // never succeed and the media port is never reached.
      const result = await preview(createApp(host), {
        personId,
        url: "https://github.com/sam.png?size=400",
      });
      expect(result.status).toBe(400);
      expect(await host.silo.personAvatar.count()).toBe(0);
    } finally {
      await host.close();
    }
  });
});
