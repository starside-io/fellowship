import { Hono } from "hono";

import type { MiniHost } from "./host.js";

/**
 * GET /media/person/:id/avatar
 *
 * The one route that serves bytes, and the reason no tool response carries
 * them: a picture is fetched by the browser from here, by id, so a person page
 * does not drag every image through a JSON payload.
 */
export function mediaRoutes(host: MiniHost): Hono {
  const app = new Hono();

  app.get("/person/:id/avatar", async (context) => {
    const id = context.req.param("id");

    const avatar = await host.silo.personAvatar.findUnique({
      where: { personId: id },
    });
    if (!avatar) return context.body(null, 404);

    // The bytes only change when the row does, so the fetch time is the tag.
    const etag = `"${avatar.fetchedAt.getTime().toString(36)}"`;
    if (context.req.header("if-none-match") === etag) {
      return context.body(null, 304);
    }

    return context.body(avatar.image as unknown as ArrayBuffer, 200, {
      "content-type": avatar.mime,
      "content-length": String(avatar.image.byteLength),
      etag,
      // Local, private and per-person. Revalidation is cheap and a stale
      // picture after a change is worse than a request.
      "cache-control": "private, max-age=0, must-revalidate",
    });
  });

  return app;
}
