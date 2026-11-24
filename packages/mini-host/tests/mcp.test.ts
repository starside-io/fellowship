import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMcpServer, mcpName } from "../src/mcp.js";
import { seedPerson, seedSelf, throwawayHost } from "./harness.js";
import type { MiniHost } from "../src/host.js";

/**
 * The milestone's own test: an assistant drives Fellowship with no UI at all.
 *
 * Everything here goes over the protocol, through the same registry /rpc uses,
 * so the gates hold on this side too.
 */

async function connect(host: MiniHost) {
  const server = createMcpServer(host);
  const client = new Client({ name: "test-assistant", version: "0.0.1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => void (await Promise.all([client.close(), server.close()])) };
}

/** The text payload of a tool result, parsed back. */
function payloadOf(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((entry) => entry.type === "text")?.text ?? "null";
  return JSON.parse(text);
}

describe("the stdio server", () => {
  it("advertises all 42 tools, with dots mapped to underscores", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(42);

      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("people_search");
      expect(names).toContain("people_log_interaction");
      expect(names).toContain("people_write_sketch");
      expect(names.some((name) => name.includes("."))).toBe(false);
      expect(mcpName("people.chat_insights")).toBe("people_chat_insights");

      // The input schema travels with the tool, so a client can fill it in.
      const search = listed.tools.find((tool) => tool.name === "people_search");
      expect(search?.inputSchema).toMatchObject({ type: "object" });
      expect(Object.keys((search?.inputSchema as { properties: object }).properties)).toContain(
        "query",
      );

      // A read is marked as one.
      expect(search?.annotations?.readOnlyHint).toBe(true);
      const sketch = listed.tools.find((tool) => tool.name === "people_write_sketch");
      expect(sketch?.annotations?.destructiveHint).toBe(true);
    } finally {
      await close();
      await host.close();
    }
  });

  it("drives the whole flow: add, log, read back", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const self = payloadOf(
        await client.callTool({ name: "people_create", arguments: { displayName: "Me" } }),
      ) as { person: { id: string } };
      await host.silo.person.update({
        where: { id: self.person.id },
        data: { isSelf: true },
      });

      const sam = payloadOf(
        await client.callTool({
          name: "people_create",
          arguments: { displayName: "Sam Rivera", location: "Lisbon" },
        }),
      ) as { person: { id: string } };

      const found = payloadOf(
        await client.callTool({ name: "people_search", arguments: { query: "Sam" } }),
      ) as { people: Array<{ id: string; displayName: string }> };
      expect(found.people.map((person) => person.displayName)).toEqual(["Sam Rivera"]);

      const logged = payloadOf(
        await client.callTool({
          name: "people_log_interaction",
          arguments: {
            title: "Dinner at Kanji",
            type: "MEAL",
            occurredAt: "2026-06-02T12:00:00.000Z",
            sentiment: 2,
            participants: [{ personId: self.person.id }, { personId: sam.person.id }],
          },
        }),
      ) as { written: boolean };
      expect(logged.written).toBe(true);

      const insights = payloadOf(
        await client.callTool({
          name: "people_insights",
          arguments: { personId: sam.person.id },
        }),
      ) as { closeness: { linked: boolean; score: number } };
      expect(insights.closeness.linked).toBe(true);
      expect(insights.closeness.score).toBeGreaterThan(0);
    } finally {
      await close();
      await host.close();
    }
  });

  it("keeps the gates: a needs-OK tool refuses over the protocol too", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      const refused = await client.callTool({
        name: "people_write_sketch",
        arguments: { personId, summary: "Replies at night.", sources: ["history"] },
      });
      expect(refused.isError).toBe(true);

      const diagnosis = await client.callTool({
        name: "people_write_sketch",
        arguments: {
          personId,
          summary: "Classic anxious attachment.",
          sources: ["history"],
          confirmedByUser: true,
        },
      });
      expect(diagnosis.isError).toBe(true);
      expect(JSON.stringify(diagnosis.content)).toContain("diagnosis");

      expect(await host.silo.personProfile.count()).toBe(0);
    } finally {
      await close();
      await host.close();
    }
  });

  it("returns unmatched names rather than inventing a person", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const selfId = await seedSelf(host);
      const before = await host.silo.person.count();

      const result = payloadOf(
        await client.callTool({
          name: "people_log_interaction",
          arguments: {
            title: "Coffee",
            type: "HANGOUT",
            occurredAt: "2026-06-02T12:00:00.000Z",
            participants: [{ personId: selfId }, { name: "Nobody I Know" }],
          },
        }),
      ) as { written: boolean; unmatched: Array<{ name: string }> };

      expect(result.written).toBe(false);
      expect(result.unmatched[0]!.name).toBe("Nobody I Know");
      expect(await host.silo.person.count()).toBe(before);
    } finally {
      await close();
      await host.close();
    }
  });

  it("audits what an assistant did, in the host's own file", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");
      await client.callTool({ name: "people_get", arguments: { personId } });
      await client.callTool({ name: "people_read_messages", arguments: { personId } });

      const tools = host.store.listAudit().map((entry) => entry.tool);
      expect(tools).toContain("people.get");
      expect(tools).toContain("people.read_messages");
    } finally {
      await close();
      await host.close();
    }
  });
});
