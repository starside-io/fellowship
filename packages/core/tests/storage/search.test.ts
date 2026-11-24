import { describe, expect, it } from "vitest";

import {
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  countMessageMatches,
  noteSearchText,
  rebuildSearchIndex,
  searchMessages,
  searchNotes,
  searchPeople,
  toMatchQuery,
} from "../../src/storage/search.js";
import { openSilo, type Silo } from "../../src/storage/client.js";
import { freshSiloPath } from "./throwaway.js";

/**
 * FTS5, and the reason it replaced `contains`: SQLite's LIKE is case
 * insensitive for ASCII only, so an accented name was findable only by typing
 * the accents, and 73,000 message bodies were not searchable at all.
 */

describe("toMatchQuery", () => {
  it("quotes every token and makes the last one a prefix", () => {
    expect(toMatchQuery("sam riv")?.expression).toBe('"sam" "riv"*');
    expect(toMatchQuery("ramen")?.expression).toBe('"ramen"*');
  });

  it("can be asked for whole words only", () => {
    expect(toMatchQuery("sam", { prefix: false })?.expression).toBe('"sam"');
  });

  it("treats the query language as words rather than obeying it", () => {
    // Each of these is an operator or a syntax error in raw FTS5.
    for (const raw of [
      "sam OR ada",
      "sam AND ada",
      "sam NOT ada",
      "sam NEAR ada",
      'say "hello"',
      "displayName:sam",
      "(sam",
      "sam*",
      "-sam",
      "^sam",
    ]) {
      const query = toMatchQuery(raw);
      expect(query, raw).not.toBeNull();
      // Nothing survives outside a quoted literal and a trailing star.
      expect(query!.expression.replace(/"[^"]*"\*?/g, "").trim(), raw).toBe("");
    }
  });

  it("keeps letters that are not ASCII", () => {
    expect(toMatchQuery("Hélène")?.tokens).toEqual(["Hélène"]);
    expect(toMatchQuery("ありがとう")?.tokens).toEqual(["ありがとう"]);
  });

  it("is null when there is nothing to search for", () => {
    for (const raw of ["", "   ", "!!!", "...", "-"]) {
      expect(toMatchQuery(raw), raw).toBeNull();
    }
  });
});

describe("noteSearchText", () => {
  it("reads the text out of a Tiptap document", () => {
    expect(
      noteSearchText({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "ramen at " },
              { type: "text", text: "Kanji", marks: [{ type: "bold" }] },
            ],
          },
        ],
      }),
      // The text is kept exactly as the document has it, trailing space and
      // all: trimming here would change what a snippet shows.
    ).toBe("ramen at \nKanji");
  });

  it("is empty for a document with nothing in it", () => {
    expect(noteSearchText({ type: "doc", content: [] })).toBe("");
    expect(noteSearchText(null)).toBe("");
  });
});

async function seeded(): Promise<Silo> {
  const db = await openSilo({ path: freshSiloPath() });

  await db.person.create({
    data: {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Hélène Dupré",
      firstName: "Hélène",
      lastName: "Dupré",
      avatarColor: "#6366f1",
      commStyle: [],
    },
  });
  await db.person.create({
    data: {
      id: "22222222-2222-4222-8222-222222222222",
      displayName: "Sam Rivera",
      avatarColor: "#ef4444",
      commStyle: [],
      archived: true,
    },
  });

  await db.note.create({
    data: {
      id: "33333333-3333-4333-8333-333333333333",
      personId: "11111111-1111-4111-8111-111111111111",
      body: { type: "doc", content: [] },
      searchText: "Allergic to peanuts, and will not say so at the table.",
    },
  });

  await db.conversation.create({
    data: { id: "44444444-4444-4444-8444-444444444444", messageCount: 3 },
  });
  await db.message.createMany({
    data: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        conversationId: "44444444-4444-4444-8444-444444444444",
        senderName: "Sam",
        personId: "22222222-2222-4222-8222-222222222222",
        sentAt: new Date("2026-05-01T08:00:00.000Z"),
        body: "the ramen place on Tuesday was perfect",
        isFromSelf: false,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        conversationId: "44444444-4444-4444-8444-444444444444",
        senderName: "Me",
        sentAt: new Date("2026-05-01T09:00:00.000Z"),
        body: "café after?",
        isFromSelf: true,
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        conversationId: "44444444-4444-4444-8444-444444444444",
        senderName: "Sam",
        sentAt: new Date("2026-05-01T10:00:00.000Z"),
        body: "joined using this group's invite link",
        isSystem: true,
      },
    ],
  });

  return db;
}

describe("searchPeople", () => {
  it("finds an accented name typed without the accents", async () => {
    const db = await seeded();
    try {
      const hits = await searchPeople(db, "helene");
      expect(hits.map((hit) => hit.displayName)).toEqual(["Hélène Dupré"]);

      // And the other way round, which LIKE could also not do.
      expect((await searchPeople(db, "Hélène")).length).toBe(1);
      expect((await searchPeople(db, "dupre")).length).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });

  it("matches a prefix, so results move while someone types", async () => {
    const db = await seeded();
    try {
      for (const typed of ["h", "he", "hel", "hele"]) {
        expect((await searchPeople(db, typed)).length, typed).toBe(1);
      }
    } finally {
      await db.$disconnect();
    }
  });

  it("leaves archived people out unless asked", async () => {
    const db = await seeded();
    try {
      expect(await searchPeople(db, "sam")).toEqual([]);
      expect((await searchPeople(db, "sam", { includeArchived: true })).length).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });

  it("returns nothing rather than throwing on a query made of punctuation", async () => {
    const db = await seeded();
    try {
      expect(await searchPeople(db, "!!!")).toEqual([]);
      expect(await searchPeople(db, 'sam" OR 1=1 --')).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });
});

describe("searchNotes", () => {
  it("finds a note by its text, and marks the hit", async () => {
    const db = await seeded();
    try {
      const hits = await searchNotes(db, "peanuts");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.snippet).toContain(`${SNIPPET_OPEN}peanuts${SNIPPET_CLOSE}`);
    } finally {
      await db.$disconnect();
    }
  });

  it("follows the note when it is deleted", async () => {
    const db = await seeded();
    try {
      await db.note.deleteMany();
      expect(await searchNotes(db, "peanuts")).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it("follows a cascade, which is the whole reason it indexes a column", async () => {
    const db = await seeded();
    try {
      await db.person.delete({ where: { id: "11111111-1111-4111-8111-111111111111" } });
      expect(await searchNotes(db, "peanuts")).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });
});

describe("searchMessages", () => {
  it("finds a body, with the hit marked", async () => {
    const db = await seeded();
    try {
      const hits = await searchMessages(db, "ramen");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.body).toContain("ramen place");
      expect(hits[0]!.snippet).toContain(SNIPPET_OPEN);
      expect(await countMessageMatches(db, "ramen")).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });

  it("folds the accents in a body too", async () => {
    const db = await seeded();
    try {
      expect((await searchMessages(db, "cafe")).length).toBe(1);
      expect((await searchMessages(db, "café")).length).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });

  it("leaves the join and leave notices out", async () => {
    const db = await seeded();
    try {
      expect(await searchMessages(db, "invite")).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it("scopes to a conversation set, and to one person's two sided stream", async () => {
    const db = await seeded();
    try {
      expect(
        await searchMessages(db, "ramen", { conversationIds: [] }),
      ).toEqual([]);

      const scoped = await searchMessages(db, "ramen", {
        conversationIds: ["44444444-4444-4444-8444-444444444444"],
        personId: "22222222-2222-4222-8222-222222222222",
      });
      expect(scoped).toHaveLength(1);

      // Someone else's id, so neither their messages nor the owner's match.
      expect(
        await searchMessages(db, "ramen", {
          personId: "11111111-1111-4111-8111-111111111111",
        }),
      ).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it("honours a date window", async () => {
    const db = await seeded();
    try {
      expect(
        (await searchMessages(db, "ramen", { from: new Date("2026-05-02T00:00:00.000Z") }))
          .length,
      ).toBe(0);
      expect(
        (await searchMessages(db, "ramen", { to: new Date("2026-05-02T00:00:00.000Z") }))
          .length,
      ).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });
});

describe("rebuildSearchIndex", () => {
  it("puts every index back from the rows it shadows", async () => {
    const db = await seeded();
    try {
      // Whatever state an index is in, a rebuild agrees with the tables again.
      await rebuildSearchIndex(db);

      expect((await searchPeople(db, "helene")).length).toBe(1);
      expect((await searchNotes(db, "peanuts")).length).toBe(1);
      expect((await searchMessages(db, "ramen")).length).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });
});
