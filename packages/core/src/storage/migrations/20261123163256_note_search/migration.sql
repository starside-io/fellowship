-- AlterTable
ALTER TABLE "Note" ADD COLUMN "searchText" TEXT;



-- The plain text of every note already here, pulled out of the Tiptap document
-- with json_tree. A document is a tree of nodes and the strings all sit under
-- a "text" key, so SQLite can do this one without help from the application.
UPDATE "Note"
SET "searchText" = (
  SELECT group_concat("value", char(10))
  FROM json_tree("Note"."body")
  WHERE "key" = 'text' AND "type" = 'text'
);

-- note_fts stops being a standalone table maintained by hand.
--
-- It was the one search table core had to write to itself, which meant a note
-- deleted by a cascade left its index row behind, and nothing would have
-- noticed until a search returned a person who no longer exists. Indexing the
-- column instead puts it under the same triggers as the other two.
DROP TABLE IF EXISTS "note_fts";

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

-- Builds the index from the column that was just filled in.
INSERT INTO "note_fts"("note_fts") VALUES ('rebuild');
