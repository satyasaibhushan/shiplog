// PR grouping + orphan clustering
// Phase 3: Grouping Strategy

import type { Commit, PullRequest } from "./github.ts";

// ── Constants ──

/** Time window for clustering orphan commits together (4 hours) */
const TIME_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Maximum commits in a single orphan group */
const MAX_GROUP_SIZE = 20;

// ── Types ──

export interface CommitGroup {
  /** "pr" if linked to a pull request, "orphan" if not */
  type: "pr" | "orphan";
  /** Human-readable label for this group */
  label: string;
  /** All commits in this group (sorted by date ascending) */
  commits: Commit[];
  /** The associated PR, if type is "pr" */
  pr?: PullRequest;
}

export interface GroupingResult {
  /** All groups: PR groups first, then orphan clusters */
  groups: CommitGroup[];
  /** Stats about the grouping */
  stats: {
    prGroups: number;
    orphanGroups: number;
    orphanCommits: number;
    commitsInPRs: number;
  };
}

// ── Helpers ──

/**
 * Extract the set of parent directories touched by a commit.
 * e.g. "src/core/github.ts" → {"src/core", "src"}
 */
function getDirectories(commit: Commit): Set<string> {
  const dirs = new Set<string>();
  for (const file of commit.files ?? []) {
    const parts = file.split("/");
    // Add each directory level (not the filename itself)
    for (let depth = 1; depth < parts.length; depth++) {
      dirs.add(parts.slice(0, depth).join("/"));
    }
    // If file is at root (no directory), add "." as a marker
    if (parts.length === 1) {
      dirs.add(".");
    }
  }
  return dirs;
}

/**
 * Count how many directory entries two sets share.
 */
function directoryOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const dir of a) {
    if (b.has(dir)) count++;
  }
  return count;
}

/**
 * Generate a human-readable label for an orphan commit group.
 * e.g. "5 changes in src/core/ (2024-03-01 – 2024-03-03)"
 */
function generateGroupLabel(commits: Commit[], dirs: Set<string>): string {
  // Find the most common top-level directory (depth ≤ 2)
  const dirCounts = new Map<string, number>();
  for (const d of dirs) {
    if (d === ".") continue;
    const topLevel = d.split("/").slice(0, 2).join("/");
    dirCounts.set(topLevel, (dirCounts.get(topLevel) ?? 0) + 1);
  }

  let locationPart: string;
  if (dirCounts.size > 0) {
    const sorted = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);
    const topDir = sorted[0]![0];
    if (sorted.length > 2) {
      locationPart = `changes in ${topDir}/ (+${sorted.length - 1} dirs)`;
    } else if (sorted.length === 2) {
      locationPart = `changes in ${topDir}/ and ${sorted[1]![0]}/`;
    } else {
      locationPart = `changes in ${topDir}/`;
    }
  } else {
    locationPart = "direct commits";
  }

  // Date range
  const dates = commits.map((c) => new Date(c.date).getTime());
  const minDate = new Date(Math.min(...dates));
  const maxDate = new Date(Math.max(...dates));

  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const datePart =
    fmt(minDate) === fmt(maxDate)
      ? fmt(minDate)
      : `${fmt(minDate)} – ${fmt(maxDate)}`;

  return `${commits.length} ${locationPart} (${datePart})`;
}

// ── Orphan Clustering ──

/**
 * Cluster orphan commits by file-path proximity and time proximity.
 *
 * Algorithm (greedy, streaming):
 *   1. Sort commits by date ascending
 *   2. For each commit, find the best existing group:
 *      - Must be within TIME_WINDOW of the group's latest commit
 *      - Prefer groups with directory overlap (higher score)
 *      - Fallback to time-only grouping if no better match
 *   3. If no suitable group, start a new one
 *   4. Groups are capped at MAX_GROUP_SIZE
 */
function clusterOrphans(orphans: Commit[]): CommitGroup[] {
  if (orphans.length === 0) return [];

  // Sort by date ascending
  const sorted = [...orphans].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const groups: Array<{
    commits: Commit[];
    dirs: Set<string>;
    latestTime: number;
  }> = [];

  for (const commit of sorted) {
    const commitDirs = getDirectories(commit);
    const commitTime = new Date(commit.date).getTime();

    // Find the best matching group
    let bestGroupIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;

      // Skip full groups
      if (group.commits.length >= MAX_GROUP_SIZE) continue;

      // Must be within time window of the group's latest commit
      const timeDelta = commitTime - group.latestTime;
      if (timeDelta > TIME_WINDOW_MS) continue;

      // Score based on directory overlap
      const overlap = directoryOverlap(commitDirs, group.dirs);

      // Higher overlap → better fit. Base score of 1 for time-only match.
      const score = overlap > 0 ? overlap * 10 + 1 : 1;

      if (score > bestScore) {
        bestScore = score;
        bestGroupIdx = i;
      }
    }

    if (bestGroupIdx >= 0) {
      const group = groups[bestGroupIdx]!;
      group.commits.push(commit);
      for (const d of commitDirs) group.dirs.add(d);
      group.latestTime = commitTime;
    } else {
      // Start a new group
      groups.push({
        commits: [commit],
        dirs: new Set(commitDirs),
        latestTime: commitTime,
      });
    }
  }

  return groups.map((g) => ({
    type: "orphan" as const,
    label: generateGroupLabel(g.commits, g.dirs),
    commits: g.commits,
  }));
}

// ── Main Grouping ──

/**
 * Group commits into logical units: PR groups and orphan clusters.
 *
 * 1. Link commits to their parent PRs (using PR.commits SHA mapping)
 * 2. Remaining commits are "orphans" — cluster them by file + time proximity
 * 3. Return PR groups first, then orphan clusters
 */
export function groupCommits(
  commits: Commit[],
  prs: PullRequest[],
): GroupingResult {
  // Build a set of all commit SHAs that belong to any PR
  const prCommitShas = new Set<string>();
  const shaToCommit = new Map<string, Commit>();

  for (const commit of commits) {
    shaToCommit.set(commit.sha, commit);
  }

  // ── PR Groups ──

  const prGroups: CommitGroup[] = [];

  for (const pr of prs) {
    const prCommits: Commit[] = [];

    for (const sha of pr.commits) {
      prCommitShas.add(sha);
      const commit = shaToCommit.get(sha);
      if (commit) {
        prCommits.push(commit);
      }
    }

    // Sort PR commits by date ascending
    prCommits.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const stateLabel =
      pr.state === "merged"
        ? "merged"
        : pr.state === "open"
          ? "open"
          : "closed";

    prGroups.push({
      type: "pr",
      label: `PR #${pr.number}: ${pr.title} (${stateLabel})`,
      commits: prCommits,
      pr,
    });
  }

  // ── Orphan Commits ──

  const orphans = commits.filter((c) => !prCommitShas.has(c.sha));
  const orphanGroups = clusterOrphans(orphans);

  // ── Combine ──

  // Sort PR groups by most recent merge/create date
  prGroups.sort((a, b) => {
    const dateA = a.pr?.mergedAt ?? a.pr?.createdAt ?? "";
    const dateB = b.pr?.mergedAt ?? b.pr?.createdAt ?? "";
    return new Date(dateB).getTime() - new Date(dateA).getTime();
  });

  const allGroups = [...prGroups, ...orphanGroups];

  const commitsInPRs = prGroups.reduce((sum, g) => sum + g.commits.length, 0);

  return {
    groups: allGroups,
    stats: {
      prGroups: prGroups.length,
      orphanGroups: orphanGroups.length,
      orphanCommits: orphans.length,
      commitsInPRs,
    },
  };
}
