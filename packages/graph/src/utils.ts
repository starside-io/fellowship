/**
 * The graph's own arithmetic: which pairs exist, what each one scores at a
 * point in the past, how thick an edge is and how far apart two nodes sit.
 *
 * Pure, and tested as such. The canvas is a thin layer over this, so a bug in
 * what the picture says is a bug that a test can catch rather than something
 * only an eye on a screenshot would see.
 *
 * Ported from akai-ito with two changes: the payload types are this package's
 * own, since dates arrive as strings over the wire, and the score comes from
 * @fellowship/core, so the graph replays with exactly the formula the silo
 * cached.
 */

// The formula itself, not the module that owns a database client: a browser
// bundle has no business carrying a Prisma client because a graph needed to
// know what a score is.
import { computePairScore, type PairEvent } from "@fellowship/core/scoring";

import { readCanvasTokens, rgba, type Rgb } from "./canvas-tokens.js";
import type { GraphEvent, GraphLink, GraphPayload, GraphPerson } from "./payload.js";

/** The occasion kinds, in the words the rest of the app uses for them. */
const TYPE_LABELS: Record<string, string> = {
  HANGOUT: "Hangout",
  MEAL: "Meal",
  CALL: "Call",
  TRIP: "Trip",
  PARTY: "Party",
  WORK: "Work",
  FAVOUR: "Favour",
  CONFLICT: "Conflict",
  MILESTONE: "Milestone",
  OTHER: "Other",
};

export function eventTypeLabel(type: string): string {
  const known = TYPE_LABELS[type];
  if (known) return known;
  const lower = type.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** One event as seen from a single pair of people, with each side's override. */
export interface PairEventDatum extends PairEvent {
  type: string;
  overrideA: number | null;
  overrideB: number | null;
}

export interface PairIndexEntry {
  key: string;
  aId: string;
  bId: string;
  events: PairEventDatum[];
}

/**
 * Expands every event into one entry per participant pair. Participant
 * sentiment overrides are mapped to the pair side by person id, so overrideA
 * always belongs to aId.
 */
export function buildPairIndex(
  events: GraphEvent[],
  knownPeople: Set<string>,
): Map<string, PairIndexEntry> {
  const index = new Map<string, PairIndexEntry>();

  for (const event of events) {
    const occurredAt = toDate(event.occurredAt);
    if (!occurredAt) continue;

    const seen = new Set<string>();
    const participants = [];
    for (const participant of event.participants ?? []) {
      if (!participant?.personId) continue;
      if (seen.has(participant.personId)) continue;
      if (knownPeople.size > 0 && !knownPeople.has(participant.personId)) continue;
      seen.add(participant.personId);
      participants.push(participant);
    }
    if (participants.length < 2) continue;

    const sentiment = Number.isFinite(event.sentiment) ? event.sentiment : 0;
    const weight = Number.isFinite(event.weight) && event.weight > 0 ? event.weight : 1;

    for (let i = 0; i < participants.length; i += 1) {
      for (let j = i + 1; j < participants.length; j += 1) {
        const first = participants[i];
        const second = participants[j];
        const aFirst = first.personId < second.personId;
        const aSide = aFirst ? first : second;
        const bSide = aFirst ? second : first;
        const key = pairKey(first.personId, second.personId);

        let entry = index.get(key);
        if (!entry) {
          entry = { key, aId: aSide.personId, bId: bSide.personId, events: [] };
          index.set(key, entry);
        }
        entry.events.push({
          occurredAt,
          type: event.type,
          sentiment,
          weight,
          overrideA: aSide.sentiment ?? null,
          overrideB: bSide.sentiment ?? null,
        });
      }
    }
  }

  return index;
}

export interface ReplayResult {
  score: number;
  eventCount: number;
  lastEventAt: Date | null;
}

export interface ReplayOptions {
  cutoff: Date;
  /** Null means every type is allowed. */
  types: Set<string> | null;
}

/**
 * Recomputes every pair score at the replay cutoff. Events after the cutoff or
 * outside the type filter are dropped, and the cutoff itself is used as "now"
 * so decay is measured from the replay point rather than from today.
 */
export function replayPairScores(
  index: Map<string, PairIndexEntry>,
  options: ReplayOptions,
): Map<string, ReplayResult> {
  const results = new Map<string, ReplayResult>();
  const cutoffMs = options.cutoff.getTime();

  for (const entry of index.values()) {
    let lastEventAt: Date | null = null;
    const kept: PairEventDatum[] = [];

    for (const event of entry.events) {
      if (event.occurredAt.getTime() > cutoffMs) continue;
      if (options.types && !options.types.has(event.type)) continue;
      kept.push(event);
      if (!lastEventAt || event.occurredAt.getTime() > lastEventAt.getTime()) {
        lastEventAt = event.occurredAt;
      }
    }

    results.set(entry.key, {
      score: kept.length > 0 ? computePairScore(kept, options.cutoff) : 0,
      eventCount: kept.length,
      lastEventAt,
    });
  }

  return results;
}

export interface EdgeDatum {
  key: string;
  aId: string;
  bId: string;
  tie: string;
  /** Replayed score before any manual override. */
  score: number;
  /** manualScore when set, otherwise the replayed score. */
  effectiveScore: number;
  manualScore: number | null;
  eventCount: number;
  lastEventAt: Date | null;
  pinned: boolean;
  /** Synthesized "knows them" thread rather than an event-derived link. */
  implicit: boolean;
}

export interface BuildEdgesOptions {
  links: GraphLink[];
  replay: Map<string, ReplayResult>;
  people: Set<string>;
  minEvents: number;
  /** Drops the synthesized acquaintance threads when false. */
  showImplicit: boolean;
}

/** Every edge the replay still supports, before visual filtering. */
export function buildEdges(options: BuildEdgesOptions): EdgeDatum[] {
  const edges: EdgeDatum[] = [];

  for (const link of options.links) {
    if (!link?.aPersonId || !link?.bPersonId) continue;
    if (link.aPersonId === link.bPersonId) continue;
    if (!options.people.has(link.aPersonId)) continue;
    if (!options.people.has(link.bPersonId)) continue;

    const key = pairKey(link.aPersonId, link.bPersonId);
    const aId = link.aPersonId < link.bPersonId ? link.aPersonId : link.bPersonId;
    const bId = link.aPersonId < link.bPersonId ? link.bPersonId : link.aPersonId;

    // Acquaintance threads carry no events, so neither the replay window nor
    // the event count threshold applies to them.
    if (link.implicit) {
      if (!options.showImplicit) continue;
      edges.push({
        key,
        aId,
        bId,
        tie: link.tie ?? "KNOWS_OF",
        score: 0,
        effectiveScore: 0,
        manualScore: null,
        eventCount: 0,
        lastEventAt: null,
        pinned: false,
        implicit: true,
      });
      continue;
    }

    const replayed = options.replay.get(key);
    const eventCount = replayed?.eventCount ?? 0;
    const score = replayed?.score ?? 0;

    const meetsThreshold = eventCount > 0 && eventCount >= options.minEvents;
    if (!meetsThreshold && !link.pinned) continue;

    edges.push({
      key,
      aId,
      bId,
      tie: link.tie ?? "",
      score,
      effectiveScore: link.manualScore ?? score,
      manualScore: link.manualScore ?? null,
      eventCount,
      lastEventAt: replayed?.lastEventAt ?? toDate(link.lastEventAt),
      pinned: Boolean(link.pinned),
      implicit: false,
    });
  }

  return edges;
}

/**
 * Where the score ramps reach full effect, for both colour and edge length.
 * Real scores cluster well below 100, so ramping over the whole range left
 * every link a shade of grey and every edge the same length.
 */
const SCORE_SATURATION = 50;

/** A pair with nothing felt on record, and a pair at full tone. */
export const HAIRLINE_WIDTH = 0.7;
const MAX_EDGE_WIDTH = 5;

// The band has to clear the node radius at both ends, otherwise a strong link
// pulls two large nodes into each other and their labels collide.
const NEUTRAL_DISTANCE = 170;
const DISTANCE_SPREAD = 80;
/** Acquaintance threads sit at the far end so they only orbit the centre. */
export const IMPLICIT_DISTANCE = 190;
export const IMPLICIT_STRENGTH = 0.07;

/**
 * Edge length encodes the relationship: a score at or past the saturation point
 * pulls to about 40, 0 rests at 130, and a strained link pushes out to about
 * 220. It saturates where the colour ramp does, because real scores sit well
 * below 100 and ramping over the full range left every edge the same length.
 */
export function distanceForScore(score: number): number {
  const clamped = Math.min(100, Math.max(-100, Number.isFinite(score) ? score : 0));
  const ratio = Math.max(-1, Math.min(1, clamped / SCORE_SATURATION));
  return NEUTRAL_DISTANCE - ratio * DISTANCE_SPREAD;
}

/**
 * Real links pull hard so people who share events cluster together, while
 * event-free links stay loose and only keep their person in orbit.
 */
export function strengthForEventCount(eventCount: number): number {
  const count = Number.isFinite(eventCount) ? Math.max(0, eventCount) : 0;
  if (count === 0) return 0.3;
  return Math.min(0.9, 0.5 + Math.sqrt(count) * 0.1);
}

/**
 * How rigidly the layout holds a pair at their distance. Feeling decides it, so
 * a pair with nothing on record floats loose instead of being pinned into the
 * cluster by the number of parties they both attended.
 */
export function strengthForScore(score: number): number {
  const clamped = Math.min(100, Math.max(-100, Number.isFinite(score) ? score : 0));
  const t = Math.sqrt(Math.min(1, Math.abs(clamped) / SCORE_SATURATION));
  return 0.08 + 0.72 * t;
}

/**
 * Closeness for every person at the replay cutoff, taken from their link to
 * the self node. Falls back to the payload value when there is no self record.
 */
export function replayCloseness(
  people: GraphPerson[],
  selfId: string | null,
  replay: Map<string, ReplayResult>,
  links: GraphLink[],
): Map<string, number> {
  const closeness = new Map<string, number>();
  if (!selfId) {
    for (const person of people) closeness.set(person.id, person.closeness ?? 0);
    return closeness;
  }

  const manualByKey = new Map<string, number | null>();
  for (const link of links) {
    if (!link?.aPersonId || !link?.bPersonId) continue;
    manualByKey.set(pairKey(link.aPersonId, link.bPersonId), link.manualScore ?? null);
  }

  for (const person of people) {
    if (person.id === selfId) {
      closeness.set(person.id, 100);
      continue;
    }
    const key = pairKey(person.id, selfId);
    const replayed = replay.get(key);
    const manual = manualByKey.get(key) ?? null;
    closeness.set(person.id, manual ?? replayed?.score ?? 0);
  }

  return closeness;
}

// The floor is large enough to carry two letters at the default zoom. Below
// that a node reads as an anonymous dot and the initials get dropped.
const MIN_RADIUS = 7;
const MAX_RADIUS = 16;

/** Square root scale so a very close person does not swamp the canvas. */
export function radiusForCloseness(closeness: number): number {
  const normalised = Math.min(1, Math.max(0, closeness / 100));
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(normalised);
}

/**
 * Thickness is how strongly the pair feels, not how often they were in the same
 * room. Counting events made a link between two people who happened to attend
 * one party look like a friendship, and made everyone in a scene look connected
 * to everyone. A pair with no sentiment on record draws as a hairline.
 */
export function widthForScore(score: number): number {
  const clamped = Math.min(100, Math.max(-100, Number.isFinite(score) ? score : 0));
  const t = Math.sqrt(Math.min(1, Math.abs(clamped) / SCORE_SATURATION));
  return HAIRLINE_WIDTH + (MAX_EDGE_WIDTH - HAIRLINE_WIDTH) * t;
}

/** A pair the events place together but say nothing about, feeling wise. */
export function isFeelingless(score: number, eventCount: number): boolean {
  return eventCount > 0 && Math.round(score) === 0;
}

export type { Rgb };

/**
 * The canvas cannot use classes, so the tone tokens are resolved from the
 * document at runtime. Every entry maps to a custom property in globals.css.
 */
export interface GraphPalette {
  negative: Rgb;
  neutral: Rgb;
  positive: Rgb;
  thread: Rgb;
  foreground: Rgb;
  onNode: Rgb;
  /** Sits behind node labels so names stay readable over links. */
  surface: Rgb;
}

const PALETTE_TOKENS: Record<keyof GraphPalette, string> = {
  negative: "--negative",
  neutral: "--muted-foreground",
  positive: "--positive",
  thread: "--thread",
  foreground: "--foreground",
  onNode: "--primary-foreground",
  surface: "--card",
};

/**
 * Reads the tone tokens off the root element. Returns null when the document
 * is not available or the canvas cannot resolve them, so callers can wait.
 */
export function readGraphPalette(): GraphPalette | null {
  return readCanvasTokens(PALETTE_TOKENS);
}

export { rgba };

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}



/** Negative through neutral to positive, saturating at SCORE_SATURATION. */
export function scoreColour(
  score: number,
  palette: GraphPalette,
  alpha = 1,
): string {
  const clamped = Math.min(100, Math.max(-100, Number.isFinite(score) ? score : 0));
  // Square root so a modest score already reads as coloured rather than grey.
  const t = Math.sqrt(Math.min(1, Math.abs(clamped) / SCORE_SATURATION));
  const rgb =
    clamped < 0
      ? mix(palette.neutral, palette.negative, t)
      : mix(palette.neutral, palette.positive, t);
  return rgba(rgb, alpha);
}

function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace("#", "");
  if (hex.length === 3) {
    const r = Number.parseInt(hex[0] + hex[0], 16);
    const g = Number.parseInt(hex[1] + hex[1], 16);
    const b = Number.parseInt(hex[2] + hex[2], 16);
    if ([r, g, b].every(Number.isFinite)) return [r, g, b];
  }
  if (hex.length === 6) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].every(Number.isFinite)) return [r, g, b];
  }
  return null;
}

/** Person colours are stored as hex. Anything unreadable falls back to a token. */
export function withAlpha(colour: string, alpha: number, fallback: Rgb): string {
  return rgba(parseHex(colour || "") ?? fallback, alpha);
}

export interface CircleOption {
  id: string;
  name: string;
  colour: string;
}

export function circleOptions(people: GraphPerson[]): CircleOption[] {
  const map = new Map<string, CircleOption>();
  for (const person of people) {
    for (const circle of person.circles ?? []) {
      if (!circle?.id || map.has(circle.id)) continue;
      map.set(circle.id, {
        id: circle.id,
        name: circle.name,
        colour: circle.colour,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function eventTypeOptions(events: GraphEvent[]): string[] {
  const types = new Set<string>();
  for (const event of events) {
    if (event?.type) types.add(event.type);
  }
  return [...types].sort((a, b) => eventTypeLabel(a).localeCompare(eventTypeLabel(b)));
}

const DAY_MS = 86_400_000;

export interface ReplayRange {
  min: number;
  max: number;
  step: number;
}

/** Slider bounds from the earliest event through to now, stepped by day. */
export function replayRange(events: GraphEvent[]): ReplayRange {
  const now = Date.now();
  let earliest = now;
  for (const event of events) {
    const date = toDate(event.occurredAt);
    if (date && date.getTime() < earliest) earliest = date.getTime();
  }
  const min = Math.min(earliest, now - DAY_MS);
  return { min, max: now, step: DAY_MS };
}

export function formatReplayDate(value: number): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatLastEvent(value: Date | null): string {
  if (!value) return "No events yet";
  return `Last event ${value.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

export function tieLabel(tie: string): string {
  if (!tie) return "Link";
  const lower = tie.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Defensive read of a payload that may arrive partially formed. */
export function normalisePayload(payload: GraphPayload | null | undefined): {
  people: GraphPerson[];
  events: GraphEvent[];
  links: GraphLink[];
} {
  return {
    people: Array.isArray(payload?.people) ? payload.people.filter(Boolean) : [],
    events: Array.isArray(payload?.events) ? payload.events.filter(Boolean) : [],
    links: Array.isArray(payload?.links) ? payload.links.filter(Boolean) : [],
  };
}
