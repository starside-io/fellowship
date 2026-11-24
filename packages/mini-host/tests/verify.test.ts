import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EXPECTED_LOSS, classify, verifySnapshot } from "../src/verify.js";

/**
 * The round trip command, on files small enough to read.
 *
 * The real akai-ito export is 20MB of someone's life and does not belong in a
 * test, so these are the shapes that file turned out to have: a string where a
 * document was expected, a picture with no metadata beside it, and a settings
 * row with nowhere to go.
 */

const SELF = "11111111-1111-4111-8111-111111111111";
const FRIEND = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const CHAT = "44444444-4444-4444-8444-444444444444";
const MESSAGE = "55555555-5555-4555-8555-555555555555";
const PROFILE = "66666666-6666-4666-8666-666666666666";

function person(id: string, displayName: string, isSelf = false) {
  return {
    id,
    displayName,
    firstName: null,
    lastName: null,
    isSelf,
    avatarColor: "#64748b",
    avatarImage: null,
    avatarMime: null,
    avatarSource: null,
    avatarSourceUrl: null,
    avatarFetchedAt: null,
    birthday: null,
    location: null,
    howWeMet: null,
    metOn: null,
    commStyle: [],
    mbti: null,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    circleIds: [],
    interestIds: [],
    allergyIds: [],
    dislikeIds: [],
    contacts: [],
    customValues: [],
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    exportedAt: "2026-07-31T12:00:00.000Z",
    people: [person(SELF, "Me", true), person(FRIEND, "Sam Rivera")],
    tags: [],
    circles: [],
    fieldDefinitions: [],
    notes: [],
    events: [
      {
        id: EVENT,
        title: "Dinner",
        type: "MEAL",
        occurredAt: "2026-06-02T12:00:00.000Z",
        location: null,
        description: { type: "doc", content: [] },
        sentiment: 2,
        weight: 1,
        createdAt: "2026-06-02T12:00:00.000Z",
        updatedAt: "2026-06-02T12:00:00.000Z",
        participants: [
          { personId: SELF, role: null, sentiment: null },
          { personId: FRIEND, role: null, sentiment: 1 },
        ],
      },
    ],
    links: [],
    personProfiles: [
      {
        id: PROFILE,
        personId: FRIEND,
        summary: "Replies in the evening.",
        whatLands: null,
        whatToAvoid: null,
        opener: null,
        traits: null,
        personality: null,
        personalityAt: null,
        sources: ["history"],
        source: "ASSISTANT",
        generatedAt: "2026-06-03T00:00:00.000Z",
        confirmedAt: null,
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ],
    favours: [],
    appSettings: [
      { key: "avatar.resolvers", value: [], updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    conversations: [
      {
        id: CHAT,
        source: "WHATSAPP",
        title: "Sam Rivera",
        isGroup: false,
        fileName: "chat.txt",
        importedAt: "2026-06-04T00:00:00.000Z",
        firstMessageAt: "2026-05-01T08:00:00.000Z",
        lastMessageAt: "2026-05-01T08:00:00.000Z",
        messageCount: 1,
        participants: [
          { senderName: "Sam", personId: FRIEND, isSelf: false, messageCount: 1 },
        ],
      },
    ],
    messages: [
      {
        id: MESSAGE,
        conversationId: CHAT,
        senderName: "Sam",
        personId: FRIEND,
        sentAt: "2026-05-01T08:00:00.000Z",
        body: "morning",
        isFromSelf: false,
        isSystem: false,
      },
    ],
    ...overrides,
  };
}

function write(file: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "fellowship-snap-")), "snapshot.json");
  writeFileSync(path, JSON.stringify(file));
  return path;
}

describe("verifySnapshot", () => {
  it("passes a file that survives whole, and says what it could not bring back", async () => {
    const result = await verifySnapshot(write(snapshot()));

    expect(result.ok).toBe(true);
    expect(result.classified.lost).toEqual([]);
    expect(result.classified.unexplained).toEqual([]);
    expect(result.checks.singleSelf).toBe(true);
    expect(result.checks.messagesStored).toBe(1);
    expect(result.checks.messagesAttachedStored).toBe(1);

    // The settings row has nowhere to go, and that is the only count that moves.
    expect(EXPECTED_LOSS).toEqual(["appSettings"]);
    const settings = result.diff.collections.find(
      (collection) => collection.collection === "appSettings",
    );
    expect(settings).toMatchObject({ before: 1, after: 0, missing: [] });
  });

  it("reads a string rich text column as normalized, not as loss", async () => {
    const file = snapshot();
    (file.events[0] as Record<string, unknown>)["description"] =
      '[object Object] Sentiment from the chat: "thanks for letting me know"';

    const result = await verifySnapshot(write(file));

    expect(result.ok).toBe(true);
    expect(result.classified.lost).toEqual([]);
    expect(result.classified.normalized).toEqual([
      {
        collection: "events",
        key: EVENT,
        path: "description",
        reason: "a string rich text column became a one paragraph document, text kept",
      },
    ]);

    // The text is still there, which is the part that matters.
    const events = result.diff.collections.find(
      (collection) => collection.collection === "events",
    );
    expect(JSON.stringify(events?.changed[0]?.fields[0]?.after)).toContain(
      "thanks for letting me know",
    );
  });

  it("reads picture metadata the file left null as normalized", async () => {
    const file = snapshot();
    const friend = file.people[1] as Record<string, unknown>;
    friend["avatarImage"] = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    friend["avatarMime"] = null;
    friend["avatarSource"] = null;
    friend["avatarFetchedAt"] = null;

    const result = await verifySnapshot(write(file));

    expect(result.ok).toBe(true);
    expect(result.checks.picturesStored).toBe(1);
    expect(result.classified.lost).toEqual([]);
    expect(result.classified.normalized.map((entry) => entry.path).sort()).toEqual([
      "avatarFetchedAt",
      "avatarMime",
      "avatarSource",
    ]);
  });

  it("fails a file whose self person is missing", async () => {
    const file = snapshot({
      people: [person(SELF, "Me"), person(FRIEND, "Sam Rivera")],
    });

    await expect(verifySnapshot(write(file))).rejects.toThrow(/self/);
  });

  it("leaves no throwaway silo behind unless asked", async () => {
    const result = await verifySnapshot(write(snapshot()));
    expect(result.siloPath).toContain("fellowship-verify-");

    const kept = await verifySnapshot(write(snapshot()), { keep: true });
    const { existsSync } = await import("node:fs");
    expect(existsSync(result.siloPath)).toBe(false);
    expect(existsSync(kept.siloPath)).toBe(true);
  });
});

describe("the classifier", () => {
  /** A diff shaped like the real thing, without needing a database. */
  function diffWith(changed: Array<{ path: string; before: unknown; after: unknown }>) {
    return {
      identical: false,
      collections: [],
      problems: [
        {
          collection: "people",
          before: 1,
          after: 1,
          missing: [],
          extra: [],
          changed: [{ key: FRIEND, fields: changed }],
        },
      ],
    };
  }

  it("calls a value that went to null loss, which is the version 1 bug", () => {
    const classified = classify(
      diffWith([{ path: "summary", before: "Replies in the evening.", after: null }]),
    );

    expect(classified.lost).toEqual([
      {
        collection: "people",
        key: FRIEND,
        path: "summary",
        reason: "the value did not come back",
      },
    ]);
    expect(classified.normalized).toEqual([]);
  });

  it("calls a row that vanished loss", () => {
    const classified = classify({
      identical: false,
      collections: [],
      problems: [
        {
          collection: "personProfiles",
          before: 1,
          after: 0,
          missing: [FRIEND],
          extra: [],
          changed: [],
        },
      ],
    });

    expect(classified.lost).toEqual([
      {
        collection: "personProfiles",
        key: FRIEND,
        path: "",
        reason: "the row did not come back",
      },
    ]);
  });

  it("calls anything it cannot account for unexplained rather than fine", () => {
    const classified = classify(
      diffWith([{ path: "displayName", before: "Sam Rivera", after: "Sam R." }]),
    );

    expect(classified.unexplained).toEqual([
      {
        collection: "people",
        key: FRIEND,
        path: "displayName",
        reason: "not a known normalization",
      },
    ]);
    expect(classified.lost).toEqual([]);
  });

  it("does not take a string that lost its text as a normalization", () => {
    const classified = classify(
      diffWith([
        {
          path: "description",
          before: "the text that was there",
          after: { type: "doc", content: [{ type: "paragraph" }] },
        },
      ]),
    );

    expect(classified.normalized).toEqual([]);
    expect(classified.unexplained).toHaveLength(1);
  });

  it("calls a row that appeared out of nowhere unexplained", () => {
    const classified = classify({
      identical: false,
      collections: [],
      problems: [
        { collection: "tags", before: 0, after: 1, missing: [], extra: ["x"], changed: [] },
      ],
    });

    expect(classified.unexplained[0]?.reason).toBe(
      "a row appeared that the file did not carry",
    );
  });
});
