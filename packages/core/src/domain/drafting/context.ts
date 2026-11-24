import type { ModuleConfig } from "../../config/index.js";
import type { Proposal, ReviewPort } from "../../ports.js";
import type { Silo } from "../../storage/client.js";
import { getPersonChatInsights } from "../chat-insights.js";
import { getPersonInsights } from "../insights.js";
import {
  DRAFT_SCHEMAS,
  type DraftJob,
  type FactDraft,
  type PersonalityDraft,
  type SenderMatchDraft,
  type SketchDraft,
} from "./schemas.js";
import { factPrompt, personalityPrompt, senderPrompt, sketchPrompt } from "./prompts.js";
import {
  factProposals,
  jsonSchemaFor,
  personalityProposals,
  senderProposals,
  sketchProposals,
} from "./mapping.js";
import {
  RecapError,
  buildRecapContext,
  recapProposals,
  type RecapTarget,
} from "./recap.js";
import type { RecapDraft } from "./schemas.js";

/**
 * Drafting without a model.
 *
 * The module never calls one. Whatever model is driving it, Claude behind an
 * assistant, GPT behind another, a local model behind the standalone app,
 * asks for the context, does the thinking, and hands the answer back. The
 * module supplies the material and the rules on the way out and enforces them
 * on the way in, so every model meets the same gates and none of them is the
 * one this library was written for.
 */

export type DraftTarget =
  | { job: "senders"; conversationId: string }
  | { job: "facts"; personId: string; text: string }
  | { job: "sketch"; personId: string; messageLimit?: number }
  | { job: "personality"; personId: string; messageLimit?: number }
  | RecapTarget;

export interface DraftContext {
  job: DraftJob;
  /** What to tell the model about how to behave. */
  system: string;
  /** The material itself, as text a model reads. */
  prompt: string;
  /** The JSON schema the answer must fit. Pass it as constrained decoding where the model supports it. */
  schema: Record<string, unknown>;
  /** How much was read, so a caller can say so. */
  material: Record<string, number>;
  /**
   * The exact target to hand back to people.propose_draft, where the job
   * reads a window that would otherwise move between the two calls.
   */
  target?: DraftTarget;
}

export class DraftError extends Error {
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "DraftError";
    this.detail = detail;
  }
}

export async function buildDraftContext(
  db: Silo,
  config: ModuleConfig,
  target: DraftTarget,
  review?: ReviewPort,
): Promise<DraftContext> {
  switch (target.job) {
    case "recap":
      if (!review) throw new DraftError("A recap needs the review queue.");
      return withRecapErrors(() => buildRecapContext(db, review, target));
    case "senders":
      return senderContext(db, target.conversationId);
    case "facts":
      return factContext(db, target.personId, target.text);
    case "sketch":
      return sketchContext(db, config, target.personId, target.messageLimit ?? 300);
    case "personality":
      return personalityContext(db, config, target.personId, target.messageLimit ?? 400);
  }
}

async function senderContext(db: Silo, conversationId: string): Promise<DraftContext> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: true },
  });
  if (!conversation) throw new DraftError("No conversation with that id.");

  const unmapped = conversation.participants
    .filter((participant) => participant.personId === null && !participant.isSelf)
    .sort((a, b) => b.messageCount - a.messageCount);

  const people = await db.person.findMany({
    where: { archived: false },
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
  });

  // A few lines each, oldest first, so the model reads how they talk rather
  // than the last thing they said.
  const samples = [];
  for (const participant of unmapped.slice(0, 10)) {
    const rows = await db.message.findMany({
      where: { conversationId, senderName: participant.senderName, isSystem: false },
      select: { senderName: true, body: true, sentAt: true },
      orderBy: { sentAt: "asc" },
      take: 6,
    });
    samples.push(
      ...rows.map((row) => ({
        senderName: row.senderName,
        body: row.body.slice(0, 200),
        sentAt: row.sentAt.toISOString().slice(0, 10),
      })),
    );
  }

  return {
    job: "senders",
    ...senderPrompt({
      conversationTitle: conversation.title,
      unmapped: unmapped.map((participant) => ({
        senderName: participant.senderName,
        messageCount: participant.messageCount,
      })),
      people,
      samples,
    }),
    schema: jsonSchemaFor("senders"),
    material: { unmapped: unmapped.length, people: people.length, samples: samples.length },
  };
}

async function factContext(db: Silo, personId: string, text: string): Promise<DraftContext> {
  const person = await db.person.findUnique({
    where: { id: personId },
    include: {
      interests: { select: { name: true } },
      allergies: { select: { name: true } },
      dislikes: { select: { name: true } },
    },
  });
  if (!person) throw new DraftError("No person with that id.");

  const fields = await db.fieldDefinition.findMany({
    select: { key: true, label: true, type: true },
    orderBy: { order: "asc" },
  });

  return {
    job: "facts",
    ...factPrompt({
      displayName: person.displayName,
      fields,
      known: {
        location: person.location,
        howWeMet: person.howWeMet,
        birthday: person.birthday ? person.birthday.toISOString().slice(0, 10) : null,
        interests: person.interests.map((tag) => tag.name),
        allergies: person.allergies.map((tag) => tag.name),
        dislikes: person.dislikes.map((tag) => tag.name),
      },
      text,
    }),
    schema: jsonSchemaFor("facts"),
    material: { characters: text.length, fields: fields.length },
  };
}

/**
 * What a sketch and a personality radar are both read from: the logged
 * history, the chat figures, the owner's notes and the most recent messages
 * between the owner and this person.
 */
async function personMaterial(
  db: Silo,
  config: ModuleConfig,
  personId: string,
  messageLimit: number,
) {
  const person = await db.person.findUnique({
    where: { id: personId },
    select: { id: true, displayName: true },
  });
  if (!person) throw new DraftError("No person with that id.");

  const [insights, chatInsights] = await Promise.all([
    getPersonInsights(db, personId),
    getPersonChatInsights(db, personId, { thresholds: config.chatThresholds }),
  ]);

  const notes = await db.note.findMany({
    where: { personId },
    select: { searchText: true },
    orderBy: { occurredAt: "desc" },
    take: 20,
  });

  const conversations = await db.conversation.findMany({
    where: { participants: { some: { personId } } },
    select: { id: true },
  });

  const messages =
    conversations.length === 0
      ? []
      : await db.message.findMany({
          where: {
            conversationId: { in: conversations.map((row) => row.id) },
            isSystem: false,
            OR: [{ personId }, { isFromSelf: true }],
          },
          select: { sentAt: true, isFromSelf: true, body: true },
          orderBy: { sentAt: "desc" },
          take: messageLimit,
        });

  const sourceHints = [
    `fellowship logged history, ${insights?.cadence.totalEvents ?? 0} occasions`,
    ...(messages.length > 0
      ? [`imported chats, ${messages.length} messages read of ${chatInsights?.messageCount ?? 0}`]
      : []),
    ...(notes.length > 0 ? [`${notes.length} notes written by the owner`] : []),
  ];

  return {
    prompt: {
      displayName: person.displayName,
      insights,
      chatInsights,
      // Oldest first, so the model reads the relationship in order.
      messages: messages.reverse().map((message) => ({
        sentAt: message.sentAt.toISOString().slice(0, 16).replace("T", " "),
        isFromSelf: message.isFromSelf,
        body: message.body.slice(0, 300),
      })),
      notes: notes.map((note) => note.searchText ?? "").filter((text) => text.length > 0),
      sourceHints,
    },
    material: {
      occasions: insights?.cadence.totalEvents ?? 0,
      messages: messages.length,
      notes: notes.length,
    },
  };
}

async function sketchContext(
  db: Silo,
  config: ModuleConfig,
  personId: string,
  messageLimit: number,
): Promise<DraftContext> {
  const { prompt, material } = await personMaterial(db, config, personId, messageLimit);
  return {
    job: "sketch",
    ...sketchPrompt(prompt),
    schema: jsonSchemaFor("sketch"),
    material,
  };
}

async function personalityContext(
  db: Silo,
  config: ModuleConfig,
  personId: string,
  messageLimit: number,
): Promise<DraftContext> {
  const { prompt, material } = await personMaterial(db, config, personId, messageLimit);
  return {
    job: "personality",
    ...personalityPrompt(prompt),
    schema: jsonSchemaFor("personality"),
    material,
  };
}

export interface ProposeResult {
  queued: Array<{ id: string; proposal: Proposal }>;
  rejected: Array<{ reason: string; detail?: unknown }>;
}

/**
 * The way back in. The answer is validated against the job's schema whatever
 * the model claims it enforced, the ids it names are checked against the silo
 * as it is now rather than as it was when the context was built, and what
 * survives goes to the review queue. Nothing here writes to the silo.
 */
export async function proposeDraft(
  db: Silo,
  review: ReviewPort,
  target: DraftTarget,
  answer: unknown,
  config?: ModuleConfig,
  now: Date = new Date(),
): Promise<ProposeResult> {
  const checked = DRAFT_SCHEMAS[target.job].safeParse(answer);
  if (!checked.success) {
    throw new DraftError("The draft is not in the shape the schema asks for.", {
      issues: checked.error.issues.slice(0, 10),
    });
  }

  const outcome =
    target.job === "recap"
      ? await withRecapErrors(() => {
          if (!config) throw new DraftError("A recap needs the module config to score.");
          return recapProposals(db, review, config, now, target, checked.data as RecapDraft);
        })
      : await outcomeFor(db, target, checked.data);

  const queued: ProposeResult["queued"] = [];
  for (const proposal of outcome.proposals) {
    const { id } = await review.propose(proposal);
    queued.push({ id, proposal });
  }

  return { queued, rejected: outcome.rejected };
}

/** A recap error is a draft error: the caller's to fix. */
async function withRecapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RecapError) throw new DraftError(error.message);
    throw error;
  }
}

async function outcomeFor(
  db: Silo,
  target: Exclude<DraftTarget, RecapTarget>,
  draft: unknown,
) {
  switch (target.job) {
    case "senders": {
      const conversation = await db.conversation.findUnique({
        where: { id: target.conversationId },
        include: { participants: { select: { senderName: true } } },
      });
      if (!conversation) throw new DraftError("No conversation with that id.");

      const people = await db.person.findMany({
        select: { id: true, displayName: true },
      });

      return senderProposals(draft as SenderMatchDraft, {
        conversationId: target.conversationId,
        knownSenders: new Set(conversation.participants.map((row) => row.senderName)),
        knownPeople: new Set(people.map((person) => person.id)),
        displayNameById: new Map(people.map((person) => [person.id, person.displayName])),
      });
    }

    case "facts": {
      const person = await db.person.findUnique({
        where: { id: target.personId },
        select: { displayName: true },
      });
      if (!person) throw new DraftError("No person with that id.");

      const fields = await db.fieldDefinition.findMany({ select: { key: true } });
      return factProposals(draft as FactDraft, {
        personId: target.personId,
        displayName: person.displayName,
        fieldKeys: new Set(fields.map((field) => field.key)),
      });
    }

    case "sketch": {
      const person = await db.person.findUnique({
        where: { id: target.personId },
        select: { displayName: true },
      });
      if (!person) throw new DraftError("No person with that id.");

      return sketchProposals(draft as SketchDraft, {
        personId: target.personId,
        displayName: person.displayName,
      });
    }

    case "personality": {
      const person = await db.person.findUnique({
        where: { id: target.personId },
        select: { displayName: true },
      });
      if (!person) throw new DraftError("No person with that id.");

      return personalityProposals(draft as PersonalityDraft, {
        personId: target.personId,
        displayName: person.displayName,
      });
    }
  }
}
