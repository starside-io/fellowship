import type { ContactKind } from "../schemas/enums.js";
import { getSocialPlatform, normaliseSocialHandle } from "./socials.js";

/*
 * One validator for every contact value, whoever is writing it.
 *
 * socials.ts already owns the handle half. This adds the two kinds it does not
 * cover, email and phone, and puts a single entry point in front of all three
 * so the UI and an assistant cannot disagree about what a stored value looks
 * like. The UI posts what the user typed and gets the canonical form back,
 * which is why no regex for any of this lives in the UI package.
 *
 * Like the strict social path, everything here rejects rather than repairs: a
 * value that cannot be an address on its kind comes back as a failure with a
 * reason, not as a plausible looking string.
 */

export type ContactValueResult =
  | { ok: true; value: string; url: string | null }
  | { ok: false; message: string };

function fail(message: string): ContactValueResult {
  return { ok: false, message };
}

/**
 * Deliberately narrower than RFC 5322: one @, a dotted host, and none of the
 * punctuation that only appears in quoted local parts. A tracker of people
 * wants the addresses people actually have, and a permissive pattern here is
 * how `sam@localhost` and `sam@@example.com` get stored as facts.
 */
const EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Hosts with no dot, which a typo produces far more often than a real address. */
const MAX_EMAIL_LENGTH = 254;

export function normaliseEmail(raw: string): ContactValueResult {
  const trimmed = raw.trim().replace(/^mailto:/i, "");
  if (!trimmed) return fail("An email address is required.");

  const at = trimmed.lastIndexOf("@");
  if (at < 1 || at === trimmed.length - 1) {
    return fail(`"${trimmed}" is not an email address: it needs a local part and a host.`);
  }

  // The domain is case insensitive and gets folded. The local part is not,
  // per RFC 5321, so it is left exactly as the user typed it.
  const value = `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;

  if (value.length > MAX_EMAIL_LENGTH) {
    return fail(`That address is ${value.length} characters, longer than an address can be.`);
  }
  if (!EMAIL.test(value)) {
    return fail(`"${trimmed}" is not a valid email address.`);
  }

  return { ok: true, value, url: `mailto:${value}` };
}

/** What a typed phone number may be made of, before the digits are pulled out. */
const PHONE_SHAPE = /^\+?[\d\s().\-/]+$/;
const MIN_PHONE_DIGITS = 6;
const MAX_PHONE_DIGITS = 15;

export function normalisePhone(raw: string): ContactValueResult {
  const trimmed = raw.trim().replace(/^tel:/i, "").trim();
  if (!trimmed) return fail("A phone number is required.");

  if (!PHONE_SHAPE.test(trimmed)) {
    return fail(`"${trimmed}" is not a phone number: it has letters or symbols in it.`);
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return fail(
      `"${trimmed}" has ${digits.length} digits. A phone number has ${MIN_PHONE_DIGITS} to ${MAX_PHONE_DIGITS}.`,
    );
  }

  // A number given with a country code is stored in E.164. One given without
  // stays national, because guessing the country is how a number stops
  // dialling.
  const value = trimmed.startsWith("+") ? `+${digits}` : digits;
  return { ok: true, value, url: `tel:${value}` };
}

/**
 * The canonical form of one contact value, and the address it opens.
 *
 * EMAIL and PHONE are validated here. SOCIAL and OTHER go through the strict
 * social path when the platform is one the registry knows, which is what turns
 * a typed handle into a profile URL. A platform outside the registry, or none
 * at all, is kept as typed: free text is what OTHER is for, and refusing it
 * would make the field useless.
 */
export function normaliseContactValue(
  kind: ContactKind,
  platform: string | null | undefined,
  raw: string,
): ContactValueResult {
  if (kind === "EMAIL") return normaliseEmail(raw);
  if (kind === "PHONE") return normalisePhone(raw);

  const known = getSocialPlatform(platform);
  if (!known) {
    const trimmed = raw.trim();
    if (!trimmed) return fail("A value is required.");
    return { ok: true, value: trimmed, url: null };
  }

  const result = normaliseSocialHandle(known.key, raw);
  if (!result.ok) return fail(result.message);
  return { ok: true, value: result.handle, url: result.url };
}
