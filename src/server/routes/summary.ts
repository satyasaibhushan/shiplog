import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  runSummarizationPipeline,
  resolveProvider,
  type SummarizationProgress,
} from "../../core/summarizer.ts";
import { isModelSupportedForProvider } from "../../shared/llm-models.ts";
import { SummaryRequestSchema, formatZodError } from "../../shared/schemas.ts";

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
  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = SummaryRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: formatZodError(parsed.error) }, 400);
  }

  const { groups, from, to, repos, provider = "auto", model } = parsed.data;

  // ── Check LLM availability early ──

  let resolvedProvider: "claude" | "codex";
  try {
    resolvedProvider = await resolveProvider(provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 503);
  }

  if (model !== undefined && !isModelSupportedForProvider(resolvedProvider, model)) {
    return c.json(
      {
        error: `Model '${model}' is not supported for provider '${resolvedProvider}'.`,
      },
      400,
    );
  }

  // ── Decide response mode ──

  const acceptSSE = c.req.header("Accept")?.includes("text/event-stream");

  if (acceptSSE) {
    // ── SSE streaming mode ──
    return streamSSE(c, async (stream) => {
      try {
        const result = await runSummarizationPipeline(
          groups,
          { from, to, repos },
          resolvedProvider,
          model,
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
      groups,
      { from, to, repos },
      resolvedProvider,
      model,
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
