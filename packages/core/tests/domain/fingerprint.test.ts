import { describe, expect, it } from "vitest";
import { z } from "zod";

import { surfaceFingerprint } from "../../src/fingerprint.js";
import { createRegistry, defineTool, type ToolDefinition } from "../../src/tools/registry.js";

/**
 * The fingerprint is what lets a client tell a host on the same code from one
 * on older code, so it has to be stable for the same surface and move when
 * the surface does.
 */

function tool(name: string, input: z.ZodTypeAny, kind: "read" | "write" = "read") {
  return defineTool({
    name,
    title: name,
    kind,
    summary: name,
    input,
    handler: async () => ({}),
  }) as unknown as ToolDefinition<never, unknown>;
}

describe("surfaceFingerprint", () => {
  it("is 16 hex characters", () => {
    expect(surfaceFingerprint()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across calls", () => {
    expect(surfaceFingerprint()).toBe(surfaceFingerprint());

    const registry = createRegistry([tool("test.a", z.object({ id: z.string() }))]);
    expect(surfaceFingerprint(registry)).toBe(surfaceFingerprint(registry));
  });

  it("does not depend on the order tools were registered in", () => {
    const a = tool("test.a", z.object({ id: z.string() }));
    const b = tool("test.b", z.object({ n: z.number() }));
    expect(surfaceFingerprint(createRegistry([a, b]))).toBe(
      surfaceFingerprint(createRegistry([b, a])),
    );
  });

  it("ignores a default computed at call time", () => {
    const at = (instant: string) =>
      createRegistry([tool("test.a", z.object({ at: z.string().default(instant) }))]);
    expect(surfaceFingerprint(at("2026-01-01T00:00:00.000Z"))).toBe(
      surfaceFingerprint(at("2027-06-15T12:34:56.000Z")),
    );
  });

  it("changes when the registry differs", () => {
    const base = surfaceFingerprint(
      createRegistry([tool("test.a", z.object({ id: z.string() }))]),
    );

    // A tool added.
    expect(
      surfaceFingerprint(
        createRegistry([
          tool("test.a", z.object({ id: z.string() })),
          tool("test.b", z.object({})),
        ]),
      ),
    ).not.toBe(base);

    // A tool renamed.
    expect(
      surfaceFingerprint(createRegistry([tool("test.c", z.object({ id: z.string() }))])),
    ).not.toBe(base);

    // A kind changed.
    expect(
      surfaceFingerprint(
        createRegistry([tool("test.a", z.object({ id: z.string() }), "write")]),
      ),
    ).not.toBe(base);

    // An input schema changed.
    expect(
      surfaceFingerprint(createRegistry([tool("test.a", z.object({ id: z.number() }))])),
    ).not.toBe(base);

    // And the real registry is not the small one.
    expect(surfaceFingerprint()).not.toBe(base);
  });
});
