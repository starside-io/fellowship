export { activate, type ModuleApi } from "./activate.js";
export * from "./ports.js";
export { surfaceFingerprint } from "./fingerprint.js";

// The two types a host needs by name, lifted to the entry so it does not have
// to reach into a namespace for them.
export type { ModuleConfig } from "./config/index.js";
export type { Silo } from "./storage/client.js";
export type {
  ToolContext,
  ToolDefinition,
  ToolKind,
} from "./tools/registry.js";

export * as config from "./config/index.js";
export * as domain from "./domain/index.js";
export * as schemas from "./schemas/index.js";
export * as storage from "./storage/index.js";
export * as tools from "./tools/index.js";
