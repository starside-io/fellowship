import type { HostPorts } from "./ports.js";
import {
  invokeTool,
  registry,
  type InvokeOptions,
  type ToolDefinition,
  type ToolKind,
} from "./tools/index.js";

/**
 * What a host gets when it installs this module. The ports go in, a tool
 * surface comes out, and nothing else crosses the boundary.
 */
export interface ModuleApi {
  /** Every tool, with its zod input schema, for a transport to register. */
  readonly tools: readonly ToolDefinition<never, unknown>[];
  /** Name, title, kind and one line each. No schemas, for a listing. */
  describe(): Array<{ name: string; title: string; kind: ToolKind; summary: string }>;
  invoke(name: string, input: unknown, options?: InvokeOptions): Promise<unknown>;
}

export function activate(ports: HostPorts): ModuleApi {
  return {
    tools: registry.tools,
    describe: () =>
      registry.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        kind: tool.kind,
        summary: tool.summary,
      })),
    invoke: (name, input, options) => invokeTool(registry, ports, name, input, options),
  };
}
