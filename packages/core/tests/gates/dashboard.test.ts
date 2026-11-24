import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ToolError } from "../../src/tools/registry.js";
import { seedSelf, testHost, type TestHost } from "./harness.js";

/**
 * Gates: the landing page, the contact card export and the personality radar
 * status, all through the real tools against a throwaway silo, with time
 * pinned so the countdowns are exact.
 */

const NOW = new Date("2026-11-24T12:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

interface Upcoming {
  kind: "birthday" | "met";
  personId: string;
  displayName: string;
  date: string;
  daysAway: number;
  years: number | null;
}

interface Dashboard {
  generatedAt: string;
  upcoming: Upcoming[];
  missingBirthdays: number;
  months: Array<{ month: string; occasions: number; people: number; messages: number }>;
  types: Array<{ type: string; count: number }>;
  topPeople: Array<{ personId: string; displayName: string; occasions: number }>;
  totals: {
    people: number;
    occasions: number;
    messages: number;
    conversations: number;
    occasionsLast30: number;
  };
}

async function create(host: TestHost, input: Record<string, unknown>): Promise<string> {
  const result = (await host.api.invoke("people.create", input, { now: NOW })) as {
    person: { id: string };
  };
  return result.person.id;
}

async function dashboard(host: TestHost, input: Record<string, unknown> = {}) {
  return (await host.api.invoke("people.dashboard", input, { now: NOW })) as Dashboard;
}

describe("people.dashboard", () => {
  let host: TestHost;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    host = await testHost();
    ids.self = await seedSelf(host);
    await host.api.invoke(
      "people.update",
      { personId: ids.self, patch: { birthday: "1990-11-25" } },
      { now: NOW },
    );

    // Today, with a year.
    ids.ada = await create(host, { displayName: "Ada", birthday: "1990-11-24" });
    // Six days out, no year, tied with Bo on the day.
    ids.bo = await create(host, { displayName: "Bo", birthday: "1604-11-30" });
    ids.abe = await create(host, { displayName: "Abe", birthday: "1991-11-30" });
    // Seven days out, the anniversary of meeting, no birthday.
    ids.cy = await create(host, { displayName: "Cy", metOn: "2020-12-01" });
    // 97 days out, past the default horizon.
    ids.dee = await create(host, { displayName: "Dee", birthday: "1985-03-01" });
    // Met this year: not an anniversary yet. No birthday either.
    ids.eve = await create(host, { displayName: "Eve", metOn: "2026-11-26" });
    // Archived: never on the page.
    ids.fay = await create(host, { displayName: "Fay", birthday: "1990-11-26" });
    await host.api.invoke("people.archive", { personId: ids.fay }, { now: NOW });

    const log = (type: string, days: number, people: string[]) =>
      host.api.invoke(
        "people.log_interaction",
        {
          title: `${type} ${days} days ago`,
          type,
          occurredAt: daysAgo(days),
          participants: people.map((personId) => ({ personId })),
        },
        { now: NOW },
      );

    await log("MEAL", 5, [ids.self!, ids.cy!]);
    await log("MEAL", 10, [ids.self!, ids.ada!]);
    await log("CALL", 40, [ids.self!, ids.ada!]);
    // Past the 90 day window for topPeople, inside the twelve months.
    await log("HANGOUT", 100, [ids.self!, ids.ada!, ids.bo!]);
    // Before the twelve months entirely.
    await log("MEAL", 400, [ids.self!, ids.bo!]);
  });

  afterAll(async () => {
    await host.close();
  });

  it("lists what is coming up in order, with days away and years", async () => {
    const data = await dashboard(host);
    expect(data.generatedAt).toBe(NOW.toISOString());

    expect(
      data.upcoming.map(({ kind, displayName, date, daysAway, years }) => ({
        kind,
        displayName,
        date,
        daysAway,
        years,
      })),
    ).toEqual([
      { kind: "birthday", displayName: "Ada", date: "2026-11-24", daysAway: 0, years: 36 },
      { kind: "birthday", displayName: "Abe", date: "2026-11-30", daysAway: 6, years: 35 },
      { kind: "birthday", displayName: "Bo", date: "2026-11-30", daysAway: 6, years: null },
      { kind: "met", displayName: "Cy", date: "2026-12-01", daysAway: 7, years: 6 },
    ]);

    const shown = new Set(data.upcoming.map((row) => row.personId));
    expect(shown.has(ids.self!)).toBe(false);
    expect(shown.has(ids.fay!)).toBe(false);
    expect(shown.has(ids.eve!)).toBe(false);
  });

  it("filters by horizonDays", async () => {
    const short = await dashboard(host, { horizonDays: 6 });
    expect(short.upcoming.map((row) => row.displayName)).toEqual(["Ada", "Abe", "Bo"]);

    const today = await dashboard(host, { horizonDays: 1 });
    expect(today.upcoming.map((row) => row.displayName)).toEqual(["Ada"]);

    const long = await dashboard(host, { horizonDays: 120 });
    const dee = long.upcoming.find((row) => row.personId === ids.dee);
    expect(dee).toMatchObject({ date: "2027-03-01", daysAway: 97, years: 42 });
    // Meeting this year never becomes an anniversary, however far out.
    const year = await dashboard(host, { horizonDays: 366 });
    expect(year.upcoming.some((row) => row.personId === ids.eve)).toBe(false);
  });

  it("refuses a horizon outside 1 to 366", async () => {
    await expect(dashboard(host, { horizonDays: 0 })).rejects.toBeInstanceOf(ToolError);
    await expect(dashboard(host, { horizonDays: 367 })).rejects.toBeInstanceOf(ToolError);
  });

  it("has twelve months, oldest first, ending at the current month", async () => {
    const data = await dashboard(host);
    expect(data.months).toHaveLength(12);
    expect(data.months[0]!.month).toBe("2025-12");
    expect(data.months[11]!.month).toBe("2026-11");

    const byMonth = new Map(data.months.map((row) => [row.month, row]));
    // Two meals this month, with Cy and with Ada; the owner is not counted.
    expect(byMonth.get("2026-11")).toMatchObject({ occasions: 2, people: 2, messages: 0 });
    expect(byMonth.get("2026-10")).toMatchObject({ occasions: 1, people: 1 });
    expect(byMonth.get("2026-08")).toMatchObject({ occasions: 1, people: 2 });
    expect(byMonth.get("2026-09")).toMatchObject({ occasions: 0, people: 0 });
  });

  it("counts occasion types over the twelve months", async () => {
    const data = await dashboard(host);
    expect(data.types[0]).toEqual({ type: "MEAL", count: 2 });
    expect(data.types).toHaveLength(3);
    expect(data.types).toEqual(
      expect.arrayContaining([
        { type: "CALL", count: 1 },
        { type: "HANGOUT", count: 1 },
      ]),
    );
  });

  it("ranks the last 90 days in topPeople without the owner", async () => {
    const data = await dashboard(host);
    expect(data.topPeople.map(({ personId, occasions }) => ({ personId, occasions }))).toEqual([
      { personId: ids.ada, occasions: 2 },
      { personId: ids.cy, occasions: 1 },
    ]);
    expect(data.topPeople.some((row) => row.personId === ids.self)).toBe(false);
  });

  it("counts missing birthdays and totals over active people only", async () => {
    const data = await dashboard(host);
    // Cy and Eve. Not the owner, not Fay.
    expect(data.missingBirthdays).toBe(2);
    expect(data.totals).toEqual({
      people: 6,
      occasions: 5,
      messages: 0,
      conversations: 0,
      occasionsLast30: 2,
    });
  });
});

describe("people.vcard", () => {
  let host: TestHost;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    host = await testHost();
    ids.self = await seedSelf(host, "Owner Self");
    ids.ada = await create(host, { displayName: "Ada", firstName: "Ada", lastName: "Byron" });
    ids.bo = await create(host, { displayName: "Bo" });
    ids.cy = await create(host, { displayName: "Cy" });
    ids.fay = await create(host, { displayName: "Fay" });
    await host.api.invoke("people.archive", { personId: ids.fay }, { now: NOW });
  });

  afterAll(async () => {
    await host.close();
  });

  type Answer = { fileName: string; count: number; vcard: string; mime: string };
  const vcard = async (input: Record<string, unknown>) =>
    (await host.api.invoke("people.vcard", input, { now: NOW })) as Answer;

  it("exports only the people asked for", async () => {
    const answer = await vcard({ personIds: [ids.ada, ids.bo] });
    expect(answer.count).toBe(2);
    expect(answer.mime).toBe("text/vcard");
    expect(answer.fileName).toBe("fellowship-contacts-2026-11-24.vcf");
    expect(answer.vcard).toContain("FN:Ada Byron");
    expect(answer.vcard).toContain("FN:Bo");
    expect(answer.vcard).not.toContain("FN:Cy");

    const one = await vcard({ personIds: [ids.ada] });
    expect(one.count).toBe(1);
    expect(one.fileName).toBe("Ada.vcf");
  });

  it("refuses an id that matches nobody", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const attempt = vcard({ personIds: [ids.ada, missing] });
    await expect(attempt).rejects.toBeInstanceOf(ToolError);
    await expect(attempt).rejects.toMatchObject({ code: "not_found" });
  });

  it("exports everyone active by default, without the owner or the archived", async () => {
    const answer = await vcard({});
    expect(answer.count).toBe(3);
    expect(answer.vcard.split("\r\n").filter((line) => line === "BEGIN:VCARD")).toHaveLength(3);
    expect(answer.vcard).not.toContain("Owner Self");
    expect(answer.vcard).not.toContain("FN:Fay");
  });
});

describe("people.personality_status", () => {
  let host: TestHost;

  beforeAll(async () => {
    host = await testHost();
  });

  afterAll(async () => {
    await host.close();
  });

  type Status = {
    people: Array<{ personId: string; messages: number; stale: boolean }>;
    stale: number;
  };
  const status = async (input: Record<string, unknown> = {}) =>
    (await host.api.invoke("people.personality_status", input, { now: NOW })) as Status;

  it("is empty when nobody has messages", async () => {
    await create(host, { displayName: "Quiet" });
    expect(await status()).toMatchObject({ people: [], stale: 0 });
  });

  it("lists only people with real messages, busiest first", async () => {
    const selfId = await seedSelf(host);
    const ada = await create(host, { displayName: "Ada" });
    const bo = await create(host, { displayName: "Bo" });
    const cy = await create(host, { displayName: "Cy" });

    const message = (personId: string, minutes: number, isSystem = false) => ({
      senderName: personId,
      personId,
      sentAt: new Date(NOW.getTime() - minutes * 60_000),
      body: "hello",
      isSystem,
    });

    await host.db.conversation.create({
      data: {
        title: "Group",
        isGroup: true,
        messages: {
          create: [
            message(ada, 30),
            message(ada, 20),
            message(cy, 10),
            // A system notice is not a message from Bo.
            message(bo, 5, true),
            // The owner is never on the list.
            message(selfId, 1),
          ],
        },
      },
    });

    const answer = await status();
    expect(answer.people.map(({ personId, messages, stale }) => ({ personId, messages, stale })))
      .toEqual([
        { personId: ada, messages: 2, stale: true },
        { personId: cy, messages: 1, stale: true },
      ]);
    expect(answer.stale).toBe(2);
  });
});
