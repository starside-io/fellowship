import { describe, expect, it } from "vitest";

import {
  isBlockedAddress,
  isBlockedHostname,
} from "../src/media/guard.js";
import { parseOgImage } from "../src/media/og-image.js";

// Ported with the fetch guard from the reference implementation's avatar
// tests. The cases are the ones that caught real mistakes: an address written
// so a string comparison misses it, and a page whose preview image is not
// https.

describe("private address guard", () => {
  const blocked = [
    "127.0.0.1",
    "127.1",
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.254",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "[::1]",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.0.1",
    // Legacy notations for 127.0.0.1: decimal, hex, and octal.
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "255.255.255.255",
    "224.0.0.1",
  ];

  for (const address of blocked) {
    it(`blocks ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  const allowed = [
    "140.82.121.4",
    "8.8.8.8",
    "172.32.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    // A name is judged on what DNS answers, not on its spelling.
    "github.com",
    "gravatar.com",
  ];

  for (const address of allowed) {
    it(`allows ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }

  it("blocks the local names before DNS is asked", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("nas.local")).toBe(true);
    expect(isBlockedHostname("api.internal")).toBe(true);
    expect(isBlockedHostname("2130706433")).toBe(true);
    expect(isBlockedHostname("github.com")).toBe(false);
  });
});

describe("og:image parsing", () => {
  it("prefers the secure og:image and resolves a relative path", () => {
    const html = `
      <meta name="twitter:image" content="/twitter.png">
      <meta property="og:image" content="http://example.com/insecure.png">
      <meta property="og:image:secure_url" content="/me.png?w=1&amp;h=2">
    `;

    expect(parseOgImage(html, "https://example.com/about")).toBe(
      "https://example.com/me.png?w=1&h=2",
    );
  });

  it("falls back to twitter:image and skips non https images", () => {
    const html = `<meta name="twitter:image" content="https://cdn.example.com/a.jpg">`;
    expect(parseOgImage(html, "https://example.com/")).toBe(
      "https://cdn.example.com/a.jpg",
    );

    const insecure = `<meta property="og:image" content="http://example.com/a.jpg">`;
    expect(parseOgImage(insecure, "https://example.com/")).toBeNull();
    expect(parseOgImage("<html></html>", "https://example.com/")).toBeNull();
  });
});
