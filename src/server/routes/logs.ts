import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  CreateLogRequestSchema,
  formatZodError,
} from "../../shared/schemas.ts";
import {
  listCachedCommitsForRange,
  listCachedPRsForRange,
} from "../../core/github.ts";
import {
  deduplicateCommits,
  remapPullRequestCommits,
} from "../../core/dedup.ts";
import { groupCommits } from "../../core/grouping.ts";
import {
  computeGroupHash,
  getCachedSummaryRow,
  resolveProvider,
} from "../../core/summarizer.ts";
import { getDefaultModel } from "../../shared/llm-models.ts";
import { getProviderStatus } from "../../core/provider-status.ts";
import {
  getLog,
  listLogsForRepo,
  listVersions,
  setLogActiveVersion,
  getVersion,
  deleteLog,
} from "../../core/entities.ts";
import { generateLog } from "../../core/report.ts";
import { flushPending, getSyncConfig } from "../../core/git-sync.ts";
import { type GenerationProgress } from "../../shared/progress.ts";

export const logsRouter = new Hono();

async function syncAfter(): Promise<void> {
  try {
    await flushPending(getSyncConfig());
  } catch (err) {
    console.warn(
      `  shiplog sync: post-write flush failed — ${(err as Error).message}`,
    );
  }
}

// GET /api/logs — list all logs
logsRouter.get("/", (c) => {
  return c.json({ logs: [] }); // atlas covers this — kept only so client never 404s
});

// GET /api/logs/repo/:owner/:repo — logs scoped to a repo (for RepoView)
logsRouter.get("/repo/:owner/:repo", (c) => {
  const { owner, repo } = c.req.param();
  return c.json({ logs: listLogsForRepo(owner, repo) });
});

// GET /api/logs/:id — hydrate a log with its active version
logsRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  const log = getLog(id);
  if (!log) return c.json({ error: "Log not found" }, 404);
  const active = log.activeVersionId ? getVersion(log.activeVersionId) : null;
  const versions = listVersions("log", id);
  return c.json({ log, activeVersion: active, versions });
});

// GET /api/logs/:id/contributions — PRs + orphan commit groups sourced from
// the local cache (populated when the log was first generated). No GitHub fetch.
logsRouter.get("/:id/contributions", (c) => {
  const id = c.req.param("id");
  const log = getLog(id);
  if (!log) return c.json({ error: "Log not found" }, 404);

  const repoFull = `${log.owner}/${log.repo}`;
  const commits = listCachedCommitsForRange(repoFull, log.rangeStart, log.rangeEnd);
  const prs = listCachedPRsForRange(repoFull, log.rangeStart, log.rangeEnd);
  const dedup = deduplicateCommits(commits);
  remapPullRequestCommits(prs, dedup);
  const grouping = groupCommits(dedup.unique, prs);

  const groupsWithSummary = grouping.groups.map((g) => {
    const contentHash = computeGroupHash(g);
    const cached = getCachedSummaryRow(contentHash);
    return {
      ...g,
      contentHash,
      summary: cached?.summary ?? null,
    };
  });

  return c.json({
    groups: groupsWithSummary,
    stats: grouping.stats,
  });
});

// GET /api/logs/:id/versions — version history
logsRouter.get("/:id/versions", (c) => {
  const id = c.req.param("id");
  const log = getLog(id);
  if (!log) return c.json({ error: "Log not found" }, 404);
  return c.json({ versions: listVersions("log", id) });
});

// POST /api/logs/:id/activate — set active version id
logsRouter.post("/:id/activate", async (c) => {
  const id = c.req.param("id");
  const log = getLog(id);
  if (!log) return c.json({ error: "Log not found" }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const versionId = (body as { versionId?: string } | null)?.versionId;
  if (!versionId) return c.json({ error: "versionId is required" }, 400);
  const v = getVersion(versionId);
  if (!v || v.parentKind !== "log" || v.parentId !== id) {
    return c.json({ error: "Version does not belong to this log" }, 400);
  }
  await setLogActiveVersion(id, versionId);
  await syncAfter();
  return c.json({ log: getLog(id) });
});

// DELETE /api/logs/:id — permanently remove a log and all its summary
// versions so it can be regenerated from scratch. Member rollups are flagged
// stale by the entity layer.
logsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const removed = await deleteLog(id);
    if (!removed) return c.json({ error: "Log not found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("DELETE /api/logs/:id error:", err);
    return c.json({ error: message }, 500);
  } finally {
    await syncAfter();
  }
});

// POST /api/logs — create a log (runs the full pipeline; streams SSE progress)
logsRouter.post("/", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = CreateLogRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: formatZodError(parsed.error) }, 400);
  }
  const {
    owner,
    repo,
    rangeStart,
    rangeEnd,
    title,
    provider = "auto",
    model,
    scope,
    force = false,
  } = parsed.data;

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

  async function run(
    onProgress?: (p: GenerationProgress) => void,
  ): Promise<{ logId: string; versionId: string }> {
    const res = await generateLog({
      owner,
      repo,
      rangeStart,
      rangeEnd,
      title,
      provider: resolvedProvider,
      model: resolvedModel,
      scope,
      force,
      onProgress,
    });
    return { logId: res!.log.id, versionId: res!.version.id };
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
        const log = getLog(res.logId);
        const version = getVersion(res.versionId);
        await stream.writeSSE({
          event: "complete",
          data: JSON.stringify({ log, activeVersion: version }),
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
    const log = getLog(res.logId);
    const version = getVersion(res.versionId);
    return c.json({ log, activeVersion: version });
  } catch (err) {
    await syncAfter();
    const msg = (err as Error).message;
    console.error("POST /api/logs error:", err);
    return c.json({ error: msg }, 500);
  }
});
