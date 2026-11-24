import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Silo } from "../storage/client.js";
import {
  SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_KEYS,
  getSocialPlatform,
  normaliseSocialHandle,
  parseSocialUrl,
  type SocialPlatform,
  type SocialPlatformKey,
} from "./socials.js";

/*
 * Server side half of the socials discovery feature (docs/socials-discovery.md
 * sections 2.2 to 2.5). Pure string work plus the write path. No network.
 *
 * Normalisation, the handle patterns and the profile URL grammar all live in
 * lib/socials.ts (section 1.4), so the read direction and the write direction
 * cannot drift apart.
 */

// ---------------------------------------------------------------------------
// Schemas (section 2.1)
// ---------------------------------------------------------------------------

export const socialPlatformSchema = z.enum(SOCIAL_PLATFORM_KEYS);

export const socialConfidenceSchema = z.enum(["high", "medium", "low"]);

/** What to do when the person already has a handle on this platform. */
export const socialResolutionSchema = z.enum(["add", "replace", "skip"]);

export const socialCandidateSchema = z.object({
  platform: socialPlatformSchema,
  handle: z.string().trim().min(1).max(200),
  profileUrl: z.string().url().optional(),
  sourceUrl: z.string().url(),
  evidence: z.string().trim().min(10).max(500),
  confidence: socialConfidenceSchema,
  label: z.string().trim().min(1).max(80).optional(),
  isPrimary: z.boolean().default(false),
  resolution: socialResolutionSchema.optional(),
});

export const socialCandidateListSchema = z
  .array(socialCandidateSchema)
  .min(1, "At least one candidate is required")
  .max(20, "Attach at most 20 handles in one call");

export type SocialCandidate = z.infer<typeof socialCandidateSchema>;

/** Provenance sentinel for a handle the user dictated, stored as a null url. */
export const USER_STATED_SOURCE_URL = "https://fellowship.local/user-stated";

const CONFIDENCE_TO_DB = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
} as const;

// ---------------------------------------------------------------------------
// Platform catalogue (section 2.2)
// ---------------------------------------------------------------------------

const URL_EXAMPLE_HANDLE = "sam.rivera";

export function platformCatalogue() {
  return SOCIAL_PLATFORMS.map((platform) => ({
    key: platform.key,
    label: platform.label,
    kind: platform.kind,
    /** The lucide export name the UI maps to a component. */
    icon: platform.icon,
    urlExample: platform.urlFor(URL_EXAMPLE_HANDLE),
    handlePattern: platform.handlePattern?.source ?? null,
    placeholder: platform.placeholder,
    aliases: platform.aliases ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Check (section 2.3)
// ---------------------------------------------------------------------------

export type CheckStatus = "new" | "duplicate" | "conflict" | "invalid";

export type ExistingChannel = {
  id: string;
  value: string;
  url: string | null;
  isPrimary: boolean;
  label: string | null;
  source: string;
  verifiedAt: Date | null;
};

export type CheckResult = {
  index: number;
  platform: SocialPlatformKey;
  handle: string;
  url: string | null;
  status: CheckStatus;
  urlMismatch: boolean;
  confidence: "high" | "medium" | "low";
  sourceUrl: string;
  existing: ExistingChannel | null;
  requiresResolution: boolean;
  warnings: string[];
  /** Not serialised: the row a conflict or duplicate resolves against. */
  existingMatches: ExistingChannel[];
};

type StoredChannel = {
  id: string;
  kind: string;
  platform: string | null;
  value: string;
  url: string | null;
  isPrimary: boolean;
  label: string | null;
  source: string;
  sourceUrl: string | null;
  verifiedAt: Date | null;
};

export async function loadPersonChannels(
  db: Silo,
  personId: string,
): Promise<StoredChannel[]> {
  return db.contactChannel.findMany({
    where: { personId },
    orderBy: [{ isPrimary: "desc" }, { kind: "asc" }],
    select: {
      id: true,
      kind: true,
      platform: true,
      value: true,
      url: true,
      isPrimary: true,
      label: true,
      source: true,
      sourceUrl: true,
      verifiedAt: true,
    },
  });
}

function publicExisting(row: StoredChannel): ExistingChannel {
  return {
    id: row.id,
    value: row.value,
    url: row.url,
    isPrimary: row.isPrimary,
    label: row.label,
    source: row.source,
    verifiedAt: row.verifiedAt,
  };
}

/** Compares a stored value against a proposed handle on the same platform. */
function storedHandle(key: SocialPlatformKey, value: string): string {
  const parsed = normaliseSocialHandle(key, value);
  return parsed.ok ? parsed.handle : value.trim().toLowerCase();
}

function duplicatePlatformMessage(platform: SocialPlatform): string {
  return `Two ${platform.key} candidates in one call. Show the user both and attach the one they pick, or label them if they are genuinely two accounts of the same person.`;
}

export function evaluateCandidates(
  candidates: SocialCandidate[],
  channels: StoredChannel[],
): CheckResult[] {
  // A platform sent twice without distinct labels is the namesake case (3.4).
  const byPlatform = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const list = byPlatform.get(candidate.platform) ?? [];
    list.push(index);
    byPlatform.set(candidate.platform, list);
  });

  const collides = new Set<number>();
  for (const indexes of byPlatform.values()) {
    if (indexes.length < 2) continue;
    const labels = indexes.map((index) => candidates[index].label?.toLowerCase() ?? "");
    const distinct = new Set(labels);
    if (labels.some((label) => label === "") || distinct.size !== labels.length) {
      for (const index of indexes) collides.add(index);
    }
  }

  const results: CheckResult[] = [];
  const seenHandles = new Set<string>();

  candidates.forEach((candidate, index) => {
    const platform = getSocialPlatform(candidate.platform) as SocialPlatform;
    const warnings: string[] = [];
    const normalised = normaliseSocialHandle(candidate.platform, candidate.handle);
    let invalid = false;

    if (!normalised.ok) {
      invalid = true;
      warnings.push(normalised.message);
    }

    const handle = normalised.ok ? normalised.handle : candidate.handle.trim();
    const url = normalised.ok ? normalised.url : null;

    // The supplied profileUrl is never stored, it is only checked (2.1).
    let urlMismatch = false;
    if (candidate.profileUrl) {
      const parsed = parseSocialUrl(candidate.profileUrl);
      if (!parsed) {
        invalid = true;
        warnings.push(
          `profileUrl ${candidate.profileUrl} is not a profile URL. A post, video, share, invite or search URL carries no handle.`,
        );
      } else if (parsed.key !== platform.key) {
        invalid = true;
        warnings.push(
          `profileUrl points at ${parsed.key}, not ${platform.key}. Send the platform the URL belongs to.`,
        );
      } else if (normalised.ok) {
        urlMismatch = parsed.handle.toLowerCase() !== handle.toLowerCase();
      }
      if (urlMismatch) {
        warnings.push(
          "profileUrl does not resolve to the same handle as the canonical URL. Check it is the profile and not another page.",
        );
      }
    }

    if (collides.has(index)) {
      invalid = true;
      warnings.push(duplicatePlatformMessage(platform));
    }

    const handleKey = `${platform.key}:${handle.toLowerCase()}`;
    if (seenHandles.has(handleKey)) {
      invalid = true;
      warnings.push(
        `The same ${platform.label} handle appears twice in this call. Send it once.`,
      );
    }
    seenHandles.add(handleKey);

    if (candidate.confidence === "low") {
      warnings.push(
        "Confidence is low. Present this as a question, not as a row you are about to write.",
      );
    }

    const matches = channels.filter(
      (row) => getSocialPlatform(row.platform)?.key === platform.key,
    );
    const same = normalised.ok
      ? matches.find((row) => storedHandle(platform.key, row.value) === handle)
      : undefined;

    let status: CheckStatus;
    let existing: StoredChannel | null = null;

    if (invalid) {
      status = "invalid";
      existing = same ?? matches[0] ?? null;
    } else if (same) {
      status = "duplicate";
      existing = same;
      warnings.push(
        `This handle is already stored for ${platform.key}. Attach skips it and only backfills a missing url or sourceUrl.`,
      );
    } else if (matches.length > 0) {
      status = "conflict";
      existing = matches[0];
      warnings.push(
        `This person already has a ${platform.key} handle. Ask the user whether this is a second account (add), a correction (replace), or wrong (skip).`,
      );
    } else {
      status = "new";
    }

    results.push({
      index,
      platform: platform.key,
      handle,
      url,
      status,
      urlMismatch,
      confidence: candidate.confidence,
      sourceUrl: candidate.sourceUrl,
      existing: existing ? publicExisting(existing) : null,
      requiresResolution: status === "conflict",
      warnings,
      existingMatches: matches.map(publicExisting),
    });
  });

  return results;
}

export function summarise(results: CheckResult[]) {
  return {
    new: results.filter((result) => result.status === "new").length,
    duplicate: results.filter((result) => result.status === "duplicate").length,
    conflict: results.filter((result) => result.status === "conflict").length,
    invalid: results.filter((result) => result.status === "invalid").length,
  };
}

/** The response shape, without the internal existingMatches field. */
export function publicResults(results: CheckResult[]) {
  return results.map(({ existingMatches: _ignored, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Check token (section 2.5)
// ---------------------------------------------------------------------------

const TOKEN_VERSION = "v1";
const TOKEN_TTL_SECONDS = 15 * 60;
const DIGEST_LENGTH = 32;

/**
 * FELLOWSHIP_SECRET when set, otherwise a value generated once per process,
 * so a restart invalidates outstanding tokens. Kept on globalThis so a module
 * reload does not rotate it mid flow. Never logged.
 */
function tokenSecret(): string {
  const configured = process.env.FELLOWSHIP_SECRET;
  if (configured) return configured;

  const store = globalThis as unknown as { __fellowshipCheckTokenSecret?: string };
  if (!store.__fellowshipCheckTokenSecret) {
    store.__fellowshipCheckTokenSecret = randomBytes(32).toString("hex");
  }
  return store.__fellowshipCheckTokenSecret;
}

/** platform and normalised handle only, so labels stay editable (2.5). */
export function tokenEntries(results: CheckResult[]): string {
  const pairs = results
    .map((result) => [result.platform, result.handle.toLowerCase()] as const)
    .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
  return JSON.stringify(pairs);
}

function digest(personId: string, entries: string, issuedAt: number): string {
  const payload = `${personId}|${entries}|${issuedAt}`;
  return createHmac("sha256", tokenSecret())
    .update(payload)
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

export function issueCheckToken(personId: string, results: CheckResult[]): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  return `${TOKEN_VERSION}.${issuedAt}.${digest(personId, tokenEntries(results), issuedAt)}`;
}

export type TokenVerdict = "ok" | "expired" | "mismatch";

export function verifyCheckToken(
  token: string,
  personId: string,
  results: CheckResult[],
): TokenVerdict {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return "mismatch";

  const issuedAt = Number(parts[1]);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return "mismatch";

  const expected = digest(personId, tokenEntries(results), issuedAt);
  const supplied = parts[2];
  if (supplied.length !== expected.length) return "mismatch";
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return "mismatch";

  const age = Math.floor(Date.now() / 1000) - issuedAt;
  if (age > TOKEN_TTL_SECONDS || age < -60) return "expired";

  return "ok";
}

// ---------------------------------------------------------------------------
// Attach (sections 2.4 and 3.3)
// ---------------------------------------------------------------------------

export type AttachFailure = {
  ok: false;
  status: number;
  body: Record<string, unknown>;
};

export type AttachSuccess = {
  ok: true;
  body: Record<string, unknown>;
};

type PlannedWrite =
  | { kind: "insert"; result: CheckResult; candidate: SocialCandidate }
  | {
      kind: "replace";
      result: CheckResult;
      candidate: SocialCandidate;
      target: ExistingChannel;
    }
  | {
      kind: "backfill";
      result: CheckResult;
      candidate: SocialCandidate;
      target: ExistingChannel;
    }
  | { kind: "skip"; result: CheckResult; candidate: SocialCandidate; targetId: string | null };

function storedSourceUrl(sourceUrl: string): string | null {
  return sourceUrl === USER_STATED_SOURCE_URL ? null : sourceUrl;
}

export async function attachSocials(
  db: Silo,
  personId: string,
  candidates: SocialCandidate[],
  checkToken: string,
): Promise<AttachSuccess | AttachFailure> {
  const channels = await loadPersonChannels(db, personId);
  const results = evaluateCandidates(candidates, channels);

  const invalid = results.filter((result) => result.status === "invalid");
  if (invalid.length > 0) {
    return {
      ok: false,
      status: 400,
      body: { error: invalid.flatMap((result) => result.warnings).join(" ") },
    };
  }

  const verdict = verifyCheckToken(checkToken, personId, results);
  if (verdict === "expired") {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "The checkToken expired. Run check_socials again and show the user the new result before attaching.",
      },
    };
  }
  if (verdict === "mismatch") {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "The candidate set changed since check_socials ran. Run check_socials again and show the user the new result before attaching.",
      },
    };
  }

  const primaries = candidates.filter((candidate) => candidate.isPrimary);
  if (primaries.length > 1) {
    return {
      ok: false,
      status: 400,
      body: { error: "Only one candidate can be the primary contact channel" },
    };
  }

  const plan: PlannedWrite[] = [];
  const conflicts: Record<string, unknown>[] = [];

  for (const result of results) {
    const candidate = candidates[result.index];
    const platform = getSocialPlatform(result.platform) as SocialPlatform;

    if (result.status === "new") {
      plan.push({ kind: "insert", result, candidate });
      continue;
    }

    if (result.status === "duplicate") {
      plan.push({
        kind: "backfill",
        result,
        candidate,
        target: result.existing as ExistingChannel,
      });
      continue;
    }

    // conflict
    const resolution = candidate.resolution;
    if (!resolution) {
      const existing = result.existing as ExistingChannel;
      conflicts.push({
        platform: result.platform,
        handle: result.handle,
        existing: { id: existing.id, value: existing.value, url: existing.url },
      });
      continue;
    }

    if (resolution === "skip") {
      plan.push({
        kind: "skip",
        result,
        candidate,
        targetId: result.existing?.id ?? null,
      });
      continue;
    }

    if (resolution === "replace") {
      plan.push({
        kind: "replace",
        result,
        candidate,
        target: result.existing as ExistingChannel,
      });
      continue;
    }

    // add: both sides need a label or the person page shows two identical rows.
    const unlabelled = result.existingMatches.find((row) => !row.label);
    if (unlabelled || !candidate.label) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `Label the existing ${platform.key} handle first, or use replace`,
        },
      };
    }
    const clash = result.existingMatches.some(
      (row) => row.label?.toLowerCase() === candidate.label?.toLowerCase(),
    );
    if (clash) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `The label "${candidate.label}" is already used by another ${platform.key} handle. Pick a different one.`,
        },
      };
    }
    plan.push({ kind: "insert", result, candidate });
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "Some handles conflict with existing contact channels",
        conflicts,
      },
    };
  }

  const attached: Record<string, unknown>[] = [];
  const replaced: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  let primaryDemoted: Record<string, unknown> | null = null;

  await db.$transaction(async (tx) => {
    const wantsPrimary = plan.some(
      (step) =>
        step.candidate.isPrimary && (step.kind === "insert" || step.kind === "replace"),
    );

    if (wantsPrimary) {
      const current = await tx.contactChannel.findFirst({
        where: { personId, isPrimary: true },
        select: { id: true, platform: true, value: true },
      });
      if (current) {
        primaryDemoted = current;
        await tx.contactChannel.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
    }

    for (const step of plan) {
      const platform = getSocialPlatform(step.result.platform) as SocialPlatform;
      const confidence = CONFIDENCE_TO_DB[step.candidate.confidence];
      const source = storedSourceUrl(step.candidate.sourceUrl);

      if (step.kind === "insert") {
        const row = await tx.contactChannel.create({
          data: {
            personId,
            kind: platform.kind,
            platform: platform.key,
            value: step.result.handle,
            url: step.result.url,
            label: step.candidate.label ?? null,
            isPrimary: step.candidate.isPrimary,
            source: "ASSISTANT",
            sourceUrl: source,
            confidence,
            verifiedAt: null,
          },
          select: { id: true },
        });
        attached.push({
          id: row.id,
          platform: platform.key,
          handle: step.result.handle,
          url: step.result.url,
        });
        continue;
      }

      if (step.kind === "replace") {
        // Keeps the row id and its isPrimary flag, drops the verification.
        const row = await tx.contactChannel.update({
          where: { id: step.target.id },
          data: {
            kind: platform.kind,
            platform: platform.key,
            value: step.result.handle,
            url: step.result.url,
            source: "ASSISTANT",
            sourceUrl: source,
            confidence,
            verifiedAt: null,
            ...(step.candidate.label ? { label: step.candidate.label } : {}),
            ...(step.candidate.isPrimary ? { isPrimary: true } : {}),
          },
          select: { id: true },
        });
        replaced.push({
          id: row.id,
          platform: platform.key,
          previousHandle: step.target.value,
          handle: step.result.handle,
          url: step.result.url,
        });
        continue;
      }

      if (step.kind === "backfill") {
        const patch: { url?: string; sourceUrl?: string } = {};
        if (!step.target.url && step.result.url) patch.url = step.result.url;
        const stored = await tx.contactChannel.findUnique({
          where: { id: step.target.id },
          select: { sourceUrl: true },
        });
        if (stored && !stored.sourceUrl && source) patch.sourceUrl = source;
        if (Object.keys(patch).length > 0) {
          await tx.contactChannel.update({ where: { id: step.target.id }, data: patch });
        }
        skipped.push({
          platform: platform.key,
          handle: step.result.handle,
          reason: "duplicate",
          existingId: step.target.id,
          backfilled: Object.keys(patch),
        });
        continue;
      }

      skipped.push({
        platform: platform.key,
        handle: step.result.handle,
        reason: "skip",
        existingId: step.targetId,
      });
    }
  });

  return {
    ok: true,
    body: {
      personId,
      attached,
      replaced,
      skipped,
      counts: {
        attached: attached.length,
        replaced: replaced.length,
        skipped: skipped.length,
      },
      primaryDemoted,
    },
  };
}
