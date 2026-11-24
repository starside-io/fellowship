import type { z } from "zod";

import type { ModuleConfig } from "../config/index.js";
import type { HostPorts } from "../ports.js";
import type { Silo } from "../storage/client.js";

/**
 * One registry, two transports. POST /rpc and the stdio MCP server both come
 * through invokeTool, so they hit the same handlers with the same validation
 * and the same audit line. The UI gets no privileged path: anything it can do,
 * an assistant can do.
 */

export type ToolKind = "read" | "write" | "needs-ok";

export interface ToolContext {
  ports: HostPorts;
  db: Silo;
  config: ModuleConfig;
  /** Fixed for the whole call, so two reads inside one handler agree. */
  now: Date;
  /**
   * Runs another tool through the registry, validated and audited like any
   * call. This is how confirming a proposal runs the tool it proposed: no
   * handler reaches past the registry to another handler's body.
   */
  invoke(name: string, input: unknown): Promise<unknown>;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  /** Namespaced, as the manifest lists it: "people.search". */
  name: string;
  title: string;
  kind: ToolKind;
  summary: string;
  input: z.ZodType<Input, z.ZodTypeDef, unknown>;
  handler: (ctx: ToolContext, input: Input) => Promise<Output>;
  /** The person this call is about, for the audit line. */
  personIdOf?: (input: Input) => string | null | undefined;
}

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "not_found"
  | "refused"
  | "conflict"
  | "unavailable";

/** A refusal the caller can act on, as opposed to an unexpected failure. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly detail?: unknown;

  constructor(code: ToolErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

export interface ToolRegistry {
  readonly tools: readonly ToolDefinition<never, unknown>[];
  byName(name: string): ToolDefinition<never, unknown> | undefined;
  names(): string[];
}

export function createRegistry(
  definitions: readonly ToolDefinition<never, unknown>[],
): ToolRegistry {
  const byName = new Map<string, ToolDefinition<never, unknown>>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`Two tools are named "${definition.name}"`);
    }
    byName.set(definition.name, definition);
  }

  return {
    tools: definitions,
    byName: (name) => byName.get(name),
    names: () => [...byName.keys()],
  };
}

export interface InvokeOptions {
  /** Pinned by tests. Defaults to the moment the call starts. */
  now?: Date;
}

/**
 * Validate, run, audit. Every call is audited whatever its outcome, because an
 * attempt that was refused is the half worth being able to read back.
 */
export async function invokeTool(
  registry: ToolRegistry,
  ports: HostPorts,
  name: string,
  rawInput: unknown,
  options: InvokeOptions = {},
): Promise<unknown> {
  const tool = registry.byName(name);
  if (!tool) {
    throw new ToolError("unknown_tool", `No tool named "${name}"`);
  }

  const now = options.now ?? new Date();
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    await audit(ports, tool, now, null, { refused: "invalid_input" });
    throw new ToolError("invalid_input", `${tool.name} was called with invalid input`, {
      issues: parsed.error.issues,
    });
  }

  const input = parsed.data as never;
  const personId = tool.personIdOf?.(input) ?? null;
  const ctx: ToolContext = {
    ports,
    db: ports.storage.silo(),
    config: await ports.settings.get(),
    now,
    invoke: (next, nextInput) => invokeTool(registry, ports, next, nextInput, { now }),
  };

  try {
    const result = await tool.handler(ctx, input);
    await audit(ports, tool, now, personId, auditDetail(result));
    return result;
  } catch (error) {
    const code = error instanceof ToolError ? error.code : "failed";
    await audit(ports, tool, now, personId, { refused: code });
    throw error;
  }
}

/**
 * What goes in the audit line. Counts and ids only: no message text, no image
 * bytes, nothing that would make the log a second copy of the data.
 */
function auditDetail(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (typeof value === "number" || typeof value === "boolean") detail[key] = value;
    else if (Array.isArray(value)) detail[`${key}Count`] = value.length;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

async function audit(
  ports: HostPorts,
  tool: ToolDefinition<never, unknown>,
  at: Date,
  personId: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  await ports.audit.log({
    tool: tool.name,
    kind: tool.kind,
    personId,
    at,
    ...(detail ? { detail } : {}),
  });
}
