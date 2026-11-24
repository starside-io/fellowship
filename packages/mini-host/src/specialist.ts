import { tools as coreTools } from "@fellowship/core";

import type { MiniHost } from "./host.js";

/**
 * The built in drafter: one optional adapter, for the standalone app when no
 * assistant is attached.
 *
 * It does exactly what any assistant does through MCP, in the same two calls:
 * people.draft_context for the material, the rules and the schema, then
 * people.propose_draft with the answer. The only thing it adds is the model in
 * between, reached through the models port. Swap the port for another
 * endpoint, or never configure one and draft from an assistant instead: the
 * module does not care which model wrote the answer, and checks every one the
 * same way.
 */

export type DraftJob = "senders" | "facts" | "sketch";

export type DraftTarget =
  | { job: "senders"; conversationId: string }
  | { job: "facts"; personId: string; text: string }
  | { job: "sketch"; personId: string; messageLimit?: number };

export interface DraftResult {
  job: DraftJob;
  queued: Array<{ id: string; tool: string; summary: string | null }>;
  rejected: Array<{ reason: string; detail?: unknown }>;
  /** How long the model took, which is the number people ask about. */
  tookMs: number;
}

export class DraftError extends Error {
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "DraftError";
    this.detail = detail;
  }
}

/** Some endpoints wrap JSON in a fenced block whatever they were asked. */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

export async function draft(host: MiniHost, target: DraftTarget): Promise<DraftResult> {
  let context: { system: string; prompt: string; schema: Record<string, unknown> };
  try {
    context = (await host.api.invoke("people.draft_context", target)) as typeof context;
  } catch (error) {
    if (error instanceof coreTools.ToolError) {
      throw new DraftError(error.message, error.detail);
    }
    throw error;
  }

  const started = Date.now();
  const answer = await host.ports.models.complete({
    system: context.system,
    prompt: context.prompt,
    schema: context.schema,
    temperature: 0.2,
  });
  const tookMs = Date.now() - started;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(answer.text));
  } catch {
    throw new DraftError(
      "The model did not answer with JSON. Its schema was passed as constrained decoding, so either the endpoint ignored it or the model is not up to the job.",
      { text: answer.text.slice(0, 400) },
    );
  }

  try {
    const proposed = (await host.api.invoke("people.propose_draft", {
      target,
      draft: parsed,
    })) as Pick<DraftResult, "queued" | "rejected">;

    return { job: target.job, ...proposed, tookMs };
  } catch (error) {
    if (error instanceof coreTools.ToolError) {
      throw new DraftError(error.message, error.detail);
    }
    throw error;
  }
}

export const draftSketch = (
  host: MiniHost,
  personId: string,
  options: { messageLimit?: number } = {},
) =>
  draft(host, {
    job: "sketch",
    personId,
    ...(options.messageLimit === undefined ? {} : { messageLimit: options.messageLimit }),
  });

export const draftSenders = (host: MiniHost, conversationId: string) =>
  draft(host, { job: "senders", conversationId });

export const draftFacts = (host: MiniHost, personId: string, text: string) =>
  draft(host, { job: "facts", personId, text });
