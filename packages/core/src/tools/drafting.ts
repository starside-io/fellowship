import { z } from "zod";

import {
  DraftError,
  buildDraftContext,
  proposeDraft,
  type DraftTarget,
} from "../domain/drafting/index.js";
import { idSchema } from "../schemas/common.js";
import { defineTool, ToolError, type ToolDefinition } from "./registry.js";

/**
 * Drafting with whatever model is driving.
 *
 * The module never calls a model. An assistant, whichever model it runs on,
 * asks for the context, reasons over it, and proposes an answer back. The
 * answer is checked against the same schema and the same rules whoever wrote
 * it, and lands in the review queue. A person confirming it is the only thing
 * that writes.
 *
 *   people.draft_context   the material, the rules and the schema
 *   people.propose_draft   the answer, validated and queued
 *   people.review          what is waiting
 *   people.decide          a person's yes or no, and the write that follows a yes
 */

const targetSchema = z.discriminatedUnion("job", [
  z.object({ job: z.literal("senders"), conversationId: idSchema }),
  z.object({
    job: z.literal("facts"),
    personId: idSchema,
    text: z.string().trim().min(1, "Expected the text to read").max(50_000),
  }),
  z.object({
    job: z.literal("sketch"),
    personId: idSchema,
    /** How many messages to read. The model's context window is the limit. */
    messageLimit: z.number().int().min(0).max(2000).optional(),
  }),
  z.object({
    job: z.literal("personality"),
    personId: idSchema,
    /** How many messages to read. The model's context window is the limit. */
    messageLimit: z.number().int().min(0).max(2000).optional(),
  }),
  z.object({
    job: z.literal("recap"),
    conversationId: idSchema,
    /** Read after this instant. Defaults to where the last recap of this chat stopped. */
    since: z.string().datetime({ offset: true }).optional(),
    /** Read up to this instant. people.draft_context sets it; pass its target back as is. */
    through: z.string().datetime({ offset: true }).optional(),
    /** Messages per window. The model's context window is the limit. */
    messageLimit: z.number().int().min(1).max(4000).optional(),
  }),
]);

function personIdOf(target: z.infer<typeof targetSchema>): string | null {
  return "personId" in target ? target.personId : null;
}

/** A draft error is the caller's to fix, not a failure of the module. */
function asToolError(error: unknown): never {
  if (error instanceof DraftError) {
    throw new ToolError(
      /No (person|conversation)/.test(error.message) ? "not_found" : "invalid_input",
      error.message,
      error.detail,
    );
  }
  throw error;
}

export const draftContextTool = defineTool({
  name: "people.draft_context",
  title: "Get drafting context",
  kind: "read",
  summary:
    "The material, the rules and the JSON schema for one drafting job: matching chat senders, reading facts out of text, sketching a person, scoring a person's personality radar from their chats, or recapping a chat (new events, likes, dislikes and allergies since the last recap). Reason over it, then hand the answer to people.propose_draft.",
  input: targetSchema,
  personIdOf,
  async handler(ctx, input) {
    try {
      const context = await buildDraftContext(
        ctx.db,
        ctx.config,
        input as DraftTarget,
        ctx.ports.review,
      );
      return {
        ...context,
        next: context.target
          ? "Answer with JSON that fits schema, then call people.propose_draft with target exactly as given here and your answer as draft. Nothing is written until the owner confirms it in review."
          : "Answer with JSON that fits schema, then call people.propose_draft with the same target and your answer as draft. Nothing is written until the owner confirms it in review.",
      };
    } catch (error) {
      asToolError(error);
    }
  },
});

export const proposeDraftTool = defineTool({
  name: "people.propose_draft",
  title: "Propose a draft",
  kind: "write",
  summary:
    "Hands back an answer to people.draft_context. It is validated against the same schema, checked for invented people and fields and for diagnosis, and what survives waits in the review queue. Nothing reaches the records until the owner confirms it.",
  input: z.object({
    target: targetSchema,
    draft: z.unknown(),
  }),
  personIdOf: (input) => personIdOf(input.target),
  async handler(ctx, input) {
    try {
      const result = await proposeDraft(
        ctx.db,
        ctx.ports.review,
        input.target as DraftTarget,
        input.draft,
        ctx.config,
        ctx.now,
      );
      return {
        queued: result.queued.map((entry) => ({
          id: entry.id,
          tool: entry.proposal.tool,
          summary: entry.proposal.summary ?? null,
        })),
        group: result.queued[0]?.proposal.group
          ? {
              id: result.queued[0].proposal.group.id,
              title: result.queued[0].proposal.group.title,
              detail: result.queued[0].proposal.group.detail ?? null,
            }
          : null,
        rejected: result.rejected,
        written: false as const,
      };
    } catch (error) {
      asToolError(error);
    }
  },
});

export const reviewTool = defineTool({
  name: "people.review",
  title: "Review queue",
  kind: "read",
  summary:
    "What is waiting for the owner's yes: each proposal names the tool it would run and the payload it would run with.",
  input: z
    .object({
      state: z.enum(["pending", "confirmed", "discarded", "all"]).default("pending"),
    })
    .default({}),
  async handler(ctx, input) {
    const proposals = await ctx.ports.review.list(input.state);
    return { proposals };
  },
});

/**
 * Tools a proposal may not name. Deciding or proposing from inside a proposal
 * would let a draft confirm another draft, which is the one loop this whole
 * arrangement exists to rule out.
 */
const NOT_PROPOSABLE = new Set(["people.decide", "people.propose_draft"]);

export const decideTool = defineTool({
  name: "people.decide",
  title: "Confirm or discard a proposal",
  kind: "needs-ok",
  summary:
    "Records the owner's decision on one proposal. Confirming runs the tool it names with the payload they read; discarding runs nothing. Only call this after the owner has said yes or no to that exact proposal.",
  input: z.object({
    proposalId: z.string().trim().min(1),
    decision: z.enum(["confirm", "discard"]),
    confirmedByUser: z.literal(true, {
      errorMap: () => ({
        message:
          "confirmedByUser must be true. Show the owner the proposal and get their decision first.",
      }),
    }),
  }),
  async handler(ctx, input) {
    const proposal = await ctx.ports.review.get(input.proposalId);
    if (!proposal) {
      throw new ToolError("not_found", `No proposal with id "${input.proposalId}"`);
    }
    if (proposal.state !== "pending") {
      throw new ToolError("conflict", `That proposal is already ${proposal.state}.`);
    }

    if (input.decision === "discard") {
      await ctx.ports.review.decide(proposal.id, "discarded");
      return { proposalId: proposal.id, state: "discarded" as const, written: false };
    }

    if (NOT_PROPOSABLE.has(proposal.tool)) {
      throw new ToolError("refused", `A proposal cannot run ${proposal.tool}.`);
    }

    const payload =
      proposal.payload && typeof proposal.payload === "object"
        ? (proposal.payload as Record<string, unknown>)
        : {};

    // The tool runs before the row is marked. A refusal leaves the proposal
    // pending, because a write that did not happen is not a decision made. It
    // comes back as this tool's refusal, with the inner one beside it: a
    // not_found from the proposed write is not "no such proposal".
    let result: unknown;
    try {
      result = await ctx.invoke(proposal.tool, { ...payload, confirmedByUser: true });
    } catch (error) {
      if (error instanceof ToolError) {
        throw new ToolError(
          "refused",
          `The proposed ${proposal.tool} was refused, so nothing was written: ${error.message}`,
          { proposalId: proposal.id, code: error.code, detail: error.detail },
        );
      }
      throw error;
    }

    await ctx.ports.review.decide(proposal.id, "confirmed");
    return { proposalId: proposal.id, state: "confirmed" as const, written: true, result };
  },
});

export const draftingTools: ToolDefinition<never, unknown>[] = [
  draftContextTool,
  proposeDraftTool,
  reviewTool,
  decideTool,
] as unknown as ToolDefinition<never, unknown>[];
