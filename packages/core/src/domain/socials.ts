import type { ContactKind } from "../schemas/enums.js";

/**
 * The lucide-react export name of the glyph a platform uses. Core holds the
 * name, never the component: importing a React icon library here would put the
 * UI into the dependency arrow of the one package that must not know it exists.
 * The UI maps a name to a component.
 */
export type SocialIconName =
  | "AtSign"
  | "Briefcase"
  | "Camera"
  | "CirclePlay"
  | "Cloud"
  | "CodeXml"
  | "Gamepad2"
  | "Ghost"
  | "Globe"
  | "Link"
  | "Mail"
  | "MessageCircle"
  | "MessageCircleMore"
  | "MessagesSquare"
  | "Music2"
  | "Phone"
  | "Rabbit"
  | "Send"
  | "Tv"
  | "Users";

export type SocialPlatformKey =
  | "instagram"
  | "tiktok"
  | "linkedin"
  | "x"
  | "bluesky"
  | "threads"
  | "facebook"
  | "snapchat"
  | "youtube"
  | "twitch"
  | "github"
  | "discord"
  | "telegram"
  | "signal"
  | "whatsapp"
  | "reddit"
  | "website";

export type SocialPlatform = {
  key: SocialPlatformKey;
  label: string;
  icon: SocialIconName;
  kind: ContactKind;
  /** Placeholder for the value field, shown while the input is empty. */
  placeholder: string;
  /** True when the value itself is the address, so no handle cleanup applies. */
  valueIsUrl?: boolean;
  /**
   * Shape a handle must have on this platform, tested by
   * `normaliseSocialHandle` after cleanup (lower cased, no leading `@`, no
   * host, no query string). Null when the value is a URL rather than a handle,
   * which is validated by parsing instead.
   */
  handlePattern: RegExp | null;
  /** Profile URL for a cleaned handle, or null when the platform has none. */
  urlFor: (handle: string) => string | null;
  /** Extra spellings matched when reading a stored platform string. */
  aliases?: string[];
};

/**
 * A YouTube channel id, the one identifier in the registry that is case
 * sensitive: `UCa-bC` and `ucA-Bc` are different channels.
 */
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** lucide-react ships no brand marks, so each platform uses a generic glyph. */
export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  {
    key: "instagram",
    label: "Instagram",
    icon: "Camera",
    kind: "SOCIAL",
    placeholder: "handle",
    handlePattern: /^[a-z0-9._]{1,30}$/,
    urlFor: (handle) => `https://instagram.com/${handle}`,
  },
  {
    key: "tiktok",
    label: "TikTok",
    icon: "Music2",
    kind: "SOCIAL",
    placeholder: "handle",
    // TikTok requires at least 2 characters. Conservative on the upper bound
    // at 24, the documented limit.
    handlePattern: /^[a-z0-9._]{2,24}$/,
    urlFor: (handle) => `https://www.tiktok.com/@${handle}`,
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    icon: "Briefcase",
    kind: "SOCIAL",
    placeholder: "profile slug",
    // Public identifiers are ASCII letters, digits, and hyphens. LinkedIn also
    // issues non ASCII slugs in some locales; those are rejected here rather
    // than guessed at.
    handlePattern: /^[a-z0-9-]{3,100}$/,
    urlFor: (handle) => `https://www.linkedin.com/in/${handle}`,
  },
  {
    key: "x",
    label: "X",
    icon: "AtSign",
    kind: "SOCIAL",
    placeholder: "handle",
    aliases: ["twitter"],
    handlePattern: /^[a-z0-9_]{1,15}$/,
    urlFor: (handle) => `https://x.com/${handle}`,
  },
  {
    key: "bluesky",
    label: "Bluesky",
    icon: "Cloud",
    kind: "SOCIAL",
    placeholder: "name.bsky.social",
    aliases: ["bsky"],
    // A Bluesky handle is a domain name, so at least two dot separated labels,
    // each starting and ending alphanumeric, 253 characters overall. DIDs
    // (did:plc:...) are identifiers, not handles, and are rejected.
    handlePattern:
      /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    urlFor: (handle) => `https://bsky.app/profile/${handle}`,
  },
  {
    key: "threads",
    label: "Threads",
    icon: "MessagesSquare",
    kind: "SOCIAL",
    placeholder: "handle",
    // Threads accounts are Instagram accounts, so the same handle rules.
    handlePattern: /^[a-z0-9._]{1,30}$/,
    urlFor: (handle) => `https://www.threads.net/@${handle}`,
  },
  {
    key: "facebook",
    label: "Facebook",
    icon: "Users",
    kind: "SOCIAL",
    placeholder: "profile name",
    aliases: ["fb", "meta"],
    // Either a vanity username (letters, digits, and dots, at least 5) or the
    // numeric profile id that profile.php?id= carries.
    handlePattern: /^(?:\d{5,20}|[a-z0-9.]{5,50})$/,
    urlFor: (handle) => `https://www.facebook.com/${handle}`,
  },
  {
    key: "snapchat",
    label: "Snapchat",
    icon: "Ghost",
    kind: "SOCIAL",
    placeholder: "username",
    aliases: ["snap"],
    // Starts with a letter, 3 to 15 characters overall.
    handlePattern: /^[a-z][a-z0-9._-]{2,14}$/,
    urlFor: (handle) => `https://www.snapchat.com/add/${handle}`,
  },
  {
    key: "youtube",
    label: "YouTube",
    icon: "CirclePlay",
    kind: "SOCIAL",
    placeholder: "channel handle",
    aliases: ["yt"],
    // Either an @handle (3 to 30 characters) or a raw channel id, which stays
    // case sensitive and gets a /channel/ URL instead of an /@ one.
    handlePattern: /^(?:[a-z0-9._-]{3,30}|UC[A-Za-z0-9_-]{22})$/,
    urlFor: (handle) =>
      YOUTUBE_CHANNEL_ID.test(handle)
        ? `https://www.youtube.com/channel/${handle}`
        : `https://www.youtube.com/@${handle}`,
  },
  {
    key: "twitch",
    label: "Twitch",
    icon: "Tv",
    kind: "SOCIAL",
    placeholder: "channel",
    handlePattern: /^[a-z0-9_]{4,25}$/,
    urlFor: (handle) => `https://www.twitch.tv/${handle}`,
  },
  {
    key: "github",
    label: "GitHub",
    icon: "CodeXml",
    kind: "SOCIAL",
    placeholder: "username",
    aliases: ["gh"],
    // 1 to 39 characters, no leading or trailing hyphen. GitHub also forbids
    // consecutive hyphens, which this does not express.
    handlePattern: /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/,
    urlFor: (handle) => `https://github.com/${handle}`,
  },
  {
    key: "discord",
    label: "Discord",
    icon: "Gamepad2",
    kind: "SOCIAL",
    placeholder: "username",
    // /users/ takes a numeric snowflake id; the newer usernames are lower case
    // with dots and underscores. Both are accepted.
    handlePattern: /^(?:\d{17,20}|[a-z0-9._]{2,32})$/,
    urlFor: (handle) => `https://discord.com/users/${handle}`,
  },
  {
    key: "telegram",
    label: "Telegram",
    icon: "Send",
    kind: "SOCIAL",
    placeholder: "username",
    aliases: ["tg"],
    // Must start with a letter and run 5 to 32 characters.
    handlePattern: /^[a-z][a-z0-9_]{4,31}$/,
    urlFor: (handle) => `https://t.me/${handle}`,
  },
  {
    key: "signal",
    label: "Signal",
    icon: "MessageCircle",
    kind: "SOCIAL",
    placeholder: "username or number",
    // Signal has no public directory and the value may be a username or a
    // phone number, so this stays deliberately loose.
    handlePattern: /^[a-z0-9._+]{3,50}$/,
    urlFor: () => null,
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    icon: "MessageCircleMore",
    kind: "SOCIAL",
    placeholder: "phone number",
    aliases: ["wa"],
    // Digits only: the normaliser strips +, spaces, dots, dashes, and parens
    // before this runs. 6 to 15 is the E.164 range.
    handlePattern: /^\d{6,15}$/,
    urlFor: (handle) => {
      const digits = handle.replace(/[^\d]/g, "");
      return digits ? `https://wa.me/${digits}` : null;
    },
  },
  {
    key: "reddit",
    label: "Reddit",
    icon: "Rabbit",
    kind: "SOCIAL",
    placeholder: "username",
    handlePattern: /^[a-z0-9_-]{3,20}$/,
    urlFor: (handle) => `https://www.reddit.com/user/${handle.replace(/^u\//, "")}`,
  },
  {
    key: "website",
    label: "Website",
    icon: "Globe",
    kind: "OTHER",
    placeholder: "example.com",
    valueIsUrl: true,
    aliases: ["web", "site", "homepage", "blog"],
    // A website is validated by parsing it as a URL, not by a handle shape.
    handlePattern: null,
    urlFor: (value) => (value ? `https://${value.replace(/^\/+/, "")}` : null),
  },
];

/**
 * Every platform key, in registry order, typed as a non empty tuple so it can
 * be handed straight to `z.enum`.
 */
export const SOCIAL_PLATFORM_KEYS = SOCIAL_PLATFORMS.map(
  (platform) => platform.key,
) as unknown as readonly [SocialPlatformKey, ...SocialPlatformKey[]];

const BY_KEY = new Map<string, SocialPlatform>();
for (const platform of SOCIAL_PLATFORMS) {
  BY_KEY.set(platform.key, platform);
  BY_KEY.set(platform.label.toLowerCase(), platform);
  for (const alias of platform.aliases ?? []) BY_KEY.set(alias, platform);
}

/** Sentinel used by the picker for a platform that is not in the registry. */
export const OTHER_PLATFORM_KEY = "__other__";

/** Fallback glyphs for rows with no known platform. */
export const FALLBACK_ICON: Record<ContactKind, SocialIconName> = {
  EMAIL: "Mail",
  PHONE: "Phone",
  SOCIAL: "AtSign",
  OTHER: "Link",
};

export function socialPlatformsForKind(kind: ContactKind): SocialPlatform[] {
  return SOCIAL_PLATFORMS.filter((platform) => platform.kind === kind);
}

/** Resolves a stored platform string, matching key, label, or alias. */
export function getSocialPlatform(
  platform: string | null | undefined,
): SocialPlatform | null {
  if (!platform) return null;
  return BY_KEY.get(platform.trim().toLowerCase()) ?? null;
}

export function contactIcon(
  kind: ContactKind | string,
  platform: string | null | undefined,
): SocialIconName {
  const known = getSocialPlatform(platform);
  if (known) return known.icon;
  return FALLBACK_ICON[kind as ContactKind] ?? "Link";
}

/** Label shown next to the glyph: the platform name, else the free text. */
export function contactPlatformLabel(
  platform: string | null | undefined,
): string | null {
  const known = getSocialPlatform(platform);
  if (known) return known.label;
  const trimmed = platform?.trim();
  return trimmed ? trimmed : null;
}

export function isHttpUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw.trim());
}

/** Last path segment of a URL, used to show a handle instead of a long link. */
function handleFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (!last) return url.hostname.replace(/^www\./, "");
    return last.replace(/^@/, "");
  } catch {
    return null;
  }
}

/**
 * Cleans a typed handle and derives its profile URL. A pasted full URL is kept
 * as the URL unchanged, with its last segment used as the readable value.
 */
export function normaliseSocialValue(
  platformKey: string | null | undefined,
  raw: string,
): { value: string; url: string | null } {
  const trimmed = raw.trim();
  const platform = getSocialPlatform(platformKey);

  if (!trimmed) return { value: "", url: null };

  if (isHttpUrl(trimmed)) {
    if (platform?.valueIsUrl) return { value: trimmed, url: trimmed };
    return { value: handleFromUrl(trimmed) ?? trimmed, url: trimmed };
  }

  if (!platform) return { value: trimmed, url: null };

  const handle = platform.valueIsUrl ? trimmed : trimmed.replace(/^@+/, "");
  return { value: handle, url: handle ? platform.urlFor(handle) : null };
}

/*
 * Strict path, used when a model supplies the string and nobody re-reads it.
 * Everything below rejects rather than repairs: a post URL, a share link, or a
 * handle that cannot exist on the platform comes back as a failure with a
 * reason instead of a plausible looking value.
 */

/** A recognised profile URL: the platform it belongs to and the handle in it. */
export type ParsedSocialUrl = {
  key: SocialPlatformKey;
  handle: string;
};

/** Why a string could not be turned into a handle for a platform. */
export type SocialHandleFailureReason =
  /** The platform key matches no registry key, label, or alias. */
  | "unknown-platform"
  /** Nothing left after trimming. */
  | "empty"
  /** A URL on a host we know, but not a profile URL on it. */
  | "not-a-profile-url"
  /** A profile URL, but for a different platform than the caller claimed. */
  | "platform-mismatch"
  /** A handle that cannot exist on this platform. */
  | "invalid-handle";

export type SocialHandleResult =
  | { ok: true; key: SocialPlatformKey; handle: string; url: string | null }
  | { ok: false; reason: SocialHandleFailureReason; message: string };

type UrlMatcher = {
  key: SocialPlatformKey;
  /** Hosts this platform answers on, with any leading "www." removed. */
  hosts: readonly string[];
  /** Dot prefixed suffixes, for country subdomains such as fr.linkedin.com. */
  hostSuffixes?: readonly string[];
  /** The raw handle carried by the path, or null when it is not a profile. */
  extract: (segments: string[], url: URL) => string | null;
};

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A one segment path that is not one of the platform's own reserved words. */
function singleSegment(
  segments: string[],
  reserved: ReadonlySet<string>,
): string | null {
  if (segments.length !== 1) return null;
  const segment = segments[0];
  if (reserved.has(segment.toLowerCase())) return null;
  return segment;
}

const INSTAGRAM_RESERVED = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "direct", "accounts",
  "about", "developer", "legal", "s", "share", "challenge", "privacy", "terms",
  "web", "oauth", "api", "graphql", "emails", "sessions",
]);

const X_RESERVED = new Set([
  "i", "home", "explore", "search", "notifications", "messages", "settings",
  "compose", "intent", "share", "hashtag", "status", "login", "signup", "tos",
  "privacy", "about", "download", "logout", "account",
]);

const FACEBOOK_RESERVED = new Set([
  "profile.php", "groups", "pages", "page", "watch", "share", "sharer",
  "story.php", "permalink.php", "photo.php", "photo", "media", "events",
  "event.php", "marketplace", "gaming", "reel", "videos", "video.php", "login",
  "login.php", "help", "policies", "business", "ads", "hashtag", "notes",
  "search", "home.php", "people", "public",
]);

const TWITCH_RESERVED = new Set([
  "directory", "videos", "settings", "downloads", "store", "subs", "jobs",
  "turbo", "prime", "p", "team", "u", "popout", "wallet", "drops", "login",
  "signup", "search",
]);

const GITHUB_RESERVED = new Set([
  "orgs", "settings", "features", "pricing", "about", "topics", "collections",
  "trending", "marketplace", "sponsors", "notifications", "explore", "login",
  "join", "search", "apps", "enterprise", "new", "issues", "pulls",
  "codespaces", "organizations", "site", "security", "readme", "contact",
  "pulse", "watching", "stars",
]);

const TELEGRAM_RESERVED = new Set([
  "joinchat", "s", "share", "addstickers", "addtheme", "proxy", "socks", "iv",
  "setlanguage", "confirmphone", "bg",
]);

const URL_MATCHERS: readonly UrlMatcher[] = [
  {
    key: "instagram",
    hosts: ["instagram.com", "m.instagram.com", "instagr.am"],
    // /p/, /reel/, /tv/, and /stories/ are posts, and they are two segments
    // deep anyway, so the single segment rule carries most of the work.
    extract: (segments) => singleSegment(segments, INSTAGRAM_RESERVED),
  },
  {
    key: "tiktok",
    hosts: ["tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    extract: (segments, url) => {
      const host = hostOf(url);
      // vm. and vt. links are opaque share redirects, never a profile.
      if (host === "vm.tiktok.com" || host === "vt.tiktok.com") return null;
      if (segments.length !== 1) return null;
      const segment = segments[0];
      return segment.startsWith("@") ? segment.slice(1) : null;
    },
  },
  {
    key: "linkedin",
    hosts: ["linkedin.com", "m.linkedin.com", "lnkd.in"],
    // fr.linkedin.com, de.linkedin.com and the rest of the country subdomains.
    hostSuffixes: [".linkedin.com"],
    extract: (segments, url) => {
      // A shortened link hides its target, so it proves nothing.
      if (hostOf(url) === "lnkd.in") return null;
      // Only /in/ is a person. /company/, /school/, /posts/, /pulse/ are not.
      if (segments.length !== 2) return null;
      if (segments[0].toLowerCase() !== "in") return null;
      return segments[1];
    },
  },
  {
    key: "x",
    hosts: ["x.com", "twitter.com", "m.twitter.com", "mobile.twitter.com", "t.co"],
    extract: (segments, url) => {
      if (hostOf(url) === "t.co") return null;
      // /handle/status/123 is a post, and it is three segments deep.
      return singleSegment(segments, X_RESERVED);
    },
  },
  {
    key: "bluesky",
    hosts: ["bsky.app"],
    extract: (segments) => {
      // /profile/handle/post/xyz is a post.
      if (segments.length !== 2) return null;
      if (segments[0].toLowerCase() !== "profile") return null;
      return segments[1];
    },
  },
  {
    key: "threads",
    hosts: ["threads.net", "threads.com"],
    extract: (segments) => {
      if (segments.length !== 1) return null;
      const segment = segments[0];
      return segment.startsWith("@") ? segment.slice(1) : null;
    },
  },
  {
    key: "facebook",
    hosts: [
      "facebook.com", "m.facebook.com", "web.facebook.com",
      "mbasic.facebook.com", "fb.com", "fb.me",
    ],
    extract: (segments, url) => {
      if (hostOf(url) === "fb.me") return null;
      // The oldest profile form: /profile.php?id=100000000000000.
      if (segments.length === 1 && segments[0].toLowerCase() === "profile.php") {
        const id = url.searchParams.get("id");
        return id && /^\d+$/.test(id) ? id : null;
      }
      return singleSegment(segments, FACEBOOK_RESERVED);
    },
  },
  {
    key: "snapchat",
    hosts: ["snapchat.com", "story.snapchat.com", "t.snapchat.com"],
    extract: (segments) => {
      // Only /add/ is an account. /spotlight/, /p/, and /t/ are content.
      if (segments.length !== 2) return null;
      if (segments[0].toLowerCase() !== "add") return null;
      return segments[1];
    },
  },
  {
    key: "youtube",
    hosts: ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"],
    extract: (segments, url) => {
      // youtu.be links are videos.
      if (hostOf(url) === "youtu.be") return null;
      if (segments.length === 1) {
        const segment = segments[0];
        return segment.startsWith("@") ? segment.slice(1) : null;
      }
      if (segments.length !== 2) return null;
      const [first, second] = segments;
      const lower = first.toLowerCase();
      if (lower === "c" || lower === "user") return second;
      if (lower === "channel" && YOUTUBE_CHANNEL_ID.test(second)) return second;
      return null;
    },
  },
  {
    key: "twitch",
    hosts: ["twitch.tv", "m.twitch.tv"],
    extract: (segments) => singleSegment(segments, TWITCH_RESERVED),
  },
  {
    key: "github",
    hosts: ["github.com", "gist.github.com"],
    extract: (segments, url) => {
      if (hostOf(url) === "gist.github.com") return null;
      // /owner/repo is a repository, not a person.
      return singleSegment(segments, GITHUB_RESERVED);
    },
  },
  {
    key: "discord",
    hosts: ["discord.com", "discordapp.com", "discord.gg"],
    extract: (segments, url) => {
      // discord.gg links are server invites.
      if (hostOf(url) === "discord.gg") return null;
      if (segments.length !== 2) return null;
      if (segments[0].toLowerCase() !== "users") return null;
      return segments[1];
    },
  },
  {
    key: "telegram",
    hosts: ["t.me", "telegram.me", "telegram.dog"],
    extract: (segments) => {
      // /channel/451 is a message in a channel.
      if (segments.length !== 1) return null;
      const segment = segments[0];
      // t.me/+AbCdEf is a private invite link.
      if (segment.startsWith("+")) return null;
      if (TELEGRAM_RESERVED.has(segment.toLowerCase())) return null;
      return segment;
    },
  },
  {
    key: "signal",
    hosts: ["signal.me", "signal.group", "signal.link"],
    // Signal links carry a one time token, not a handle anyone can reuse.
    extract: () => null,
  },
  {
    key: "whatsapp",
    hosts: [
      "wa.me", "api.whatsapp.com", "web.whatsapp.com", "whatsapp.com",
      "chat.whatsapp.com",
    ],
    extract: (segments, url) => {
      // chat.whatsapp.com links are group invites, not a person.
      if (hostOf(url) === "chat.whatsapp.com") return null;
      if (hostOf(url) === "wa.me") {
        // /message/CODE and /qr/CODE are short links, not numbers.
        if (segments.length !== 1) return null;
        const segment = segments[0];
        const digits = segment.replace(/[^\d]/g, "");
        // Reject anything that was not already just a number.
        return segment.replace(/^\+/, "") === digits ? digits : null;
      }
      const phone = url.searchParams.get("phone");
      return phone ? phone.replace(/[^\d]/g, "") || null : null;
    },
  },
  {
    key: "reddit",
    hosts: [
      "reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com",
      "m.reddit.com", "redd.it",
    ],
    extract: (segments, url) => {
      if (hostOf(url) === "redd.it") return null;
      // /r/ is a subreddit, /user/name/comments/... is a post.
      if (segments.length !== 2) return null;
      const lower = segments[0].toLowerCase();
      if (lower !== "user" && lower !== "u") return null;
      return segments[1];
    },
  },
];

const MATCHER_BY_HOST = new Map<string, UrlMatcher>();
for (const matcher of URL_MATCHERS) {
  for (const host of matcher.hosts) MATCHER_BY_HOST.set(host, matcher);
}

function matcherForHost(host: string): UrlMatcher | null {
  const direct = MATCHER_BY_HOST.get(host);
  if (direct) return direct;
  for (const matcher of URL_MATCHERS) {
    for (const suffix of matcher.hostSuffixes ?? []) {
      if (host.endsWith(suffix)) return matcher;
    }
  }
  return null;
}

/** Handles are stored lower cased, apart from case sensitive channel ids. */
function foldHandleCase(key: SocialPlatformKey, handle: string): string {
  if (key === "youtube" && YOUTUBE_CHANNEL_ID.test(handle)) return handle;
  return handle.toLowerCase();
}

const HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** Website "handle": the host without www, plus the path, minus the scheme. */
function websiteHandleFromUrl(url: URL): string | null {
  const host = hostOf(url);
  if (!HOSTNAME.test(host)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${path}`;
}

function isWebsiteHandle(handle: string): boolean {
  if (/\s/.test(handle)) return false;
  try {
    return HOSTNAME.test(new URL(`https://${handle}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Identifies the platform an http(s) URL belongs to and pulls the handle out
 * of it. Returns null when the URL is not a profile: a post, a video, a share
 * link, a search, a group, a company page, or a bare host root on a platform
 * we recognise. A URL on a host outside the registry is reported as `website`,
 * which is what makes a platform mismatch detectable for every candidate.
 */
export function parseSocialUrl(raw: string): ParsedSocialUrl | null {
  const trimmed = raw.trim();
  if (!isHttpUrl(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const matcher = matcherForHost(hostOf(url));
  if (!matcher) {
    const handle = websiteHandleFromUrl(url);
    return handle ? { key: "website", handle } : null;
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  const extracted = matcher.extract(segments, url);
  if (!extracted) return null;

  const handle = foldHandleCase(matcher.key, extracted.replace(/^@+/, ""));
  const pattern = BY_KEY.get(matcher.key)?.handlePattern;
  if (pattern && !pattern.test(handle)) return null;
  return { key: matcher.key, handle };
}

function fail(
  reason: SocialHandleFailureReason,
  message: string,
): SocialHandleResult {
  return { ok: false, reason, message };
}

/** Cleanup applied to a value that is a handle rather than a URL. */
function cleanHandle(platform: SocialPlatform, raw: string): string {
  let handle = raw.split(/[?#]/)[0].trim();
  handle = handle.replace(/^\/+/, "").replace(/\/+$/, "");
  handle = handle.replace(/^@+/, "");
  if (platform.key === "reddit") handle = handle.replace(/^u(?:ser)?\//i, "");
  if (platform.key === "whatsapp") handle = handle.replace(/[^\d]/g, "");
  if (platform.key === "website") handle = handle.replace(/^www\./i, "");
  return foldHandleCase(platform.key, handle);
}

function validated(platform: SocialPlatform, handle: string): SocialHandleResult {
  if (!handle) {
    return fail("empty", `A ${platform.label} handle is required.`);
  }
  if (platform.handlePattern) {
    if (!platform.handlePattern.test(handle)) {
      return fail(
        "invalid-handle",
        `"${handle}" is not a valid ${platform.label} handle, it does not match ${platform.handlePattern.source}.`,
      );
    }
  } else if (!isWebsiteHandle(handle)) {
    return fail("invalid-handle", `"${handle}" is not a valid web address.`);
  }
  return {
    ok: true,
    key: platform.key,
    handle,
    url: platform.urlFor(handle),
  };
}

/** Host followed by a path, with the scheme left off, e.g. "x.com/sam". */
const BARE_HOST_WITH_PATH = /^(?:[a-z0-9-]+\.)+[a-z]{2,}\//i;
/** Bare host with no path, e.g. "samrivera.dev". */
const BARE_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

function looksLikeUrl(raw: string, platform: SocialPlatform): boolean {
  if (isHttpUrl(raw)) return true;
  // A dotted host on its own is ambiguous: "sam.rivera" is a real Instagram
  // handle, so only a following path makes it a URL, except for website where
  // the value is an address by definition.
  if (BARE_HOST_WITH_PATH.test(raw)) return true;
  return platform.valueIsUrl === true && BARE_HOST.test(raw);
}

/**
 * Strict counterpart to `normaliseSocialValue`, for values a model supplied.
 * Accepts a handle or a profile URL, and returns the canonical handle plus
 * `platform.urlFor(handle)` so the stored URL never depends on what was
 * pasted. Anything that is not a profile on that platform is a failure with a
 * reason, never a repaired value: `instagram.com/p/Cxyz1234/` is rejected
 * rather than read as the handle `Cxyz1234`.
 */
export function normaliseSocialHandle(
  platformKey: string | null | undefined,
  raw: string,
): SocialHandleResult {
  const platform = getSocialPlatform(platformKey);
  if (!platform) {
    return fail(
      "unknown-platform",
      `"${platformKey ?? ""}" is not a known platform. Use one of: ${SOCIAL_PLATFORM_KEYS.join(", ")}.`,
    );
  }

  const trimmed = raw.trim();
  if (!trimmed) return fail("empty", `A ${platform.label} handle is required.`);

  const candidate = isHttpUrl(trimmed) ? trimmed : trimmed.replace(/\/+$/, "");

  if (looksLikeUrl(candidate, platform)) {
    const url = isHttpUrl(candidate) ? candidate : `https://${candidate}`;
    const parsed = parseSocialUrl(url);
    if (!parsed) {
      return fail(
        "not-a-profile-url",
        `${trimmed} is not a ${platform.label} profile URL. Post, video, share, invite, and search URLs carry no handle.`,
      );
    }
    if (parsed.key !== platform.key) {
      const actual = getSocialPlatform(parsed.key)?.label ?? parsed.key;
      return fail(
        "platform-mismatch",
        `${trimmed} is a ${actual} URL, not a ${platform.label} one.`,
      );
    }
    return validated(platform, parsed.handle);
  }

  const cleaned = cleanHandle(platform, candidate);
  if (!cleaned) {
    // "empty" is reserved for a caller that sent nothing. Input that cleans
    // down to nothing, such as a WhatsApp value with no digits in it, is a bad
    // handle rather than a missing one.
    return fail(
      "invalid-handle",
      `"${trimmed}" leaves no ${platform.label} handle once cleaned up.`,
    );
  }
  return validated(platform, cleaned);
}
