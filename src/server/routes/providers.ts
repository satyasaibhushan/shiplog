import { Hono } from "hono";
import { getProviderStatus } from "../../core/provider-status.ts";

export const providersRouter = new Hono();

// GET /api/providers — per-provider availability plus the merged model catalog.
// The UI uses this to hide unusable providers and prefer runtime-discovered models.
providersRouter.get("/", async (c) => {
  const status = await getProviderStatus({
    force: c.req.query("refresh") === "1",
  });
  return c.json(status);
});
