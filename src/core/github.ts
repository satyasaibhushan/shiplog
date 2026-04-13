// GitHub data fetching via gh CLI
// Phase 2: GitHub Data Fetching

import { eq } from "drizzle-orm";
import { getDb } from "./cache.ts";
import * as schema from "../db/schema.ts";
import { withRetry } from "./retry.ts";

// ── Types ──

export interface Repo {
  name: string;
  owner: string;
  fullName: string;
  isForked: boolean;
  org?: string;
  description?: string;
  language?: string;
  updatedAt?: string;
}

export interface Org {
  login: string;
  description?: string;
  repos?: Repo[];
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
  repo: string;
  diff?: string;
  files?: string[];
}

export interface PullRequest {
  id: string; // "owner/repo:number"
  number: number;
  title: string;
  state: "merged" | "open" | "closed";
  repo: string;
  mergedAt?: string;
  createdAt: string;
  commits: string[]; // commit SHAs
}

export interface ContributionsParams {
  repos: string[];
  from: string;
  to: string;
  scope: string[];
}

export interface ContributionsResult {
  commits: Commit[];
  pullRequests: PullRequest[];
  stats: {
    totalCommits: number;
    totalPRs: number;
    mergedPRs: number;
    openPRs: number;
    closedPRs: number;
    reposProcessed: number;
    filesChanged: number;
    cachedCommits: number;
    fetchedCommits: number;
  };
}

// ── Constants ──

const MAX_DIFF_SIZE = 100_000; // 100KB per file patch
const MAX_TOTAL_DIFF_SIZE = 500_000; // 500KB total per commit
const DIFF_CONCURRENCY = 5; // Max concurrent diff fetches

// ── Low-Level Helpers ──

let _cachedUsername: string | null = null;

/**
 * Run a `gh` CLI command and return stdout as a string.
 * Retries on transient errors (rate limits, network issues) with exponential backoff.
 */
async function runGh(args: string[]): Promise<string> {
  return withRetry(
    async () => {
      const proc = Bun.spawn(["gh", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const errMsg = stderr.trim() || "Unknown error";

        // Friendly error messages
        if (errMsg.includes("rate limit") || errMsg.includes("abuse detection")) {
          throw new Error(
            "GitHub API rate limit exceeded. Retrying with backoff...",
          );
        }
        if (errMsg.includes("Could not resolve host") || errMsg.includes("ENOTFOUND")) {
          throw new Error(
            "Network error: could not reach GitHub. Check your internet connection.",
          );
        }
        if (errMsg.includes("401") || errMsg.includes("authentication")) {
          throw new Error(
            "GitHub authentication failed. Run `gh auth login` to fix.",
          );
        }
        // For 404s, include the endpoint so the caller can decide what to do
        if (errMsg.includes("404") || errMsg.includes("Not Found")) {
          const endpoint = args.find((a) => a.startsWith("/")) ?? args.slice(1, 3).join(" ");
          throw new Error(`GitHub API 404: ${endpoint}`);
        }

        throw new Error(
          `gh ${args.slice(0, 3).join(" ")} failed (exit ${exitCode}): ${errMsg}`,
        );
      }

      return stdout;
    },
    {
      maxRetries: 3,
      baseDelay: 2000,
      onRetry: (attempt, error, delay) => {
        console.warn(
          `    Retry ${attempt}/3 in ${(delay / 1000).toFixed(1)}s: ${error.message}`,
        );
      },
    },
  );
}

/**
 * Build a URL with query parameters appended.
 * gh api uses `-f` for POST body params; for GET requests we must put params in the URL.
 */
function buildUrl(endpoint: string, params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return endpoint;
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${endpoint}?${qs}`;
}

/**
 * Call `gh api` for a single (non-paginated) GET endpoint.
 * Returns parsed JSON.
 */
async function ghApi<T>(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = buildUrl(endpoint, params);
  const output = await runGh(["api", url]);
  const trimmed = output.trim();
  if (!trimmed) return {} as T;
  return JSON.parse(trimmed) as T;
}

/**
 * Call `gh api --paginate` for GET endpoints that return JSON arrays.
 * Handles the edge case where paginated output is concatenated arrays.
 */
async function ghApiPaginated<T>(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<T[]> {
  const url = buildUrl(endpoint, params);
  const output = await runGh(["api", url, "--paginate"]);
  const trimmed = output.trim();
  if (!trimmed) return [];

  try {
    return JSON.parse(trimmed) as T[];
  } catch {
    // gh --paginate can sometimes produce concatenated JSON arrays
    // e.g., [{...}][{...}] instead of [{...},{...}]
    try {
      const fixed = "[" + trimmed.replace(/\]\s*\[/g, ",") + "]";
      const parsed = JSON.parse(fixed);
      return (Array.isArray(parsed[0]) ? parsed.flat() : parsed) as T[];
    } catch {
      throw new Error(`Failed to parse paginated response from ${endpoint}`);
    }
  }
}

/**
 * Run async tasks with a concurrency limit.
 */
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

// ── Public API ──

/**
 * Get the authenticated GitHub username. Cached after first call.
 */
export async function getAuthenticatedUser(): Promise<string> {
  if (_cachedUsername) return _cachedUsername;
  const user = await ghApi<{ login: string }>("/user");
  _cachedUsername = user.login;
  return _cachedUsername;
}

/**
 * List the authenticated user's GitHub organizations.
 * Returns empty array on failure (e.g. missing `read:org` scope).
 */
export async function listOrgs(): Promise<Org[]> {
  try {
    const raw = await ghApiPaginated<{
      login: string;
      description: string | null;
    }>("/user/orgs", { per_page: "100" });

    return raw.map((o) => ({
      login: o.login,
      description: o.description ?? undefined,
    }));
  } catch (err) {
    // Don't fail the whole app if orgs can't be listed (common with limited token scopes)
    console.warn(`  Could not list orgs: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * List all repositories accessible to the authenticated user.
 * Includes personal repos, organization repos, and forks.
 */
export async function listRepos(): Promise<Repo[]> {
  const username = await getAuthenticatedUser();

  const raw = await ghApiPaginated<{
    name: string;
    owner: { login: string };
    full_name: string;
    fork: boolean;
    description: string | null;
    language: string | null;
    updated_at: string;
  }>("/user/repos", {
    per_page: "100",
    sort: "updated",
    affiliation: "owner,collaborator,organization_member",
  });

  return raw.map((r) => ({
    name: r.name,
    owner: r.owner.login,
    fullName: r.full_name,
    isForked: r.fork,
    org: r.owner.login !== username ? r.owner.login : undefined,
    description: r.description ?? undefined,
    language: r.language ?? undefined,
    updatedAt: r.updated_at,
  }));
}

/**
 * Fetch commits authored by the authenticated user in a date range.
 * Returns a list of commits WITHOUT diffs (diffs are fetched separately).
 */
export async function fetchCommits(
  repo: string,
  from: string,
  to: string,
): Promise<Commit[]> {
  const username = await getAuthenticatedUser();

  const raw = await ghApiPaginated<{
    sha: string;
    commit: {
      message: string;
      author: { name: string; email: string; date: string };
    };
    author: { login: string } | null;
    parents: Array<{ sha: string }>;
  }>(`/repos/${repo}/commits`, {
    author: username,
    since: `${from}T00:00:00Z`,
    until: `${to}T23:59:59Z`,
    per_page: "100",
  });

  return raw
    .filter((c) => {
      // Skip merge commits (2+ parents) — they're git plumbing, not real work
      if (c.parents && c.parents.length > 1) return false;
      // Skip commits whose message starts with "Merge " (catches squash-merge artifacts)
      if (c.commit.message.startsWith("Merge pull request")) return false;
      if (c.commit.message.startsWith("Merge branch")) return false;
      return true;
    })
    .map((c) => ({
      sha: c.sha,
      message: c.commit.message.split("\n")[0] ?? c.commit.message,
      author: c.author?.login ?? c.commit.author.name,
      date: c.commit.author.date,
      repo,
    }));
}

/**
 * Fetch the full diff and file list for a single commit.
 * Large diffs are truncated to stay within size limits.
 */
export async function fetchCommitDetail(
  repo: string,
  sha: string,
): Promise<{ diff: string; files: string[] }> {
  const detail = await ghApi<{
    files?: Array<{
      filename: string;
      patch?: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
    }>;
  }>(`/repos/${repo}/commits/${sha}`);

  const files = detail.files ?? [];
  const fileNames = files.map((f) => f.filename);

  let totalSize = 0;
  const diffParts: string[] = [];

  for (const f of files) {
    if (!f.patch) continue;

    let patch = f.patch;

    // Truncate individual file patches that are too large
    if (patch.length > MAX_DIFF_SIZE) {
      patch = patch.slice(0, MAX_DIFF_SIZE) + "\n... [truncated — file too large]";
    }

    // Stop adding diffs once total size limit is reached
    if (totalSize + patch.length > MAX_TOTAL_DIFF_SIZE) {
      const remaining = files.length - diffParts.length;
      diffParts.push(`\n... [${remaining} remaining file diff(s) truncated — total size limit reached]`);
      break;
    }

    diffParts.push(`--- a/${f.filename}\n+++ b/${f.filename}\n${patch}`);
    totalSize += patch.length;
  }

  return {
    diff: diffParts.join("\n\n"),
    files: fileNames,
  };
}

/**
 * Fetch pull requests authored by the authenticated user in a date range.
 * Uses the GitHub Search API for precise date filtering.
 * Scope controls which PR states to fetch (merged, open, closed).
 */
export async function fetchPullRequests(
  repo: string,
  from: string,
  to: string,
  scope: string[] = ["merged-prs"],
): Promise<PullRequest[]> {
  const username = await getAuthenticatedUser();
  const prs: PullRequest[] = [];

  // Build search queries based on scope
  // Each scope type uses a different date qualifier for accuracy
  const queries: Array<{ query: string; expectedState: string }> = [];

  if (scope.includes("merged-prs")) {
    queries.push({
      query: `repo:${repo} is:pr is:merged author:${username} merged:${from}..${to}`,
      expectedState: "merged",
    });
  }
  if (scope.includes("open-prs")) {
    queries.push({
      query: `repo:${repo} is:pr is:open author:${username} created:${from}..${to}`,
      expectedState: "open",
    });
  }
  if (scope.includes("closed-prs")) {
    queries.push({
      query: `repo:${repo} is:pr is:closed is:unmerged author:${username} closed:${from}..${to}`,
      expectedState: "closed",
    });
  }

  for (const { query } of queries) {
    const result = await ghApi<{
      total_count: number;
      items: Array<{
        number: number;
        title: string;
        state: string;
        pull_request: {
          merged_at: string | null;
        };
        created_at: string;
      }>;
    }>("/search/issues", {
      q: query,
      per_page: "100",
      sort: "updated",
      order: "desc",
    });

    // Fetch commit SHAs for each PR (needed for grouping in Phase 3)
    for (const item of result.items) {
      let state: "merged" | "open" | "closed";
      if (item.pull_request.merged_at) {
        state = "merged";
      } else if (item.state === "open") {
        state = "open";
      } else {
        state = "closed";
      }

      const prId = `${repo}:${item.number}`;

      // Always fetch PR commits fresh to ensure author filtering is applied
      let commitShas: string[];
      {
        // Fetch commits associated with this PR — filter to only the user's commits
        try {
          const prCommits = await ghApiPaginated<{
            sha: string;
            author: { login: string } | null;
            commit: { author: { name: string } };
          }>(
            `/repos/${repo}/pulls/${item.number}/commits`,
            { per_page: "100" },
          );
          commitShas = prCommits
            .filter((c) => c.author?.login === username)
            .map((c) => c.sha);
        } catch {
          console.warn(`  ⚠ Could not fetch commits for PR #${item.number} in ${repo}`);
          commitShas = [];
        }
      }

      const pr: PullRequest = {
        id: prId,
        number: item.number,
        title: item.title,
        state,
        repo,
        mergedAt: item.pull_request.merged_at ?? undefined,
        createdAt: item.created_at,
        commits: commitShas,
      };

      prs.push(pr);
    }
  }

  return prs;
}

/**
 * For orphan commits, check if they belong to any PR (the user's own or others').
 *
 * This catches:
 *   - Squash-merge commits: different SHA than PR branch commits, but linked via GitHub
 *   - Contributions to others' PRs: user's commits inside someone else's PR
 *
 * For the user's own PRs already in `existingPRs`, the commit SHA is added to that PR.
 * For new PRs (others'), a new PullRequest entry is returned.
 */
export async function resolveOrphanCommitPRs(
  commits: Commit[],
  knownPRCommitShas: Set<string>,
  existingPRs: PullRequest[],
): Promise<PullRequest[]> {
  // Only check commits not already claimed by known PRs
  const orphans = commits.filter((c) => !knownPRCommitShas.has(c.sha));
  if (orphans.length === 0) return [];

  // Index existing PRs by "repo:number" for fast lookup
  const existingPRMap = new Map<string, PullRequest>();
  for (const pr of existingPRs) {
    existingPRMap.set(pr.id, pr);
  }

  // Group orphans by repo
  const byRepo = new Map<string, Commit[]>();
  for (const c of orphans) {
    if (!byRepo.has(c.repo)) byRepo.set(c.repo, []);
    byRepo.get(c.repo)!.push(c);
  }

  // Discovered NEW PRs (others'): prId → data
  const newPRs = new Map<
    string,
    { number: number; title: string; state: string; repo: string; createdAt: string; mergedAt?: string; shas: string[] }
  >();
  let linkedToExisting = 0;

  for (const [repo, repoCommits] of byRepo) {
    const sample = repoCommits.slice(0, 20);

    await mapWithConcurrency(
      sample,
      async (commit) => {
        try {
          const prs = await ghApi<
            Array<{
              number: number;
              title: string;
              state: string;
              merged_at: string | null;
              created_at: string;
              user: { login: string };
            }>
          >(`/repos/${repo}/commits/${commit.sha}/pulls`);

          if (!Array.isArray(prs) || prs.length === 0) return;

          // Take the first (most relevant) PR
          const pr = prs[0]!;
          const prId = `${repo}:${pr.number}`;

          // Case 1: This PR already exists in our list (squash-merge of own PR)
          const existing = existingPRMap.get(prId);
          if (existing) {
            if (!existing.commits.includes(commit.sha)) {
              existing.commits.push(commit.sha);
              linkedToExisting++;
            }
            return;
          }

          // Case 2: New PR (likely someone else's, or own PR not in date range search)
          if (!newPRs.has(prId)) {
            newPRs.set(prId, {
              number: pr.number,
              title: pr.title,
              state: pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed",
              repo,
              createdAt: pr.created_at,
              mergedAt: pr.merged_at ?? undefined,
              shas: [],
            });
          }
          newPRs.get(prId)!.shas.push(commit.sha);
        } catch {
          // Silently skip
        }
      },
      DIFF_CONCURRENCY,
    );
  }

  if (linkedToExisting > 0) {
    console.log(`    Linked ${linkedToExisting} squash-merge commit(s) to existing PRs`);
  }
  if (newPRs.size > 0) {
    console.log(`    Found ${newPRs.size} additional PR(s) containing your commits`);
  }

  // Convert new PRs to PullRequest objects
  const result: PullRequest[] = [];
  for (const [prId, info] of newPRs) {
    result.push({
      id: prId,
      number: info.number,
      title: info.title,
      state: info.state as "merged" | "open" | "closed",
      repo: info.repo,
      mergedAt: info.mergedAt,
      createdAt: info.createdAt,
      commits: info.shas,
    });
  }

  return result;
}

// ── Cache Operations (SQLite via Drizzle) ──

/**
 * Get a cached commit by SHA. Returns null if not found.
 */
function getCachedCommit(sha: string): Commit | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.commits)
    .where(eq(schema.commits.sha, sha))
    .get();

  if (!row) return null;

  return {
    sha: row.sha,
    message: row.message,
    author: row.author,
    date: row.date,
    repo: row.repo,
    diff: row.diff ?? undefined,
    files: row.files ? JSON.parse(row.files) : undefined,
  };
}

/**
 * Cache a commit with its diff and file list.
 * Uses INSERT OR IGNORE — existing commits are not overwritten.
 */
function cacheCommit(commit: Commit): void {
  const db = getDb();
  db.insert(schema.commits)
    .values({
      sha: commit.sha,
      repo: commit.repo,
      message: commit.message,
      author: commit.author,
      date: commit.date,
      diff: commit.diff ?? null,
      files: commit.files ? JSON.stringify(commit.files) : null,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Get a cached pull request by ID ("owner/repo:number").
 */
function getCachedPR(id: string): PullRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, id))
    .get();

  if (!row) return null;

  return {
    id: row.id,
    number: row.number,
    title: row.title,
    state: row.state as "merged" | "open" | "closed",
    repo: row.repo,
    mergedAt: row.mergedAt ?? undefined,
    createdAt: row.createdAt,
    commits: row.commitShas ? JSON.parse(row.commitShas) : [],
  };
}

/**
 * Cache a pull request. Updates existing records since PR state can change.
 */
function cachePR(pr: PullRequest): void {
  const db = getDb();
  db.insert(schema.pullRequests)
    .values({
      id: pr.id,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      mergedAt: pr.mergedAt ?? null,
      createdAt: pr.createdAt,
      commitShas: JSON.stringify(pr.commits),
    })
    .onConflictDoUpdate({
      target: schema.pullRequests.id,
      set: {
        title: pr.title,
        state: pr.state,
        mergedAt: pr.mergedAt ?? null,
        commitShas: JSON.stringify(pr.commits),
      },
    })
    .run();
}

// ── High-Level Orchestration ──

/**
 * Fetch all contributions for the given parameters.
 * This is the main entry point for the POST /api/contributions endpoint.
 *
 * Flow per repo:
 *   1. Fetch commit list from GitHub (lightweight, always fresh)
 *   2. For each commit, check SQLite cache for diff data
 *   3. Fetch missing diffs concurrently (up to DIFF_CONCURRENCY at a time)
 *   4. Cache newly fetched commits
 *   5. Fetch PRs via GitHub Search API based on scope
 *   6. Cache PR metadata
 */
export async function fetchContributions(
  params: ContributionsParams,
): Promise<ContributionsResult> {
  const { repos, from, to, scope } = params;

  const allCommits: Commit[] = [];
  const allPRs: PullRequest[] = [];
  let totalFilesChanged = 0;
  let cachedCommitCount = 0;
  let fetchedCommitCount = 0;

  for (const repo of repos) {
    console.log(`  📦 Fetching contributions from ${repo}...`);

    // ── Step 1: Fetch commit list ──
    let commitList: Commit[];
    try {
      commitList = await fetchCommits(repo, from, to);
    } catch (err) {
      console.warn(`  ⚠ Could not fetch commits for ${repo}: ${err}`);
      commitList = [];
    }
    console.log(`    Found ${commitList.length} commits`);

    // ── Step 2–4: Fetch diffs with caching + concurrency ──
    if (commitList.length > 0) {
      const enrichedCommits = await mapWithConcurrency(
        commitList,
        async (commit, i) => {
          // Check cache first — commits are immutable, so cached diffs are always valid
          const cached = getCachedCommit(commit.sha);
          if (cached && cached.diff !== undefined) {
            cachedCommitCount++;
            return cached;
          }

          // Fetch diff from GitHub
          try {
            const detail = await fetchCommitDetail(repo, commit.sha);
            const enriched: Commit = {
              ...commit,
              diff: detail.diff,
              files: detail.files,
            };
            cacheCommit(enriched);
            fetchedCommitCount++;

            // Progress logging every 10 commits
            if ((i + 1) % 10 === 0 || i + 1 === commitList.length) {
              console.log(`    Fetched ${i + 1}/${commitList.length} commit diffs...`);
            }

            return enriched;
          } catch (err) {
            // If diff fetch fails, cache the commit without a diff and continue
            console.warn(
              `    ⚠ Could not fetch diff for ${commit.sha.slice(0, 7)}: ${err}`,
            );
            cacheCommit(commit);
            fetchedCommitCount++;
            return commit;
          }
        },
        DIFF_CONCURRENCY,
      );

      totalFilesChanged += enrichedCommits.reduce(
        (sum, c) => sum + (c.files?.length ?? 0),
        0,
      );
      allCommits.push(...enrichedCommits);
    }

    // ── Step 5–6: Fetch PRs ──
    const hasPRScope = scope.some((s) => s.endsWith("-prs"));
    if (hasPRScope) {
      try {
        const prList = await fetchPullRequests(repo, from, to, scope);
        console.log(`    Found ${prList.length} pull requests`);

        for (const pr of prList) {
          cachePR(pr);
          allPRs.push(pr);
        }
      } catch (err) {
        console.warn(`  ⚠ Could not fetch PRs for ${repo}: ${err}`);
      }
    }
  }

  // ── Step 7: Backfill missing PR commits ──
  // PR branches may contain commits not on the default branch.
  // Fetch details for any PR commit SHAs we don't already have.
  {
    const knownShas = new Set(allCommits.map((c) => c.sha));
    const missingShas: Array<{ sha: string; repo: string }> = [];

    for (const pr of allPRs) {
      for (const sha of pr.commits) {
        if (!knownShas.has(sha)) {
          missingShas.push({ sha, repo: pr.repo });
          knownShas.add(sha); // prevent duplicates
        }
      }
    }

    if (missingShas.length > 0) {
      console.log(`    Backfilling ${missingShas.length} PR branch commit(s)...`);
      const backfilled = await mapWithConcurrency(
        missingShas,
        async ({ sha, repo }) => {
          // Check cache first
          const cached = getCachedCommit(sha);
          if (cached && cached.diff !== undefined) {
            cachedCommitCount++;
            return cached;
          }

          try {
            // Fetch commit metadata + diff
            const detail = await fetchCommitDetail(repo, sha);
            const meta = await ghApi<{
              sha: string;
              commit: {
                message: string;
                author: { name: string; date: string };
              };
              author: { login: string } | null;
            }>(`/repos/${repo}/commits/${sha}`);

            const commit: Commit = {
              sha,
              message: meta.commit.message.split("\n")[0] ?? meta.commit.message,
              author: meta.author?.login ?? meta.commit.author.name,
              date: meta.commit.author.date,
              repo,
              diff: detail.diff,
              files: detail.files,
            };
            cacheCommit(commit);
            fetchedCommitCount++;
            return commit;
          } catch (err) {
            console.warn(`    ⚠ Could not fetch PR commit ${sha.slice(0, 7)}: ${err}`);
            // Return a minimal commit so the group isn't empty
            const minimal: Commit = {
              sha,
              message: "(commit details unavailable)",
              author: "unknown",
              date: new Date().toISOString(),
              repo,
            };
            return minimal;
          }
        },
        DIFF_CONCURRENCY,
      );

      allCommits.push(...backfilled);
      totalFilesChanged += backfilled.reduce(
        (sum, c) => sum + (c.files?.length ?? 0),
        0,
      );
    }
  }

  // ── Step 8: Resolve orphan commits → link to PRs (squash merges + others' PRs) ──
  const knownPRShas = new Set(allPRs.flatMap((pr) => pr.commits));
  try {
    const newPRs = await resolveOrphanCommitPRs(allCommits, knownPRShas, allPRs);
    for (const pr of newPRs) {
      cachePR(pr);
      allPRs.push(pr);
    }
    // Update caches for existing PRs that got new squash-merge commits added
    for (const pr of allPRs) {
      cachePR(pr);
    }
  } catch (err) {
    console.warn(`  ⚠ Could not resolve orphan commits: ${err}`);
  }

  console.log(
    `\n  ✅ Done — ${allCommits.length} commits, ${allPRs.length} PRs across ${repos.length} repo(s)`,
  );
  if (cachedCommitCount > 0) {
    console.log(`     (${cachedCommitCount} from cache, ${fetchedCommitCount} fetched)\n`);
  }

  return {
    commits: allCommits,
    pullRequests: allPRs,
    stats: {
      totalCommits: allCommits.length,
      totalPRs: allPRs.length,
      mergedPRs: allPRs.filter((p) => p.state === "merged").length,
      openPRs: allPRs.filter((p) => p.state === "open").length,
      closedPRs: allPRs.filter((p) => p.state === "closed").length,
      reposProcessed: repos.length,
      filesChanged: totalFilesChanged,
      cachedCommits: cachedCommitCount,
      fetchedCommits: fetchedCommitCount,
    },
  };
}
