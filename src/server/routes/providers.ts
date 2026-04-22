import { Hono } from "hono";
import { getProviderStatus } from "../../core/provider-status.ts";

export const providersRouter = new Hono();

// GET /api/providers — per-provider { installed, authed } for claude/codex/cursor.
// The UI uses this to hide model tiles for providers that can't actually run.
providersRouter.get("/", async (c) => {
  const status = await getProviderStatus();
  return c.json(status);
});
