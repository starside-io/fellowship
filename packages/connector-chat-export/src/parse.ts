/**
 * WhatsApp chat export parser.
 *
 * Pure and dependency free: the caller supplies the text of an exported
 * ".txt" file ("Export Chat" -> "Without Media") and gets back either a
 * parsed conversation or a failure describing what could not be understood.
 * Nothing here throws, reads the filesystem, or touches the database.
 *
 * Timestamps: an export carries no timezone, only the wall clock of the
 * phone that produced it. Every Date is built with Date.UTC so the wall
 * clock survives round trips and results do not depend on the machine
 * running the parser.
 */

export type LineStyle = "bracketed" | "dashed";

export type ClockStyle = "12-hour" | "24-hour";

export interface DetectedFormat {
  /** "[12/03/2024, 20:14:33] Name: text" versus "12/03/2024, 20:14 - Name: text". */
  style: LineStyle;
  dateSeparator: "/" | "." | "-";
  /** True for ISO like dates such as "2024-03-12", which carry no ambiguity. */
  yearFirst: boolean;
  twoDigitYear: boolean;
  clock: ClockStyle;
  hasSeconds: boolean;
  /** The first header line the detection was based on, for display. */
  sampleLine: string;
}

export type DateOrderSource =
  | "explicit"
  | "component-evidence"
  | "chronology"
  | "year-first"
  | "default";

export interface DateOrderEvidence {
  line: number;
  text: string;
}

export interface DateOrderDecision {
  /** True when the first date component is the day, as in 12/03/2024 = 12 March. */
  dayFirst: boolean;
  /** True when the file gave no evidence and the fallback was used. */
  ambiguous: boolean;
  source: DateOrderSource;
  /** Human readable explanation of the decision, safe to show in the UI. */
  reason: string;
  evidence: DateOrderEvidence | null;
}

export type SystemMessageKind =
  | "encryption"
  | "media"
  | "deleted"
  | "missed-call"
  | "joined"
  | "left"
  | "added"
  | "removed"
  | "group-created"
  | "group-subject"
  | "group-icon"
  | "group-description"
  | "admin"
  | "security-code"
  | "phone-number"
  | "disappearing-messages"
  | "blocked"
  | "notice";

export interface ParsedMessage {
  /** Position in file order, 0 based. */
  index: number;
  /** 1 based line number of the header line this message started on. */
  line: number;
  sentAt: Date;
  /** Null for notices that carry no sender, such as the encryption notice. */
  senderName: string | null;
  body: string;
  isSystem: boolean;
  systemKind: SystemMessageKind | null;
  isFromSelf: boolean;
}

export interface ParsedParticipant {
  senderName: string;
  /** Every line attributed to this sender, including media placeholders. */
  messageCount: number;
  /** The subset of messageCount that is a system or media placeholder line. */
  systemMessageCount: number;
  isSelf: boolean;
  firstMessageAt: Date;
  lastMessageAt: Date;
}

export type ParseWarningCode =
  | "orphan-lines"
  | "mixed-format-line"
  | "invalid-timestamp"
  | "self-name-not-found"
  | "explicit-order-contradicts-evidence"
  | "warnings-truncated";

export interface ParseWarning {
  code: ParseWarningCode;
  message: string;
  line: number | null;
}

export type ParseFailureCode =
  | "empty-input"
  | "no-timestamped-lines"
  | "no-valid-messages"
  | "date-order-conflict"
  | "unexpected-error";

export interface ParseFailure {
  code: ParseFailureCode;
  message: string;
  line: number | null;
  sample: string | null;
}

export interface ParsedConversation {
  messages: ParsedMessage[];
  participants: ParsedParticipant[];
  /** Set only when a selfName hint matched a sender. Never guessed. */
  ownerName: string | null;
  /** Sender names the caller can pick the owner from, most active first. */
  ownerCandidates: string[];
  isGroup: boolean;
  messageCount: number;
  humanMessageCount: number;
  systemMessageCount: number;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  /** Span of the non system messages only, useful for recency metrics. */
  firstHumanMessageAt: Date | null;
  lastHumanMessageAt: Date | null;
  format: DetectedFormat;
  dateOrder: DateOrderDecision;
}

export interface WhatsAppParseSuccess {
  ok: true;
  conversation: ParsedConversation;
  warnings: ParseWarning[];
}

export interface WhatsAppParseFailure {
  ok: false;
  error: ParseFailure;
  warnings: ParseWarning[];
}

export type WhatsAppParseResult = WhatsAppParseSuccess | WhatsAppParseFailure;

export interface WhatsAppParseOptions {
  /** Force the day/month order instead of inferring it. Always wins. */
  dayFirst?: boolean;
  /** Expected display name of the export owner, matched case insensitively. */
  selfName?: string;
  /** Order used when the file carries no evidence at all. Defaults to true. */
  defaultDayFirst?: boolean;
}

/**
 * Bidi and formatting marks iOS sprinkles into exports, plus the BOM. They
 * carry no meaning here and break naive regexes, so they are removed.
 */
const INVISIBLE_MARKS =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Narrow no-break space, no-break space and friends, folded to a plain space. */
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * One header line: an optional bracket, a three part date with a consistent
 * separator, a 24 or 12 hour time with optional seconds and meridiem, then
 * either the closing bracket or the Android " - " before the payload.
 */
const HEADER_RE =
  /^(\[)?\s*(\d{1,4})([./-])(\d{1,2})\3(\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([APap])\.?\s?[Mm]\.?)?\s*(\]|-)\s*([\s\S]*)$/;

const MAX_SENDER_LENGTH = 120;
const MAX_WARNINGS = 50;

const MEDIA_RE =
  /^(?:<\s*media omitted\s*>|<\s*attached:[^>]*>|(?:image|video|audio|sticker|document|gif|photo|contact card|voice message|live location)\s+omitted|.+\(file attached\))$/i;

const DELETED_RE =
  /^(?:this message was deleted(?: by (?:the )?admin)?\.?|you deleted this message\.?|message deleted\.?)$/i;

const MISSED_CALL_RE =
  /^(?:missed (?:voice|video|group voice|group video) call(?:,.*)?|null)$/i;

/**
 * Notices that arrive without a sender. Order matters: the first match wins,
 * so specific patterns come before the loose verb patterns.
 */
const NOTICE_PATTERNS: ReadonlyArray<{
  kind: SystemMessageKind;
  pattern: RegExp;
}> = [
  { kind: "encryption", pattern: /end-to-end encrypted/i },
  { kind: "media", pattern: MEDIA_RE },
  { kind: "deleted", pattern: DELETED_RE },
  { kind: "missed-call", pattern: MISSED_CALL_RE },
  { kind: "security-code", pattern: /security code (?:with .+ )?changed|\bsecurity code\b/i },
  { kind: "phone-number", pattern: /changed (?:their|to a new) phone number/i },
  { kind: "disappearing-messages", pattern: /disappearing messages/i },
  { kind: "group-subject", pattern: /changed the subject|changed the group name/i },
  { kind: "group-icon", pattern: /changed (?:this |the )?group(?:'s)? icon/i },
  {
    kind: "group-description",
    pattern: /changed the group description|deleted the group description/i,
  },
  { kind: "group-created", pattern: /created (?:this )?group|created group/i },
  { kind: "admin", pattern: /\b(?:an admin|group admin|no longer an admin)\b/i },
  { kind: "blocked", pattern: /\byou (?:blocked|unblocked)\b/i },
  { kind: "joined", pattern: /\bjoined\b/i },
  { kind: "added", pattern: /\b(?:added|were added)\b/i },
  { kind: "removed", pattern: /\bremoved\b/i },
  { kind: "left", pattern: /\bleft\b/i },
];

/** A sender candidate that reads like a notice is not a sender. */
const SENDER_REJECT_RE =
  /\b(?:added|removed|joined|left|created|changed|deleted|blocked|pinned|turned on|turned off|encrypted)\b/i;

interface RawRecord {
  line: number;
  /** Date components in the order they appear in the file. */
  first: number;
  second: number;
  third: number;
  yearFirst: boolean;
  hour: number;
  minute: number;
  secondOfMinute: number;
  meridiem: "am" | "pm" | null;
  senderName: string | null;
  bodyParts: string[];
  headerText: string;
}

function normaliseLine(line: string): string {
  return line.replace(INVISIBLE_MARKS, "").replace(ODD_SPACES, " ");
}

function expandYear(value: number): number {
  if (value >= 100) return value;
  return value < 70 ? 2000 + value : 1900 + value;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normaliseHour(hour: number, meridiem: "am" | "pm" | null): number | null {
  if (meridiem === null) return hour <= 23 ? hour : null;
  if (hour < 1 || hour > 12) return null;
  if (meridiem === "am") return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

/** Milliseconds for a record under a given day/month order, or null if invalid. */
function toTimestamp(record: RawRecord, dayFirst: boolean): number | null {
  let year: number;
  let month: number;
  let day: number;

  if (record.yearFirst) {
    year = expandYear(record.first);
    month = record.second;
    day = record.third;
  } else {
    year = expandYear(record.third);
    month = dayFirst ? record.second : record.first;
    day = dayFirst ? record.first : record.second;
  }

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  const hour = normaliseHour(record.hour, record.meridiem);
  if (hour === null) return null;
  if (record.minute > 59 || record.secondOfMinute > 59) return null;

  return Date.UTC(year, month - 1, day, hour, record.minute, record.secondOfMinute);
}

function classifyBody(
  senderName: string | null,
  body: string,
): { isSystem: boolean; kind: SystemMessageKind | null } {
  const trimmed = body.trim();

  if (senderName !== null) {
    // A line with a sender is a real message unless its whole body is a
    // placeholder the export left behind in place of the content.
    if (MEDIA_RE.test(trimmed)) return { isSystem: true, kind: "media" };
    if (DELETED_RE.test(trimmed)) return { isSystem: true, kind: "deleted" };
    if (MISSED_CALL_RE.test(trimmed)) return { isSystem: true, kind: "missed-call" };
    return { isSystem: false, kind: null };
  }

  for (const { kind, pattern } of NOTICE_PATTERNS) {
    if (pattern.test(trimmed)) return { isSystem: true, kind };
  }
  return { isSystem: true, kind: "notice" };
}

function splitSender(rest: string): { senderName: string | null; body: string } {
  const separatorIndex = rest.indexOf(": ");

  if (separatorIndex > 0 && separatorIndex <= MAX_SENDER_LENGTH) {
    const candidate = rest.slice(0, separatorIndex).trim();
    if (candidate.length > 0 && !SENDER_REJECT_RE.test(candidate)) {
      return { senderName: candidate, body: rest.slice(separatorIndex + 2) };
    }
    return { senderName: null, body: rest };
  }

  // "Name:" with nothing after it still names a sender.
  if (separatorIndex === -1 && rest.endsWith(":") && rest.length - 1 <= MAX_SENDER_LENGTH) {
    const candidate = rest.slice(0, -1).trim();
    if (candidate.length > 0 && !SENDER_REJECT_RE.test(candidate)) {
      return { senderName: candidate, body: "" };
    }
  }

  return { senderName: null, body: rest };
}

/**
 * Decides whether the first date component is the day.
 *
 * The order is a property of the whole file, never of a single line, so the
 * evidence is gathered across every record before a single Date is built:
 *
 *  1. An explicit dayFirst option always wins, and contradicting evidence is
 *     reported as a warning rather than silently overridden.
 *  2. ISO like dates (2024-03-12) carry a year first and no ambiguity at all.
 *  3. A first component above 12 can only be a day, a second component above
 *     12 can only be a day as well. Either settles the file. Both appearing
 *     in one file is a contradiction the parser refuses to resolve.
 *  4. Failing that, exports are chronological, so if exactly one of the two
 *     orders keeps the file in non decreasing order it is the right one.
 *  5. Otherwise the file is genuinely ambiguous. A fallback is used, the
 *     result says so, and the caller can re-parse with an explicit order.
 */
function resolveDateOrder(
  records: RawRecord[],
  options: WhatsAppParseOptions,
  pushWarning: (warning: ParseWarning) => void,
): { decision: DateOrderDecision } | { conflict: ParseFailure } {
  const ambiguousRecords = records.filter((record) => !record.yearFirst);

  let dayEvidence: RawRecord | null = null;
  let monthEvidence: RawRecord | null = null;

  for (const record of ambiguousRecords) {
    if (dayEvidence === null && record.first > 12 && record.first <= 31) {
      dayEvidence = record;
    }
    if (monthEvidence === null && record.second > 12 && record.second <= 31) {
      monthEvidence = record;
    }
    if (dayEvidence !== null && monthEvidence !== null) break;
  }

  if (options.dayFirst !== undefined) {
    const contradiction = options.dayFirst ? monthEvidence : dayEvidence;
    if (contradiction !== null) {
      pushWarning({
        code: "explicit-order-contradicts-evidence",
        message: `The file says otherwise on line ${contradiction.line} ("${contradiction.headerText}") but the explicit dayFirst=${options.dayFirst} option was honoured.`,
        line: contradiction.line,
      });
    }
    return {
      decision: {
        dayFirst: options.dayFirst,
        ambiguous: false,
        source: "explicit",
        reason: `The caller supplied dayFirst=${options.dayFirst}, so no inference was needed.`,
        evidence: null,
      },
    };
  }

  if (ambiguousRecords.length === 0) {
    return {
      decision: {
        dayFirst: false,
        ambiguous: false,
        source: "year-first",
        reason:
          "Every date is written year first (such as 2024-03-12), which leaves no day/month ambiguity.",
        evidence: null,
      },
    };
  }

  if (dayEvidence !== null && monthEvidence !== null) {
    return {
      conflict: {
        code: "date-order-conflict",
        message: `Line ${dayEvidence.line} ("${dayEvidence.headerText}") can only be day first while line ${monthEvidence.line} ("${monthEvidence.headerText}") can only be month first. Re-parse with an explicit dayFirst option.`,
        line: monthEvidence.line,
        sample: monthEvidence.headerText,
      },
    };
  }

  if (dayEvidence !== null) {
    return {
      decision: {
        dayFirst: true,
        ambiguous: false,
        source: "component-evidence",
        reason: `Line ${dayEvidence.line} ("${dayEvidence.headerText}") starts with ${dayEvidence.first}, which is above 12 and can only be a day, so the whole file is day first.`,
        evidence: { line: dayEvidence.line, text: dayEvidence.headerText },
      },
    };
  }

  if (monthEvidence !== null) {
    return {
      decision: {
        dayFirst: false,
        ambiguous: false,
        source: "component-evidence",
        reason: `Line ${monthEvidence.line} ("${monthEvidence.headerText}") has ${monthEvidence.second} as its second component, which is above 12 and can only be a day, so the whole file is month first.`,
        evidence: { line: monthEvidence.line, text: monthEvidence.headerText },
      },
    };
  }

  const chronology = checkChronology(ambiguousRecords);
  if (chronology !== null) {
    return {
      decision: {
        dayFirst: chronology.dayFirst,
        ambiguous: false,
        source: "chronology",
        reason: `Every date is ambiguous on its own, but only ${
          chronology.dayFirst ? "day first" : "month first"
        } keeps the export in chronological order (line ${chronology.brokenBy.line}, "${
          chronology.brokenBy.headerText
        }", would go backwards otherwise).`,
        evidence: { line: chronology.brokenBy.line, text: chronology.brokenBy.headerText },
      },
    };
  }

  const fallback = options.defaultDayFirst ?? true;
  return {
    decision: {
      dayFirst: fallback,
      ambiguous: true,
      source: "default",
      reason: `No date in this file has a component above 12 and both orders stay chronological, so the day/month order cannot be proven. Fell back to ${
        fallback ? "day first" : "month first"
      }. Re-parse with an explicit dayFirst option to settle it.`,
      evidence: null,
    },
  };
}

/**
 * Exports are written in chronological order, so an ordering that makes the
 * file jump backwards in time is wrong. Returns a decision only when exactly
 * one of the two orders survives.
 */
function checkChronology(
  records: RawRecord[],
): { dayFirst: boolean; brokenBy: RawRecord } | null {
  let dayFirstOk = true;
  let monthFirstOk = true;
  let dayFirstBrokenBy: RawRecord | null = null;
  let monthFirstBrokenBy: RawRecord | null = null;
  let previousDayFirst = Number.NEGATIVE_INFINITY;
  let previousMonthFirst = Number.NEGATIVE_INFINITY;
  let distinctDays = 0;
  let lastDayKey = "";

  for (const record of records) {
    const dayKey = `${record.first}-${record.second}-${record.third}`;
    if (dayKey !== lastDayKey) {
      distinctDays += 1;
      lastDayKey = dayKey;
    }

    const asDayFirst = toTimestamp(record, true);
    const asMonthFirst = toTimestamp(record, false);

    if (asDayFirst === null || asDayFirst < previousDayFirst) {
      if (dayFirstOk) dayFirstBrokenBy = record;
      dayFirstOk = false;
    } else {
      previousDayFirst = asDayFirst;
    }

    if (asMonthFirst === null || asMonthFirst < previousMonthFirst) {
      if (monthFirstOk) monthFirstBrokenBy = record;
      monthFirstOk = false;
    } else {
      previousMonthFirst = asMonthFirst;
    }
  }

  if (distinctDays < 2) return null;
  if (dayFirstOk && !monthFirstOk && monthFirstBrokenBy !== null) {
    return { dayFirst: true, brokenBy: monthFirstBrokenBy };
  }
  if (monthFirstOk && !dayFirstOk && dayFirstBrokenBy !== null) {
    return { dayFirst: false, brokenBy: dayFirstBrokenBy };
  }
  return null;
}

/**
 * Parses the text of a WhatsApp chat export.
 *
 * Never throws. Malformed input comes back as `{ ok: false, error }`.
 */
export function parseWhatsAppExport(
  text: string,
  options: WhatsAppParseOptions = {},
): WhatsAppParseResult {
  const warnings: ParseWarning[] = [];
  let warningCount = 0;

  const pushWarning = (warning: ParseWarning): void => {
    warningCount += 1;
    if (warningCount <= MAX_WARNINGS) warnings.push(warning);
  };

  const finishWarnings = (): ParseWarning[] => {
    if (warningCount > MAX_WARNINGS) {
      warnings.push({
        code: "warnings-truncated",
        message: `${warningCount - MAX_WARNINGS} further warnings were dropped.`,
        line: null,
      });
    }
    return warnings;
  };

  try {
    if (typeof text !== "string" || text.replace(INVISIBLE_MARKS, "").trim() === "") {
      return {
        ok: false,
        error: {
          code: "empty-input",
          message: "The file has no content.",
          line: null,
          sample: null,
        },
        warnings: finishWarnings(),
      };
    }

    const lines = text.split(/\r\n|\r|\n/);
    const records: RawRecord[] = [];

    let format: DetectedFormat | null = null;
    let lockedStyle: LineStyle | null = null;
    let lockedSeparator: string | null = null;
    let current: RawRecord | null = null;
    let orphanLines = 0;
    let firstOrphanLine: number | null = null;
    let firstNonEmpty: { line: number; text: string } | null = null;

    // Single pass: every line either opens a record or extends the previous
    // one. Bodies are collected as parts and joined once, never concatenated
    // repeatedly, so a 100k line export stays linear.
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = normaliseLine(lines[index] ?? "");

      if (firstNonEmpty === null && line.trim() !== "") {
        firstNonEmpty = { line: lineNumber, text: line.slice(0, 160) };
      }

      const match = HEADER_RE.exec(line);
      if (match === null) {
        if (current === null) {
          if (line.trim() !== "") {
            orphanLines += 1;
            if (firstOrphanLine === null) firstOrphanLine = lineNumber;
          }
        } else {
          current.bodyParts.push(line);
        }
        continue;
      }

      const bracketed = match[1] !== undefined;
      const closer = match[10];
      const separator = match[3] as "/" | "." | "-";

      // The opener and closer have to agree, otherwise this is body text that
      // merely starts with something date shaped.
      if ((bracketed && closer !== "]") || (!bracketed && closer !== "-")) {
        if (current === null) {
          orphanLines += 1;
          if (firstOrphanLine === null) firstOrphanLine = lineNumber;
        } else {
          current.bodyParts.push(line);
        }
        continue;
      }

      const style: LineStyle = bracketed ? "bracketed" : "dashed";

      // Once the file's shape is known, a line in a different shape is body
      // text rather than a new message.
      if (lockedStyle !== null && (style !== lockedStyle || separator !== lockedSeparator)) {
        pushWarning({
          code: "mixed-format-line",
          message: `Line ${lineNumber} looks like a timestamp in a different format than the rest of the file and was kept as message text.`,
          line: lineNumber,
        });
        if (current === null) {
          orphanLines += 1;
          if (firstOrphanLine === null) firstOrphanLine = lineNumber;
        } else {
          current.bodyParts.push(line);
        }
        continue;
      }

      const first = Number(match[2]);
      const secondComponent = Number(match[4]);
      const third = Number(match[5]);
      const yearFirst = (match[2] ?? "").length === 4;
      const meridiemLetter = match[9];
      const meridiem =
        meridiemLetter === undefined
          ? null
          : meridiemLetter.toLowerCase() === "a"
            ? ("am" as const)
            : ("pm" as const);
      const rest = match[11] ?? "";
      const { senderName, body } = splitSender(rest);

      const record: RawRecord = {
        line: lineNumber,
        first,
        second: secondComponent,
        third,
        yearFirst,
        hour: Number(match[6]),
        minute: Number(match[7]),
        secondOfMinute: match[8] === undefined ? 0 : Number(match[8]),
        meridiem,
        senderName,
        bodyParts: [body],
        headerText: line.slice(0, 80),
      };

      if (format === null) {
        lockedStyle = style;
        lockedSeparator = separator;
        format = {
          style,
          dateSeparator: separator,
          yearFirst,
          twoDigitYear: yearFirst ? false : (match[5] ?? "").length === 2,
          clock: meridiem === null ? "24-hour" : "12-hour",
          hasSeconds: match[8] !== undefined,
          sampleLine: line.slice(0, 160),
        };
      }

      records.push(record);
      current = record;
    }

    if (format === null || records.length === 0) {
      return {
        ok: false,
        error: {
          code: "no-timestamped-lines",
          message:
            "No line in this file starts with a timestamp WhatsApp would produce, so it does not look like a chat export.",
          line: firstNonEmpty?.line ?? null,
          sample: firstNonEmpty?.text ?? null,
        },
        warnings: finishWarnings(),
      };
    }

    if (orphanLines > 0) {
      pushWarning({
        code: "orphan-lines",
        message: `${orphanLines} line(s) before the first timestamped message were ignored.`,
        line: firstOrphanLine,
      });
    }

    const resolved = resolveDateOrder(records, options, pushWarning);
    if ("conflict" in resolved) {
      return { ok: false, error: resolved.conflict, warnings: finishWarnings() };
    }
    const dateOrder = resolved.decision;

    const messages: ParsedMessage[] = [];
    for (const record of records) {
      const timestamp = toTimestamp(record, dateOrder.dayFirst);
      if (timestamp === null) {
        pushWarning({
          code: "invalid-timestamp",
          message: `Line ${record.line} ("${record.headerText}") has a timestamp that is not a real date and was skipped.`,
          line: record.line,
        });
        continue;
      }

      const body = record.bodyParts.length === 1
        ? (record.bodyParts[0] ?? "")
        : record.bodyParts.join("\n");
      const { isSystem, kind } = classifyBody(record.senderName, body);

      messages.push({
        index: messages.length,
        line: record.line,
        sentAt: new Date(timestamp),
        senderName: record.senderName,
        body,
        isSystem,
        systemKind: kind,
        isFromSelf: false,
      });
    }

    if (messages.length === 0) {
      return {
        ok: false,
        error: {
          code: "no-valid-messages",
          message:
            "Every timestamped line in this file had a date that does not exist, so nothing could be parsed.",
          line: records[0]?.line ?? null,
          sample: records[0]?.headerText ?? null,
        },
        warnings: finishWarnings(),
      };
    }

    interface Tally {
      senderName: string;
      messageCount: number;
      systemMessageCount: number;
      first: number;
      last: number;
    }
    const tallies = new Map<string, Tally>();

    let firstMessageAt = Number.POSITIVE_INFINITY;
    let lastMessageAt = Number.NEGATIVE_INFINITY;
    let firstHumanAt = Number.POSITIVE_INFINITY;
    let lastHumanAt = Number.NEGATIVE_INFINITY;
    let systemMessageCount = 0;

    for (const message of messages) {
      const at = message.sentAt.getTime();
      if (at < firstMessageAt) firstMessageAt = at;
      if (at > lastMessageAt) lastMessageAt = at;

      if (message.isSystem) {
        systemMessageCount += 1;
      } else {
        if (at < firstHumanAt) firstHumanAt = at;
        if (at > lastHumanAt) lastHumanAt = at;
      }

      if (message.senderName === null) continue;
      const tally = tallies.get(message.senderName);
      if (tally === undefined) {
        tallies.set(message.senderName, {
          senderName: message.senderName,
          messageCount: 1,
          systemMessageCount: message.isSystem ? 1 : 0,
          first: at,
          last: at,
        });
      } else {
        tally.messageCount += 1;
        if (message.isSystem) tally.systemMessageCount += 1;
        if (at < tally.first) tally.first = at;
        if (at > tally.last) tally.last = at;
      }
    }

    const ordered = [...tallies.values()].sort(
      (a, b) => b.messageCount - a.messageCount || a.senderName.localeCompare(b.senderName),
    );

    // The owner cannot be read out of the text, so it is only set when the
    // caller's hint matches a real sender. Otherwise the candidates go back.
    let ownerName: string | null = null;
    const hint = options.selfName?.trim();
    if (hint !== undefined && hint !== "") {
      const matched = ordered.find(
        (tally) => tally.senderName.toLowerCase() === hint.toLowerCase(),
      );
      if (matched === undefined) {
        pushWarning({
          code: "self-name-not-found",
          message: `No sender in this export is named "${hint}", so the owner was left undecided.`,
          line: null,
        });
      } else {
        ownerName = matched.senderName;
      }
    }

    const participants: ParsedParticipant[] = ordered.map((tally) => ({
      senderName: tally.senderName,
      messageCount: tally.messageCount,
      systemMessageCount: tally.systemMessageCount,
      isSelf: tally.senderName === ownerName,
      firstMessageAt: new Date(tally.first),
      lastMessageAt: new Date(tally.last),
    }));

    if (ownerName !== null) {
      for (const message of messages) {
        message.isFromSelf = message.senderName === ownerName;
      }
    }

    const conversation: ParsedConversation = {
      messages,
      participants,
      ownerName,
      ownerCandidates: participants.map((participant) => participant.senderName),
      isGroup: participants.length >= 3,
      messageCount: messages.length,
      humanMessageCount: messages.length - systemMessageCount,
      systemMessageCount,
      firstMessageAt: new Date(firstMessageAt),
      lastMessageAt: new Date(lastMessageAt),
      firstHumanMessageAt: firstHumanAt === Number.POSITIVE_INFINITY ? null : new Date(firstHumanAt),
      lastHumanMessageAt: lastHumanAt === Number.NEGATIVE_INFINITY ? null : new Date(lastHumanAt),
      format,
      dateOrder,
    };

    return { ok: true, conversation, warnings: finishWarnings() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "unexpected-error",
        message: error instanceof Error ? error.message : "Unknown parser failure.",
        line: null,
        sample: null,
      },
      warnings: finishWarnings(),
    };
  }
}
