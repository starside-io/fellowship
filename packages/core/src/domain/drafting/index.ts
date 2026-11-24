/**
 * Drafting: what any model is asked, what it may answer, and what becomes of
 * the answer.
 *
 * The answer becomes a proposal. Not a row, not a patch applied in the
 * background: a line in the review queue naming the tool that would run and
 * the payload it would run with, which a person confirms or discards. The
 * model proposes; it never confirms, and the module never calls one itself.
 */
export * from "./context.js";
export * from "./mapping.js";
export * from "./prompts.js";
export * from "./recap.js";
export * from "./schemas.js";
