-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "isSelf" BOOLEAN NOT NULL DEFAULT false,
    "avatarColor" TEXT NOT NULL,
    "birthday" DATETIME,
    "location" TEXT,
    "howWeMet" TEXT,
    "metOn" DATETIME,
    "commStyle" JSONB NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PersonAvatar" (
    "personId" TEXT NOT NULL PRIMARY KEY,
    "image" BLOB NOT NULL,
    "mime" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "fetchedAt" DATETIME NOT NULL,
    CONSTRAINT "PersonAvatar_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PersonAvatar_source_check" CHECK ("source" IN ('MANUAL', 'RESOLVER', 'ASSISTANT'))
);

-- CreateTable
CREATE TABLE "ContactChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "platform" TEXT,
    "value" TEXT NOT NULL,
    "url" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceUrl" TEXT,
    "confidence" TEXT,
    "verifiedAt" DATETIME,
    CONSTRAINT "ContactChannel_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContactChannel_kind_check" CHECK ("kind" IN ('EMAIL', 'PHONE', 'SOCIAL', 'OTHER')),
    CONSTRAINT "ContactChannel_source_check" CHECK ("source" IN ('MANUAL', 'IMPORT', 'ASSISTANT')),
    CONSTRAINT "ContactChannel_confidence_check" CHECK ("confidence" IS NULL OR "confidence" IN ('HIGH', 'MEDIUM', 'LOW'))
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    CONSTRAINT "Tag_kind_check" CHECK ("kind" IN ('INTEREST', 'ALLERGY', 'DISLIKE'))
);

-- CreateTable
CREATE TABLE "Circle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "FieldDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'STANDARD',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "FieldDefinition_type_check" CHECK ("type" IN ('TEXT', 'LONGTEXT', 'DATE', 'NUMBER', 'URL', 'TAGS', 'SELECT', 'BOOLEAN')),
    CONSTRAINT "FieldDefinition_scope_check" CHECK ("scope" IN ('STANDARD', 'CUSTOM'))
);

-- CreateTable
CREATE TABLE "CustomValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personId" TEXT NOT NULL,
    "fieldDefinitionId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    CONSTRAINT "CustomValue_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CustomValue_fieldDefinitionId_fkey" FOREIGN KEY ("fieldDefinitionId") REFERENCES "FieldDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personId" TEXT,
    "eventId" TEXT,
    "body" JSONB NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Note_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Note_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'HANGOUT',
    "occurredAt" DATETIME NOT NULL,
    "location" TEXT,
    "description" JSONB,
    "sentiment" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Event_type_check" CHECK ("type" IN ('HANGOUT', 'MEAL', 'CALL', 'TRIP', 'PARTY', 'WORK', 'FAVOUR', 'CONFLICT', 'MILESTONE', 'OTHER'))
);

-- CreateTable
CREATE TABLE "EventParticipant" (
    "eventId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" TEXT,
    "sentiment" INTEGER,

    PRIMARY KEY ("eventId", "personId"),
    CONSTRAINT "EventParticipant_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EventParticipant_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Link" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "aPersonId" TEXT NOT NULL,
    "bPersonId" TEXT NOT NULL,
    "tie" TEXT NOT NULL DEFAULT 'ACQUAINTANCE',
    "manualScore" REAL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    CONSTRAINT "Link_aPersonId_fkey" FOREIGN KEY ("aPersonId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Link_bPersonId_fkey" FOREIGN KEY ("bPersonId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Link_tie_check" CHECK ("tie" IN ('FRIEND', 'CLOSE_FRIEND', 'PARTNER', 'FAMILY', 'COLLEAGUE', 'ACQUAINTANCE', 'KNOWS_OF', 'ESTRANGED'))
);

-- CreateTable
CREATE TABLE "LinkStat" (
    "linkId" TEXT NOT NULL PRIMARY KEY,
    "score" REAL NOT NULL DEFAULT 0,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "lastEventAt" DATETIME,
    "positiveCount" INTEGER NOT NULL DEFAULT 0,
    "negativeCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "LinkStat_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "Link" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "title" TEXT,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstMessageAt" DATETIME,
    "lastMessageAt" DATETIME,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Conversation_source_check" CHECK ("source" IN ('WHATSAPP', 'OTHER'))
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "conversationId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "personId" TEXT,
    "isSelf" BOOLEAN NOT NULL DEFAULT false,
    "messageCount" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("conversationId", "senderName"),
    CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationParticipant_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "personId" TEXT,
    "sentAt" DATETIME NOT NULL,
    "body" TEXT NOT NULL,
    "isFromSelf" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PersonProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personId" TEXT NOT NULL,
    "summary" TEXT,
    "whatLands" TEXT,
    "whatToAvoid" TEXT,
    "opener" TEXT,
    "traits" JSONB,
    "sources" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "generatedAt" DATETIME,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PersonProfile_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PersonProfile_source_check" CHECK ("source" IN ('MANUAL', 'ASSISTANT'))
);

-- CreateTable
CREATE TABLE "Favour" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "settledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Favour_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Favour_direction_check" CHECK ("direction" IN ('THEY_OWE_ME', 'I_OWE_THEM'))
);

-- CreateTable
CREATE TABLE "_PersonInterests" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_PersonInterests_A_fkey" FOREIGN KEY ("A") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_PersonInterests_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_PersonAllergies" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_PersonAllergies_A_fkey" FOREIGN KEY ("A") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_PersonAllergies_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_PersonDislikes" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_PersonDislikes_A_fkey" FOREIGN KEY ("A") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_PersonDislikes_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_CircleToPerson" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_CircleToPerson_A_fkey" FOREIGN KEY ("A") REFERENCES "Circle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_CircleToPerson_B_fkey" FOREIGN KEY ("B") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_NoteTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_NoteTags_A_fkey" FOREIGN KEY ("A") REFERENCES "Note" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_NoteTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Person_displayName_idx" ON "Person"("displayName");

-- CreateIndex
CREATE INDEX "Person_archived_idx" ON "Person"("archived");

-- CreateIndex
CREATE INDEX "ContactChannel_personId_idx" ON "ContactChannel"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_kind_name_key" ON "Tag"("kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Circle_name_key" ON "Circle"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FieldDefinition_key_key" ON "FieldDefinition"("key");

-- CreateIndex
CREATE INDEX "CustomValue_fieldDefinitionId_idx" ON "CustomValue"("fieldDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomValue_personId_fieldDefinitionId_key" ON "CustomValue"("personId", "fieldDefinitionId");

-- CreateIndex
CREATE INDEX "Note_personId_idx" ON "Note"("personId");

-- CreateIndex
CREATE INDEX "Note_eventId_idx" ON "Note"("eventId");

-- CreateIndex
CREATE INDEX "Note_occurredAt_idx" ON "Note"("occurredAt");

-- CreateIndex
CREATE INDEX "Event_occurredAt_idx" ON "Event"("occurredAt");

-- CreateIndex
CREATE INDEX "EventParticipant_personId_idx" ON "EventParticipant"("personId");

-- CreateIndex
CREATE INDEX "Link_bPersonId_idx" ON "Link"("bPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "Link_aPersonId_bPersonId_key" ON "Link"("aPersonId", "bPersonId");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "ConversationParticipant_personId_idx" ON "ConversationParticipant"("personId");

-- CreateIndex
CREATE INDEX "Message_conversationId_sentAt_idx" ON "Message"("conversationId", "sentAt");

-- CreateIndex
CREATE INDEX "Message_personId_sentAt_idx" ON "Message"("personId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonProfile_personId_key" ON "PersonProfile"("personId");

-- CreateIndex
CREATE INDEX "Favour_personId_idx" ON "Favour"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "_PersonInterests_AB_unique" ON "_PersonInterests"("A", "B");

-- CreateIndex
CREATE INDEX "_PersonInterests_B_index" ON "_PersonInterests"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_PersonAllergies_AB_unique" ON "_PersonAllergies"("A", "B");

-- CreateIndex
CREATE INDEX "_PersonAllergies_B_index" ON "_PersonAllergies"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_PersonDislikes_AB_unique" ON "_PersonDislikes"("A", "B");

-- CreateIndex
CREATE INDEX "_PersonDislikes_B_index" ON "_PersonDislikes"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_CircleToPerson_AB_unique" ON "_CircleToPerson"("A", "B");

-- CreateIndex
CREATE INDEX "_CircleToPerson_B_index" ON "_CircleToPerson"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_NoteTags_AB_unique" ON "_NoteTags"("A", "B");

-- CreateIndex
CREATE INDEX "_NoteTags_B_index" ON "_NoteTags"("B");
