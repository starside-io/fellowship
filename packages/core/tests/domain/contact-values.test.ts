import { describe, expect, it } from "vitest";

import {
  normaliseContactValue,
  normaliseEmail,
  normalisePhone,
} from "../../src/domain/contact-values.js";

/**
 * The validator every contact value goes through, whoever is writing it.
 *
 * The thing worth pinning down is that it rejects rather than repairs: a
 * tracker that stores "sam@@example.com" because something had to be stored is
 * a tracker whose contact card cannot be trusted.
 */

describe("normaliseEmail", () => {
  it("folds the host and leaves the local part alone", () => {
    expect(normaliseEmail("  Sam.Rivera@Example.COM ")).toEqual({
      ok: true,
      value: "Sam.Rivera@example.com",
      url: "mailto:Sam.Rivera@example.com",
    });
  });

  it("takes a mailto: link as the address it names", () => {
    expect(normaliseEmail("mailto:sam@example.com")).toMatchObject({
      ok: true,
      value: "sam@example.com",
    });
  });

  it("refuses an address with no host, a double @, or a dotless host", () => {
    for (const raw of ["sam", "sam@", "@example.com", "sam@@example.com", "sam@localhost"]) {
      expect(normaliseEmail(raw), raw).toMatchObject({ ok: false });
    }
  });

  it("refuses an address longer than an address can be", () => {
    const result = normaliseEmail(`${"a".repeat(250)}@example.com`);
    expect(result).toMatchObject({ ok: false });
  });
});

describe("normalisePhone", () => {
  it("stores a number given with a country code in E.164", () => {
    expect(normalisePhone("+41 (79) 123-45-67")).toEqual({
      ok: true,
      value: "+41791234567",
      url: "tel:+41791234567",
    });
  });

  it("leaves a national number national rather than guessing the country", () => {
    expect(normalisePhone("079 123 45 67")).toMatchObject({
      ok: true,
      value: "0791234567",
    });
  });

  it("refuses letters, and a digit count no number has", () => {
    expect(normalisePhone("call me")).toMatchObject({ ok: false });
    expect(normalisePhone("12345")).toMatchObject({ ok: false });
    expect(normalisePhone("1234567890123456")).toMatchObject({ ok: false });
  });
});

describe("normaliseContactValue", () => {
  it("turns a typed handle into the handle and its profile URL", () => {
    expect(normaliseContactValue("SOCIAL", "instagram", "@Sam.Rivera")).toEqual({
      ok: true,
      value: "sam.rivera",
      url: "https://instagram.com/sam.rivera",
    });
  });

  it("derives the URL from the handle, not from what was pasted", () => {
    expect(
      normaliseContactValue("SOCIAL", "github", "https://github.com/sam?tab=repositories"),
    ).toEqual({
      ok: true,
      value: "sam",
      url: "https://github.com/sam",
    });
  });

  it("refuses a post URL rather than reading its last segment as a handle", () => {
    expect(
      normaliseContactValue("SOCIAL", "instagram", "https://instagram.com/p/Cxyz1234/"),
    ).toMatchObject({ ok: false });
  });

  it("keeps free text for a platform the registry does not know", () => {
    expect(normaliseContactValue("OTHER", "pigeon post", "third window, left")).toEqual({
      ok: true,
      value: "third window, left",
      url: null,
    });
  });

  it("validates an email and a phone by kind, whatever the platform says", () => {
    expect(normaliseContactValue("EMAIL", null, "sam@example.com")).toMatchObject({
      ok: true,
      url: "mailto:sam@example.com",
    });
    expect(normaliseContactValue("PHONE", null, "nope")).toMatchObject({ ok: false });
  });
});
