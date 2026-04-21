import { Hono } from "hono";
import {
  listRepos,
  listOrgs,
  getAuthenticatedUser,
  getLocalGitEmail,
  fetchContributedRepos,
  type Repo,
} from "../../core/github.ts";

export const reposRouter = new Hono();

// In-memory cache for the full repos payload. GitHub pagination makes the
// naive path take several seconds; org/repo membership is stable enough that
// a 5-minute TTL is fine. `?refresh=1` bypasses the cache.
interface ReposPayload {
  username: string;
  email: string | null;
  repos: Repo[];
  orgs: Array<{ login: string; description?: string; repos: Repo[] }>;
}
const REPOS_CACHE_TTL_MS = 5 * 60 * 1000;
let reposCache: { at: number; payload: ReposPayload } | null = null;

// Contribution set rarely changes (authoring a new commit is the only signal
// that invalidates it), so a longer TTL is fine. `?refresh=1` forces a refetch.
const CONTRIBUTED_CACHE_TTL_MS = 60 * 60 * 1000;
let contributedCache: { at: number; repos: string[] } | null = null;

// GET /api/repos — list user's repos and orgs
// Deduplicates personal forks of org repos: shows one entry under the org,
// but includes the fork's fullName so contributions can be fetched from both.
reposRouter.get("/", async (c) => {
  try {
    const refresh = c.req.query("refresh") === "1";
    if (!refresh && reposCache && Date.now() - reposCache.at < REPOS_CACHE_TTL_MS) {
      return c.json(reposCache.payload);
    }
    // First check: can we authenticate at all?
    let username: string;
    try {
      username = await getAuthenticatedUser();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT") || msg.includes("not found")) {
        return c.json(
          { error: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login`." },
          503,
        );
      }
      if (msg.includes("auth") || msg.includes("401")) {
        return c.json(
          { error: "GitHub CLI is not authenticated. Run `gh auth login` in your terminal." },
          503,
        );
      }
      return c.json({ error: `GitHub error: ${msg}` }, 503);
    }

    const [repos, orgs, email] = await Promise.all([
      listRepos().catch((err) => {
        console.warn("Could not list repos:", err);
        return [] as Repo[];
      }),
      listOrgs().catch(() => []),
      getLocalGitEmail().catch(() => null),
    ]);

    // Split into personal and org repos
    const personalRepos = repos.filter((r) => r.owner === username);
    const orgRepos = repos.filter((r) => r.owner !== username);

    // Build a set of org repo names for dedup: "repoName" → org fullName
    const orgRepoNames = new Map<string, string>();
    for (const r of orgRepos) {
      orgRepoNames.set(r.name, r.fullName);
    }

    // Deduplicate: remove personal forks that have a matching org repo (same name).
    // Attach the fork's fullName to the org repo as `forkFullName` so contributions
    // can be fetched from both.
    const forkMap = new Map<string, string>(); // orgFullName → forkFullName
    const dedupedPersonal: Repo[] = [];

    for (const r of personalRepos) {
      const orgMatch = orgRepoNames.get(r.name);
      if (orgMatch && r.isForked) {
        // This personal repo is a fork of the org repo — hide it, link the fork
        forkMap.set(orgMatch, r.fullName);
      } else {
        dedupedPersonal.push(r);
      }
    }

    // Group org repos by owner, attaching fork info
    const orgRepoMap: Record<string, (Repo & { forkFullName?: string })[]> = {};
    for (const repo of orgRepos) {
      const owner = repo.owner;
      if (!orgRepoMap[owner]) orgRepoMap[owner] = [];
      orgRepoMap[owner].push({
        ...repo,
        forkFullName: forkMap.get(repo.fullName),
      });
    }

    // Build org list: merge known orgs with extra owners from repos
    const knownOrgLogins = new Set(orgs.map((o) => o.login));
    const allOrgEntries = [
      ...orgs.map((org) => ({
        ...org,
        repos: orgRepoMap[org.login] ?? [],
      })),
      ...Object.keys(orgRepoMap)
        .filter((owner) => !knownOrgLogins.has(owner))
        .map((owner) => ({
          login: owner,
          description: undefined,
          repos: orgRepoMap[owner] ?? [],
        })),
    ];

    const payload: ReposPayload = {
      username,
      email,
      repos: dedupedPersonal,
      orgs: allOrgEntries,
    };
    reposCache = { at: Date.now(), payload };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("rate limit")) {
      return c.json({ error: message }, 429);
    }
    console.error("GET /api/repos error:", err);
    return c.json({ error: message }, 500);
  }
});

// GET /api/repos/contributed — list of `owner/repo` fullNames the authed user
// has authored at least one commit in. Used by the "hide repos with no
// contributions" toggle to prune the sidebar.
reposRouter.get("/contributed", async (c) => {
  const refresh = c.req.query("refresh") === "1";
  if (
    !refresh &&
    contributedCache &&
    Date.now() - contributedCache.at < CONTRIBUTED_CACHE_TTL_MS
  ) {
    return c.json({ repos: contributedCache.repos });
  }
  try {
    const set = await fetchContributedRepos();
    const repos = Array.from(set).sort();
    contributedCache = { at: Date.now(), repos };
    return c.json({ repos });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("GET /api/repos/contributed error:", err);
    return c.json({ error: message }, 500);
  }
});
