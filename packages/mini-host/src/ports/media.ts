import type { FetchedImage, MediaPort } from "@fellowship/core";

import { fetchGuardedImage } from "../media/guard.js";

/**
 * The media port. Everything dangerous about fetching an image by URL is in
 * media/guard.ts, and the module gets bytes rather than a URL it would have to
 * fetch itself, which is the whole reason this is a port and not a tool.
 */
export function createMediaPort(): MediaPort {
  return {
    async fetchImage(url: string): Promise<FetchedImage> {
      const image = await fetchGuardedImage(url);
      return {
        bytes: image.bytes,
        mime: image.mime,
        sourceUrl: image.finalUrl,
      };
    },
  };
}
