import { describe, expect, it } from "vitest";

import {
  buildVCard,
  buildVCards,
  escapeValue,
  foldLine,
  photoIsPortable,
  vcardFileName,
  type VCardPerson,
} from "../../src/domain/vcard.js";

/**
 * vCard 3.0 as phones import it: escaped values, lines folded at 75 octets,
 * CRLF between lines, and a birthday with no year in Apple's 1604 form.
 */

const encoder = new TextEncoder();

function person(overrides: Partial<VCardPerson> = {}): VCardPerson {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "Sam Rivera",
    firstName: null,
    lastName: null,
    birthday: null,
    location: null,
    howWeMet: null,
    contacts: [],
    circles: [],
    photo: null,
    ...overrides,
  };
}

function contact(
  overrides: Partial<VCardPerson["contacts"][number]> &
    Pick<VCardPerson["contacts"][number], "kind" | "value">,
): VCardPerson["contacts"][number] {
  return { platform: null, url: null, isPrimary: false, label: null, ...overrides };
}

/** The logical lines of a card, folding undone. */
function lines(card: string): string[] {
  return card.replace(/\r\n /g, "").split("\r\n");
}

function unfold(text: string): string {
  return text.replace(/\r\n /g, "");
}

describe("escapeValue", () => {
  it("escapes backslashes, commas, semicolons and newlines", () => {
    expect(escapeValue("a\\b")).toBe("a\\\\b");
    expect(escapeValue("a,b")).toBe("a\\,b");
    expect(escapeValue("a;b")).toBe("a\\;b");
    expect(escapeValue("a\nb")).toBe("a\\nb");
    expect(escapeValue("a\r\nb")).toBe("a\\nb");
  });

  it("escapes the backslash first, so an escape is not escaped twice", () => {
    expect(escapeValue("\\,")).toBe("\\\\\\,");
  });

  it("leaves plain text alone", () => {
    expect(escapeValue("Sam Rivera")).toBe("Sam Rivera");
  });
});

describe("foldLine", () => {
  it("leaves a line of 75 octets or fewer alone", () => {
    const line = "x".repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it("keeps every physical line at 75 octets or fewer, continuations starting with a space", () => {
    const line = `NOTE:${"abcdefghij".repeat(30)}`;
    const folded = foldLine(line);
    const physical = folded.split("\r\n");

    expect(physical.length).toBeGreaterThan(1);
    for (const [index, part] of physical.entries()) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
      if (index > 0) expect(part.startsWith(" ")).toBe(true);
    }
    expect(unfold(folded)).toBe(line);
  });

  it("counts bytes and never splits a multi byte character", () => {
    const line = `NOTE:${"é".repeat(60)}${"😀".repeat(20)}${"日本".repeat(20)}`;
    const folded = foldLine(line);
    const physical = folded.split("\r\n");

    expect(physical.length).toBeGreaterThan(1);
    for (const part of physical) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
      // A lone surrogate would mean an emoji was cut in half.
      expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(part).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      // And each physical line decodes back to itself.
      expect(new TextDecoder().decode(encoder.encode(part))).toBe(part);
    }
    expect(unfold(folded)).toBe(line);
  });
});

describe("buildVCard", () => {
  it("writes N and FN from first and last name", () => {
    const card = lines(buildVCard(person({ firstName: "Sam", lastName: "Rivera" })));
    expect(card).toContain("N:Rivera;Sam;;;");
    expect(card).toContain("FN:Sam Rivera");
  });

  it("falls back to the display name for FN and splits it for N", () => {
    const card = lines(buildVCard(person({ displayName: "Mary Ann Smith" })));
    expect(card).toContain("FN:Mary Ann Smith");
    expect(card).toContain("N:Smith;Mary Ann;;;");

    const single = lines(buildVCard(person({ displayName: "Cher" })));
    expect(single).toContain("FN:Cher");
    expect(single).toContain("N:;Cher;;;");
  });

  it("writes NICKNAME only when the display name differs from the full name and the first name", () => {
    const nick = lines(
      buildVCard(person({ displayName: "Sammy", firstName: "Sam", lastName: "Rivera" })),
    );
    expect(nick).toContain("NICKNAME:Sammy");

    const sameAsFull = lines(
      buildVCard(person({ displayName: "Sam Rivera", firstName: "Sam", lastName: "Rivera" })),
    );
    expect(sameAsFull.some((line) => line.startsWith("NICKNAME"))).toBe(false);

    const sameAsFirst = lines(
      buildVCard(person({ displayName: "Sam", firstName: "Sam", lastName: "Rivera" })),
    );
    expect(sameAsFirst.some((line) => line.startsWith("NICKNAME"))).toBe(false);

    // No first or last name: the display name is already FN.
    const noNames = lines(buildVCard(person({ displayName: "Sammy" })));
    expect(noNames.some((line) => line.startsWith("NICKNAME"))).toBe(false);
  });

  it("writes a birthday with a year plainly, and one without in Apple's 1604 form", () => {
    const withYear = lines(
      buildVCard(person({ birthday: new Date("1990-03-14T00:00:00.000Z") })),
    );
    expect(withYear).toContain("BDAY:1990-03-14");

    const withoutYear = lines(
      buildVCard(person({ birthday: new Date("1604-07-09T00:00:00.000Z") })),
    );
    expect(withoutYear).toContain("BDAY;X-APPLE-OMIT-YEAR=1604:1604-07-09");
    expect(withoutYear.some((line) => line.startsWith("BDAY:"))).toBe(false);
  });

  it("writes TEL and EMAIL lines, with PREF on the primary one", () => {
    const card = lines(
      buildVCard(
        person({
          contacts: [
            contact({ kind: "PHONE", value: "+33612345678", isPrimary: true }),
            contact({ kind: "PHONE", value: "+33100000000", label: "work" }),
            contact({ kind: "EMAIL", value: "sam@example.test", isPrimary: true }),
            contact({ kind: "EMAIL", value: "sam@work.test", label: "work" }),
          ],
        }),
      ),
    );
    expect(card).toContain("TEL;TYPE=CELL,PREF:+33612345678");
    expect(card).toContain("TEL;TYPE=WORK:+33100000000");
    expect(card).toContain("EMAIL;TYPE=INTERNET,HOME,PREF:sam@example.test");
    expect(card).toContain("EMAIL;TYPE=INTERNET,WORK:sam@work.test");
  });

  it("writes a social as X-SOCIALPROFILE and URL", () => {
    const card = lines(
      buildVCard(
        person({
          contacts: [contact({ kind: "SOCIAL", platform: "instagram", value: "@sam.rivera" })],
        }),
      ),
    );
    expect(card).toContain(
      "X-SOCIALPROFILE;TYPE=instagram;x-user=sam.rivera:https://instagram.com/sam.rivera",
    );
    expect(card).toContain("URL;TYPE=instagram:https://instagram.com/sam.rivera");
  });

  it("writes a website as a URL line only", () => {
    const card = lines(
      buildVCard(
        person({
          contacts: [contact({ kind: "SOCIAL", platform: "website", value: "samrivera.dev" })],
        }),
      ),
    );
    expect(card).toContain("URL:https://samrivera.dev");
    expect(card.some((line) => line.startsWith("X-SOCIALPROFILE"))).toBe(false);
  });

  it("writes ADR, CATEGORIES and NOTE, escaped", () => {
    const card = lines(
      buildVCard(
        person({
          location: "Lyon, France",
          circles: [{ name: "Climbing" }, { name: "Work; old" }],
          howWeMet: "At the gym, 2019",
        }),
      ),
    );
    expect(card).toContain("ADR;TYPE=HOME:;;;Lyon\\, France;;;");
    expect(card).toContain("CATEGORIES:Climbing,Work\\; old");
    expect(card).toContain("NOTE:How we met: At the gym\\, 2019");
  });

  it("leaves ADR, CATEGORIES and NOTE out when there is nothing to say", () => {
    const card = lines(buildVCard(person()));
    for (const prefix of ["ADR", "CATEGORIES", "NOTE", "BDAY", "PHOTO", "NICKNAME"]) {
      expect(card.some((line) => line.startsWith(prefix)), prefix).toBe(false);
    }
  });

  it("writes PHOTO for JPEG, PNG and GIF and leaves WebP out", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const base64 = Buffer.from(bytes).toString("base64");

    for (const [mime, type] of [
      ["image/jpeg", "JPEG"],
      ["image/png", "PNG"],
      ["image/gif", "GIF"],
    ] as const) {
      const card = lines(buildVCard(person({ photo: { bytes, mime } })));
      expect(card).toContain(`PHOTO;ENCODING=b;TYPE=${type}:${base64}`);
    }

    const webp = lines(buildVCard(person({ photo: { bytes, mime: "image/webp" } })));
    expect(webp.some((line) => line.startsWith("PHOTO"))).toBe(false);
  });

  it("separates lines with CRLF and nothing else", () => {
    const card = buildVCard(
      person({ firstName: "Sam", lastName: "Rivera", howWeMet: "line one\nline two" }),
    );
    expect(card.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(card.endsWith("\r\nEND:VCARD")).toBe(true);
    expect(card.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("folds a long photo line", () => {
    const bytes = new Uint8Array(500).fill(7);
    const card = buildVCard(person({ photo: { bytes, mime: "image/png" } }));
    for (const physical of card.split("\r\n")) {
      expect(encoder.encode(physical).length).toBeLessThanOrEqual(75);
    }
  });
});

describe("photoIsPortable", () => {
  it("is true for the formats contact apps read", () => {
    expect(photoIsPortable("image/jpeg")).toBe(true);
    expect(photoIsPortable("image/jpg")).toBe(true);
    expect(photoIsPortable("IMAGE/PNG")).toBe(true);
    expect(photoIsPortable("image/gif")).toBe(true);
  });

  it("is false for WebP and AVIF", () => {
    expect(photoIsPortable("image/webp")).toBe(false);
    expect(photoIsPortable("image/avif")).toBe(false);
  });
});

describe("buildVCards", () => {
  it("writes one BEGIN and END per person and ends with CRLF", () => {
    const file = buildVCards([
      person({ id: "a", displayName: "Ada" }),
      person({ id: "b", displayName: "Bo" }),
      person({ id: "c", displayName: "Cy" }),
    ]);
    expect(file.split("\r\n").filter((line) => line === "BEGIN:VCARD")).toHaveLength(3);
    expect(file.split("\r\n").filter((line) => line === "END:VCARD")).toHaveLength(3);
    expect(file.endsWith("END:VCARD\r\n")).toBe(true);
    expect(file.endsWith("\r\n\r\n")).toBe(false);
  });
});

describe("vcardFileName", () => {
  const now = new Date("2026-11-24T10:00:00.000Z");

  it("names a single card after the person, accents stripped", () => {
    expect(vcardFileName([{ displayName: "Zoé Lefèvre" }], now)).toBe("Zoe-Lefevre.vcf");
    expect(vcardFileName([{ displayName: "  Sam  O'Neil! " }], now)).toBe("Sam-O-Neil.vcf");
  });

  it("falls back to contact when nothing is left of the name", () => {
    expect(vcardFileName([{ displayName: "日本" }], now)).toBe("contact.vcf");
  });

  it("names several cards after the day", () => {
    expect(vcardFileName([{ displayName: "Ada" }, { displayName: "Bo" }], now)).toBe(
      "fellowship-contacts-2026-11-24.vcf",
    );
    expect(vcardFileName([], now)).toBe("fellowship-contacts-2026-11-24.vcf");
  });
});
