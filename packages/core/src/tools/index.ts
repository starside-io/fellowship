import { createRegistry, type ToolDefinition } from "./registry.js";
import { confirmTools } from "./confirm.js";
import { draftingTools } from "./drafting.js";
import { readTools } from "./read.js";
import { writeTools } from "./write.js";

export * from "./registry.js";
export { readTools } from "./read.js";
export { writeTools } from "./write.js";
export { confirmTools } from "./confirm.js";
export { draftingTools } from "./drafting.js";

/**
 * The whole tool surface: 15 read, 16 write, 5 that need the owner's yes.
 *
 * The four drafting tools are what make the module model agnostic: any model
 * behind any assistant drafts through them, and none is built in.
 */
export const allTools: readonly ToolDefinition<never, unknown>[] = [
  ...readTools,
  ...writeTools,
  ...confirmTools,
  ...draftingTools,
];

export const registry = createRegistry(allTools);
