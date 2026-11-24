import { describe, expect, it } from "vitest";

import { buildScene, defaultSettings, initialsOf } from "../src/scene.js";
import type { GraphPayload } from "../src/payload.js";

/**
 * The scene is what the picture means before anything is painted, so it gets
 * tested rather than eyeballed.
 */

const ME = "a-me";
const SAM = "b-sam";
const ADA = "c-ada";
const CIRCLE = "circle-climbing";
const NOW = new Date("2026-07-31T12:00:00.000Z");
const DAY = 86_400_000;

function payload(overrides: Partial<GraphPayload> = {}): GraphPayload {
  return {
    people: [
      {
        id: ME,
        displayName: "Me",
        avatarColor: "#64748b",
        isSelf: true,
        circles: [],
        closeness: 0,
      },
      {
        id: SAM,
        displayName: "Sam Rivera",
        avatarColor: "#ef4444",
        isSelf: false,
        circles: [{ id: CIRCLE, name: "Climbing", colour: "#6366f1" }],
        closeness: 0,
      },
      {
        id: ADA,
        displayName: "Ada Vance",
        avatarColor: "#10b981",
        isSelf: false,
        circles: [],
        closeness: 0,
      },
    ],
    events: [
      {
        id: "e1",
        // Dates arrive as strings over the wire, which is the shape that
        // matters: the server types them as Date and JSON does not carry one.
        occurredAt: NOW.toISOString(),
        type: "MEAL",
        sentiment: 2,
        weight: 2,
        participants: [
          { personId: ME, sentiment: null },
          { personId: SAM, sentiment: null },
        ],
      },
      {
        id: "e2",
        occurredAt: new Date(NOW.getTime() - 400 * DAY).toISOString(),
        type: "CONFLICT",
        sentiment: -2,
        weight: 1,
        participants: [
          { personId: ME, sentiment: null },
          { personId: ADA, sentiment: null },
        ],
      },
    ],
    links: [
      {
        aPersonId: ME,
        bPersonId: SAM,
        tie: "FRIEND",
        score: 20,
        eventCount: 1,
        lastEventAt: NOW.toISOString(),
        pinned: false,
        manualScore: null,
        implicit: false,
      },
      {
        aPersonId: ME,
        bPersonId: ADA,
        tie: "ACQUAINTANCE",
        score: -2,
        eventCount: 1,
        lastEventAt: new Date(NOW.getTime() - 400 * DAY).toISOString(),
        pinned: false,
        manualScore: null,
        implicit: false,
      },
      {
        aPersonId: SAM,
        bPersonId: ADA,
        tie: "KNOWS_OF",
        score: 0,
        eventCount: 0,
        lastEventAt: null,
        pinned: false,
        manualScore: null,
        implicit: true,
      },
    ],
    ...overrides,
  };
}

function settings(overrides: Partial<ReturnType<typeof defaultSettings>> = {}) {
  return { ...defaultSettings(payload()), cutoff: NOW.getTime(), ...overrides };
}

describe("buildScene", () => {
  it("draws a node per person and an edge per surviving link", () => {
    const scene = buildScene(payload(), settings());

    expect(scene.nodes.map((node) => node.id).sort()).toEqual([ME, SAM, ADA].sort());
    expect(scene.edges).toHaveLength(3);
    expect(scene.selfId).toBe(ME);
  });

  it("replays the score at the cutoff rather than trusting the file", () => {
    const scene = buildScene(payload(), settings());
    const sam = scene.edgeVisuals.get([ME, SAM].sort().join("|"));

    // 2 sentiment, weight 2, no decay yet, scale 5.
    expect(sam?.score).toBe(20);

    // Rewound to before that evening the pair has nothing between them, and a
    // link the replay no longer supports is not drawn at all unless a human
    // pinned it.
    const earlier = buildScene(
      payload(),
      settings({ cutoff: NOW.getTime() - 10 * DAY }),
    );
    expect(earlier.edgeVisuals.get([ME, SAM].sort().join("|"))).toBeUndefined();
    // The older conflict is still behind the cutoff, so that pair stays.
    expect([...earlier.edges.map((edge) => edge.key)].sort()).toEqual(
      [[ME, ADA].sort().join("|"), [SAM, ADA].sort().join("|")].sort(),
    );
  });

  it("sizes a node by closeness to the self record", () => {
    const scene = buildScene(payload(), settings());
    const close = scene.nodeVisuals.get(SAM)?.radius ?? 0;
    const distant = scene.nodeVisuals.get(ADA)?.radius ?? 0;
    expect(close).toBeGreaterThan(distant);
  });

  it("dims everyone outside an isolated circle, except the self node", () => {
    const scene = buildScene(payload(), settings({ circleId: CIRCLE }));

    expect(scene.nodeVisuals.get(SAM)?.dimmed).toBe(false);
    expect(scene.nodeVisuals.get(ADA)?.dimmed).toBe(true);
    expect(scene.nodeVisuals.get(ME)?.dimmed).toBe(false);
  });

  it("drops the synthesized threads when asked", () => {
    const withThreads = buildScene(payload(), settings());
    const without = buildScene(payload(), settings({ showImplicit: false }));

    expect(withThreads.edges).toHaveLength(3);
    expect(without.edges).toHaveLength(2);
    expect([...without.edgeVisuals.values()].every((edge) => !edge.implicit)).toBe(true);
  });

  it("filters by occasion kind", () => {
    const meals = buildScene(payload(), settings({ types: ["MEAL"] }));

    // The conflict is the only thing those two shared, so filtering it out
    // takes their edge with it.
    expect(meals.edgeVisuals.get([ME, ADA].sort().join("|"))).toBeUndefined();
    expect(meals.edgeVisuals.get([ME, SAM].sort().join("|"))?.eventCount).toBe(1);
  });

  it("keeps a pinned link the replay no longer supports", () => {
    const file = payload();
    file.links[0]!.pinned = true;

    const scene = buildScene(file, settings({ cutoff: NOW.getTime() - 10 * DAY }));
    const pinned = scene.edgeVisuals.get([ME, SAM].sort().join("|"));

    expect(pinned).toBeDefined();
    expect(pinned?.eventCount).toBe(0);
    expect(pinned?.pinned).toBe(true);
  });

  it("hides the self node without losing the rest", () => {
    const scene = buildScene(payload(), settings({ showSelf: false }));
    expect(scene.nodeVisuals.get(ME)?.hidden).toBe(true);
    // Every edge touching the hidden node goes with it.
    expect(scene.edges.map((edge) => edge.key)).toEqual([[SAM, ADA].sort().join("|")]);
  });

  it("offers the circles and the kinds the payload actually holds", () => {
    const scene = buildScene(payload(), settings());
    expect(scene.circles.map((circle) => circle.name)).toEqual(["Climbing"]);
    expect([...scene.typeOptions].sort()).toEqual(["CONFLICT", "MEAL"]);
  });

  it("seeds people who share an occasion on the same side of the centre", () => {
    const scene = buildScene(payload(), settings());
    const self = scene.nodes.find((node) => node.isSelf);
    expect(self).toMatchObject({ x: 0, y: 0 });

    for (const node of scene.nodes.filter((entry) => !entry.isSelf)) {
      expect(Math.hypot(node.x, node.y)).toBeCloseTo(130, 5);
    }
  });

  it("survives a payload that is empty or malformed", () => {
    for (const input of [null, undefined, {} as GraphPayload]) {
      const scene = buildScene(input, settings());
      expect(scene.nodes).toEqual([]);
      expect(scene.edges).toEqual([]);
      expect(scene.selfId).toBeNull();
    }
  });
});

describe("initialsOf", () => {
  it("takes the first and last initial", () => {
    expect(initialsOf("Sam Rivera")).toBe("SR");
    expect(initialsOf("Me")).toBe("ME");
    expect(initialsOf("  ")).toBe("?");
    expect(initialsOf("Ada Lovelace King")).toBe("AK");
  });
});
