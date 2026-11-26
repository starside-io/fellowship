import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { storage } from "@fellowship/core";
import type { ConnectorPull, ConnectorsPort } from "@fellowship/core";

import { readChatExportFile, resolveImportRoots } from "./chat-file.js";
import type { HostStore } from "./host-store.js";

/**
 * The chat-export connector, which is the only one the mini-host has.
 *
 * The module reads no files. This does, from one directory the user drops
 * exports into, and hands over normalized items. The cursor is the newest
 * modified time already handed over, kept in host.db so a restart does not
 * replay the inbox.
 *
 * It also reads one named export for people.import_chat's filePath, from the
 * import roots only: see chat-file.ts.
 */

export const INBOX_ENV = "FELLOWSHIP_INBOX";
export const CHAT_EXPORT_CONNECTOR = "chat-export";

/** Where exports are picked up from. Beside the database by default. */
export function resolveInbox(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[INBOX_ENV]?.trim();
  if (override) return override;
  return join(dirname(storage.resolveDbPath(env)), "inbox");
}

export interface ChatExportItem {
  fileName: string;
  text: string;
  modifiedAt: string;
}

export function createConnectorsPort(
  store: HostStore,
  options: { inbox?: string; env?: NodeJS.ProcessEnv } = {},
): ConnectorsPort {
  const inbox = options.inbox ?? resolveInbox(options.env);
  const importRoots = resolveImportRoots(options.env ?? process.env, inbox);

  return {
    readChatExport: (path: string) => readChatExportFile(path, importRoots),


    async pull(connector: string, cursor?: string | null): Promise<ConnectorPull> {
      if (connector !== CHAT_EXPORT_CONNECTOR) {
        throw new Error(
          `The mini-host has one connector, "${CHAT_EXPORT_CONNECTOR}". Asked for "${connector}".`,
        );
      }

      const since = cursor ?? store.readCursor(CHAT_EXPORT_CONNECTOR);
      const sinceTime = since ? Date.parse(since) : 0;

      let names: string[];
      try {
        names = readdirSync(inbox).filter((name) => name.toLowerCase().endsWith(".txt"));
      } catch {
        // No inbox is not an error: it means nothing has been dropped in yet.
        return { items: [], cursor: since ?? null };
      }

      const items = [];
      let newest = sinceTime;

      for (const name of names.sort()) {
        const full = join(inbox, name);
        const modified = statSync(full).mtime;
        if (modified.getTime() <= sinceTime) continue;

        items.push({
          id: name,
          payload: {
            fileName: name,
            text: readFileSync(full, "utf8"),
            modifiedAt: modified.toISOString(),
          } satisfies ChatExportItem,
        });
        newest = Math.max(newest, modified.getTime());
      }

      const next = newest > 0 ? new Date(newest).toISOString() : null;
      if (items.length > 0) store.writeCursor(CHAT_EXPORT_CONNECTOR, next);

      return { items, cursor: next };
    },
  };
}
