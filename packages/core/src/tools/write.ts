import { z } from "zod";

import { Prisma } from "../../generated/prisma/index.js";
import { avatarColorFor } from "../domain/avatar-colour.js";
import { normaliseContactValue } from "../domain/contact-values.js";
import { recomputeForPeople } from "../domain/link-engine.js";
import { noteSearchText } from "../storage/search.js";
import { avatarResolverListSchema } from "../config/avatar-resolvers.js";
import { idSchema, optionalText, optionalUrl, slugify } from "../schemas/common.js";
import {
  ContactConfidence,
  ContactSource,
  FavourDirection,
  TagKind,
  TieType,
} from "../schemas/enums.js";
import { importChatSchema, mapSenderSchema } from "../schemas/conversation.js";
import { eventBaseSchema } from "../schemas/event.js";
import { fieldDefinitionBaseSchema } from "../schemas/field-definition.js";
import { noteCreateSchema } from "../schemas/note.js";
import { personCreateSchema, personUpdateSchema } from "../schemas/person.js";
import { importChatExport, mapChatSender } from "../domain/chat-store.js";
import { defineTool, ToolError, type ToolContext, type ToolDefinition } from "./registry.js";

/**
 * The write half, minus the four that need the user's explicit yes.
 *
 * Everything here lands unconfirmed: a contact keeps the provenance it was
 * written with, a sketch is not written here at all, and nothing in this file
 * sets verifiedAt or confirmedAt. Only the user confirms, through the host's
 * review queue.
 *
 * Two rules are structural rather than conventional. LinkStat is never written
 * by a tool, only by the recompute, so a caller cannot hand itself a closeness
 * score. And a name that matches nobody is returned rather than turned into a
 * person: inventing people is how a tracker fills up with ghosts.
 */

/** Scoring config, as the link engine wants it. */
function scoring(ctx: ToolContext) {
  return { halfLifeDays: ctx.config.halfLifeDays, scoreScale: ctx.config.scoreScale };
}

async function requirePerson(ctx: ToolContext, personId: string) {
  const person = await ctx.db.person.findUnique({
    where: { id: personId },
    select: { id: true, displayName: true, isSelf: true },
  });
  if (!person) {
    throw new ToolError("not_found", `No person with id "${personId}"`);
  }
  return person;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export const createTool = defineTool({
  name: "people.create",
  title: "Add a person",
  kind: "write",
  summary:
    "Adds a person. Search first: this creates a second row for a name that is already here.",
  input: personCreateSchema,
  async handler(ctx, input) {
    const person = await ctx.db.person.create({
      data: {
        displayName: input.displayName,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        birthday: input.birthday ?? null,
        location: input.location ?? null,
        howWeMet: input.howWeMet ?? null,
        metOn: input.metOn ?? null,
        commStyle: input.commStyle,
        mbti: input.mbti ?? null,
        avatarColor: input.avatarColor ?? avatarColorFor(input.displayName),
      },
    });

    await ctx.ports.bus.emit("people.person.created", {
      personId: person.id,
      displayName: person.displayName,
    });

    return { person };
  },
});

export const updateTool = defineTool({
  name: "people.update",
  title: "Update a person",
  kind: "write",
  summary: "Changes the facts on a person. Omitted fields keep their value.",
  input: z.object({ personId: idSchema, patch: personUpdateSchema }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    await requirePerson(ctx, input.personId);
    const person = await ctx.db.person.update({
      where: { id: input.personId },
      data: {
        ...input.patch,
        ...(input.patch.commStyle ? { commStyle: input.patch.commStyle } : {}),
      },
    });
    return { person };
  },
});

export const archiveTool = defineTool({
  name: "people.archive",
  title: "Archive a person",
  kind: "write",
  summary:
    "Moves a person out of the active list, or back in. The owner's own record cannot be archived.",
  input: z.object({ personId: idSchema, archived: z.boolean().default(true) }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const person = await requirePerson(ctx, input.personId);
    if (person.isSelf) {
      throw new ToolError("refused", "Your own record cannot be archived.");
    }

    const updated = await ctx.db.person.update({
      where: { id: input.personId },
      data: { archived: input.archived },
      select: { id: true, displayName: true, archived: true },
    });
    return { person: updated };
  },
});

export const addNoteTool = defineTool({
  name: "people.add_note",
  title: "Add a note",
  kind: "write",
  summary:
    "Writes a note against a person or an event. The body is a Tiptap document.",
  input: noteCreateSchema,
  personIdOf: (input) => input.personId ?? null,
  async handler(ctx, input) {
    if (input.personId) await requirePerson(ctx, input.personId);

    const note = await ctx.db.note.create({
      data: {
        personId: input.personId ?? null,
        eventId: input.eventId ?? null,
        body: jsonValue(input.body),
        // What note_fts indexes. A trigger cannot walk a Tiptap tree, so the
        // plain text is written beside the document on every write.
        searchText: noteSearchText(input.body),
        occurredAt: input.occurredAt,
        pinned: input.pinned,
        ...(input.tagIds.length
          ? { tags: { connect: input.tagIds.map((id) => ({ id })) } }
          : {}),
      },
      include: { tags: { orderBy: { name: "asc" } } },
    });

    return { note };
  },
});

/**
 * An event, with every participant resolved to a person that already exists.
 *
 * A bare name is matched against displayName, case insensitively, and a name
 * that matches nobody comes back in `unmatched` with whatever near misses the
 * silo holds. Nothing is written in that case, not even the event: a caller
 * that wanted the other people on the row would otherwise get a half logged
 * evening and no way to tell.
 */
export const logInteractionTool = defineTool({
  name: "people.log_interaction",
  title: "Log an interaction",
  kind: "write",
  summary:
    "Logs something that happened, with who was there. Returns unmatched names rather than inventing people.",
  input: eventBaseSchema,
  async handler(ctx, input) {
    const resolved: Array<{ personId: string; role: string | null; sentiment: number | null }> = [];
    const unmatched: Array<{ name: string; candidates: Array<{ id: string; displayName: string }> }> = [];
    const seen = new Set<string>();

    for (const participant of input.participants) {
      let personId = participant.personId ?? null;

      if (!personId) {
        const name = (participant.name ?? "").trim();
        const match = await ctx.db.person.findFirst({
          where: { displayName: { equals: name } },
          select: { id: true },
        });

        if (match) {
          personId = match.id;
        } else {
          const candidates = await ctx.db.person.findMany({
            where: { displayName: { contains: name } },
            select: { id: true, displayName: true },
            take: 5,
          });
          unmatched.push({ name, candidates });
          continue;
        }
      } else {
        await requirePerson(ctx, personId);
      }

      if (seen.has(personId)) continue;
      seen.add(personId);
      resolved.push({
        personId,
        role: participant.role ?? null,
        sentiment: participant.sentiment ?? null,
      });
    }

    if (unmatched.length > 0) {
      return {
        written: false as const,
        unmatched,
        hint: "Add these people with people.create, or pass a personId, then log the interaction again. Nothing was written.",
      };
    }

    const event = await ctx.db.$transaction(async (tx) => {
      return tx.event.create({
        data: {
          title: input.title,
          type: input.type,
          occurredAt: input.occurredAt,
          location: input.location ?? null,
          ...(input.description ? { description: jsonValue(input.description) } : {}),
          sentiment: input.sentiment,
          weight: input.weight,
          participants: {
            createMany: {
              data: resolved.map((participant) => ({
                personId: participant.personId,
                role: participant.role,
                sentiment: participant.sentiment,
              })),
            },
          },
        },
        select: { id: true, title: true, occurredAt: true },
      });
    });

    // Scoring is cheap at this scale, so links are rebuilt inline, after the
    // transaction commits and before anything is emitted.
    const personIds = resolved.map((participant) => participant.personId);
    const recompute = await recomputeForPeople(ctx.db, personIds, ctx.now, scoring(ctx));

    await ctx.ports.bus.emit("people.interaction.logged", {
      eventId: event.id,
      personIds,
      occurredAt: event.occurredAt.toISOString(),
    });

    return { written: true as const, event, personIds, recompute, unmatched: [] };
  },
});

const contactInput = z.object({
  id: idSchema.optional(),
  kind: z.enum(["EMAIL", "PHONE", "SOCIAL", "OTHER"]),
  platform: optionalText,
  value: z.string().trim().min(1).max(320),
  url: optionalUrl,
  isPrimary: z.boolean().default(false),
  label: optionalText,
  /** Who is writing this row. MANUAL means a human typed it. */
  source: ContactSource.default("MANUAL"),
  sourceUrl: optionalUrl,
  confidence: ContactConfidence.nullish(),
});

export const setContactsTool = defineTool({
  name: "people.set_contacts",
  title: "Set contact channels",
  kind: "write",
  summary:
    "Writes a person's contact rows. A manual edit of a value drops the citations that came with it, and nothing here marks a row as verified.",
  input: z.object({
    personId: idSchema,
    contacts: z.array(contactInput).max(50),
    /** Deletes the rows this call did not mention. */
    replace: z.boolean().default(false),
  }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    await requirePerson(ctx, input.personId);

    const written: string[] = [];

    await ctx.db.$transaction(async (tx) => {
      for (const contact of input.contacts) {
        const existing = contact.id
          ? await tx.contactChannel.findUnique({ where: { id: contact.id } })
          : null;

        if (contact.id && !existing) {
          throw new ToolError("not_found", `No contact channel with id "${contact.id}"`);
        }
        if (existing && existing.personId !== input.personId) {
          throw new ToolError("refused", "That contact channel belongs to someone else.");
        }

        // One validator for every caller: the UI posts what was typed, a model
        // posts what it read, and both land as the canonical value with the
        // profile URL derived from it rather than from what was pasted.
        const normalised = normaliseContactValue(
          contact.kind,
          contact.platform,
          contact.value,
        );
        if (!normalised.ok) {
          throw new ToolError("invalid_input", normalised.message);
        }

        // A changed value is no longer the one an assistant proposed and the
        // user stood behind, so the provenance that came with it stops
        // applying. verifiedAt is the user's own act and no tool sets it.
        const valueChanged = existing !== null && existing.value !== normalised.value;
        const manual = contact.source === "MANUAL";
        const citations =
          manual && valueChanged
            ? { sourceUrl: null, confidence: null, verifiedAt: null }
            : {
                sourceUrl: contact.sourceUrl ?? null,
                confidence: contact.confidence ?? null,
                ...(valueChanged ? { verifiedAt: null } : {}),
              };

        const data = {
          kind: contact.kind,
          platform: contact.platform ?? null,
          value: normalised.value,
          // A derived address wins over a pasted one. A platform with no public
          // profile URL, such as Signal, leaves whatever the caller gave.
          url: normalised.url ?? contact.url ?? null,
          isPrimary: contact.isPrimary,
          label: contact.label ?? null,
          source: contact.source,
          ...citations,
        };

        if (contact.isPrimary) {
          await tx.contactChannel.updateMany({
            where: {
              personId: input.personId,
              isPrimary: true,
              ...(existing ? { NOT: { id: existing.id } } : {}),
            },
            data: { isPrimary: false },
          });
        }

        const row = existing
          ? await tx.contactChannel.update({ where: { id: existing.id }, data })
          : await tx.contactChannel.create({
              data: { personId: input.personId, ...data },
            });
        written.push(row.id);
      }

      if (input.replace) {
        await tx.contactChannel.deleteMany({
          where: { personId: input.personId, id: { notIn: written } },
        });
      }
    });

    const contacts = await ctx.db.contactChannel.findMany({
      where: { personId: input.personId },
      orderBy: [{ isPrimary: "desc" }, { kind: "asc" }],
    });
    return { personId: input.personId, contacts };
  },
});

/** Sage for a like, crimson for an allergy, ochre for a dislike. */
const DEFAULT_TAG_COLOURS: Record<z.infer<typeof TagKind>, string> = {
  INTEREST: "#6f9a7e",
  ALLERGY: "#b3162f",
  DISLIKE: "#c8955a",
};

const tagListInput = z.array(z.string().trim().min(1).max(80)).max(100).optional();

export const setTagsTool = defineTool({
  name: "people.set_tags",
  title: "Set interests, allergies and dislikes",
  kind: "write",
  summary:
    "Sets the tag membership of the kinds you pass, by name. Replaces it by default; with mode add, adds to what is there. A name that is not a tag yet becomes one.",
  input: z.object({
    personId: idSchema,
    /**
     * add leaves what is there alone. A proposal drafted before another one
     * was confirmed must not wipe it, so drafts use add.
     */
    mode: z.enum(["replace", "add"]).default("replace"),
    interests: tagListInput,
    allergies: tagListInput,
    dislikes: tagListInput,
  }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    await requirePerson(ctx, input.personId);

    const kinds = [
      ["INTEREST", "interests", input.interests],
      ["ALLERGY", "allergies", input.allergies],
      ["DISLIKE", "dislikes", input.dislikes],
    ] as const;

    await ctx.db.$transaction(async (tx) => {
      for (const [kind, relation, names] of kinds) {
        if (names === undefined) continue;

        const ids: string[] = [];
        for (const name of [...new Set(names)]) {
          const tag = await tx.tag.upsert({
            where: { kind_name: { kind, name } },
            update: {},
            create: { kind, name, colour: DEFAULT_TAG_COLOURS[kind] },
            select: { id: true },
          });
          ids.push(tag.id);
        }

        await tx.person.update({
          where: { id: input.personId },
          data: {
            [relation]:
              input.mode === "add"
                ? { connect: ids.map((id) => ({ id })) }
                : { set: ids.map((id) => ({ id })) },
          },
        });
      }
    });

    const person = await ctx.db.person.findUnique({
      where: { id: input.personId },
      select: {
        id: true,
        interests: { orderBy: { name: "asc" } },
        allergies: { orderBy: { name: "asc" } },
        dislikes: { orderBy: { name: "asc" } },
      },
    });
    return { person };
  },
});

export const setCirclesTool = defineTool({
  name: "people.set_circles",
  title: "Set circles",
  kind: "write",
  summary:
    "Replaces which circles a person belongs to, by name. A name that is not a circle yet becomes one.",
  input: z.object({
    personId: idSchema,
    circles: z.array(z.string().trim().min(1).max(80)).max(50),
  }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    await requirePerson(ctx, input.personId);

    await ctx.db.$transaction(async (tx) => {
      const ids: string[] = [];
      for (const name of [...new Set(input.circles)]) {
        const circle = await tx.circle.upsert({
          where: { name },
          update: {},
          create: { name, colour: avatarColorFor(name) },
          select: { id: true },
        });
        ids.push(circle.id);
      }

      await tx.person.update({
        where: { id: input.personId },
        data: { circles: { set: ids.map((id) => ({ id })) } },
      });
    });

    const person = await ctx.db.person.findUnique({
      where: { id: input.personId },
      select: { id: true, circles: { orderBy: { name: "asc" } } },
    });
    return { person };
  },
});

export const setCustomValuesTool = defineTool({
  name: "people.set_custom_values",
  title: "Set custom field values",
  kind: "write",
  summary:
    "Writes values for the fields people.fields lists. A null value clears one. An unknown key is refused rather than invented.",
  input: z.object({
    personId: idSchema,
    values: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(80),
          value: z.unknown(),
        }),
      )
      .max(100),
  }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    await requirePerson(ctx, input.personId);

    const written: Array<{ key: string; cleared: boolean }> = [];

    await ctx.db.$transaction(async (tx) => {
      for (const entry of input.values) {
        const field = await tx.fieldDefinition.findUnique({
          where: { key: slugify(entry.key) },
          select: { id: true, key: true },
        });
        if (!field) {
          throw new ToolError(
            "not_found",
            `No field definition with key "${entry.key}". people.fields lists the keys this silo defines.`,
          );
        }

        const where = {
          personId_fieldDefinitionId: {
            personId: input.personId,
            fieldDefinitionId: field.id,
          },
        };

        if (entry.value === null || entry.value === undefined) {
          await tx.customValue.deleteMany({
            where: { personId: input.personId, fieldDefinitionId: field.id },
          });
          written.push({ key: field.key, cleared: true });
          continue;
        }

        const value = jsonValue(entry.value);
        await tx.customValue.upsert({
          where,
          update: { value },
          create: {
            personId: input.personId,
            fieldDefinitionId: field.id,
            value,
          },
        });
        written.push({ key: field.key, cleared: false });
      }
    });

    return { personId: input.personId, written };
  },
});

export const setFieldsTool = defineTool({
  name: "people.set_fields",
  title: "Set field definitions",
  kind: "write",
  summary:
    "Defines or changes the custom fields. The key is slugified from the label when it is left out.",
  input: z.object({
    fields: z
      .array(fieldDefinitionBaseSchema.extend({ id: idSchema.optional() }))
      .min(1)
      .max(100),
  }),
  async handler(ctx, input) {
    const written: string[] = [];

    await ctx.db.$transaction(async (tx) => {
      for (const field of input.fields) {
        const key = slugify(field.key ?? field.label);
        if (field.type === "SELECT" && field.options.length === 0) {
          throw new ToolError("invalid_input", `Field "${key}" is a SELECT with no options.`);
        }

        const data = {
          key,
          label: field.label,
          type: field.type,
          options: jsonValue(field.options),
          scope: field.scope,
          order: field.order,
        };

        const row = field.id
          ? await tx.fieldDefinition.update({ where: { id: field.id }, data })
          : await tx.fieldDefinition.upsert({
              where: { key },
              update: data,
              create: data,
            });
        written.push(row.id);
      }
    });

    const fields = await ctx.db.fieldDefinition.findMany({
      orderBy: [{ order: "asc" }, { label: "asc" }],
    });
    return { fields, writtenCount: written.length };
  },
});

export const setFavourTool = defineTool({
  name: "people.set_favour",
  title: "Set a favour",
  kind: "write",
  summary:
    "Records who owes whom, or settles one. Pass a favourId to change an existing row.",
  input: z
    .object({
      personId: idSchema,
      favourId: idSchema.optional(),
      direction: FavourDirection.optional(),
      description: z.string().trim().min(1).max(280).optional(),
      settled: z.boolean().optional(),
    })
    .refine(
      (value) => value.favourId !== undefined || (value.direction && value.description),
      {
        message: "A new favour needs a direction and a description",
        path: ["description"],
      },
    ),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    await requirePerson(ctx, input.personId);

    if (!input.favourId) {
      const favour = await ctx.db.favour.create({
        data: {
          personId: input.personId,
          direction: input.direction!,
          description: input.description!,
          settledAt: input.settled ? ctx.now : null,
        },
      });
      return { favour };
    }

    const existing = await ctx.db.favour.findUnique({ where: { id: input.favourId } });
    if (!existing || existing.personId !== input.personId) {
      throw new ToolError("not_found", `No favour with id "${input.favourId}" for that person`);
    }

    const favour = await ctx.db.favour.update({
      where: { id: input.favourId },
      data: {
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.settled === undefined
          ? {}
          : { settledAt: input.settled ? ctx.now : null }),
      },
    });
    return { favour };
  },
});

export const setLinkTool = defineTool({
  name: "people.set_link",
  title: "Curate a link",
  kind: "write",
  summary:
    "Writes the human half of a link: the tie, a manual score, pinned, notes. The derived score is a cache and no tool can write it.",
  input: z.object({
    aPersonId: idSchema,
    bPersonId: idSchema,
    tie: TieType.optional(),
    /** Overrides the derived score for readers. Null hands it back. */
    manualScore: z.number().int().min(-100).max(100).nullish(),
    pinned: z.boolean().optional(),
    notes: optionalText,
  }),
  async handler(ctx, input) {
    if (input.aPersonId === input.bPersonId) {
      throw new ToolError("refused", "A person cannot be linked to themselves.");
    }
    await requirePerson(ctx, input.aPersonId);
    await requirePerson(ctx, input.bPersonId);

    // Stored with the canonical ordering the unique constraint expects.
    const key =
      input.aPersonId < input.bPersonId
        ? { aPersonId: input.aPersonId, bPersonId: input.bPersonId }
        : { aPersonId: input.bPersonId, bPersonId: input.aPersonId };

    const data = {
      ...(input.tie ? { tie: input.tie } : {}),
      ...(input.manualScore === undefined ? {} : { manualScore: input.manualScore }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };

    const link = await ctx.db.link.upsert({
      where: { aPersonId_bPersonId: key },
      update: data,
      create: { ...key, ...data },
      include: { stat: true },
    });

    return { link };
  },
});

export const importChatTool = defineTool({
  name: "people.import_chat",
  title: "Import a chat export",
  kind: "write",
  summary:
    "Parses an exported chat and stores it whole. Re-importing the same chat rewrites it rather than duplicating it, and mappings made by hand are carried across.",
  input: importChatSchema,
  async handler(ctx, input) {
    return importChatExport(ctx.db, input, {
      messageChunk: ctx.config.messageChunk,
    });
  },
});

export const mapSenderTool = defineTool({
  name: "people.map_sender",
  title: "Map a chat sender",
  kind: "write",
  summary:
    "Binds a sender name in an imported chat to a person, and backfills their messages.",
  input: z.object({ conversationId: idSchema }).and(mapSenderSchema),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const result = await mapChatSender(
      ctx.db,
      input.conversationId,
      input.senderName,
      input.personId,
    );
    if (!result) {
      throw new ToolError(
        "not_found",
        "That conversation has no such sender, or that person does not exist.",
      );
    }
    return result;
  },
});

export const setResolversTool = defineTool({
  name: "people.set_resolvers",
  title: "Set the avatar resolvers",
  kind: "write",
  summary:
    "Replaces the list of sources a picture may be fetched from. Templates are checked: https only, no credentials, and a placeholder that gets filled in.",
  input: z.object({ resolvers: avatarResolverListSchema }),
  async handler(ctx, input) {
    const config = await ctx.ports.settings.set({ avatarResolvers: input.resolvers });
    return { resolvers: config.avatarResolvers };
  },
});

export const writeTools: ToolDefinition<never, unknown>[] = [
  createTool,
  updateTool,
  archiveTool,
  addNoteTool,
  logInteractionTool,
  setContactsTool,
  setTagsTool,
  setCirclesTool,
  setCustomValuesTool,
  setFieldsTool,
  setFavourTool,
  setLinkTool,
  importChatTool,
  mapSenderTool,
  setResolversTool,
] as unknown as ToolDefinition<never, unknown>[];
