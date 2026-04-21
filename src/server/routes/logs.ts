import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  CreateLogRequestSchema,
  formatZodError,
} from "../../shared/schemas.ts";
import {
  fetchContributions,
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
  runSummarizationPipeline,
  resolveProvider,
  type SummarizationProgress,
} from "../../core/summarizer.ts";
import { isModelSupportedForProvider } from "../../shared/llm-models.ts";
import {
  appendSummaryVersion,
  createLog,
  getLog,
  listLogsForRepo,
  listVersions,
  setLogActiveVersion,
  addDep,
  getVersion,
} from "../../core/entities.ts";
import { loadConfig } from "../../cli/config.ts";
import { flushPending, getSyncConfig } from "../../core/git-sync.ts";
import {
  makeProgress,
  type GenerationProgress,
} from "../../shared/progress.ts";

export const logsRouter = new Hono();

async function getAuthorEmail(): Promise<string> {
  const cfg = await loadConfig();
  return cfg.gitEmails?.[0] ?? "unknown@local";
}

async function syncAfter(): Promise<void> {
  try {
    await flushPending(getSyncConfig());
  } catch (err) {
    console.warn(
      `  shiplog sync: post-write flush failed — ${(err as Error).message}`,
    );
  }
}

// Translate SummarizationProgress → unified GenerationProgress (copied from summary.ts;
// isolated here so we can add phases specific to the log pipeline later).
function toUnified(p: SummarizationProgress): GenerationProgress | null {
  if (p.phase === "map") {
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
  } = parsed.data;

  let resolvedProvider: "claude" | "codex";
  try {
    resolvedProvider = await resolveProvider(provider);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 503);
  }
  if (model && !isModelSupportedForProvider(resolvedProvider, model)) {
    return c.json(
      { error: `Model '${model}' is not supported for '${resolvedProvider}'.` },
      400,
    );
  }

  const repoFull = `${owner}/${repo}`;
  const contributionScope =
    scope && scope.length > 0 ? scope : ["merged-prs", "direct-commits"];

  async function run(
    onProgress?: (p: GenerationProgress) => void,
  ): Promise<{
    logId: string;
    summaryMarkdown: string;
    versionId: string;
  }> {
    const cfg = await loadConfig();
    const raw = await fetchContributions(
      {
        repos: [repoFull],
        from: rangeStart,
        to: rangeEnd,
        scope: contributionScope,
        gitEmails: cfg.gitEmails,
      },
      onProgress,
    );

    const dedupResult = deduplicateCommits(raw.commits);
    remapPullRequestCommits(raw.pullRequests, dedupResult);
    const grouping = groupCommits(dedupResult.unique, raw.pullRequests);

    const result = await runSummarizationPipeline(
      grouping.groups,
      { from: rangeStart, to: rangeEnd, repos: [repoFull] },
      resolvedProvider,
      model,
      (p) => {
        const unified = toUnified(p);
        if (unified) onProgress?.(unified);
      },
    );

    const authorEmail = await getAuthorEmail();
    const log = await createLog({
      owner,
      repo,
      authorEmail,
      rangeStart,
      rangeEnd,
      title,
    });

    // Record dependency edges so regenerating a PR/orphan summary can mark
    // this log stale. We keep edges keyed by contentHash since PR/orphan rows
    // in the versions table haven't been introduced yet — they flow through
    // the content-hash `summaries` cache.
    for (const g of result.groupSummaries) {
      addDep({
        parentKind: "log",
        parentId: log.id,
        childKind: g.groupType, // 'pr' | 'orphan'
        childId: g.contentHash,
      });
    }

    const version = await appendSummaryVersion({
      parentKind: "log",
      parentId: log.id,
      summaryMarkdown: result.rollupSummary,
      timeline: result.timeline,
      stats: result.aggregateStats,
      source: "generated",
      model: model ?? (resolvedProvider === "claude" ? "sonnet" : "gpt-5-mini"),
    });

    return {
      logId: log.id,
      summaryMarkdown: result.rollupSummary,
      versionId: version.id,
    };
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
