import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HostAlreadyRunning,
  acquireHostLock,
  describeThisProcess,
  hostLockPath,
  processAlive,
  readHostLock,
  releaseHostLock,
  type HostLock,
} from "../src/host-lock.js";
import { serveMiniHost } from "../src/server.js";

/**
 * One host at a time. The lock sits beside host.db in a throwaway directory
 * here, never beside the real one.
 */

function throwawayDir(): string {
  return mkdtempSync(join(tmpdir(), "fellowship-lock-"));
}

function filesIn(dir: string) {
  return { dbPath: join(dir, "fellowship.db"), hostDbPath: join(dir, "host.db") };
}

function lockFor(pid: number, overrides: Partial<HostLock> = {}): HostLock {
  return { ...describeThisProcess("test-fingerprint"), pid, ...overrides };
}

function writeLock(path: string, lock: HostLock): void {
  writeFileSync(path, JSON.stringify(lock, null, 2));
}

/** A pid that was real a moment ago and is not any more. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("The child did not start");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

const children: ChildProcess[] = [];

/**
 * Another live process that answers /health with its own pid, which is what
 * a second host process holding the lock looks like from here.
 */
async function otherHost(): Promise<{ pid: number; port: number }> {
  const script = `
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port) + "\\n");
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
  return { pid: child.pid!, port };
}

afterEach(async () => {
  // Only the children this file spawned, by handle.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  }
});

describe("acquireHostLock", () => {
  it("writes the lock on an empty directory", async () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    expect(existsSync(path)).toBe(false);

    const lock = describeThisProcess("abc123");
    await acquireHostLock(path, lock);

    expect(readHostLock(path)).toEqual(lock);
    expect(readHostLock(path)).toMatchObject({ pid: process.pid, port: null, url: null });
  });

  it("replaces a lock left by a process that died", async () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    const pid = await deadPid();
    expect(processAlive(pid)).toBe(false);
    writeLock(path, lockFor(pid, { port: 1, url: "http://127.0.0.1:1" }));

    await acquireHostLock(path, describeThisProcess("fresh"));

    expect(readHostLock(path)).toMatchObject({ pid: process.pid, fingerprint: "fresh" });
  });

  it("replaces a lock whose port answers with another pid", async () => {
    // The pid is alive, but nothing on its recorded port says it is that pid.
    const other = await otherHost();
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    writeLock(path, lockFor(process.ppid, { port: other.port }));

    await acquireHostLock(path, describeThisProcess("fresh"));

    expect(readHostLock(path)).toMatchObject({ pid: process.pid });
  });

  it("refuses while another live host holds it", async () => {
    const other = await otherHost();
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    writeLock(path, lockFor(other.pid, { port: other.port }));

    const attempt = acquireHostLock(path, describeThisProcess("second"));
    await expect(attempt).rejects.toBeInstanceOf(HostAlreadyRunning);
    await expect(attempt).rejects.toMatchObject({ lock: { pid: other.pid } });
    expect(readHostLock(path)).toMatchObject({ pid: other.pid });
  });

  it("refuses while another live host is still binding its port", async () => {
    const other = await otherHost();
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    writeLock(path, lockFor(other.pid, { port: null, startedAt: new Date().toISOString() }));

    await expect(acquireHostLock(path, describeThisProcess("second"))).rejects.toBeInstanceOf(
      HostAlreadyRunning,
    );
  });
});

describe("releaseHostLock", () => {
  it("removes this process's own lock", async () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    await acquireHostLock(path, describeThisProcess("mine"));
    releaseHostLock(path);
    expect(existsSync(path)).toBe(false);
  });

  it("leaves another pid's lock alone", () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    writeLock(path, lockFor(process.ppid));
    releaseHostLock(path);
    expect(readHostLock(path)).toMatchObject({ pid: process.ppid });
  });

  it("does nothing when there is no lock", () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    expect(() => releaseHostLock(path)).not.toThrow();
  });
});

describe("serveMiniHost and the lock", () => {
  it("takes the lock, records the port, and releases it on close", async () => {
    const dir = throwawayDir();
    const files = filesIn(dir);
    const path = hostLockPath(files.hostDbPath);

    const running = await serveMiniHost({ ...files, port: 0 });
    try {
      expect(readHostLock(path)).toMatchObject({
        pid: process.pid,
        port: running.port,
        url: running.url,
      });
    } finally {
      await running.close();
    }
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to start beside another live host, and leaves its files alone", async () => {
    const other = await otherHost();
    const dir = throwawayDir();
    const files = filesIn(dir);
    const path = hostLockPath(files.hostDbPath);
    writeLock(path, lockFor(other.pid, { port: other.port }));

    await expect(serveMiniHost({ ...files, port: 0 })).rejects.toBeInstanceOf(
      HostAlreadyRunning,
    );
    // Refused before the files were opened.
    expect(existsSync(files.dbPath)).toBe(false);
    expect(existsSync(files.hostDbPath)).toBe(false);
    expect(readHostLock(path)).toMatchObject({ pid: other.pid });
  });

  it("starts over a lock left by a host that died", async () => {
    const dir = throwawayDir();
    const files = filesIn(dir);
    const path = hostLockPath(files.hostDbPath);
    writeLock(path, lockFor(await deadPid(), { port: 1 }));

    const running = await serveMiniHost({ ...files, port: 0 });
    try {
      expect(readHostLock(path)).toMatchObject({ pid: process.pid, port: running.port });
    } finally {
      await running.close();
    }
  });

  it("answers /health with this pid and a fingerprint", async () => {
    const running = await serveMiniHost({ ...filesIn(throwawayDir()), port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/health`);
      const body = (await response.json()) as { ok: boolean; pid: number; fingerprint: unknown };
      expect(body.ok).toBe(true);
      expect(body.pid).toBe(process.pid);
      expect(typeof body.fingerprint).toBe("string");
      expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(readHostLock(hostLockPath(running.host.hostPath))?.fingerprint).toBe(
        body.fingerprint,
      );
    } finally {
      await running.close();
    }
  });
});
