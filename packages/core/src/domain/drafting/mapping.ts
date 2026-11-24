import { zodToJsonSchema } from "zod-to-json-schema";

import type { Proposal } from "../../ports.js";
import { checkPersonality, checkSketch, explainFindings } from "../sketch-discipline.js";
import {
  DRAFT_SCHEMAS,
  type DraftJob,
  type FactDraft,
  type PersonalityDraft,
  type SenderMatchDraft,
  type SketchDraft,
} from "./schemas.js";
import { confidentMatches } from "./prompts.js";

/**
 * What becomes of an answer: proposals for the review queue, and the parts
 * that were dropped on the way, with the reason kept.
 */

/** The constrained decoding schema for a job, from the zod schema itself. */
export function jsonSchemaFor(job: DraftJob): Record<string, unknown> {
  // No name and no refs: an endpoint wants the object schema itself, and a
  // $ref into a definitions block is the shape half of them choke on.
  return zodToJsonSchema(DRAFT_SCHEMAS[job], {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
}

export interface DraftOutcome {
  /** What the review queue should show, in the order it should show it. */
  proposals: Proposal[];
  /** What was dropped before it got that far, and why. */
  rejected: Array<{ reason: string; detail?: unknown }>;
}

export interface SenderDraftContext {
  conversationId: string;
  /** Only these senders exist in that conversation. */
  knownSenders: Set<string>;
  /** Only these people exist in this silo. */
  knownPeople: Set<string>;
  displayNameById: Map<string, string>;
}

/**
 * Sender matches become one proposal each, because they are confirmed one at
 * a time: binding the wrong sender to a person rewrites who said what across
 * a whole chat, and the silo has no undo for that.
 */
export function senderProposals(
  draft: SenderMatchDraft,
  context: SenderDraftContext,
): DraftOutcome {
  const proposals: Proposal[] = [];
  const rejected: DraftOutcome["rejected"] = [];

  for (const match of confidentMatches(draft.matches)) {
    const personId = match.personId as string;

    // A model that answers with an id nobody has is answering about a person
    // that does not exist, which is the one thing it was told not to do.
    if (!context.knownPeople.has(personId)) {
      rejected.push({
        reason: "that personId is not in this silo",
        detail: { senderName: match.senderName, personId },
      });
      continue;
    }
    if (!context.knownSenders.has(match.senderName)) {
      rejected.push({
        reason: "that sender is not in this conversation",
        detail: { senderName: match.senderName },
      });
      continue;
    }

    proposals.push({
      tool: "people.map_sender",
      personId,
      payload: {
        conversationId: context.conversationId,
        senderName: match.senderName,
        personId,
      },
      summary: `Map "${match.senderName}" to ${
        context.displayNameById.get(personId) ?? personId
      } (${match.confidence}): ${match.evidence}`,
    });
  }

  for (const match of draft.matches) {
    if (match.personId === null) {
      rejected.push({
        reason: "the model could not tell who this is",
        detail: { senderName: match.senderName },
      });
    } else if (match.confidence === "low") {
      rejected.push({
        reason: "too low a confidence to be worth confirming",
        detail: { senderName: match.senderName, evidence: match.evidence },
      });
    }
  }

  return { proposals, rejected };
}

export interface FactDraftContext {
  personId: string;
  displayName: string;
  /** The field keys this silo defines. An update to anything else is dropped. */
  fieldKeys: Set<string>;
}

/** Person columns that hold a date, which a fact must give as YYYY-MM-DD. */
const DATE_FIELDS = new Set(["birthday", "metOn"]);

/** Person columns a fact may set. Anything else is a custom field or nothing. */
const PERSON_FIELDS = new Set(["location", "howWeMet", "birthday", "metOn", "firstName", "lastName"]);

/**
 * Extracted facts become one proposal per tool, so confirming "the tags" does
 * not also confirm a contact handle nobody looked at.
 */
export function factProposals(draft: FactDraft, context: FactDraftContext): DraftOutcome {
  const proposals: Proposal[] = [];
  const rejected: DraftOutcome["rejected"] = [];

  const patch: Record<string, string> = {};
  /** The words each field came from, so the reviewer sees the evidence beside the value. */
  const quotes: Record<string, string> = {};
  const custom: Array<{ key: string; value: string }> = [];
  const tags: Record<"interest" | "allergy" | "dislike", string[]> = {
    interest: [],
    allergy: [],
    dislike: [],
  };
  const contacts: Array<{ kind: string; value: string }> = [];
  const notes: string[] = [];

  for (const fact of draft.facts) {
    if (fact.confidence === "low") {
      rejected.push({ reason: "too low a confidence", detail: fact });
      continue;
    }

    switch (fact.kind) {
      case "update": {
        const field = fact.field ?? "";
        if (DATE_FIELDS.has(field) && !/^\d{4}-\d{2}-\d{2}$/.test(fact.value.trim())) {
          // "12/09" is the 12th of September or the 9th of December depending
          // on who wrote it. Only an ISO date says which.
          rejected.push({ reason: `${field} must be a YYYY-MM-DD date`, detail: fact });
          break;
        }
        if (PERSON_FIELDS.has(field)) {
          patch[field] = fact.value.trim();
          quotes[field] = fact.quote;
        }
        else if (context.fieldKeys.has(field)) custom.push({ key: field, value: fact.value });
        else rejected.push({ reason: `no field called "${field}"`, detail: fact });
        break;
      }
      case "interest":
      case "allergy":
      case "dislike":
        tags[fact.kind].push(fact.value);
        break;
      case "contact": {
        const kind = (fact.field ?? "OTHER").toUpperCase();
        contacts.push({
          kind: ["EMAIL", "PHONE", "SOCIAL", "OTHER"].includes(kind) ? kind : "OTHER",
          value: fact.value,
        });
        break;
      }
      case "note":
        notes.push(`${fact.value}\n\nFrom: "${fact.quote}"`);
        break;
    }
  }

  if (Object.keys(patch).length > 0) {
    proposals.push({
      tool: "people.update",
      personId: context.personId,
      payload: { personId: context.personId, patch },
      summary: `Set ${Object.entries(patch)
        .map(([field, value]) => `${field} to "${value}" (quote: "${quotes[field]}")`)
        .join(", ")} on ${context.displayName}`,
    });
  }

  if (custom.length > 0) {
    proposals.push({
      tool: "people.set_custom_values",
      personId: context.personId,
      payload: { personId: context.personId, values: custom },
      summary: `Set ${custom.map((entry) => entry.key).join(", ")} on ${context.displayName}`,
    });
  }

  const anyTags = tags.interest.length + tags.allergy.length + tags.dislike.length > 0;
  if (anyTags) {
    proposals.push({
      tool: "people.set_tags",
      personId: context.personId,
      payload: {
        personId: context.personId,
        ...(tags.interest.length > 0 ? { interests: tags.interest } : {}),
        ...(tags.allergy.length > 0 ? { allergies: tags.allergy } : {}),
        ...(tags.dislike.length > 0 ? { dislikes: tags.dislike } : {}),
      },
      // Allergies are named first on purpose: they are the half of this that
      // can hurt someone if it is wrong.
      summary: [
        tags.allergy.length > 0 ? `allergies: ${tags.allergy.join(", ")}` : "",
        tags.dislike.length > 0 ? `dislikes: ${tags.dislike.join(", ")}` : "",
        tags.interest.length > 0 ? `interests: ${tags.interest.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  if (contacts.length > 0) {
    proposals.push({
      tool: "people.set_contacts",
      personId: context.personId,
      payload: {
        personId: context.personId,
        contacts: contacts.map((contact) => ({
          kind: contact.kind,
          value: contact.value,
          // Written by a model, so it carries that rather than passing as a
          // value the owner typed.
          source: "ASSISTANT",
        })),
      },
      summary: `Add ${contacts.map((contact) => contact.value).join(", ")} to ${
        context.displayName
      }`,
    });
  }

  for (const note of notes) {
    proposals.push({
      tool: "people.add_note",
      personId: context.personId,
      payload: {
        personId: context.personId,
        body: {
          type: "doc",
          content: note.split("\n\n").map((paragraph) => ({
            type: "paragraph",
            content: [{ type: "text", text: paragraph }],
          })),
        },
      },
      summary: `Note on ${context.displayName}: ${note.split("\n")[0] ?? ""}`,
    });
  }

  for (const line of draft.unplaced) {
    rejected.push({ reason: "nothing in the records takes this", detail: line });
  }

  return { proposals, rejected };
}

export interface SketchDraftContext {
  personId: string;
  displayName: string;
}

/**
 * A sketch becomes one proposal, and only if it passes the same discipline
 * check the tool applies. Refusing here rather than at confirmation time means
 * the owner never reads a diagnosis in their own review queue.
 */
export function sketchProposals(
  draft: SketchDraft,
  context: SketchDraftContext,
): DraftOutcome {
  const findings = checkSketch(draft);
  if (findings.length > 0) {
    return {
      proposals: [],
      rejected: [{ reason: explainFindings(findings), detail: { findings } }],
    };
  }

  return {
    proposals: [
      {
        tool: "people.write_sketch",
        personId: context.personId,
        payload: { personId: context.personId, ...draft, source: "ASSISTANT" },
        summary: `A sketch of ${context.displayName}, from ${draft.sources.length} ${
          draft.sources.length === 1 ? "source" : "sources"
        }`,
      },
    ],
    rejected: [],
  };
}


export interface PersonalityDraftContext {
  personId: string;
  displayName: string;
}

/**
 * One proposal for the whole radar. The evidence goes through the same
 * discipline as a sketch, so a score cannot carry a diagnosis in its reason.
 */
export function personalityProposals(
  draft: PersonalityDraft,
  context: PersonalityDraftContext,
): DraftOutcome {
  const findings = checkPersonality(draft.scores);
  if (findings.length > 0) {
    return {
      proposals: [],
      rejected: [{ reason: explainFindings(findings), detail: { findings } }],
    };
  }

  return {
    proposals: [
      {
        tool: "people.set_personality",
        personId: context.personId,
        payload: { personId: context.personId, scores: draft.scores, sources: draft.sources },
        summary: `A personality radar for ${context.displayName}, ${draft.scores.length} axes from ${
          draft.sources.length
        } ${draft.sources.length === 1 ? "source" : "sources"}`,
      },
    ],
    rejected: [],
  };
}
