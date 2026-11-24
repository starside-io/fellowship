// The avatar resolver list: module config, held behind the host's settings
// port rather than in a table of its own.
//
// It is configuration rather than code because the useful sources for a profile
// picture are unofficial, unstable third party endpoints: the owner has to be
// able to swap a dead one out without a release. Everything read back is
// re-validated, so a hand edited value cannot hand the host's media port a URL
// it would not accept.
//
// The private address guard is not here. It needs DNS, so it runs at fetch
// time, on every redirect hop, inside the host's media port.

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  SOCIAL_PLATFORM_KEYS,
  getSocialPlatform,
  type SocialPlatformKey,
} from "../domain/socials.js";

/** The settings key the list is stored under. */
export const AVATAR_RESOLVERS_KEY = "avatarResolvers";

/**
 * Contact channels of kind EMAIL carry no platform string, so the resolver list
 * uses this key for them. It is also the marker for the hashing resolvers:
 * Gravatar takes a digest of the address, never the address itself.
 */
export const EMAIL_RESOLVER_PLATFORM = "email";

export type AvatarResolverPlatform =
  | SocialPlatformKey
  | typeof EMAIL_RESOLVER_PLATFORM;

export const HANDLE_PLACEHOLDER = "{handle}";
export const PLATFORM_PLACEHOLDER = "{platform}";
export const HASH_PLACEHOLDER = "{hash}";

const resolverPlatformSchema = z.union([
  z.enum(SOCIAL_PLATFORM_KEYS),
  z.literal(EMAIL_RESOLVER_PLATFORM),
]);

/** Stand ins used to check that a template is a URL before any handle exists. */
const PROBE_HANDLE = "probe";
const PROBE_HASH = "0".repeat(64);

/** True for the resolvers that hash their input rather than paste it in raw. */
export function isHashResolver(platform: string): boolean {
  return platform === EMAIL_RESOLVER_PLATFORM;
}

function substitute(
  template: string,
  platform: string,
  values: { handle: string; hash: string },
): string {
  return template
    .split(PLATFORM_PLACEHOLDER)
    .join(platform)
    .split(HANDLE_PLACEHOLDER)
    .join(values.handle)
    .split(HASH_PLACEHOLDER)
    .join(values.hash);
}

export type TemplateProblem =
  | "not-a-url"
  | "not-https"
  | "has-credentials"
  | "missing-handle"
  | "missing-hash"
  | "has-whitespace";

/**
 * Static checks on a resolver template. https only so a resolver cannot be
 * downgraded into a cleartext request, and no credentials in the URL so a
 * template can never smuggle a basic auth pair at some host. The private
 * address guard is not here: it needs DNS, so it runs at fetch time, on every
 * hop, in avatar-fetch.ts.
 */
export function checkAvatarTemplate(
  template: string,
  platform: string,
): TemplateProblem | null {
  if (/\s/.test(template)) return "has-whitespace";

  if (isHashResolver(platform)) {
    if (!template.includes(HASH_PLACEHOLDER)) return "missing-hash";
  } else if (!template.includes(HANDLE_PLACEHOLDER)) {
    return "missing-handle";
  }

  const probe = substitute(template, platform, {
    handle: PROBE_HANDLE,
    hash: PROBE_HASH,
  });

  let url: URL;
  try {
    url = new URL(probe);
  } catch {
    return "not-a-url";
  }

  if (url.protocol !== "https:") return "not-https";
  if (url.username !== "" || url.password !== "") return "has-credentials";
  if (url.hostname === "") return "not-a-url";
  return null;
}

const TEMPLATE_MESSAGES: Record<TemplateProblem, string> = {
  "has-whitespace": "A URL template cannot contain whitespace",
  "missing-handle": `A URL template must contain ${HANDLE_PLACEHOLDER}`,
  "missing-hash": `An email resolver template must contain ${HASH_PLACEHOLDER}`,
  "not-a-url": "Expected a valid URL template",
  "not-https": "Only https templates are allowed",
  "has-credentials": "A URL template cannot carry credentials",
};

export const avatarResolverSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Expected a lowercase id such as github"),
    label: z.string().trim().min(1, "A label is required").max(80),
    platform: resolverPlatformSchema,
    urlTemplate: z.string().trim().min(1, "A URL template is required").max(500),
    enabled: z.boolean(),
  })
  .superRefine((resolver, ctx) => {
    const problem = checkAvatarTemplate(resolver.urlTemplate, resolver.platform);
    if (problem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["urlTemplate"],
        message: TEMPLATE_MESSAGES[problem],
      });
    }
  });

export type AvatarResolver = z.infer<typeof avatarResolverSchema>;

export const avatarResolverListSchema = z
  .array(avatarResolverSchema)
  .max(20, "At most 20 resolvers")
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const [index, resolver] of list.entries()) {
      if (seen.has(resolver.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: `Duplicate resolver id "${resolver.id}"`,
        });
      }
      seen.add(resolver.id);
    }
  });

/**
 * Shipped defaults, in the order they are tried: LinkedIn, then TikTok, then
 * YouTube, then the two official endpoints.
 *
 * The first three go through unavatar, an unofficial third party proxy, because
 * none of those three platforms has a public endpoint of its own. LinkedIn
 * answers 999 to an unknown client, TikTok serves a script shell with no
 * preview image in it, and YouTube's own API wants a key. unavatar reads them
 * and hands back a picture, which is the only route that does not involve
 * scraping from here.
 *
 * Every one of them carries fallback=false, which is what keeps a miss honest:
 * without it unavatar generates a letter tile and every person gets a picture
 * that is not theirs. With it, a handle it cannot resolve answers 403 and the
 * fetch fails, which is the outcome the picker can report.
 *
 * LinkedIn's path wants `user:` in front of the slug. GitHub and Gravatar are
 * last and are the only two that ask nobody's permission: a documented endpoint
 * and a digest of an address. Instagram ships disabled because unavatar is
 * currently blocked there and answers 403 for every handle, mine included.
 */
export const DEFAULT_AVATAR_RESOLVERS: readonly AvatarResolver[] = [
  {
    id: "linkedin-unavatar",
    label: "LinkedIn (unavatar, unofficial)",
    platform: "linkedin",
    urlTemplate: "https://unavatar.io/linkedin/user:{handle}?fallback=false",
    enabled: true,
  },
  {
    id: "tiktok-unavatar",
    label: "TikTok (unavatar, unofficial)",
    platform: "tiktok",
    urlTemplate: "https://unavatar.io/{platform}/{handle}?fallback=false",
    enabled: true,
  },
  {
    id: "youtube-unavatar",
    label: "YouTube (unavatar, unofficial)",
    platform: "youtube",
    urlTemplate: "https://unavatar.io/{platform}/{handle}?fallback=false",
    enabled: true,
  },
  {
    id: "github",
    label: "GitHub",
    platform: "github",
    urlTemplate: "https://github.com/{handle}.png?size=400",
    enabled: true,
  },
  {
    id: "gravatar",
    label: "Gravatar",
    platform: EMAIL_RESOLVER_PLATFORM,
    urlTemplate: "https://www.gravatar.com/avatar/{hash}?s=400&d=404",
    enabled: true,
  },
  {
    id: "instagram-unavatar",
    label: "Instagram (unavatar, blocked upstream)",
    platform: "instagram",
    urlTemplate: "https://unavatar.io/{platform}/{handle}?fallback=false",
    enabled: false,
  },
];

/** sha256 of the trimmed, lower cased address, the Gravatar digest. */
export function gravatarHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * Fills a template in. The handle is percent encoded, so a value carrying a
 * slash, a question mark, or a space cannot reshape the URL it lands in.
 * Returns null when the resolver needs a value the caller did not supply.
 */
export function expandAvatarTemplate(
  resolver: Pick<AvatarResolver, "platform" | "urlTemplate">,
  input: { handle?: string | null; email?: string | null },
): string | null {
  if (isHashResolver(resolver.platform)) {
    const email = input.email?.trim();
    if (!email) return null;
    return substitute(resolver.urlTemplate, resolver.platform, {
      handle: "",
      hash: gravatarHash(email),
    });
  }

  const handle = input.handle?.trim();
  if (!handle) return null;
  return substitute(resolver.urlTemplate, resolver.platform, {
    handle: encodeURIComponent(handle),
    hash: "",
  });
}

/*
 * Candidates: which URLs are worth trying for a person's picture, in order.
 *
 * Pure, and core's rather than the host's, because it is the resolver list and
 * the socials registry talking to each other. The host fetches what this
 * returns, through the guard, and never the other way round.
 */

export type AvatarCandidate = {
  resolverId: string;
  label: string;
  platform: string;
  url: string;
  /** The channel value this came from, shown in the report. */
  handle: string | null;
  /**
   * Set when the candidate is already known to be unusable, for instance a home
   * page that could not be read. Reported as a failed attempt, never fetched.
   */
  error?: string;
};

/** The slice of a contact channel the candidate builder needs. */
export type CandidateChannel = {
  kind: string;
  platform: string | null;
  value: string;
  url: string | null;
};

/**
 * Pure ordering step: enabled resolvers in list order, and within each one the
 * channels that match its platform, in the order they were given. Disabled
 * resolvers produce nothing, and a resolver with no matching channel is simply
 * absent rather than a failing candidate.
 */
export function buildResolverCandidates(
  resolvers: readonly AvatarResolver[],
  channels: readonly CandidateChannel[],
): AvatarCandidate[] {
  const candidates: AvatarCandidate[] = [];
  const seen = new Set<string>();

  for (const resolver of resolvers) {
    if (!resolver.enabled) continue;

    for (const channel of channels) {
      const value = channel.value?.trim();
      if (!value) continue;

      const hashKind = isHashResolver(resolver.platform);
      const matches = hashKind
        ? channel.kind === "EMAIL" ||
          channel.platform?.trim().toLowerCase() === EMAIL_RESOLVER_PLATFORM
        : getSocialPlatform(channel.platform)?.key === resolver.platform;
      if (!matches) continue;

      const url = expandAvatarTemplate(resolver, {
        handle: value,
        email: value,
      });
      if (!url || seen.has(url)) continue;

      seen.add(url);
      candidates.push({
        resolverId: resolver.id,
        label: resolver.label,
        platform: resolver.platform,
        url,
        // A hashed address is never echoed back into the report.
        handle: hashKind ? null : value,
      });
    }
  }

  return candidates;
}

