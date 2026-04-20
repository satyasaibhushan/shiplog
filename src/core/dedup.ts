// Patch-id deduplication
// Phase 3: Deduplication

import { eq } from "drizzle-orm";
import { getDb } from "./cache.ts";
import * as schema from "../db/schema.ts";
import type { Commit, PullRequest } from "./github.ts";

// ── Types ──

export interface DedupResult {
  /** One commit per unique patch-id (chronologically first is kept) */
  unique: Commit[];
  /** patchId → array of ALL commit SHAs sharing that patch (including the kept one) */
  duplicates: Map<string, string[]>;
  /** Number of duplicate commits removed */
  totalRemoved: number;
}

// ── Patch-ID Computation ──

/**
 * Compute a patch-id from a diff string.
 *
 * Similar to `git patch-id`: hashes the meaningful content of a diff,
 * ignoring metadata (file headers, hunk line numbers) and normalizing
 * whitespace so that cherry-picks and rebased commits produce the same ID.
 *
 * Returns an empty string if the diff has no meaningful content.
 */
export function computePatchId(diff: string): string {
  if (!diff || !diff.trim()) return "";

  const lines = diff.split("\n");
  const normalized: string[] = [];

  for (const line of lines) {
    // Skip diff metadata lines
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("diff ")) continue;
    if (line.startsWith("index ")) continue;

    // For hunk headers, keep the marker but strip line numbers
    // @@ -10,5 +10,5 @@ → @@
    if (line.startsWith("@@ ")) {
      normalized.push("@@");
      continue;
    }

    // Keep only actual change lines (+ and - prefixed) and context lines
    if (
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith(" ")
    ) {
      // Collapse whitespace within the line for normalization
      const content = line.slice(1).replace(/\s+/g, " ").trim();
      if (content) {
        normalized.push(line[0] + content);
      }
    }
  }

  if (normalized.length === 0) return "";

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(normalized.join("\n"));
  return hasher.digest("hex");
}

// ── Deduplication ──

/**
 * Deduplicate an array of commits by their patch-id.
 *
 * For commits that share the same diff content (e.g. cherry-picks across
 * branches or forks), keeps the chronologically first commit and records
 * the rest as duplicates.
 *
 * Side effects:
 *   - Updates each commit's `patch_id` field in the `commits` table
 *   - Inserts entries into the `dedup_index` table (first-seen mapping)
 */
export function deduplicateCommits(commits: Commit[]): DedupResult {
  if (commits.length === 0) {
    return { unique: [], duplicates: new Map(), totalRemoved: 0 };
  }

  const db = getDb();

  // Sort by date ascending so the chronologically first commit is kept
  const sorted = [...commits].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const patchIdToShas = new Map<string, string[]>();
  const seenPatchIds = new Set<string>();
  const unique: Commit[] = [];
  let removed = 0;

  for (const commit of sorted) {
    // Commits without diffs can't be deduped — keep them all
    if (!commit.diff) {
      unique.push(commit);
      continue;
    }

    const patchId = computePatchId(commit.diff);

    // Empty patch-id means the diff had no meaningful content
    if (!patchId) {
      unique.push(commit);
      continue;
    }

    // Update commit's patch_id in the database
    db.update(schema.commits)
      .set({ patchId })
      .where(eq(schema.commits.sha, commit.sha))
      .run();

    // Track all SHAs for this patch-id
    if (!patchIdToShas.has(patchId)) {
      patchIdToShas.set(patchId, []);
    }
    patchIdToShas.get(patchId)!.push(commit.sha);

    if (!seenPatchIds.has(patchId)) {
      // First occurrence — keep this commit
      seenPatchIds.add(patchId);
      unique.push(commit);

      // Record in dedup_index (first-seen mapping)
      db.insert(schema.dedupIndex)
        .values({ patchId, commitSha: commit.sha })
        .onConflictDoNothing()
        .run();
    } else {
      // Duplicate — skip
      removed++;
    }
  }

  // Only include entries with actual duplicates in the map
  const duplicates = new Map<string, string[]>();
  for (const [patchId, shas] of patchIdToShas) {
    if (shas.length > 1) {
      duplicates.set(patchId, shas);
    }
  }

  if (removed > 0) {
    console.log(
      `  Dedup: removed ${removed} duplicate commit(s) across ${duplicates.size} shared patch-id(s)`,
    );
  }

  return { unique, duplicates, totalRemoved: removed };
}

// ── PR Commit Remap & Filter ──

export interface RemapPullRequestCommitsResult {
  pullRequests: PullRequest[];
  /** Count of PRs whose commit list was non-empty before but empty after. */
  emptiedPrCount: number;
}

/**
 * Rewrite each PR's `commits` list to account for dedup:
 *   1. Remap SHAs that were removed as duplicates to the kept SHA (within
 *      each shared-patch-id set).
 *   2. Drop any SHA that isn't present in `uniqueCommits` at all — these
 *      would otherwise create ghost commits in downstream grouping.
 *
 * Returns a new array of PRs (mutates the input PR objects' `commits` field).
 */
export function remapPullRequestCommits(
  pullRequests: PullRequest[],
  dedup: DedupResult,
): RemapPullRequestCommitsResult {
  const allRemainingShas = new Set(dedup.unique.map((c) => c.sha));
  const shaRemap = new Map<string, string>();

  for (const [, shas] of dedup.duplicates) {
    const kept = shas.find((sha) => allRemainingShas.has(sha));
    if (!kept) continue;
    for (const sha of shas) {
      if (sha !== kept) shaRemap.set(sha, kept);
    }
  }

  let emptiedPrCount = 0;
  for (const pr of pullRequests) {
    const before = pr.commits.length;
    const remapped = pr.commits.map((sha) => shaRemap.get(sha) ?? sha);
    pr.commits = [...new Set(remapped.filter((sha) => allRemainingShas.has(sha)))];
    if (before > 0 && pr.commits.length === 0) emptiedPrCount += 1;
  }

  return { pullRequests, emptiedPrCount };
}
