import { describe, expect, it } from "vitest";

import {
  NO_YEAR,
  daysUntil,
  hasYear,
  nextOccurrence,
  turning,
} from "../../src/domain/birthday.js";

/**
 * Birthdays with and without a year. A day with no known year is stored in
 * 1604, and every calculation works in UTC days.
 */

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe("hasYear", () => {
  it("is false for the 1604 placeholder and true otherwise", () => {
    expect(NO_YEAR).toBe(1604);
    expect(hasYear(utc("1604-05-01"))).toBe(false);
    expect(hasYear(utc("1990-05-01"))).toBe(true);
    expect(hasYear(utc("1605-05-01"))).toBe(true);
  });
});

describe("nextOccurrence", () => {
  it("counts today as the next occurrence", () => {
    const now = new Date("2026-11-24T18:30:00.000Z");
    expect(nextOccurrence(utc("1990-11-24"), now).toISOString()).toBe(
      "2026-11-24T00:00:00.000Z",
    );
  });

  it("falls later this year when the day is still to come", () => {
    const now = new Date("2026-11-24T08:00:00.000Z");
    expect(nextOccurrence(utc("1990-12-02"), now).toISOString()).toBe(
      "2026-12-02T00:00:00.000Z",
    );
  });

  it("rolls a passed day to next year", () => {
    const now = new Date("2026-11-24T08:00:00.000Z");
    expect(nextOccurrence(utc("1990-11-23"), now).toISOString()).toBe(
      "2027-11-23T00:00:00.000Z",
    );
  });

  it("puts the 29th of February on the 28th in a year without one", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    expect(nextOccurrence(utc("1604-02-29"), now).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("keeps the 29th of February in a leap year", () => {
    const now = new Date("2028-01-10T00:00:00.000Z");
    expect(nextOccurrence(utc("1996-02-29"), now).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("rolls the 29th of February into next year once the 28th has passed", () => {
    // 2027 has no 29th, so the 28th stands in.
    const now = new Date("2026-03-01T00:00:00.000Z");
    expect(nextOccurrence(utc("1996-02-29"), now).toISOString()).toBe(
      "2027-02-28T00:00:00.000Z",
    );
  });

  it("crosses from the 31st of December to the 1st of January", () => {
    const now = new Date("2026-12-31T23:59:00.000Z");
    expect(nextOccurrence(utc("1990-01-01"), now).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(nextOccurrence(utc("1990-12-31"), now).toISOString()).toBe(
      "2026-12-31T00:00:00.000Z",
    );
  });
});

describe("daysUntil", () => {
  it("counts whole UTC days, ignoring the time of day", () => {
    const now = new Date("2026-11-24T23:00:00.000Z");
    expect(daysUntil(utc("2026-11-24"), now)).toBe(0);
    expect(daysUntil(utc("2026-11-25"), now)).toBe(1);
    expect(daysUntil(utc("2026-12-24"), now)).toBe(30);
  });

  it("crosses the year", () => {
    const now = new Date("2026-12-31T12:00:00.000Z");
    expect(daysUntil(utc("2027-01-01"), now)).toBe(1);
  });
});

describe("turning", () => {
  it("is the age on the occurrence", () => {
    expect(turning(utc("1990-03-14"), utc("2027-03-14"))).toBe(37);
  });

  it("is null when the year is not known", () => {
    expect(turning(utc("1604-03-14"), utc("2027-03-14"))).toBeNull();
  });

  it("is null for a birth year in the future or an absurd age", () => {
    expect(turning(utc("2030-03-14"), utc("2027-03-14"))).toBeNull();
    expect(turning(utc("2027-03-14"), utc("2027-03-14"))).toBeNull();
    expect(turning(utc("1800-03-14"), utc("2027-03-14"))).toBeNull();
    expect(turning(utc("1898-03-14"), utc("2027-03-14"))).toBe(129);
    expect(turning(utc("1897-03-14"), utc("2027-03-14"))).toBeNull();
  });
});
