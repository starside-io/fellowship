import { describe, expect, it } from "vitest";
import {
  DEFAULT_AVATAR_RESOLVERS,
  EMAIL_RESOLVER_PLATFORM,
  avatarResolverSchema,
  buildResolverCandidates,
  checkAvatarTemplate,
  expandAvatarTemplate,
  gravatarHash,
  type AvatarResolver,
  type CandidateChannel,
} from "../../src/config/avatar-resolvers.js";

// The resolver list: template expansion, template validation and candidate
// ordering. Pure, and core's, because it is the resolver config and the socials
// registry talking to each other.
//
// The private address guard and the og:image parsing that used to sit beside
// these moved with the fetch itself, into the host: see
// packages/mini-host/tests/media.test.ts.

function resolver(overrides: Partial<AvatarResolver> = {}): AvatarResolver {
  return {
    id: "github",
    label: "GitHub",
    platform: "github",
    urlTemplate: "https://github.com/{handle}.png?size=400",
    enabled: true,
    ...overrides,
  };
}

describe("template expansion", () => {
  it("fills the handle in", () => {
    expect(expandAvatarTemplate(resolver(), { handle: "jdoe" })).toBe(
      "https://github.com/jdoe.png?size=400",
    );
  });

  it("percent encodes a handle so it cannot reshape the URL", () => {
    const url = expandAvatarTemplate(resolver(), {
      handle: "../../etc/passwd?x=1 y&z",
    });

    expect(url).toBe(
      "https://github.com/..%2F..%2Fetc%2Fpasswd%3Fx%3D1%20y%26z.png?size=400",
    );
    // The encoded value stays inside the path segment it was meant for.
    expect(new URL(url!).pathname).toBe(
      "/..%2F..%2Fetc%2Fpasswd%3Fx%3D1%20y%26z.png",
    );
    expect(new URL(url!).searchParams.get("x")).toBeNull();
  });

  it("substitutes the platform placeholder", () => {
    const url = expandAvatarTemplate(
      resolver({
        id: "unavatar",
        platform: "instagram",
        urlTemplate: "https://unavatar.io/{platform}/{handle}",
      }),
      { handle: "sam.rivera" },
    );

    expect(url).toBe("https://unavatar.io/instagram/sam.rivera");
  });

  it("hashes the address for an email resolver", () => {
    const gravatar = DEFAULT_AVATAR_RESOLVERS.find((entry) => entry.id === "gravatar");
    const url = expandAvatarTemplate(gravatar!, { email: "  Sam.Rivera@Example.com " });

    expect(url).toBe(
      "https://www.gravatar.com/avatar/168eb0d5cf337a4e5c634305f7be6bd293b04cea20ce293704546b52f526dd12?s=400&d=404",
    );
    // The raw address never appears in the URL.
    expect(url).not.toContain("example.com");
  });

  it("returns null when the value the resolver needs is missing", () => {
    expect(expandAvatarTemplate(resolver(), { handle: "   " })).toBeNull();
    expect(
      expandAvatarTemplate(resolver({ platform: EMAIL_RESOLVER_PLATFORM }), {
        handle: "sam",
      }),
    ).toBeNull();
  });
});

describe("gravatar hash", () => {
  it("is the sha256 of the trimmed lower cased address", () => {
    expect(gravatarHash("sam.rivera@example.com")).toBe(
      "168eb0d5cf337a4e5c634305f7be6bd293b04cea20ce293704546b52f526dd12",
    );
    expect(gravatarHash("  SAM.RIVERA@EXAMPLE.COM  ")).toBe(
      gravatarHash("sam.rivera@example.com"),
    );
  });
});

describe("template validation", () => {
  it("accepts the shipped defaults", () => {
    for (const entry of DEFAULT_AVATAR_RESOLVERS) {
      expect(avatarResolverSchema.safeParse(entry).success).toBe(true);
      expect(checkAvatarTemplate(entry.urlTemplate, entry.platform)).toBeNull();
    }
  });

  it("rejects http", () => {
    expect(checkAvatarTemplate("http://github.com/{handle}.png", "github")).toBe(
      "not-https",
    );
    expect(
      avatarResolverSchema.safeParse(
        resolver({ urlTemplate: "http://github.com/{handle}.png" }),
      ).success,
    ).toBe(false);
  });

  it("rejects credentials in the URL", () => {
    expect(
      checkAvatarTemplate("https://user:secret@github.com/{handle}.png", "github"),
    ).toBe("has-credentials");
    expect(checkAvatarTemplate("https://user@github.com/{handle}.png", "github")).toBe(
      "has-credentials",
    );
  });

  it("demands a handle placeholder, or a hash for an email resolver", () => {
    expect(checkAvatarTemplate("https://github.com/sam.png", "github")).toBe(
      "missing-handle",
    );
    expect(
      checkAvatarTemplate(
        "https://www.gravatar.com/avatar/{handle}",
        EMAIL_RESOLVER_PLATFORM,
      ),
    ).toBe("missing-hash");
    expect(
      checkAvatarTemplate(
        "https://www.gravatar.com/avatar/{hash}?s=400",
        EMAIL_RESOLVER_PLATFORM,
      ),
    ).toBeNull();
  });

  it("rejects nonsense and whitespace", () => {
    expect(checkAvatarTemplate("not a url {handle}", "github")).toBe("has-whitespace");
    expect(checkAvatarTemplate("ftp://host/{handle}", "github")).toBe("not-https");
    expect(checkAvatarTemplate("/avatars/{handle}.png", "github")).toBe("not-a-url");
  });

  it("rejects a duplicate or malformed id", () => {
    expect(avatarResolverSchema.safeParse(resolver({ id: "Bad Id" })).success).toBe(
      false,
    );
    expect(avatarResolverSchema.safeParse(resolver({ label: "" })).success).toBe(false);
    expect(
      avatarResolverSchema.safeParse(resolver({ platform: "myspace" as never })).success,
    ).toBe(false);
  });
});

describe("candidate ordering", () => {
  const resolvers: AvatarResolver[] = [
    resolver(),
    resolver({
      id: "gravatar",
      label: "Gravatar",
      platform: EMAIL_RESOLVER_PLATFORM,
      urlTemplate: "https://www.gravatar.com/avatar/{hash}?s=400&d=404",
    }),
    resolver({
      id: "instagram-unavatar",
      label: "Instagram",
      platform: "instagram",
      urlTemplate: "https://unavatar.io/{platform}/{handle}",
      enabled: false,
    }),
  ];

  const channels: CandidateChannel[] = [
    { kind: "SOCIAL", platform: "instagram", value: "sam.rivera", url: null },
    { kind: "EMAIL", platform: null, value: "sam.rivera@example.com", url: null },
    { kind: "SOCIAL", platform: "github", value: "jdoe", url: null },
  ];

  it("follows resolver order, not channel order, and skips disabled ones", () => {
    const candidates = buildResolverCandidates(resolvers, channels);

    expect(candidates.map((candidate) => candidate.resolverId)).toEqual([
      "github",
      "gravatar",
    ]);
    expect(candidates[0].url).toBe("https://github.com/jdoe.png?size=400");
    expect(candidates[0].handle).toBe("jdoe");
    // The hashed address is not echoed back into the report.
    expect(candidates[1].handle).toBeNull();
  });

  it("includes a disabled resolver once it is enabled", () => {
    const enabled = resolvers.map((entry) =>
      entry.id === "instagram-unavatar" ? { ...entry, enabled: true } : entry,
    );

    expect(buildResolverCandidates(enabled, channels).map((entry) => entry.url)).toEqual([
      "https://github.com/jdoe.png?size=400",
      "https://www.gravatar.com/avatar/168eb0d5cf337a4e5c634305f7be6bd293b04cea20ce293704546b52f526dd12?s=400&d=404",
      "https://unavatar.io/instagram/sam.rivera",
    ]);
  });

  it("matches platform aliases and produces nothing for an unmatched resolver", () => {
    const aliased: CandidateChannel[] = [
      { kind: "SOCIAL", platform: "gh", value: "jdoe", url: null },
    ];

    expect(buildResolverCandidates(resolvers, aliased)).toHaveLength(1);
    expect(buildResolverCandidates(resolvers, [])).toEqual([]);
  });

  it("keeps one candidate per URL when a handle repeats", () => {
    const duplicated: CandidateChannel[] = [
      { kind: "SOCIAL", platform: "github", value: "jdoe", url: null },
      { kind: "SOCIAL", platform: "github", value: "jdoe", url: null },
    ];

    expect(buildResolverCandidates(resolvers, duplicated)).toHaveLength(1);
  });
});

describe("the shipped order", () => {
  it("tries LinkedIn, then TikTok, then YouTube", () => {
    const enabled = DEFAULT_AVATAR_RESOLVERS.filter((entry) => entry.enabled).map(
      (entry) => entry.platform,
    );
    expect(enabled.slice(0, 3)).toEqual(["linkedin", "tiktok", "youtube"]);
  });

  it("asks unavatar for the LinkedIn slug the way its path wants it", () => {
    const linkedin = DEFAULT_AVATAR_RESOLVERS.find(
      (entry) => entry.platform === "linkedin",
    );
    expect(linkedin?.urlTemplate).toContain("/user:{handle}");

    const url = expandAvatarTemplate(linkedin!, {
      handle: "sam-rivera-123",
      email: "",
    });
    expect(url).toBe("https://unavatar.io/linkedin/user:sam-rivera-123?fallback=false");
  });

  it("refuses the generated tile on every resolver that could return one", () => {
    // Without fallback=false unavatar answers 200 with a letter tile, and
    // every person ends up with a picture that is not theirs.
    for (const entry of DEFAULT_AVATAR_RESOLVERS) {
      if (!entry.urlTemplate.includes("unavatar.io")) continue;
      expect(entry.urlTemplate, entry.id).toContain("fallback=false");
    }
  });

  it("ships Instagram disabled while unavatar is blocked there", () => {
    const instagram = DEFAULT_AVATAR_RESOLVERS.find(
      (entry) => entry.platform === "instagram",
    );
    expect(instagram?.enabled).toBe(false);
  });

  it("builds one candidate per matching handle, in the shipped order", () => {
    const channels: CandidateChannel[] = [
      { kind: "SOCIAL", platform: "youtube", value: "janedoe", url: null },
      { kind: "SOCIAL", platform: "linkedin", value: "jane-doe", url: null },
      { kind: "SOCIAL", platform: "snapchat", value: "janedoe", url: null },
    ];

    expect(
      buildResolverCandidates(DEFAULT_AVATAR_RESOLVERS, channels).map((entry) => entry.url),
    ).toEqual([
      "https://unavatar.io/linkedin/user:jane-doe?fallback=false",
      "https://unavatar.io/youtube/janedoe?fallback=false",
    ]);
  });
});
