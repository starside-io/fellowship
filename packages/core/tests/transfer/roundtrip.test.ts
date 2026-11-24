import { describe, expect, it } from "vitest";

import { encodeBytes } from "../../src/domain/transfer/bytes.js";
import { buildExportSnapshot } from "../../src/domain/transfer/export.js";
import { importSnapshot } from "../../src/domain/transfer/import.js";
import {
  SNAPSHOT_VERSION,
  type ExportSnapshot,
} from "../../src/domain/transfer/snapshot.js";
import { openSilo } from "../../src/storage/client.js";
import { freshSiloPath } from "../storage/throwaway.js";

/**
 * The snapshot round trip gate: every table and column survives export then
 * import, avatar bytes included, and versions 1 and 2 still load.
 *
 * This is the layer this project has been bitten in twice. Version 1 dropped
 * sketches, favours, contact provenance and avatars while replace mode deleted
 * them first, and the chat tables shipped with no transfer layer at all.
 */

const SELF_ID = "11111111-1111-4111-8111-111111111111";
const FRIEND_ID = "22222222-2222-4222-8222-222222222222";
const CIRCLE_ID = "33333333-3333-4333-8333-333333333333";
const INTEREST_ID = "44444444-4444-4444-8444-444444444444";
const ALLERGY_ID = "55555555-5555-4555-8555-555555555555";
const FIELD_ID = "66666666-6666-4666-8666-666666666666";
const CONTACT_ID = "77777777-7777-4777-8777-777777777777";
const VALUE_ID = "88888888-8888-4888-8888-888888888888";
const NOTE_ID = "99999999-9999-4999-8999-999999999999";
const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROFILE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FAVOUR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHAT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MESSAGE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SECOND_MESSAGE_ID = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";

/** Not valid UTF-8, so only real bytes survive the trip. */
const AVATAR_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0xfe, 0x80]);

/** Newlines, emoji and non-ASCII: what a chat line actually holds. */
const AWKWARD_BODY = 'ありがとう 🙏\nLine two\tafter a tab\nCafé, naïve, Straße\r\nquote " and \\';

function fullSnapshot(): ExportSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    exportedAt: "2026-07-31T12:00:00.000Z",
    circles: [{ id: CIRCLE_ID, name: "Climbing", colour: "#6366f1" }],
    // In the order the exporter writes them: kind, then name.
    tags: [
      { id: ALLERGY_ID, kind: "ALLERGY", name: "peanuts", colour: "#ef4444" },
      { id: INTEREST_ID, kind: "INTEREST", name: "ramen", colour: "#10b981" },
    ],
    fieldDefinitions: [
      {
        id: FIELD_ID,
        key: "coffee_order",
        label: "Coffee order",
        type: "TEXT",
        options: [],
        scope: "CUSTOM",
        order: 0,
      },
    ],
    people: [
      {
        id: SELF_ID,
        displayName: "Me",
        firstName: "Me",
        lastName: null,
        isSelf: true,
        avatarColor: "#64748b",
        avatarImage: null,
        avatarMime: null,
        avatarSource: null,
        avatarSourceUrl: null,
        avatarFetchedAt: null,
        birthday: "1990-03-04",
        location: "Springfield",
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
      },
      {
        id: FRIEND_ID,
        displayName: "Sam Rivera",
        firstName: "Sam",
        lastName: "Rivera",
        isSelf: false,
        avatarColor: "#ef4444",
        avatarImage: encodeBytes(AVATAR_BYTES),
        avatarMime: "image/webp",
        avatarSource: "RESOLVER",
        avatarSourceUrl: "https://github.com/sam.png",
        avatarFetchedAt: "2026-05-05T05:05:05.000Z",
        birthday: "1991-11-12",
        location: "Lisbon",
        howWeMet: "Climbing gym",
        metOn: "2024-02-02",
        commStyle: ["voice notes", "long replies"],
        mbti: "ENFP",
        archived: false,
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-04T00:00:00.000Z",
        circleIds: [CIRCLE_ID],
        interestIds: [INTEREST_ID],
        allergyIds: [ALLERGY_ID],
        dislikeIds: [],
        contacts: [
          {
            id: CONTACT_ID,
            kind: "SOCIAL",
            platform: "github",
            value: "sam",
            url: "https://github.com/sam",
            isPrimary: true,
            label: null,
            source: "ASSISTANT",
            sourceUrl: "https://github.com/sam",
            confidence: "MEDIUM",
            verifiedAt: null,
          },
        ],
        customValues: [
          { id: VALUE_ID, fieldDefinitionId: FIELD_ID, value: "flat white" },
        ],
      },
    ],
    notes: [
      {
        id: NOTE_ID,
        personId: FRIEND_ID,
        eventId: null,
        body: { type: "doc", content: [{ type: "paragraph" }] },
        occurredAt: "2026-06-01T10:00:00.000Z",
        pinned: true,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
        tagIds: [INTEREST_ID],
      },
    ],
    events: [
      {
        id: EVENT_ID,
        title: "Dinner at Kanji",
        type: "MEAL",
        occurredAt: "2026-06-02T12:00:00.000Z",
        location: "Kanji",
        description: { type: "doc", content: [] },
        sentiment: 2,
        weight: 2,
        createdAt: "2026-06-02T12:00:00.000Z",
        updatedAt: "2026-06-02T12:00:00.000Z",
        participants: [
          { personId: SELF_ID, role: null, sentiment: null },
          { personId: FRIEND_ID, role: "host", sentiment: 1 },
        ],
      },
    ],
    links: [
      {
        id: LINK_ID,
        aPersonId: SELF_ID < FRIEND_ID ? SELF_ID : FRIEND_ID,
        bPersonId: SELF_ID < FRIEND_ID ? FRIEND_ID : SELF_ID,
        tie: "CLOSE_FRIEND",
        manualScore: null,
        pinned: true,
        notes: "met climbing",
        stat: {
          score: 42,
          eventCount: 1,
          lastEventAt: "2026-06-02T12:00:00.000Z",
          positiveCount: 1,
          negativeCount: 0,
        },
      },
    ],
    personProfiles: [
      {
        id: PROFILE_ID,
        personId: FRIEND_ID,
        summary: "Replies in the evening, in paragraphs.",
        whatLands: "Specific plans",
        whatToAvoid: "Open ended maybes",
        opener: "Ask about the last route they tried",
        traits: [
          { key: "pace", label: "Pace", left: "Slow", right: "Fast", value: 70 },
        ],
        personality: [
          { key: "warmth", value: 80, evidence: "Checks in after every trip.", confidence: "medium" },
        ],
        personalityAt: "2026-06-04T00:00:00.000Z",
        sources: ["https://github.com/sam"],
        source: "ASSISTANT",
        generatedAt: "2026-06-03T00:00:00.000Z",
        confirmedAt: null,
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ],
    favours: [
      {
        id: FAVOUR_ID,
        personId: FRIEND_ID,
        direction: "I_OWE_THEM",
        description: "They paid for dinner",
        settledAt: null,
        createdAt: "2026-06-02T13:00:00.000Z",
        updatedAt: "2026-06-02T13:00:00.000Z",
      },
    ],
    appSettings: [
      { key: "avatar.resolvers", value: [], updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    conversations: [
      {
        id: CHAT_ID,
        source: "WHATSAPP",
        title: "Sam Rivera",
        isGroup: false,
        fileName: "chat.txt",
        importedAt: "2026-06-04T00:00:00.000Z",
        firstMessageAt: "2026-05-01T08:00:00.000Z",
        lastMessageAt: "2026-05-01T09:00:00.000Z",
        messageCount: 2,
        participants: [
          { senderName: "Me", personId: SELF_ID, isSelf: true, messageCount: 1 },
          { senderName: "Sam", personId: FRIEND_ID, isSelf: false, messageCount: 1 },
        ],
      },
    ],
    messages: [
      {
        id: MESSAGE_ID,
        conversationId: CHAT_ID,
        senderName: "Sam",
        personId: FRIEND_ID,
        sentAt: "2026-05-01T08:00:00.000Z",
        body: AWKWARD_BODY,
        isFromSelf: false,
        isSystem: false,
      },
      {
        id: SECOND_MESSAGE_ID,
        conversationId: CHAT_ID,
        senderName: "Me",
        personId: SELF_ID,
        sentAt: "2026-05-01T09:00:00.000Z",
        body: "on my way",
        isFromSelf: true,
        isSystem: false,
      },
    ],
  };
}

/** The whole file bar the timestamp of the export itself. */
function comparable(snapshot: ExportSnapshot) {
  const { exportedAt: _ignored, ...rest } = snapshot;
  return rest;
}

async function silo() {
  return openSilo({ path: freshSiloPath() });
}

describe("the snapshot round trip", () => {
  it("brings back every table and column it took out", async () => {
    const db = await silo();
    try {
      const file = fullSnapshot();
      const first = await importSnapshot(db, file, "replace");

      expect(first.counts.people).toBe(2);
      expect(first.counts.contacts).toBe(1);
      expect(first.counts.customValues).toBe(1);
      expect(first.counts.notes).toBe(1);
      expect(first.counts.events).toBe(1);
      expect(first.counts.eventParticipants).toBe(2);
      expect(first.counts.links).toBe(1);
      expect(first.counts.personProfiles).toBe(1);
      expect(first.counts.favours).toBe(1);
      expect(first.counts.conversations).toBe(1);
      expect(first.counts.conversationParticipants).toBe(2);
      expect(first.counts.messages).toBe(2);
      // The silo has no settings table, and the import says so rather than
      // dropping the rows quietly.
      expect(first.counts.appSettingsIgnored).toBe(1);

      const exported = await buildExportSnapshot(db);

      // appSettings is the one key that cannot come back: it is the host's now.
      expect(exported.appSettings).toEqual([]);
      expect(comparable(exported)).toEqual(
        comparable({ ...file, appSettings: [] }),
      );
    } finally {
      await db.$disconnect();
    }
  });

  it("keeps the avatar bytes byte for byte", async () => {
    const db = await silo();
    try {
      await importSnapshot(db, fullSnapshot(), "replace");
      const exported = await buildExportSnapshot(db);

      const friend = exported.people.find((person) => person.id === FRIEND_ID);
      expect(friend?.avatarImage).toBe(encodeBytes(AVATAR_BYTES));
      expect(friend?.avatarMime).toBe("image/webp");
      expect(friend?.avatarSource).toBe("RESOLVER");

      // And the bytes are not on the person row, they are in their own table.
      const row = await db.person.findUnique({
        where: { id: FRIEND_ID },
        include: { avatar: true },
      });
      expect(row?.avatar?.image).toEqual(AVATAR_BYTES);
    } finally {
      await db.$disconnect();
    }
  });

  it("is stable: exporting, importing and exporting again gives the same file", async () => {
    const db = await silo();
    try {
      await importSnapshot(db, fullSnapshot(), "replace");
      const once = await buildExportSnapshot(db);

      await importSnapshot(db, once, "merge");
      const twice = await buildExportSnapshot(db);

      expect(comparable(twice)).toEqual(comparable(once));
    } finally {
      await db.$disconnect();
    }
  });

  it("leaves 21k messages attached to their person through a replace", async () => {
    const db = await silo();
    try {
      const file = fullSnapshot();
      const many = Array.from({ length: 2_000 }, (_, index) => ({
        id: `${(index + 1).toString().padStart(8, "0")}-0000-4000-8000-000000000000`,
        conversationId: CHAT_ID,
        senderName: "Sam",
        personId: FRIEND_ID,
        sentAt: new Date(Date.UTC(2026, 4, 1, 8, 0, index)).toISOString(),
        body: `message ${index}`,
        isFromSelf: false,
        isSystem: false,
      }));
      file.messages = many;
      file.conversations[0]!.messageCount = many.length;

      await importSnapshot(db, file, "replace");
      const attached = await db.message.count({ where: { personId: FRIEND_ID } });
      expect(attached).toBe(many.length);

      // Re-importing the same file must not sever them or double them up.
      await importSnapshot(db, file, "merge");
      expect(await db.message.count()).toBe(many.length);
      expect(await db.message.count({ where: { personId: FRIEND_ID } })).toBe(
        many.length,
      );
    } finally {
      await db.$disconnect();
    }
  });

  it("refuses to replace everything with a file holding no people", async () => {
    const db = await silo();
    try {
      const empty = { ...fullSnapshot(), people: [] };
      await expect(importSnapshot(db, empty, "replace")).rejects.toThrow(
        /holds no people/,
      );
    } finally {
      await db.$disconnect();
    }
  });

  it("refuses a file that leaves no single self person", async () => {
    const db = await silo();
    try {
      const file = fullSnapshot();
      file.people = file.people.map((person) => ({ ...person, isSelf: false }));
      await expect(importSnapshot(db, file, "replace")).rejects.toThrow(/self/);
    } finally {
      await db.$disconnect();
    }
  });
});

describe("older files", () => {
  it("loads a version 1 file without blanking what it never knew about", async () => {
    const db = await silo();
    try {
      await importSnapshot(db, fullSnapshot(), "replace");

      // A version 1 file: no provenance, no avatar, no sketches, no chats.
      const v1 = {
        version: 1,
        exportedAt: "2026-07-31T12:00:00.000Z",
        circles: [],
        tags: [],
        fieldDefinitions: [],
        people: [
          {
            id: FRIEND_ID,
            displayName: "Sam Rivera",
            firstName: "Sam",
            lastName: "Rivera",
            isSelf: false,
            avatarColor: "#ef4444",
            birthday: null,
            location: "Lisbon",
            howWeMet: null,
            metOn: null,
            commStyle: [],
            archived: false,
            createdAt: "2026-01-03T00:00:00.000Z",
            updatedAt: "2026-01-04T00:00:00.000Z",
            circleIds: [],
            interestIds: [],
            allergyIds: [],
            dislikeIds: [],
            contacts: [],
            customValues: [],
          },
        ],
        notes: [],
        events: [],
        links: [],
      };

      await importSnapshot(db, v1, "merge");
      const exported = await buildExportSnapshot(db);
      const friend = exported.people.find((person) => person.id === FRIEND_ID);

      // The picture and the sketch were not in the file, so they are still here.
      expect(friend?.avatarImage).toBe(encodeBytes(AVATAR_BYTES));
      expect(exported.personProfiles).toHaveLength(1);
      expect(exported.messages).toHaveLength(2);
    } finally {
      await db.$disconnect();
    }
  });

  it("loads a version 2 file, which knows pictures but not chats", async () => {
    const db = await silo();
    try {
      await importSnapshot(db, fullSnapshot(), "replace");

      const v2 = {
        ...fullSnapshot(),
        version: 2,
        conversations: undefined,
        messages: undefined,
      };
      delete (v2 as Record<string, unknown>)["conversations"];
      delete (v2 as Record<string, unknown>)["messages"];

      await importSnapshot(db, v2, "merge");
      const exported = await buildExportSnapshot(db);

      // A file with no opinion about chats does not wipe them.
      expect(exported.messages).toHaveLength(2);
      expect(exported.conversations).toHaveLength(1);
    } finally {
      await db.$disconnect();
    }
  });
});

describe("the import tool", () => {
  it("rebuilds the cached scores rather than trusting the file's", async () => {
    const db = await silo();
    try {
      const file = fullSnapshot();
      // The file carries a score computed by whatever exported it, at its own
      // "now". This one is impossible: no event in the file supports it.
      file.links[0]!.stat = {
        score: 99,
        eventCount: 41,
        lastEventAt: "2020-01-01T00:00:00.000Z",
        positiveCount: 41,
        negativeCount: 0,
      };

      const { activate } = await import("../../src/activate.js");
      const { DEFAULT_CONFIG } = await import("../../src/config/index.js");

      const api = activate({
        storage: { silo: () => db },
        models: { complete: async () => ({ text: "" }), embed: async () => [] },
        review: {
          propose: async () => ({ id: "p" }),
          list: async () => [],
          get: async () => null,
          decide: async () => false,
        },
        bus: { emit: () => undefined },
        connectors: { pull: async () => ({ items: [] }) },
        privacy: { redact: (text) => text },
        audit: { log: async () => undefined },
        settings: { get: async () => DEFAULT_CONFIG, set: async () => DEFAULT_CONFIG },
        refs: {
          resolve: async (ref) => ({ status: "unavailable", ref, reason: "one module" }),
        },
        media: {
          fetchImage: async () => {
            throw new Error("not used");
          },
        },
      });

      const result = (await api.invoke("people.import", {
        snapshot: file,
        mode: "replace",
        confirmedByUser: true,
      })) as { recompute: { pairsProcessed: number } };

      expect(result.recompute.pairsProcessed).toBeGreaterThan(0);

      const stat = await db.linkStat.findFirstOrThrow();
      // One event between the two of them, so one event is what the cache says.
      expect(stat.eventCount).toBe(1);
      expect(stat.score).not.toBe(99);
    } finally {
      await db.$disconnect();
    }
  });
});
