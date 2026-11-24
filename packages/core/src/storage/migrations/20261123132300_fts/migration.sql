-- FTS5 search tables, triggers included. This is a copy of
-- src/storage/fts.sql, which is the readable source of truth for the search
-- layer. A migration is a frozen record of what was applied, so the two are
-- edited together: change fts.sql and add a new migration, never rewrite this
-- one.

-- FTS5 search tables. Prisma cannot model a virtual table, so these live in
-- raw SQL, are created by a raw migration, and are queried with $queryRaw.
--
-- The tokenizer strips diacritics, which is the point: SQLite's LIKE is
-- case-insensitive for ASCII only, so `contains` silently stops working on
-- accented names. "Mederic" matches "Médéric" here.
--
-- person_fts and message_fts are external content tables: they index rows that
-- live in Person and Message and store no copy of the text, kept in step by
-- triggers. note_fts is standalone because Note.body is a Tiptap document and
-- extracting its plain text is application work, not something a trigger can
-- do. Core writes note_fts whenever it writes a note.

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

-- Standalone, keyed by note id rather than rowid, because core writes it from
-- the plain text it extracts out of the Tiptap document.
CREATE VIRTUAL TABLE "note_fts" USING fts5(
  "noteId" UNINDEXED,
  "body",
  tokenize = "unicode61 remove_diacritics 2"
);
