import { EventEmitter } from "node:events";

import { config as coreConfig, domain } from "@fellowship/core";
import type {
  AuditPort,
  BusPort,
  HostPorts,
  ModuleConfig,
  ModuleEventName,
  PrivacyPort,
  QueuedProposal,
  RefsPort,
  ReviewPort,
  SettingsPort,
  Silo,
  StoragePort,
} from "@fellowship/core";

import { createConnectorsPort } from "./connectors.js";
import { createMediaPort } from "./media.js";
import { createModelsPort } from "./models.js";
import { HostStore, type ProposalRow } from "./host-store.js";

export * from "./host-store.js";
export * from "./connectors.js";
export * from "./media.js";
export * from "./models.js";

const SETTINGS_KEY = "module.config";

export interface PortsOptions {
  silo: Silo;
  store: HostStore;
  /** In-process listeners for the bus. The UI feed reads host.db instead. */
  emitter?: EventEmitter;
  inbox?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MiniHostPorts {
  ports: HostPorts;
  emitter: EventEmitter;
  /** Reads the stored config without going through the port. */
  readConfig(): ModuleConfig;
}

/**
 * Every port the module can reach, over one silo and one host.db.
 *
 * The two that carry a rule rather than a lookup:
 *
 * settings.set recomputes every link before a change to halfLifeDays or
 * scoreScale counts as applied. LinkStat.score is a cache of those two, so
 * saving a new half life without the recompute leaves every cached score
 * silently wrong, and a pair with no new events never recovers.
 *
 * privacy.redact is the identity function and stays that way. read_messages
 * returns real message text on purpose, and a redactor that did nothing but
 * look like protection would be worse than none.
 */
export function createPorts(options: PortsOptions): MiniHostPorts {
  const { silo, store } = options;
  const emitter = options.emitter ?? new EventEmitter();

  function readConfig(): ModuleConfig {
    const stored = store.readSetting(SETTINGS_KEY);
    const parsed = coreConfig.moduleConfigSchema.safeParse(stored ?? {});
    if (parsed.success) return parsed.data;

    // A hand edited row that no longer validates falls back to the defaults
    // rather than taking the host down with it.
    process.stderr.write(
      `The stored module config is invalid, using the defaults: ${parsed.error.message}\n`,
    );
    return coreConfig.DEFAULT_CONFIG;
  }

  const storagePort: StoragePort = { silo: () => silo };

  const settings: SettingsPort = {
    get: async () => readConfig(),
    set: async (patch) => {
      const before = readConfig();
      const next = coreConfig.moduleConfigSchema.parse({ ...before, ...patch });

      if (coreConfig.needsScoreRecompute(before, next)) {
        // Before the new value counts as applied, not after.
        await domain.linkEngine.recomputeAll(silo, new Date(), {
          halfLifeDays: next.halfLifeDays,
          scoreScale: next.scoreScale,
        });
      }

      store.writeSetting(SETTINGS_KEY, next);
      return next;
    },
  };

  const queued = (row: ProposalRow): QueuedProposal => ({
    id: row.id,
    tool: row.tool,
    personId: row.personId,
    payload: row.payload,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.group === null ? {} : { group: row.group }),
    state: row.state,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  });

  const review: ReviewPort = {
    propose: async (proposal) => store.propose(proposal),
    list: async (state = "pending") => store.listProposals(state).map(queued),
    get: async (id) => {
      const row = store.getProposal(id);
      return row ? queued(row) : null;
    },
    decide: async (id, state) => store.decideProposal(id, state),
  };

  const bus: BusPort = {
    emit: (name: ModuleEventName, payload) => {
      // Appended after the write that produced it, so the feed never shows an
      // event for a transaction that did not land.
      store.recordEvent(name, payload);
      emitter.emit(name, payload);
      emitter.emit("*", { name, payload });
    },
  };

  const audit: AuditPort = {
    log: async (entry) => {
      store.logAudit(entry);
    },
  };

  const privacy: PrivacyPort = { redact: (text) => text };

  const refs: RefsPort = {
    resolve: async (ref) => {
      const match = /^module:\/\/people\/person\/([0-9a-fA-F-]{36})$/.exec(ref.trim());
      if (!match) {
        return {
          status: "unavailable",
          ref,
          reason: "The mini-host hosts one module, so only a people ref resolves.",
        };
      }

      const person = await silo.person.findUnique({
        where: { id: match[1] as string },
        select: { id: true, displayName: true, archived: true },
      });
      if (!person) {
        return { status: "unavailable", ref, reason: "No person with that id." };
      }

      return {
        status: "resolved",
        ref,
        label: person.displayName,
        detail: { personId: person.id, archived: person.archived },
      };
    },
  };

  const ports: HostPorts = {
    storage: storagePort,
    models: createModelsPort({ ...(options.env ? { env: options.env } : {}) }),
    review,
    bus,
    connectors: createConnectorsPort(store, {
      ...(options.inbox ? { inbox: options.inbox } : {}),
      ...(options.env ? { env: options.env } : {}),
    }),
    privacy,
    audit,
    settings,
    refs,
    media: createMediaPort(),
  };

  return { ports, emitter, readConfig };
}
