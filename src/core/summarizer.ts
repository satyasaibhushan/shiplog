// LLM integration (claude/codex abstraction)
// Phase 4: LLM Summarization — Map-Reduce Pipeline

import { $ } from "bun";
import { join } from "path";
import { eq } from "drizzle-orm";
import { getDb } from "./cache.ts";
import * as schema from "../db/schema.ts";
import type { CommitGroup } from "./grouping.ts";
import {
  splitDiffByFile,
  shouldExcludeFile,
  getFilePriority,
  type FilterOptions,
} from "./filter.ts";
import { createInflightDedup } from "./retry.ts";
import { persistSummary, lookupStoredSummary } from "./git-sync.ts";
import type { SummaryType } from "./datastore.ts";

// ── Types ──

export type LLMProvider = "claude" | "codex" | "cursor" | "auto";

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
  /** Aggregated size data across all groups — ready for persistence. */
  aggregateStats: GroupStats & { prs: number };
  /** Day-by-day timeline of activity, computed deterministically from sources. */
  timeline: TimelineEntry[];
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

// Provider binary → absolute path. We resolve via `which` once and reuse the
// absolute path for every Bun.spawn call so spawn never has to do its own
// PATH lookup. This dodges a Bun race condition where concurrent spawns of
// an unqualified command name intermittently throw
// `Executable not found in $PATH` even though the binary is on PATH — which
// otherwise shows up as "works for some LLM calls, fails for others" during
// the MAP phase.
const resolvedBinaryPaths: Partial<Record<"claude" | "codex" | "cursor", string>> = {};

async function resolveBinary(command: string): Promise<string | null> {
  try {
    const res = await $`which ${command}`.quiet();
    if (res.exitCode !== 0) return null;
    const path = res.stdout.toString().trim();
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Get the cached absolute path for a provider's CLI. Falls back to the bare
 * command name if resolution fails for some reason — Bun.spawn will then
 * produce the "Executable not found" error as a last resort, which the caller
 * already surfaces.
 */
function binaryFor(provider: "claude" | "codex" | "cursor"): string {
  const command =
    provider === "claude"
      ? "claude"
      : provider === "codex"
        ? "codex"
        : "cursor-agent";
  return resolvedBinaryPaths[provider] ?? command;
}

/**
 * Detect which LLM CLI is available on the user's machine.
 * Priority: claude > codex > cursor.
 *
 * Also caches the absolute binary path for each provider it finds so every
 * subsequent `invokeLLM` call can skip PATH resolution.
 */
export async function detectProvider(): Promise<"claude" | "codex" | "cursor" | null> {
  const claudePath = await resolveBinary("claude");
  if (claudePath) {
    resolvedBinaryPaths.claude = claudePath;
    return "claude";
  }

  const codexPath = await resolveBinary("codex");
  if (codexPath) {
    resolvedBinaryPaths.codex = codexPath;
    return "codex";
  }

  const cursorPath = await resolveBinary("cursor-agent");
  if (cursorPath) {
    resolvedBinaryPaths.cursor = cursorPath;
    return "cursor";
  }

  return null;
}

/**
 * Ensure the absolute path for a provider's CLI is cached, resolving it via
 * `which` on first call. Called up-front by `invokeLLM` so the MAP phase
 * doesn't race on PATH resolution.
 */
async function ensureBinaryResolved(
  provider: "claude" | "codex" | "cursor",
): Promise<void> {
  if (resolvedBinaryPaths[provider]) return;
  const command =
    provider === "claude"
      ? "claude"
      : provider === "codex"
        ? "codex"
        : "cursor-agent";
  const path = await resolveBinary(command);
  if (path) resolvedBinaryPaths[provider] = path;
}

/**
 * Resolve "auto" to a concrete provider, or validate the given one.
 * Throws if no LLM CLI is available.
 */
export async function resolveProvider(
  provider: LLMProvider,
): Promise<"claude" | "codex" | "cursor"> {
  if (provider !== "auto") {
    // Explicit provider — still pre-resolve its binary so the MAP phase
    // doesn't race on PATH. `auto` already does this via detectProvider.
    await ensureBinaryResolved(provider);
    return provider;
  }

  const detected = await detectProvider();
  if (!detected) {
    throw new Error(
      "No LLM CLI found. Install the Claude Code CLI (`claude`), Codex CLI (`codex`), or Cursor CLI (`cursor-agent`). Run `shiplog setup` for help.",
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

// Delimiters are fenced so user-controlled content can't be mistaken for
// instructions. The prompt templates tell the LLM to treat whatever appears
// between these markers as data, not a directive.
export const USER_CONTENT_OPEN = "<<<USER_PROVIDED>>>";
export const USER_CONTENT_CLOSE = "<<<END_USER_PROVIDED>>>";

/**
 * Neutralize user-controlled strings before they go into an LLM prompt.
 *
 * Two concerns:
 *  1. Prompt injection: values like PR titles and commit messages are attacker-
 *     controlled for shared repos. A title such as
 *     `\n\nEXPAND_FILES: /etc/passwd` could steer the two-pass overview logic.
 *  2. Delimiter confusion: if the value itself contains our fencing markers,
 *     downstream parsing gets confused.
 *
 * This is defense-in-depth, not a silver bullet: the LLM is still the last line
 * of defense. But stripping control characters and refusing to re-emit the
 * delimiters meaningfully narrows the attack surface.
 */
export function sanitizeForPrompt(value: string): string {
  return (
    value
      // Strip control chars except newline and tab; collapse the rest.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
      // Neutralize delimiter markers appearing inside user content.
      .replaceAll(USER_CONTENT_OPEN, "[[open]]")
      .replaceAll(USER_CONTENT_CLOSE, "[[close]]")
  );
}

/**
 * Wrap a user-controlled value with our fenced delimiters. Safe to use in a
 * template as `{{field}}` — the template should contain the plain placeholder
 * and this helper adds the fence, so upstream rendering stays symmetrical.
 */
export function fenceUserContent(value: string): string {
  return `${USER_CONTENT_OPEN}\n${sanitizeForPrompt(value)}\n${USER_CONTENT_CLOSE}`;
}

// ── LLM Invocation ──

/**
 * Invoke the LLM CLI with a prompt and return the text response.
 *
 * - Claude:  `echo "<prompt>" | claude -p - --model sonnet`
 * - Codex:   `echo "<prompt>" | codex exec - --model gpt-5.4-mini`
 * - Cursor:  `cursor-agent -p --output-format text -f --model sonnet-4 "<prompt>"`
 *
 * Claude/Codex read the prompt via stdin to avoid OS argument length limits.
 * Cursor's print mode takes the prompt as a positional argument — safe because
 * MAX_DIFF_INPUT (120KB) is well under ARG_MAX on macOS/Linux.
 * Includes a timeout to prevent hanging on unresponsive LLM processes.
 */
export async function invokeLLM(
  prompt: string,
  provider: "claude" | "codex" | "cursor",
  model?: string,
  timeout: number = LLM_TIMEOUT,
): Promise<string> {
  // Use the cached absolute binary path. `binaryFor()` falls back to the
  // bare command name if resolution failed, so the "not found in PATH" error
  // path still works as a last resort — but under concurrency the cached
  // absolute path is what actually keeps us out of Bun's PATH-lookup race.
  await ensureBinaryResolved(provider);
  const binary = binaryFor(provider);

  let args: string[];

  if (provider === "claude") {
    args = [binary, "-p", "-", "--model", model || "sonnet"];
  } else if (provider === "cursor") {
    // `-p` enables print/non-interactive mode; `--output-format text` avoids
    // the default stream-json; `-f` auto-allows tool calls so the agent
    // doesn't hang on a permission prompt when it decides to poke around.
    args = [
      binary,
      "-p",
      "--output-format", "text",
      "-f",
      ...(model ? ["--model", model] : []),
      prompt,
    ];
  } else {
    // `--skip-git-repo-check` so codex runs regardless of where `shiplog`
    // was invoked from. Without it, launches outside a trusted git repo
    // (e.g. `~`) fail with "Not inside a trusted directory".
    args = [
      binary, "exec",
      "--skip-git-repo-check",
      ...(model ? ["-m", model] : []),
      "-", // read prompt from stdin
    ];
  }

  const proc = Bun.spawn(args, {
    stdin: new Response(prompt).body!,
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
    // cursor-agent renders its auth/login UI to stdout (not stderr) and still
    // exits non-zero, so fall back to stdout when stderr is empty. Strip ANSI
    // escapes so TTY control bytes don't pollute the surfaced message.
    const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
    const stderrSnippet = stripAnsi(result.stderr).trim();
    const stdoutSnippet = stripAnsi(result.stdout).trim();
    const raw = (stderrSnippet || stdoutSnippet).slice(0, 300);

    const looksUnauthed =
      provider === "cursor" &&
      /sign in|not logged in|login|press any key/i.test(
        stderrSnippet + stdoutSnippet,
      );
    const hint = looksUnauthed
      ? " — run `cursor-agent login` to authenticate"
      : "";

    throw new Error(
      `${provider} CLI failed (exit ${result.exitCode})${hint}: ${raw}`,
    );
  }

  return result.stdout.trim();
}

// ── Cache Operations ──

/**
 * Look up a cached summary by its content hash. Returns the full row so
 * callers can back-fill the git-backed datastore when it's missing.
 */
export function getCachedSummaryRow(
  contentHash: string,
): { summary: string; provider: string } | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.summaries)
    .where(eq(schema.summaries.contentHash, contentHash))
    .get();
  if (!row) return null;
  return { summary: row.summary, provider: row.provider };
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

/** Compute the datastore scope for a CommitGroup. */
function scopeForGroup(group: CommitGroup): { repos: string[] } {
  if (group.type === "pr" && group.pr) {
    return { repos: [group.pr.repo] };
  }
  const repos = [...new Set(group.commits.map((c) => c.repo))];
  return { repos };
}

/**
 * Two-tier cache read: SQLite first (fast), then the JSON datastore (the
 * second-chance path recovers summaries pulled from another machine that
 * SQLite hasn't seen yet).
 *
 * Back-fill rule: whichever tier has the summary, ensure the *other* tier
 * gets it too. Without this, a summary cached in SQLite would never reach
 * the git-synced datastore (orphans stay local forever), and a summary
 * pulled from git would keep going through the slow path every call.
 */
async function lookupCachedSummary(
  contentHash: string,
  scope: { repos: string[] },
  summaryType: SummaryType,
  source?: Record<string, unknown>,
): Promise<string | null> {
  const fromSqlite = getCachedSummaryRow(contentHash);

  if (fromSqlite) {
    // Back-fill the datastore if the correctly-scoped file isn't there. Keep
    // it best-effort — a datastore failure shouldn't break the fast path.
    // `source` carries provenance (PR number, commit SHAs, or rollup period +
    // group hashes) that SQLite doesn't store but the caller knows; without
    // it, the JSON file would be a provenance-free blob.
    try {
      const existing = await lookupStoredSummary(scope, contentHash, summaryType);
      if (!existing) {
        await persistSummary({
          contentHash,
          summaryType,
          scope,
          source,
          summary: fromSqlite.summary,
          provider: fromSqlite.provider,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  shiplog: datastore back-fill failed (${msg})`);
    }
    return fromSqlite.summary;
  }

  const fromDatastore = await lookupStoredSummary(scope, contentHash, summaryType);
  if (!fromDatastore) return null;

  cacheSummary(
    contentHash,
    fromDatastore.summaryType,
    fromDatastore.summary,
    fromDatastore.provider,
  );
  return fromDatastore.summary;
}

/**
 * Write-through: SQLite (for fast local reads) + JSON file + git queue.
 * Never throws — persistence to the datastore is best-effort; we don't want
 * a filesystem hiccup to lose LLM output that already hit SQLite.
 */
async function persistSummaryEverywhere(args: {
  contentHash: string;
  summaryType: SummaryType;
  scope: { repos: string[] };
  source?: Record<string, unknown>;
  summary: string;
  provider: string;
}): Promise<void> {
  cacheSummary(args.contentHash, args.summaryType, args.summary, args.provider);
  try {
    await persistSummary({
      contentHash: args.contentHash,
      summaryType: args.summaryType,
      scope: args.scope,
      source: args.source,
      summary: args.summary,
      provider: args.provider,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  shiplog: datastore write failed (${msg})`);
  }
}

/**
 * Compute a stable cache key for a commit group. Commit SHAs are mixed into
 * the hash so that when the commit list changes (e.g. a prior bug produced an
 * empty PR group and was later fixed), the cache naturally misses instead of
 * returning the stale summary.
 *   - PR group  → "owner/repo:pr_number:<sha16>"
 *   - Orphan    → "orphan:<sha16>"
 */
export function computeGroupHash(group: CommitGroup): string {
  const sortedShas = group.commits
    .map((c) => c.sha)
    .sort()
    .join(",");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(sortedShas);
  const shaDigest = hasher.digest("hex").slice(0, 16);

  if (group.type === "pr" && group.pr) {
    return `${group.pr.id}:${shaDigest}`;
  }
  return `orphan:${shaDigest}`;
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

export interface GroupStats {
  additions: number;
  deletions: number;
  files: number;
  commits: number;
  /** True if any constituent commit had its file list truncated by GitHub. */
  truncated: boolean;
}

export interface TimelineEntry {
  /** YYYY-MM-DD */
  date: string;
  additions: number;
  deletions: number;
  prCount: number;
  commitCount: number;
  /** Up to 5 PR titles merged that day, for model context. */
  topPRTitles: string[];
}

/**
 * Aggregate per-file size data into a single group-level stats object.
 * Unique-file count is computed across commits (a file touched in two commits
 * counts once).
 */
export function computeGroupStats(group: CommitGroup): GroupStats {
  // Merge commits pull in upstream changes that aren't the author's work —
  // excluding them keeps aggregate +/- counts meaningful. Counted toward
  // `commits` regardless so commit totals still match reality.
  let additions = 0;
  let deletions = 0;
  let truncated = false;
  const files = new Set<string>();

  // Prefer PR-level stats (matches GitHub's base...head compare) when available.
  if (group.type === "pr" && group.pr?.stats) {
    return {
      additions: group.pr.stats.additions,
      deletions: group.pr.stats.deletions,
      files: group.pr.stats.changedFiles,
      commits: group.commits.length,
      truncated: false,
    };
  }

  for (const c of group.commits) {
    if (c.isMerge) continue;
    const s = c.stats;
    if (s) {
      additions += s.additions;
      deletions += s.deletions;
      if (s.truncated) truncated = true;
      for (const f of s.perFile) files.add(f.filename);
    } else if (c.files) {
      for (const f of c.files) files.add(f);
    }
  }
  return {
    additions,
    deletions,
    files: files.size,
    commits: group.commits.length,
    truncated,
  };
}

/**
 * Format stats as a one-line header for prompt injection.
 * Kept short so the model treats it as a factual preamble, not a constraint.
 */
export function formatStatsLine(stats: GroupStats): string {
  const truncNote = stats.truncated ? " (file list truncated — partial)" : "";
  return `Change size: +${stats.additions} / -${stats.deletions} across ${stats.files} file(s), ${stats.commits} commit(s)${truncNote}.`;
}

/**
 * Build a structural timeline from the set of groups used in a rollup.
 * This is deterministic metadata (not LLM-generated) — one entry per calendar
 * day that saw activity.
 */
export function computeTimeline(groups: CommitGroup[]): TimelineEntry[] {
  const byDay = new Map<string, TimelineEntry>();
  for (const g of groups) {
    for (const c of g.commits) {
      const date = (c.date ?? "").slice(0, 10);
      if (!date) continue;
      let entry = byDay.get(date);
      if (!entry) {
        entry = {
          date,
          additions: 0,
          deletions: 0,
          prCount: 0,
          commitCount: 0,
          topPRTitles: [],
        };
        byDay.set(date, entry);
      }
      // Merge commits aren't real work — skip their +/- but keep counting the commit.
      if (!c.isMerge) {
        entry.additions += c.stats?.additions ?? 0;
        entry.deletions += c.stats?.deletions ?? 0;
      }
      entry.commitCount += 1;
    }
    if (g.type === "pr" && g.pr) {
      // Attribute the PR to its merge day (fallback: creation day).
      const prDate = (g.pr.mergedAt ?? g.pr.createdAt ?? "").slice(0, 10);
      if (prDate) {
        let entry = byDay.get(prDate);
        if (!entry) {
          entry = {
            date: prDate,
            additions: 0,
            deletions: 0,
            prCount: 0,
            commitCount: 0,
            topPRTitles: [],
          };
          byDay.set(prDate, entry);
        }
        entry.prCount += 1;
        if (entry.topPRTitles.length < 5) {
          entry.topPRTitles.push(g.pr.title);
        }
      }
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Format a timeline array for prompt injection. Kept empty-string when there
 * are fewer than 2 days so the prompt doesn't ask for a timeline that would be
 * a single line (the prompt itself conditions on this).
 */
export function formatTimelineForPrompt(timeline: TimelineEntry[]): string {
  if (timeline.length < 2) return "";
  const lines = timeline.map((t) => {
    const prs = t.prCount > 0 ? `, ${t.prCount} PR${t.prCount > 1 ? "s" : ""}` : "";
    const titles = t.topPRTitles.length ? ` — ${t.topPRTitles.join("; ")}` : "";
    return `- ${t.date}: +${t.additions}/-${t.deletions}, ${t.commitCount} commit${t.commitCount > 1 ? "s" : ""}${prs}${titles}`;
  });
  return lines.join("\n");
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
 * Parse the LLM's response for an EXPAND_FILES directive.
 *
 * Tightened to:
 *   - Only match at the start of a line (prevents a commit message or a prose
 *     sentence containing the phrase from hijacking the parser).
 *   - Only look at the last ~25 lines of the response, where the directive is
 *     expected (summaries can be long and contain quoted file content earlier).
 *   - Strip surrounding quotes/backticks that LLMs sometimes wrap paths in.
 */
export function parseExpandRequest(response: string): string[] {
  const tail = response.trimEnd().split("\n").slice(-25).join("\n");
  const match = tail.match(/^\s*EXPAND_FILES:\s*(.+)$/im);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((f) => f.trim().replace(/^[`'"]+|[`'"]+$/g, ""))
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

// ── In-flight dedup ──
//
// Concurrent MAP workers (and concurrent HTTP requests) can hit `summarizeGroup`
// for the same content hash before the first call finishes caching its result.
// Without coordination they all pay for the LLM call. The dedup helper ensures
// only one call escapes; the rest await the in-flight promise.
const inflightSummaries = createInflightDedup<string>();

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
  provider: "claude" | "codex" | "cursor",
  model?: string,
  options: FilterOptions = {},
): Promise<GroupSummary> {
  const contentHash = computeGroupHash(group);
  const scope = scopeForGroup(group);
  // Same provenance shape the non-cached path writes at persistSummaryEverywhere
  // — keep them aligned so a file back-filled from SQLite looks identical to
  // one written from a fresh LLM call.
  const source: Record<string, unknown> =
    group.type === "pr" && group.pr
      ? { prNumber: group.pr.number, prId: group.pr.id }
      : { commitShas: group.commits.map((c) => c.sha) };

  // ── Two-tier cache (SQLite → JSON datastore) ──
  const cached = await lookupCachedSummary(contentHash, scope, group.type, source);
  if (cached) {
    return {
      groupLabel: group.label,
      groupType: group.type,
      summary: cached,
      contentHash,
      cached: true,
    };
  }

  // ── In-flight dedup: reuse any ongoing call for the same content hash ──
  const { value: summary, dedupedFromInflight } = await inflightSummaries.dedupe(
    contentHash,
    () => computeSummary(group, provider, contentHash, model, options),
  );

  return {
    groupLabel: group.label,
    groupType: group.type,
    summary,
    contentHash,
    // A dedup hit means another caller paid for the LLM work — report as cached.
    cached: dedupedFromInflight,
  };
}

/**
 * Do the actual work of summarizing one group (diff prep, LLM call, cache write).
 * Separate from the in-flight coordination above so the happy path stays flat.
 */
async function computeSummary(
  group: CommitGroup,
  provider: "claude" | "codex" | "cursor",
  contentHash: string,
  model?: string,
  options: FilterOptions = {},
): Promise<string> {
  // ── Prepare diffs ──
  const prepared = prepareGroupDiffs(group, options);
  const scope = scopeForGroup(group);
  const source: Record<string, unknown> =
    group.type === "pr" && group.pr
      ? { prNumber: group.pr.number, prId: group.pr.id }
      : { commitShas: group.commits.map((c) => c.sha) };

  if (!prepared.text.trim()) {
    const empty = "No meaningful code changes found in this group.";
    await persistSummaryEverywhere({
      contentHash,
      summaryType: group.type,
      scope,
      source,
      summary: empty,
      provider,
    });
    return empty;
  }

  const context = buildGroupContext(group);
  const groupStats = computeGroupStats(group);
  const statsLine = formatStatsLine(groupStats);
  const timelineEntries = computeTimeline([group]);
  const timelineBlock = formatTimelineForPrompt(timelineEntries);
  let summary: string;

  if (!prepared.isOverview) {
    // ── Single pass: diffs fit within limits ──
    // User-controlled values (PR title, repo name, commit messages inside
    // diffs) are fenced so the LLM treats them as data, not instructions.
    let prompt: string;
    if (group.type === "pr" && group.pr) {
      const template = await loadTemplate("pr-summary");
      prompt = renderTemplate(template, {
        title: fenceUserContent(group.pr.title),
        number: String(group.pr.number),
        repo: fenceUserContent(group.pr.repo),
        state: group.pr.state, // enum, not attacker-controlled
        stats: statsLine,
        timeline: timelineBlock,
        diffs: fenceUserContent(prepared.text),
      });
    } else {
      const template = await loadTemplate("orphan-summary");
      const repos = [...new Set(group.commits.map((c) => c.repo))].join(", ");
      const dates = group.commits.map((c) => c.date).sort();
      prompt = renderTemplate(template, {
        repo: fenceUserContent(repos),
        count: String(group.commits.length),
        from: dates[0]?.split("T")[0] ?? "unknown",
        to: dates[dates.length - 1]?.split("T")[0] ?? "unknown",
        stats: statsLine,
        timeline: timelineBlock,
        diffs: fenceUserContent(prepared.text),
      });
    }
    summary = await invokeLLM(prompt, provider, model);
  } else {
    // ── Two-pass: overview → optional expansion ──

    // Pass 1: Overview
    const overviewTemplate = await loadTemplate("overview-summary");
    const overviewPrompt = renderTemplate(overviewTemplate, {
      context: fenceUserContent(context),
      stats: statsLine,
      timeline: timelineBlock,
      diffs: fenceUserContent(prepared.text),
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
        // previous_summary is LLM output but routed back into a prompt —
        // fence it so an earlier injected directive can't reassert itself.
        const prevCleaned = overviewResponse.replace(/EXPAND_FILES:.*$/im, "").trim();
        const expandPrompt = renderTemplate(expandTemplate, {
          context: fenceUserContent(context),
          stats: statsLine,
          timeline: timelineBlock,
          previous_summary: fenceUserContent(prevCleaned),
          diffs: fenceUserContent(expandedDiffs),
        });
        summary = await invokeLLM(expandPrompt, provider, model);
      } else {
        // Couldn't find the requested files — use overview as-is
        summary = overviewResponse.replace(/EXPAND_FILES:.*$/im, "").trim();
      }
    }
  }

  // ── Cache result (SQLite + git-backed datastore) ──
  await persistSummaryEverywhere({
    contentHash,
    summaryType: group.type,
    scope,
    source,
    summary,
    provider,
  });

  return summary;
}

// ── REDUCE: Roll-Up Summary ──

/**
 * Combine all group summaries into a single high-level roll-up.
 */
async function summarizeRollup(
  groupSummaries: GroupSummary[],
  params: {
    from: string;
    to: string;
    repos: string[];
    statsLine?: string;
    timelineBlock?: string;
  },
  provider: "claude" | "codex" | "cursor",
  model?: string,
): Promise<{ summary: string; contentHash: string; cached: boolean }> {
  const groupHashes = groupSummaries.map((g) => g.contentHash);
  const contentHash = computeRollupHash(groupHashes);
  const scope = { repos: params.repos };
  const source = {
    period: { from: params.from, to: params.to },
    groupHashes,
  };

  // Two-tier cache (SQLite → JSON datastore)
  const cached = await lookupCachedSummary(contentHash, scope, "rollup", source);
  if (cached) {
    return { summary: cached, contentHash, cached: true };
  }

  // Build combined summaries input. Each segment is treated as user-controlled
  // content because group labels + summary text originate in PR titles / commit
  // messages that flowed through the MAP phase.
  const summariesText = groupSummaries
    .map((g) => {
      const prefix = g.groupType === "pr" ? "Pull Request" : "Direct Commits";
      return `### ${prefix}: ${sanitizeForPrompt(g.groupLabel)}\n\n${sanitizeForPrompt(g.summary)}`;
    })
    .join("\n\n---\n\n");

  const template = await loadTemplate("rollup-summary");
  const prompt = renderTemplate(template, {
    from: params.from, // validated YYYY-MM-DD by the request schema
    to: params.to,
    repos: fenceUserContent(params.repos.join(", ")),
    stats: params.statsLine ?? "",
    timeline: params.timelineBlock ?? "",
    summaries: fenceUserContent(summariesText),
  });

  const summary = await invokeLLM(prompt, provider, model);

  await persistSummaryEverywhere({
    contentHash,
    summaryType: "rollup",
    scope,
    source: {
      period: { from: params.from, to: params.to },
      groupHashes,
    },
    summary,
    provider,
  });

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

  // Groups run with MAP_CONCURRENCY parallelism, so the array index is NOT a
  // valid progress counter — a later index can finish before an earlier one.
  // Track a monotonic completion counter instead so the bar only moves
  // forward.
  let doneCount = 0;

  const groupSummaries = await mapWithConcurrency(
    groups,
    async (group) => {
      try {
        const result = await summarizeGroup(group, resolved, model, filterOpts);
        doneCount++;

        if (result.cached) {
          cacheHits++;
          console.log(
            `    [${doneCount}/${groups.length}] ${group.label} (cached)`,
          );
        } else {
          llmCalls++;
          console.log(`    [${doneCount}/${groups.length}] ${group.label} ✓`);
        }

        onProgress?.({
          phase: "map",
          current: doneCount,
          total: groups.length,
          groupLabel: group.label,
          cached: result.cached,
        });

        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        doneCount++;
        console.warn(
          `    [${doneCount}/${groups.length}] ${group.label} — FAILED: ${errMsg}`,
        );

        onProgress?.({
          phase: "error",
          current: doneCount,
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

  // Aggregate stats + timeline across all groups. This feeds BOTH the rollup
  // prompt ({{stats}} / {{timeline}} slots) AND the persisted summary_versions
  // row via the return value.
  const aggregateStatsBase = groups.reduce<GroupStats>(
    (acc, g) => {
      const s = computeGroupStats(g);
      return {
        additions: acc.additions + s.additions,
        deletions: acc.deletions + s.deletions,
        files: acc.files + s.files, // approximate; cross-group dedup skipped
        commits: acc.commits + s.commits,
        truncated: acc.truncated || s.truncated,
      };
    },
    { additions: 0, deletions: 0, files: 0, commits: 0, truncated: false },
  );
  const prCount = groups.filter((g) => g.type === "pr").length;
  const aggregateStats = { ...aggregateStatsBase, prs: prCount };
  const aggregateStatsLine = formatStatsLine(aggregateStatsBase);
  const timeline = computeTimeline(groups);
  const timelineBlock = formatTimelineForPrompt(timeline);

  if (validSummaries.length === 0) {
    rollupSummary = "No summaries were generated successfully.";
  } else if (validSummaries.length === 1) {
    // Single group — its summary IS the roll-up (skip LLM call)
    rollupSummary = validSummaries[0]!.summary;
  } else {
    try {
      const result = await summarizeRollup(
        validSummaries,
        {
          ...params,
          statsLine: aggregateStatsLine,
          timelineBlock,
        },
        resolved,
        model,
      );
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
    aggregateStats,
    timeline,
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
