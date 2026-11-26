import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { tools as coreTools } from "@fellowship/core";
import type { ToolDefinition } from "@fellowship/core";

import { startMiniHost, type MiniHost, type MiniHostOptions } from "./host.js";

/**
 * The stdio MCP server: the second transport over the one registry.
 *
 * An assistant with this server attached can drive Fellowship with no UI at
 * all, which is the honest test of the tool surface. It gets no shortcut the
 * UI does not have and no path around the gates: the needs-OK tools still want
 * confirmedByUser, attach_socials still wants its token, and every call still
 * lands in the audit log.
 */

/** MCP tool names avoid dots, which some clients reject. */
export function mcpName(toolName: string): string {
  return toolName.replace(/\./g, "_");
}

const KIND_NOTE: Record<string, string> = {
  read: "Reads. Writes nothing.",
  write:
    "Writes to the database. What it writes lands unconfirmed: confirming is the user's own action in the app.",
  "needs-ok":
    "Writes, and refuses without confirmedByUser: true. Show the user exactly what this will write and get an explicit yes first. Never set that flag on your own judgement.",
};

function describe(tool: ToolDefinition<never, unknown>): string {
  return `${tool.summary}\n\n${KIND_NOTE[tool.kind] ?? ""}`.trim();
}

export function createMcpServer(host: MiniHost): McpServer {
  const server = new McpServer(
    { name: "fellowship", version: "0.0.2" },
    {
      instructions: [
        "Fellowship tracks the people in one person's life: who they are, what they like, what to avoid, the occasions they shared, and how close each connection is.",
        "Search before you write. people_search returns the ids every other tool takes, and people_create makes a second row for a name that is already here.",
        "Nothing you write is confirmed. The user confirms, in the app.",
        "people_log_interaction returns unmatched names rather than inventing a person. Resolve them and call it again.",
        "A sketch holds observed behaviour with a quote or a number behind each claim. No diagnosis, no personality typing: those drafts are refused.",
      ].join(" "),
    },
  );

  for (const tool of host.api.tools) {
    server.registerTool(
      mcpName(tool.name),
      {
        title: tool.title,
        description: describe(tool),
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: tool.kind === "read",
          destructiveHint: tool.kind === "needs-ok",
        },
      },
      async (args: unknown) => {
        try {
          const result = await host.api.invoke(tool.name, args ?? {});
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          const message =
            error instanceof coreTools.ToolError
              ? `${error.code}: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
          };
        }
      },
    );
  }

  return server;
}

/** Opens the files, attaches to stdio, and stays up until the pipe closes. */
export async function runStdioServer(options: MiniHostOptions = {}): Promise<void> {
  const host = await startMiniHost(options);
  const server = createMcpServer(host);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await host.close().catch(() => undefined);
  };

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  await server.connect(transport);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runStdioServer().catch((error: unknown) => {
    // stdout is the protocol. Anything a human should read goes to stderr.
    process.stderr.write(
      `fellowship mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
