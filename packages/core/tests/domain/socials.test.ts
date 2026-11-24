import { describe, expect, it } from "vitest";
import {
  SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_KEYS,
  getSocialPlatform,
  normaliseSocialHandle,
  normaliseSocialValue,
  parseSocialUrl,
  type SocialPlatformKey,
} from "../../src/domain/socials.js";

// The contract under test, from docs/socials-discovery.md section 1.4:
//   - normaliseSocialHandle is the model facing path. It returns a canonical
//     handle plus platform.urlFor(handle), or an explicit failure. It never
//     repairs a value that is not a profile handle.
//   - parseSocialUrl reads a profile URL back into a platform and a handle,
//     and returns null for posts, shares, searches, and bare roots.
//   - normaliseSocialValue stays lenient, because a human is looking at the
//     field they just typed into.

/** One well formed handle per platform, used for the round trip. */
const SAMPLE_HANDLES: Record<SocialPlatformKey, string> = {
  instagram: "sam.rivera",
  tiktok: "sam.rivera",
  linkedin: "samrivera-ux",
  x: "samrivera",
  bluesky: "sam.bsky.social",
  threads: "sam.rivera",
  facebook: "sam.rivera",
  snapchat: "sam.rivera",
  youtube: "samrivera",
  twitch: "samrivera",
  github: "samrivera",
  discord: "sam.rivera",
  telegram: "samrivera",
  signal: "sam.rivera",
  whatsapp: "33612345678",
  reddit: "samrivera",
  website: "samrivera.dev",
};

describe("SOCIAL_PLATFORM_KEYS", () => {
  it("lists every registry platform once, in registry order", () => {
    expect([...SOCIAL_PLATFORM_KEYS]).toEqual(
      SOCIAL_PLATFORMS.map((platform) => platform.key),
    );
    expect(new Set(SOCIAL_PLATFORM_KEYS).size).toBe(SOCIAL_PLATFORM_KEYS.length);
  });

  it("is non empty, so z.enum can consume it", () => {
    expect(SOCIAL_PLATFORM_KEYS.length).toBeGreaterThan(0);
  });

  it("has a sample handle in this file for every platform", () => {
    expect(Object.keys(SAMPLE_HANDLES).sort()).toEqual(
      [...SOCIAL_PLATFORM_KEYS].sort(),
    );
  });
});

describe("handlePattern", () => {
  it("accepts the sample handle on every platform that has a pattern", () => {
    for (const platform of SOCIAL_PLATFORMS) {
      if (!platform.handlePattern) continue;
      expect(
        platform.handlePattern.test(SAMPLE_HANDLES[platform.key]),
        `${platform.key} rejects its own sample handle`,
      ).toBe(true);
    }
  });

  it("is null only for website, which is validated by parsing instead", () => {
    const withoutPattern = SOCIAL_PLATFORMS.filter(
      (platform) => platform.handlePattern === null,
    ).map((platform) => platform.key);
    expect(withoutPattern).toEqual(["website"]);
  });
});

describe("parseSocialUrl round trip", () => {
  it("reads urlFor back into the same platform and handle", () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const handle = SAMPLE_HANDLES[platform.key];
      const url = platform.urlFor(handle);
      // Signal has no profile URL at all, so there is nothing to read back.
      if (url === null) {
        expect(platform.key).toBe("signal");
        continue;
      }
      expect(parseSocialUrl(url), `${platform.key} did not round trip`).toEqual({
        key: platform.key,
        handle,
      });
    }
  });

  it("round trips a YouTube channel id, which is case sensitive", () => {
    const channelId = "UCaBcDefghijklmnopqrstuv";
    const url = getSocialPlatform("youtube")?.urlFor(channelId);
    expect(url).toBe(`https://www.youtube.com/channel/${channelId}`);
    expect(parseSocialUrl(url as string)).toEqual({
      key: "youtube",
      handle: channelId,
    });
  });

  it("returns null for a string that is not an http URL", () => {
    expect(parseSocialUrl("sam.rivera")).toBeNull();
    expect(parseSocialUrl("")).toBeNull();
    expect(parseSocialUrl("mailto:sam@example.com")).toBeNull();
  });
});

describe("parseSocialUrl host variants", () => {
  const cases: Array<[string, SocialPlatformKey, string]> = [
    ["https://m.facebook.com/sam.rivera/?ref=bookmarks", "facebook", "sam.rivera"],
    ["https://fb.com/sam.rivera", "facebook", "sam.rivera"],
    ["https://www.facebook.com/profile.php?id=100000000000001", "facebook", "100000000000001"],
    ["https://twitter.com/SamRivera", "x", "samrivera"],
    ["https://mobile.twitter.com/samrivera", "x", "samrivera"],
    ["https://fr.linkedin.com/in/samrivera-ux", "linkedin", "samrivera-ux"],
    ["https://www.linkedin.com/in/samrivera-ux/", "linkedin", "samrivera-ux"],
    ["https://www.instagram.com/Sam.Rivera/?hl=en&igshid=abc", "instagram", "sam.rivera"],
    ["https://youtube.com/c/SamRivera", "youtube", "samrivera"],
    ["https://www.youtube.com/@samrivera", "youtube", "samrivera"],
    ["https://old.reddit.com/u/samrivera", "reddit", "samrivera"],
    ["https://www.reddit.com/user/samrivera/", "reddit", "samrivera"],
    ["https://t.me/samrivera", "telegram", "samrivera"],
    ["https://bsky.app/profile/sam.bsky.social", "bluesky", "sam.bsky.social"],
    ["https://www.tiktok.com/@sam.rivera", "tiktok", "sam.rivera"],
    ["https://api.whatsapp.com/send?phone=+33612345678", "whatsapp", "33612345678"],
  ];

  for (const [url, key, handle] of cases) {
    it(`reads ${url} as ${key}/${handle}`, () => {
      expect(parseSocialUrl(url)).toEqual({ key, handle });
    });
  }

  it("reports an unknown host as a website, so a mismatch is detectable", () => {
    expect(parseSocialUrl("https://samrivera.dev/about")).toEqual({
      key: "website",
      handle: "samrivera.dev/about",
    });
  });
});

describe("parseSocialUrl rejects everything that is not a profile", () => {
  const nonProfiles: Array<[SocialPlatformKey, string]> = [
    // The case the whole strict path exists for.
    ["instagram", "https://www.instagram.com/p/Cxyz1234/"],
    ["instagram", "https://instagram.com/reel/Cabc9876/"],
    ["instagram", "https://www.instagram.com/stories/sam.rivera/123/"],
    ["x", "https://x.com/samrivera/status/1234567890123456789"],
    ["x", "https://twitter.com/i/flow/login"],
    ["x", "https://x.com/search?q=sam%20rivera"],
    ["tiktok", "https://www.tiktok.com/@samrivera/video/7212345678901234567"],
    ["tiktok", "https://vm.tiktok.com/ZMabcdefg/"],
    ["linkedin", "https://www.linkedin.com/company/kanji"],
    ["linkedin", "https://www.linkedin.com/posts/samrivera-ux_activity-123"],
    ["linkedin", "https://lnkd.in/abcdefg"],
    ["youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["youtube", "https://youtu.be/dQw4w9WgXcQ"],
    ["youtube", "https://www.youtube.com/shorts/abcdefghijk"],
    ["facebook", "https://www.facebook.com/samrivera/posts/1234567890"],
    ["facebook", "https://www.facebook.com/share/p/abc123/"],
    ["facebook", "https://www.facebook.com/groups/lyondesign"],
    ["reddit", "https://www.reddit.com/r/lyon/comments/abc123/a_title/"],
    ["reddit", "https://www.reddit.com/user/samrivera/comments/abc123/a_title/"],
    ["bluesky", "https://bsky.app/profile/sam.bsky.social/post/3kabcdefgh"],
    ["threads", "https://www.threads.net/@samrivera/post/C1abcdef"],
    ["twitch", "https://www.twitch.tv/samrivera/clip/TastyClipName"],
    ["twitch", "https://www.twitch.tv/directory/game/Chess"],
    ["github", "https://github.com/samrivera/akai-ito"],
    ["github", "https://github.com/orgs/kanji/people"],
    ["telegram", "https://t.me/+AbCdEfGhIjKl"],
    ["telegram", "https://t.me/joinchat/AAAAAEabcdef"],
    ["telegram", "https://t.me/lyondesign/451"],
    ["discord", "https://discord.gg/abcdef"],
    ["whatsapp", "https://chat.whatsapp.com/ABCdef123456"],
    ["whatsapp", "https://wa.me/message/ABCDEFGHIJKLM1"],
    ["snapchat", "https://www.snapchat.com/spotlight/abc123"],
    // Bare roots carry no handle either.
    ["instagram", "https://www.instagram.com/"],
    ["x", "https://x.com"],
    ["github", "https://github.com/"],
  ];

  for (const [key, url] of nonProfiles) {
    it(`returns null for ${url}`, () => {
      expect(parseSocialUrl(url)).toBeNull();
    });

    it(`refuses to make a ${key} handle out of ${url}`, () => {
      const result = normaliseSocialHandle(key, url);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("not-a-profile-url");
      expect(result.message.length).toBeGreaterThan(0);
    });
  }

  it("never turns an Instagram post id into a handle", () => {
    const result = normaliseSocialHandle(
      "instagram",
      "https://www.instagram.com/p/Cxyz1234/",
    );
    expect(result.ok).toBe(false);
    // No handle and no URL come back at all, so nothing downstream can store
    // the post id the lenient path would have produced.
    expect(result).not.toHaveProperty("handle");
    expect(result).not.toHaveProperty("url");
  });
});

describe("normaliseSocialHandle", () => {
  it("returns the canonical handle and the canonical URL for every platform", () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const handle = SAMPLE_HANDLES[platform.key];
      const result = normaliseSocialHandle(platform.key, handle);
      expect(result, `${platform.key} rejected its own sample`).toMatchObject({
        ok: true,
        key: platform.key,
        handle,
        url: platform.urlFor(handle),
      });
    }
  });

  it("rebuilds the URL from the registry instead of trusting what was pasted", () => {
    const result = normaliseSocialHandle(
      "instagram",
      "https://www.instagram.com/Sam.Rivera/?hl=en&igshid=abcdef",
    );
    expect(result).toEqual({
      ok: true,
      key: "instagram",
      handle: "sam.rivera",
      url: "https://instagram.com/sam.rivera",
    });
  });

  it("accepts the awkward Facebook hosts", () => {
    expect(
      normaliseSocialHandle("facebook", "https://m.facebook.com/sam.rivera/?ref=bookmarks"),
    ).toEqual({
      ok: true,
      key: "facebook",
      handle: "sam.rivera",
      url: "https://www.facebook.com/sam.rivera",
    });
  });

  it("accepts a URL with no scheme", () => {
    expect(normaliseSocialHandle("github", "github.com/samrivera")).toMatchObject({
      ok: true,
      handle: "samrivera",
    });
  });

  it("strips a leading @, whitespace, a trailing slash, and a query string", () => {
    for (const raw of [
      " @Sam.Rivera ",
      "@sam.rivera/",
      "sam.rivera?utm_source=newsletter",
      "sam.rivera#bio",
    ]) {
      expect(normaliseSocialHandle("instagram", raw), raw).toMatchObject({
        ok: true,
        handle: "sam.rivera",
      });
    }
  });

  it("reports a URL that belongs to another platform as a mismatch", () => {
    const result = normaliseSocialHandle("instagram", "https://x.com/samrivera");
    expect(result).toMatchObject({ ok: false, reason: "platform-mismatch" });
  });

  it("reports an unknown platform key", () => {
    expect(normaliseSocialHandle("insta", "sam.rivera")).toMatchObject({
      ok: false,
      reason: "unknown-platform",
    });
    expect(normaliseSocialHandle(null, "sam.rivera")).toMatchObject({
      ok: false,
      reason: "unknown-platform",
    });
  });

  it("reports an empty value", () => {
    expect(normaliseSocialHandle("instagram", "   ")).toMatchObject({
      ok: false,
      reason: "empty",
    });
  });

  it("rejects handles the platform could not issue", () => {
    const bad: Array<[SocialPlatformKey, string]> = [
      ["instagram", "sam rivera"],
      ["instagram", "sam@rivera"],
      ["instagram", "s".repeat(31)],
      ["x", "sam_rivera_the_designer"],
      ["linkedin", "ab"],
      ["linkedin", "sam_rivera"],
      ["github", "-samrivera"],
      ["github", "samrivera-"],
      ["telegram", "4ever"],
      ["telegram", "sam"],
      ["twitch", "sam"],
      ["bluesky", "samrivera"],
      ["reddit", "sam rivera"],
      ["whatsapp", "not-a-number"],
      ["website", "not a host"],
    ];

    for (const [key, raw] of bad) {
      const result = normaliseSocialHandle(key, raw);
      expect(result.ok, `${key} accepted "${raw}"`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("invalid-handle");
    }
  });

  it("keeps a Signal handle even though the platform has no URL", () => {
    expect(normaliseSocialHandle("signal", "@Sam.Rivera")).toEqual({
      ok: true,
      key: "signal",
      handle: "sam.rivera",
      url: null,
    });
  });

  it("takes a website as an address, with or without a scheme", () => {
    const bare = normaliseSocialHandle("website", "samrivera.dev");
    const full = normaliseSocialHandle("website", "https://www.samrivera.dev/");
    expect(bare).toEqual({
      ok: true,
      key: "website",
      handle: "samrivera.dev",
      url: "https://samrivera.dev",
    });
    expect(full).toEqual(bare);
  });

  it("strips a leading u/ from a Reddit username", () => {
    expect(normaliseSocialHandle("reddit", "u/SamRivera")).toEqual({
      ok: true,
      key: "reddit",
      handle: "samrivera",
      url: "https://www.reddit.com/user/samrivera",
    });
  });

  it("keeps a YouTube channel id as typed and gives it a /channel/ URL", () => {
    const channelId = "UCaBcDefghijklmnopqrstuv";
    expect(normaliseSocialHandle("youtube", channelId)).toEqual({
      ok: true,
      key: "youtube",
      handle: channelId,
      url: `https://www.youtube.com/channel/${channelId}`,
    });
  });
});

describe("normaliseSocialHandle alias resolution", () => {
  const aliases: Array<[string, SocialPlatformKey]> = [
    ["twitter", "x"],
    ["Twitter", "x"],
    ["bsky", "bluesky"],
    ["gh", "github"],
    ["fb", "facebook"],
    ["wa", "whatsapp"],
    ["tg", "telegram"],
    ["yt", "youtube"],
    ["snap", "snapchat"],
    ["homepage", "website"],
    // The label is matched too, not only the key and the aliases.
    ["LinkedIn", "linkedin"],
  ];

  for (const [alias, key] of aliases) {
    it(`resolves "${alias}" to ${key}`, () => {
      const result = normaliseSocialHandle(alias, SAMPLE_HANDLES[key]);
      expect(result).toMatchObject({ ok: true, key });
    });
  }

  it("stores the canonical key, so twitter writes an x row", () => {
    expect(normaliseSocialHandle("twitter", "@SamRivera")).toEqual({
      ok: true,
      key: "x",
      handle: "samrivera",
      url: "https://x.com/samrivera",
    });
  });
});

describe("normaliseSocialHandle WhatsApp digits", () => {
  it("reduces a written phone number to digits", () => {
    for (const raw of [
      "+33 6 12 34 56 78",
      "+33-6-12-34-56-78",
      "(33) 612 345 678",
      "33612345678",
    ]) {
      expect(normaliseSocialHandle("whatsapp", raw), raw).toEqual({
        ok: true,
        key: "whatsapp",
        handle: "33612345678",
        url: "https://wa.me/33612345678",
      });
    }
  });

  it("reads the number back out of a wa.me link and a send link", () => {
    expect(normaliseSocialHandle("whatsapp", "https://wa.me/33612345678")).toMatchObject({
      ok: true,
      handle: "33612345678",
    });
    expect(
      normaliseSocialHandle("whatsapp", "https://api.whatsapp.com/send?phone=33612345678"),
    ).toMatchObject({ ok: true, handle: "33612345678" });
  });

  it("rejects a number that is too short or too long to be dialled", () => {
    expect(normaliseSocialHandle("whatsapp", "12345")).toMatchObject({
      ok: false,
      reason: "invalid-handle",
    });
    expect(normaliseSocialHandle("whatsapp", "1234567890123456")).toMatchObject({
      ok: false,
      reason: "invalid-handle",
    });
  });
});

describe("normaliseSocialValue stays lenient", () => {
  // The contact dialog depends on this behaviour. The strict path was added
  // alongside it, not in place of it.

  it("keeps a pasted URL verbatim and shows its last segment", () => {
    expect(
      normaliseSocialValue("instagram", "https://www.instagram.com/sam.rivera/?hl=en"),
    ).toEqual({
      value: "sam.rivera",
      url: "https://www.instagram.com/sam.rivera/?hl=en",
    });
  });

  it("still turns a post URL into a handle, which is why the strict path exists", () => {
    expect(normaliseSocialValue("instagram", "https://www.instagram.com/p/Cxyz1234/")).toEqual({
      value: "Cxyz1234",
      url: "https://www.instagram.com/p/Cxyz1234/",
    });
  });

  it("returns an empty value for an empty input", () => {
    expect(normaliseSocialValue("instagram", "  ")).toEqual({ value: "", url: null });
  });

  it("passes an unknown platform through without a URL", () => {
    expect(normaliseSocialValue("myspace", "sam.rivera")).toEqual({
      value: "sam.rivera",
      url: null,
    });
  });

  it("strips a leading @ and builds the profile URL for a typed handle", () => {
    expect(normaliseSocialValue("instagram", "@sam.rivera")).toEqual({
      value: "sam.rivera",
      url: "https://instagram.com/sam.rivera",
    });
  });

  it("keeps a website value as the URL it is", () => {
    expect(normaliseSocialValue("website", "https://samrivera.dev/about")).toEqual({
      value: "https://samrivera.dev/about",
      url: "https://samrivera.dev/about",
    });
  });

  it("accepts a value the strict path would reject", () => {
    const raw = "Sam Rivera";
    expect(normaliseSocialValue("instagram", raw)).toEqual({
      value: raw,
      url: "https://instagram.com/Sam Rivera",
    });
    expect(normaliseSocialHandle("instagram", raw)).toMatchObject({ ok: false });
  });
});
