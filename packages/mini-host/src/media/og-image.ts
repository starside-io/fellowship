// Reading the social preview image out of a page's markup.
//
// A home page is the one channel with no handle to expand into a URL, so the
// page itself is asked for its picture. Parsing is pure and lives here; the
// fetch that feeds it goes through the guard like every other request, and a
// candidate that is not https is dropped rather than downgraded.

/** The candidate produced from the website channel, when the page has one. */
export const OG_IMAGE_RESOLVER_ID = "website-og-image";

const META_TAG = /<meta\b[^>]*>/gi;
const ATTRIBUTE = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
/** In preference order: the explicit social image, then the Twitter fallback. */
const IMAGE_META_KEYS = [
  "og:image:secure_url",
  "og:image",
  "twitter:image",
  "twitter:image:src",
];

/** Pulls the social preview image out of a page's markup. */
export function parseOgImage(html: string, pageUrl: string): string | null {
  const found = new Map<string, string>();

  for (const tag of html.match(META_TAG) ?? []) {
    const attributes = new Map<string, string>();
    ATTRIBUTE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTRIBUTE.exec(tag)) !== null) {
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      attributes.set(match[1].toLowerCase(), value);
    }

    const key = (attributes.get("property") ?? attributes.get("name") ?? "")
      .trim()
      .toLowerCase();
    const content = attributes.get("content")?.trim();
    if (!key || !content || found.has(key)) continue;
    if (IMAGE_META_KEYS.includes(key)) found.set(key, content);
  }

  for (const key of IMAGE_META_KEYS) {
    const content = found.get(key);
    if (!content) continue;
    try {
      const resolved = new URL(decodeHtmlEntities(content), pageUrl);
      if (resolved.protocol !== "https:") continue;
      return resolved.href;
    } catch {
      continue;
    }
  }

  return null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Fetches a home page under the same guards and reads its preview image. */
