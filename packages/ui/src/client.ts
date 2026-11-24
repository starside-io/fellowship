/**
 * The only thing in this package that talks to the host.
 *
 * Every read and every write goes through POST /rpc, which is the same
 * registry an assistant reaches over MCP: no privileged path for the UI, no
 * second way into the database, and nothing here builds SQL. The three /host
 * endpoints below are the host's own surface, for the review queue, the audit
 * log and the event feed, which belong to it rather than to the people module.
 */

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "not_found"
  | "refused"
  | "conflict"
  | "unavailable"
  | "failed"
  | "unreachable";

export class RpcError extends Error {
  readonly code: ToolErrorCode;
  readonly detail: unknown;
  readonly tool: string;

  constructor(tool: string, code: ToolErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "RpcError";
    this.tool = tool;
    this.code = code;
    this.detail = detail;
  }

  /** True when the caller can fix the input and try again. */
  get isInput(): boolean {
    return this.code === "invalid_input";
  }

  /** The field messages behind an invalid_input, when the host sent them. */
  get issues(): Array<{ path: string; message: string }> {
    const detail = this.detail as { issues?: Array<{ path?: unknown[]; message?: string }> };
    return (detail?.issues ?? []).map((issue) => ({
      path: (issue.path ?? []).join("."),
      message: issue.message ?? "Invalid",
    }));
  }
}

interface RpcSuccess<T> {
  ok: true;
  tool: string;
  result: T;
}

interface RpcFailure {
  ok: false;
  tool: string;
  error: { code: ToolErrorCode; message: string; detail?: unknown };
}

/** Where the host is. Same origin in the build, proxied in development. */
export const BASE = "";

export async function rpc<T>(tool: string, input: unknown = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, input }),
    });
  } catch (error) {
    throw new RpcError(
      tool,
      "unreachable",
      `Could not reach the host. Is it running? (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }

  let body: RpcSuccess<T> | RpcFailure;
  try {
    body = (await response.json()) as RpcSuccess<T> | RpcFailure;
  } catch {
    throw new RpcError(tool, "failed", `The host answered ${response.status} with no JSON.`);
  }

  if (!body.ok) {
    throw new RpcError(tool, body.error.code, body.error.message, body.error.detail);
  }
  return body.result;
}

async function hostGet<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}/host${path}`);
  if (!response.ok) {
    throw new RpcError(path, "failed", `The host answered ${response.status}`);
  }
  return (await response.json()) as T;
}

export interface ProposalRow {
  id: string;
  tool: string;
  personId: string | null;
  payload: unknown;
  summary: string | null;
  /** Proposals drafted together, such as one chat recap. */
  group: { id: string; title: string; detail?: string; meta?: Record<string, unknown> } | null;
  state: "pending" | "confirmed" | "discarded";
  createdAt: string;
  decidedAt: string | null;
}

export interface AuditRow {
  id: number;
  tool: string;
  kind: string;
  personId: string | null;
  at: string;
  detail: Record<string, unknown> | null;
}

export interface EventRow {
  id: number;
  name: string;
  payload: Record<string, unknown>;
  at: string;
}

export const host = {
  review: (state = "pending") =>
    hostGet<{ proposals: ProposalRow[] }>(`/review?state=${encodeURIComponent(state)}`),

  audit: (limit = 50) => hostGet<{ entries: AuditRow[] }>(`/audit?limit=${limit}`),

  events: (limit = 20) => hostGet<{ events: EventRow[] }>(`/events?limit=${limit}`),

  config: () => hostGet<{ config: ModuleConfigShape }>("/config"),

  health: async () => {
    const response = await fetch(`${BASE}/health`);
    if (!response.ok) throw new RpcError("/health", "failed", "The host is not answering.");
    return (await response.json()) as {
      ok: boolean;
      silo: string;
      hostDb: string;
      tools: number;
    };
  },

  /**
   * Confirming runs the tool. The answer says whether it did, and a refusal
   * leaves the proposal where it was.
   */
  async decide(
    id: string,
    decision: "confirm" | "discard",
  ): Promise<{ ok: boolean; message?: string }> {
    const response = await fetch(`${BASE}/host/review/${encodeURIComponent(id)}/${decision}`, {
      method: "POST",
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: { message?: string } | string;
    } | null;

    if (response.ok && body?.ok) return { ok: true };

    const error = body?.error;
    return {
      ok: false,
      message:
        typeof error === "string"
          ? error
          : (error?.message ?? `The host answered ${response.status}`),
    };
  },

  /**
   * Fetches a candidate picture through the host's guard and hands it back
   * inline, storing nothing. Showing it is what the owner says yes to, and the
   * yes is people.set_picture.
   */
  async avatarPreview(personId: string, url: string): Promise<AvatarPreview> {
    const response = await fetch(`${BASE}/host/avatar/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personId, url }),
    });

    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      preview?: AvatarPreview;
      error?: string;
    } | null;

    if (!response.ok || !body?.ok || !body.preview) {
      throw new RpcError(
        "/host/avatar/preview",
        response.status === 502 ? "unavailable" : "failed",
        body?.error ?? `The host answered ${response.status}`,
      );
    }
    return body.preview;
  },

  /**
   * The specialist. Each one ends in the review queue: the model proposes and
   * a person confirms, which is the only thing that writes.
   */
  draft: {
    sketch: (personId: string, messageLimit?: number) =>
      draftPost(`/draft/sketch/${encodeURIComponent(personId)}`, { messageLimit }),
    senders: (conversationId: string) =>
      draftPost(`/draft/senders/${encodeURIComponent(conversationId)}`, {}),
    facts: (personId: string, text: string) =>
      draftPost(`/draft/facts/${encodeURIComponent(personId)}`, { text }),
  },
};

export interface AvatarPreview {
  /** The bytes themselves, inline: nothing stored them to serve from. */
  dataUrl: string;
  mime: string;
  bytes: number;
  sourceUrl: string;
  candidate: { url: string; label: string; handle: string | null };
}

export interface DraftAnswer {
  job: string;
  queued: Array<{ id: string; proposal: { tool: string; summary?: string } }>;
  rejected: Array<{ reason: string; detail?: unknown }>;
  tookMs: number;
}

async function draftPost(path: string, body: unknown): Promise<DraftAnswer> {
  const response = await fetch(`${BASE}/host${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const answer = (await response.json().catch(() => null)) as {
    ok?: boolean;
    draft?: DraftAnswer;
    error?: string;
  } | null;

  if (!response.ok || !answer?.ok || !answer.draft) {
    throw new RpcError(
      path,
      response.status === 502 ? "unavailable" : "failed",
      answer?.error ?? `The host answered ${response.status}`,
    );
  }

  return answer.draft;
}

/** The config the settings form edits. Mirrors config.schema.json. */
export interface ModuleConfigShape {
  halfLifeDays: number;
  scoreScale: number;
  messageChunk: number;
  avatarResolvers: Array<{
    id: string;
    label: string;
    platform: string;
    urlTemplate: string;
    enabled: boolean;
  }>;
  chatThresholds: Record<string, number>;
}

/** The picture route. Answers 404 for anyone with no stored picture. */
export function avatarUrl(personId: string): string {
  return `${BASE}/media/person/${encodeURIComponent(personId)}/avatar`;
}
