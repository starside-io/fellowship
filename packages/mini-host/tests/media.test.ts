import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  ALLOWED_IMAGE_MIME,
  IMAGE_TIMEOUT_MS,
  ImageFetchError,
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
  assertFetchableUrl,
  isBlockedAddress,
  isBlockedHostname,
  normaliseImageBytes,
} from "../src/media/guard.js";
import { parseOgImage } from "../src/media/og-image.js";
import { createApp } from "../src/server.js";
import { seedPerson, throwawayHost } from "./harness.js";

/**
 * The guard, and the one route that serves bytes.
 *
 * The address tests are the ones that matter: a URL that reaches this machine
 * or this LAN is the hole this file exists to close, and the notations below
 * are all 127.0.0.1 written so a naive string comparison misses it.
 */

describe("the address guard", () => {
  it("blocks loopback however it is spelled", () => {
    for (const value of [
      "127.0.0.1",
      "127.1",
      "127.0.1",
      "2130706433",
      "0x7f000001",
      "017700000001",
      "::1",
      "[::1]",
      "0.0.0.0",
      "0",
    ]) {
      expect(isBlockedAddress(value), value).toBe(true);
    }
  });

  it("blocks the private ranges and link local", () => {
    for (const value of [
      "10.0.0.1",
      "10.11.12.13",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isBlockedAddress(value), value).toBe(true);
    }
  });

  it("lets a public address through", () => {
    for (const value of ["8.8.8.8", "1.1.1.1", "140.82.121.4", "2606:4700::1111"]) {
      expect(isBlockedAddress(value), value).toBe(false);
    }
  });

  it("blocks the names that resolve inside the machine or the LAN", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "api.localhost",
      "printer.local",
      "db.internal",
      "router.home.arpa",
      "127.0.0.1",
      "",
    ]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }

    for (const host of ["github.com", "www.gravatar.com", "unavatar.io"]) {
      expect(isBlockedHostname(host), host).toBe(false);
    }
  });
});

describe("assertFetchableUrl", () => {
  it("refuses anything but https", async () => {
    await expect(assertFetchableUrl("http://github.com/sam.png")).rejects.toBeInstanceOf(
      ImageFetchError,
    );
    await expect(assertFetchableUrl("file:///etc/passwd")).rejects.toBeInstanceOf(
      ImageFetchError,
    );
    await expect(assertFetchableUrl("not a url")).rejects.toBeInstanceOf(ImageFetchError);
  });

  it("refuses a URL carrying credentials", async () => {
    await expect(
      assertFetchableUrl("https://user:secret@github.com/sam.png"),
    ).rejects.toThrow(/credentials/);
  });

  it("refuses a private or local host before DNS is consulted", async () => {
    for (const url of [
      "https://localhost/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://192.168.1.1/a.png",
      "https://169.254.169.254/latest/meta-data",
      "https://2130706433/a.png",
    ]) {
      await expect(assertFetchableUrl(url), url).rejects.toThrow(/private or local/);
    }
  });

  it("keeps the caps and the hop limit the spec names", () => {
    expect(IMAGE_TIMEOUT_MS).toBe(10_000);
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_REDIRECTS).toBe(3);
    expect([...ALLOWED_IMAGE_MIME].sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

describe("the re-encode", () => {
  it("drops EXIF, which is where the GPS point of a face photo lives", async () => {
    const withExif = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#6366f1" },
    })
      .withExif({ IFD0: { Copyright: "Someone", Artist: "Someone" } })
      .jpeg()
      .toBuffer();

    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const normalised = await normaliseImageBytes(withExif);
    expect(normalised.mime).toBe("image/webp");
    expect((await sharp(Buffer.from(normalised.bytes)).metadata()).exif).toBeUndefined();
  });

  it("fits a large picture inside 400px without enlarging a small one", async () => {
    const big = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: "#ef4444" },
    })
      .png()
      .toBuffer();

    const resized = await normaliseImageBytes(big);
    expect(resized.width).toBe(400);
    expect(resized.height).toBe(267);

    const small = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#10b981" },
    })
      .png()
      .toBuffer();

    const kept = await normaliseImageBytes(small);
    expect(kept.width).toBe(32);
  });

  it("refuses bytes that are not an image", async () => {
    await expect(normaliseImageBytes(Buffer.from("not an image"))).rejects.toThrow();
  });
});

describe("parseOgImage", () => {
  it("prefers the explicit social image, then the Twitter fallback", () => {
    expect(
      parseOgImage(
        `<meta property="og:image" content="https://example.test/og.png">
         <meta name="twitter:image" content="https://example.test/twitter.png">`,
        "https://example.test/",
      ),
    ).toBe("https://example.test/og.png");

    expect(
      parseOgImage(
        `<meta name="twitter:image:src" content="/twitter.png">`,
        "https://example.test/about",
      ),
    ).toBe("https://example.test/twitter.png");
  });

  it("drops a candidate that is not https", () => {
    expect(
      parseOgImage(`<meta property="og:image" content="http://example.test/og.png">`, "https://example.test/"),
    ).toBeNull();
    expect(parseOgImage("<p>no meta here</p>", "https://example.test/")).toBeNull();
  });

  it("decodes the entities a real page carries", () => {
    expect(
      parseOgImage(
        `<meta property='og:image' content='https://example.test/og.png?a=1&amp;b=2'>`,
        "https://example.test/",
      ),
    ).toBe("https://example.test/og.png?a=1&b=2");
  });
});

describe("GET /media/person/:id/avatar", () => {
  it("serves the bytes, with an etag, and 404s when there is no picture", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const personId = await seedPerson(host, "Sam Rivera");

      const missing = await app.request(`/media/person/${personId}/avatar`);
      expect(missing.status).toBe(404);

      const bytes = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#6366f1" },
      })
        .webp()
        .toBuffer();

      await host.silo.personAvatar.create({
        data: {
          personId,
          image: new Uint8Array(bytes),
          mime: "image/webp",
          source: "MANUAL",
          sourceUrl: null,
          fetchedAt: new Date("2026-07-31T12:00:00.000Z"),
        },
      });

      const served = await app.request(`/media/person/${personId}/avatar`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/webp");
      expect(Buffer.from(await served.arrayBuffer())).toEqual(bytes);

      const etag = served.headers.get("etag");
      expect(etag).toBeTruthy();

      const revalidated = await app.request(`/media/person/${personId}/avatar`, {
        headers: { "if-none-match": etag! },
      });
      expect(revalidated.status).toBe(304);
    } finally {
      await host.close();
    }
  });
});
