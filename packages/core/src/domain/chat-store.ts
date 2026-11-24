// Storing a parsed chat export, and binding a sender to a person afterwards.
//
// The parser is pure and lives in @fellowship/connector-chat-export. This is
// the half that touches the silo: one transaction for the whole import,
// messages in batches, and a re-import of the same chat rewrites it rather
// than duplicating it.

import type { z } from "zod";

import type { importChatSchema } from "../schemas/conversation.js";
import type { Silo } from "../storage/client.js";
import { DEFAULT_CONFIG } from "../config/index.js";
import { parseWhatsAppExport } from "@fellowship/connector-chat-export";

type ImportChatData = z.output<typeof importChatSchema>;

const IMPORT_TIMEOUT_MS = 120_000;

export interface ImportedParticipant {
  senderName: string;
  personId: string | null;
  /** The mapped person's name, null while the sender is unclaimed. */
  displayName: string | null;
  isSelf: boolean;
  messageCount: number;
  person: { id: string; displayName: string } | null;
}

export interface ImportedConversation {
  id: string;
  source: string;
  title: string | null;
  isGroup: boolean;
  fileName: string | null;
  importedAt: string;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  participants: ImportedParticipant[];
}

export interface ImportChatSuccess {
  ok: true;
  /** True when an existing conversation was rewritten rather than one added. */
  replaced: boolean;
  conversation: ImportedConversation;
  participants: ImportedParticipant[];
  /** Senders with no person behind them yet, busiest first. */
  unmappedSenders: { senderName: string; messageCount: number }[];
  /** What the parser understood, so a caller can sanity check the dates. */
  parse: {
    style: string;
    clock: string;
    dayFirst: boolean;
    dateOrderAmbiguous: boolean;
    dateOrderReason: string;
    ownerName: string | null;
    ownerCandidates: string[];
    humanMessages: number;
    systemMessages: number;
    warnings: string[];
  };
}

/** Bad input, not a broken server: the export could not be read as a chat. */
export interface ImportChatFailure {
  ok: false;
  error: string;
  code: string;
  line: number | null;
  sample: string | null;
  issues: string[];
}

export type ImportChatResult = ImportChatSuccess | ImportChatFailure;

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    out.push(rows.slice(index, index + size));
  }
  return out;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Parses an export and stores it whole: the conversation, its senders, and
 * every message, in one transaction.
 *
 * Re-importing the same chat rewrites it rather than duplicating it. A
 * conversation is recognised by its content, not by its file name: the set of
 * sender names plus the timestamp of the first message. An export extended
 * with newer messages therefore replaces the old one, and mappings already
 * made by hand are carried across.
 */
export async function importChatExport(
  db: Silo,
  data: ImportChatData,
  options: { messageChunk?: number } = {},
): Promise<ImportChatResult> {
  const messageChunk = options.messageChunk ?? DEFAULT_CONFIG.messageChunk;

  const result = parseWhatsAppExport(data.text, {
    ...(data.selfName ? { selfName: data.selfName } : {}),
    ...(data.dayFirst === undefined ? {} : { dayFirst: data.dayFirst }),
  });

  const warnings = result.warnings.map((warning) => warning.message);

  if (!result.ok) {
    return {
      ok: false,
      error: result.error.message,
      code: result.error.code,
      line: result.error.line,
      sample: result.error.sample,
      issues: warnings,
    };
  }

  const parsed = result.conversation;

  // Notices carrying no sender are stored under an empty name: they are part of
  // the record but belong to nobody, so they never become a participant.
  const messages = parsed.messages
    .map((message) => ({
      sentAt: message.sentAt,
      senderName: message.senderName?.trim() ?? "",
      body: message.body,
      isSystem: message.isSystem,
    }))
    .filter((message) => !Number.isNaN(message.sentAt.getTime()))
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  if (messages.length === 0) {
    return {
      ok: false,
      error: "No messages were found in that export",
      code: "no-valid-messages",
      line: null,
      sample: null,
      issues: warnings,
    };
  }

  const firstMessageAt = messages[0].sentAt;
  const lastMessageAt = messages[messages.length - 1].sentAt;

  // Counts are taken from the rows about to be stored, so the summary can never
  // drift from what is actually in the table.
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.senderName.length === 0) continue;
    counts.set(message.senderName, (counts.get(message.senderName) ?? 0) + 1);
  }

  for (const entry of parsed.participants) {
    const name = entry.senderName.trim();
    if (name.length === 0) continue;
    if (!counts.has(name)) counts.set(name, entry.messageCount);
  }

  const senderNames = [...counts.keys()];
  if (senderNames.length === 0) {
    return {
      ok: false,
      error: "No senders were found in that export",
      code: "no-valid-messages",
      line: null,
      sample: null,
      issues: warnings,
    };
  }

  const selfPerson = await db.person.findFirst({
    where: { isSelf: true },
    select: { id: true, displayName: true },
  });

  // The parser only marks an owner when it was told one. Falling back to the
  // owner's own display name keeps a plain import from having no side of "you".
  const selfFlags = new Set(
    parsed.participants
      .filter((entry) => entry.isSelf)
      .map((entry) => lower(entry.senderName)),
  );
  const declaredSelf = data.selfName ? lower(data.selfName) : null;
  const ownName = selfPerson ? lower(selfPerson.displayName) : null;

  const isSelfSender = (senderName: string): boolean => {
    const key = lower(senderName);
    if (selfFlags.has(key)) return true;
    if (declaredSelf && key === declaredSelf) return true;
    if (ownName && key === ownName) return true;
    return false;
  };

  const requestedMapping = new Map<string, string>();
  for (const [senderName, personId] of Object.entries(data.personIdBySender ?? {})) {
    requestedMapping.set(lower(senderName), personId);
  }

  const requestedIds = [...new Set(requestedMapping.values())];
  if (requestedIds.length > 0) {
    const found = await db.person.findMany({
      where: { id: { in: requestedIds } },
      select: { id: true },
    });
    const known = new Set(found.map((person) => person.id));
    const missing = requestedIds.filter((personId) => !known.has(personId));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `No person exists with id ${missing.join(", ")}`,
        code: "unknown-person",
        line: null,
        sample: null,
        issues: warnings,
      };
    }
  }

  const isGroup = parsed.isGroup;

  const stored = await db.$transaction(
    async (tx) => {
      const sameStart = await tx.conversation.findMany({
        where: { firstMessageAt },
        select: {
          id: true,
          participants: {
            select: { senderName: true, personId: true, isSelf: true },
          },
        },
      });

      const wanted = new Set(senderNames.map(lower));
      const existing = sameStart.find((conversation) => {
        const have = new Set(
          conversation.participants.map((participant) => lower(participant.senderName)),
        );
        if (have.size !== wanted.size) return false;
        for (const name of wanted) if (!have.has(name)) return false;
        return true;
      });

      const carried = new Map<string, string>();
      if (existing) {
        for (const participant of existing.participants) {
          if (participant.personId) {
            carried.set(lower(participant.senderName), participant.personId);
          }
        }
      }

      const participantRows = senderNames.map((senderName) => {
        const key = lower(senderName);
        const named = isSelfSender(senderName);
        const personId =
          requestedMapping.get(key) ??
          carried.get(key) ??
          (named ? (selfPerson?.id ?? null) : null);

        // A sender mapped to the owner's own record is the owner, whatever
        // name the export gives them. Matching on the name alone missed an
        // export that calls the owner "M" while the record says "Me": a
        // re-import carried the mapping across but counted every one of the
        // owner's messages as the other person's, which turned volume,
        // initiation, latency and last word inside out. An explicit mapping
        // wins over the name, so a sender mapped to someone else is not self.
        const self = personId !== null ? personId === (selfPerson?.id ?? null) : named;

        return {
          senderName,
          personId,
          isSelf: self,
          messageCount: counts.get(senderName) ?? 0,
        };
      });

      // Chosen after the mappings are known, for the same reason: a one to
      // one chat is titled after the other person, never after the owner.
      const title = isGroup
        ? null
        : (participantRows.find((row) => !row.isSelf)?.senderName ?? senderNames[0] ?? null);

      const personBySender = new Map(
        participantRows.map((row) => [lower(row.senderName), row.personId]),
      );
      const selfBySender = new Map(
        participantRows.map((row) => [lower(row.senderName), row.isSelf]),
      );

      const conversationData = {
        source: data.source,
        title,
        isGroup,
        fileName: data.fileName ?? null,
        importedAt: new Date(),
        firstMessageAt,
        lastMessageAt,
        messageCount: messages.length,
      };

      let conversationId: string;
      if (existing) {
        await tx.message.deleteMany({ where: { conversationId: existing.id } });
        await tx.conversationParticipant.deleteMany({
          where: { conversationId: existing.id },
        });
        await tx.conversation.update({
          where: { id: existing.id },
          data: conversationData,
        });
        conversationId = existing.id;
      } else {
        const created = await tx.conversation.create({
          data: conversationData,
          select: { id: true },
        });
        conversationId = created.id;
      }

      await tx.conversationParticipant.createMany({
        data: participantRows.map((row) => ({ ...row, conversationId })),
      });

      const messageRows = messages.map((message) => ({
        conversationId,
        senderName: message.senderName,
        personId: personBySender.get(lower(message.senderName)) ?? null,
        sentAt: message.sentAt,
        body: message.body,
        isFromSelf: selfBySender.get(lower(message.senderName)) ?? false,
        isSystem: message.isSystem,
      }));

      for (const batch of chunk(messageRows, messageChunk)) {
        await tx.message.createMany({ data: batch });
      }

      return {
        conversationId,
        replaced: Boolean(existing),
        participantRows,
        conversationData,
      };
    },
    { timeout: IMPORT_TIMEOUT_MS, maxWait: 10_000 },
  );

  const people = await db.person.findMany({
    where: {
      id: {
        in: [
          ...new Set(
            stored.participantRows
              .map((row) => row.personId)
              .filter((personId): personId is string => Boolean(personId)),
          ),
        ],
      },
    },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(people.map((person) => [person.id, person.displayName]));

  const participants: ImportedParticipant[] = stored.participantRows
    .map((row) => ({
      senderName: row.senderName,
      personId: row.personId,
      displayName: row.personId ? (nameById.get(row.personId) ?? null) : null,
      isSelf: row.isSelf,
      messageCount: row.messageCount,
      person: row.personId
        ? { id: row.personId, displayName: nameById.get(row.personId) ?? "" }
        : null,
    }))
    .sort((a, b) => b.messageCount - a.messageCount);

  const conversation: ImportedConversation = {
    id: stored.conversationId,
    source: stored.conversationData.source,
    title: stored.conversationData.title,
    isGroup: stored.conversationData.isGroup,
    fileName: stored.conversationData.fileName,
    importedAt: stored.conversationData.importedAt.toISOString(),
    firstMessageAt: iso(firstMessageAt),
    lastMessageAt: iso(lastMessageAt),
    messageCount: messages.length,
    participants,
  };

  return {
    ok: true,
    replaced: stored.replaced,
    conversation,
    participants,
    unmappedSenders: participants
      .filter((participant) => participant.personId === null)
      .map((participant) => ({
        senderName: participant.senderName,
        messageCount: participant.messageCount,
      })),
    parse: {
      style: parsed.format.style,
      clock: parsed.format.clock,
      dayFirst: parsed.dateOrder.dayFirst,
      dateOrderAmbiguous: parsed.dateOrder.ambiguous,
      dateOrderReason: parsed.dateOrder.reason,
      ownerName: parsed.ownerName,
      ownerCandidates: parsed.ownerCandidates,
      humanMessages: messages.filter((message) => !message.isSystem).length,
      systemMessages: messages.filter((message) => message.isSystem).length,
      warnings,
    },
  };
}

export interface MapSenderResult {
  conversationId: string;
  senderName: string;
  personId: string;
  displayName: string;
  /** Messages that now point at that person. */
  messagesUpdated: number;
}

/**
 * Binds a sender to a person after the fact. The sender's messages are
 * backfilled in one statement rather than row by row.
 */
export async function mapChatSender(
  db: Silo,
  conversationId: string,
  senderName: string,
  personId: string,
): Promise<MapSenderResult | null> {
  const chatId = conversationId;
  const input = { senderName, personId };

  const result = await db.$transaction(async (tx) => {
    const participant = await tx.conversationParticipant.findUnique({
      where: {
        conversationId_senderName: {
          conversationId: chatId,
          senderName: input.senderName,
        },
      },
      select: { senderName: true },
    });
    if (!participant) return null;

    const person = await tx.person.findUnique({
      where: { id: input.personId },
      select: { id: true, displayName: true, isSelf: true },
    });
    if (!person) return null;

    // Mapping a sender to the owner's record makes them the owner, and
    // mapping them to anyone else makes them not, so the messages say who
    // sent them the same way the import does.
    await tx.conversationParticipant.update({
      where: {
        conversationId_senderName: {
          conversationId: chatId,
          senderName: input.senderName,
        },
      },
      data: { personId: person.id, isSelf: person.isSelf },
    });

    const updated = await tx.message.updateMany({
      where: { conversationId: chatId, senderName: input.senderName },
      data: { personId: person.id, isFromSelf: person.isSelf },
    });

    return {
      conversationId: chatId,
      senderName: input.senderName,
      personId: person.id,
      displayName: person.displayName,
      messagesUpdated: updated.count,
    };
  });

  return result;
}

