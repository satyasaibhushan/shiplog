// Git-backed JSON datastore.
//
// Runs alongside the SQLite cache (write-through). The filesystem layout is
// deliberately human-browsable:
//
//   ~/.shiplog-data/
//     config.json
//     repos/<owner>/<repo>/prs/<n>.json         mutable PR metadata
//     repos/<owner>/<repo>/summaries/<h>.json   per-PR summaries
//     repos/<owner>/<repo>/orphans/<h>.json     orphan-commit summaries
//     repos/<owner>/<repo>/rollups/<h>.json     single-repo rollups
//     rollups/<h>.json                          multi-repo rollups
//     summaries/<h>.json                        multi-repo group summaries
//
// Routing is by (scope, summaryType): single-repo records live under their
// repo's folder, multi-repo records at the top level. Owner and repo are
// separate path segments so GitHub's tree view groups repos under the org.

import { mkdirSync } from "fs";
import { rename, unlink } from "fs/promises";
import { join, dirname, relative } from "path";
import { getDataDir } from "../cli/config.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface StoredPR {
  id: string;
  number: number;
  repo: string;
  title: string;
  state: "merged" | "open" | "closed";
  mergedAt?: string;
  createdAt: string;
  commits: string[];
  stats?: {
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  /** True if the PR was opened by someone other than the shiplog user. */
  openedByOther?: boolean;
}

export type SummaryType = "pr" | "orphan" | "rollup";

export interface StoredSummary {
  contentHash: string;
  summaryType: SummaryType;
  /** Which repos this summary draws from. Drives path routing. */
  scope: { repos: string[] };
  /** Free-form provenance so an operator can eyeball where a file came from. */
  source?: Record<string, unknown>;
  summary: string;
  provider: string;
  createdAt: string;
}

// New persistent entities introduced by the Atlas workspace rewrite. These are
// user-facing records (unlike StoredSummary which is a content-hashed cache
// entry). They live under `entities/` to avoid path collisions with the
// existing `rollups/` and `summaries/` cache trees.

/** Parent kind for a `StoredSummaryVersion`. */
export type SummaryParentKind = "log" | "rollup" | "pr" | "orphan";

export interface StoredLog {
  id: string;
  owner: string;
  repo: string;
  authorEmail: string;
  rangeStart: string;
  rangeEnd: string;
  title?: string;
  activeVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRollup {
  id: string;
  title: string;
  authorEmail: string;
  rangeStart: string;
  rangeEnd: string;
  logIds: string[];
  activeVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSummaryVersion {
  id: string;
  parentKind: SummaryParentKind;
  parentId: string;
  versionNumber: number;
  summaryMarkdown: string;
  timeline?: Array<{
    date: string;
    additions: number;
    deletions: number;
    prCount: number;
    commitCount: number;
    topPRTitles: string[];
  }>;
  stats?: {
    additions: number;
    deletions: number;
    files: number;
    commits: number;
    prs?: number;
    truncated?: boolean;
  };
  source: "generated" | "chat";
  chatPrompt?: Record<string, unknown>;
  model: string;
  createdAt: string;
}

// ── Path helpers ───────────────────────────────────────────────────────────

/** Sanitize a single path segment (owner or repo name) for filesystem use. */
export function slugSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Split "owner/repo" into filesystem-safe `[owner, repo]` segments. Throws on
 * malformed input so a bug upstream surfaces here rather than as a silently
 * wrong path.
 */
export function splitRepo(repo: string): [string, string] {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`datastore: invalid repo "${repo}" (expected "owner/name")`);
  }
  return [slugSegment(parts[0]), slugSegment(parts[1])];
}

/** Make a hash safe to use as a filename. */
export function slugHash(hash: string): string {
  return hash.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Derive a filename from a content hash by stripping the redundant type/repo
 * prefix. The folder already encodes that information, so we only want the
 * distinguishing tail:
 *   "vmockinc/jobs-support:125"       → "125.json"
 *   "orphan:abc123..."                → "abc123....json"
 *   "rollup:def456..."                → "def456....json"
 */
export function filenameFromHash(hash: string): string {
  const colon = hash.lastIndexOf(":");
  const stem = colon === -1 ? hash : hash.slice(colon + 1);
  return `${slugHash(stem)}.json`;
}

/** Subdirectory for a given summary type inside a repo folder. */
function subdirForType(t: SummaryType): string {
  switch (t) {
    case "pr":
      return "summaries";
    case "orphan":
      return "orphans";
    case "rollup":
      return "rollups";
  }
}

export function prPath(repo: string, num: number): string {
  const [owner, name] = splitRepo(repo);
  return join(getDataDir(), "repos", owner, name, "prs", `${num}.json`);
}

export function summaryPath(
  scope: { repos: string[] },
  summaryType: SummaryType,
  hash: string,
): string {
  const filename = filenameFromHash(hash);
  if (scope.repos.length === 1) {
    const [owner, name] = splitRepo(scope.repos[0]!);
    return join(
      getDataDir(),
      "repos",
      owner,
      name,
      subdirForType(summaryType),
      filename,
    );
  }
  // Multi-repo: rollups go to top-level `rollups/`, everything else to
  // top-level `summaries/`. No separate `orphans/` bucket at the top level
  // because cross-repo orphans are rare and don't warrant the directory.
  const topLevel = summaryType === "rollup" ? "rollups" : "summaries";
  return join(getDataDir(), topLevel, filename);
}

// ── New persistent-entity paths (Atlas workspace) ──────────────────────────
//
// These live under `entities/` so they can't collide with the content-hash
// `rollups/` and `summaries/` trees above.

function slugId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function logPath(id: string): string {
  return join(getDataDir(), "entities", "logs", `${slugId(id)}.json`);
}

export function rollupEntityPath(id: string): string {
  return join(getDataDir(), "entities", "rollups", `${slugId(id)}.json`);
}

export function summaryVersionPath(
  parentKind: SummaryParentKind,
  parentId: string,
  versionNumber: number,
): string {
  return join(
    getDataDir(),
    "entities",
    "summary-versions",
    parentKind,
    slugId(parentId),
    `${versionNumber}.json`,
  );
}

/** Return a path relative to the data dir — useful for `git add` arguments. */
export function relativeToDataDir(path: string): string {
  return relative(getDataDir(), path);
}

// ── Atomic JSON R/W ────────────────────────────────────────────────────────

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, `${JSON.stringify(data, null, 2)}\n`);
  try {
    await rename(tmp, path);
  } catch (err) {
    // Clean up the temp file on failure so we don't leave stray .tmp-* files.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`datastore: failed to parse ${path}: ${msg}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function readPR(
  repo: string,
  num: number,
): Promise<StoredPR | null> {
  return readJson<StoredPR>(prPath(repo, num));
}

export async function writePR(pr: StoredPR): Promise<string> {
  const path = prPath(pr.repo, pr.number);
  await writeJsonAtomic(path, pr);
  return path;
}

export async function readSummary(
  scope: { repos: string[] },
  summaryType: SummaryType,
  hash: string,
): Promise<StoredSummary | null> {
  return readJson<StoredSummary>(summaryPath(scope, summaryType, hash));
}

export async function writeSummary(s: StoredSummary): Promise<string> {
  const path = summaryPath(s.scope, s.summaryType, s.contentHash);
  await writeJsonAtomic(path, s);
  return path;
}

// ── New persistent-entity R/W ──────────────────────────────────────────────

export async function readLog(id: string): Promise<StoredLog | null> {
  return readJson<StoredLog>(logPath(id));
}

export async function writeLog(log: StoredLog): Promise<string> {
  const path = logPath(log.id);
  await writeJsonAtomic(path, log);
  return path;
}

export async function readRollupEntity(id: string): Promise<StoredRollup | null> {
  return readJson<StoredRollup>(rollupEntityPath(id));
}

export async function writeRollupEntity(r: StoredRollup): Promise<string> {
  const path = rollupEntityPath(r.id);
  await writeJsonAtomic(path, r);
  return path;
}

export async function readSummaryVersion(
  parentKind: SummaryParentKind,
  parentId: string,
  versionNumber: number,
): Promise<StoredSummaryVersion | null> {
  return readJson<StoredSummaryVersion>(
    summaryVersionPath(parentKind, parentId, versionNumber),
  );
}

export async function writeSummaryVersion(
  v: StoredSummaryVersion,
): Promise<string> {
  const path = summaryVersionPath(v.parentKind, v.parentId, v.versionNumber);
  await writeJsonAtomic(path, v);
  return path;
}
