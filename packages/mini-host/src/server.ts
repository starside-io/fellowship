import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { surfaceFingerprint, tools as coreTools } from "@fellowship/core";

import { resolveHostDbPath } from "./host-db.js";
import { startMiniHost, type MiniHost, type MiniHostOptions } from "./host.js";
import {
  acquireHostLock,
  describeThisProcess,
  hostLockPath,
  releaseHostLock,
  updateHostLock,
} from "./host-lock.js";
import { DraftError, draftFacts, draftSenders, draftSketch } from "./specialist.js";
import { desktopAppStatus, installDesktopApp } from "./desktop-app.js";
import { mediaRoutes } from "./media.js";
import { FELLOWSHIP_VERSION } from "./version.js";
import {
  UPDATES_SETTING,
  checkForUpdates,
  installUpdate,
  readInstalledPlugin,
  type CommandRunner,
  type UpdateOptions,
} from "./updates.js";
import { rpcRoutes } from "./rpc.js";

/**
 * The HTTP surface: /rpc for the module, /media for the one route that serves
 * bytes, and /host for the things that belong to the host rather than to the
 * people module. The UI reads the review queue, the audit log and the event
 * feed from /host, and everything else through /rpc.
 */

export const DEFAULT_PORT = 4319;
export const PORT_ENV = "FELLOWSHIP_PORT";

/**
 * Loopback only, unless told otherwise.
 *
 * Node listens on every interface when it is not given an address, which for
 * this process means anyone on the same wifi could read the silo over /rpc:
 * every person, every message, no auth, because there is none to have in a
 * single user app. The host answers on 127.0.0.1 by default, and widening it
 * is a deliberate act with an environment variable.
 */
export const DEFAULT_HOSTNAME = "127.0.0.1";
export const HOSTNAME_ENV = "FELLOWSHIP_HOST";

export interface AppOptions {
  uiDir?: string;
  /** Seams for the update check, so a test reaches neither GitHub nor the claude CLI. */
  updates?: UpdateOptions & {
    run?: CommandRunner;
    claudePath?: string | null;
    app?: { unzip?: (zip: string, into: string) => Promise<void>; supported?: boolean };
  };
}

export function createApp(host: MiniHost, options: AppOptions = {}): Hono {
  const app = new Hono();

  // pid and fingerprint let a client tell this process apart from another
  // host, and this code apart from older code: the desktop app reuses a host
  // only when the fingerprint is its own.
  app.get("/health", (context) =>
    context.json({
      ok: true,
      silo: host.siloPath,
      hostDb: host.hostPath,
      tools: host.api.describe().length,
      pid: process.pid,
      fingerprint: fingerprint(),
    }),
  );

  app.route("/rpc", rpcRoutes(host));
  app.route("/media", mediaRoutes(host));

  const hostRoutes = new Hono();

  hostRoutes.get("/review", (context) => {
    const state = context.req.query("state") ?? "pending";
    const allowed = ["pending", "confirmed", "discarded", "all"] as const;
    const chosen = (allowed as readonly string[]).includes(state)
      ? (state as (typeof allowed)[number])
      : "pending";
    return context.json({ proposals: host.store.listProposals(chosen) });
  });

  /**
   * The owner's decision, through the same tool an assistant would call. The
   * UI clicking Confirm is the owner saying yes, which is what confirmedByUser
   * means; the tool runs the write and marks the row, or refuses and leaves it
   * pending.
   */
  hostRoutes.post("/review/:id/:decision", async (context) => {
    const decision = context.req.param("decision");
    if (decision !== "confirm" && decision !== "discard") {
      return context.json({ ok: false, error: "Expected confirm or discard" }, 400);
    }

    try {
      const result = (await host.api.invoke("people.decide", {
        proposalId: context.req.param("id"),
        decision,
        confirmedByUser: true,
      })) as { state: string; result?: unknown };

      return context.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof coreTools.ToolError) {
        const status = error.code === "not_found" ? 404 : 409;
        return context.json(
          {
            ok: false,
            error: { code: error.code, message: error.message, detail: error.detail },
          },
          status,
        );
      }
      return context.json(
        {
          ok: false,
          error: {
            code: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        500,
      );
    }
  });

  hostRoutes.get("/audit", (context) =>
    context.json({ entries: host.store.listAudit(limitOf(context.req.query("limit"))) }),
  );

  hostRoutes.get("/events", (context) =>
    context.json({ events: host.store.listEvents(limitOf(context.req.query("limit"))) }),
  );

  hostRoutes.get("/config", (context) => context.json({ config: host.config() }));

  /**
   * A config change goes through the settings port, which recomputes every
   * connection before a change to halfLifeDays or scoreScale counts as
   * applied. The UI waits on that: a saved half life with a stale cache behind
   * it would be worse than a slow save.
   */
  hostRoutes.post("/config", async (context) => {
    let patch: Record<string, unknown>;
    try {
      patch = (await context.req.json()) as Record<string, unknown>;
    } catch {
      return context.json({ error: "Expected a JSON body" }, 400);
    }

    try {
      const config = await host.ports.settings.set(patch);
      return context.json({ config });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  /**
   * A picture, fetched and shown but not stored.
   *
   * The owner has to see what a resolver returns before saying yes to it, and
   * the browser must not fetch it itself: unavatar and the rest would get the
   * request straight from the person reading the page, outside the guard that
   * owns the size cap, the content type allowlist and the EXIF strip.
   *
   * The URL is not taken on trust either. It has to be one of the candidates
   * people.avatar_candidates builds for that person, from handles already
   * stored against them, so this is not a fetch anything proxy for whatever
   * posts to it.
   */
  hostRoutes.post("/avatar/preview", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      personId?: unknown;
      url?: unknown;
    };
    if (typeof body.personId !== "string" || typeof body.url !== "string") {
      return context.json({ ok: false, error: "Expected a personId and a url" }, 400);
    }

    let candidates: Array<{ url: string; label: string; handle: string | null }>;
    try {
      const answer = (await host.api.invoke("people.avatar_candidates", {
        personId: body.personId,
      })) as { candidates: Array<{ url: string; label: string; handle: string | null }> };
      candidates = answer.candidates;
    } catch (error) {
      const code = error instanceof coreTools.ToolError ? error.code : "failed";
      return context.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        code === "not_found" ? 404 : 500,
      );
    }

    const candidate = candidates.find((entry) => entry.url === body.url);
    if (!candidate) {
      return context.json(
        {
          ok: false,
          error: "That URL is not one of this person's picture candidates.",
        },
        400,
      );
    }

    try {
      const image = await host.ports.media.fetchImage(candidate.url);
      return context.json({
        ok: true,
        preview: {
          // Inline, because the bytes are not stored anywhere to serve them
          // from and an avatar is small enough to carry.
          dataUrl: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`,
          mime: image.mime,
          bytes: image.bytes.byteLength,
          sourceUrl: image.sourceUrl,
          candidate,
        },
      });
    } catch (error) {
      return context.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  });

  /**
   * The built in drafter, for the standalone app with no assistant attached.
   * Optional: it needs a model endpoint, and an assistant drafting through
   * people.draft_context and people.propose_draft needs none. Either way the
   * draft ends in the review queue and nowhere else.
   */
  const draftRoutes = new Hono();

  draftRoutes.post("/senders/:conversationId", async (context) =>
    runDraft(context, () => draftSenders(host, context.req.param("conversationId"))),
  );

  draftRoutes.post("/sketch/:personId", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      messageLimit?: number;
    };
    return runDraft(context, () =>
      draftSketch(host, context.req.param("personId"), {
        ...(typeof body.messageLimit === "number"
          ? { messageLimit: body.messageLimit }
          : {}),
      }),
    );
  });

  draftRoutes.post("/facts/:personId", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      return context.json({ ok: false, error: "Expected some text to read" }, 400);
    }
    return runDraft(context, () =>
      draftFacts(host, context.req.param("personId"), body.text as string),
    );
  });

  hostRoutes.route("/draft", draftRoutes);

  /**
   * The plugin update check. Off until the owner turns it on; see updates.ts
   * for what it sends and where the answer is cached.
   */
  const updates = options.updates ?? {};
  const updatesEnabled = () => host.store.readSetting(UPDATES_SETTING) === true;
  const updateStatus = (force: boolean) =>
    checkForUpdates({ ...updates, enabled: updatesEnabled(), hostDbPath: host.hostPath, force });

  hostRoutes.get("/updates", async (context) =>
    context.json(await updateStatus(context.req.query("refresh") === "1")),
  );

  hostRoutes.post("/updates/settings", async (context) => {
    if (!context.req.header("content-type")?.startsWith("application/json")) {
      return context.json({ error: "Expected a JSON request" }, 415);
    }
    const body = (await context.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return context.json({ error: "Expected { enabled: true | false }" }, 400);
    }
    host.store.writeSetting(UPDATES_SETTING, body.enabled);
    return context.json(await updateStatus(body.enabled));
  });

  /*
   * Runs claude plugin update. JSON only: a page on another site can send a
   * plain form post to a loopback port, but not a JSON one without a CORS
   * preflight this host never answers.
   */
  hostRoutes.post("/updates/install", async (context) => {
    if (!context.req.header("content-type")?.startsWith("application/json")) {
      return context.json({ ok: false, message: "Expected a JSON request" }, 415);
    }
    const result = await installUpdate({
      ...updates,
      app: { ...updates.app, ...(updates.fetch ? { fetch: updates.fetch } : {}) },
    });
    return context.json(result, result.ok ? 200 : 502);
  });

  /**
   * Fellowship.app, installed on request: the build attached to the release
   * that matches the installed plugin, or this host's own version.
   */
  const appEnv = updates.env ?? process.env;
  const appVersion = () => readInstalledPlugin(appEnv)?.version ?? FELLOWSHIP_VERSION;

  hostRoutes.get("/app", (context) =>
    context.json({
      ...desktopAppStatus(appEnv),
      ...(updates.app?.supported === undefined ? {} : { supported: updates.app.supported }),
      available: appVersion(),
    }),
  );

  hostRoutes.post("/app/install", async (context) => {
    if (!context.req.header("content-type")?.startsWith("application/json")) {
      return context.json({ ok: false, message: "Expected a JSON request" }, 415);
    }
    const result = await installDesktopApp({
      version: appVersion(),
      env: appEnv,
      ...(updates.fetch ? { fetch: updates.fetch } : {}),
      ...updates.app,
    });
    return context.json(result, result.ok ? 200 : 502);
  });

  app.route("/host", hostRoutes);

  const uiDir = options.uiDir ?? process.env[UI_DIR_ENV];
  if (uiDir && existsSync(join(uiDir, "index.html"))) {
    uiRoutes(app, uiDir);
  } else {
    app.get("/", (context) => context.html(NO_UI));
  }

  return app;
}

/** One shape for every draft route, including the ways a model fails. */
async function runDraft(
  context: { json: (body: unknown, status?: 200 | 400 | 502 | 503) => Response },
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    return context.json({ ok: true, draft: await run() });
  } catch (error) {
    if (error instanceof DraftError) {
      return context.json(
        { ok: false, error: error.message, detail: error.detail },
        400,
      );
    }
    // A model endpoint that is not running is the common case here, and it
    // should read as "nothing is listening" rather than as a bug.
    return context.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}

function limitOf(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 100;
  return Math.min(parsed, 1000);
}

let cachedFingerprint: string | undefined;

/** Computed once: it hashes every tool schema and migration. */
function fingerprint(): string {
  cachedFingerprint ??= surfaceFingerprint();
  return cachedFingerprint;
}

export interface ServeOptions extends MiniHostOptions {
  /**
   * Take host.lock so a second host over the same files refuses to start.
   * On by default; a test serving throwaway files may turn it off.
   */
  lock?: boolean;
  port?: number;
  /** The address to listen on. Loopback unless set. */
  hostname?: string;
  /** The built UI. Omitted, or missing on disk, serves a note instead. */
  uiDir?: string;
}

export const UI_DIR_ENV = "FELLOWSHIP_UI_DIR";

/**
 * The built SPA, plus a fallback so a deep link such as /people/<id> is served
 * the shell rather than a 404. The host owns four paths and the SPA owns the
 * rest, which is why the fallback is last.
 */
function uiRoutes(app: Hono, dir: string): void {
  const index = join(dir, "index.html");

  app.use(
    "/assets/*",
    serveStatic({
      root: dir,
      rewriteRequestPath: (path) => path,
      onFound: (_path, context) => {
        // Vite fingerprints these, so they can be cached hard.
        context.header("cache-control", "public, max-age=31536000, immutable");
      },
    }),
  );

  app.use("/favicon.ico", serveStatic({ root: dir }));
  app.use("/favicon.svg", serveStatic({ root: dir }));

  app.get("*", (context) => {
    const accept = context.req.header("accept") ?? "";
    if (!accept.includes("text/html")) return context.body(null, 404);
    return context.html(readFileSync(index, "utf8"));
  });
}

const NO_UI = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fellowship</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; line-height: 1.5">
<h1>The host is up, the UI is not built</h1>
<p>Run <code>pnpm build</code>, or point <code>FELLOWSHIP_UI_DIR</code> at a built
<code>packages/ui/dist</code>. The tools are already reachable over
<code>POST /rpc</code> and over the MCP server either way.</p>
</body></html>`;

export interface RunningHost {
  host: MiniHost;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Opens both files, wires the ports and listens. One process, one writer. */
export async function serveMiniHost(options: ServeOptions = {}): Promise<RunningHost> {
  const env = options.env ?? process.env;
  const lockPath = hostLockPath(options.hostDbPath ?? resolveHostDbPath(env));
  const locking = options.lock !== false;
  // Taken before the files are opened, so a refused host never touches them.
  if (locking) await acquireHostLock(lockPath, describeThisProcess(fingerprint()));

  let host: MiniHost;
  try {
    host = await startMiniHost(options);
  } catch (error) {
    if (locking) releaseHostLock(lockPath);
    throw error;
  }
  const app = createApp(host, options.uiDir === undefined ? {} : { uiDir: options.uiDir });
  const configured = Number(process.env[PORT_ENV]);
  const port =
    options.port ?? (Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_PORT);

  const hostname =
    options.hostname ?? (process.env[HOSTNAME_ENV]?.trim() || DEFAULT_HOSTNAME);

  // The port is only known once the socket is bound, which matters when it
  // was 0 and the OS picked one: the desktop shell asks for exactly that.
  const { server, actual } = await new Promise<{
    server: ReturnType<typeof serve>;
    actual: number;
  }>((resolve, reject) => {
    const instance = serve({ fetch: app.fetch, port, hostname }, (info) => {
      resolve({ server: instance, actual: info.port });
    });
    instance.once("error", reject);
  }).catch(async (error: unknown) => {
    await host.close();
    if (locking) releaseHostLock(lockPath);
    throw error;
  });

  const url = `http://${hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname}:${actual}`;
  if (locking) {
    updateHostLock(lockPath, { port: actual, url });
    // A process that exits without close() still drops its own lock.
    process.once("exit", () => releaseHostLock(lockPath));
  }

  return {
    host,
    port: actual,
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await host.close();
      if (locking) releaseHostLock(lockPath);
    },
  };
}
