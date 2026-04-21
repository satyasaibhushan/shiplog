// Git-backed sync for the datastore.
//
// Three responsibilities:
//  1. Lifecycle — `git init` + remote + `.gitattributes` on first run.
//  2. Pull on CLI startup (non-blocking, short timeout).
//  3. Debounced commit + push after writes; flushed on process exit.
//
// Failures are never fatal. Any git error logs a warning and leaves local
// state untouched so the user can keep working offline.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_SYNC_CONFIG,
  getDataDir,
  type SyncConfig,
} from "../cli/config.ts";
import {
  readSummary,
  relativeToDataDir,
  writeLog,
  writePR,
  writeRollupEntity,
  writeSummary,
  writeSummaryVersion,
  type StoredLog,
  type StoredPR,
  type StoredRollup,
  type StoredSummary,
  type StoredSummaryVersion,
  type SummaryType,
} from "./datastore.ts";

// ── State (module-local) ───────────────────────────────────────────────────

interface PendingWrite {
  path: string; // absolute path under data dir
  reason: string; // short tag used in the commit message
}

let pendingWrites: PendingWrite[] = [];
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let currentFlush: Promise<void> | null = null;
let pulledThisSession = false;
let globalSyncConfig: SyncConfig | null = null;

/**
 * Register the effective sync config for the current process. Called once
 * from the CLI entry point after loading user config so the summarizer and
 * other call sites don't have to plumb it through.
 */
export function setSyncConfig(cfg: SyncConfig): void {
  globalSyncConfig = cfg;
}

export function getSyncConfig(): SyncConfig {
  return globalSyncConfig ?? DEFAULT_SYNC_CONFIG;
}

// ── Git invocation ─────────────────────────────────────────────────────────

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function git(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<GitResult> {
  const cwd = opts.cwd ?? getDataDir();
  if (!existsSync(cwd)) {
    return { code: -1, stdout: "", stderr: `cwd missing: ${cwd}`, timedOut: false };
  }

  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  if (opts.timeoutMs) {
    const t = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
    try {
      await proc.exited;
    } finally {
      clearTimeout(t);
    }
  } else {
    await proc.exited;
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: proc.exitCode ?? -1, stdout, stderr, timedOut };
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    const r = await git(["--version"], { cwd: "/" });
    return r.code === 0;
  } catch {
    return false;
  }
}

// ── Initialization ─────────────────────────────────────────────────────────

const DATA_REPO_README = `# shiplog-data

This repository is auto-managed by [shiplog](https://github.com/satyasaibhushan/shiplog). It stores LLM-generated summaries of your GitHub contributions and shared shiplog config, synced across your machines.

## Layout

- \`repos/<owner>/<repo>/prs/<n>.json\` — PR metadata
- \`repos/<owner>/<repo>/summaries/<n>.json\` — per-PR summaries
- \`repos/<owner>/<repo>/orphans/<hash>.json\` — direct-commit (orphan) summaries
- \`repos/<owner>/<repo>/rollups/<hash>.json\` — single-repo period rollups
- \`rollups/<hash>.json\` — multi-repo rollups
- \`summaries/<hash>.json\` — multi-repo summaries (rare)
- \`entities/logs/<id>.json\` — persistent log entities (Atlas workspace)
- \`entities/rollups/<id>.json\` — persistent rollup entities
- \`entities/summary-versions/<kind>/<id>/<n>.json\` — versioned summary history
- \`config.json\` — shared shiplog settings

Stale markers are machine-local and deliberately NOT synced.

## Safe to delete

Nothing here is authoritative. shiplog regenerates any missing summary on the next run — deleting files only costs an LLM re-call.
`;


/**
 * Ensure the data dir exists, is a git repo, has our `.gitattributes`, and
 * points at the configured remote. Idempotent — safe to call on every run.
 */
export async function ensureInitialized(cfg: SyncConfig): Promise<void> {
  if (!cfg.enabled) return;

  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });

  if (!existsSync(join(dir, ".git"))) {
    const init = await git(["init", "-b", "main"], { cwd: dir });
    if (init.code !== 0) {
      console.warn(`  shiplog sync: git init failed — ${init.stderr.trim()}`);
      return;
    }
  }

  // `.gitattributes` — future-proof for jsonl indexes (concurrent-append merge).
  // README — orients anyone who stumbles into the repo on GitHub.
  const attrs = join(dir, ".gitattributes");
  const readme = join(dir, "README.md");
  const needsAttrs = !existsSync(attrs);
  const needsReadme = !existsSync(readme);
  if (needsAttrs) {
    writeFileSync(attrs, "*.jsonl merge=union\n");
  }
  if (needsReadme) {
    writeFileSync(readme, DATA_REPO_README);
  }
  if (needsAttrs || needsReadme) {
    await git(["add", ".gitattributes", "README.md"], { cwd: dir });
    await git(["commit", "-m", "shiplog: initialize data store"], { cwd: dir });
  }

  if (cfg.remoteUrl) {
    const exists = await git(["remote", "get-url", "origin"], { cwd: dir });
    if (exists.code !== 0) {
      await git(["remote", "add", "origin", cfg.remoteUrl], { cwd: dir });
    } else if (exists.stdout.trim() !== cfg.remoteUrl) {
      await git(["remote", "set-url", "origin", cfg.remoteUrl], { cwd: dir });
    }
  }
}

// ── Startup pull ───────────────────────────────────────────────────────────

/**
 * Pull from origin once per process, with a small time budget. Safe to call
 * fire-and-forget from the CLI entry point — never throws.
 */
export async function pullIfDue(
  cfg: SyncConfig,
): Promise<{ ok: boolean; reason?: string }> {
  if (!cfg.enabled) return { ok: false, reason: "sync disabled" };
  if (!cfg.pullOnStart) return { ok: false, reason: "pullOnStart=false" };
  if (!cfg.remoteUrl) return { ok: false, reason: "no remote" };
  if (pulledThisSession) return { ok: true, reason: "already pulled" };
  pulledThisSession = true;

  // Skip silently when the remote has no branches yet. Happens right after
  // `gh repo create` if the first push hasn't landed — complaining about a
  // missing `main` ref would just confuse the user.
  if (!(await remoteHasHeads(cfg.remoteUrl, cfg.pullTimeoutMs))) {
    return { ok: false, reason: "remote has no commits yet" };
  }

  // Explicitly specify the branch — on first run, upstream tracking isn't
  // set yet and plain `git pull` would refuse.
  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.stdout.trim() || "main";

  const r = await git(["pull", "--ff-only", "origin", branch], {
    timeoutMs: cfg.pullTimeoutMs,
  });
  if (r.timedOut) {
    console.warn(`  shiplog sync: pull timed out after ${cfg.pullTimeoutMs}ms`);
    return { ok: false, reason: "timeout" };
  }
  if (r.code !== 0) {
    // Fast-forward refused usually means local has diverging commits.
    // Keep local state; the next push path will try a rebase.
    console.warn(
      `  shiplog sync: pull failed — ${r.stderr.trim().slice(0, 200)}`,
    );
    return { ok: false, reason: r.stderr.trim() };
  }
  return { ok: true };
}

/**
 * Whether the configured remote has any branches. Used to skip pull on a
 * freshly-created empty repo without logging a scary "no ref" warning.
 */
export async function remoteHasHeads(
  remoteUrl: string,
  timeoutMs?: number,
): Promise<boolean> {
  const proc = Bun.spawn(["git", "ls-remote", "--heads", remoteUrl], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  if (timeoutMs) {
    const t = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    try {
      await proc.exited;
    } finally {
      clearTimeout(t);
    }
  } else {
    await proc.exited;
  }
  if (timedOut || proc.exitCode !== 0) return false;
  const out = (await new Response(proc.stdout).text()).trim();
  return out.length > 0;
}

// ── Queued writes + debounced flush ────────────────────────────────────────

/**
 * Register a just-written file for the next commit. Resets the debounce
 * timer; the actual commit + push happens on the trailing edge.
 */
export function queueWrite(
  cfg: SyncConfig,
  path: string,
  reason: string,
): void {
  if (!cfg.enabled) return;
  pendingWrites.push({ path, reason });

  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void flushPending(cfg).catch((err) => {
      console.warn(`  shiplog sync: flush failed — ${err.message}`);
    });
  }, cfg.pushDebounceMs);
}

/**
 * Commit pending writes and push to origin. Waits for any in-flight flush so
 * back-to-back calls serialize cleanly. Returns immediately if nothing is
 * queued.
 *
 * Expected to be called both by the debounce timer and explicitly on process
 * exit (via `shiplog` wrapper).
 */
export async function flushPending(cfg: SyncConfig): Promise<void> {
  if (!cfg.enabled) return;
  if (currentFlush) {
    await currentFlush;
  }
  if (pendingWrites.length === 0) return;

  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }

  const writes = pendingWrites.splice(0);
  currentFlush = runFlush(cfg, writes);
  try {
    await currentFlush;
  } finally {
    currentFlush = null;
  }
}

async function runFlush(cfg: SyncConfig, writes: PendingWrite[]): Promise<void> {
  const uniquePaths = [...new Set(writes.map((w) => w.path))];
  const relPaths = uniquePaths.map(relativeToDataDir);

  const add = await git(["add", "--", ...relPaths]);
  if (add.code !== 0) {
    console.warn(`  shiplog sync: git add failed — ${add.stderr.trim()}`);
    return;
  }

  // If nothing staged (files unchanged from tree), bail early.
  const status = await git(["diff", "--cached", "--quiet"]);
  if (status.code === 0) return;

  const msg = summarizeCommitMessage(writes);
  const commit = await git(["commit", "-m", msg]);
  if (commit.code !== 0) {
    console.warn(
      `  shiplog sync: commit failed — ${commit.stderr.trim().slice(0, 200)}`,
    );
    return;
  }

  if (!cfg.remoteUrl) return;
  await pushHeadWithRebase();
}

/**
 * Catch-up sync: stage any files the debounce timer never got to, commit
 * them, and push anything ahead of origin. Used by `shiplog sync push` so a
 * user can recover from a crash, Ctrl+C, or a push that failed silently —
 * without needing to `cd` into the data dir and run git by hand.
 *
 * Returns a status so the CLI can report what actually happened instead of a
 * blanket "done" that hides no-ops or misconfiguration.
 */
export async function pushExistingCommits(
  cfg: SyncConfig,
): Promise<{ committed: number; pushed: boolean; reason?: string }> {
  if (!cfg.enabled) return { committed: 0, pushed: false, reason: "sync disabled" };
  if (!cfg.remoteUrl) return { committed: 0, pushed: false, reason: "no remoteUrl configured" };
  if (!existsSync(getDataDir())) return { committed: 0, pushed: false, reason: "data dir missing" };

  // Stage everything under the data dir. The debounced queue only tracks
  // writes made via the current process — if an earlier run crashed after
  // writing a file but before flushPending fired, the file sits untracked.
  const add = await git(["add", "-A", "."]);
  if (add.code !== 0) {
    console.warn(`  shiplog sync: git add failed — ${add.stderr.trim()}`);
    return { committed: 0, pushed: false, reason: "git add failed" };
  }

  let committed = 0;
  const hasStaged = await git(["diff", "--cached", "--quiet"]);
  if (hasStaged.code !== 0) {
    const commit = await git(["commit", "-m", "shiplog: sync push"]);
    if (commit.code !== 0) {
      console.warn(
        `  shiplog sync: commit failed — ${commit.stderr.trim().slice(0, 200)}`,
      );
      return { committed: 0, pushed: false, reason: "commit failed" };
    }
    committed = 1;
  }

  // Check if there's anything to push. `@{upstream}` only resolves once the
  // branch has tracking set — on a fresh repo `git push -u` handles that,
  // so fall back to comparing against origin/HEAD or just pushing blind.
  const ahead = await git(["rev-list", "--count", "@{upstream}..HEAD"]);
  const aheadCount = parseInt(ahead.stdout.trim(), 10);
  if (ahead.code === 0 && aheadCount === 0) {
    return { committed, pushed: false, reason: "nothing to push" };
  }

  await pushHeadWithRebase();
  return { committed, pushed: true };
}

async function pushHeadWithRebase(): Promise<void> {
  // `-u` sets upstream tracking on the first push so subsequent pulls don't
  // need an explicit branch argument. No-op once tracking is set.
  const push = await git(["push", "-u", "origin", "HEAD"]);
  if (push.code === 0) return;

  // Include the real stderr so auth/permission errors surface rather than
  // disappearing behind a generic "push rejected" message.
  console.warn(
    `  shiplog sync: push rejected — ${push.stderr.trim().slice(0, 300)}. Retrying after rebase...`,
  );
  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.stdout.trim() || "main";
  const rebase = await git(["pull", "--rebase", "origin", branch]);
  if (rebase.code !== 0) {
    console.warn(
      `  shiplog sync: rebase failed — ${rebase.stderr.trim().slice(0, 200)}. ` +
        "Local commit is preserved; resolve manually in " +
        getDataDir() +
        ".",
    );
    return;
  }

  const retry = await git(["push", "-u", "origin", "HEAD"]);
  if (retry.code !== 0) {
    console.warn(
      `  shiplog sync: push failed after rebase — ${retry.stderr.trim().slice(0, 200)}. ` +
        "Local commit is preserved and will retry on next flush.",
    );
  }
}

function summarizeCommitMessage(writes: PendingWrite[]): string {
  const counts = new Map<string, number>();
  for (const w of writes) {
    counts.set(w.reason, (counts.get(w.reason) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason}`);
  return `shiplog: ${parts.join(", ")}`;
}

// ── Write-through wrappers for the summarizer ──────────────────────────────
//
// Two reasons to go through these instead of calling datastore + queueWrite
// directly from the summarizer:
//  1. They pick up the module-level SyncConfig so callers don't have to
//     thread it through.
//  2. They centralize the routing between per-scope summaries and rollups
//     (different datastore files, different commit-message reasons).

/**
 * Write a summary to disk and (if sync is enabled) queue it for the next
 * commit. Safe to call regardless of whether sync is configured.
 */
export async function persistSummary(s: StoredSummary): Promise<void> {
  const path = await writeSummary(s);
  queueWrite(
    getSyncConfig(),
    path,
    s.summaryType === "rollup" ? "rollup" : "summary",
  );
}

/**
 * Write PR metadata to disk (under `repos/<owner>/<repo>/prs/<n>.json`) and
 * queue for the next commit. PRs authored by others but containing the user's
 * commits are captured here so the cross-machine sync picks them up without
 * paying for another orphan-resolution round trip to GitHub.
 */
export async function persistPR(pr: StoredPR): Promise<void> {
  const path = await writePR(pr);
  queueWrite(getSyncConfig(), path, "pr");
}

/** Write a persistent log entity through the datastore, then queue for sync. */
export async function persistLog(log: StoredLog): Promise<void> {
  const path = await writeLog(log);
  queueWrite(getSyncConfig(), path, "log");
}

/** Write a persistent rollup entity through the datastore, then queue for sync. */
export async function persistRollupEntity(r: StoredRollup): Promise<void> {
  const path = await writeRollupEntity(r);
  queueWrite(getSyncConfig(), path, "rollup-entity");
}

/** Write a summary version through the datastore, then queue for sync. */
export async function persistSummaryVersion(
  v: StoredSummaryVersion,
): Promise<void> {
  const path = await writeSummaryVersion(v);
  queueWrite(getSyncConfig(), path, "summary-version");
}

/**
 * Look up a stored summary by hash. Used by the summarizer as a second-chance
 * read when the SQLite cache misses — recovers work from a previous run on
 * a different machine after a `git pull`.
 */
export async function lookupStoredSummary(
  scope: { repos: string[] },
  hash: string,
  summaryType: SummaryType,
): Promise<StoredSummary | null> {
  return readSummary(scope, summaryType, hash);
}

// ── Test hooks ─────────────────────────────────────────────────────────────

/**
 * Reset module state. Only used by tests — do not call from production code.
 */
export function __resetForTests(): void {
  pendingWrites = [];
  pulledThisSession = false;
  globalSyncConfig = null;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  currentFlush = null;
}

/** Inspect the current pending queue. Tests only. */
export function __pendingCount(): number {
  return pendingWrites.length;
}
