/**
 * The Fellowship design system, ported from akai-ito. Import primitives from here rather than from
 * their individual files, so the surface stays easy to audit.
 *
 * See docs/DESIGN.md for the token reference and usage notes.
 */

export {
  TONE_FILL,
  TONE_SURFACE,
  TONE_TEXT,
  clampScore,
  scoreTone,
  sentimentLabel,
  sentimentTone,
  type Tone,
} from "@/ds/tone";

export {
  SentimentChip,
  type SentimentChipProps,
} from "@/ds/sentiment-chip";

export {
  ScoreBar,
  ScoreDot,
  type ScoreBarProps,
  type ScoreDotProps,
} from "@/ds/score";

export {
  AVATAR_SIZES,
  InitialsAvatar,
  initialsFor,
  type AvatarSize,
  type InitialsAvatarProps,
} from "@/ds/initials-avatar";

export {
  AvatarStack,
  type AvatarStackPerson,
  type AvatarStackProps,
} from "@/ds/avatar-stack";

export {
  TagChip,
  type TagChipProps,
  type TagChipVariant,
} from "@/ds/tag-chip";

export { StatCard, type StatCardProps } from "@/ds/stat-card";

export { StatRow, type StatRowProps } from "@/ds/stat-row";

export { EmptyState, type EmptyStateProps } from "@/ds/empty-state";

export {
  SectionCard,
  type SectionCardProps,
} from "@/ds/section-card";

export { KbdChip, type KbdChipProps } from "@/ds/kbd-chip";

export {
  RadarChart,
  type RadarAxis,
  type RadarChartProps,
  type RadarSeries,
} from "@/ds/radar-chart";

// readCanvasTokens and rgba moved to @fellowship/graph, which is the only
// thing here that paints to a canvas.
