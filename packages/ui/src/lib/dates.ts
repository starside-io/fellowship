/**
 * Dates as the host stores them: a date only column read back as an ISO
 * instant at midnight UTC. Formatted in UTC, so a birthday does not move a day
 * for anyone west of Greenwich.
 */

/** The year a birthday with no known year is stored in. Mirrors core. */
export const NO_YEAR = 1604;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const MONTH_NAMES = MONTHS;

/** "12 September 1994", or "12 September" when the year is not known. */
export function formatDay(iso: string, options: { short?: boolean } = {}): string {
  const date = new Date(iso);
  const month = MONTHS[date.getUTCMonth()] ?? "";
  const monthText = options.short ? month.slice(0, 3) : month;
  const year = date.getUTCFullYear();
  return year === NO_YEAR
    ? `${date.getUTCDate()} ${monthText}`
    : `${date.getUTCDate()} ${monthText} ${year}`;
}

/** The parts a birthday form edits. Empty strings for what is not set. */
export function dayParts(iso: string | null | undefined): {
  day: string;
  month: string;
  year: string;
} {
  if (!iso) return { day: "", month: "", year: "" };
  const date = new Date(iso);
  const year = date.getUTCFullYear();
  return {
    day: String(date.getUTCDate()),
    month: String(date.getUTCMonth() + 1),
    year: year === NO_YEAR ? "" : String(year),
  };
}

/**
 * Back to YYYY-MM-DD, null when nothing is set, or an error string when the
 * parts do not make a day that exists.
 */
export function partsToDay(parts: { day: string; month: string; year: string }):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  const { day, month, year } = parts;
  if (!day && !month && !year.trim()) return { ok: true, value: null };
  if (!day || !month) return { ok: false, error: "Pick both a day and a month." };

  const y = year.trim() ? Number(year.trim()) : NO_YEAR;
  if (!Number.isInteger(y) || (y !== NO_YEAR && (y < 1900 || y > new Date().getUTCFullYear()))) {
    return { ok: false, error: "The year is a four digit year in the past, or blank." };
  }
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) {
    return { ok: false, error: `${MONTHS[m - 1]} has no day ${d}.` };
  }
  return { ok: true, value: date.toISOString().slice(0, 10) };
}
