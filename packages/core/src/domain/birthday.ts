/**
 * Birthdays, with and without a year.
 *
 * A birthday is often known as a day and a month only. The column is a date,
 * so a birthday with no known year is stored in 1604, the year Apple Contacts
 * uses for the same purpose: it is a leap year, so the 29th of February fits,
 * and no living person was born in it. The vCard export writes it back out
 * with X-APPLE-OMIT-YEAR, which is how Contacts reads it as "no year".
 */

export const NO_YEAR = 1604;

/** True when the year on a stored birthday is a real one. */
export function hasYear(birthday: Date): boolean {
  return birthday.getUTCFullYear() !== NO_YEAR;
}

/**
 * The next time the day comes round, on or after today (UTC days). The 29th
 * of February falls on the 28th in a year without one.
 */
export function nextOccurrence(day: Date, now: Date): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const month = day.getUTCMonth();
  const date = day.getUTCDate();

  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const candidate = Date.UTC(year, month, month === 1 && date === 29 && !leap ? 28 : date);
    if (candidate >= today) return new Date(candidate);
  }
  // Unreachable: next year always qualifies.
  return new Date(today);
}

/** Whole days from today to a date, both as UTC days. */
export function daysUntil(date: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((date.getTime() - today) / 86_400_000);
}

/**
 * The age someone turns on a given occurrence, or null when the year is not
 * known or cannot be right (a year in the future of the occurrence).
 */
export function turning(birthday: Date, occurrence: Date): number | null {
  if (!hasYear(birthday)) return null;
  const age = occurrence.getUTCFullYear() - birthday.getUTCFullYear();
  return age > 0 && age < 130 ? age : null;
}
