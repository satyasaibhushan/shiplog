import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  runSummarizationPipeline,
  resolveProvider,
  type SummarizationProgress,
} from "../../core/summarizer.ts";
import { isModelSupportedForProvider } from "../../shared/llm-models.ts";
import { SummaryRequestSchema, formatZodError } from "../../shared/schemas.ts";
import {
  makeProgress,
  type GenerationProgress,
} from "../../shared/progress.ts";
import { flushPending, getSyncConfig } from "../../core/git-sync.ts";

// Push any queued summaries to the remote. Swallows errors — sync failures
// shouldn't break the response the user is waiting on.
async function syncAfterGenerate(): Promise<void> {
  try {
    await flushPending(getSyncConfig());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  shiplog sync: post-generate flush failed — ${msg}`);
  }
}

export const summaryRouter = new Hono();

/**
 * Translate internal SummarizationProgress (map/reduce/complete) into the
 * unified GenerationProgress shape used by the UI stepper.
 *
 * Returns null for "complete" — the caller sends that via the SSE "complete"
 * event once the final result is ready.
 */
function toGenerationProgress(
  p: SummarizationProgress,
): GenerationProgress | null {
  if (p.phase === "map") {
    // Groups finish out-of-order (MAP_CONCURRENCY = 3) so we can't derive
    // stepDone from a single event. The UI advances the step when it sees
    // the first "create-overview" event.
    return makeProgress("summarize-groups", {
      current: p.current,
      total: p.total,
      detail: p.groupLabel
        ? `${p.current}/${p.total} · ${p.cached ? "cached · " : ""}${p.groupLabel}`
        : `${p.current}/${p.total}`,
      cached: p.cached,
    });
  }
  if (p.phase === "reduce") {
    return makeProgress("create-overview", {
      current: 0,
      total: 1,
      detail: p.groupLabel ?? "Creating roll-up summary...",
    });
  }
  if (p.phase === "error") {
    return makeProgress("summarize-groups", {
      current: p.current,
      total: p.total,
      detail: `error: ${p.error ?? "unknown"}${p.groupLabel ? ` · ${p.groupLabel}` : ""}`,
    });
  }
  return null;
}

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
        // Kick off step 6 immediately so the UI advances even before the
        // first group finishes (groups can take 30s+).
        await stream.writeSSE({
          event: "progress",
          data: JSON.stringify(
            makeProgress("summarize-groups", {
              current: 0,
              total: groups.length,
              detail: `preparing ${groups.length} group(s)`,
            }),
          ),
        });

        const result = await runSummarizationPipeline(
          groups,
          { from, to, repos },
          resolvedProvider,
          model,
          async (progress: SummarizationProgress) => {
            const unified = toGenerationProgress(progress);
            if (!unified) return;
            await stream.writeSSE({
              event: "progress",
              data: JSON.stringify(unified),
            });
          },
        );

        // Mark step 7 (create-overview) as done.
        await stream.writeSSE({
          event: "progress",
          data: JSON.stringify(
            makeProgress("create-overview", {
              current: 1,
              total: 1,
              stepDone: true,
            }),
          ),
        });

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
      } finally {
        // Push whatever was persisted — partial results from a failed run
        // are still worth syncing so another machine doesn't regenerate them.
        await syncAfterGenerate();
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
  } finally {
    await syncAfterGenerate();
  }
});
