import { Hono } from "hono";

export const reposRouter = new Hono();

// GET /api/repos — list user's repos and orgs
reposRouter.get("/", async (c) => {
  // TODO: Implement GitHub repo fetching via gh CLI
  return c.json({ repos: [], orgs: [] });
});
