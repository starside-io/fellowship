import { describe, expect, it } from "vitest";
import { pairKey, pairsFromPeople } from "../../src/domain/link-engine.js";

// Only the pure pair helpers are exercised here. Everything else in the
// module talks to Prisma and needs a real database.

describe("pairKey", () => {
  it("orders the two ids so aPersonId is always the lower one", () => {
    expect(pairKey("a", "b")).toEqual({ aPersonId: "a", bPersonId: "b" });
    expect(pairKey("b", "a")).toEqual({ aPersonId: "a", bPersonId: "b" });
  });

  it("is stable whichever way round the caller passes the ids", () => {
    expect(pairKey("zoe", "adam")).toEqual(pairKey("adam", "zoe"));
  });
});

describe("pairsFromPeople", () => {
  it("returns no pairs for fewer than two people", () => {
    expect(pairsFromPeople([])).toEqual([]);
    expect(pairsFromPeople(["a"])).toEqual([]);
  });

  it("returns every unordered pair", () => {
    const pairs = pairsFromPeople(["a", "b", "c"]);
    expect(pairs).toHaveLength(3);
    expect(pairs).toEqual([
      { aPersonId: "a", bPersonId: "b" },
      { aPersonId: "a", bPersonId: "c" },
      { aPersonId: "b", bPersonId: "c" },
    ]);
  });

  it("deduplicates repeated ids before pairing", () => {
    expect(pairsFromPeople(["a", "a", "b"])).toEqual([
      { aPersonId: "a", bPersonId: "b" },
    ]);
  });

  it("emits n choose 2 pairs and never a self pair", () => {
    const ids = ["p1", "p2", "p3", "p4", "p5"];
    const pairs = pairsFromPeople(ids);

    expect(pairs).toHaveLength((ids.length * (ids.length - 1)) / 2);
    for (const pair of pairs) {
      expect(pair.aPersonId).not.toBe(pair.bPersonId);
      expect(pair.aPersonId < pair.bPersonId).toBe(true);
    }
  });

  it("canonicalises pairs regardless of the input order", () => {
    expect(pairsFromPeople(["c", "a"])).toEqual([
      { aPersonId: "a", bPersonId: "c" },
    ]);
  });
});
