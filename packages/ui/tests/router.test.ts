import { describe, expect, it } from "vitest";

import { hrefOf, parseRoute } from "@/lib/router";

describe("parseRoute", () => {
  it("knows the seven screens", () => {
    expect(parseRoute("/")).toEqual({ name: "dashboard" });
    expect(parseRoute("/people")).toEqual({ name: "people" });
    expect(parseRoute("/personalities")).toEqual({ name: "personalities" });
    expect(parseRoute("/events")).toEqual({ name: "events" });
    expect(parseRoute("/review")).toEqual({ name: "review" });
    expect(parseRoute("/settings")).toEqual({ name: "settings" });
    expect(parseRoute("/people/11111111-1111-4111-8111-111111111111")).toEqual({
      name: "person",
      personId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("ignores a trailing slash", () => {
    expect(parseRoute("/events/")).toEqual({ name: "events" });
    expect(parseRoute("//")).toEqual({ name: "dashboard" });
  });

  it("refuses a person path that is not an id", () => {
    expect(parseRoute("/people/sam")).toEqual({ name: "unknown", path: "/people/sam" });
  });

  it("round trips through hrefOf", () => {
    for (const path of [
      "/",
      "/people",
      "/personalities",
      "/events",
      "/review",
      "/settings",
      "/people/11111111-1111-4111-8111-111111111111",
    ]) {
      expect(hrefOf(parseRoute(path))).toBe(path);
    }
  });
});
