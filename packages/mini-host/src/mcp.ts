import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { tools as coreTools } from "@fellowship/core";
import type { ToolDefinition } from "@fellowship/core";

import { startMiniHost, type MiniHost, type MiniHostOptions } from "./host.js";
import { desktopAppStatus, installDesktopApp, openDesktopApp } from "./desktop-app.js";
import { advertisedSchema } from "./mcp-schema.js";
import { FELLOWSHIP_VERSION } from "./version.js";

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

/** Seams for the desktop app tools, so a test downloads and opens nothing. */
export interface McpServerOptions {
  app?: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    unzip?: (zip: string, into: string) => Promise<void>;
    supported?: boolean;
    open?: () => Promise<void>;
  };
}

export function createMcpServer(host: MiniHost, options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "fellowship", version: FELLOWSHIP_VERSION },
    {
      instructions: [
        "Fellowship tracks the people in one person's life: who they are, what they like, what to avoid, the occasions they shared, and how close each connection is.",
        "Search before you write. people_search returns the ids every other tool takes, and people_create makes a second row for a name that is already here.",
        "Nothing you write is confirmed. The user confirms, in the app.",
        "people_log_interaction returns unmatched names rather than inventing a person. Resolve them and call it again.",
        "A sketch holds observed behaviour with a quote or a number behind each claim. No diagnosis, no personality typing: those drafts are refused.",
        "To open the Fellowship window, call app_open. app_install downloads the desktop app, and only after the user said yes.",
      ].join(" "),
    },
  );

  for (const tool of host.api.tools) {
    server.registerTool(
      mcpName(tool.name),
      {
        title: tool.title,
        description: describe(tool),
        inputSchema: advertisedSchema(tool.input as never),
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

  registerAppTools(server, options.app ?? {});
  return server;
}

function text(value: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Fellowship.app, from a chat. A client that only speaks MCP, such as the
 * Claude desktop app, has no slash commands, so /fellowship:open cannot run
 * there. These three do the same job. They belong to this server rather than
 * to the people module: the module never reaches the network, and installing
 * is a download from the GitHub release, made only after the user said yes.
 */
function registerAppTools(server: McpServer, seams: NonNullable<McpServerOptions["app"]>): void {
  const env = seams.env ?? process.env;
  // The app that matches the code answering here, not whatever plugin record is on disk.
  const available = () => FELLOWSHIP_VERSION;
  const status = () => {
    const app = desktopAppStatus(env);
    const supported = seams.supported ?? app.supported;
    return {
      ...app,
      supported,
      available: available(),
      behind: app.version !== null && app.version !== available(),
    };
  };

  server.registerTool(
    "app_status",
    {
      title: "Desktop app status",
      description:
        "Whether Fellowship.app is installed on this Mac, which version, and which version an install or update would bring. Reads nothing from the network.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => text(status()),
  );

  server.registerTool(
    "app_install",
    {
      title: "Install or update the desktop app",
      description:
        "Downloads Fellowship.app (about 110 MB) from the GitHub release matching this server's version, checks it against the published SHA-256, and puts it in ~/Applications, replacing an older copy. Apple Silicon Macs only. Call it only after the user said yes to this download in the conversation, and set confirmedByUser: true.",
      inputSchema: z.object({ confirmedByUser: z.literal(true) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const result = await installDesktopApp({
        version: available(),
        env,
        ...(seams.fetch ? { fetch: seams.fetch } : {}),
        ...(seams.unzip ? { unzip: seams.unzip } : {}),
        ...(seams.supported === undefined ? {} : { supported: seams.supported }),
      });
      return text(result, !result.ok);
    },
  );

  server.registerTool(
    "app_open",
    {
      title: "Open the desktop app",
      description:
        "Opens Fellowship.app. When it is not installed, or older than this version, it says so: ask the user, then call app_install with confirmedByUser: true.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async () => {
      const app = status();
      if (!app.supported) {
        return text({
          opened: false,
          message:
            "The desktop app is built for Apple Silicon Macs only. Run `fellowship serve` and open http://localhost:4319 in a browser instead.",
        });
      }
      if (app.version === null) {
        return text({
          opened: false,
          message: `Fellowship.app is not installed. Ask the user whether to download it (about 110 MB, version ${app.available}), then call app_install with confirmedByUser: true.`,
        });
      }
      try {
        await (seams.open ?? (() => openDesktopApp(env)))();
      } catch (error) {
        return text(
          { opened: false, message: `Could not open ${app.path}: ${error instanceof Error ? error.message : String(error)}` },
          true,
        );
      }
      return text({
        opened: true,
        version: app.version,
        message: app.behind
          ? `Opened Fellowship.app ${app.version}. Version ${app.available} is available: offer to update it with app_install.`
          : `Opened Fellowship.app ${app.version}.`,
      });
    },
  );
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
