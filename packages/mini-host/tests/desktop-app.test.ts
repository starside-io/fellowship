import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  appAssetName,
  desktopAppPath,
  installDesktopApp,
  installedAppVersion,
} from "../src/desktop-app.js";
import { createApp } from "../src/server.js";
import { installUpdate, type CommandRunner } from "../src/updates.js";
import { throwawayHost } from "./harness.js";

/**
 * Fellowship.app from a release. GitHub is a stand in serving a fake zip, and
 * the "unzip" writes a bundle with the version the test says, so nothing is
 * downloaded and no real app is touched.
 */

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>`;
}

function writeBundle(at: string, version: string) {
  mkdirSync(join(at, "Contents"), { recursive: true });
  writeFileSync(join(at, "Contents", "Info.plist"), plist(version));
}

/** An unzip that unpacks a Fellowship.app of the given version. */
function unzipTo(version: string) {
  return async (_zip: string, into: string) => writeBundle(join(into, "Fellowship.app"), version);
}

function appDir(): NodeJS.ProcessEnv {
  return { FELLOWSHIP_APP_DIR: mkdtempSync(join(tmpdir(), "fellowship-apps-")) };
}

/** GitHub as far as the installer sees it: one release with the zip and its hash. */
function github(version: string, options: { hash?: string; withZip?: boolean } = {}) {
  const zip = Buffer.from(`zip for ${version}`);
  const hash = options.hash ?? createHash("sha256").update(zip).digest("hex");
  const name = appAssetName(version);
  const assets = [
    ...(options.withZip === false
      ? []
      : [{ name, browser_download_url: "https://dl/zip", size: zip.length }]),
    { name: `${name}.sha256`, browser_download_url: "https://dl/sha", size: 80 },
  ];
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith(`/releases/tags/v${version}`)) {
      return new Response(JSON.stringify({ assets }), { status: 200 });
    }
    if (href.includes("/releases/tags/")) return new Response("{}", { status: 404 });
    if (href === "https://dl/zip") return new Response(zip, { status: 200 });
    if (href === "https://dl/sha") return new Response(`${hash}  ${name}\n`, { status: 200 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("installDesktopApp", () => {
  it("installs the build attached to the release, replacing an older app", async () => {
    const env = appDir();
    writeBundle(desktopAppPath(env), "0.0.3");

    const result = await installDesktopApp({
      version: "0.0.5",
      env,
      fetch: github("0.0.5"),
      unzip: unzipTo("0.0.5"),
      supported: true,
    });

    expect(result).toMatchObject({ ok: true, version: "0.0.5" });
    expect(installedAppVersion(desktopAppPath(env))).toBe("0.0.5");
  });

  it("refuses a download that does not match the published hash, and keeps the old app", async () => {
    const env = appDir();
    writeBundle(desktopAppPath(env), "0.0.3");

    const result = await installDesktopApp({
      version: "0.0.5",
      env,
      fetch: github("0.0.5", { hash: "0".repeat(64) }),
      unzip: unzipTo("0.0.5"),
      supported: true,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match the hash/);
    expect(installedAppVersion(desktopAppPath(env))).toBe("0.0.3");
  });

  it("refuses a zip that holds another version", async () => {
    const env = appDir();
    const result = await installDesktopApp({
      version: "0.0.5",
      env,
      fetch: github("0.0.5"),
      unzip: unzipTo("0.0.4"),
      supported: true,
    });
    expect(result.ok).toBe(false);
    expect(installedAppVersion(desktopAppPath(env))).toBeNull();
  });

  it("says so when the release has no app, or there is no such release", async () => {
    const env = appDir();
    const noZip = await installDesktopApp({
      version: "0.0.5",
      env,
      fetch: github("0.0.5", { withZip: false }),
      supported: true,
    });
    expect(noZip.message).toMatch(/no desktop app attached/);

    const noRelease = await installDesktopApp({
      version: "9.9.9",
      env,
      fetch: github("0.0.5"),
      supported: true,
    });
    expect(noRelease.message).toMatch(/no 9\.9\.9 release/);
  });

  it("downloads nothing on a machine the app is not built for", async () => {
    const fetch = github("0.0.5");
    const result = await installDesktopApp({ version: "0.0.5", env: appDir(), fetch, supported: false });
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the plugin update and the app", () => {
  function claude(version: string): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), "fellowship-claude-"));
    mkdirSync(join(dir, "plugins"));
    writeFileSync(
      join(dir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "fellowship@starside": [{ scope: "user", version, installPath: "/x" }] },
      }),
    );
    return { CLAUDE_CONFIG_DIR: dir, PATH: "" };
  }
  const run: CommandRunner = async () => ({ code: 0, output: "" });

  it("brings an installed app up to the new plugin version", async () => {
    const env = { ...claude("0.0.5"), ...appDir() };
    writeBundle(desktopAppPath(env), "0.0.4");

    const result = await installUpdate({
      env,
      run,
      claudePath: "/bin/claude",
      app: { fetch: github("0.0.5"), unzip: unzipTo("0.0.5"), supported: true },
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Fellowship.app is now 0.0.5");
    expect(installedAppVersion(desktopAppPath(env))).toBe("0.0.5");
  });

  it("does not install an app nobody asked for", async () => {
    const env = { ...claude("0.0.5"), ...appDir() };
    const fetch = github("0.0.5");
    await installUpdate({
      env,
      run,
      claudePath: "/bin/claude",
      app: { fetch, unzip: unzipTo("0.0.5"), supported: true },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(installedAppVersion(desktopAppPath(env))).toBeNull();
  });
});

describe("the /host/app routes", () => {
  it("report the app and install it only on a JSON post", async () => {
    const host = await throwawayHost();
    try {
      const env = appDir();
      const app = createApp(host, {
        updates: {
          env,
          fetch: github("0.0.5"),
          app: { unzip: unzipTo("0.0.5"), supported: true },
        },
      });

      const before = (await (await app.request("/host/app")).json()) as {
        version: string | null;
        supported: boolean;
      };
      expect(before).toMatchObject({ version: null, supported: true });

      const form = await app.request("/host/app/install", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      expect(form.status).toBe(415);
    } finally {
      await host.close();
    }
  });
});
