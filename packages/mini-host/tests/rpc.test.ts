import { describe, expect, it } from "vitest";

import { createApp } from "../src/server.js";
import { seedPerson, seedSelf, throwawayHost } from "./harness.js";

/**
 * POST /rpc: the one way in, and the only one the UI will have.
 *
 * Everything here goes through the same registry the MCP server uses, so a
 * refusal reads the same from both and neither gets a privileged path.
 */

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  const response = await app.request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the HTTP surface", () => {
  it("answers /health with where the files are", async () => {
    const host = await throwawayHost();
    try {
      const response = await createApp(host).request("/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        silo: host.siloPath,
        hostDb: host.hostPath,
        tools: 43,
      });
    } finally {
      await host.close();
    }
  });

  it("lists the tool surface for a client building a palette", async () => {
    const host = await throwawayHost();
    try {
      const response = await createApp(host).request("/rpc/tools");
      const body = (await response.json()) as { tools: Array<{ name: string; kind: string }> };
      expect(body.tools).toHaveLength(43);
      expect(body.tools.filter((tool) => tool.kind === "needs-ok")).toHaveLength(6);
    } finally {
      await host.close();
    }
  });
});

describe("a call over /rpc", () => {
  it("writes, reads back and derives, all through tools", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const self = await post(app, { tool: "people.create", input: { displayName: "Me" } });
      expect(self.status).toBe(200);
      const selfId = ((self.body.result as { person: { id: string } }).person).id;
      await host.silo.person.update({ where: { id: selfId }, data: { isSelf: true } });

      const created = await post(app, {
        tool: "people.create",
        input: { displayName: "Sam Rivera", location: "Lisbon" },
      });
      const personId = ((created.body.result as { person: { id: string } }).person).id;

      const logged = await post(app, {
        tool: "people.log_interaction",
        input: {
          title: "Dinner at Kanji",
          type: "MEAL",
          occurredAt: "2026-06-02T12:00:00.000Z",
          sentiment: 2,
          participants: [{ personId: selfId }, { personId }],
        },
      });
      expect(logged.status).toBe(200);
      expect(logged.body.result).toMatchObject({ written: true });

      const insights = await post(app, { tool: "people.insights", input: { personId } });
      expect(insights.status).toBe(200);
      expect(insights.body.result).toMatchObject({
        displayName: "Sam Rivera",
        cadence: { totalEvents: 1 },
        closeness: { linked: true },
      });

      // And the host's own surface shows what the module did.
      const events = await app.request("/host/events");
      const feed = (await events.json()) as { events: Array<{ name: string }> };
      expect(feed.events.map((event) => event.name)).toContain("people.interaction.logged");

      const audit = await app.request("/host/audit");
      const log = (await audit.json()) as { entries: Array<{ tool: string }> };
      expect(log.entries.map((entry) => entry.tool)).toContain("people.log_interaction");
    } finally {
      await host.close();
    }
  });

  it("gives a refusal its own status code and keeps the message", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      const unknown = await post(app, { tool: "people.nope", input: {} });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ ok: false, error: { code: "unknown_tool" } });

      const invalid = await post(app, {
        tool: "people.write_sketch",
        input: { personId, summary: "x", sources: ["history"] },
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ ok: false, error: { code: "invalid_input" } });

      const missing = await post(app, {
        tool: "people.get",
        input: { personId: "11111111-1111-4111-8111-111111111111" },
      });
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ ok: false, error: { code: "not_found" } });

      const refused = await post(app, { tool: "people.archive", input: { personId: await seedSelf(host) } });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ ok: false, error: { code: "refused" } });

      const noTool = await post(app, { input: {} });
      expect(noTool.status).toBe(400);

      const notJson = await app.request("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(notJson.status).toBe(400);
    } finally {
      await host.close();
    }
  });

  it("has no route that reaches the silo without a tool", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      for (const path of ["/people", "/silo", "/db", "/query", "/sql"]) {
        const response = await app.request(path);
        expect(response.status, path).toBe(404);
      }
    } finally {
      await host.close();
    }
  });
});

describe("the review queue", () => {
  it("lists what the module proposed and takes one decision per row", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      // A payload the tool will accept: confirming runs it now, so a proposal
      // that could never be written is refused at confirmation, not marked done.
      const { id } = await host.ports.review.propose({
        tool: "people.write_sketch",
        personId,
        payload: {
          personId,
          summary: "Replies in the evening, in paragraphs.",
          sources: ["fellowship logged history"],
        },
        summary: "A sketch for Sam Rivera",
      });

      const listed = await app.request("/host/review");
      expect((await listed.json()) as unknown).toMatchObject({
        proposals: [{ id, state: "pending", tool: "people.write_sketch" }],
      });

      const confirmed = await app.request(`/host/review/${id}/confirm`, { method: "POST" });
      expect(confirmed.status).toBe(200);
      expect(await host.silo.personProfile.count()).toBe(1);

      // Decided once, so a second decision is a conflict rather than a write.
      const again = await app.request(`/host/review/${id}/confirm`, { method: "POST" });
      expect(again.status).toBe(409);
      expect(await host.silo.personProfile.count()).toBe(1);

      const missing = await app.request(`/host/review/nope/confirm`, { method: "POST" });
      expect(missing.status).toBe(404);

      const bad = await app.request(`/host/review/${id}/maybe`, { method: "POST" });
      expect(bad.status).toBe(400);
    } finally {
      await host.close();
    }
  });
});
