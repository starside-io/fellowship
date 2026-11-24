/**
 * The single source of truth for the three point tone scale used by scores,
 * sentiments, and anything else that reads as bad, flat, or good.
 *
 * Positive is the teal family, negative is the red family, neutral is the
 * graphite family. Feature code should call these helpers instead of writing
 * its own colour ramp.
 */

export type Tone = "negative" | "neutral" | "positive";

/** Text only, for numbers and labels sitting on a page or card surface. */
export const TONE_TEXT: Record<Tone, string> = {
  negative: "text-negative",
  neutral: "text-muted-foreground",
  positive: "text-positive",
};

/** Tinted chip surface: border, background wash, and matching text. */
export const TONE_SURFACE: Record<Tone, string> = {
  negative: "border-negative/40 bg-negative/10 text-negative",
  neutral: "border-border bg-muted text-muted-foreground",
  positive: "border-positive/40 bg-positive/10 text-positive",
};

/** Solid fill, for bars, dots, and other non text marks. */
export const TONE_FILL: Record<Tone, string> = {
  negative: "bg-negative",
  neutral: "bg-muted-foreground",
  positive: "bg-positive",
};

/** Clamps a raw connection score into the -100 to 100 range the UI expects. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(-100, Math.min(100, score));
}

/** Maps a -100 to 100 connection score onto the tone scale. */
export function scoreTone(score: number): Tone {
  const clamped = clampScore(score);
  if (clamped < 0) return "negative";
  if (clamped > 0) return "positive";
  return "neutral";
}

/** Maps a -2 to 2 sentiment onto the tone scale. Null reads as neutral. */
export function sentimentTone(sentiment: number | null | undefined): Tone {
  if (sentiment === null || sentiment === undefined) return "neutral";
  if (sentiment < 0) return "negative";
  if (sentiment > 0) return "positive";
  return "neutral";
}

/** -2 bad, -1 tense, 0 neutral, 1 good, 2 great. */
const SENTIMENT_LABEL: Record<number, string> = {
  [-2]: "Bad",
  [-1]: "Tense",
  0: "Neutral",
  1: "Good",
  2: "Great",
};

export function sentimentLabel(sentiment: number | null | undefined): string {
  if (sentiment === null || sentiment === undefined) return "Neutral";
  return SENTIMENT_LABEL[sentiment] ?? "Neutral";
}
