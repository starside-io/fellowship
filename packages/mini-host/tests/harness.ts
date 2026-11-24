import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMiniHost, type MiniHost } from "../src/host.js";

/**
 * A throwaway pair of files, migrated on the way up by the host itself.
 * Never point a test at the real silo: it holds real people's records.
 */
export async function throwawayHost(options: { inbox?: string } = {}): Promise<MiniHost> {
  const dir = mkdtempSync(join(tmpdir(), "fellowship-host-"));
  return startMiniHost({
    dbPath: join(dir, "fellowship.db"),
    hostDbPath: join(dir, "host.db"),
    ...(options.inbox ? { inbox: options.inbox } : {}),
  });
}

export async function seedPerson(host: MiniHost, displayName: string): Promise<string> {
  const result = (await host.api.invoke("people.create", { displayName })) as {
    person: { id: string };
  };
  return result.person.id;
}

export async function seedSelf(host: MiniHost, displayName = "Me"): Promise<string> {
  const id = await seedPerson(host, displayName);
  await host.silo.person.update({ where: { id }, data: { isSelf: true } });
  return id;
}
