import { z } from "zod";

import { Prisma } from "../../generated/prisma/index.js";
import { recomputeAll } from "../domain/link-engine.js";
import { checkPersonality, checkSketch, explainFindings } from "../domain/sketch-discipline.js";
import {
  attachSocials,
  socialCandidateListSchema,
} from "../domain/socials-check.js";
import { importSnapshot } from "../domain/transfer/import.js";
import { idSchema } from "../schemas/common.js";
import { AvatarSource } from "../schemas/enums.js";
import { personProfileInputSchema } from "../schemas/person-profile.js";
import { personalityScoresSchema } from "../schemas/personality.js";
import { defineTool, ToolError, type ToolDefinition } from "./registry.js";

/**
 * The four tools that need the user's explicit yes.
 *
 * confirmedByUser is a z.literal(true), so the flag is part of validation and
 * a handler cannot forget to check it: a call without it never reaches the
 * body. It is the caller's statement that a human saw the thing and said yes,
 * and an assistant that sets it on its own judgement is lying to the user, not
 * to this file.
 *
 * attach_socials wants more than a flag. It also wants the HMAC token
 * check_socials issued over the exact candidate set, so a host that renders a
 * stale or substituted proposal cannot get a write through. The module does not
 * have to trust that the host showed the truth.
 */

const confirmedByUser = z.literal(true, {
  errorMap: () => ({
    message:
      "confirmedByUser must be true. Show the user what this will write and get an explicit yes first.",
  }),
});

export const attachSocialsTool = defineTool({
  name: "people.attach_socials",
  title: "Attach social handles",
  kind: "needs-ok",
  summary:
    "Writes the handles check_socials validated. Needs the token it issued, unexpired and over this exact candidate set.",
  input: z.object({
    personId: idSchema,
    candidates: socialCandidateListSchema,
    checkToken: z.string().min(1, "Run people.check_socials first and pass its checkToken"),
    confirmedByUser,
  }),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const result = await attachSocials(
      ctx.db,
      input.personId,
      input.candidates,
      input.checkToken,
    );

    if (!result.ok) {
      const message =
        typeof result.body === "object" && result.body && "error" in result.body
          ? String((result.body as { error: unknown }).error)
          : "That write was refused.";
      throw new ToolError(result.status === 404 ? "not_found" : "refused", message);
    }

    return result.body;
  },
});

export const writeSketchTool = defineTool({
  name: "people.write_sketch",
  title: "Write a sketch",
  kind: "needs-ok",
  summary:
    "Writes the sketch of how someone actually is. Lands unconfirmed, sources must be non-empty, and a diagnosis-shaped draft is refused.",
  input: personProfileInputSchema
    .extend({
      personId: idSchema,
      /**
       * Required and non-empty. The pages read, plus the history itself when it
       * was leaned on. A sketch with no stated sources is a horoscope.
       */
      sources: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
      source: z.enum(["MANUAL", "ASSISTANT"]).default("ASSISTANT"),
      confirmedByUser,
    })
    .refine(
      (value) =>
        Boolean(
          value.summary ||
            value.whatLands ||
            value.whatToAvoid ||
            value.opener ||
            value.traits,
        ),
      { message: "A sketch needs something in it", path: ["summary"] },
    ),
  personIdOf: (input) => input.personId,
  async handler(ctx, input) {
    const person = await ctx.db.person.findUnique({
      where: { id: input.personId },
      select: { id: true, displayName: true },
    });
    if (!person) {
      throw new ToolError("not_found", `No person with id "${input.personId}"`);
    }

    const findings = checkSketch(input);
    if (findings.length > 0) {
      throw new ToolError("refused", explainFindings(findings), { findings });
    }

    const assistant = input.source === "ASSISTANT";
    const traits =
      input.traits === undefined
        ? undefined
        : input.traits === null
          ? Prisma.DbNull
          : (input.traits as unknown as Prisma.InputJsonValue);

    const written = {
      summary: input.summary,
      whatLands: input.whatLands,
      whatToAvoid: input.whatToAvoid,
      opener: input.opener,
      ...(traits === undefined ? {} : { traits }),
    };

    const profile = await ctx.db.personProfile.upsert({
      where: { personId: input.personId },
      create: {
        personId: input.personId,
        summary: input.summary ?? null,
        whatLands: input.whatLands ?? null,
        whatToAvoid: input.whatToAvoid ?? null,
        opener: input.opener ?? null,
        traits: traits === undefined || traits === Prisma.DbNull ? Prisma.DbNull : traits,
        sources: input.sources,
        source: input.source,
        // Nothing here confirms itself. Confirming that a sketch reads true is
        // the user's own action in the app.
        generatedAt: assistant ? ctx.now : null,
        confirmedAt: null,
      },
      update: {
        ...written,
        sources: input.sources,
        source: input.source,
        generatedAt: assistant ? ctx.now : null,
        confirmedAt: null,
      },
    });

    await ctx.ports.bus.emit("people.sketch.written", {
      personId: person.id,
      source: input.source,
      sourceCount: input.sources.length,
    });

    return {
      personId: person.id,
      displayName: person.displayName,
      profile: {
        ...profile,
        // The stored traits come back as JSON. Handed over as they are.
      },
      confirmed: false,
    };
  },
});

export const setPersonalityTool = defineTool({
  name: "people.set_personality",
  title: "Write a personality radar",
  kind: "needs-ok",
  summary:
    "Writes the personality radar: a 0 to 100 score with evidence on each fixed axis (curiosity, planning, energy, warmth, composure, playfulness, initiative, expressiveness). Replaces the previous radar whole. Evidence that reads as a diagnosis is refused.",
  input: z.object({
    personId: idSchema,
    scores: personalityScoresSchema,
    sources: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    confirmedByUser,
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

    const findings = checkPersonality(input.scores);
    if (findings.length > 0) {
      throw new ToolError("refused", explainFindings(findings), { findings });
    }

    const personality = input.scores as unknown as Prisma.InputJsonValue;
    await ctx.db.personProfile.upsert({
      where: { personId: input.personId },
      // A radar with no sketch yet still needs a profile row to live on. The
      // sketch fields stay empty and its sources start as the radar's.
      create: {
        personId: input.personId,
        sources: input.sources,
        source: "ASSISTANT",
        personality,
        personalityAt: ctx.now,
      },
      update: { personality, personalityAt: ctx.now },
    });

    await ctx.ports.bus.emit("people.personality.written", {
      personId: person.id,
      axes: input.scores.length,
    });

    return {
      personId: person.id,
      displayName: person.displayName,
      axes: input.scores.length,
      personalityAt: ctx.now.toISOString(),
    };
  },
});

export const setPictureTool = defineTool({
  name: "people.set_picture",
  title: "Set a person's picture",
  kind: "needs-ok",
  summary:
    "Fetches an image through the host and stores it against a person. The response carries metadata, never the bytes.",
  input: z.object({
    personId: idSchema,
    url: z.string().url("Expected the URL of a public image"),
    source: AvatarSource.default("MANUAL"),
    confirmedByUser,
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

    // The module never fetches. The host owns the SSRF defence, the size cap,
    // the content-type allowlist and the EXIF strip, and hands back bytes.
    const image = await ctx.ports.media.fetchImage(input.url);

    const data = {
      image: image.bytes,
      mime: image.mime,
      source: input.source,
      sourceUrl: image.sourceUrl,
      fetchedAt: ctx.now,
    };

    await ctx.db.personAvatar.upsert({
      where: { personId: input.personId },
      create: { personId: input.personId, ...data },
      update: data,
    });

    return {
      personId: person.id,
      displayName: person.displayName,
      picture: {
        mime: image.mime,
        bytes: image.bytes.byteLength,
        sourceUrl: image.sourceUrl,
        fetchedAt: ctx.now.toISOString(),
        source: input.source,
      },
    };
  },
});

/** Rows a replace would destroy, counted before anything is deleted. */
async function countEverything(ctx: { db: import("../storage/client.js").Silo }) {
  const [
    people,
    circles,
    tags,
    fieldDefinitions,
    contacts,
    customValues,
    notes,
    events,
    links,
    personProfiles,
    favours,
    conversations,
    messages,
  ] = await Promise.all([
    ctx.db.person.count(),
    ctx.db.circle.count(),
    ctx.db.tag.count(),
    ctx.db.fieldDefinition.count(),
    ctx.db.contactChannel.count(),
    ctx.db.customValue.count(),
    ctx.db.note.count(),
    ctx.db.event.count(),
    ctx.db.link.count(),
    ctx.db.personProfile.count(),
    ctx.db.favour.count(),
    ctx.db.conversation.count(),
    ctx.db.message.count(),
  ]);

  return {
    people,
    circles,
    tags,
    fieldDefinitions,
    contacts,
    customValues,
    notes,
    events,
    links,
    personProfiles,
    favours,
    conversations,
    messages,
  };
}

export const importTool = defineTool({
  name: "people.import",
  title: "Import a snapshot",
  kind: "needs-ok",
  summary:
    "Reads a snapshot back in. merge lets the file win row by row, replace wipes first and names the row counts it will destroy.",
  input: z.object({
    snapshot: z.unknown(),
    mode: z.enum(["merge", "replace"]).default("merge"),
    /** Counts what a replace would destroy and writes nothing. */
    dryRun: z.boolean().default(false),
    confirmedByUser,
  }),
  async handler(ctx, input) {
    const before = await countEverything(ctx);

    if (input.dryRun) {
      return {
        mode: input.mode,
        written: false as const,
        wouldDestroy: input.mode === "replace" ? before : null,
      };
    }

    const result = await importSnapshot(ctx.db, input.snapshot, input.mode, {
      messageChunk: ctx.config.messageChunk,
    });

    /*
     * The cached scores that came in with the file are the exporting app's,
     * computed at its own "now". Decay makes that a different answer from
     * today's, and the import of a real akai-ito snapshot moved 18 of 24
     * scores by up to 23 points, so leaving them would hand this silo another
     * app's stale cache. LinkStat.score is a cache: it gets rebuilt here, from
     * the events the file just brought, with this module's own config.
     */
    const recompute = await recomputeAll(ctx.db, ctx.now, {
      halfLifeDays: ctx.config.halfLifeDays,
      scoreScale: ctx.config.scoreScale,
    });

    return {
      mode: result.mode,
      written: true as const,
      counts: result.counts,
      recompute,
      destroyed: input.mode === "replace" ? before : null,
    };
  },
});

export const confirmTools: ToolDefinition<never, unknown>[] = [
  attachSocialsTool,
  writeSketchTool,
  setPersonalityTool,
  setPictureTool,
  importTool,
] as unknown as ToolDefinition<never, unknown>[];
