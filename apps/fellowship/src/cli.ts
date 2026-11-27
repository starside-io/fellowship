import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { storage } from "@fellowship/core";
import {
  HostAlreadyRunning,
  checkForUpdates,
  desktopAppStatus,
  installDesktopApp,
  openDesktopApp,
  readInstalledPlugin,
  FELLOWSHIP_VERSION,
  formatVerify,
  healthPid,
  hostLockPath,
  liveHostLock,
  processAlive,
  readUpdatesEnabled,
  resolveHostDbPath,
  runStdioServer,
  serveMiniHost,
  startMiniHost,
  verifySnapshot,
} from "@fellowship/mini-host";

/**
 * The standalone binary.
 *
 *   fellowship serve    one process: the silo, the ports, /rpc and /media
 *   fellowship mcp      the same host over stdio, for an assistant
 *   fellowship status   where the files are, and what is in them
 *   fellowship tools    the surface, one line each
 *   fellowship restart  stop the running host and start it again on this code
 *   fellowship whoami   is the owner's own record set up, and what it is missing
 *
 * `fsp` is the short alias. There is no database server to start first and no
 * port to argue with: the files are opened by whichever of these runs.
 */

const USAGE = `fellowship <command>

  serve [--port <n>]       Start the host: POST /rpc, /media, /host. One at a
                           time: refuses while another host is running.
  restart                  Stop the running host and start it the same way
                           again, on the code as it is now. Fellowship.app
                           owns its own host: restart the app for that one.
  mcp                      Start the stdio MCP server for an assistant
  whoami [--hook]          Whether your own record is set up, and what it is
                           missing. --hook prints a SessionStart hook payload,
                           and only when setup is still to do.
  status                   Print where the files are and what is in them
  tools                    List the tool surface
  paths                    Print the silo and host.db paths
  verify <file> [--keep]   Import a snapshot into a throwaway silo, export it
                           back out, and diff the two. Touches no live file.
  import <file>            Read a snapshot into the live silo. Merge: the file
                           wins row by row and nothing else is touched.
        [--replace --yes]  Wipe first. Names what it will destroy, and refuses
                           without --yes.
  export <file>            Write the whole silo to a snapshot file.
  app [status|install|open]
                           Fellowship.app: whether it is installed, download
                           the build attached to this version's release into
                           ~/Applications, or open it. Apple Silicon only.
  reindex                  Rebuild the three search indexes from the rows they
                           shadow. The triggers keep them current, so this is
                           for a file restored from a backup taken mid write.
`;

/**
 * The built UI: beside this binary in the npm package (ui/), or in the
 * workspace when run from a checkout. An env var overrides both, and a missing
 * build is not fatal: the tools are reachable over /rpc and over MCP either way.
 */
function uiDir(): string {
  const override = process.env["FELLOWSHIP_UI_DIR"]?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = resolve(here, "..", "ui");
  if (existsSync(join(packaged, "index.html"))) return packaged;
  return resolve(here, "..", "..", "..", "packages", "ui", "dist");
}

function portFrom(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index === -1) return undefined;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "serve";

  switch (command) {
    case "serve": {
      // No flag means the host decides: FELLOWSHIP_PORT, else the default.
      const port = portFrom(argv);
      let running: Awaited<ReturnType<typeof serveMiniHost>>;
      try {
        running = await serveMiniHost({
          ...(port === undefined ? {} : { port }),
          uiDir: uiDir(),
        });
      } catch (error) {
        if (error instanceof HostAlreadyRunning) {
          process.stderr.write(`${error.message}\n`);
          return 3;
        }
        throw error;
      }
      process.stdout.write(
        [
          `Fellowship is up on ${running.url}`,
          `  silo     ${running.host.siloPath}`,
          `  host.db  ${running.host.hostPath}`,
          `  tools    ${running.host.api.describe().length}`,
          `  ui       ${join(uiDir(), "index.html")}`,
          "",
          "Ctrl+C to stop.",
          "",
        ].join("\n"),
      );

      const stop = async () => {
        await running.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void stop());
      process.on("SIGTERM", () => void stop());
      process.on("SIGHUP", () => void stop());

      // Started by Fellowship.app: go when it goes, even if it crashed and
      // never got to stop this process. No orphan keeps the silo open.
      const parent = Number(process.env["FELLOWSHIP_PARENT_PID"]);
      if (Number.isInteger(parent) && parent > 1) {
        setInterval(() => {
          if (!processAlive(parent)) void stop();
        }, 2000).unref();
      }
      return -1;
    }

    case "restart": {
      return restartHost();
    }

    case "app": {
      return desktopApp(argv[1] ?? "status");
    }

    case "whoami": {
      return whoami(argv.includes("--hook"));
    }

    case "mcp": {
      // stdout is the protocol here, so nothing else may write to it.
      await runStdioServer();
      return -1;
    }

    case "status": {
      const host = await startMiniHost();
      try {
        const [people, events, messages] = await Promise.all([
          host.silo.person.count(),
          host.silo.event.count(),
          host.silo.message.count(),
        ]);
        const pending = host.store.listProposals("pending").length;

        process.stdout.write(
          [
            `silo       ${host.siloPath}`,
            `host.db    ${host.hostPath}`,
            `people     ${people}`,
            `occasions  ${events}`,
            `messages   ${messages}`,
            `to review  ${pending}`,
            `tools      ${host.api.describe().length}`,
            "",
          ].join("\n"),
        );
      } finally {
        await host.close();
      }
      return 0;
    }

    case "tools": {
      const host = await startMiniHost();
      try {
        for (const tool of host.api.describe()) {
          process.stdout.write(`${tool.kind.padEnd(9)} ${tool.name.padEnd(26)} ${tool.title}\n`);
        }
      } finally {
        await host.close();
      }
      return 0;
    }

    case "import": {
      const file = argv[1];
      if (!file) {
        process.stderr.write("Usage: fellowship import <snapshot.json> [--replace --yes]\n");
        return 2;
      }

      const replace = argv.includes("--replace");
      const mode = replace ? "replace" : "merge";
      const snapshot: unknown = JSON.parse(readFileSync(file, "utf8"));
      const host = await startMiniHost();

      try {
        // Replace mode names the row counts it will destroy before it runs,
        // and will not run on the strength of one flag.
        if (replace) {
          const dryRun = (await host.api.invoke("people.import", {
            snapshot,
            mode,
            dryRun: true,
            confirmedByUser: true,
          })) as { wouldDestroy: Record<string, number> | null };

          const counts = Object.entries(dryRun.wouldDestroy ?? {})
            .filter(([, value]) => value > 0)
            .map(([name, value]) => `  ${name.padEnd(18)} ${value}`);

          process.stdout.write(
            [
              `This will destroy everything in ${host.siloPath}:`,
              ...(counts.length > 0 ? counts : ["  nothing, the silo is empty"]),
              "",
            ].join("\n"),
          );

          if (!argv.includes("--yes")) {
            process.stderr.write("Refusing a replace without --yes. Nothing was written.\n");
            return 1;
          }
        }

        const result = (await host.api.invoke("people.import", {
          snapshot,
          mode,
          confirmedByUser: true,
        })) as { counts: Record<string, number> };

        process.stdout.write(
          [
            `${mode} into ${host.siloPath}`,
            ...Object.entries(result.counts).map(
              ([name, value]) => `  ${name.padEnd(22)} ${value}`,
            ),
            "",
          ].join("\n"),
        );
      } finally {
        await host.close();
      }
      return 0;
    }

    case "export": {
      const file = argv[1];
      if (!file) {
        process.stderr.write("Usage: fellowship export <snapshot.json>\n");
        return 2;
      }

      const host = await startMiniHost();
      try {
        const snapshot = await host.api.invoke("people.export", {});
        writeFileSync(file, JSON.stringify(snapshot));
        const people = (snapshot as { people: unknown[] }).people.length;
        process.stdout.write(`Wrote ${file}: ${people} people, and everything attached.\n`);
      } finally {
        await host.close();
      }
      return 0;
    }

    case "reindex": {
      const host = await startMiniHost();
      try {
        const started = Date.now();
        await storage.rebuildSearchIndex(host.silo);
        const [people, notes, messages] = await Promise.all([
          host.silo.person.count(),
          host.silo.note.count(),
          host.silo.message.count(),
        ]);
        process.stdout.write(
          [
            `Rebuilt in ${Date.now() - started}ms`,
            `  people    ${people}`,
            `  notes     ${notes}`,
            `  messages  ${messages}`,
            "",
          ].join("\n"),
        );
      } finally {
        await host.close();
      }
      return 0;
    }

    case "verify": {
      const file = argv[1];
      if (!file) {
        process.stderr.write("Usage: fellowship verify <snapshot.json> [--keep]\n");
        return 2;
      }

      // A throwaway silo, so a file nobody has checked yet never gets near
      // the real one.
      const result = await verifySnapshot(file, { keep: argv.includes("--keep") });
      process.stdout.write(formatVerify(result));
      if (argv.includes("--keep")) {
        process.stdout.write(`kept            ${result.siloPath}\n`);
      }
      return result.ok ? 0 : 1;
    }

    case "paths": {
      process.stdout.write(`${storage.resolveDbPath()}\n${resolveHostDbPath()}\n`);
      return 0;
    }

    case "--help":
    case "-h":
    case "help": {
      process.stdout.write(USAGE);
      return 0;
    }

    default: {
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
    }
  }
}

/**
 * Reads the owner's own record without opening the silo for writing, so it is
 * safe beside a running host and fast enough for a session start hook. A
 * missing file or a record with nothing but a name both mean setup is to do.
 */
async function whoami(hook: boolean): Promise<number> {
  const path = storage.resolveDbPath();
  let self: Record<string, unknown> | undefined;
  let contacts = 0;
  if (existsSync(path)) {
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        self = db
          .prepare(
            `SELECT "id", "displayName", "firstName", "lastName", "birthday", "location"
             FROM "Person" WHERE "isSelf" = 1 LIMIT 1`,
          )
          .get() as Record<string, unknown> | undefined;
        if (self) {
          const row = db
            .prepare(`SELECT COUNT(*) AS "count" FROM "ContactChannel" WHERE "personId" = ?`)
            .get(self["id"] as string) as { count: number };
          contacts = row.count;
        }
      } finally {
        db.close();
      }
    } catch {
      // A file mid migration, or not a silo yet: treat as not set up.
      self = undefined;
    }
  }

  const missing = self
    ? [
        self["firstName"] ? null : "first name",
        self["lastName"] ? null : "last name",
        self["birthday"] ? null : "birthday",
        self["location"] ? null : "where you live",
        contacts > 0 ? null : "a way to reach you",
      ].filter((entry): entry is string => entry !== null)
    : ["your own record"];
  // Setup is to do when there is no record, or nothing on it but a name.
  const needed = !self || missing.length >= 4;

  if (hook) {
    const context: string[] = [];
    if (needed) {
      const message = self
        ? `Fellowship: the owner's own record ("${String(self["displayName"])}") has almost nothing on it (missing ${missing.join(", ")}).`
        : "Fellowship: there is no record of the owner yet, so closeness and the app's profile card have nothing to measure against.";
      context.push(
        `${message} When it fits the conversation, offer once to run /fellowship:setup, which asks a few questions and fills it in. Do not push if the user is busy with something else.`,
      );
    }
    const update = await updateOffer();
    if (update) context.push(update);

    if (context.length === 0) return 0;
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context.join("\n\n"),
        },
      })}\n`,
    );
    return 0;
  }

  if (!self) {
    process.stdout.write("No record of you yet. Run /fellowship:setup in an assistant, or add yourself in the app.\n");
    return 0;
  }
  process.stdout.write(
    [
      `you        ${String(self["displayName"])}`,
      `missing    ${missing.length > 0 ? missing.join(", ") : "nothing"}`,
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * The desktop app, for /fellowship:open. Installing downloads the build
 * attached to the GitHub release for the installed plugin's version, or this
 * build's own, and checks its hash before it replaces anything.
 */
async function desktopApp(action: string): Promise<number> {
  const status = desktopAppStatus();
  const version = readInstalledPlugin()?.version ?? FELLOWSHIP_VERSION;

  switch (action) {
    case "status": {
      process.stdout.write(
        [
          `app        ${status.version ? `${status.version} at ${status.path}` : "not installed"}`,
          `available  ${status.supported ? version : "none: the app is built for Apple Silicon Macs only"}`,
          "",
        ].join("\n"),
      );
      return 0;
    }
    case "install": {
      process.stdout.write(`Downloading Fellowship.app ${version} from its GitHub release...\n`);
      const result = await installDesktopApp({ version });
      process.stdout.write(`${result.message}\n`);
      return result.ok ? 0 : 1;
    }
    case "open": {
      if (!status.version) {
        process.stdout.write("Fellowship.app is not installed. Run: fellowship app install\n");
        return 1;
      }
      await openDesktopApp();
      process.stdout.write(`Opened Fellowship.app ${status.version}.\n`);
      return 0;
    }
    default:
      process.stderr.write(`Unknown app action "${action}". Use status, install or open.\n`);
      return 2;
  }
}

/**
 * The update half of the session start hook. Silent unless the owner turned
 * the check on and a newer release than the installed plugin is out. The
 * answer is cached beside host.db for a day, so most sessions never reach the
 * network, and a slow GitHub costs at most the fetch timeout.
 */
async function updateOffer(): Promise<string | null> {
  try {
    const hostDbPath = resolveHostDbPath();
    const status = await checkForUpdates({
      enabled: readUpdatesEnabled(hostDbPath),
      hostDbPath,
    });
    if (!status.updateAvailable || !status.installed || !status.latest) return null;
    return `Fellowship: version ${status.latest.version} of the plugin is out (${status.installed.version} is installed). Release notes: ${status.latest.url}. When it fits the conversation, offer once to update it: run \`${status.command}\`, or press the update button in the Fellowship app, then restart Claude Code to load it. Do not push if the user is busy with something else.`;
  } catch {
    return null;
  }
}

/**
 * Stops the live host and starts it again the way it was started, detached,
 * logging beside host.db. Used after a commit so a host left running does not
 * keep serving yesterday's code to today's UI.
 */
async function restartHost(): Promise<number> {
  const lockPath = hostLockPath(resolveHostDbPath());
  const live = await liveHostLock(lockPath);
  if (!live) {
    process.stdout.write("No host is running. Nothing to restart.\n");
    return 0;
  }
  if (live.owner === "desktop") {
    process.stdout.write(
      `The running host (pid ${live.pid}) belongs to Fellowship.app. Restart the app to restart it.\n`,
    );
    return 0;
  }

  process.stdout.write(`Stopping the host on ${live.url ?? "?"} (pid ${live.pid})\n`);
  process.kill(live.pid, "SIGTERM");
  const stopBy = Date.now() + 15_000;
  while (processAlive(live.pid)) {
    if (Date.now() > stopBy) {
      process.stderr.write(`pid ${live.pid} did not stop within 15 seconds. Not starting another.\n`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const log = join(dirname(lockPath), "host.log");
  const out = openSync(log, "a");
  const child = spawn(live.execPath, [...live.execArgv, ...live.argv.slice(1)], {
    cwd: live.cwd,
    env: { ...process.env, ...live.env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  const port = live.port;
  const upBy = Date.now() + 45_000;
  while (Date.now() < upBy) {
    if (port !== null && child.pid !== undefined && (await healthPid(port)) === child.pid) {
      process.stdout.write(`Restarted on ${live.url} (pid ${child.pid}). Log: ${log}\n`);
      return 0;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  process.stderr.write(`The host did not come back. Its log is ${log}\n`);
  return 1;
}

const code = await main(process.argv.slice(2));
if (code >= 0) process.exit(code);
