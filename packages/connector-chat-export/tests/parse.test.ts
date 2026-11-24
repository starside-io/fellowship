import { describe, expect, it } from "vitest";
import {
  parseWhatsAppExport,
  type WhatsAppParseOptions,
  type WhatsAppParseSuccess,
} from "../src/parse.js";

const NNBSP = " "; // narrow no-break space, iOS puts this before AM/PM
const NBSP = " ";
const LRM = "‎"; // left-to-right mark, iOS sprinkles these around
const BOM = "﻿";

function parseOk(text: string, options?: WhatsAppParseOptions): WhatsAppParseSuccess {
  const result = parseWhatsAppExport(text, options);
  if (!result.ok) {
    throw new Error(`expected a parse success, got ${result.error.code}: ${result.error.message}`);
  }
  return result;
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

// The four shapes real exports come in.
const IOS_BRACKETS = [
  "[12/03/2024, 20:14:33] John: hey",
  "[12/03/2024, 20:15:02] Yuki: hey yourself",
  "[13/03/2024, 09:01:00] John: morning",
].join("\n");

const ANDROID_DASH = [
  "12/03/2024, 20:14 - John: hey",
  "12/03/2024, 20:15 - Yuki: hey yourself",
  "13/03/2024, 09:01 - John: morning",
].join("\n");

const ISO_TWELVE_HOUR = [
  "[2024-03-12, 8:14:33 PM] John: hey",
  "[2024-03-12, 8:15:02 PM] Yuki: hey yourself",
  "[2024-03-13, 9:01:00 AM] John: morning",
].join("\n");

const DOTS_TWO_DIGIT_YEAR = [
  "12.03.24, 20:14 - John: hey",
  "13.03.24, 09:01 - Yuki: morning",
].join("\n");

describe("line formats", () => {
  it("parses the iOS bracketed format with seconds", () => {
    const { conversation } = parseOk(IOS_BRACKETS);

    expect(conversation.messages).toHaveLength(3);
    expect(conversation.format.style).toBe("bracketed");
    expect(conversation.format.dateSeparator).toBe("/");
    expect(conversation.format.hasSeconds).toBe(true);
    expect(conversation.format.clock).toBe("24-hour");
    expect(conversation.messages[0]?.senderName).toBe("John");
    expect(conversation.messages[0]?.body).toBe("hey");
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-12T20:14:33.000Z");
  });

  it("parses the Android dashed format without seconds", () => {
    const { conversation } = parseOk(ANDROID_DASH);

    expect(conversation.messages).toHaveLength(3);
    expect(conversation.format.style).toBe("dashed");
    expect(conversation.format.hasSeconds).toBe(false);
    expect(conversation.messages[1]?.senderName).toBe("Yuki");
    expect(conversation.messages[1]?.body).toBe("hey yourself");
    expect(iso(conversation.messages[1]?.sentAt ?? null)).toBe("2024-03-12T20:15:00.000Z");
  });

  it("parses ISO like dates with a 12 hour clock", () => {
    const { conversation } = parseOk(ISO_TWELVE_HOUR);

    expect(conversation.format.yearFirst).toBe(true);
    expect(conversation.format.dateSeparator).toBe("-");
    expect(conversation.format.clock).toBe("12-hour");
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-12T20:14:33.000Z");
    expect(iso(conversation.messages[2]?.sentAt ?? null)).toBe("2024-03-13T09:01:00.000Z");
  });

  it("parses dotted dates with a two digit year", () => {
    const { conversation } = parseOk(DOTS_TWO_DIGIT_YEAR);

    expect(conversation.format.dateSeparator).toBe(".");
    expect(conversation.format.twoDigitYear).toBe(true);
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-12T20:14:00.000Z");
    expect(iso(conversation.messages[1]?.sentAt ?? null)).toBe("2024-03-13T09:01:00.000Z");
  });

  it("converts 12 AM and 12 PM correctly", () => {
    const { conversation } = parseOk(
      [
        "[2024-03-12, 12:00:00 AM] John: midnight",
        "[2024-03-12, 12:30:00 PM] John: noon",
        "[2024-03-12, 11:59:00 PM] John: almost tomorrow",
      ].join("\n"),
    );

    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-12T00:00:00.000Z");
    expect(iso(conversation.messages[1]?.sentAt ?? null)).toBe("2024-03-12T12:30:00.000Z");
    expect(iso(conversation.messages[2]?.sentAt ?? null)).toBe("2024-03-12T23:59:00.000Z");
  });

  it("survives a narrow no-break space before AM/PM", () => {
    const { conversation } = parseOk(
      [
        `[2024-03-12, 8:14:33${NNBSP}PM] John: narrow space`,
        `[2024-03-12, 9:15:02${NBSP}PM] Yuki: non breaking space`,
      ].join("\n"),
    );

    expect(conversation.messages).toHaveLength(2);
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-12T20:14:33.000Z");
    expect(iso(conversation.messages[1]?.sentAt ?? null)).toBe("2024-03-12T21:15:02.000Z");
  });

  it("survives a leading UTF-8 BOM", () => {
    const { conversation } = parseOk(`${BOM}${IOS_BRACKETS}`);

    expect(conversation.messages).toHaveLength(3);
    expect(conversation.messages[0]?.senderName).toBe("John");
  });

  it("survives left-to-right marks anywhere in the line", () => {
    const { conversation } = parseOk(
      [
        `${LRM}[12/03/2024, 20:14:33]${LRM} John: hey${LRM}`,
        `[12/03/2024, 20:15:02] ${LRM}Yuki: ${LRM}hey yourself`,
      ].join("\n"),
    );

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]?.senderName).toBe("John");
    expect(conversation.messages[0]?.body).toBe("hey");
    expect(conversation.messages[1]?.senderName).toBe("Yuki");
    expect(conversation.messages[1]?.body).toBe("hey yourself");
  });

  it("handles CRLF line endings", () => {
    const { conversation } = parseOk(IOS_BRACKETS.split("\n").join("\r\n"));

    expect(conversation.messages).toHaveLength(3);
    expect(conversation.messages[0]?.body).toBe("hey");
  });

  it("reports the sample line the format was detected from", () => {
    const { conversation } = parseOk(ANDROID_DASH);

    expect(conversation.format.sampleLine).toBe("12/03/2024, 20:14 - John: hey");
  });
});

describe("date order resolution", () => {
  it("settles the whole file when a first component is above 12", () => {
    const { conversation } = parseOk(
      [
        "[03/04/2024, 20:14:33] John: ambiguous on its own",
        "[25/04/2024, 20:15:02] Yuki: 25 can only be a day",
      ].join("\n"),
    );

    expect(conversation.dateOrder.dayFirst).toBe(true);
    expect(conversation.dateOrder.ambiguous).toBe(false);
    expect(conversation.dateOrder.source).toBe("component-evidence");
    expect(conversation.dateOrder.evidence?.line).toBe(2);
    expect(conversation.dateOrder.reason).toContain("day first");
    // The ambiguous line is read with the order the whole file settled on.
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-04-03T20:14:33.000Z");
  });

  it("settles the whole file when a second component is above 12", () => {
    const { conversation } = parseOk(
      [
        "[03/04/2024, 20:14:33] John: ambiguous on its own",
        "[04/25/2024, 20:15:02] Yuki: 25 can only be a day",
      ].join("\n"),
    );

    expect(conversation.dateOrder.dayFirst).toBe(false);
    expect(conversation.dateOrder.ambiguous).toBe(false);
    expect(conversation.dateOrder.source).toBe("component-evidence");
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-04T20:14:33.000Z");
  });

  it("reports the ambiguity instead of guessing silently when no date settles it", () => {
    const { conversation } = parseOk(
      [
        "[03/04/2024, 20:14:33] John: hey",
        "[05/04/2024, 20:15:02] Yuki: hey yourself",
      ].join("\n"),
    );

    expect(conversation.dateOrder.ambiguous).toBe(true);
    expect(conversation.dateOrder.source).toBe("default");
    expect(conversation.dateOrder.dayFirst).toBe(true);
    expect(conversation.dateOrder.reason).toContain("cannot be proven");
    expect(conversation.dateOrder.evidence).toBeNull();
  });

  it("lets the caller pick the fallback order for an ambiguous file", () => {
    const text = [
      "[03/04/2024, 20:14:33] John: hey",
      "[05/04/2024, 20:15:02] Yuki: hey yourself",
    ].join("\n");

    const { conversation } = parseOk(text, { defaultDayFirst: false });

    expect(conversation.dateOrder.ambiguous).toBe(true);
    expect(conversation.dateOrder.dayFirst).toBe(false);
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-04T20:14:33.000Z");
  });

  it("takes an explicit dayFirst option over inference", () => {
    const text = [
      "[03/04/2024, 20:14:33] John: hey",
      "[05/04/2024, 20:15:02] Yuki: hey yourself",
    ].join("\n");

    const { conversation, warnings } = parseOk(text, { dayFirst: false });

    expect(conversation.dateOrder.source).toBe("explicit");
    expect(conversation.dateOrder.ambiguous).toBe(false);
    expect(conversation.dateOrder.dayFirst).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("warns when an explicit order contradicts the file's own evidence", () => {
    const { conversation, warnings } = parseOk(
      [
        "[25/04/2024, 20:14:33] John: 25 can only be a day",
        "[04/03/2024, 20:15:02] Yuki: readable either way",
      ].join("\n"),
      { dayFirst: false },
    );

    expect(conversation.dateOrder.dayFirst).toBe(false);
    expect(conversation.dateOrder.source).toBe("explicit");
    expect(warnings.map((warning) => warning.code)).toContain(
      "explicit-order-contradicts-evidence",
    );
    // 25 as a month is not a real date, so those lines are dropped honestly.
    expect(warnings.some((warning) => warning.code === "invalid-timestamp")).toBe(true);
  });

  it("fails rather than guessing when the file contradicts itself", () => {
    const result = parseWhatsAppExport(
      [
        "[25/04/2024, 20:14:33] John: only a day first file has 25 here",
        "[04/25/2024, 20:15:02] Yuki: only a month first file has 25 here",
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("date-order-conflict");
    expect(result.error.message).toContain("explicit dayFirst");
    expect(result.error.line).toBe(2);
  });

  it("still parses a self contradicting file when the caller settles the order", () => {
    const { conversation } = parseOk(
      [
        "[25/04/2024, 20:14:33] John: day first line",
        "[04/25/2024, 20:15:02] Yuki: month first line",
      ].join("\n"),
      { dayFirst: true },
    );

    expect(conversation.dateOrder.source).toBe("explicit");
    expect(conversation.messages).toHaveLength(1);
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-04-25T20:14:33.000Z");
  });

  it("treats year first dates as unambiguous", () => {
    const { conversation } = parseOk(ISO_TWELVE_HOUR);

    expect(conversation.dateOrder.source).toBe("year-first");
    expect(conversation.dateOrder.ambiguous).toBe(false);
    expect(conversation.dateOrder.reason).toContain("year first");
  });

  it("falls back to chronology when every component is 12 or below", () => {
    const { conversation } = parseOk(
      [
        "[05/03/2024, 20:14:33] John: first",
        "[04/04/2024, 20:15:02] Yuki: later",
      ].join("\n"),
    );

    // Month first would read these as 3 May then 4 April, which goes backwards.
    expect(conversation.dateOrder.source).toBe("chronology");
    expect(conversation.dateOrder.dayFirst).toBe(true);
    expect(conversation.dateOrder.ambiguous).toBe(false);
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-05T20:14:33.000Z");
  });

  it("uses chronology to pick month first as well", () => {
    const { conversation } = parseOk(
      [
        "[03/05/2024, 20:14:33] John: first",
        "[04/04/2024, 20:15:02] Yuki: later",
      ].join("\n"),
    );

    expect(conversation.dateOrder.source).toBe("chronology");
    expect(conversation.dateOrder.dayFirst).toBe(false);
    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-05T20:14:33.000Z");
  });

  it("does not invoke chronology when the export covers a single day", () => {
    const { conversation } = parseOk(
      [
        "[03/04/2024, 20:14:33] John: one",
        "[03/04/2024, 20:15:02] Yuki: two",
      ].join("\n"),
    );

    expect(conversation.dateOrder.source).toBe("default");
    expect(conversation.dateOrder.ambiguous).toBe(true);
  });

  it("expands two digit years around the year 2000", () => {
    const { conversation } = parseOk(
      [
        "12.03.24, 20:14 - John: this century",
        "13.03.99, 20:14 - John: last century",
      ].join("\n"),
      { dayFirst: true },
    );

    expect(iso(conversation.messages[0]?.sentAt ?? null)).toBe("2024-03-12T20:14:00.000Z");
    expect(iso(conversation.messages[1]?.sentAt ?? null)).toBe("1999-03-13T20:14:00.000Z");
  });

  it("skips impossible dates with a warning instead of inventing one", () => {
    const { conversation, warnings } = parseOk(
      [
        "[31/02/2024, 20:14:33] John: no such day",
        "[13/03/2024, 20:15:02] Yuki: real",
      ].join("\n"),
    );

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.body).toBe("real");
    const invalid = warnings.find((warning) => warning.code === "invalid-timestamp");
    expect(invalid?.line).toBe(1);
  });
});

describe("multi line messages", () => {
  it("keeps continuation lines and their newlines", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:14:33] John: first line",
        "second line",
        "third line",
        "[12/03/2024, 20:15:02] Yuki: single",
      ].join("\n"),
    );

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]?.body).toBe("first line\nsecond line\nthird line");
    expect(conversation.messages[1]?.body).toBe("single");
  });

  it("preserves blank lines inside a message", () => {
    const { conversation } = parseOk(
      ["12/03/2024, 20:14 - John: a", "", "b"].join("\n"),
    );

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.body).toBe("a\n\nb");
  });

  it("keeps a body that merely contains something timestamp shaped", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:14:33] John: you wrote [11/03/2024, 09:00:00] Yuki: hi, remember?",
        "[12/03/2024, 20:15:02] Yuki: I do",
      ].join("\n"),
    );

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]?.body).toBe(
      "you wrote [11/03/2024, 09:00:00] Yuki: hi, remember?",
    );
    expect(conversation.messages[0]?.senderName).toBe("John");
  });

  it("keeps a continuation line written in a different timestamp format", () => {
    const { conversation, warnings } = parseOk(
      [
        "[12/03/2024, 20:14:33] John: pasted from another export:",
        "12/03/2024, 20:14 - Someone: hey",
        "[12/03/2024, 20:15:02] Yuki: weird flex",
      ].join("\n"),
    );

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]?.body).toBe(
      "pasted from another export:\n12/03/2024, 20:14 - Someone: hey",
    );
    expect(warnings.map((warning) => warning.code)).toContain("mixed-format-line");
  });

  it("ignores junk before the first timestamped line but says so", () => {
    const { conversation, warnings } = parseOk(
      ["some header nonsense", "[12/03/2024, 20:14:33] John: hey"].join("\n"),
    );

    expect(conversation.messages).toHaveLength(1);
    const orphan = warnings.find((warning) => warning.code === "orphan-lines");
    expect(orphan?.line).toBe(1);
  });

  it("does not build the body with quadratic concatenation", () => {
    const lines = ["[12/03/2024, 20:14:33] John: start"];
    for (let index = 0; index < 5000; index += 1) lines.push(`line ${index}`);

    const { conversation } = parseOk(lines.join("\n"));

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.body.split("\n")).toHaveLength(5001);
  });
});

describe("system messages", () => {
  const SYSTEM_EXPORT = [
    "[12/03/2024, 20:00:00] Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.",
    "[12/03/2024, 20:01:00] John created group \"Ramen club\"",
    "[12/03/2024, 20:02:00] Yuki joined using this group's invite link",
    "[12/03/2024, 20:03:00] John added Kwame",
    "[12/03/2024, 20:04:00] Kwame left",
    "[12/03/2024, 20:05:00] John removed Yuki",
    "[12/03/2024, 20:06:00] John changed the subject from \"Ramen club\" to \"Noodle club\"",
    "[12/03/2024, 20:07:00] John changed this group's icon",
    "[12/03/2024, 20:08:00] Yuki changed the group description",
    "[12/03/2024, 20:09:00] Your security code with Yuki changed. Tap to learn more.",
    "[12/03/2024, 20:10:00] Yuki changed their phone number to a new number.",
    "[12/03/2024, 20:11:00] John turned on disappearing messages.",
    "[12/03/2024, 20:12:00] Missed voice call",
  ].join("\n");

  it("classifies sender-less notices without dropping them", () => {
    const { conversation } = parseOk(SYSTEM_EXPORT);

    expect(conversation.messages).toHaveLength(13);
    expect(conversation.messages.every((message) => message.isSystem)).toBe(true);
    expect(conversation.messages.every((message) => message.senderName === null)).toBe(true);
    expect(conversation.messages.map((message) => message.systemKind)).toEqual([
      "encryption",
      "group-created",
      "joined",
      "added",
      "left",
      "removed",
      "group-subject",
      "group-icon",
      "group-description",
      "security-code",
      "phone-number",
      "disappearing-messages",
      "missed-call",
    ]);
  });

  it("treats media placeholders as system while keeping their sender", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:14:33] John: <Media omitted>",
        "[12/03/2024, 20:15:00] Yuki: image omitted",
        "[12/03/2024, 20:16:00] Yuki: video omitted",
        "[12/03/2024, 20:17:00] John: IMG-20240312-WA0001.jpg (file attached)",
        "[12/03/2024, 20:18:00] Yuki: <attached: 00000042-PHOTO-2024-03-12-20-14-33.jpg>",
      ].join("\n"),
    );

    expect(conversation.messages.every((message) => message.isSystem)).toBe(true);
    expect(conversation.messages.every((message) => message.systemKind === "media")).toBe(true);
    expect(conversation.messages[0]?.senderName).toBe("John");
    expect(conversation.humanMessageCount).toBe(0);
    expect(conversation.systemMessageCount).toBe(5);
  });

  it("classifies deletions from either side", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:14:33] John: You deleted this message",
        "[12/03/2024, 20:15:00] Yuki: This message was deleted",
        "[12/03/2024, 20:16:00] Yuki: real one",
      ].join("\n"),
    );

    expect(conversation.messages[0]?.systemKind).toBe("deleted");
    expect(conversation.messages[1]?.systemKind).toBe("deleted");
    expect(conversation.messages[2]?.isSystem).toBe(false);
    expect(conversation.messages[2]?.systemKind).toBeNull();
  });

  it("does not misread a human message that talks about leaving", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:14:33] John: Kwame left the office already, he added the file though",
        "[12/03/2024, 20:15:00] Yuki: someone changed the subject at dinner and I loved it",
      ].join("\n"),
    );

    expect(conversation.messages.some((message) => message.isSystem)).toBe(false);
    expect(conversation.humanMessageCount).toBe(2);
  });

  it("keeps the message count honest about what is real", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:00:00] Messages and calls are end-to-end encrypted.",
        "[12/03/2024, 20:14:33] John: hey",
        "[12/03/2024, 20:15:00] Yuki: <Media omitted>",
        "[12/03/2024, 20:16:00] Yuki: hi",
      ].join("\n"),
    );

    expect(conversation.messageCount).toBe(4);
    expect(conversation.systemMessageCount).toBe(2);
    expect(conversation.humanMessageCount).toBe(2);
  });

  it("parses a file made only of system messages", () => {
    const { conversation } = parseOk(SYSTEM_EXPORT);

    expect(conversation.participants).toEqual([]);
    expect(conversation.ownerCandidates).toEqual([]);
    expect(conversation.isGroup).toBe(false);
    expect(conversation.humanMessageCount).toBe(0);
    expect(iso(conversation.firstMessageAt)).toBe("2024-03-12T20:00:00.000Z");
    expect(conversation.firstHumanMessageAt).toBeNull();
    expect(conversation.lastHumanMessageAt).toBeNull();
  });

  it("classifies an unrecognised sender-less line as a plain notice", () => {
    const { conversation } = parseOk("[12/03/2024, 20:00:00] Something new WhatsApp invented");

    expect(conversation.messages[0]?.isSystem).toBe(true);
    expect(conversation.messages[0]?.systemKind).toBe("notice");
  });

  it("reads the Android flavour of the notices too", () => {
    const { conversation } = parseOk(
      [
        "12/03/2024, 20:00 - Messages and calls are end-to-end encrypted. Tap to learn more.",
        "12/03/2024, 20:01 - Yuki joined using this group's invite link",
        "12/03/2024, 20:02 - John: <Media omitted>",
      ].join("\n"),
    );

    expect(conversation.messages.map((message) => message.systemKind)).toEqual([
      "encryption",
      "joined",
      "media",
    ]);
  });
});

describe("participants and owner", () => {
  const GROUP = [
    "[12/03/2024, 20:00:00] Messages and calls are end-to-end encrypted.",
    "[12/03/2024, 20:14:33] John: hey",
    "[12/03/2024, 20:15:00] Yuki: hi",
    "[12/03/2024, 20:16:00] Kwame: yo",
    "[13/03/2024, 09:00:00] John: morning",
    "[13/03/2024, 09:05:00] John: <Media omitted>",
  ].join("\n");

  it("counts messages per sender", () => {
    const { conversation } = parseOk(GROUP);

    expect(conversation.participants).toHaveLength(3);
    expect(conversation.participants[0]).toMatchObject({
      senderName: "John",
      messageCount: 3,
      systemMessageCount: 1,
      isSelf: false,
    });
    expect(conversation.participants[1]?.senderName).toBe("Kwame");
    expect(conversation.participants[2]?.senderName).toBe("Yuki");
  });

  it("records each participant's own first and last message", () => {
    const { conversation } = parseOk(GROUP);
    const john = conversation.participants[0];

    expect(iso(john?.firstMessageAt ?? null)).toBe("2024-03-12T20:14:33.000Z");
    expect(iso(john?.lastMessageAt ?? null)).toBe("2024-03-13T09:05:00.000Z");
  });

  it("returns candidates and no owner when given no hint", () => {
    const { conversation } = parseOk(GROUP);

    expect(conversation.ownerName).toBeNull();
    expect(conversation.ownerCandidates).toEqual(["John", "Kwame", "Yuki"]);
    expect(conversation.messages.every((message) => !message.isFromSelf)).toBe(true);
  });

  it("uses a self name hint, case insensitively", () => {
    const { conversation, warnings } = parseOk(GROUP, { selfName: "  jOhN " });

    expect(conversation.ownerName).toBe("John");
    expect(conversation.participants[0]?.isSelf).toBe(true);
    expect(conversation.participants[1]?.isSelf).toBe(false);
    expect(
      conversation.messages.filter((message) => message.isFromSelf).map((message) => message.body),
    ).toEqual(["hey", "morning", "<Media omitted>"]);
    expect(warnings).toHaveLength(0);
  });

  it("refuses to guess when the hint matches nobody", () => {
    const { conversation, warnings } = parseOk(GROUP, { selfName: "Nobody" });

    expect(conversation.ownerName).toBeNull();
    expect(conversation.ownerCandidates).toHaveLength(3);
    expect(warnings.map((warning) => warning.code)).toContain("self-name-not-found");
  });

  it("calls three or more distinct senders a group", () => {
    const { conversation } = parseOk(GROUP);

    expect(conversation.isGroup).toBe(true);
  });

  it("does not call a two person chat a group", () => {
    const { conversation } = parseOk(IOS_BRACKETS);

    expect(conversation.isGroup).toBe(false);
    expect(conversation.participants).toHaveLength(2);
  });

  it("reports the conversation span from the messages", () => {
    const { conversation } = parseOk(GROUP);

    expect(iso(conversation.firstMessageAt)).toBe("2024-03-12T20:00:00.000Z");
    expect(iso(conversation.lastMessageAt)).toBe("2024-03-13T09:05:00.000Z");
    expect(iso(conversation.firstHumanMessageAt)).toBe("2024-03-12T20:14:33.000Z");
    expect(iso(conversation.lastHumanMessageAt)).toBe("2024-03-13T09:00:00.000Z");
  });
});

describe("sender names", () => {
  it("keeps emoji and non-ASCII names intact", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:14:33] 由紀 🍜: ラーメン食べたい",
        "[12/03/2024, 20:15:00] Zoë Ångström: same",
        "[12/03/2024, 20:16:00] Мёдерик: да",
      ].join("\n"),
    );

    expect(conversation.ownerCandidates.sort()).toEqual(
      ["Zoë Ångström", "Мёдерик", "由紀 🍜"].sort(),
    );
    expect(conversation.messages[0]?.body).toBe("ラーメン食べたい");
    expect(conversation.isGroup).toBe(true);
  });

  it("keeps a colon inside a sender name", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:14:33] DJ:Echo: dropping a set tonight",
        "[12/03/2024, 20:15:00] John: nice",
      ].join("\n"),
    );

    expect(conversation.messages[0]?.senderName).toBe("DJ:Echo");
    expect(conversation.messages[0]?.body).toBe("dropping a set tonight");
  });

  it("splits on the first colon-space, so a colon in the body is safe", () => {
    const { conversation } = parseOk(
      "[12/03/2024, 20:14:33] John: recipe: noodles, egg: soft boiled",
    );

    expect(conversation.messages[0]?.senderName).toBe("John");
    expect(conversation.messages[0]?.body).toBe("recipe: noodles, egg: soft boiled");
  });

  it("accepts a sender with an empty body", () => {
    const { conversation } = parseOk("[12/03/2024, 20:14:33] John:");

    expect(conversation.messages[0]?.senderName).toBe("John");
    expect(conversation.messages[0]?.body).toBe("");
    expect(conversation.messages[0]?.isSystem).toBe(false);
  });

  it("does not turn a long notice into a sender", () => {
    const { conversation } = parseOk(
      "[12/03/2024, 20:14:33] John changed the group description: dinner at 8",
    );

    expect(conversation.messages[0]?.senderName).toBeNull();
    expect(conversation.messages[0]?.systemKind).toBe("group-description");
  });
});

describe("failures", () => {
  it("fails on an empty file", () => {
    const result = parseWhatsAppExport("");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("empty-input");
  });

  it("fails on a whitespace or BOM only file", () => {
    for (const text of [`${BOM}`, "   \n\n\t", `${BOM}\n${LRM}  `]) {
      const result = parseWhatsAppExport(text);
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.error.code).toBe("empty-input");
    }
  });

  it("fails on text that is not an export, naming what it saw", () => {
    const result = parseWhatsAppExport("dear diary\nnothing happened today\n");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no-timestamped-lines");
    expect(result.error.line).toBe(1);
    expect(result.error.sample).toBe("dear diary");
  });

  it("fails when every timestamped line has an impossible date", () => {
    const result = parseWhatsAppExport("[31/02/2024, 20:14:33] John: no such day", {
      dayFirst: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no-valid-messages");
  });

  it("rejects out of range clock values instead of rolling them over", () => {
    const result = parseWhatsAppExport("[12/03/2024, 25:99:99] John: nope", {
      dayFirst: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no-valid-messages");
  });

  it("never throws, whatever it is handed", () => {
    const nasty = [
      " ",
      "[[[[[[",
      "[12/03/2024, 20:14:33]",
      "]]]]",
      "12/03/2024, 20:14 -",
      "[99/99/9999, 99:99:99] x: y",
      "a".repeat(50_000),
      "[12/03/2024, 20:14:33] " + "b".repeat(50_000),
    ];

    for (const text of nasty) {
      expect(() => parseWhatsAppExport(text)).not.toThrow();
    }
    expect(() => parseWhatsAppExport(undefined as unknown as string)).not.toThrow();
    expect(parseWhatsAppExport(undefined as unknown as string).ok).toBe(false);
  });

  it("always returns a warnings array, success or failure", () => {
    expect(Array.isArray(parseWhatsAppExport("").warnings)).toBe(true);
    expect(Array.isArray(parseWhatsAppExport(IOS_BRACKETS).warnings)).toBe(true);
  });

  it("caps the warning list on a pathologically broken file", () => {
    const lines: string[] = ["[13/03/2024, 20:00:00] John: real"];
    for (let index = 0; index < 120; index += 1) {
      lines.push(`[31/02/2024, 20:14:${String(index % 60).padStart(2, "0")}] John: bad`);
    }

    const { warnings } = parseOk(lines.join("\n"));

    expect(warnings.length).toBeLessThanOrEqual(51);
    expect(warnings[warnings.length - 1]?.code).toBe("warnings-truncated");
  });
});

describe("shape of the result", () => {
  it("numbers messages by file order and keeps their line numbers", () => {
    const { conversation } = parseOk(
      [
        "[12/03/2024, 20:14:33] John: one",
        "continued",
        "[12/03/2024, 20:15:02] Yuki: two",
      ].join("\n"),
    );

    expect(conversation.messages.map((message) => message.index)).toEqual([0, 1]);
    expect(conversation.messages.map((message) => message.line)).toEqual([1, 3]);
  });

  it("stays linear on a large export", () => {
    const lines: string[] = [
      "[12/03/2024, 20:00:00] Messages and calls are end-to-end encrypted.",
    ];
    for (let index = 0; index < 40_000; index += 1) {
      const minute = String(index % 60).padStart(2, "0");
      const sender = index % 2 === 0 ? "John" : "Yuki";
      lines.push(`[13/03/2024, 09:${minute}:00] ${sender}: message ${index}`);
      if (index % 10 === 0) lines.push("with a second line");
    }

    const started = Date.now();
    const { conversation } = parseOk(lines.join("\n"), { selfName: "John" });

    expect(conversation.messageCount).toBe(40_001);
    expect(conversation.humanMessageCount).toBe(40_000);
    expect(conversation.participants).toHaveLength(2);
    expect(conversation.participants[0]?.messageCount).toBe(20_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
