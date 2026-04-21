// GitHub data fetching via gh CLI
// Phase 2: GitHub Data Fetching

import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "./cache.ts";
import * as schema from "../db/schema.ts";
import { withRetry, warnOnError, parseJsonStrict } from "./retry.ts";
import { persistPR } from "./git-sync.ts";
import type { StoredPR } from "./datastore.ts";
import {
  makeProgress,
  type GenerationProgress,
} from "../shared/progress.ts";

export type FetchProgressCallback = (progress: GenerationProgress) => void;

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

export interface CommitFileStat {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
}

export interface CommitStats {
  additions: number;
  deletions: number;
  files: number;
  truncated: boolean;
  perFile: CommitFileStat[];
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
  repo: string;
  diff?: string;
  files?: string[];
  /** Per-file and total size data from GitHub's commit detail endpoint. */
  stats?: CommitStats;
  /**
   * True when GitHub's single-commit API capped the files array at 300 —
   * meaning `files` and `diff` are incomplete. Surfaced so the UI can warn.
   */
  filesListTruncated?: boolean;
  /**
   * True if the commit has ≥2 parents (merge commit). Merge commits are excluded
   * from diff-size aggregations because a backmerge pulls in upstream changes
   * that aren't actually the author's work.
   */
  isMerge?: boolean;
}

export interface PullRequest {
  id: string; // "owner/repo:number"
  number: number;
  title: string;
  state: "merged" | "open" | "closed";
  repo: string;
  mergedAt?: string;
  createdAt: string;
  commits: string[]; // commit SHAs (filtered to only the current user's commits)
  /**
   * PR-level diff size from GitHub (base...head compare). This is what the
   * PR page shows — it excludes files pulled in by backmerge commits.
   * Absent for PRs cached before this field existed.
   */
  stats?: {
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  /**
   * True when the PR was opened by someone other than the authenticated user
   * but contains at least one commit authored by them. The UI shows a pill
   * and the summarizer still only sees the user's own commits.
   */
  openedByOther?: boolean;
}

export interface ContributionsParams {
  repos: string[];
  from: string;
  to: string;
  scope: string[];
  /** Additional git emails to search for commits (old laptops, unlinked emails) */
  gitEmails?: string[];
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
    /** Commits whose file list hit GitHub's 300-file cap — diff is incomplete. */
    commitsWithTruncatedFiles: number;
    /** True if orphan PR resolution hit the per-repo cap and skipped some commits. */
    orphanCheckTruncated: boolean;
  };
}

// ── Constants ──

const MAX_DIFF_SIZE = 100_000; // 100KB per file patch
const MAX_TOTAL_DIFF_SIZE = 500_000; // 500KB total per commit
const DIFF_CONCURRENCY = 5; // Max concurrent diff fetches
// Safety ceiling on per-commit PR lookups during orphan resolution. One gh
// call per commit times N repos can get expensive fast; 200 covers typical
// use and leaves headroom, with the rest logged as truncated.
const MAX_ORPHAN_PR_CHECKS_PER_REPO = 200;

// ── Low-Level Helpers ──

let _cachedUsername: string | null = null;
let _cachedGitEmail: string | null | undefined = undefined; // undefined = not checked yet

/**
 * Get the local git config email. Used to find commits where the author
 * isn't linked to a GitHub account (ghost avatar commits).
 */
export async function getLocalGitEmail(): Promise<string | null> {
  if (_cachedGitEmail !== undefined) return _cachedGitEmail;
  try {
    const proc = Bun.spawn(["git", "config", "user.email"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const email = (await new Response(proc.stdout).text()).trim();
    _cachedGitEmail = email || null;
  } catch {
    _cachedGitEmail = null;
  }
  return _cachedGitEmail;
}

/**
 * Run a `gh` CLI command and return stdout as a string.
 * Retries on transient errors (rate limits, network issues) with exponential backoff.
 *
 * `endpointForErrors` is the URL/path the caller is hitting. It's used in error
 * messages so 404s etc. are self-describing — callers should pass it explicitly
 * rather than relying on a heuristic over `args`.
 */
async function runGh(args: string[], endpointForErrors?: string): Promise<string> {
  const endpoint = endpointForErrors ?? args.slice(0, 3).join(" ");
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
        if (errMsg.includes("404") || errMsg.includes("Not Found")) {
          throw new Error(`GitHub API 404: ${endpoint}`);
        }

        throw new Error(
          `gh ${endpoint} failed (exit ${exitCode}): ${errMsg}`,
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
  const output = await runGh(["api", url], `GET ${endpoint}`);
  const trimmed = output.trim();
  if (!trimmed) return {} as T;
  return parseJsonStrict<T>(trimmed, `GET ${endpoint}`);
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
  const output = await runGh(["api", url, "--paginate"], `GET ${endpoint} (paginated)`);
  const trimmed = output.trim();
  if (!trimmed) return [];

  try {
    return JSON.parse(trimmed) as T[];
  } catch {
    // gh --paginate can sometimes produce concatenated JSON arrays
    // e.g., [{...}][{...}] instead of [{...},{...}]
    const fixed = "[" + trimmed.replace(/\]\s*\[/g, ",") + "]";
    const parsed = parseJsonStrict<unknown>(fixed, `GET ${endpoint} (paginated, repaired)`);
    return (Array.isArray(parsed) && Array.isArray(parsed[0])
      ? (parsed as unknown[][]).flat()
      : parsed) as T[];
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
 * Repos the authenticated user has authored at least one commit in, by full
 * name (`owner/repo`). Uses GitHub's commit-search index, which covers forks
 * and upstreams — a single commit authored in either shows both paths once
 * GitHub surfaces the repo. Capped at 1000 results (10 × 100 per page).
 */
export async function fetchContributedRepos(): Promise<Set<string>> {
  const username = await getAuthenticatedUser();
  const gitEmail = await getLocalGitEmail();
  const queries = [`author:${username}`];
  if (gitEmail) queries.push(`author-email:${gitEmail}`);

  const set = new Set<string>();
  for (const q of queries) {
    try {
      for (let page = 1; page <= 10; page++) {
        const res = await ghApi<{
          total_count?: number;
          items?: Array<{ repository?: { full_name?: string } }>;
        }>("search/commits", {
          q,
          per_page: "100",
          page: String(page),
        });
        const items = res.items ?? [];
        for (const item of items) {
          const name = item.repository?.full_name;
          if (name) set.add(name);
        }
        if (items.length < 100) break;
      }
    } catch (err) {
      console.warn(
        `  Could not search commits for "${q}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return set;
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
  extraEmails: string[] = [],
): Promise<Commit[]> {
  const username = await getAuthenticatedUser();
  const gitEmail = await getLocalGitEmail();

  type RawCommit = {
    sha: string;
    commit: {
      message: string;
      author: { name: string; email: string; date: string };
    };
    author: { login: string } | null;
    parents: Array<{ sha: string }>;
  };

  const baseParams = {
    since: `${from}T00:00:00Z`,
    until: `${to}T23:59:59Z`,
    per_page: "100",
  };

  // Collect all identities to search by (deduplicated)
  const identities = new Set<string>([username]);
  if (gitEmail) identities.add(gitEmail);
  for (const e of extraEmails) {
    if (e) identities.add(e);
  }

  // Fetch commits for each identity in parallel.
  //
  // Auth errors MUST propagate — returning [] would silently hide the problem
  // and make contributions look empty. 404 and rate-limit noise can be
  // swallowed with a warning (some identities genuinely won't exist in every
  // repo, or we hit secondary limits mid-fan-out).
  const allResults = await Promise.all(
    [...identities].map(async (identity) => {
      try {
        return await ghApiPaginated<RawCommit>(
          `/repos/${repo}/commits`,
          { ...baseParams, author: identity },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/authentication|401/i.test(msg)) {
          throw err;
        }
        warnOnError(`fetchCommits[${repo}/${identity}]`, err);
        return [] as RawCommit[];
      }
    }),
  );

  // Deduplicate by SHA
  const seen = new Set<string>();
  const combined: RawCommit[] = [];
  for (const results of allResults) {
    for (const c of results) {
      if (!seen.has(c.sha)) {
        seen.add(c.sha);
        combined.push(c);
      }
    }
  }

  return combined
    .filter((c) => {
      // Skip merge commits (2+ parents)
      if (c.parents && c.parents.length > 1) return false;
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
): Promise<{
  diff: string;
  files: string[];
  filesListTruncated: boolean;
  stats: CommitStats;
  isMerge: boolean;
}> {
  const detail = await ghApi<{
    parents?: Array<{ sha: string }>;
    files?: Array<{
      filename: string;
      patch?: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
    }>;
  }>(`/repos/${repo}/commits/${sha}`);

  const isMerge = (detail.parents?.length ?? 0) >= 2;

  const files = detail.files ?? [];
  const fileNames = files.map((f) => f.filename);

  // GitHub silently caps the files array at 300 entries for single-commit responses.
  // A truncated file list means an incomplete diff and an unreliable patch-id for dedup.
  const filesListTruncated = files.length >= 300;
  if (filesListTruncated) {
    console.warn(
      `    ⚠ Commit ${sha.slice(0, 7)} in ${repo} touches ${files.length}+ files — GitHub API caps at 300, file list and diff are incomplete`,
    );
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  const perFile: CommitFileStat[] = [];
  let totalSize = 0;
  const diffParts: string[] = [];

  for (const f of files) {
    totalAdditions += f.additions ?? 0;
    totalDeletions += f.deletions ?? 0;
    perFile.push({
      filename: f.filename,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      status: f.status,
    });

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
    filesListTruncated,
    stats: {
      additions: totalAdditions,
      deletions: totalDeletions,
      files: files.length,
      truncated: filesListTruncated,
      perFile,
    },
    isMerge,
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
    // Paginate search results — GitHub Search API returns max 100 per page
    // and caps at 1000 total results. Without pagination, repos with >100 PRs
    // in a date range silently drop results, causing commits to appear orphaned.
    type SearchItem = {
      number: number;
      title: string;
      state: string;
      pull_request: {
        merged_at: string | null;
      };
      created_at: string;
    };

    const allItems: SearchItem[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const result = await ghApi<{
        total_count: number;
        items: SearchItem[];
      }>("/search/issues", {
        q: query,
        per_page: String(perPage),
        sort: "updated",
        order: "desc",
        page: String(page),
      });

      allItems.push(...result.items);

      // Stop when: all results fetched, page was partial, or GitHub's 1000-result cap
      if (
        allItems.length >= result.total_count ||
        result.items.length < perPage ||
        allItems.length >= 1000
      ) {
        break;
      }
      page++;
    }

    // Fetch commit SHAs for each PR (needed for grouping in Phase 3)
    for (const item of allItems) {
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

      // Fetch PR-level diff size (base...head). This matches what the PR page
      // shows and correctly excludes files pulled in by backmerge commits.
      let prStats: PullRequest["stats"];
      try {
        const detail = await ghApi<{
          additions: number;
          deletions: number;
          changed_files: number;
        }>(`/repos/${repo}/pulls/${item.number}`);
        prStats = {
          additions: detail.additions,
          deletions: detail.deletions,
          changedFiles: detail.changed_files,
        };
      } catch (err) {
        warnOnError(`fetchPullRequests[${repo}#${item.number}].stats`, err);
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
        stats: prStats,
        openedByOther: false,
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
): Promise<{ newPRs: PullRequest[]; truncated: boolean }> {
  // Only check commits not already claimed by known PRs
  const orphans = commits.filter((c) => !knownPRCommitShas.has(c.sha));
  if (orphans.length === 0) return { newPRs: [], truncated: false };

  // Used to distinguish PRs opened by the user from PRs opened by others.
  const username = await getAuthenticatedUser();

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
    {
      number: number;
      title: string;
      state: string;
      repo: string;
      createdAt: string;
      mergedAt?: string;
      shas: string[];
      openedByOther: boolean;
    }
  >();
  let linkedToExisting = 0;
  let truncated = false;

  for (const [repo, repoCommits] of byRepo) {
    // Cap the per-repo check to keep API volume bounded. Prefer the most recent
    // commits (GitHub's PR linkage is most useful when fresh).
    let sample = repoCommits;
    if (repoCommits.length > MAX_ORPHAN_PR_CHECKS_PER_REPO) {
      truncated = true;
      sample = [...repoCommits]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, MAX_ORPHAN_PR_CHECKS_PER_REPO);
      console.warn(
        `    ⚠ ${repo}: ${repoCommits.length} orphan commits exceeds cap of ${MAX_ORPHAN_PR_CHECKS_PER_REPO}; checking most recent only`,
      );
    }

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
              openedByOther: pr.user?.login !== username,
            });
          }
          newPRs.get(prId)!.shas.push(commit.sha);
        } catch (err) {
          // 404 is the expected signal that a commit has no PR — stay silent.
          // Any other error is worth surfacing so we don't mask auth/network
          // problems during orphan resolution.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/404|Not Found/i.test(msg)) {
            warnOnError(`resolveOrphanCommitPRs[${repo}/${commit.sha.slice(0, 7)}]`, err);
          }
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

  // Convert new PRs to PullRequest objects, fetching PR-level size so the UI
  // can show a real +/- count (matches what GitHub's PR page shows).
  const newPRList = [...newPRs.entries()];
  const result: PullRequest[] = await mapWithConcurrency(
    newPRList,
    async ([prId, info]) => {
      let stats: PullRequest["stats"];
      try {
        const detail = await ghApi<{
          additions: number;
          deletions: number;
          changed_files: number;
        }>(`/repos/${info.repo}/pulls/${info.number}`);
        stats = {
          additions: detail.additions,
          deletions: detail.deletions,
          changedFiles: detail.changed_files,
        };
      } catch (err) {
        warnOnError(`resolveOrphanCommitPRs[${info.repo}#${info.number}].stats`, err);
      }
      return {
        id: prId,
        number: info.number,
        title: info.title,
        state: info.state as "merged" | "open" | "closed",
        repo: info.repo,
        mergedAt: info.mergedAt,
        createdAt: info.createdAt,
        commits: info.shas,
        stats,
        openedByOther: info.openedByOther,
      };
    },
    DIFF_CONCURRENCY,
  );

  return { newPRs: result, truncated };
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

  let files: string[] | undefined;
  if (row.files) {
    try {
      files = JSON.parse(row.files) as string[];
    } catch (err) {
      warnOnError(`getCachedCommit[${row.sha.slice(0, 7)}].files`, err);
    }
  }

  let stats: CommitStats | undefined;
  if (row.statsJson) {
    try {
      stats = JSON.parse(row.statsJson) as CommitStats;
    } catch (err) {
      warnOnError(`getCachedCommit[${row.sha.slice(0, 7)}].stats`, err);
    }
  }

  return {
    sha: row.sha,
    message: row.message,
    author: row.author,
    date: row.date,
    repo: row.repo,
    diff: row.diff ?? undefined,
    files,
    stats,
    isMerge: row.isMerge === 1,
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
      statsJson: commit.stats ? JSON.stringify(commit.stats) : null,
      isMerge: commit.isMerge ? 1 : 0,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Queue PR metadata for the git-sync datastore. Fire-and-forget — any write
 * failure is logged via warnOnError and never blocks the SQLite cache.
 */
function syncPRToDatastore(pr: PullRequest): void {
  const stored: StoredPR = {
    id: pr.id,
    number: pr.number,
    repo: pr.repo,
    title: pr.title,
    state: pr.state,
    mergedAt: pr.mergedAt,
    createdAt: pr.createdAt,
    commits: pr.commits,
    stats: pr.stats,
    openedByOther: pr.openedByOther ?? false,
  };
  void persistPR(stored).catch((err) =>
    warnOnError(`syncPRToDatastore[${pr.id}]`, err),
  );
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
      additions: pr.stats?.additions ?? null,
      deletions: pr.stats?.deletions ?? null,
      changedFiles: pr.stats?.changedFiles ?? null,
      openedByOther: pr.openedByOther ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: schema.pullRequests.id,
      set: {
        title: pr.title,
        state: pr.state,
        mergedAt: pr.mergedAt ?? null,
        commitShas: JSON.stringify(pr.commits),
        openedByOther: pr.openedByOther ? 1 : 0,
        // Preserve previously-cached stats if the new record lacks them (e.g.
        // orphan-resolution path only knows PR metadata, not compare size).
        ...(pr.stats
          ? {
              additions: pr.stats.additions,
              deletions: pr.stats.deletions,
              changedFiles: pr.stats.changedFiles,
            }
          : {}),
      },
    })
    .run();

  syncPRToDatastore(pr);
}

/**
 * List cached commits for a repo within [from, to] (ISO 8601 date strings).
 * String comparison works because commit.date is an ISO timestamp.
 */
export function listCachedCommitsForRange(
  repoFullName: string,
  from: string,
  to: string,
): Commit[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.commits)
    .where(
      and(
        eq(schema.commits.repo, repoFullName),
        gte(schema.commits.date, from),
        lte(schema.commits.date, to),
      ),
    )
    .all();

  return rows.map((row) => {
    let files: string[] | undefined;
    if (row.files) {
      try {
        files = JSON.parse(row.files) as string[];
      } catch (err) {
        warnOnError(`listCachedCommits[${row.sha.slice(0, 7)}].files`, err);
      }
    }
    let stats: CommitStats | undefined;
    if (row.statsJson) {
      try {
        stats = JSON.parse(row.statsJson) as CommitStats;
      } catch (err) {
        warnOnError(`listCachedCommits[${row.sha.slice(0, 7)}].stats`, err);
      }
    }
    return {
      sha: row.sha,
      message: row.message,
      author: row.author,
      date: row.date,
      repo: row.repo,
      diff: row.diff ?? undefined,
      files,
      stats,
      isMerge: row.isMerge === 1,
    };
  });
}

/**
 * List cached PRs for a repo whose merge/create date falls within [from, to].
 * A PR is included if its mergedAt (or createdAt, if unmerged) is in range.
 */
export function listCachedPRsForRange(
  repoFullName: string,
  from: string,
  to: string,
): PullRequest[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.repo, repoFullName))
    .all();

  const result: PullRequest[] = [];
  for (const row of rows) {
    const anchor = row.mergedAt ?? row.createdAt;
    if (!anchor || anchor < from || anchor > to) continue;

    let commits: string[] = [];
    if (row.commitShas) {
      try {
        commits = JSON.parse(row.commitShas) as string[];
      } catch (err) {
        warnOnError(`listCachedPRs[${row.id}].commitShas`, err);
      }
    }

    result.push({
      id: row.id,
      number: row.number,
      title: row.title,
      state: row.state as PullRequest["state"],
      repo: row.repo,
      mergedAt: row.mergedAt ?? undefined,
      createdAt: row.createdAt,
      commits,
      stats:
        row.additions != null &&
        row.deletions != null &&
        row.changedFiles != null
          ? {
              additions: row.additions,
              deletions: row.deletions,
              changedFiles: row.changedFiles,
            }
          : undefined,
      openedByOther: row.openedByOther === 1,
    });
  }
  return result;
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
  onProgress?: FetchProgressCallback,
): Promise<ContributionsResult> {
  const { repos, from, to, scope, gitEmails = [] } = params;

  const allCommits: Commit[] = [];
  const allPRs: PullRequest[] = [];
  let totalFilesChanged = 0;
  let cachedCommitCount = 0;
  let fetchedCommitCount = 0;

  const repoCount = repos.length;
  const hasPRScope = scope.some((s) => s.endsWith("-prs"));

  // Per-repo collection of commit lists so we can fan out steps 2 & 3 across all repos.
  const perRepo: Array<{ repo: string; commitList: Commit[] }> = [];

  for (let repoIdx = 0; repoIdx < repos.length; repoIdx++) {
    const repo = repos[repoIdx]!;
    console.log(`  📦 Fetching contributions from ${repo}...`);

    // ── Step 1: Fetch commit list ──
    onProgress?.(
      makeProgress("fetch-commit-list", {
        current: repoIdx,
        total: repoCount,
        detail: `repo ${repoIdx + 1}/${repoCount} · ${repo}`,
      }),
    );

    let commitList: Commit[];
    try {
      commitList = await fetchCommits(repo, from, to, gitEmails);
    } catch (err) {
      console.warn(`  ⚠ Could not fetch commits for ${repo}: ${err}`);
      commitList = [];
    }
    console.log(`    Found ${commitList.length} commits`);

    onProgress?.(
      makeProgress("fetch-commit-list", {
        current: repoIdx + 1,
        total: repoCount,
        detail: `repo ${repoIdx + 1}/${repoCount} · ${repo} · found ${commitList.length} commits`,
        stepDone: repoIdx + 1 === repoCount,
      }),
    );

    perRepo.push({ repo, commitList });
  }

  // ── Step 2: Fetch commit diffs (per repo) ──
  for (let repoIdx = 0; repoIdx < perRepo.length; repoIdx++) {
    const { repo, commitList } = perRepo[repoIdx]!;

    // Always emit an initial event so the step becomes visible even when the
    // commit list is empty.
    onProgress?.(
      makeProgress("fetch-commit-diffs", {
        current: 0,
        total: commitList.length,
        detail:
          repoCount > 1
            ? `repo ${repoIdx + 1}/${repoCount} · ${repo}`
            : repo,
      }),
    );

    if (commitList.length > 0) {
      let doneInRepo = 0;
      const enrichedCommits = await mapWithConcurrency(
        commitList,
        async (commit, i) => {
          // Check cache first — commits are immutable, so cached diffs are always valid
          const cached = getCachedCommit(commit.sha);
          if (cached && cached.diff !== undefined) {
            cachedCommitCount++;
            doneInRepo++;
            onProgress?.(
              makeProgress("fetch-commit-diffs", {
                current: doneInRepo,
                total: commitList.length,
                detail:
                  repoCount > 1
                    ? `repo ${repoIdx + 1}/${repoCount} · ${repo} · ${doneInRepo}/${commitList.length}`
                    : `${repo} · ${doneInRepo}/${commitList.length}`,
                cached: true,
              }),
            );
            return cached;
          }

          // Fetch diff from GitHub
          try {
            const detail = await fetchCommitDetail(repo, commit.sha);
            const enriched: Commit = {
              ...commit,
              diff: detail.diff,
              files: detail.files,
              stats: detail.stats,
              isMerge: detail.isMerge,
              ...(detail.filesListTruncated ? { filesListTruncated: true } : {}),
            };
            cacheCommit(enriched);
            fetchedCommitCount++;
            doneInRepo++;

            // Progress logging every 10 commits
            if ((i + 1) % 10 === 0 || i + 1 === commitList.length) {
              console.log(`    Fetched ${i + 1}/${commitList.length} commit diffs...`);
            }

            onProgress?.(
              makeProgress("fetch-commit-diffs", {
                current: doneInRepo,
                total: commitList.length,
                detail:
                  repoCount > 1
                    ? `repo ${repoIdx + 1}/${repoCount} · ${repo} · ${doneInRepo}/${commitList.length}`
                    : `${repo} · ${doneInRepo}/${commitList.length}`,
              }),
            );

            return enriched;
          } catch (err) {
            // If diff fetch fails, cache the commit without a diff and continue
            console.warn(
              `    ⚠ Could not fetch diff for ${commit.sha.slice(0, 7)}: ${err}`,
            );
            cacheCommit(commit);
            fetchedCommitCount++;
            doneInRepo++;
            onProgress?.(
              makeProgress("fetch-commit-diffs", {
                current: doneInRepo,
                total: commitList.length,
                detail:
                  repoCount > 1
                    ? `repo ${repoIdx + 1}/${repoCount} · ${repo} · ${doneInRepo}/${commitList.length}`
                    : `${repo} · ${doneInRepo}/${commitList.length}`,
              }),
            );
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

    if (repoIdx + 1 === perRepo.length) {
      onProgress?.(
        makeProgress("fetch-commit-diffs", {
          current: commitList.length,
          total: commitList.length || 1,
          stepDone: true,
        }),
      );
    }
  }

  // ── Step 3: Fetch pull requests (per repo) ──
  for (let repoIdx = 0; repoIdx < perRepo.length; repoIdx++) {
    const { repo } = perRepo[repoIdx]!;

    onProgress?.(
      makeProgress("fetch-pull-requests", {
        current: repoIdx,
        total: repoCount,
        detail: hasPRScope
          ? `repo ${repoIdx + 1}/${repoCount} · ${repo}`
          : "PR scope not requested — skipping",
      }),
    );

    if (hasPRScope) {
      try {
        const prList = await fetchPullRequests(repo, from, to, scope);
        console.log(`    Found ${prList.length} pull requests`);

        for (const pr of prList) {
          cachePR(pr);
          allPRs.push(pr);
        }

        onProgress?.(
          makeProgress("fetch-pull-requests", {
            current: repoIdx + 1,
            total: repoCount,
            detail: `repo ${repoIdx + 1}/${repoCount} · ${repo} · found ${prList.length} PRs`,
            stepDone: repoIdx + 1 === repoCount,
          }),
        );
      } catch (err) {
        console.warn(`  ⚠ Could not fetch PRs for ${repo}: ${err}`);
        onProgress?.(
          makeProgress("fetch-pull-requests", {
            current: repoIdx + 1,
            total: repoCount,
            detail: `repo ${repoIdx + 1}/${repoCount} · ${repo} · fetch failed`,
            stepDone: repoIdx + 1 === repoCount,
          }),
        );
      }
    } else {
      onProgress?.(
        makeProgress("fetch-pull-requests", {
          current: repoIdx + 1,
          total: repoCount,
          detail: "PR scope not requested — skipping",
          stepDone: repoIdx + 1 === repoCount,
        }),
      );
    }
  }

  // ── Step 4: Backfill missing PR commits ──
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

    onProgress?.(
      makeProgress("backfill-pr-commits", {
        current: 0,
        total: missingShas.length,
        detail:
          missingShas.length === 0
            ? "nothing to backfill"
            : `0/${missingShas.length} commits`,
      }),
    );

    if (missingShas.length > 0) {
      console.log(`    Backfilling ${missingShas.length} PR branch commit(s)...`);
      let doneBackfill = 0;
      const backfilled = await mapWithConcurrency(
        missingShas,
        async ({ sha, repo }) => {
          // Check cache first
          const cached = getCachedCommit(sha);
          if (cached && cached.diff !== undefined) {
            cachedCommitCount++;
            doneBackfill++;
            onProgress?.(
              makeProgress("backfill-pr-commits", {
                current: doneBackfill,
                total: missingShas.length,
                detail: `${doneBackfill}/${missingShas.length} commits`,
                cached: true,
              }),
            );
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
              stats: detail.stats,
              isMerge: detail.isMerge,
              ...(detail.filesListTruncated ? { filesListTruncated: true } : {}),
            };
            cacheCommit(commit);
            fetchedCommitCount++;
            doneBackfill++;
            onProgress?.(
              makeProgress("backfill-pr-commits", {
                current: doneBackfill,
                total: missingShas.length,
                detail: `${doneBackfill}/${missingShas.length} commits`,
              }),
            );
            return commit;
          } catch (err) {
            console.warn(`    ⚠ Could not fetch PR commit ${sha.slice(0, 7)}: ${err}`);
            doneBackfill++;
            onProgress?.(
              makeProgress("backfill-pr-commits", {
                current: doneBackfill,
                total: missingShas.length,
                detail: `${doneBackfill}/${missingShas.length} commits · one failed`,
              }),
            );
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

    onProgress?.(
      makeProgress("backfill-pr-commits", {
        current: missingShas.length,
        total: missingShas.length || 1,
        detail:
          missingShas.length === 0
            ? "nothing to backfill"
            : `${missingShas.length}/${missingShas.length} commits`,
        stepDone: true,
      }),
    );
  }

  // ── Step 8: Resolve orphan commits → link to PRs (squash merges + others' PRs) ──
  const knownPRShas = new Set(allPRs.flatMap((pr) => pr.commits));
  let orphanCheckTruncated = false;
  try {
    const { newPRs, truncated } = await resolveOrphanCommitPRs(
      allCommits,
      knownPRShas,
      allPRs,
    );
    orphanCheckTruncated = truncated;
    for (const pr of newPRs) {
      cachePR(pr);
      allPRs.push(pr);
    }
    // Update caches for existing PRs that got new squash-merge commits added
    for (const pr of allPRs) {
      cachePR(pr);
    }
  } catch (err) {
    warnOnError("resolveOrphanCommitPRs", err);
  }

  console.log(
    `\n  ✅ Done — ${allCommits.length} commits, ${allPRs.length} PRs across ${repos.length} repo(s)`,
  );
  if (cachedCommitCount > 0) {
    console.log(`     (${cachedCommitCount} from cache, ${fetchedCommitCount} fetched)\n`);
  }

  const commitsWithTruncatedFiles = allCommits.filter((c) => c.filesListTruncated).length;

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
      commitsWithTruncatedFiles,
      orphanCheckTruncated,
    },
  };
}
