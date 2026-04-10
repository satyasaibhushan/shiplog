import { Hono } from "hono";

export const contributionsRouter = new Hono();

// POST /api/contributions — fetch & process contributions
contributionsRouter.post("/", async (c) => {
  // TODO: Implement contribution fetching, dedup, and grouping
  const body = await c.req.json();
  return c.json({ contributions: [], params: body });
});
