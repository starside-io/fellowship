import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcError, avatarUrl, host, rpc } from "@/client";

/**
 * The one way in. Everything the UI knows about the host is here, so the
 * shapes it promises the screens are worth pinning down.
 */

type FetchCall = [string, RequestInit | undefined];

function answerWith(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** The arguments of one fetch call, typed, since vi.fn infers them loosely. */
function callsOf(mock: { mock: { calls: unknown[][] } }): FetchCall[] {
  return mock.mock.calls as FetchCall[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rpc", () => {
  it("posts the tool and its input, and unwraps the result", async () => {
    const fetchMock = answerWith({ ok: true, tool: "people.search", result: { people: [] } });
    vi.stubGlobal("fetch", fetchMock);

    const result = await rpc<{ people: unknown[] }>("people.search", { query: "Sam" });

    expect(result).toEqual({ people: [] });
    const [url, init] = callsOf(fetchMock)[0] as FetchCall;
    expect(url).toBe("/rpc");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      tool: "people.search",
      input: { query: "Sam" },
    });
  });

  it("turns a refusal into an error that keeps its code", async () => {
    vi.stubGlobal(
      "fetch",
      answerWith(
        {
          ok: false,
          tool: "people.get",
          error: { code: "not_found", message: 'No person with id "x"' },
        },
        404,
      ),
    );

    await expect(rpc("people.get", { personId: "x" })).rejects.toMatchObject({
      code: "not_found",
      message: 'No person with id "x"',
    });
  });

  it("keeps the field messages behind an invalid input", async () => {
    vi.stubGlobal(
      "fetch",
      answerWith(
        {
          ok: false,
          tool: "people.write_sketch",
          error: {
            code: "invalid_input",
            message: "refused",
            detail: {
              issues: [{ path: ["sources"], message: "At least one source is required" }],
            },
          },
        },
        400,
      ),
    );

    try {
      await rpc("people.write_sketch", {});
      expect.unreachable("that call should have thrown");
    } catch (error) {
      const refusal = error as RpcError;
      expect(refusal.isInput).toBe(true);
      expect(refusal.issues).toEqual([
        { path: "sources", message: "At least one source is required" },
      ]);
    }
  });

  it("says the host is not answering rather than throwing a fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(rpc("people.search", { query: "x" })).rejects.toMatchObject({
      code: "unreachable",
    });
  });
});

describe("the host surface", () => {
  it("reads the review queue, the audit log and the feed", async () => {
    const fetchMock = answerWith({ proposals: [] });
    vi.stubGlobal("fetch", fetchMock);

    await host.review("pending");
    expect(callsOf(fetchMock)[0]?.[0]).toBe("/host/review?state=pending");

    await host.audit(10);
    expect(callsOf(fetchMock)[1]?.[0]).toBe("/host/audit?limit=10");

    await host.events(5);
    expect(callsOf(fetchMock)[2]?.[0]).toBe("/host/events?limit=5");
  });

  it("posts one decision per proposal", async () => {
    const fetchMock = answerWith({ ok: true, state: "confirmed" });
    vi.stubGlobal("fetch", fetchMock);

    expect(await host.decide("abc", "confirm")).toEqual({ ok: true });
    expect(callsOf(fetchMock)[0]?.[0]).toBe("/host/review/abc/confirm");
  });

  it("carries the reason when confirming ran the tool and the tool said no", async () => {
    vi.stubGlobal(
      "fetch",
      answerWith(
        {
          ok: false,
          state: "pending",
          error: { code: "not_found", message: 'No person with id "x"' },
        },
        409,
      ),
    );

    expect(await host.decide("abc", "confirm")).toEqual({
      ok: false,
      message: 'No person with id "x"',
    });
  });
});

describe("avatarUrl", () => {
  it("points at the one route that serves bytes", () => {
    expect(avatarUrl("11111111-1111-4111-8111-111111111111")).toBe(
      "/media/person/11111111-1111-4111-8111-111111111111/avatar",
    );
  });
});
