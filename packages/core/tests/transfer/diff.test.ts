import { describe, expect, it } from "vitest";

import { diffSnapshots, formatDiff } from "../../src/domain/transfer/diff.js";
import type { ExportSnapshot } from "../../src/domain/transfer/snapshot.js";

/**
 * The comparison itself. If this is wrong, a clean round trip report means
 * nothing, so it gets its own tests rather than being trusted because the real
 * file happened to pass.
 */

const PERSON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const TAG = "44444444-4444-4444-8444-444444444444";
const EVENT = "55555555-5555-4555-8555-555555555555";

function snapshot(overrides: Partial<ExportSnapshot> = {}): ExportSnapshot {
  return {
    version: 3,
    exportedAt: "2026-07-31T12:00:00.000Z",
    people: [
      {
        id: PERSON,
        displayName: "Sam Rivera",
        firstName: "Sam",
        lastName: "Rivera",
        isSelf: false,
        avatarColor: "#ef4444",
        avatarImage: null,
        avatarMime: null,
        avatarSource: null,
        avatarSourceUrl: null,
        avatarFetchedAt: null,
        birthday: null,
        location: "Lisbon",
        howWeMet: null,
        metOn: null,
        commStyle: ["voice notes", "long replies"],
        archived: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        circleIds: [],
        interestIds: [TAG],
        allergyIds: [],
        dislikeIds: [],
        contacts: [
          {
            id: CONTACT,
            kind: "SOCIAL",
            platform: "github",
            value: "sam",
            url: null,
            isPrimary: true,
            label: null,
            source: "ASSISTANT",
            sourceUrl: "https://github.com/sam",
            confidence: "HIGH",
            verifiedAt: null,
          },
        ],
        customValues: [],
      },
    ],
    tags: [{ id: TAG, kind: "INTEREST", name: "ramen", colour: "#10b981" }],
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
        durationDays: 1,
        createdAt: "2026-06-02T12:00:00.000Z",
        updatedAt: "2026-06-02T12:00:00.000Z",
        participants: [{ personId: PERSON, role: null, sentiment: 1 }],
      },
    ],
    links: [],
    personProfiles: [],
    favours: [],
    appSettings: [],
    conversations: [],
    messages: [],
    ...overrides,
  };
}

describe("diffSnapshots", () => {
  it("calls an unchanged pair identical, whatever order the rows are in", () => {
    const before = snapshot();
    const after = snapshot({ tags: [...snapshot().tags].reverse() });
    const diff = diffSnapshots(before, after);

    expect(diff.identical).toBe(true);
    expect(diff.problems).toEqual([]);
  });

  it("ignores the export timestamp, which is never the same twice", () => {
    const diff = diffSnapshots(
      snapshot(),
      snapshot({ exportedAt: "2026-08-01T00:00:00.000Z" }),
    );
    expect(diff.identical).toBe(true);
  });

  it("compares id arrays as sets", () => {
    const before = snapshot();
    const after = snapshot();
    after.people[0]!.commStyle = ["long replies", "voice notes"];
    expect(diffSnapshots(before, after).identical).toBe(true);

    after.people[0]!.commStyle = ["voice notes"];
    expect(diffSnapshots(before, after).identical).toBe(false);
  });

  it("names a row that did not come back", () => {
    const diff = diffSnapshots(snapshot(), snapshot({ tags: [] }));
    const tags = diff.collections.find((entry) => entry.collection === "tags");

    expect(tags?.missing).toEqual([TAG]);
    expect(tags?.before).toBe(1);
    expect(tags?.after).toBe(0);
    expect(diff.identical).toBe(false);
  });

  it("names a row that appeared", () => {
    const after = snapshot();
    after.tags.push({ id: OTHER, kind: "DISLIKE", name: "queues", colour: "#64748b" });

    const diff = diffSnapshots(snapshot(), after);
    expect(diff.collections.find((entry) => entry.collection === "tags")?.extra).toEqual([OTHER]);
  });

  it("names the field that changed, with both values", () => {
    const after = snapshot();
    after.people[0]!.location = "Porto";

    const diff = diffSnapshots(snapshot(), after);
    const people = diff.collections.find((entry) => entry.collection === "people");

    expect(people?.changed).toEqual([
      { key: PERSON, fields: [{ path: "location", before: "Lisbon", after: "Porto" }] },
    ]);
  });

  it("reaches into a nested contact, which is where provenance hides", () => {
    const after = snapshot();
    after.people[0]!.contacts[0]!.sourceUrl = null;

    const diff = diffSnapshots(snapshot(), after);
    const people = diff.collections.find((entry) => entry.collection === "people");

    expect(people?.changed[0]?.fields[0]?.path).toBe(`contacts.${CONTACT}.sourceUrl`);
  });

  it("notices a dropped event participant", () => {
    const after = snapshot();
    after.events[0]!.participants = [];

    const diff = diffSnapshots(snapshot(), after);
    const events = diff.collections.find((entry) => entry.collection === "events");
    expect(events?.changed[0]?.fields[0]?.path).toBe(`participants.${PERSON}`);
  });

  it("can be told a collection is not expected to survive", () => {
    const before = snapshot({
      appSettings: [{ key: "avatar.resolvers", value: [], updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const after = snapshot({ appSettings: [] });

    const diff = diffSnapshots(before, after, { ignore: ["appSettings"] });
    const settings = diff.collections.find((entry) => entry.collection === "appSettings");

    expect(settings?.missing).toEqual([]);
    expect(settings?.before).toBe(1);
    expect(settings?.after).toBe(0);
    // The count still moved, so it is still reported, just not as missing rows.
    expect(diff.identical).toBe(false);
  });

  it("prints a report a person can read", () => {
    const report = formatDiff(diffSnapshots(snapshot(), snapshot({ tags: [] })));
    expect(report).toContain("tags");
    expect(report).toContain("1 missing");
    expect(report).toContain(`tags ${TAG} is gone`);
  });
});
