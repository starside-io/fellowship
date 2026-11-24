// The image fetch guard: the host's job, not the module's.
//
// Nothing here trusts a URL. A resolver template is owner supplied
// configuration pointing at third party services, and a URL an assistant found
// on a page is worse, so every fetch is treated as a request to an address
// nobody vetted:
//
//   - https only, no credentials in the URL
//   - the hostname is resolved and every address it answers with is checked
//     against loopback, link local and the RFC1918 ranges, so a URL can never
//     be aimed at this machine or this LAN
//   - at most 3 redirects, each hop re-checked the same way
//   - a hard 10s timeout and a 5MB cap enforced while the body streams
//   - an allowlist of image content types, then a re-encode through sharp,
//     which drops EXIF, because a face photo routinely carries the GPS point
//     it was taken at
//
// Ported from the reference implementation with the names generalised and the
// storage half left behind. It is the one piece of this project where a mistake
// is a hole rather than a bug.

import { lookup } from "node:dns/promises";

import sharp from "sharp";

export const IMAGE_TIMEOUT_MS = 10_000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
/** A home page only has to give up its head, so it gets a much smaller cap. */
export const MAX_PAGE_BYTES = 512 * 1024;
const IMAGE_EDGE = 400;
const USER_AGENT = "fellowship/1.0 (image fetcher)";

export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/*
 * Address guard.
 *
 * The check has to happen on the literal too, not only on what DNS answers,
 * because an address can be written in forms Node resolves but a naive string
 * comparison misses: 2130706433, 0x7f000001, and 127.1 are all 127.0.0.1.
 * parseIpv4 below implements the legacy inet_aton forms for that reason.
 */

function parseIpv4Part(part: string): number | null {
  if (part === "") return null;
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part.slice(2), 16);
  else if (/^0[0-7]+$/.test(part)) value = parseInt(part.slice(1), 8);
  else if (/^(?:0|[1-9][0-9]*)$/.test(part)) value = Number(part);
  else return null;
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
    ? value
    : null;
}

/** An IPv4 address as a 32 bit number, accepting the legacy short forms. */
function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const parsed = parseIpv4Part(part);
    if (parsed === null) return null;
    numbers.push(parsed);
  }

  const last = numbers[numbers.length - 1];
  const leading = numbers.slice(0, -1);
  if (leading.some((n) => n > 255)) return null;

  const span = 2 ** (8 * (4 - leading.length));
  if (last >= span) return null;

  let head = 0;
  for (const n of leading) head = head * 256 + n;
  return head * span + last;
}

function ipv6Bytes(value: string): number[] | null {
  let text = value.trim().toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toBytes = (chunk: string): number[] | null => {
    if (chunk === "") return [];
    const groups = chunk.split(":");
    const bytes: number[] = [];
    for (const [index, group] of groups.entries()) {
      // A trailing dotted group is an embedded IPv4 address.
      if (index === groups.length - 1 && group.includes(".")) {
        const v4 = parseIpv4(group);
        if (v4 === null) return null;
        bytes.push((v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const parsed = parseInt(group, 16);
      bytes.push((parsed >> 8) & 255, parsed & 255);
    }
    return bytes;
  };

  const head = toBytes(halves[0]);
  if (head === null) return null;

  if (halves.length === 1) return head.length === 16 ? head : null;

  const tail = toBytes(halves[1]);
  if (tail === null) return null;

  const fill = 16 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function isBlockedIpv4(address: number): boolean {
  const inRange = (prefix: string, bits: number): boolean => {
    const base = parseIpv4(prefix);
    if (base === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (address >>> 0 & mask) === (base >>> 0 & mask);
  };

  return (
    inRange("0.0.0.0", 8) || // "this network"
    inRange("10.0.0.0", 8) || // RFC1918
    inRange("100.64.0.0", 10) || // carrier grade NAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link local, including cloud metadata
    inRange("172.16.0.0", 12) || // RFC1918
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.168.0.0", 16) || // RFC1918
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved, includes 255.255.255.255
  );
}

function isBlockedIpv6(bytes: number[]): boolean {
  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return true;

  // ::1
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;

  // ::ffff:a.b.c.d and the deprecated ::a.b.c.d, both carry an IPv4 address.
  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
  if (firstTenZero && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) {
    const v4 =
      ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
    return isBlockedIpv4(v4);
  }

  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  return false;
}

/**
 * True when a host literal is an address that must never be fetched: loopback,
 * link local, or private space, in any notation. A plain hostname returns
 * false here, it is judged on what DNS resolves it to instead.
 */
export function isBlockedAddress(value: string): boolean {
  const text = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (text === "") return true;

  if (text.includes(":")) {
    const bytes = ipv6Bytes(text);
    return bytes === null ? false : isBlockedIpv6(bytes);
  }

  const v4 = parseIpv4(text);
  return v4 === null ? false : isBlockedIpv4(v4);
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** Names that resolve inside the machine or the LAN, before DNS is consulted. */
export function isBlockedHostname(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (name === "" || name === "localhost") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return isBlockedAddress(name);
}

export class ImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageFetchError";
  }
}

function fail(message: string): never {
  throw new ImageFetchError(message);
}

/**
 * Every gate a URL has to pass before it is fetched, including on each redirect
 * hop. The DNS answer is checked rather than trusted: a hostname the owner
 * pasted may point at 127.0.0.1 or at 192.168.1.1 today.
 *
 * There is a residual race here, since the socket resolves the name again after
 * this check. Closing it would mean pinning the connection to the address that
 * was checked, which breaks TLS validation on hosts that answer on many
 * addresses. For a single user app fetching public avatar endpoints, the check
 * plus the redirect re-check is the proportionate guard.
 */
export async function assertFetchableUrl(raw: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    fail(`Not a valid URL: ${String(raw)}`);
  }

  if (url.protocol !== "https:") fail(`Refusing a non https URL: ${url.href}`);
  if (url.username !== "" || url.password !== "") {
    fail("Refusing a URL that carries credentials");
  }

  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isBlockedHostname(host)) {
    fail(`Refusing a private or local address: ${host}`);
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    fail(`Could not resolve ${host}`);
  }

  if (addresses.length === 0) fail(`Could not resolve ${host}`);

  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      fail(`${host} resolves to a private address (${entry.address})`);
    }
  }

  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type GuardedResponse = { response: Response; url: URL };

/** Follows redirects by hand so each target goes back through the guard. */
async function guardedFetch(
  raw: string,
  accept: string,
  signal: AbortSignal,
): Promise<GuardedResponse> {
  let url = await assertFetchableUrl(raw);

  for (let hop = 0; ; hop += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { accept, "user-agent": USER_AGENT },
    });

    if (!REDIRECT_STATUSES.has(response.status)) return { response, url };

    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) fail(`${url.href} redirected without a location`);
    if (hop >= MAX_REDIRECTS) fail(`Too many redirects from ${raw}`);

    url = await assertFetchableUrl(new URL(location, url));
  }
}

/**
 * Reads a body while counting bytes, so an endpoint that lies about, or omits,
 * content-length still cannot make this process hold more than the cap.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail(`Body is ${declared} bytes, over the ${maxBytes} byte cap`);
  }

  const body = response.body;
  if (!body) fail("Response had no body");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      fail(`Body exceeded the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

function contentTypeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

export type NormalisedImage = {
  /** Plain Uint8Array rather than Buffer, which is what the Bytes column takes. */
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  width: number;
  height: number;
};

/**
 * Re-encodes to a 400px webp. sharp copies no metadata unless asked to, so the
 * stored bytes carry no EXIF: this is a photograph of a person, and the tags
 * routinely include the GPS point where it was taken.
 */
export async function normaliseImageBytes(input: Buffer): Promise<NormalisedImage> {
  const result = await sharp(input, { failOn: "error" })
    // Applies the orientation tag while it is still readable, since the
    // re-encode drops it.
    .rotate()
    .resize(IMAGE_EDGE, IMAGE_EDGE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: new Uint8Array(result.data),
    mime: "image/webp",
    width: result.info.width,
    height: result.info.height,
  };
}

export type GuardedImage = NormalisedImage & {
  /** The URL the bytes actually came from, after any redirects. */
  finalUrl: string;
  /** What the server sent, before the re-encode. */
  sourceMime: string;
  sourceBytes: number;
};

export async function fetchGuardedImage(url: string): Promise<GuardedImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const { response, url: finalUrl } = await guardedFetch(
      url,
      "image/jpeg,image/png,image/webp,image/gif;q=0.9,*/*;q=0.1",
      controller.signal,
    );

    if (!response.ok) {
      await response.body?.cancel();
      fail(`${finalUrl.href} answered ${response.status}`);
    }

    const mime = contentTypeOf(response);
    if (!ALLOWED_IMAGE_MIME.has(mime)) {
      await response.body?.cancel();
      fail(`${finalUrl.href} answered with ${mime || "no content type"}`);
    }

    const raw = await readCapped(response, MAX_IMAGE_BYTES);
    if (raw.byteLength === 0) fail(`${finalUrl.href} answered with an empty body`);

    let normalised: NormalisedImage;
    try {
      normalised = await normaliseImageBytes(raw);
    } catch (error) {
      fail(`Could not decode the image: ${errorMessage(error)}`);
    }

    return {
      ...normalised,
      finalUrl: finalUrl.href,
      sourceMime: mime,
      sourceBytes: raw.byteLength,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      fail(`Timed out after ${IMAGE_TIMEOUT_MS}ms fetching ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}


export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
