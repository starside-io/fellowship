import { z } from "zod";

import type { Prisma } from "../../generated/prisma/index.js";
import type { AuditEntry } from "../ports.js";

import { buildResolverCandidates } from "../config/avatar-resolvers.js";
import { getPersonChatInsights } from "../domain/chat-insights.js";
import { getDashboardData } from "../domain/dashboard.js";
import { getGraphData } from "../domain/graph.js";
import { getPersonInsights } from "../domain/insights.js";
import { resolvePeopleByName } from "../domain/person-resolve.js";
import {
  evaluateCandidates,
  issueCheckToken,
  loadPersonChannels,
  platformCatalogue,
  publicResults,
  socialCandidateListSchema,
  summarise,
} from "../domain/socials-check.js";
import { buildExportSnapshot } from "../domain/transfer/export.js";
import { buildVCards, photoIsPortable, vcardFileName } from "../domain/vcard.js";
import { idSchema } from "../schemas/common.js";
import { PERSONALITY_AXES, parsePersonality } from "../schemas/personality.js";
import {
  countMessageMatches,
  searchMessages,
  searchNotes,
  searchPeople,
  toMatchQuery,
} from "../storage/search.js";
import { personMessagesSchema } from "../schemas/conversation.js";
import { defineTool, ToolError, type ToolDefinition } from "./registry.js";

/**
 * The read half of the tool surface. Nothing here writes, and nothing here
 * returns image bytes: a picture is served by the host's media route, never
 * through a tool response.
 */

const personIdInput = z.object({ personId: idSchema });
const nothing = z.object({}).default({});

/** Everything about a person except the bytes of their picture. */
const personDetailSelect = {
  id: true,
  displayName: true,
  firstName: true,
  lastName: true,
  isSelf: true,
  avatarColor: true,
  birthday: true,
  location: true,
  howWeMet: true,
  metOn: true,
  commStyle: true,
  mbti: true,
  archived: true,
  createdAt: true,
  updatedAt: true,
  contacts: { orderBy: [{ isPrimary: "desc" }, { kind: "asc" }] },
  circles: { orderBy: { name: "asc" } },
  interests: { orderBy: { name: "asc" } },
  allergies: { orderBy: { name: "asc" } },
  dislikes: { orderBy: { name: "asc" } },
  customValues: {
    include: { fieldDefinition: true },
    orderBy: { fieldDefinition: { order: "asc" } },
  },
  /**
   * The row without its image column: whether a picture exists and where it
   * came from, which is all a caller can act on. The bytes stay in the table.
   */
  avatar: {
    select: { mime: true, source: true, sourceUrl: true, fetchedAt: true },
  },
} satisfies Prisma.PersonSelect;

export const searchTool = defineTool({
  name: "people.search",
  title: "Search",
  kind: "read",
  summary:
    "Finds people, tags, circles, occasions, notes and message text. Run this before anything that takes a person id.",
  input: z.object({
    query: z.string().trim().min(1, "Expected something to search for"),
    limit: z.number().int().min(1).max(50).default(8),
    includeArchived: z.boolean().default(false),
    /** Message bodies are real text, so they are opt out rather than free. */
    includeMessages: z.boolean().default(true),
  }),
  async handler(ctx, input) {
    const term = input.query;
    const take = input.limit;

    // FTS5 over the names, which is what makes an accented name findable by
    // the way it is usually typed: SQLite's LIKE is case insensitive for ASCII
    // only, so "helene" never found "Hélène" and never would have.
    const match = toMatchQuery(term);

    const [people, tags, circles, events, notes, messages, messageTotal] =
      await Promise.all([
        match
          ? searchPeople(ctx.db, term, {
              limit: take,
              includeArchived: input.includeArchived,
            })
          : [],
        ctx.db.tag.findMany({
          where: { name: { contains: term } },
          orderBy: [{ kind: "asc" }, { name: "asc" }],
          take,
        }),
        ctx.db.circle.findMany({
          where: { name: { contains: term } },
          orderBy: { name: "asc" },
          take,
        }),
        ctx.db.event.findMany({
          where: { title: { contains: term } },
          select: { id: true, title: true, type: true, occurredAt: true },
          orderBy: { occurredAt: "desc" },
          take,
        }),
        match ? searchNotes(ctx.db, term, { limit: take }) : [],
        match && input.includeMessages
          ? searchMessages(ctx.db, term, { limit: take })
          : [],
        match && input.includeMessages ? countMessageMatches(ctx.db, term) : 0,
      ]);

    const peopleHits = people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      isSelf: person.isSelf,
      avatarColor: person.avatarColor,
      archived: person.archived,
    }));

    return {
      query: term,
      people: peopleHits,
      tags,
      circles,
      events,
      notes,
      messages,
      /** Every message that matched, not just the page returned. */
      messageTotal,
    };
  },
});

export const getTool = defineTool({
  name: "people.get",
  title: "Get person",
  kind: "read",
  summary: "One person in full: contacts, circles, tags, custom fields and sketch.",
  input: personIdInput,
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const person = await ctx.db.person.findUnique({
      where: { id: input.personId },
      select: personDetailSelect,
    });
    if (!person) {
      throw new ToolError("not_found", `No person with id "${input.personId}"`);
    }

    const profile = await ctx.db.personProfile.findUnique({
      where: { personId: input.personId },
    });
    const favours = await ctx.db.favour.findMany({
      where: { personId: input.personId },
      orderBy: { createdAt: "desc" },
    });

    // The axes travel with the person, so a client draws the radar from
    // what core defines rather than from a copy of its own.
    return { person, profile, favours, personalityAxes: PERSONALITY_AXES };
  },
});

export const selfTool = defineTool({
  name: "people.self",
  title: "Get the owner's own record",
  kind: "read",
  summary:
    "The single person marked isSelf. Closeness, the graph and the insights are all defined against it.",
  input: nothing,
  async handler(ctx) {
    const person = await ctx.db.person.findFirst({
      where: { isSelf: true },
      select: personDetailSelect,
    });
    return { person };
  },
});

export const fieldsTool = defineTool({
  name: "people.fields",
  title: "List field definitions",
  kind: "read",
  summary:
    "The custom fields this silo defines, so a write uses a key that exists rather than inventing one.",
  input: nothing,
  async handler(ctx) {
    const fields = await ctx.db.fieldDefinition.findMany({
      orderBy: [{ order: "asc" }, { label: "asc" }],
    });
    return { fields };
  },
});

export const activityTool = defineTool({
  name: "people.activity",
  title: "Recent activity",
  kind: "read",
  summary:
    "What happened lately, and who has gone quiet, optionally only the occasions one person was at. The dashboard and a catch-up both read this.",
  input: z.object({
    days: z.number().int().min(1).max(3650).default(30),
    limit: z.number().int().min(1).max(500).default(20),
    /** Only occasions this person was at. */
    personId: idSchema.optional(),
  }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const since = new Date(ctx.now.getTime() - input.days * 86_400_000);

    const [events, people] = await Promise.all([
      ctx.db.event.findMany({
        where: {
          occurredAt: { gte: since },
          ...(input.personId ? { participants: { some: { personId: input.personId } } } : {}),
        },
        select: {
          id: true,
          title: true,
          type: true,
          occurredAt: true,
          sentiment: true,
          participants: {
            select: { person: { select: { id: true, displayName: true } } },
          },
        },
        orderBy: { occurredAt: "desc" },
        take: input.limit,
      }),
      ctx.db.person.findMany({
        where: { archived: false, isSelf: false },
        select: {
          id: true,
          displayName: true,
          events: {
            select: { event: { select: { occurredAt: true } } },
            orderBy: { event: { occurredAt: "desc" } },
            take: 1,
          },
        },
      }),
    ]);

    const quietPeople = people
      .map((person) => ({
        id: person.id,
        displayName: person.displayName,
        lastEventAt: person.events[0]?.event.occurredAt ?? null,
      }))
      .filter((person) => person.lastEventAt === null || person.lastEventAt < since)
      .sort((a, b) => {
        if (a.lastEventAt === null && b.lastEventAt === null) {
          return a.displayName.localeCompare(b.displayName);
        }
        if (a.lastEventAt === null) return -1;
        if (b.lastEventAt === null) return 1;
        return a.lastEventAt.getTime() - b.lastEventAt.getTime();
      })
      .slice(0, input.limit);

    return {
      since: since.toISOString(),
      events: events.map((event) => ({
        id: event.id,
        title: event.title,
        type: event.type,
        occurredAt: event.occurredAt,
        sentiment: event.sentiment,
        participants: event.participants.map((participant) => participant.person),
      })),
      quietPeople,
    };
  },
});

export const timelineTool = defineTool({
  name: "people.timeline",
  title: "Person timeline",
  kind: "read",
  summary:
    "One person's events and standalone notes, newest first. Notes attached to an event show under that event.",
  input: personIdInput,
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const [notes, events] = await Promise.all([
      ctx.db.note.findMany({
        where: { personId: input.personId, eventId: null },
        include: { tags: { orderBy: { name: "asc" } } },
        orderBy: { occurredAt: "desc" },
      }),
      ctx.db.event.findMany({
        where: { participants: { some: { personId: input.personId } } },
        include: {
          participants: {
            include: {
              person: { select: { id: true, displayName: true, avatarColor: true } },
            },
          },
        },
        orderBy: { occurredAt: "desc" },
      }),
    ]);

    const entries = [
      ...notes.map((note) => ({ kind: "note" as const, at: note.occurredAt, note })),
      ...events.map((event) => ({ kind: "event" as const, at: event.occurredAt, event })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    return { personId: input.personId, entries };
  },
});

export const insightsTool = defineTool({
  name: "people.insights",
  title: "Person insights",
  kind: "read",
  summary:
    "Cadence, sentiment per event type, trend, closeness and favours. Reports a thin sample as thin rather than as a number.",
  input: personIdInput,
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const insights = await getPersonInsights(ctx.db, input.personId, ctx.now);
    if (!insights) {
      throw new ToolError("not_found", `No person with id "${input.personId}"`);
    }
    return insights;
  },
});

export const chatInsightsTool = defineTool({
  name: "people.chat_insights",
  title: "Chat insights",
  kind: "read",
  summary:
    "Volume, who opens, reply latency, cadence, rhythm and who gets the last word, from the imported chats.",
  input: z.object({
    personId: idSchema,
    /** Minutes added to UTC before bucketing hours and weekdays. */
    offsetMinutes: z.number().int().min(-840).max(840).default(0),
  }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const insights = await getPersonChatInsights(ctx.db, input.personId, {
      now: ctx.now,
      offsetMinutes: input.offsetMinutes,
      thresholds: ctx.config.chatThresholds,
    });
    if (!insights) {
      throw new ToolError("not_found", `No person with id "${input.personId}"`);
    }
    return insights;
  },
});

export const readMessagesTool = defineTool({
  name: "people.read_messages",
  title: "Read messages",
  kind: "read",
  summary:
    "Real message text, newest first, capped. Not redacted, and every call is audited with the person and the number of rows returned.",
  input: z
    .object({
      personId: idSchema,
      /** FTS5 over the bodies. Without it, the page is simply newest first. */
      query: z.string().trim().min(1).optional(),
    })
    .and(personMessagesSchema),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const person = await ctx.db.person.findUnique({
      where: { id: input.personId },
      select: { id: true },
    });
    if (!person) {
      throw new ToolError("not_found", `No person with id "${input.personId}"`);
    }

    const conversations = await ctx.db.conversation.findMany({
      where: {
        participants: { some: { personId: input.personId } },
        ...(input.conversationId ? { id: input.conversationId } : {}),
      },
      select: { id: true },
    });
    const conversationIds = conversations.map((conversation) => conversation.id);

    if (conversationIds.length === 0) {
      // Still audited: "nothing came back" is as much a read as any other.
      await auditRead(ctx, input.personId, 0, 0);
      return {
        personId: input.personId,
        messages: [],
        page: { limit: input.limit, offset: input.offset, total: 0, hasMore: false },
      };
    }

    const where = {
      conversationId: { in: conversationIds },
      OR: [{ personId: input.personId }, { isFromSelf: true }],
      ...(input.from || input.to
        ? {
            sentAt: {
              ...(input.from ? { gte: input.from } : {}),
              ...(input.to ? { lte: input.to } : {}),
            },
          }
        : {}),
    };

    // With a query the rows come back by relevance out of FTS5, which is the
    // only way to look through tens of thousands of bodies. Without one they
    // come back newest first, which is what reading a thread wants.
    const [rows, total] = input.query
      ? await Promise.all([
          searchMessages(ctx.db, input.query, {
            conversationIds,
            personId: input.personId,
            ...(input.from ? { from: input.from } : {}),
            ...(input.to ? { to: input.to } : {}),
            limit: input.limit,
            offset: input.offset,
          }),
          countMessageMatches(ctx.db, input.query, {
            conversationIds,
            personId: input.personId,
            ...(input.from ? { from: input.from } : {}),
            ...(input.to ? { to: input.to } : {}),
          }),
        ])
      : await Promise.all([
          ctx.db.message.findMany({
            where,
            orderBy: { sentAt: "desc" },
            skip: input.offset,
            take: input.limit,
          }),
          ctx.db.message.count({ where }),
        ]);

    // The privacy port is pass-through on purpose, and running the text through
    // it says so out loud rather than leaving the reader to wonder.
    const messages = rows.map((row) => ({
      ...row,
      body: ctx.ports.privacy.redact(row.body),
    }));

    await auditRead(ctx, input.personId, messages.length, total);

    return {
      personId: input.personId,
      ...(input.query ? { query: input.query } : {}),
      messages,
      page: {
        limit: input.limit,
        offset: input.offset,
        total,
        hasMore: input.offset + messages.length < total,
      },
    };
  },
});

/**
 * Audited here as well as by the registry, because the count is the part worth
 * being able to read back: this is the one tool that hands over real message
 * text, and the decision to leave it unredacted was taken on the condition
 * that every call says how much it handed over.
 */
async function auditRead(
  ctx: { ports: { audit: { log: (entry: AuditEntry) => Promise<void> } }; now: Date },
  personId: string,
  returned: number,
  total: number,
): Promise<void> {
  await ctx.ports.audit.log({
    tool: "people.read_messages",
    kind: "read",
    personId,
    at: ctx.now,
    detail: { returned, total },
  });
}

export const graphTool = defineTool({
  name: "people.graph",
  title: "Graph payload",
  kind: "read",
  summary:
    "Nodes, edges and the raw events behind them, plus synthesized KNOWS_OF threads to everyone with no real link. Payload only, nothing is written back.",
  input: nothing,
  async handler(ctx) {
    return getGraphData(ctx.db);
  },
});

export const socialPlatformsTool = defineTool({
  name: "people.social_platforms",
  title: "Social platforms",
  kind: "read",
  summary:
    "The registry: handle patterns, profile URL shapes and the platforms whose hosts are awkward. Read this before proposing a handle.",
  input: nothing,
  async handler() {
    return { platforms: platformCatalogue() };
  },
});

export const checkSocialsTool = defineTool({
  name: "people.check_socials",
  title: "Check socials",
  kind: "read",
  summary:
    "Dry run over proposed handles: normalizes them, finds duplicates and conflicts, and issues the token attach_socials needs. Writes nothing.",
  input: z.object({
    personId: idSchema,
    candidates: socialCandidateListSchema,
  }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const person = await ctx.db.person.findUnique({
      where: { id: input.personId },
      select: { id: true, displayName: true },
    });
    if (!person) {
      throw new ToolError("not_found", `No person with id "${input.personId}"`);
    }

    const channels = await loadPersonChannels(ctx.db, input.personId);
    const results = evaluateCandidates(input.candidates, channels);

    return {
      personId: person.id,
      displayName: person.displayName,
      summary: summarise(results),
      results: publicResults(results),
      checkToken: issueCheckToken(person.id, results),
    };
  },
});

export const avatarCandidatesTool = defineTool({
  name: "people.avatar_candidates",
  title: "Picture candidates",
  kind: "read",
  summary:
    "The picture URLs the enabled resolvers would try for a person, in order, built from the handles already stored against them. Fetches nothing and writes nothing: people.set_picture stores one, and only after the owner has seen it and said yes.",
  input: personIdInput,
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const person = await ctx.db.person.findUnique({
      where: { id: input.personId },
      select: {
        id: true,
        displayName: true,
        avatar: { select: { source: true, sourceUrl: true, fetchedAt: true } },
      },
    });
    if (!person) {
      throw new ToolError("not_found", `No person with id "${input.personId}"`);
    }

    const channels = await ctx.db.contactChannel.findMany({
      where: { personId: input.personId },
      select: { kind: true, platform: true, value: true, url: true },
      orderBy: [{ isPrimary: "desc" }, { kind: "asc" }],
    });

    const resolvers = ctx.config.avatarResolvers;
    const candidates = buildResolverCandidates(resolvers, channels);
    const anyEnabled = resolvers.some((resolver) => resolver.enabled);

    // An empty list has three different causes and the caller can act on each
    // one, so it says which rather than returning nothing and letting the
    // screen guess.
    const hint =
      candidates.length > 0
        ? "Each of these is a URL a resolver would try. Nothing has been fetched."
        : !anyEnabled
          ? "No resolver is enabled. Settings turns one on."
          : channels.length === 0
            ? `${person.displayName} has no contact channels, so there is no handle to build a picture URL from.`
            : "No enabled resolver matches the handles on this person.";

    return {
      personId: person.id,
      displayName: person.displayName,
      picture: person.avatar
        ? {
            source: person.avatar.source,
            sourceUrl: person.avatar.sourceUrl,
            fetchedAt: person.avatar.fetchedAt.toISOString(),
          }
        : null,
      candidates,
      hint,
    };
  },
});

export const resolvePersonTool = defineTool({
  name: "people.resolve_person",
  title: "Resolve a name",
  kind: "read",
  summary:
    "Turns a name into one person id, or into the candidates that answer to it with the facts that tell them apart. Run this before any write when all you were given is a name: several matches mean ask the owner, never pick.",
  input: z.object({
    name: z.string().trim().min(1, "Expected a name to resolve"),
    limit: z.number().int().min(1).max(10).default(8),
    includeArchived: z.boolean().default(false),
  }),
  async handler(ctx, input) {
    return resolvePeopleByName(ctx.db, input.name, {
      limit: input.limit,
      includeArchived: input.includeArchived,
    });
  },
});

export const exportTool = defineTool({
  name: "people.export",
  title: "Export the silo",
  kind: "read",
  summary:
    "The whole silo as one snapshot, for the user's own backup. Avatar bytes travel base64, so the file is large.",
  input: nothing,
  async handler(ctx) {
    return buildExportSnapshot(ctx.db);
  },
});

export const dashboardTool = defineTool({
  name: "people.dashboard",
  title: "Dashboard",
  kind: "read",
  summary:
    "The landing page in one call: birthdays and the anniversaries of when you met coming up, occasions, people seen and messages per month over the last year, the mix of occasion kinds, who you saw most in the last 90 days, and circle sizes.",
  input: z
    .object({ horizonDays: z.number().int().min(1).max(366).default(60) })
    .default({}),
  async handler(ctx, input) {
    return getDashboardData(ctx.db, ctx.now, { horizonDays: input.horizonDays });
  },
});

export const personalityStatusTool = defineTool({
  name: "people.personality_status",
  title: "Personality radar status",
  kind: "read",
  summary:
    "Everyone with imported messages, busiest first, with their personality radar scores, when it was last written and whether messages arrived since, plus the axes. Work down the stale ones with people.draft_context job personality, then people.propose_draft.",
  input: z
    .object({ onlyStale: z.boolean().default(false) })
    .default({}),
  async handler(ctx, input) {
    const people = await ctx.db.person.findMany({
      where: { archived: false, isSelf: false },
      select: {
        id: true,
        displayName: true,
        avatarColor: true,
        mbti: true,
        profile: { select: { personalityAt: true, personality: true } },
        _count: { select: { messages: { where: { isSystem: false } } } },
        messages: {
          where: { isSystem: false },
          select: { sentAt: true },
          orderBy: { sentAt: "desc" },
          take: 1,
        },
      },
    });

    const rows = people
      .filter((person) => person._count.messages > 0)
      .map((person) => {
        const personalityAt = person.profile?.personalityAt ?? null;
        const lastMessageAt = person.messages[0]?.sentAt ?? null;
        return {
          personId: person.id,
          displayName: person.displayName,
          avatarColor: person.avatarColor,
          mbti: person.mbti,
          scores: parsePersonality(person.profile?.personality),
          messages: person._count.messages,
          lastMessageAt,
          personalityAt,
          stale:
            personalityAt === null ||
            (lastMessageAt !== null && lastMessageAt > personalityAt),
        };
      })
      .filter((row) => !input.onlyStale || row.stale)
      .sort((a, b) => b.messages - a.messages);

    return {
      axes: PERSONALITY_AXES,
      people: rows,
      stale: rows.filter((row) => row.stale).length,
    };
  },
});

export const vcardTool = defineTool({
  name: "people.vcard",
  title: "Export contact cards",
  kind: "read",
  summary:
    "vCard 3.0 text for one person, a list, or everyone not archived: names, birthday, phones, emails, socials, location, circles, how you met and, unless photos is false, the stored picture when it is JPEG, PNG or GIF (photoless lists the rest). Import the .vcf on a phone or in Contacts.",
  input: z
    .object({
      /** Omitted or empty: everyone not archived, without the owner's own record. */
      personIds: z.array(idSchema).max(5000).optional(),
      photos: z.boolean().default(true),
    })
    .default({}),
  async handler(ctx, input) {
    const ids = input.personIds && input.personIds.length > 0 ? input.personIds : null;
    const people = await ctx.db.person.findMany({
      where: ids ? { id: { in: ids } } : { archived: false, isSelf: false },
      select: {
        id: true,
        displayName: true,
        firstName: true,
        lastName: true,
        birthday: true,
        location: true,
        howWeMet: true,
        contacts: { orderBy: [{ isPrimary: "desc" }, { kind: "asc" }] },
        circles: { select: { name: true }, orderBy: { name: "asc" } },
        avatar: input.photos ? { select: { image: true, mime: true } } : false,
      },
      orderBy: { displayName: "asc" },
    });

    if (ids && people.length !== new Set(ids).size) {
      const found = new Set(people.map((person) => person.id));
      throw new ToolError(
        "not_found",
        `No person with id "${ids.find((id) => !found.has(id))}"`,
      );
    }

    const vcard = buildVCards(
      people.map((person) => ({
        ...person,
        photo:
          "avatar" in person && person.avatar
            ? { bytes: person.avatar.image, mime: person.avatar.mime }
            : null,
      })),
    );

    return {
      fileName: vcardFileName(people, ctx.now),
      mime: "text/vcard",
      count: people.length,
      vcard,
      /**
       * People whose stored picture is in a format contact apps do not
       * import (WebP, AVIF), so their card went out without it. A client
       * that can transcode, a browser through a canvas for one, can add a
       * PHOTO line to those cards itself.
       */
      photoless: input.photos
        ? people.flatMap((person) =>
            "avatar" in person && person.avatar && !photoIsPortable(person.avatar.mime)
              ? [person.id]
              : [],
          )
        : [],
    };
  },
});

export const readTools: ToolDefinition<never, unknown>[] = [
  searchTool,
  getTool,
  selfTool,
  fieldsTool,
  activityTool,
  timelineTool,
  insightsTool,
  chatInsightsTool,
  readMessagesTool,
  graphTool,
  socialPlatformsTool,
  checkSocialsTool,
  avatarCandidatesTool,
  resolvePersonTool,
  exportTool,
  dashboardTool,
  personalityStatusTool,
  vcardTool,
] as unknown as ToolDefinition<never, unknown>[];
