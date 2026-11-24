import { z } from "zod";

import { EventType } from "../../schemas/enums.js";
import { personProfileInputSchema } from "../../schemas/person-profile.js";
import { personalityScoresSchema } from "../../schemas/personality.js";

/**
 * What the model is allowed to answer with.
 *
 * Every one of these is handed to the endpoint as a JSON schema for
 * constrained decoding and used again to parse the answer, because a server
 * that ignores the field fails silently otherwise. The schema is the contract
 * in both directions, which is the only way the two cannot drift.
 *
 * None of this writes anything. A draft becomes a proposal, and a proposal
 * becomes a write when a person says so.
 */

export const confidenceSchema = z.enum(["high", "medium", "low"]);

/* ---------------------------------------------------------------- senders */

export const senderMatchSchema = z.object({
  senderName: z.string().trim().min(1).max(200),
  /** The person this sender is, or null when the model cannot tell. */
  personId: z.string().uuid().nullable(),
  confidence: confidenceSchema,
  /**
   * What in the messages says so. A match with no reason is a guess, and a
   * guess that maps a stranger onto a friend quietly poisons every figure
   * downstream.
   */
  evidence: z.string().trim().min(10).max(400),
});

export const senderMatchDraftSchema = z.object({
  matches: z.array(senderMatchSchema).max(50),
});

export type SenderMatch = z.infer<typeof senderMatchSchema>;
export type SenderMatchDraft = z.infer<typeof senderMatchDraftSchema>;

/* ------------------------------------------------------------------ facts */

export const factSchema = z.object({
  /**
   * Which tool would write it. The extraction does not get to invent a place
   * to put something: it chooses from the surface that already exists.
   */
  kind: z.enum(["update", "interest", "allergy", "dislike", "contact", "note"]),
  /** For an update: the Person field. For a contact: the channel kind. */
  field: z.string().trim().min(1).max(80).optional(),
  value: z.string().trim().min(1).max(2000),
  /** The words it came from, quoted. */
  quote: z.string().trim().min(1).max(500),
  confidence: confidenceSchema,
});

export const factDraftSchema = z.object({
  facts: z.array(factSchema).max(40),
  /** What the text said that has nowhere to go, rather than being forced. */
  unplaced: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
});

export type Fact = z.infer<typeof factSchema>;
export type FactDraft = z.infer<typeof factDraftSchema>;

/* ----------------------------------------------------------------- sketch */

/**
 * The sketch shape, with the one rule a prompt only ever requests: sources is
 * required and non-empty. A sketch with no stated sources is a horoscope, and
 * a schema enforces that where a sentence in a prompt does not.
 */
export const sketchDraftSchema = personProfileInputSchema
  .extend({
    summary: z.string().trim().min(40).max(2000),
    sources: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  })
  .strip();

export type SketchDraft = z.infer<typeof sketchDraftSchema>;

/* ------------------------------------------------------------ personality */

/**
 * The radar. Fixed axes, a score and the evidence behind each one, and the
 * sources read, so the chart says what it was drawn from.
 */
export const personalityDraftSchema = z.object({
  scores: personalityScoresSchema,
  sources: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
});

export type PersonalityDraft = z.infer<typeof personalityDraftSchema>;

/* ------------------------------------------------------------------ recap */

const quoteSchema = z.string().trim().min(1).max(500);

export const recapEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: EventType,
  /** The day it happened, YYYY-MM-DD, or a full timestamp. */
  occurredAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/, "Expected a date, YYYY-MM-DD"),
  location: z.string().trim().min(1).max(200).nullish(),
  /** Everyone who was there, from the people listed. A mention is not presence. */
  participantIds: z.array(z.string().uuid()).min(1).max(30),
  sentiment: z.number().int().min(-2).max(2),
  weight: z.number().int().min(1).max(3),
  /** The words that say it happened, quoted from the messages. */
  quote: quoteSchema,
  confidence: confidenceSchema,
});

export const recapPreferenceSchema = z.object({
  kind: z.enum(["interest", "dislike", "allergy"]),
  /** Who it is about. One of the people listed. */
  personId: z.string().uuid(),
  value: z.string().trim().min(1).max(80),
  quote: quoteSchema,
  confidence: confidenceSchema,
});

export const recapDraftSchema = z.object({
  /** What happened over the window, in a few sentences. */
  summary: z.string().trim().min(20).max(2000),
  events: z.array(recapEventSchema).max(40).default([]),
  preferences: z.array(recapPreferenceSchema).max(40).default([]),
});

export type RecapEvent = z.infer<typeof recapEventSchema>;
export type RecapPreference = z.infer<typeof recapPreferenceSchema>;
export type RecapDraft = z.infer<typeof recapDraftSchema>;

/* ------------------------------------------------------------------ jobs */

export const DRAFT_JOBS = ["senders", "facts", "sketch", "personality", "recap"] as const;
export type DraftJob = (typeof DRAFT_JOBS)[number];

export const DRAFT_SCHEMAS = {
  senders: senderMatchDraftSchema,
  facts: factDraftSchema,
  sketch: sketchDraftSchema,
  personality: personalityDraftSchema,
  recap: recapDraftSchema,
} as const;
