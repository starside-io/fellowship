import type { ModuleConfig } from "./config/index.js";
import type { Silo } from "./storage/client.js";

/**
 * The only thing core knows about a host.
 *
 * Everything that reaches outside the silo is here: the model, the review
 * queue, the event bus, the connectors, the audit log, the settings store, the
 * reference resolver and the image fetch. A module that holds this interface
 * runs on the mini-host, on a host kernel, or on a test double, and cannot tell
 * the difference.
 *
 * What is deliberately absent: a network client, a filesystem, a logger that
 * writes anywhere, and any way to reach another module's data.
 */
export interface HostPorts {
  storage: StoragePort;
  models: ModelsPort;
  review: ReviewPort;
  bus: BusPort;
  connectors: ConnectorsPort;
  privacy: PrivacyPort;
  audit: AuditPort;
  settings: SettingsPort;
  refs: RefsPort;
  media: MediaPort;
}

/** The silo, and nothing else. One writer, pragmas already asserted. */
export interface StoragePort {
  silo(): Silo;
}

export interface CompletionRequest {
  prompt: string;
  system?: string;
  /**
   * A JSON schema the answer must fit. Passed through as constrained decoding
   * where the server supports it, and validated on the way back regardless,
   * because a server that ignores it fails silently otherwise.
   */
  schema?: unknown;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  text: string;
}

export interface ModelsPort {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  embed(texts: string[]): Promise<number[][]>;
}

/** A write an assistant wants, waiting for the user to confirm or discard. */
export interface Proposal {
  /** The tool that would run on confirmation. */
  tool: string;
  personId?: string | null;
  payload: unknown;
  /** One line the host can render without understanding the payload. */
  summary?: string;
  /**
   * Proposals drafted together, such as one chat recap, share a group so the
   * host can show them under one heading and decide them together. Each one
   * is still confirmed on its own: a group is a heading, not a transaction.
   */
  group?: ProposalGroup;
}

export interface ProposalGroup {
  id: string;
  /** What the group is, in one line. */
  title: string;
  /** A longer line under the title, such as the projected change in a score. */
  detail?: string;
  /** Whatever the drafter needs to read back later. The host stores it as is. */
  meta?: Record<string, unknown>;
}

export type ProposalState = "pending" | "confirmed" | "discarded";

/** A proposal as the queue holds it. */
export interface QueuedProposal extends Proposal {
  id: string;
  state: ProposalState;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * The review queue. The host owns it, and the module reads and decides
 * through it so that any model, behind any assistant, can propose a draft and
 * any person can confirm it, with the same gates either way.
 */
export interface ReviewPort {
  propose(proposal: Proposal): Promise<{ id: string }>;
  list(state?: ProposalState | "all"): Promise<QueuedProposal[]>;
  get(id: string): Promise<QueuedProposal | null>;
  /** Marks a pending proposal. False when it was not pending. */
  decide(id: string, state: "confirmed" | "discarded"): Promise<boolean>;
}

/** The events this module emits, as docs/SPEC.md section 9 lists them. */
export type ModuleEventName =
  | "people.interaction.logged"
  | "people.closeness.changed"
  | "people.person.created"
  | "people.sketch.written"
  | "people.personality.written";

export interface BusPort {
  /**
   * Emitted after the transaction commits, never before. With a single SQLite
   * writer, emitting early is the easiest bug in this file to write by
   * accident.
   */
  emit(name: ModuleEventName, payload: Record<string, unknown>): void | Promise<void>;
}

/** One normalized item handed over by a connector. */
export interface ConnectorItem {
  id: string;
  payload: unknown;
}

export interface ConnectorPull {
  items: ConnectorItem[];
  cursor?: string | null;
}

/** An exported chat the host read off disk, as text. */
export interface ChatExportFile {
  /** The file's base name, which people.import_chat stores when no fileName is given. */
  fileName: string;
  text: string;
}

export interface ConnectorsPort {
  pull(connector: string, cursor?: string | null): Promise<ConnectorPull>;
  /**
   * Reads one exported chat for people.import_chat, so an assistant can pass a
   * path instead of writing a megabyte of text out as a tool argument. The host
   * decides which folders may be read, caps the size and unpacks a zip; the
   * module only ever receives the text. Failures are ToolErrors that say what
   * went wrong.
   */
  readChatExport(path: string): Promise<ChatExportFile>;
}

/**
 * Pass-through, and it stays pass-through. read_messages returns real message
 * text on purpose, so nothing here should look like protection that is not
 * there: see the read_messages decision in docs/SPEC.md section 13.
 */
export interface PrivacyPort {
  redact(text: string): string;
}

export interface AuditEntry {
  tool: string;
  /** read, write, or needs-ok, as the registry classifies the tool. */
  kind: string;
  personId?: string | null;
  at: Date;
  /** Counts and ids only. Never message text, never image bytes. */
  detail?: Record<string, unknown>;
}

/** Append only. Never updated, never deleted by the module. */
export interface AuditPort {
  log(entry: AuditEntry): Promise<void>;
}

export interface SettingsPort {
  get(): Promise<ModuleConfig>;
  /**
   * A change to halfLifeDays or scoreScale must recompute every link before
   * the new value counts as applied, because LinkStat.score is a cache of
   * both. The host owns that hook.
   */
  set(patch: Partial<ModuleConfig>): Promise<ModuleConfig>;
}

export type RefResolution =
  | { status: "resolved"; ref: string; label: string; detail?: Record<string, unknown> }
  | { status: "unavailable"; ref: string; reason: string };

export interface RefsPort {
  resolve(ref: string): Promise<RefResolution>;
}

export interface FetchedImage {
  /** Owns its own memory, so it can go straight into the Bytes column. */
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  /** The URL the bytes finally came from, after any redirect. */
  sourceUrl: string;
}

/**
 * Fetch and re-encode an image by URL. The host owns the SSRF defence, the
 * size cap, the content-type allowlist and the EXIF strip, and hands back
 * bytes rather than a URL for the module to fetch itself.
 */
export interface MediaPort {
  fetchImage(url: string): Promise<FetchedImage>;
}
