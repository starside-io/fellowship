import { z } from "zod";

import { THRESHOLDS } from "../domain/chat-insights.js";
import {
  DEFAULT_AVATAR_RESOLVERS,
  avatarResolverListSchema,
} from "./avatar-resolvers.js";

export * from "./avatar-resolvers.js";

/**
 * The module's config, as docs/SPEC.md section 8 declares it. The host stores
 * the values and hands them over through the settings port; core owns the shape
 * and the defaults.
 *
 * halfLifeDays and scoreScale are the two that LinkStat.score is a cache of.
 * Changing either makes every cached score in the silo wrong, silently, until
 * the next event mutation touches that pair, and a pair with no new events
 * never recovers. The host recomputes every link before a change to those two
 * counts as applied: see recomputeAll and the config recompute gate.
 */

/** Sample sizes below which a chat figure is noise. */
export const chatThresholdsSchema = z.object({
  messages: z.number().int().min(1).default(THRESHOLDS.messages),
  lengths: z.number().int().min(1).default(THRESHOLDS.lengths),
  openers: z.number().int().min(1).default(THRESHOLDS.openers),
  replies: z.number().int().min(1).default(THRESHOLDS.replies),
  p90Replies: z.number().int().min(1).default(THRESHOLDS.p90Replies),
  trendMessages: z.number().int().min(1).default(THRESHOLDS.trendMessages),
  sessions: z.number().int().min(1).default(THRESHOLDS.sessions),
});

export const moduleConfigSchema = z.object({
  /** Half life of a contribution, in days. Six months by default. */
  halfLifeDays: z.number().min(30).max(1095).default(180),
  /** Multiplier before the clamp to -100..100. */
  scoreScale: z.number().min(1).max(50).default(5),
  avatarResolvers: avatarResolverListSchema.default(() =>
    DEFAULT_AVATAR_RESOLVERS.map((resolver) => ({ ...resolver })),
  ),
  chatThresholds: chatThresholdsSchema.default({}),
  /**
   * Rows per bulk upsert during an import. 500 across 8 columns binds 4000
   * parameters, well under the 32766 ceiling of a modern SQLite and clear of
   * the 999 of an older one.
   */
  messageChunk: z.number().int().min(1).max(1000).default(500),
});

export type ModuleConfig = z.infer<typeof moduleConfigSchema>;

/** Every default, as one object. */
export const DEFAULT_CONFIG: ModuleConfig = moduleConfigSchema.parse({});

/** The two keys whose change invalidates every cached score. */
export const SCORE_CONFIG_KEYS = ["halfLifeDays", "scoreScale"] as const;

/** True when a config change leaves LinkStat.score stale. */
export function needsScoreRecompute(
  before: Pick<ModuleConfig, "halfLifeDays" | "scoreScale">,
  after: Pick<ModuleConfig, "halfLifeDays" | "scoreScale">,
): boolean {
  return SCORE_CONFIG_KEYS.some((key) => before[key] !== after[key]);
}
