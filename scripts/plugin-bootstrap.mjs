#!/usr/bin/env node
// Makes a plugin install runnable.
//
// A plugin installed from the marketplace is a checkout of this repo with no
// node_modules and no build output, because neither is committed. This script
// is what .mcp.json and the SessionStart hook run instead of the built files:
// it builds the checkout the first time, then hands over.
//
//   node scripts/plugin-bootstrap.mjs mcp     build if needed, then serve MCP on stdio
//   node scripts/plugin-bootstrap.mjs hook    SessionStart: start a build in the
//                                             background if needed, else ask whoami
//   node scripts/plugin-bootstrap.mjs build   build now, in the foreground
//
// No dependencies of its own: it has to run before there are any. stdout is the
// MCP protocol in `mcp` mode and the hook payload in `hook` mode, so every
// line meant for a person goes to stderr or to the log.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockDir = join(root, ".plugin-build.lock");
const logPath = join(root, ".plugin-build.log");

/** What a plugin session needs: the MCP server, the CLI for the hook, the UI. */
const OUTPUTS = [
  "packages/mini-host/dist/mcp.js",
  "apps/fellowship/dist/cli.js",
  "packages/ui/dist/index.html",
];

/** A build that has not finished in this long is taken to have died. */
const STALE_LOCK_MS = 15 * 60_000;

function built() {
  return OUTPUTS.every((path) => existsSync(join(root, path)));
}

function building() {
  if (!existsSync(lockDir)) return false;
  if (Date.now() - statSync(lockDir).mtimeMs > STALE_LOCK_MS) {
    rmSync(lockDir, { recursive: true, force: true });
    return false;
  }
  return true;
}

/**
 * pnpm through corepack, which ships with Node 22, so nothing has to be
 * installed globally first. The version comes from packageManager in
 * package.json.
 */
function pnpm(args, out) {
  const result = spawnSync("corepack", ["pnpm", ...args], {
    cwd: root,
    stdio: ["ignore", out, out],
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "true" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed (exit ${result.status}). Log: ${logPath}`);
  }
}

/** Install, generate the database client, build. Returns false if another build holds the lock. */
function build() {
  try {
    mkdirSync(lockDir);
  } catch {
    return false;
  }
  const out = openSync(logPath, "a");
  try {
    pnpm(["install", "--frozen-lockfile"], out);
    pnpm(["--filter", "@fellowship/core", "db:generate"], out);
    pnpm(["build"], out);
    return true;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function waitForBuild(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (building() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function ensureBuilt() {
  if (built()) return;
  if (building()) await waitForBuild(10 * 60_000);
  if (built()) return;
  process.stderr.write(
    "Fellowship: first run, installing and building (a minute or two). Log: " + logPath + "\n",
  );
  if (!build()) await waitForBuild(10 * 60_000);
  if (!built()) throw new Error(`The build did not finish. Log: ${logPath}`);
}

async function mcp() {
  await ensureBuilt();
  const entry = join(root, "packages/mini-host/dist/mcp.js");
  const { runStdioServer } = await import(pathToFileURL(entry).href);
  await runStdioServer();
}

function hook() {
  if (built()) {
    const result = spawnSync(
      process.execPath,
      [join(root, "apps/fellowship/dist/cli.js"), "whoami", "--hook"],
      { cwd: root, stdio: ["ignore", "inherit", "ignore"] },
    );
    return result.status ?? 0;
  }

  // Not built yet: start the build where it will outlive this hook, and tell
  // the session why the Fellowship tools may not be there yet.
  if (!building()) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "build"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "Fellowship was just installed and is building itself in the background (a minute or two, it needs Node 22 or later and a network connection). If the Fellowship tools are not listed yet, they will be in the next session, or after /mcp reconnects the server. Once they are, offer /fellowship:setup.",
      },
    })}\n`,
  );
  return 0;
}

const mode = process.argv[2] ?? "mcp";
try {
  if (mode === "mcp") {
    await mcp();
  } else if (mode === "hook") {
    process.exitCode = hook();
  } else if (mode === "build") {
    if (!built() && !build()) await waitForBuild(10 * 60_000);
    process.exitCode = built() ? 0 : 1;
  } else {
    process.stderr.write("Usage: plugin-bootstrap.mjs mcp | hook | build\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(
    `Fellowship: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
