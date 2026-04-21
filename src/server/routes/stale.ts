import { Hono } from "hono";
import { listStaleMarkers } from "../../core/entities.ts";

export const staleRouter = new Hono();

// GET /api/stale — all currently-stale (parentKind, parentId) pairs.
staleRouter.get("/", (c) => {
  return c.json({ markers: listStaleMarkers() });
});
