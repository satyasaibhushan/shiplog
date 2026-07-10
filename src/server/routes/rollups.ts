import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  CreateRollupRequestSchema,
  formatZodError,
} from "../../shared/schemas.ts";
import {
  getLog,
  getRollup,
  getVersion,
  listRollups,
  listVersions,
  setRollupActiveVersion,
  deleteRollup,
  type LogRecord,
} from "../../core/entities.ts";
import { resolveProvider } from "../../core/summarizer.ts";
import { generateRollup } from "../../core/report.ts";
import { getDefaultModel } from "../../shared/llm-models.ts";
import { getProviderStatus } from "../../core/provider-status.ts";
import { flushPending, getSyncConfig } from "../../core/git-sync.ts";
import { type GenerationProgress } from "../../shared/progress.ts";

export const rollupsRouter = new Hono();

async function syncAfter(): Promise<void> {
  try {
    await flushPending(getSyncConfig());
  } catch (err) {
    console.warn(
      `  shiplog sync: post-write flush failed — ${(err as Error).message}`,
    );
  }
}

// GET /api/rollups — list all rollups
rollupsRouter.get("/", (c) => {
  return c.json({ rollups: listRollups() });
});

// GET /api/rollups/:id — hydrate with active version
rollupsRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  const rollup = getRollup(id);
  if (!rollup) return c.json({ error: "Rollup not found" }, 404);
  const active = rollup.activeVersionId
    ? getVersion(rollup.activeVersionId)
    : null;
  const versions = listVersions("rollup", id);
  return c.json({ rollup, activeVersion: active, versions });
});

// GET /api/rollups/:id/versions
rollupsRouter.get("/:id/versions", (c) => {
  const id = c.req.param("id");
  const rollup = getRollup(id);
  if (!rollup) return c.json({ error: "Rollup not found" }, 404);
  return c.json({ versions: listVersions("rollup", id) });
});

// POST /api/rollups/:id/activate
rollupsRouter.post("/:id/activate", async (c) => {
  const id = c.req.param("id");
  const rollup = getRollup(id);
  if (!rollup) return c.json({ error: "Rollup not found" }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const versionId = (body as { versionId?: string } | null)?.versionId;
  if (!versionId) return c.json({ error: "versionId is required" }, 400);
  const v = getVersion(versionId);
  if (!v || v.parentKind !== "rollup" || v.parentId !== id) {
    return c.json({ error: "Version does not belong to this rollup" }, 400);
  }
  await setRollupActiveVersion(id, versionId);
  await syncAfter();
  return c.json({ rollup: getRollup(id) });
});

// DELETE /api/rollups/:id — permanently remove a rollup and its summary
// versions. Member logs are left intact.
rollupsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const removed = await deleteRollup(id);
    if (!removed) return c.json({ error: "Rollup not found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("DELETE /api/rollups/:id error:", err);
    return c.json({ error: message }, 500);
  } finally {
    await syncAfter();
  }
});

// POST /api/rollups — create a rollup from existing logs.
// Unlike logs, a rollup does NOT re-run the contributions pipeline. It
// stitches together each constituent log's active summary and feeds that into
// the rollup prompt. This matches the user directive: "For PR/Rollup chat,
// you can send already summarized chats as the context."
rollupsRouter.post("/", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = CreateRollupRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: formatZodError(parsed.error) }, 400);
  }
  const { title, logIds, provider = "auto", model } = parsed.data;

  // Validate that every log id exists and has an active version.
  const logs = logIds.map((id) => getLog(id));
  const missing = logIds.filter((_, i) => !logs[i]);
  if (missing.length > 0) {
    return c.json(
      { error: `Logs not found: ${missing.join(", ")}` },
      400,
    );
  }
  const missingSummary = logs.filter((l) => l && !l.activeVersionId);
  if (missingSummary.length > 0) {
    return c.json(
      {
        error: `Some logs have no active summary: ${missingSummary
          .map((l) => l!.id)
          .join(", ")}`,
      },
      400,
    );
  }

  let resolvedProvider: "claude" | "codex" | "cursor";
  try {
    resolvedProvider = await resolveProvider(provider);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 503);
  }
  const providerCatalog = (await getProviderStatus())[resolvedProvider];
  const availableModels = providerCatalog.models;
  if (
    model &&
    providerCatalog.modelCatalogSource === "runtime" &&
    !availableModels.some((entry) => entry.id === model)
  ) {
    return c.json(
      {
        error:
          `Model '${model}' is not supported for '${resolvedProvider}'. ` +
          `Available models: ${availableModels.map((entry) => entry.id).join(", ")}.`,
      },
      400,
    );
  }
  const resolvedModel = model ?? availableModels[0]?.id ?? getDefaultModel(resolvedProvider);

  async function run(onProgress?: (p: GenerationProgress) => void) {
    const res = await generateRollup({
      title,
      logs: logs as LogRecord[],
      provider: resolvedProvider,
      model: resolvedModel,
      onProgress,
    });
    return { rollupId: res.rollup.id, versionId: res.version.id };
  }

  const acceptSSE = c.req.header("Accept")?.includes("text/event-stream");
  if (acceptSSE) {
    return streamSSE(c, async (stream) => {
      try {
        const res = await run((p) => {
          void stream.writeSSE({
            event: "progress",
            data: JSON.stringify(p),
          });
        });
        const rollup = getRollup(res.rollupId);
        const version = getVersion(res.versionId);
        await stream.writeSSE({
          event: "complete",
          data: JSON.stringify({ rollup, activeVersion: version }),
        });
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: (err as Error).message }),
        });
      } finally {
        await syncAfter();
      }
    });
  }

  try {
    const res = await run();
    await syncAfter();
    const rollup = getRollup(res.rollupId);
    const version = getVersion(res.versionId);
    return c.json({ rollup, activeVersion: version });
  } catch (err) {
    await syncAfter();
    console.error("POST /api/rollups error:", err);
    return c.json({ error: (err as Error).message }, 500);
  }
});
