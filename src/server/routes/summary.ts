import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  runSummarizationPipeline,
  resolveProvider,
  type LLMProvider,
  type SummarizationProgress,
} from "../../core/summarizer.ts";
import type { CommitGroup } from "../../core/grouping.ts";

export const summaryRouter = new Hono();

// POST /api/summary — trigger LLM summarization pipeline
//
// Body: {
//   groups: CommitGroup[],   — from POST /api/contributions response
//   from:   string,          — YYYY-MM-DD
//   to:     string,          — YYYY-MM-DD
//   repos:  string[],        — repo names for context
//   provider?: "claude" | "codex" | "auto"
// }
//
// Accept: text/event-stream  → SSE stream (progress events + final result)
// Accept: application/json   → plain JSON (waits for completion)
//
summaryRouter.post("/", async (c) => {
  let body: Record<string, unknown>;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { groups, from, to, repos, provider = "auto", model } = body;

  // ── Validation ──

  if (!groups || !Array.isArray(groups) || groups.length === 0) {
    return c.json(
      { error: "`groups` is required and must be a non-empty array of CommitGroups" },
      400,
    );
  }

  if (!from || typeof from !== "string") {
    return c.json({ error: "`from` date is required (YYYY-MM-DD)" }, 400);
  }

  if (!to || typeof to !== "string") {
    return c.json({ error: "`to` date is required (YYYY-MM-DD)" }, 400);
  }

  if (!repos || !Array.isArray(repos) || repos.length === 0) {
    return c.json(
      { error: "`repos` is required and must be a non-empty array" },
      400,
    );
  }

  // ── Check LLM availability early ──

  try {
    await resolveProvider(provider as LLMProvider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 503);
  }

  // ── Decide response mode ──

  const acceptSSE = c.req.header("Accept")?.includes("text/event-stream");

  if (acceptSSE) {
    // ── SSE streaming mode ──
    return streamSSE(c, async (stream) => {
      try {
        const result = await runSummarizationPipeline(
          groups as CommitGroup[],
          { from: from as string, to: to as string, repos: repos as string[] },
          provider as LLMProvider,
          model as string | undefined,
          async (progress: SummarizationProgress) => {
            await stream.writeSSE({
              event: "progress",
              data: JSON.stringify(progress),
            });
          },
        );

        await stream.writeSSE({
          event: "complete",
          data: JSON.stringify(result),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: message }),
        });
      }
    });
  }

  // ── Standard JSON mode ──

  try {
    const result = await runSummarizationPipeline(
      groups as CommitGroup[],
      { from: from as string, to: to as string, repos: repos as string[] },
      provider as LLMProvider,
      model as string | undefined,
    );

    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("No LLM CLI found")) {
      return c.json({ error: message }, 503);
    }

    console.error("POST /api/summary error:", err);
    return c.json({ error: message }, 500);
  }
});
