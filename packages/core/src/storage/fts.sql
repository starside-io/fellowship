-- FTS5 search tables. Prisma cannot model a virtual table, so these live in
-- raw SQL, are created by a raw migration, and are queried with $queryRaw.
--
-- The tokenizer strips diacritics, which is the point: SQLite's LIKE is
-- case-insensitive for ASCII only, so `contains` silently stops working on
-- accented names. "Helene" matches "Hélène" here.
--
-- All three are external content tables: they index rows that live in Person,
-- Message and Note and store no copy of the text, kept in step by triggers.
--
-- Note is the awkward one, since its body is a Tiptap document and no trigger
-- can walk a tree. It carries a searchText column instead, which core fills in
-- on every write, and the trigger indexes that. note_fts started out as a
-- standalone table that core wrote to by hand, which meant a note removed by a
-- cascade left its index row behind: see the note_search migration.

-- Person -------------------------------------------------------------------

CREATE VIRTUAL TABLE "person_fts" USING fts5(
  "displayName",
  "firstName",
  "lastName",
  content = 'Person',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER "person_fts_ai" AFTER INSERT ON "Person" BEGIN
  INSERT INTO "person_fts"("rowid", "displayName", "firstName", "lastName")
  VALUES (new."rowid", new."displayName", new."firstName", new."lastName");
END;

CREATE TRIGGER "person_fts_ad" AFTER DELETE ON "Person" BEGIN
  INSERT INTO "person_fts"("person_fts", "rowid", "displayName", "firstName", "lastName")
  VALUES ('delete', old."rowid", old."displayName", old."firstName", old."lastName");
END;

CREATE TRIGGER "person_fts_au" AFTER UPDATE ON "Person" BEGIN
  INSERT INTO "person_fts"("person_fts", "rowid", "displayName", "firstName", "lastName")
  VALUES ('delete', old."rowid", old."displayName", old."firstName", old."lastName");
  INSERT INTO "person_fts"("rowid", "displayName", "firstName", "lastName")
  VALUES (new."rowid", new."displayName", new."firstName", new."lastName");
END;

-- Message ------------------------------------------------------------------

CREATE VIRTUAL TABLE "message_fts" USING fts5(
  "body",
  content = 'Message',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER "message_fts_ai" AFTER INSERT ON "Message" BEGIN
  INSERT INTO "message_fts"("rowid", "body") VALUES (new."rowid", new."body");
END;

CREATE TRIGGER "message_fts_ad" AFTER DELETE ON "Message" BEGIN
  INSERT INTO "message_fts"("message_fts", "rowid", "body")
  VALUES ('delete', old."rowid", old."body");
END;

CREATE TRIGGER "message_fts_au" AFTER UPDATE ON "Message" BEGIN
  INSERT INTO "message_fts"("message_fts", "rowid", "body")
  VALUES ('delete', old."rowid", old."body");
  INSERT INTO "message_fts"("rowid", "body") VALUES (new."rowid", new."body");
END;

-- Note ---------------------------------------------------------------------

CREATE VIRTUAL TABLE "note_fts" USING fts5(
  "searchText",
  content = 'Note',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER "note_fts_ai" AFTER INSERT ON "Note" BEGIN
  INSERT INTO "note_fts"("rowid", "searchText") VALUES (new."rowid", new."searchText");
END;

CREATE TRIGGER "note_fts_ad" AFTER DELETE ON "Note" BEGIN
  INSERT INTO "note_fts"("note_fts", "rowid", "searchText")
  VALUES ('delete', old."rowid", old."searchText");
END;

CREATE TRIGGER "note_fts_au" AFTER UPDATE ON "Note" BEGIN
  INSERT INTO "note_fts"("note_fts", "rowid", "searchText")
  VALUES ('delete', old."rowid", old."searchText");
  INSERT INTO "note_fts"("rowid", "searchText") VALUES (new."rowid", new."searchText");
END;
