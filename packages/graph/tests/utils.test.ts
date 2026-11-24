import { describe, expect, it } from "vitest";
import {
  IMPLICIT_DISTANCE,
  buildEdges,
  buildPairIndex,
  distanceForScore,
  pairKey,
  replayPairScores,
  strengthForEventCount,
} from "../src/utils.js";
import type { GraphEvent, GraphLink } from "../src/payload.js";

// Ids are chosen so ALICE < BOB lexicographically, which is the canonical
// pair ordering the whole link layer relies on.
const ALICE = "a-alice";
const BOB = "b-bob";
const CARA = "c-cara";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-07-31T12:00:00.000Z");

function event(overrides: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: "e1",
    occurredAt: NOW,
    type: "HANGOUT",
    sentiment: 2,
    weight: 1,
    participants: [
      { personId: ALICE, sentiment: null },
      { personId: BOB, sentiment: null },
    ],
    ...overrides,
  };
}

function link(overrides: Partial<GraphLink> = {}): GraphLink {
  return {
    aPersonId: ALICE,
    bPersonId: BOB,
    tie: "FRIEND",
    score: 0,
    eventCount: 0,
    lastEventAt: null,
    pinned: false,
    manualScore: null,
    implicit: false,
    ...overrides,
  };
}

describe("distanceForScore", () => {
  it("maps the documented anchors", () => {
    // 0 rests at the neutral distance, a saturated score pulls in, a strained
    // one pushes out. The ramp saturates at 50, not at 100.
    expect(distanceForScore(0)).toBe(170);
    expect(distanceForScore(50)).toBe(90);
    expect(distanceForScore(100)).toBe(90);
    expect(distanceForScore(-50)).toBe(250);
    expect(distanceForScore(-100)).toBe(250);
  });

  it("is monotonically decreasing in the score", () => {
    expect(distanceForScore(30)).toBeLessThan(distanceForScore(0));
    expect(distanceForScore(0)).toBeLessThan(distanceForScore(-30));
  });

  it("clamps scores outside the -100 to 100 range", () => {
    expect(distanceForScore(5000)).toBe(distanceForScore(100));
    expect(distanceForScore(-5000)).toBe(distanceForScore(-100));
  });

  it("falls back to neutral for a non finite score", () => {
    expect(distanceForScore(Number.NaN)).toBe(170);
    expect(distanceForScore(Number.POSITIVE_INFINITY)).toBe(170);
  });

  it("keeps event backed links closer than acquaintance threads", () => {
    expect(distanceForScore(0)).toBeLessThan(IMPLICIT_DISTANCE);
  });
});

describe("strengthForEventCount", () => {
  it("uses the loose strength when there are no events", () => {
    expect(strengthForEventCount(0)).toBe(0.3);
  });

  it("pulls harder as events accumulate", () => {
    const one = strengthForEventCount(1);
    const four = strengthForEventCount(4);
    const nine = strengthForEventCount(9);

    expect(one).toBeGreaterThan(strengthForEventCount(0));
    expect(four).toBeGreaterThan(one);
    expect(nine).toBeGreaterThan(four);
  });

  it("caps at 0.9 however many events there are", () => {
    expect(strengthForEventCount(16)).toBe(0.9);
    expect(strengthForEventCount(1000)).toBe(0.9);
  });

  it("treats a negative or non finite count as zero events", () => {
    expect(strengthForEventCount(-5)).toBe(0.3);
    expect(strengthForEventCount(Number.NaN)).toBe(0.3);
  });
});

describe("pairKey", () => {
  it("is order independent", () => {
    expect(pairKey(BOB, ALICE)).toBe(pairKey(ALICE, BOB));
    expect(pairKey(ALICE, BOB)).toBe(`${ALICE}|${BOB}`);
  });
});

describe("buildPairIndex", () => {
  it("makes one entry per pair of participants", () => {
    const index = buildPairIndex(
      [
        event({
          participants: [
            { personId: ALICE, sentiment: null },
            { personId: BOB, sentiment: null },
            { personId: CARA, sentiment: null },
          ],
        }),
      ],
      new Set([ALICE, BOB, CARA]),
    );

    // Three people at one event is three pairs.
    expect([...index.keys()].sort()).toEqual(
      [pairKey(ALICE, BOB), pairKey(ALICE, CARA), pairKey(BOB, CARA)].sort(),
    );
    for (const entry of index.values()) {
      expect(entry.events).toHaveLength(1);
      expect(entry.aId < entry.bId).toBe(true);
    }
  });

  it("maps participant overrides onto the canonical pair sides", () => {
    // Participants are listed with the higher id first on purpose.
    const index = buildPairIndex(
      [
        event({
          participants: [
            { personId: BOB, sentiment: 1 },
            { personId: ALICE, sentiment: -1 },
          ],
        }),
      ],
      new Set([ALICE, BOB]),
    );

    const entry = index.get(pairKey(ALICE, BOB));
    expect(entry).toBeDefined();
    expect(entry?.aId).toBe(ALICE);
    expect(entry?.bId).toBe(BOB);
    expect(entry?.events[0].overrideA).toBe(-1);
    expect(entry?.events[0].overrideB).toBe(1);
  });

  it("drops participants who are not in the known people set", () => {
    const index = buildPairIndex(
      [
        event({
          participants: [
            { personId: ALICE, sentiment: null },
            { personId: BOB, sentiment: null },
            { personId: CARA, sentiment: null },
          ],
        }),
      ],
      new Set([ALICE, BOB]),
    );

    expect([...index.keys()]).toEqual([pairKey(ALICE, BOB)]);
  });

  it("ignores an event with fewer than two usable participants", () => {
    const index = buildPairIndex(
      [event({ participants: [{ personId: ALICE, sentiment: null }] })],
      new Set([ALICE, BOB]),
    );

    expect(index.size).toBe(0);
  });

  it("ignores an event whose date cannot be read", () => {
    const index = buildPairIndex(
      [event({ occurredAt: new Date("not a date") })],
      new Set([ALICE, BOB]),
    );

    expect(index.size).toBe(0);
  });
});

describe("replayPairScores", () => {
  const thirtyDaysAgo = new Date(NOW.getTime() - 30 * DAY_MS);

  it("scores a pair from the single event they share", () => {
    const index = buildPairIndex([event({ occurredAt: NOW })], new Set([ALICE, BOB]));
    const results = replayPairScores(index, { cutoff: NOW, types: null });

    expect(results.size).toBe(1);
    const result = results.get(pairKey(ALICE, BOB));
    // sentiment 2, weight 1, no decay: round(5 * 2) = 10.
    expect(result?.score).toBe(10);
    expect(result?.eventCount).toBe(1);
    expect(result?.lastEventAt?.getTime()).toBe(NOW.getTime());
  });

  it("measures decay from the cutoff rather than from today", () => {
    const index = buildPairIndex(
      [event({ occurredAt: thirtyDaysAgo })],
      new Set([ALICE, BOB]),
    );

    const atEvent = replayPairScores(index, { cutoff: thirtyDaysAgo, types: null });
    const later = replayPairScores(index, { cutoff: NOW, types: null });

    expect(atEvent.get(pairKey(ALICE, BOB))?.score).toBe(10);
    const decayed = later.get(pairKey(ALICE, BOB))?.score ?? 0;
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(10);
  });

  it("drops events after the cutoff", () => {
    const index = buildPairIndex([event({ occurredAt: NOW })], new Set([ALICE, BOB]));
    const results = replayPairScores(index, {
      cutoff: new Date(NOW.getTime() - DAY_MS),
      types: null,
    });

    const result = results.get(pairKey(ALICE, BOB));
    expect(result?.eventCount).toBe(0);
    expect(result?.score).toBe(0);
    expect(result?.lastEventAt).toBeNull();
  });

  it("drops events outside the type filter", () => {
    const index = buildPairIndex(
      [event({ type: "CONFLICT", occurredAt: NOW })],
      new Set([ALICE, BOB]),
    );

    const excluded = replayPairScores(index, {
      cutoff: NOW,
      types: new Set(["HANGOUT"]),
    });
    const included = replayPairScores(index, {
      cutoff: NOW,
      types: new Set(["HANGOUT", "CONFLICT"]),
    });

    expect(excluded.get(pairKey(ALICE, BOB))?.eventCount).toBe(0);
    expect(excluded.get(pairKey(ALICE, BOB))?.score).toBe(0);
    expect(included.get(pairKey(ALICE, BOB))?.eventCount).toBe(1);
    expect(included.get(pairKey(ALICE, BOB))?.score).toBe(10);
  });

  it("reports the latest kept event as lastEventAt", () => {
    const index = buildPairIndex(
      [
        event({ id: "old", occurredAt: thirtyDaysAgo }),
        event({ id: "new", occurredAt: NOW }),
      ],
      new Set([ALICE, BOB]),
    );

    const results = replayPairScores(index, { cutoff: NOW, types: null });
    const result = results.get(pairKey(ALICE, BOB));
    expect(result?.eventCount).toBe(2);
    expect(result?.lastEventAt?.getTime()).toBe(NOW.getTime());
  });

  it("applies the overrides it mapped onto each side", () => {
    // Both sides logged +1 against a +2 event, so the pair value is +1.
    const index = buildPairIndex(
      [
        event({
          occurredAt: NOW,
          sentiment: 2,
          weight: 1,
          participants: [
            { personId: BOB, sentiment: 1 },
            { personId: ALICE, sentiment: 1 },
          ],
        }),
      ],
      new Set([ALICE, BOB]),
    );

    const results = replayPairScores(index, { cutoff: NOW, types: null });
    expect(results.get(pairKey(ALICE, BOB))?.score).toBe(5);
  });
});

describe("buildEdges", () => {
  const people = new Set([ALICE, BOB]);

  it("keeps an implicit thread however high the event threshold is", () => {
    const edges = buildEdges({
      links: [link({ implicit: true, tie: "KNOWS_OF" })],
      replay: new Map(),
      people,
      minEvents: 99,
      showImplicit: true,
    });

    expect(edges).toHaveLength(1);
    expect(edges[0].implicit).toBe(true);
    expect(edges[0].eventCount).toBe(0);
    expect(edges[0].effectiveScore).toBe(0);
  });

  it("drops implicit threads when they are switched off", () => {
    const edges = buildEdges({
      links: [link({ implicit: true })],
      replay: new Map(),
      people,
      minEvents: 1,
      showImplicit: false,
    });

    expect(edges).toHaveLength(0);
  });

  it("drops a real link below the event threshold", () => {
    const replay = new Map([
      [pairKey(ALICE, BOB), { score: 40, eventCount: 1, lastEventAt: NOW }],
    ]);

    const edges = buildEdges({
      links: [link()],
      replay,
      people,
      minEvents: 3,
      showImplicit: true,
    });

    expect(edges).toHaveLength(0);
  });

  it("keeps a pinned link below the event threshold", () => {
    const replay = new Map([
      [pairKey(ALICE, BOB), { score: 40, eventCount: 1, lastEventAt: NOW }],
    ]);

    const edges = buildEdges({
      links: [link({ pinned: true })],
      replay,
      people,
      minEvents: 3,
      showImplicit: true,
    });

    expect(edges).toHaveLength(1);
    expect(edges[0].pinned).toBe(true);
    expect(edges[0].eventCount).toBe(1);
    expect(edges[0].score).toBe(40);
  });

  it("keeps a real link that meets the threshold", () => {
    const replay = new Map([
      [pairKey(ALICE, BOB), { score: 40, eventCount: 3, lastEventAt: NOW }],
    ]);

    const edges = buildEdges({
      links: [link()],
      replay,
      people,
      minEvents: 3,
      showImplicit: true,
    });

    expect(edges).toHaveLength(1);
    expect(edges[0].implicit).toBe(false);
    expect(edges[0].effectiveScore).toBe(40);
  });

  it("prefers manualScore over the replayed score", () => {
    const replay = new Map([
      [pairKey(ALICE, BOB), { score: 40, eventCount: 3, lastEventAt: NOW }],
    ]);

    const edges = buildEdges({
      links: [link({ manualScore: -20 })],
      replay,
      people,
      minEvents: 1,
      showImplicit: true,
    });

    expect(edges).toHaveLength(1);
    // The derived score is preserved alongside the human override.
    expect(edges[0].score).toBe(40);
    expect(edges[0].manualScore).toBe(-20);
    expect(edges[0].effectiveScore).toBe(-20);
  });

  it("honours a manualScore of 0 rather than falling back to the score", () => {
    const replay = new Map([
      [pairKey(ALICE, BOB), { score: 40, eventCount: 3, lastEventAt: NOW }],
    ]);

    const edges = buildEdges({
      links: [link({ manualScore: 0 })],
      replay,
      people,
      minEvents: 1,
      showImplicit: true,
    });

    expect(edges[0].effectiveScore).toBe(0);
  });

  it("orders each edge into the canonical pair direction", () => {
    const edges = buildEdges({
      links: [
        link({
          aPersonId: BOB,
          bPersonId: ALICE,
          pinned: true,
        }),
      ],
      replay: new Map(),
      people,
      minEvents: 1,
      showImplicit: true,
    });

    expect(edges[0].aId).toBe(ALICE);
    expect(edges[0].bId).toBe(BOB);
    expect(edges[0].key).toBe(pairKey(ALICE, BOB));
  });

  it("skips self links and people outside the visible set", () => {
    const edges = buildEdges({
      links: [
        link({ aPersonId: ALICE, bPersonId: ALICE, pinned: true }),
        link({ aPersonId: ALICE, bPersonId: CARA, pinned: true }),
      ],
      replay: new Map(),
      people,
      minEvents: 1,
      showImplicit: true,
    });

    expect(edges).toHaveLength(0);
  });
});
