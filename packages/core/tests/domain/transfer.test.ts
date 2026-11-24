import { describe, expect, it } from "vitest";

import { decodeBytes, encodeBytes } from "../../src/domain/transfer/bytes.js";
import {
  MAX_AVATAR_BASE64_LENGTH,
  SNAPSHOT_VERSION,
  snapshotSchema,
  summariseSnapshot,
} from "../../src/domain/transfer/snapshot.js";

// The pure half of the transfer code: the snapshot schema, the version
// boundary, and the base64 encoding that carries avatar bytes through JSON.
// Nothing here touches the database.

const PERSON_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const FAVOUR_ID = "55555555-5555-4555-8555-555555555555";
const TAG_ID = "66666666-6666-4666-8666-666666666666";
const CIRCLE_ID = "77777777-7777-4777-8777-777777777777";
const FIELD_ID = "88888888-8888-4888-8888-888888888888";
const NOTE_ID = "99999999-9999-4999-8999-999999999999";
const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MESSAGE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECOND_MESSAGE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** Newlines, emoji, and non-ASCII: the three things a chat line really holds. */
const AWKWARD_BODY =
  "ありがとう 🙏\nLine two\tafter a tab\nCafé, naïve, Straße\r\nquote \" and backslash \\ and 👨‍👩‍👧‍👦";

/** A tiny run of bytes that is not valid UTF-8, so only real bytes survive. */
const AVATAR_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x7f, 0x01, 0x00, 0x00, 0xc3,
  0x28, 0xed, 0xa0,
]);

function v1Person() {
  return {
    id: PERSON_ID,
    displayName: "Ada",
    firstName: "Ada",
    lastName: null,
    isSelf: true,
    avatarColor: "#6366f1",
    birthday: "1980-12-10",
    location: "Kyoto",
    howWeMet: null,
    metOn: null,
    commStyle: ["direct"],
    archived: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    circleIds: [CIRCLE_ID],
    interestIds: [TAG_ID],
    allergyIds: [],
    dislikeIds: [],
    contacts: [
      {
        id: CONTACT_ID,
        kind: "SOCIAL",
        platform: "github",
        value: "ada",
        url: "https://github.com/ada",
        isPrimary: true,
        label: null,
      },
    ],
    customValues: [
      { id: OTHER_ID, fieldDefinitionId: FIELD_ID, value: { note: "hi" } },
    ],
  };
}

function v1Snapshot() {
  return {
    version: 1,
    exportedAt: "2024-06-01T10:00:00.000Z",
    people: [v1Person()],
    tags: [{ id: TAG_ID, kind: "INTEREST", name: "kendo", colour: "#10b981" }],
    circles: [{ id: CIRCLE_ID, name: "Dojo", colour: "#0ea5e9" }],
    fieldDefinitions: [
      {
        id: FIELD_ID,
        key: "role",
        label: "Role",
        type: "TEXT",
        options: [],
        scope: "CUSTOM",
        order: 0,
      },
    ],
    notes: [
      {
        id: NOTE_ID,
        personId: PERSON_ID,
        eventId: null,
        body: { type: "doc", content: [] },
        occurredAt: "2024-03-01T00:00:00.000Z",
        pinned: false,
        createdAt: "2024-03-01T00:00:00.000Z",
        updatedAt: "2024-03-01T00:00:00.000Z",
        tagIds: [TAG_ID],
      },
    ],
    events: [
      {
        id: EVENT_ID,
        title: "Tea",
        type: "MEAL",
        occurredAt: "2024-04-01T00:00:00.000Z",
        location: null,
        description: null,
        sentiment: 1,
        weight: 1,
        createdAt: "2024-04-01T00:00:00.000Z",
        updatedAt: "2024-04-01T00:00:00.000Z",
        participants: [{ personId: PERSON_ID, role: null, sentiment: 1 }],
      },
    ],
    links: [
      {
        id: LINK_ID,
        aPersonId: PERSON_ID,
        bPersonId: OTHER_ID,
        tie: "FRIEND",
        manualScore: null,
        pinned: false,
        notes: null,
        stat: {
          score: 4.5,
          eventCount: 2,
          lastEventAt: "2024-04-01T00:00:00.000Z",
          positiveCount: 2,
          negativeCount: 0,
        },
      },
    ],
  };
}

function v2Snapshot() {
  const base = v1Snapshot();
  const person = base.people[0];

  return {
    ...base,
    version: 2,
    people: [
      {
        ...person,
        avatarImage: encodeBytes(AVATAR_BYTES),
        avatarMime: "image/webp",
        avatarSource: "RESOLVER",
        avatarSourceUrl: "https://github.com/ada.png?size=400",
        avatarFetchedAt: "2024-05-01T09:00:00.000Z",
        contacts: [
          {
            ...person.contacts[0],
            source: "ASSISTANT",
            sourceUrl: "https://example.test/ada",
            confidence: "HIGH",
            verifiedAt: "2024-05-02T09:00:00.000Z",
          },
        ],
      },
    ],
    personProfiles: [
      {
        id: PROFILE_ID,
        personId: PERSON_ID,
        summary: "Reads the room before speaking.",
        whatLands: "Concrete plans.",
        whatToAvoid: "Small talk.",
        opener: "How did the tournament go?",
        traits: [
          { key: "pace", label: "Pace", left: "Slow", right: "Fast", value: 40 },
        ],
        sources: ["https://example.test/ada"],
        source: "ASSISTANT",
        generatedAt: "2024-05-03T09:00:00.000Z",
        confirmedAt: null,
        createdAt: "2024-05-03T09:00:00.000Z",
        updatedAt: "2024-05-03T09:00:00.000Z",
      },
    ],
    favours: [
      {
        id: FAVOUR_ID,
        personId: PERSON_ID,
        direction: "I_OWE_THEM",
        description: "Borrowed a bokken.",
        settledAt: null,
        createdAt: "2024-05-04T09:00:00.000Z",
        updatedAt: "2024-05-04T09:00:00.000Z",
      },
    ],
    appSettings: [
      {
        key: "avatar.resolvers",
        value: [{ id: "github", enabled: true }],
        updatedAt: "2024-05-05T09:00:00.000Z",
      },
    ],
  };
}

function v3Snapshot() {
  return {
    ...v2Snapshot(),
    version: 3,
    conversations: [
      {
        id: CONVERSATION_ID,
        source: "WHATSAPP",
        title: "Dojo group",
        isGroup: true,
        fileName: "WhatsApp Chat with Dojo group.txt",
        importedAt: "2024-06-01T08:00:00.000Z",
        firstMessageAt: "2023-01-01T12:00:00.000Z",
        lastMessageAt: "2024-05-31T21:30:00.000Z",
        messageCount: 2,
        participants: [
          {
            senderName: "Ada",
            personId: PERSON_ID,
            isSelf: true,
            messageCount: 1,
          },
          {
            senderName: "Grace H.",
            personId: null,
            isSelf: false,
            messageCount: 1,
          },
        ],
      },
    ],
    messages: [
      {
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderName: "Ada",
        personId: PERSON_ID,
        sentAt: "2023-01-01T12:00:00.000Z",
        body: AWKWARD_BODY,
        isFromSelf: true,
        isSystem: false,
      },
      {
        id: SECOND_MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderName: "Grace H.",
        personId: null,
        sentAt: "2024-05-31T21:30:00.000Z",
        body: "",
        isFromSelf: false,
        isSystem: true,
      },
    ],
  };
}

describe("base64 avatar bytes", () => {
  it("round trips byte for byte", () => {
    const encoded = encodeBytes(AVATAR_BYTES);
    const decoded = decodeBytes(encoded);

    expect(decoded.byteLength).toBe(AVATAR_BYTES.byteLength);
    expect(Array.from(decoded)).toEqual(Array.from(AVATAR_BYTES));
  });

  it("survives JSON.stringify and JSON.parse", () => {
    const wire: unknown = JSON.parse(
      JSON.stringify({ avatarImage: encodeBytes(AVATAR_BYTES) }),
    );
    const image = (wire as { avatarImage: string }).avatarImage;

    expect(Array.from(decodeBytes(image))).toEqual(Array.from(AVATAR_BYTES));
  });

  it("round trips a run covering every byte value", () => {
    const every = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) every[index] = index;

    expect(Array.from(decodeBytes(encodeBytes(every)))).toEqual(
      Array.from(every),
    );
  });

  it("encodes to roughly four characters per three bytes", () => {
    const bytes = new Uint8Array(25 * 1024);
    const encoded = encodeBytes(bytes);

    expect(encoded.length).toBe(Math.ceil(bytes.byteLength / 3) * 4);
    expect(encoded.length).toBeLessThanOrEqual(MAX_AVATAR_BASE64_LENGTH);
  });

  it("round trips an empty picture as an empty string", () => {
    expect(encodeBytes(new Uint8Array(0))).toBe("");
    expect(decodeBytes("").byteLength).toBe(0);
  });
});

describe("version 3 snapshot schema", () => {
  it("is the version the exporter writes", () => {
    expect(SNAPSHOT_VERSION).toBe(3);
  });

  it("accepts a full snapshot with its chats", () => {
    const parsed = snapshotSchema.parse(v3Snapshot());

    expect(parsed.version).toBe(3);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.messages).toHaveLength(2);
  });

  it("keeps every conversation column", () => {
    const conversation = snapshotSchema.parse(v3Snapshot()).conversations?.[0];

    expect(conversation?.id).toBe(CONVERSATION_ID);
    expect(conversation?.source).toBe("WHATSAPP");
    expect(conversation?.title).toBe("Dojo group");
    expect(conversation?.isGroup).toBe(true);
    expect(conversation?.fileName).toBe("WhatsApp Chat with Dojo group.txt");
    expect(conversation?.importedAt).toEqual(
      new Date("2024-06-01T08:00:00.000Z"),
    );
    expect(conversation?.firstMessageAt).toEqual(
      new Date("2023-01-01T12:00:00.000Z"),
    );
    expect(conversation?.lastMessageAt).toEqual(
      new Date("2024-05-31T21:30:00.000Z"),
    );
    expect(conversation?.messageCount).toBe(2);
  });

  it("keeps the participants and the person each sender maps to", () => {
    const participants =
      snapshotSchema.parse(v3Snapshot()).conversations?.[0].participants ?? [];

    expect(participants).toHaveLength(2);
    expect(participants[0]).toEqual({
      senderName: "Ada",
      personId: PERSON_ID,
      isSelf: true,
      messageCount: 1,
    });
    // An unmapped sender keeps its null rather than losing the row.
    expect(participants[1].personId).toBeNull();
    expect(participants[1].senderName).toBe("Grace H.");
  });

  it("keeps every message column", () => {
    const messages = snapshotSchema.parse(v3Snapshot()).messages ?? [];

    expect(messages[0].id).toBe(MESSAGE_ID);
    expect(messages[0].conversationId).toBe(CONVERSATION_ID);
    expect(messages[0].senderName).toBe("Ada");
    expect(messages[0].personId).toBe(PERSON_ID);
    expect(messages[0].sentAt).toEqual(new Date("2023-01-01T12:00:00.000Z"));
    expect(messages[0].isFromSelf).toBe(true);
    expect(messages[0].isSystem).toBe(false);

    expect(messages[1].personId).toBeNull();
    expect(messages[1].body).toBe("");
    expect(messages[1].isSystem).toBe(true);
  });

  it("accepts the empty sender a system notice carries", () => {
    const snapshot = v3Snapshot();
    snapshot.messages[1].senderName = "";

    const parsed = snapshotSchema.parse(snapshot);

    expect(parsed.messages?.[1].senderName).toBe("");
    expect(parsed.messages?.[1].isSystem).toBe(true);
  });

  it("does not trim a sender name, which is half a participant key", () => {
    const snapshot = v3Snapshot();
    snapshot.conversations[0].participants[1].senderName = " Grace H. ";
    snapshot.messages[1].senderName = " Grace H. ";

    const parsed = snapshotSchema.parse(snapshot);

    expect(parsed.conversations?.[0].participants[1].senderName).toBe(
      " Grace H. ",
    );
    expect(parsed.messages?.[1].senderName).toBe(" Grace H. ");
  });

  it("carries a message body through JSON unchanged", () => {
    const wire: unknown = JSON.parse(JSON.stringify(v3Snapshot()));
    const parsed = snapshotSchema.parse(wire);

    expect(parsed.messages?.[0].body).toBe(AWKWARD_BODY);
    expect(parsed.messages?.[0].body).toContain("\n");
    expect(parsed.messages?.[0].body).toContain("\r\n");
    expect(parsed.messages?.[0].body).toContain("🙏");
    expect(parsed.messages?.[0].body).toContain("Straße");
    // Round tripped again, so nothing drifts on a re-export of an import.
    expect(
      snapshotSchema.parse(JSON.parse(JSON.stringify(wire))).messages?.[0].body,
    ).toBe(AWKWARD_BODY);
  });

  it("rejects a message pointing at a conversation the file lacks", () => {
    const snapshot = v3Snapshot();
    snapshot.messages[0].conversationId = OTHER_ID;

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects messages with no conversations at all", () => {
    const snapshot = v3Snapshot();
    const { conversations: _dropped, ...rest } = snapshot;

    expect(snapshotSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects two messages sharing an id", () => {
    const snapshot = v3Snapshot();
    snapshot.messages[1].id = MESSAGE_ID;

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects one sender appearing twice in a conversation", () => {
    const snapshot = v3Snapshot();
    snapshot.conversations[0].participants[1].senderName = "Ada";

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects two conversations sharing an id", () => {
    const snapshot = v3Snapshot();
    snapshot.conversations.push({ ...snapshot.conversations[0] });

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});

describe("version 2 snapshot schema", () => {
  it("accepts a full snapshot and keeps every new entity", () => {
    const parsed = snapshotSchema.parse(v2Snapshot());

    expect(parsed.version).toBe(2);
    expect(parsed.personProfiles).toHaveLength(1);
    expect(parsed.favours).toHaveLength(1);
    expect(parsed.appSettings).toHaveLength(1);
    expect(parsed.personProfiles?.[0].personId).toBe(PERSON_ID);
    expect(parsed.favours?.[0].direction).toBe("I_OWE_THEM");
    expect(parsed.appSettings?.[0].key).toBe("avatar.resolvers");
  });

  it("keeps contact provenance", () => {
    const contact = snapshotSchema.parse(v2Snapshot()).people[0].contacts[0];

    expect(contact.source).toBe("ASSISTANT");
    expect(contact.sourceUrl).toBe("https://example.test/ada");
    expect(contact.confidence).toBe("HIGH");
    expect(contact.verifiedAt).toEqual(new Date("2024-05-02T09:00:00.000Z"));
  });

  it("keeps the avatar columns and hands the bytes back unchanged", () => {
    const person = snapshotSchema.parse(v2Snapshot()).people[0];

    expect(person.avatarMime).toBe("image/webp");
    expect(person.avatarSource).toBe("RESOLVER");
    expect(person.avatarSourceUrl).toBe("https://github.com/ada.png?size=400");
    expect(person.avatarFetchedAt).toEqual(
      new Date("2024-05-01T09:00:00.000Z"),
    );
    expect(Array.from(decodeBytes(person.avatarImage ?? ""))).toEqual(
      Array.from(AVATAR_BYTES),
    );
  });

  it("reads an explicit null avatar as a picture the file says is absent", () => {
    const snapshot = v2Snapshot();
    snapshot.people[0].avatarImage = null as unknown as string;

    expect(snapshotSchema.parse(snapshot).people[0].avatarImage).toBeNull();
  });

  it("still parses, with the version 3 collections absent rather than empty", () => {
    const parsed = snapshotSchema.parse(v2Snapshot());

    expect(parsed.version).toBe(2);
    expect(parsed.conversations).toBeUndefined();
    expect(parsed.messages).toBeUndefined();
    expect(parsed.personProfiles).toHaveLength(1);
  });
});

describe("version 1 snapshots", () => {
  it("still parses", () => {
    const parsed = snapshotSchema.parse(v1Snapshot());

    expect(parsed.version).toBe(1);
    expect(parsed.people).toHaveLength(1);
    expect(parsed.links[0].stat?.eventCount).toBe(2);
  });

  it("leaves the later collections absent rather than empty", () => {
    const parsed = snapshotSchema.parse(v1Snapshot());

    expect(parsed.personProfiles).toBeUndefined();
    expect(parsed.favours).toBeUndefined();
    expect(parsed.appSettings).toBeUndefined();
    expect(parsed.conversations).toBeUndefined();
    expect(parsed.messages).toBeUndefined();
  });

  it("leaves the avatar and provenance columns absent, not null", () => {
    const person = snapshotSchema.parse(v1Snapshot()).people[0];

    expect(person.avatarImage).toBeUndefined();
    expect(person.avatarMime).toBeUndefined();
    expect(person.avatarSource).toBeUndefined();
    expect(person.avatarSourceUrl).toBeUndefined();
    expect(person.avatarFetchedAt).toBeUndefined();
    expect(person.contacts[0].source).toBeUndefined();
    expect(person.contacts[0].confidence).toBeUndefined();
    expect(person.contacts[0].verifiedAt).toBeUndefined();
  });
});

describe("malformed snapshots", () => {
  it("rejects an unknown version", () => {
    const snapshot = { ...v3Snapshot(), version: 4 };
    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects an object that is not a snapshot at all", () => {
    expect(snapshotSchema.safeParse({ hello: "there" }).success).toBe(false);
    expect(snapshotSchema.safeParse(null).success).toBe(false);
    expect(snapshotSchema.safeParse([]).success).toBe(false);
  });

  it("rejects avatar bytes that are not base64", () => {
    const snapshot = v2Snapshot();
    snapshot.people[0].avatarImage = "not base64!!";

    const result = snapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(false);
  });

  it("rejects an avatar past the size cap", () => {
    const snapshot = v2Snapshot();
    snapshot.people[0].avatarImage = "A".repeat(MAX_AVATAR_BASE64_LENGTH + 4);

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a favour with no direction", () => {
    const snapshot = v2Snapshot();
    snapshot.favours[0].direction = "MAYBE" as "I_OWE_THEM";

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects two sketches for the same person", () => {
    const snapshot = v2Snapshot();
    snapshot.personProfiles.push({
      ...snapshot.personProfiles[0],
      id: OTHER_ID,
    });

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects duplicate setting keys", () => {
    const snapshot = v2Snapshot();
    snapshot.appSettings.push({ ...snapshot.appSettings[0] });

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects more than one self", () => {
    const snapshot = v2Snapshot();
    snapshot.people.push({ ...snapshot.people[0], id: OTHER_ID });

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a person id that is not a uuid", () => {
    const snapshot = v2Snapshot();
    snapshot.people[0].id = "nope";

    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});

describe("summariseSnapshot", () => {
  it("counts the conversations and messages a version 3 file carries", () => {
    const summary = summariseSnapshot(v3Snapshot());

    expect(summary?.version).toBe(3);
    expect(summary?.conversations).toBe(1);
    expect(summary?.messages).toBe(2);
  });

  it("reports null for the chats a version 2 file cannot hold", () => {
    const summary = summariseSnapshot(v2Snapshot());

    expect(summary?.version).toBe(2);
    expect(summary?.conversations).toBeNull();
    expect(summary?.messages).toBeNull();
  });

  it("reports the version 2 collections and the avatar count", () => {
    const summary = summariseSnapshot(v2Snapshot());

    expect(summary).not.toBeNull();
    expect(summary?.version).toBe(2);
    expect(summary?.people).toBe(1);
    expect(summary?.personProfiles).toBe(1);
    expect(summary?.favours).toBe(1);
    expect(summary?.appSettings).toBe(1);
    expect(summary?.avatars).toBe(1);
  });

  it("reports null for what a version 1 file cannot hold", () => {
    const summary = summariseSnapshot(v1Snapshot());

    expect(summary?.version).toBe(1);
    expect(summary?.personProfiles).toBeNull();
    expect(summary?.favours).toBeNull();
    expect(summary?.appSettings).toBeNull();
    expect(summary?.avatars).toBeNull();
    expect(summary?.conversations).toBeNull();
    expect(summary?.messages).toBeNull();
  });

  it("counts only the people who actually carry a picture", () => {
    const snapshot = v2Snapshot();
    snapshot.people.push({
      ...snapshot.people[0],
      id: OTHER_ID,
      isSelf: false,
      avatarImage: null as unknown as string,
    });

    expect(summariseSnapshot(snapshot)?.avatars).toBe(1);
  });

  it("refuses a file from a version this build cannot read", () => {
    expect(summariseSnapshot({ ...v3Snapshot(), version: 4 })).toBeNull();
    expect(summariseSnapshot("nope")).toBeNull();
  });
});
