import { activate, type ModuleApi } from "../../src/activate.js";
import { DEFAULT_CONFIG, type ModuleConfig } from "../../src/config/index.js";
import type {
  AuditEntry,
  FetchedImage,
  HostPorts,
  ModuleEventName,
  Proposal,
  QueuedProposal,
} from "../../src/ports.js";
import { openSilo, type Silo } from "../../src/storage/client.js";
import { ToolError } from "../../src/tools/registry.js";
import { freshSiloPath } from "../storage/throwaway.js";

/**
 * A host made of nothing but records: a real migrated silo, and a port for
 * every outward thing the module can reach, each one keeping what it was asked
 * to do. The gates assert against these.
 *
 * The media port is the only one that can produce bytes, and it produces them
 * from this file rather than from the network: a gate that proves the module
 * never fetches is worthless if the test harness fetches for it.
 */

export interface TestHost {
  api: ModuleApi;
  ports: HostPorts;
  db: Silo;
  audit: AuditEntry[];
  events: Array<{ name: ModuleEventName; payload: Record<string, unknown> }>;
  proposals: QueuedProposal[];
  redactions: string[];
  mediaCalls: string[];
  completions: number;
  config: ModuleConfig;
  /** What the media port will hand back next. */
  nextImage: FetchedImage;
  close(): Promise<void>;
}

export const SAMPLE_IMAGE_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
]) as Uint8Array<ArrayBuffer>;

export async function testHost(
  config: Partial<ModuleConfig> = {},
): Promise<TestHost> {
  const db = await openSilo({ path: freshSiloPath() });

  const host: TestHost = {
    api: undefined as unknown as ModuleApi,
    ports: undefined as unknown as HostPorts,
    db,
    audit: [],
    events: [],
    proposals: [],
    redactions: [],
    mediaCalls: [],
    completions: 0,
    config: { ...DEFAULT_CONFIG, ...config },
    nextImage: {
      bytes: SAMPLE_IMAGE_BYTES,
      mime: "image/png",
      sourceUrl: "https://example.test/picture.png",
    },
    close: async () => {
      await db.$disconnect();
    },
  };

  host.ports = {
    storage: { silo: () => db },
    models: {
      complete: async () => {
        host.completions += 1;
        return { text: "{}" };
      },
      embed: async (texts) => texts.map(() => [0]),
    },
    review: {
      propose: async (proposal: Proposal) => {
        const id = `proposal-${host.proposals.length + 1}`;
        host.proposals.push({
          ...proposal,
          id,
          state: "pending",
          createdAt: new Date().toISOString(),
          decidedAt: null,
        });
        return { id };
      },
      list: async (state = "pending") =>
        host.proposals.filter((row) => state === "all" || row.state === state),
      get: async (id) => host.proposals.find((row) => row.id === id) ?? null,
      decide: async (id, state) => {
        const row = host.proposals.find((entry) => entry.id === id);
        if (!row || row.state !== "pending") return false;
        row.state = state;
        row.decidedAt = new Date().toISOString();
        return true;
      },
    },
    bus: {
      emit: (name, payload) => {
        host.events.push({ name, payload });
      },
    },
    connectors: {
      pull: async () => ({ items: [], cursor: null }),
      readChatExport: async () => {
        throw new ToolError("unavailable", "The test host reads no files.");
      },
    },
    privacy: {
      redact: (text) => {
        host.redactions.push(text);
        return text;
      },
    },
    audit: {
      log: async (entry) => {
        host.audit.push(entry);
      },
    },
    settings: {
      get: async () => host.config,
      set: async (patch) => {
        host.config = { ...host.config, ...patch };
        return host.config;
      },
    },
    refs: {
      resolve: async (ref) => ({
        status: "unavailable",
        ref,
        reason: "The mini-host hosts one module.",
      }),
    },
    media: {
      fetchImage: async (url) => {
        host.mediaCalls.push(url);
        return host.nextImage;
      },
    },
  };

  host.api = activate(host.ports);
  return host;
}

/** The owner's own record, which closeness and the graph are defined against. */
export async function seedSelf(host: TestHost, displayName = "Me") {
  const result = (await host.api.invoke("people.create", { displayName })) as {
    person: { id: string };
  };
  await host.db.person.update({
    where: { id: result.person.id },
    data: { isSelf: true },
  });
  return result.person.id;
}

export async function seedPerson(host: TestHost, displayName: string) {
  const result = (await host.api.invoke("people.create", { displayName })) as {
    person: { id: string };
  };
  return result.person.id;
}
