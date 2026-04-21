import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  CreateRollupRequestSchema,
  formatZodError,
} from "../../shared/schemas.ts";
import {
  appendSummaryVersion,
  createRollup,
  getLog,
  getRollup,
  getVersion,
  listRollups,
  listVersions,
  setRollupActiveVersion,
} from "../../core/entities.ts";
import {
  invokeLLM,
  resolveProvider,
  fenceUserContent,
  sanitizeForPrompt,
} from "../../core/summarizer.ts";
import { isModelSupportedForProvider } from "../../shared/llm-models.ts";
import { loadConfig } from "../../cli/config.ts";
import { flushPending, getSyncConfig } from "../../core/git-sync.ts";
import { makeProgress } from "../../shared/progress.ts";
import { join } from "path";

const PROMPTS_DIR = join(import.meta.dir, "../../../prompts");

export const rollupsRouter = new Hono();

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

async function loadPrompt(name: string): Promise<string> {
  const file = Bun.file(join(PROMPTS_DIR, `${name}.txt`));
  return file.text();
}

function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
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

  // Compute the umbrella range from constituent logs.
  const rangeStart = logs
    .map((l) => l!.rangeStart)
    .sort((a, b) => a.localeCompare(b))[0]!;
  const rangeEnd = logs
    .map((l) => l!.rangeEnd)
    .sort((a, b) => b.localeCompare(a))[0]!;
  const repos = [...new Set(logs.map((l) => `${l!.owner}/${l!.repo}`))];

  async function run(
    onProgress?: (p: ReturnType<typeof makeProgress>) => void,
  ) {
    onProgress?.(
      makeProgress("create-overview", {
        current: 0,
        total: 1,
        detail: "Gathering constituent log summaries...",
      }),
    );

    // Build the `summaries` block from each log's active version.
    const sections: string[] = [];
    let aggAdditions = 0;
    let aggDeletions = 0;
    let aggFiles = 0;
    let aggCommits = 0;
    let aggPrs = 0;
    for (const log of logs) {
      const v = getVersion(log!.activeVersionId!);
      if (!v) continue;
      const heading = `### ${log!.owner}/${log!.repo} — ${log!.rangeStart} → ${log!.rangeEnd}`;
      sections.push(
        `${heading}\n\n${sanitizeForPrompt(v.summaryMarkdown)}`,
      );
      if (v.stats) {
        aggAdditions += v.stats.additions ?? 0;
        aggDeletions += v.stats.deletions ?? 0;
        aggFiles += v.stats.files ?? 0;
        aggCommits += v.stats.commits ?? 0;
        aggPrs += v.stats.prs ?? 0;
      }
    }
    const statsLine = `Change size: +${aggAdditions} / -${aggDeletions} across ${aggFiles} file(s), ${aggCommits} commit(s), ${aggPrs} PR(s).`;
    const summariesText = sections.join("\n\n---\n\n");

    // Merge each log's timeline into a single rollup timeline block. These are
    // already date-sorted; concatenate and let the model absorb them as-is.
    const timelineLines: string[] = [];
    for (const log of logs) {
      const v = getVersion(log!.activeVersionId!);
      if (!v?.timeline) continue;
      for (const t of v.timeline) {
        const prs = t.prCount > 0 ? `, ${t.prCount} PR(s)` : "";
        timelineLines.push(
          `- ${t.date} [${log!.owner}/${log!.repo}]: +${t.additions}/-${t.deletions}, ${t.commitCount} commit(s)${prs}`,
        );
      }
    }
    const timelineBlock = timelineLines.sort().join("\n");

    onProgress?.(
      makeProgress("create-overview", {
        current: 0,
        total: 1,
        detail: "Composing rollup summary...",
      }),
    );

    const template = await loadPrompt("rollup-summary");
    const prompt = renderTemplate(template, {
      from: rangeStart,
      to: rangeEnd,
      repos: fenceUserContent(repos.join(", ")),
      stats: statsLine,
      timeline: timelineBlock,
      summaries: fenceUserContent(summariesText),
    });

    const summary = await invokeLLM(prompt, resolvedProvider, model);

    const authorEmail = await getAuthorEmail();
    const rollup = await createRollup({
      title,
      authorEmail,
      rangeStart,
      rangeEnd,
      logIds,
    });

    const version = await appendSummaryVersion({
      parentKind: "rollup",
      parentId: rollup.id,
      summaryMarkdown: summary,
      stats: {
        additions: aggAdditions,
        deletions: aggDeletions,
        files: aggFiles,
        commits: aggCommits,
        prs: aggPrs,
      },
      source: "generated",
      model: model ?? (resolvedProvider === "claude" ? "sonnet" : "gpt-5-mini"),
    });

    onProgress?.(
      makeProgress("create-overview", {
        current: 1,
        total: 1,
        stepDone: true,
      }),
    );

    return { rollupId: rollup.id, versionId: version.id };
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
