// Shared log/rollup generation pipelines. The HTTP routes (POST /api/logs,
// POST /api/rollups) and the `shiplog report` CLI subcommand all delegate
// here so the persisted entities are identical regardless of entry point.

import { join } from "path";
import { fetchContributions } from "./github.ts";
import { deduplicateCommits, remapPullRequestCommits } from "./dedup.ts";
import { groupCommits } from "./grouping.ts";
import {
  runSummarizationPipeline,
  invokeLLM,
  fenceUserContent,
  sanitizeForPrompt,
  type SummarizationProgress,
} from "./summarizer.ts";
import {
  addDep,
  getLog,
  getRollup,
  createLog,
  createRollup,
  getVersion,
  type LogRecord,
  type RollupRecord,
  type SummaryVersionRecord,
} from "./entities.ts";
import { loadConfig } from "../cli/config.ts";
import { makeProgress, type GenerationProgress } from "../shared/progress.ts";
import type { SupportedLLMProvider } from "../shared/llm-models.ts";

import { fingerprint, singleFlight } from "./report-identity.ts";
import { appendReportVersion } from "./report-version.ts";
import { dateWindow, reportWindow, type ReportKind, type ReportTimezone } from "./report-period.ts";

const PROMPTS_DIR = join(import.meta.dir, "../../prompts");

async function loadPrompt(name: string): Promise<string> {
  const file = Bun.file(join(PROMPTS_DIR, `${name}.txt`));
  return file.text();
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

async function getAuthorEmail(): Promise<string> {
  const cfg = await loadConfig();
  return cfg.gitEmails?.[0] ?? "unknown@local";
}

// Translate SummarizationProgress → unified GenerationProgress.
export function toUnifiedProgress(p: SummarizationProgress): GenerationProgress | null {
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

export type ResolvedProvider = SupportedLLMProvider;

export interface GenerateLogInput {
  owner: string;
  repo: string;
  timezone?: ReportTimezone;
  rangeStart: string;
  rangeEnd: string;
  title?: string;
  provider: ResolvedProvider;
  model: string;
  scope?: string[];
  force?: boolean;
  /** Skip persisting when the range has no contribution groups. */
  skipIfEmpty?: boolean;
  onProgress?: (p: GenerationProgress) => void;
}

export interface GenerateLogResult {
  log: LogRecord;
  version: SummaryVersionRecord;
  groupCount: number;
}

/**
 * Full log pipeline for one repo + range: fetch → dedup → group → summarize →
 * persist a log with its summary version and dependency edges.
 * Returns null when `skipIfEmpty` is set and the range has no activity.
 */
export interface ReportAdapters {
  fetch?: typeof fetchContributions;
  summarize?: typeof runSummarizationPipeline;
}
export function generateLog(
  input: GenerateLogInput,
  adapters: ReportAdapters = {},
): Promise<GenerateLogResult | null> {
  return singleFlight("log-request:" + fingerprint({ ...input, onProgress: undefined }), () =>
    generateLogOnce(input, adapters),
  );
}
async function generateLogOnce(
  input: GenerateLogInput,
  adapters: ReportAdapters,
): Promise<GenerateLogResult | null> {
  const cfg = await loadConfig();
  const repoFull = `${input.owner}/${input.repo}`;
  const scope =
    input.scope && input.scope.length > 0 ? input.scope : ["merged-prs", "direct-commits"];

  const timezone = input.timezone ?? "UTC"; // Existing HTTP callers retain UTC semantics.
  const window = dateWindow(input.rangeStart, input.rangeEnd, timezone);
  const raw = await (adapters.fetch ?? fetchContributions)(
    {
      repos: [repoFull],
      from: window.startInclusive,
      to: new Date(Date.parse(window.endExclusive) - 1).toISOString(),
      scope,
      gitEmails: cfg.gitEmails,
    },
    input.onProgress,
  );

  const dedupResult = deduplicateCommits(raw.commits);
  remapPullRequestCommits(raw.pullRequests, dedupResult);
  const grouping = groupCommits(dedupResult.unique, raw.pullRequests);

  if (input.skipIfEmpty && grouping.groups.length === 0) return null;

  const result = await (adapters.summarize ?? runSummarizationPipeline)(
    grouping.groups,
    { from: input.rangeStart, to: input.rangeEnd, repos: [repoFull], timezone },
    input.provider,
    input.model,
    (p) => {
      const unified = toUnifiedProgress(p);
      if (unified) input.onProgress?.(unified);
    },
    {},
    input.force ?? false,
  );

  const authorEmail = await getAuthorEmail();
  const log = await createLog({
    id:
      "log_" +
      fingerprint({ source: "github", repoFull, authorEmail, window, scope: [...scope].sort() }),
    owner: input.owner,
    repo: input.repo,
    authorEmail,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    title: input.title,
  });

  // Record dependency edges so regenerating a PR/orphan summary can mark
  // this log stale. Edges are keyed by contentHash since PR/orphan summaries
  // flow through the content-hash `summaries` cache.
  for (const g of result.groupSummaries) {
    addDep({
      parentKind: "log",
      parentId: log.id,
      childKind: g.groupType, // 'pr' | 'orphan'
      childId: g.contentHash,
    });
  }

  const version = await appendReportVersion(
    {
      parentKind: "log",
      parentId: log.id,
      summaryMarkdown: result.rollupSummary,
      timeline: result.timeline,
      stats: result.aggregateStats,
      source: "generated",
      model: input.model,
    },
    fingerprint({
      summary: result.rollupSummary,
      timeline: result.timeline,
      stats: result.aggregateStats,
      sources: result.groupSummaries.map((g) => g.contentHash).sort(),
      model: input.model,
      provider: input.provider,
    }),
  );

  return { log: getLog(log.id)!, version, groupCount: grouping.groups.length };
}

export interface GenerateRollupInput {
  title: string;
  /** Constituent logs. Every log must already have an activeVersionId. */
  logs: LogRecord[];
  provider: ResolvedProvider;
  model: string;
  onProgress?: (p: GenerationProgress) => void;
}

export interface GenerateRollupResult {
  rollup: RollupRecord;
  version: SummaryVersionRecord;
}

/**
 * Build a rollup from existing logs. Does NOT re-run the contributions
 * pipeline — it stitches each log's active summary into the rollup prompt.
 */
export async function generateRollup(
  input: GenerateRollupInput,
  summarize: typeof invokeLLM = invokeLLM,
): Promise<GenerateRollupResult> {
  // Capture pointers before coalescing; a newer source must start a distinct request.
  if (!input.logs.length) throw new Error("A rollup requires at least one log");
  const logs = [...new Set(input.logs.map((l) => l.id))].sort().map((id) => {
    const log = getLog(id);
    const version = log?.activeVersionId ? getVersion(log.activeVersionId) : null;
    if (!log || !version || version.parentId !== id || version.parentKind !== "log")
      throw new Error(`Log has no valid active summary: ${id}`);
    return log;
  });
  return singleFlight("rollup-request:" + fingerprint({
    title: input.title, sources: logs.map(l => [l.id, l.activeVersionId]),
    provider: input.provider, model: input.model,
  }), () => generateRollupOnce(input, logs, summarize));
}
async function generateRollupOnce(
  input: GenerateRollupInput,
  logs: LogRecord[],
  summarize: typeof invokeLLM,
): Promise<GenerateRollupResult> {
  const { onProgress } = input;
  const canActivate = () => logs.every(l => getLog(l.id)?.activeVersionId === l.activeVersionId);
  const authorEmail = await getAuthorEmail();
  const rollupId =
    "rollup_" + fingerprint({ title: input.title, authorEmail, logIds: logs.map((l) => l.id) });
  const signature = fingerprint({
    versions: logs.map((l) => l.activeVersionId),
    provider: input.provider,
    model: input.model,
  });
  const existing = getRollup(rollupId);
  const existingVersion = existing?.activeVersionId ? getVersion(existing.activeVersionId) : null;
  if (existing && existingVersion?.chatPrompt?.generationFingerprint === signature)
    return { rollup: existing, version: existingVersion };

  const rangeStart = logs.map((l) => l.rangeStart).sort((a, b) => a.localeCompare(b))[0]!;
  const rangeEnd = logs.map((l) => l.rangeEnd).sort((a, b) => b.localeCompare(a))[0]!;
  const repos = [...new Set(logs.map((l) => `${l.owner}/${l.repo}`))];

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
    const v = getVersion(log.activeVersionId!);
    if (!v) continue;
    const heading = `### ${log.owner}/${log.repo} — ${log.rangeStart} → ${log.rangeEnd}`;
    sections.push(`${heading}\n\n${sanitizeForPrompt(v.summaryMarkdown)}`);
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
    const v = getVersion(log.activeVersionId!);
    if (!v?.timeline) continue;
    for (const t of v.timeline) {
      const prs = t.prCount > 0 ? `, ${t.prCount} PR(s)` : "";
      timelineLines.push(
        `- ${t.date} [${log.owner}/${log.repo}]: +${t.additions}/-${t.deletions}, ${t.commitCount} commit(s)${prs}`,
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

  const summary = await summarize(prompt, input.provider, input.model);

  if (!canActivate()) throw new Error("Report sources changed during generation; retry with current active versions");
  const rollup = await createRollup({
    id: rollupId,
    title: input.title,
    authorEmail,
    rangeStart,
    rangeEnd,
    logIds: logs.map((l) => l.id),
  });

  const version = await appendReportVersion(
    {
      parentKind: "rollup",
      parentId: rollup.id,
      canActivate,
      summaryMarkdown: summary,
      stats: {
        additions: aggAdditions,
        deletions: aggDeletions,
        files: aggFiles,
        commits: aggCommits,
        prs: aggPrs,
      },
      source: "generated",
      model: input.model,
      chatPrompt: {
        sourceVersions: logs.map((l) => ({ logId: l.id, versionId: l.activeVersionId })),
      },
    },
    signature,
  );

  onProgress?.(
    makeProgress("create-overview", {
      current: 1,
      total: 1,
      stepDone: true,
    }),
  );

  return { rollup: getRollup(rollup.id)!, version };
}

// ── Project-wise report rendering (CLI `shiplog report`) ────────────────────

export interface ProjectReportData {
  from: string;
  to: string;
  title: string;
  entries: GenerateLogResult[];
  rollup?: GenerateRollupResult;
}

function statsLine(stats: SummaryVersionRecord["stats"]): string | null {
  if (!stats) return null;
  const prs = stats.prs ? `, ${stats.prs} PR(s)` : "";
  return `> +${stats.additions} / -${stats.deletions} across ${stats.files} file(s), ${stats.commits} commit(s)${prs}`;
}

/** Render a persisted report as project-wise markdown. */
export function renderProjectReport(data: ProjectReportData): string {
  const lines: string[] = [`# ${data.title}`, "", `_${data.from} → ${data.to}_`, ""];

  if (data.rollup) {
    lines.push("## Overview", "", data.rollup.version.summaryMarkdown.trim(), "");
  }

  for (const entry of data.entries) {
    lines.push(`## ${entry.log.owner}/${entry.log.repo}`, "");
    const stats = statsLine(entry.version.stats);
    if (stats) lines.push(stats, "");
    lines.push(entry.version.summaryMarkdown.trim(), "");
  }

  if (data.entries.length === 0) {
    lines.push("_No activity found in this range._", "");
  }

  return lines.join("\n");
}

/** Calendar labels; use reportWindow for half-open UTC bounds. */
export function reportRange(
  kind: ReportKind,
  now = new Date(),
  timezone: ReportTimezone = "UTC",
  weekStartsOn = 1,
): { from: string; to: string } {
  const { from, to } = reportWindow(kind, now, timezone, weekStartsOn);
  return { from, to };
}
