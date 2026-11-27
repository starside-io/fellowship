import { activate, domain, storage, type ModuleApi } from "@fellowship/core";
import type { HostPorts, ModuleConfig, Silo } from "@fellowship/core";

import { openHostDb, resolveHostDbPath, type HostDb } from "./host-db.js";
import { HostStore, createPorts } from "./ports/index.js";

/**
 * The mini-host itself: one process, two SQLite files, one module.
 *
 * It owns the silo and is its only writer. Everything the module can reach
 * goes through the ports built here, so the standalone app and a host kernel
 * differ in what is behind the ports and in nothing else.
 */

export interface MiniHost {
  api: ModuleApi;
  ports: HostPorts;
  silo: Silo;
  host: HostDb;
  store: HostStore;
  config(): ModuleConfig;
  siloPath: string;
  hostPath: string;
  close(): Promise<void>;
}

export interface MiniHostOptions {
  /** The silo. Defaults to the platform path, or FELLOWSHIP_DB_PATH. */
  dbPath?: string;
  /** host.db. Defaults to beside the silo, or FELLOWSHIP_HOST_DB_PATH. */
  hostDbPath?: string;
  inbox?: string;
  env?: NodeJS.ProcessEnv;
}

export async function startMiniHost(options: MiniHostOptions = {}): Promise<MiniHost> {
  const env = options.env ?? process.env;
  const siloPath = options.dbPath ?? storage.resolveDbPath(env);
  const hostPath = options.hostDbPath ?? resolveHostDbPath(env);

  // A file that is not there yet, or is behind, is brought up to date before
  // it is opened: an assistant driving this over stdio has no other way to run
  // a migration, and refusing to start would make "no UI at all" a lie.
  const migration = storage.migrateSilo(siloPath);
  if (migration.changed.length > 0) {
    process.stderr.write(
      `Warning: ${migration.changed.join(", ")} changed since it was applied to ${siloPath}.\n`,
    );
  }

  // openSilo asserts the pragmas and refuses a file where foreign keys are off.
  const silo = await storage.openSilo({ path: siloPath });
  const host = openHostDb(hostPath);
  const store = new HostStore(host);

  const { ports, readConfig } = createPorts({
    silo,
    store,
    ...(options.inbox ? { inbox: options.inbox } : {}),
    ...(options.env ? { env: options.env } : {}),
  });

  await rescoreIfFormulaChanged(silo, store, readConfig());

  return {
    api: activate(ports),
    ports,
    silo,
    host,
    store,
    config: readConfig,
    siloPath,
    hostPath,
    close: async () => {
      host.close();
      await silo.$disconnect();
    },
  };
}

/** The host.db setting naming the formula the cached scores were computed by. */
export const SCORING_VERSION_SETTING = "scoring.version";

/**
 * LinkStat.score is a cache of the closeness formula. When a new build brings
 * a new formula, every cached score is from the old one until something
 * touches that pair, and a pair nothing touches never recovers. So the first
 * host on the new formula rebuilds them all, once.
 */
export async function rescoreIfFormulaChanged(
  silo: Silo,
  store: HostStore,
  config: ModuleConfig,
): Promise<boolean> {
  const version = domain.scoring.SCORING_VERSION;
  if (store.readSetting(SCORING_VERSION_SETTING) === version) return false;
  await domain.linkEngine.recomputeAll(silo, new Date(), {
    halfLifeDays: config.halfLifeDays,
    scoreScale: config.scoreScale,
  });
  store.writeSetting(SCORING_VERSION_SETTING, version);
  return true;
}
