import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createMcpServer, mcpName, type McpServerOptions } from "../src/mcp.js";
import { seedPerson, seedSelf, throwawayHost } from "./harness.js";
import type { MiniHost } from "../src/host.js";
import { FELLOWSHIP_VERSION } from "../src/version.js";

/**
 * The milestone's own test: an assistant drives Fellowship with no UI at all.
 *
 * Everything here goes over the protocol, through the same registry /rpc uses,
 * so the gates hold on this side too.
 */

async function connect(host: MiniHost, options: McpServerOptions = {}) {
  const server = createMcpServer(host, options);
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
  it("advertises all 43 people tools and the 3 app tools, with dots mapped to underscores", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(46);
      expect(listed.tools.filter((tool) => tool.name.startsWith("people_"))).toHaveLength(43);

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

  it("lists the fields of every tool, whatever shape its schema has", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const listed = await client.listTools();
      const fields = (name: string) =>
        Object.keys(
          (listed.tools.find((tool) => tool.name === name)?.inputSchema as {
            properties?: object;
          }).properties ?? {},
        );

      // A refine, an intersection, a default and a discriminated union: each
      // used to go out as an empty parameter list.
      expect(fields("people_add_note")).toEqual(expect.arrayContaining(["personId", "body"]));
      expect(fields("people_set_favour")).toEqual(
        expect.arrayContaining(["personId", "favourId", "direction", "settled"]),
      );
      expect(fields("people_map_sender")).toEqual(
        expect.arrayContaining(["conversationId", "senderName", "personId"]),
      );
      expect(fields("people_read_messages")).toEqual(
        expect.arrayContaining(["personId", "query"]),
      );
      expect(fields("people_write_sketch")).toEqual(
        expect.arrayContaining(["personId", "sources", "confirmedByUser"]),
      );
      expect(fields("people_draft_context")).toEqual(
        expect.arrayContaining(["job", "personId", "conversationId"]),
      );
      expect(fields("people_import_chat")).toEqual(expect.arrayContaining(["text", "filePath"]));

      // Only a tool that really takes nothing lists nothing.
      const empty = listed.tools
        .filter((tool) => tool.name.startsWith("people_") && fields(tool.name).length === 0)
        .map((tool) => tool.name);
      for (const name of empty) {
        const definition = host.api.tools.find((tool) => mcpName(tool.name) === name)!;
        expect(definition.input.safeParse({}).success, name).toBe(true);
      }
    } finally {
      await close();
      await host.close();
    }
  });

  it("still validates against the real schema behind a flattened one", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      // A note goes in through the refined schema it is advertised without.
      const note = await client.callTool({
        name: "people_add_note",
        arguments: {
          personId,
          body: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Training for the autumn half marathon." }],
              },
            ],
          },
        },
      });
      expect(note.isError).toBeFalsy();

      // And the refine still refuses what it always refused.
      const empty = await client.callTool({ name: "people_add_note", arguments: { personId } });
      expect(empty.isError).toBe(true);

      // A tool with nothing required takes no arguments at all.
      const self = await client.callTool({ name: "people_self", arguments: {} });
      expect(self.isError).toBeFalsy();
    } finally {
      await close();
      await host.close();
    }
  });

  it("opens, and installs on a yes only, the desktop app", async () => {
    const host = await throwawayHost();
    const dir = mkdtempSync(join(tmpdir(), "fellowship-apps-"));
    const opened: string[] = [];
    const { client, close } = await connect(host, {
      app: {
        env: { FELLOWSHIP_APP_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, "no-claude") },
        supported: true,
        open: async () => void opened.push("open"),
        // A stand in for the release: the "download" unpacks a bundle at this build's version.
        fetch: (async (url: string | URL | Request) => {
          const href = String(url);
          if (href.includes("/releases/tags/")) {
            const name = `Fellowship-${FELLOWSHIP_VERSION}-macos-arm64.zip`;
            return new Response(
              JSON.stringify({
                assets: [
                  { name, browser_download_url: "https://dl/zip" },
                  { name: `${name}.sha256`, browser_download_url: "https://dl/sha" },
                ],
              }),
            );
          }
          if (href === "https://dl/zip") return new Response("zip");
          return new Response(createHash("sha256").update("zip").digest("hex"));
        }) as typeof fetch,
        unzip: async (_zip, into) => {
          mkdirSync(join(into, "Fellowship.app", "Contents"), { recursive: true });
          writeFileSync(
            join(into, "Fellowship.app", "Contents", "Info.plist"),
            `<key>CFBundleShortVersionString</key><string>${FELLOWSHIP_VERSION}</string>`,
          );
        },
      },
    });
    try {
      const before = payloadOf(await client.callTool({ name: "app_open", arguments: {} })) as {
        opened: boolean;
        message: string;
      };
      expect(before.opened).toBe(false);
      expect(before.message).toMatch(/not installed/);
      expect(opened).toEqual([]);

      // No yes, no download.
      const refused = await client.callTool({ name: "app_install", arguments: {} });
      expect(refused.isError).toBe(true);

      const installed = await client.callTool({
        name: "app_install",
        arguments: { confirmedByUser: true },
      });
      expect(installed.isError).toBeFalsy();
      expect(payloadOf(installed)).toMatchObject({ ok: true, version: FELLOWSHIP_VERSION });

      const status = payloadOf(await client.callTool({ name: "app_status", arguments: {} }));
      expect(status).toMatchObject({ version: FELLOWSHIP_VERSION, behind: false });

      const after = payloadOf(await client.callTool({ name: "app_open", arguments: {} }));
      expect(after).toMatchObject({ opened: true });
      expect(opened).toEqual(["open"]);
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
