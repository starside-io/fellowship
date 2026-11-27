import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { domain } from "@fellowship/core";

import { SCORING_VERSION_SETTING, startMiniHost } from "../src/host.js";
import { seedPerson, seedSelf } from "./harness.js";

/**
 * Cached closeness scores are a cache of the formula. A host on a new formula
 * rebuilds them once, the first time it opens the files.
 */
describe("a new closeness formula", () => {
  it("rebuilds every cached score once, then leaves them be", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fellowship-rescore-"));
    const paths = { dbPath: join(dir, "fellowship.db"), hostDbPath: join(dir, "host.db") };

    const first = await startMiniHost(paths);
    expect(first.store.readSetting(SCORING_VERSION_SETTING)).toBe(domain.scoring.SCORING_VERSION);
    const selfId = await seedSelf(first);
    const personId = await seedPerson(first, "Jane Doe");
    await first.api.invoke("people.log_interaction", {
      title: "Dinner",
      type: "MEAL",
      occurredAt: new Date().toISOString(),
      sentiment: 2,
      weight: 1,
      participants: [{ personId: selfId }, { personId }],
    });
    const fresh = (await first.silo.linkStat.findFirstOrThrow()).score;

    // As the files would look after an older build: a stale score, an older version.
    await first.silo.linkStat.updateMany({ data: { score: 99 } });
    first.store.writeSetting(SCORING_VERSION_SETTING, 1);
    await first.close();

    const second = await startMiniHost(paths);
    expect((await second.silo.linkStat.findFirstOrThrow()).score).toBe(fresh);
    expect(second.store.readSetting(SCORING_VERSION_SETTING)).toBe(domain.scoring.SCORING_VERSION);

    // Same version: nothing is touched.
    await second.silo.linkStat.updateMany({ data: { score: 42 } });
    await second.close();
    const third = await startMiniHost(paths);
    expect((await third.silo.linkStat.findFirstOrThrow()).score).toBe(42);
    await third.close();
  });
});
