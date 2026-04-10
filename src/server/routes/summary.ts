import { Hono } from "hono";

export const summaryRouter = new Hono();

// POST /api/summary — trigger LLM summarization
summaryRouter.post("/", async (c) => {
  // TODO: Implement LLM summarization pipeline
  const body = await c.req.json();
  return c.json({ summary: null, params: body });
});
