-- How long an occasion lasted, in days, so a two week stay can count for more
-- than a coffee. Every existing occasion keeps 1.
--
-- The table is rebuilt, so the type CHECK the init migration put on it is
-- written out again here: the enum injector only recognises CREATE TABLE
-- "Event", not the "new_Event" a rebuild goes through.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'HANGOUT',
    "occurredAt" DATETIME NOT NULL,
    "location" TEXT,
    "description" JSONB,
    "sentiment" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "durationDays" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Event_type_check" CHECK ("type" IN ('HANGOUT', 'MEAL', 'CALL', 'TRIP', 'PARTY', 'WORK', 'FAVOUR', 'CONFLICT', 'MILESTONE', 'OTHER')),
    CONSTRAINT "Event_durationDays_check" CHECK ("durationDays" BETWEEN 1 AND 365)
);
INSERT INTO "new_Event" ("createdAt", "description", "id", "location", "occurredAt", "sentiment", "title", "type", "updatedAt", "weight") SELECT "createdAt", "description", "id", "location", "occurredAt", "sentiment", "title", "type", "updatedAt", "weight" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE INDEX "Event_occurredAt_idx" ON "Event"("occurredAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
