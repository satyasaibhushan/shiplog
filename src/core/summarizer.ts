// LLM integration (claude/codex abstraction)
// Phase 4: LLM Summarization — Map-Reduce Pipeline

import { $ } from "bun";
import { join } from "path";
import { eq } from "drizzle-orm";
import { getDb } from "./cache.ts";
import * as schema from "../db/schema.ts";
import type { CommitGroup } from "./grouping.ts";
import {
  buildPrioritizedDiff,
  splitDiffByFile,
  shouldExcludeFile,
  getFilePriority,
  type FilterOptions,
} from "./filter.ts";

// ── Types ──

export type LLMProvider = "claude" | "codex" | "auto";

export interface GroupSummary {
  groupLabel: string;
  groupType: "pr" | "orphan";
  summary: string;
  contentHash: string;
  cached: boolean;
}

export interface SummarizationResult {
  groupSummaries: GroupSummary[];
  rollupSummary: string;
  provider: string;
  stats: {
    groupsProcessed: number;
    cacheHits: number;
    llmCalls: number;
    totalDuration: number; // ms
  };
}

export interface SummarizationProgress {
  phase: "map" | "reduce" | "complete" | "error";
  current: number;
  total: number;
  groupLabel?: string;
  cached?: boolean;
  error?: string;
}

// ── Constants ──

const PROMPTS_DIR = join(import.meta.dir, "../../prompts");
const MAX_DIFF_INPUT = 120_000; // ~120KB max diff text per LLM call
const LLM_TIMEOUT = 120_000; // 2 minutes per LLM call
const MAP_CONCURRENCY = 3; // Concurrent LLM calls during MAP phase

// ── Provider Detection ──

/**
 * Detect which LLM CLI is available on the user's machine.
 * Priority: claude > codex.
 */
export async function detectProvider(): Promise<"claude" | "codex" | null> {
  try {
    const claude = await $`which claude`.quiet();
    if (claude.exitCode === 0) return "claude";
  } catch {}

  try {
    const codex = await $`which codex`.quiet();
    if (codex.exitCode === 0) return "codex";
  } catch {}

  return null;
}

/**
 * Resolve "auto" to a concrete provider, or validate the given one.
 * Throws if no LLM CLI is available.
 */
export async function resolveProvider(
  provider: LLMProvider,
): Promise<"claude" | "codex"> {
  if (provider !== "auto") return provider;

  const detected = await detectProvider();
  if (!detected) {
    throw new Error(
      "No LLM CLI found. Install the Claude Code CLI (`claude`) or Codex CLI (`codex`). Run `shiplog setup` for help.",
    );
  }
  return detected;
}

// ── Template Rendering ──

/**
 * Load a prompt template from the prompts/ directory.
 */
async function loadTemplate(name: string): Promise<string> {
  const file = Bun.file(join(PROMPTS_DIR, `${name}.txt`));
  if (!(await file.exists())) {
    throw new Error(`Prompt template not found: ${name}.txt`);
  }
  return file.text();
}

/**
 * Render a prompt template by replacing `{{key}}` placeholders.
 */
function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ── LLM Invocation ──

/**
 * Invoke the LLM CLI with a prompt and return the text response.
 *
 * - Claude:  `claude -p "<prompt>"`
 * - Codex:   `codex exec "<prompt>"`
 *
 * Includes a timeout to prevent hanging on unresponsive LLM processes.
 */
async function invokeLLM(
  prompt: string,
  provider: "claude" | "codex",
  model?: string,
  timeout: number = LLM_TIMEOUT,
): Promise<string> {
  const args =
    provider === "claude"
      ? ["claude", "-p", prompt, "--model", model || "sonnet"]
      : ["codex", "exec", ...(model ? ["--model", model] : []), prompt];

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Race between process completion and timeout
  const result = await Promise.race([
    (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode, timedOut: false };
    })(),
    new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
    }>((resolve) =>
      setTimeout(() => {
        proc.kill();
        resolve({
          stdout: "",
          stderr: "LLM call timed out",
          exitCode: -1,
          timedOut: true,
        });
      }, timeout),
    ),
  ]);

  if (result.timedOut) {
    throw new Error(`LLM call timed out after ${timeout / 1000}s`);
  }

  if (result.exitCode !== 0) {
    const errSnippet = result.stderr.trim().slice(0, 300);
    throw new Error(
      `${provider} CLI failed (exit ${result.exitCode}): ${errSnippet}`,
    );
  }

  return result.stdout.trim();
}

// ── Cache Operations ──

/**
 * Look up a cached summary by its content hash.
 */
function getCachedSummary(contentHash: string): string | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.summaries)
    .where(eq(schema.summaries.contentHash, contentHash))
    .get();
  return row?.summary ?? null;
}

/**
 * Store a summary in the cache.
 */
function cacheSummary(
  contentHash: string,
  summaryType: string,
  summary: string,
  provider: string,
): void {
  const db = getDb();
  db.insert(schema.summaries)
    .values({ contentHash, summaryType, summary, provider })
    .onConflictDoNothing()
    .run();
}

/**
 * Compute a stable cache key for a commit group.
 *   - PR group  → "owner/repo:pr_number" (the PR id)
 *   - Orphan    → SHA-256 of sorted commit SHAs (truncated to 16 chars)
 */
function computeGroupHash(group: CommitGroup): string {
  if (group.type === "pr" && group.pr) {
    return group.pr.id; // e.g. "owner/repo:42"
  }

  const sortedShas = group.commits
    .map((c) => c.sha)
    .sort()
    .join(",");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(sortedShas);
  return `orphan:${hasher.digest("hex").slice(0, 16)}`;
}

/**
 * Compute a stable cache key for the roll-up summary.
 * Hash of all underlying group content hashes, sorted.
 */
function computeRollupHash(groupHashes: string[]): string {
  const sorted = [...groupHashes].sort().join(",");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(sorted);
  return `rollup:${hasher.digest("hex").slice(0, 16)}`;
}

// ── Diff Preparation ──

const OVERVIEW_PREVIEW_LINES = 300; // Lines of diff to show per file in overview mode (only truncates very large files)
const MAX_EXPAND_FILES = 5; // Max files to expand in second pass
const LARGE_DIFF_THRESHOLD = MAX_DIFF_INPUT * 0.8; // When to switch to overview mode

interface PreparedDiffs {
  /** The diff text to send to the LLM */
  text: string;
  /** Total untruncated size of all diffs */
  fullSize: number;
  /** Whether this is a truncated overview (needs potential expansion) */
  isOverview: boolean;
  /** All file sections with full content, for expansion pass */
  allSections: Array<{ filePath: string; content: string; commitSha: string }>;
}

/**
 * Prepare diffs for a group. If total diffs fit within limits, returns them in full.
 * If too large, returns an overview with truncated previews per file.
 */
function prepareGroupDiffs(
  group: CommitGroup,
  options: FilterOptions = {},
): PreparedDiffs {
  // Collect all file sections across commits
  const allSections: Array<{ filePath: string; content: string; commitSha: string }> = [];
  let fullSize = 0;

  for (const commit of group.commits) {
    if (!commit.diff) continue;
    const sections = splitDiffByFile(commit.diff);
    for (const s of sections) {
      if (shouldExcludeFile(s.filePath, options)) continue;
      allSections.push({ ...s, commitSha: commit.sha });
      fullSize += s.content.length;
    }
  }

  if (allSections.length === 0) {
    return { text: "", fullSize: 0, isOverview: false, allSections };
  }

  // Sort: high-priority files first
  allSections.sort((a, b) => {
    const pa = getFilePriority(a.filePath) === "high" ? 0 : getFilePriority(a.filePath) === "normal" ? 1 : 2;
    const pb = getFilePriority(b.filePath) === "high" ? 0 : getFilePriority(b.filePath) === "normal" ? 1 : 2;
    return pa - pb;
  });

  // If it fits, return full diffs
  if (fullSize <= LARGE_DIFF_THRESHOLD) {
    const parts: string[] = [];
    let totalSize = 0;
    for (const s of allSections) {
      const section = `// ${s.commitSha.slice(0, 7)} — ${s.filePath}\n${s.content}`;
      if (totalSize + section.length > MAX_DIFF_INPUT) break;
      parts.push(section);
      totalSize += section.length;
    }
    return { text: parts.join("\n\n---\n\n"), fullSize, isOverview: false, allSections };
  }

  // Too large → build overview with truncated previews
  const overviewParts: string[] = [];
  overviewParts.push(`Changed files (${allSections.length} total):\n`);

  // File list
  const filesByCommit = new Map<string, string[]>();
  for (const s of allSections) {
    if (!filesByCommit.has(s.commitSha)) filesByCommit.set(s.commitSha, []);
    filesByCommit.get(s.commitSha)!.push(s.filePath);
  }
  for (const [sha, files] of filesByCommit) {
    overviewParts.push(`Commit ${sha.slice(0, 7)}: ${files.join(", ")}`);
  }
  overviewParts.push("\n---\n");

  // Truncated previews
  let previewSize = overviewParts.join("\n").length;
  for (const s of allSections) {
    const lines = s.content.split("\n");
    const preview = lines.slice(0, OVERVIEW_PREVIEW_LINES).join("\n");
    const truncated = lines.length > OVERVIEW_PREVIEW_LINES
      ? `${preview}\n... [${lines.length - OVERVIEW_PREVIEW_LINES} more lines]`
      : preview;
    const section = `// ${s.filePath}\n${truncated}`;

    if (previewSize + section.length > MAX_DIFF_INPUT) {
      overviewParts.push(`\n... [${allSections.length - overviewParts.length} more file previews omitted]`);
      break;
    }
    overviewParts.push(section);
    previewSize += section.length;
  }

  return {
    text: overviewParts.join("\n\n"),
    fullSize,
    isOverview: true,
    allSections,
  };
}

/**
 * Parse the LLM's response for EXPAND_FILES directive.
 * Returns the list of file paths the LLM wants to see in full.
 */
function parseExpandRequest(response: string): string[] {
  const match = response.match(/EXPAND_FILES:\s*(.+)/i);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(0, MAX_EXPAND_FILES);
}

/**
 * Build the full diff text for specific files from the prepared sections.
 */
function getExpandedDiffs(
  sections: Array<{ filePath: string; content: string; commitSha: string }>,
  filePaths: string[],
): string {
  const pathSet = new Set(filePaths);
  const parts: string[] = [];
  let totalSize = 0;

  for (const s of sections) {
    if (!pathSet.has(s.filePath)) continue;
    const section = `// ${s.commitSha.slice(0, 7)} — ${s.filePath}\n${s.content}`;
    if (totalSize + section.length > MAX_DIFF_INPUT) break;
    parts.push(section);
    totalSize += section.length;
  }

  return parts.join("\n\n---\n\n");
}

// ── MAP: Summarize a Single Group ──

/**
 * Build context string for prompt templates (PR metadata or orphan metadata).
 */
function buildGroupContext(group: CommitGroup): string {
  if (group.type === "pr" && group.pr) {
    return `PR #${group.pr.number}: ${group.pr.title}\nRepo: ${group.pr.repo}\nStatus: ${group.pr.state}`;
  }
  const repos = [...new Set(group.commits.map((c) => c.repo))].join(", ");
  const dates = group.commits.map((c) => c.date).sort();
  return `${group.commits.length} commits in ${repos}\nPeriod: ${dates[0]?.split("T")[0] ?? "?"} to ${dates[dates.length - 1]?.split("T")[0] ?? "?"}`;
}

/**
 * Summarize a single CommitGroup. Checks cache first; calls LLM if uncached.
 *
 * For large diffs, uses a two-pass strategy:
 *   Pass 1: Send overview (file list + truncated previews) → get summary + file expansion requests
 *   Pass 2: Send full diffs for requested files → get refined summary
 */
async function summarizeGroup(
  group: CommitGroup,
  provider: "claude" | "codex",
  model?: string,
  options: FilterOptions = {},
): Promise<GroupSummary> {
  const contentHash = computeGroupHash(group);

  // ── Cache hit? ──
  const cached = getCachedSummary(contentHash);
  if (cached) {
    return {
      groupLabel: group.label,
      groupType: group.type,
      summary: cached,
      contentHash,
      cached: true,
    };
  }

  // ── Prepare diffs ──
  const prepared = prepareGroupDiffs(group, options);
  if (!prepared.text.trim()) {
    const empty = "No meaningful code changes found in this group.";
    cacheSummary(contentHash, group.type, empty, provider);
    return {
      groupLabel: group.label,
      groupType: group.type,
      summary: empty,
      contentHash,
      cached: false,
    };
  }

  const context = buildGroupContext(group);
  let summary: string;

  if (!prepared.isOverview) {
    // ── Single pass: diffs fit within limits ──
    let prompt: string;
    if (group.type === "pr" && group.pr) {
      const template = await loadTemplate("pr-summary");
      prompt = renderTemplate(template, {
        title: group.pr.title,
        number: String(group.pr.number),
        repo: group.pr.repo,
        state: group.pr.state,
        diffs: prepared.text,
      });
    } else {
      const template = await loadTemplate("orphan-summary");
      const repos = [...new Set(group.commits.map((c) => c.repo))].join(", ");
      const dates = group.commits.map((c) => c.date).sort();
      prompt = renderTemplate(template, {
        repo: repos,
        count: String(group.commits.length),
        from: dates[0]?.split("T")[0] ?? "unknown",
        to: dates[dates.length - 1]?.split("T")[0] ?? "unknown",
        diffs: prepared.text,
      });
    }
    summary = await invokeLLM(prompt, provider, model);
  } else {
    // ── Two-pass: overview → optional expansion ──

    // Pass 1: Overview
    const overviewTemplate = await loadTemplate("overview-summary");
    const overviewPrompt = renderTemplate(overviewTemplate, {
      context,
      diffs: prepared.text,
    });
    const overviewResponse = await invokeLLM(overviewPrompt, provider, model);

    // Check if LLM wants to expand any files
    const expandFiles = parseExpandRequest(overviewResponse);

    if (expandFiles.length === 0) {
      // LLM is satisfied with the overview — strip the EXPAND_FILES line
      summary = overviewResponse.replace(/EXPAND_FILES:.*$/im, "").trim();
    } else {
      // Pass 2: Send full diffs for requested files
      const expandedDiffs = getExpandedDiffs(prepared.allSections, expandFiles);

      if (expandedDiffs.trim()) {
        const expandTemplate = await loadTemplate("expand-summary");
        const expandPrompt = renderTemplate(expandTemplate, {
          context,
          previous_summary: overviewResponse.replace(/EXPAND_FILES:.*$/im, "").trim(),
          diffs: expandedDiffs,
        });
        summary = await invokeLLM(expandPrompt, provider, model);
      } else {
        // Couldn't find the requested files — use overview as-is
        summary = overviewResponse.replace(/EXPAND_FILES:.*$/im, "").trim();
      }
    }
  }

  // ── Cache result ──
  cacheSummary(contentHash, group.type, summary, provider);

  return {
    groupLabel: group.label,
    groupType: group.type,
    summary,
    contentHash,
    cached: false,
  };
}

// ── REDUCE: Roll-Up Summary ──

/**
 * Combine all group summaries into a single high-level roll-up.
 */
async function summarizeRollup(
  groupSummaries: GroupSummary[],
  params: { from: string; to: string; repos: string[] },
  provider: "claude" | "codex",
  model?: string,
): Promise<{ summary: string; contentHash: string; cached: boolean }> {
  const groupHashes = groupSummaries.map((g) => g.contentHash);
  const contentHash = computeRollupHash(groupHashes);

  // Cache hit?
  const cached = getCachedSummary(contentHash);
  if (cached) {
    return { summary: cached, contentHash, cached: true };
  }

  // Build combined summaries input
  const summariesText = groupSummaries
    .map((g) => {
      const prefix = g.groupType === "pr" ? "Pull Request" : "Direct Commits";
      return `### ${prefix}: ${g.groupLabel}\n\n${g.summary}`;
    })
    .join("\n\n---\n\n");

  const template = await loadTemplate("rollup-summary");
  const prompt = renderTemplate(template, {
    from: params.from,
    to: params.to,
    repos: params.repos.join(", "),
    summaries: summariesText,
  });

  const summary = await invokeLLM(prompt, provider, model);

  cacheSummary(contentHash, "rollup", summary, provider);

  return { summary, contentHash, cached: false };
}

// ── Concurrency Helper ──

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ── Main Pipeline ──

/**
 * Run the full Map-Reduce summarization pipeline.
 *
 * MAP phase:   Summarize each CommitGroup in parallel (with cache lookups).
 * REDUCE phase: Combine all group summaries into a high-level roll-up.
 *
 * @param groups       CommitGroups from the grouping phase
 * @param params       Date range and repo list (for roll-up context)
 * @param provider     LLM provider preference ("auto" detects available CLI)
 * @param onProgress   Optional callback for streaming progress updates (SSE)
 * @param filterOpts   Diff filter options (exclude patterns, etc.)
 */
export async function runSummarizationPipeline(
  groups: CommitGroup[],
  params: { from: string; to: string; repos: string[] },
  provider: LLMProvider = "auto",
  model?: string,
  onProgress?: (progress: SummarizationProgress) => void,
  filterOpts: FilterOptions = {},
): Promise<SummarizationResult> {
  const startTime = Date.now();
  const resolved = await resolveProvider(provider);
  let cacheHits = 0;
  let llmCalls = 0;

  // ── MAP phase: summarize each group ──

  console.log(`  Summarizing ${groups.length} group(s) via ${resolved}...`);

  const groupSummaries = await mapWithConcurrency(
    groups,
    async (group, i) => {
      onProgress?.({
        phase: "map",
        current: i + 1,
        total: groups.length,
        groupLabel: group.label,
      });

      try {
        const result = await summarizeGroup(group, resolved, model, filterOpts);

        if (result.cached) {
          cacheHits++;
          console.log(
            `    [${i + 1}/${groups.length}] ${group.label} (cached)`,
          );
        } else {
          llmCalls++;
          console.log(`    [${i + 1}/${groups.length}] ${group.label} ✓`);
        }

        onProgress?.({
          phase: "map",
          current: i + 1,
          total: groups.length,
          groupLabel: group.label,
          cached: result.cached,
        });

        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          `    [${i + 1}/${groups.length}] ${group.label} — FAILED: ${errMsg}`,
        );

        onProgress?.({
          phase: "error",
          current: i + 1,
          total: groups.length,
          groupLabel: group.label,
          error: errMsg,
        });

        // Return a placeholder so the pipeline continues
        return {
          groupLabel: group.label,
          groupType: group.type,
          summary: `[Summarization failed: ${errMsg}]`,
          contentHash: computeGroupHash(group),
          cached: false,
        } as GroupSummary;
      }
    },
    MAP_CONCURRENCY,
  );

  // ── REDUCE phase: create roll-up ──

  onProgress?.({
    phase: "reduce",
    current: 1,
    total: 1,
    groupLabel: "Creating roll-up summary...",
  });

  let rollupSummary: string;

  // Filter out failed summaries before roll-up
  const validSummaries = groupSummaries.filter(
    (g) => !g.summary.startsWith("[Summarization failed"),
  );

  if (validSummaries.length === 0) {
    rollupSummary = "No summaries were generated successfully.";
  } else if (validSummaries.length === 1) {
    // Single group — its summary IS the roll-up (skip LLM call)
    rollupSummary = validSummaries[0]!.summary;
  } else {
    try {
      const result = await summarizeRollup(validSummaries, params, resolved, model);
      rollupSummary = result.summary;

      if (result.cached) {
        cacheHits++;
        console.log(`  Roll-up summary (cached)`);
      } else {
        llmCalls++;
        console.log(`  Roll-up summary ✓`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`  Roll-up failed: ${errMsg}`);
      // Graceful fallback: concatenate individual summaries
      rollupSummary = validSummaries
        .map((g) => `## ${g.groupLabel}\n\n${g.summary}`)
        .join("\n\n---\n\n");
    }
  }

  onProgress?.({
    phase: "complete",
    current: groups.length,
    total: groups.length,
  });

  const totalDuration = Date.now() - startTime;
  console.log(
    `\n  ✅ Summarization complete in ${(totalDuration / 1000).toFixed(1)}s` +
      ` (${llmCalls} LLM call(s), ${cacheHits} cache hit(s))\n`,
  );

  return {
    groupSummaries,
    rollupSummary,
    provider: resolved,
    stats: {
      groupsProcessed: groups.length,
      cacheHits,
      llmCalls,
      totalDuration,
    },
  };
}

// ── Legacy / Simple API ──

/**
 * One-shot summarize call (convenience wrapper for simple use cases).
 */
export async function summarize(
  diffs: string,
  prompt: string,
  provider: LLMProvider = "auto",
): Promise<{ summary: string; provider: string }> {
  const resolved = await resolveProvider(provider);
  const fullPrompt = `${prompt}\n\n${diffs}`;
  const summary = await invokeLLM(fullPrompt, resolved);
  return { summary, provider: resolved };
}
