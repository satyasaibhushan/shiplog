// Git-backed JSON datastore.
//
// Replaces nothing yet — runs alongside the SQLite cache (write-through).
// The filesystem layout is deliberately human-browsable:
//
//   ~/.shiplog-data/
//     config.json                    (optional — config file may live here too)
//     repos/<owner__repo>/prs/<n>.json       mutable PR metadata
//     repos/<owner__repo>/summaries/<h>.json single-repo summaries
//     summaries/<h>.json                     multi-repo group summaries
//     rollups/<h>.json                       period roll-up summaries
//
// Routing is by *scope* (how many repos the record touches), not by *type*,
// so adding new summary types later doesn't move files or require migration.

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

// ── Path helpers ───────────────────────────────────────────────────────────

/** Convert "owner/repo" to a filesystem-safe directory name. */
export function slugRepo(repo: string): string {
  return repo.replaceAll("/", "__");
}

/** Make a hash safe to use as a filename. */
export function slugHash(hash: string): string {
  return hash.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function prPath(repo: string, num: number): string {
  return join(getDataDir(), "repos", slugRepo(repo), "prs", `${num}.json`);
}

export function summaryPath(
  scope: { repos: string[] },
  hash: string,
): string {
  const safe = slugHash(hash);
  if (scope.repos.length === 1) {
    return join(
      getDataDir(),
      "repos",
      slugRepo(scope.repos[0]!),
      "summaries",
      `${safe}.json`,
    );
  }
  return join(getDataDir(), "summaries", `${safe}.json`);
}

export function rollupPath(hash: string): string {
  return join(getDataDir(), "rollups", `${slugHash(hash)}.json`);
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
  hash: string,
): Promise<StoredSummary | null> {
  return readJson<StoredSummary>(summaryPath(scope, hash));
}

export async function writeSummary(s: StoredSummary): Promise<string> {
  const path = summaryPath(s.scope, s.contentHash);
  await writeJsonAtomic(path, s);
  return path;
}

export async function readRollup(
  hash: string,
): Promise<StoredSummary | null> {
  return readJson<StoredSummary>(rollupPath(hash));
}

export async function writeRollup(s: StoredSummary): Promise<string> {
  const path = rollupPath(s.contentHash);
  await writeJsonAtomic(path, s);
  return path;
}
