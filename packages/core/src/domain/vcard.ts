import { NO_YEAR, hasYear } from "./birthday.js";
import { getSocialPlatform } from "./socials.js";

/**
 * Contact cards a phone can import.
 *
 * vCard 3.0, because it is the version iOS Contacts, macOS Contacts and
 * Google Contacts all read without complaint. One card per person, several
 * cards to one file for a bulk import. Socials go out twice: as an
 * X-SOCIALPROFILE line, which Apple Contacts shows under the platform's name,
 * and as a URL line, which every other reader at least keeps.
 */

export interface VCardPerson {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  /** Date only, midnight UTC. */
  birthday: Date | null;
  location: string | null;
  howWeMet: string | null;
  contacts: Array<{
    kind: string;
    platform: string | null;
    value: string;
    url: string | null;
    isPrimary: boolean;
    label: string | null;
  }>;
  circles: Array<{ name: string }>;
  /** The stored picture, when there is one and the caller wants it. */
  photo: { bytes: Uint8Array; mime: string } | null;
}

/** Commas, semicolons, backslashes and newlines are structure in a vCard value. */
export function escapeValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Lines longer than 75 octets are folded: a CRLF and one space, which a
 * reader removes. Folding counts bytes, not characters, and never splits a
 * multi byte character.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  // The first line holds 75 octets, each continuation 74 after its space.
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** The kind of photo a vCard 3.0 TYPE parameter names. */
function photoType(mime: string): string | null {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "JPEG";
    case "image/png":
      return "PNG";
    case "image/gif":
      return "GIF";
    default:
      // WebP and AVIF are not types most contact apps read. Leaving the
      // picture out beats a card that fails to import.
      return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** The two names a card carries, from what is stored. */
function names(person: VCardPerson): { given: string; family: string } {
  if (person.firstName || person.lastName) {
    return { given: person.firstName ?? "", family: person.lastName ?? "" };
  }
  // Only a display name: everything before the last word is the given name.
  const parts = person.displayName.trim().split(/\s+/);
  if (parts.length === 1) return { given: parts[0] ?? "", family: "" };
  return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1] ?? "" };
}

function typeParam(label: string | null, fallback: string, isPrimary: boolean): string {
  const types = [label && /^[a-z]+$/i.test(label) ? label.toUpperCase() : fallback];
  if (isPrimary) types.push("PREF");
  return types.join(",");
}

/** True when a contacts app can read the picture as stored. */
export function photoIsPortable(mime: string): boolean {
  return photoType(mime) !== null;
}

export function buildVCard(person: VCardPerson): string {
  const { given, family } = names(person);
  const fullName = [person.firstName, person.lastName].filter(Boolean).join(" ");
  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:urn:uuid:${person.id}`,
    `N:${escapeValue(family)};${escapeValue(given)};;;`,
    // A phone lists people by their full name. What you call them goes in
    // NICKNAME when it is something else.
    `FN:${escapeValue(fullName || person.displayName)}`,
  ];

  if (fullName && person.displayName !== fullName && person.displayName !== person.firstName) {
    lines.push(`NICKNAME:${escapeValue(person.displayName)}`);
  }

  if (person.birthday) {
    const day = person.birthday.toISOString().slice(0, 10);
    // A birthday with no known year keeps Apple's placeholder year and says
    // so, which Contacts reads as a day and a month only.
    lines.push(
      hasYear(person.birthday) ? `BDAY:${day}` : `BDAY;X-APPLE-OMIT-YEAR=${NO_YEAR}:${day}`,
    );
  }

  for (const contact of person.contacts) {
    if (contact.kind === "PHONE") {
      lines.push(
        `TEL;TYPE=${typeParam(contact.label, "CELL", contact.isPrimary)}:${escapeValue(contact.value)}`,
      );
    } else if (contact.kind === "EMAIL") {
      lines.push(
        `EMAIL;TYPE=INTERNET,${typeParam(contact.label, "HOME", contact.isPrimary)}:${escapeValue(contact.value)}`,
      );
    } else if (contact.kind === "SOCIAL") {
      const platform = contact.platform ? getSocialPlatform(contact.platform) : undefined;
      const url = contact.url ?? platform?.urlFor(contact.value.replace(/^@/, "")) ?? null;
      const type = (platform?.key ?? contact.platform ?? "social").toLowerCase();
      if (platform?.key === "website") {
        if (url) lines.push(`URL:${escapeValue(url)}`);
        continue;
      }
      lines.push(
        `X-SOCIALPROFILE;TYPE=${type};x-user=${escapeValue(contact.value.replace(/^@/, ""))}:${escapeValue(
          url ?? contact.value,
        )}`,
      );
      if (url) lines.push(`URL;TYPE=${type}:${escapeValue(url)}`);
    } else if (contact.url) {
      lines.push(`URL:${escapeValue(contact.url)}`);
    }
  }

  if (person.location) {
    // Free text, so it goes in the locality slot rather than being guessed
    // apart into a street and a city.
    lines.push(`ADR;TYPE=HOME:;;;${escapeValue(person.location)};;;`);
  }

  if (person.circles.length > 0) {
    lines.push(`CATEGORIES:${person.circles.map((circle) => escapeValue(circle.name)).join(",")}`);
  }

  if (person.howWeMet) {
    lines.push(`NOTE:${escapeValue(`How we met: ${person.howWeMet}`)}`);
  }

  if (person.photo) {
    const type = photoType(person.photo.mime);
    if (type) lines.push(`PHOTO;ENCODING=b;TYPE=${type}:${toBase64(person.photo.bytes)}`);
  }

  lines.push("END:VCARD");
  return lines.map(foldLine).join("\r\n");
}

/** Several cards in one file, which every contacts app imports in one go. */
export function buildVCards(people: VCardPerson[]): string {
  return people.map(buildVCard).join("\r\n") + "\r\n";
}

/** A file name that survives every file system. */
export function vcardFileName(people: Array<{ displayName: string }>, now: Date): string {
  if (people.length === 1) {
    const slug = people[0]!.displayName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${slug || "contact"}.vcf`;
  }
  return `fellowship-contacts-${now.toISOString().slice(0, 10)}.vcf`;
}
