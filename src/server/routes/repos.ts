import { Hono } from "hono";
import {
  listRepos,
  listOrgs,
  getAuthenticatedUser,
  type Repo,
} from "../../core/github.ts";

export const reposRouter = new Hono();

// GET /api/repos — list user's repos and orgs
// Returns repos grouped by owner (personal vs each organization)
reposRouter.get("/", async (c) => {
  try {
    // Fetch user info, repos, and orgs concurrently
    const [username, repos, orgs] = await Promise.all([
      getAuthenticatedUser(),
      listRepos(),
      listOrgs(),
    ]);

    // Split into personal repos and org repos
    const personalRepos = repos.filter((r) => r.owner === username);
    const orgRepos = repos.filter((r) => r.owner !== username);

    // Group org repos by org login
    const orgRepoMap: Record<string, Repo[]> = {};
    for (const repo of orgRepos) {
      const orgLogin = repo.owner;
      if (!orgRepoMap[orgLogin]) orgRepoMap[orgLogin] = [];
      orgRepoMap[orgLogin].push(repo);
    }

    return c.json({
      username,
      repos: personalRepos,
      orgs: orgs.map((org) => ({
        ...org,
        repos: orgRepoMap[org.login] ?? [],
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Provide a helpful error if gh CLI is the problem
    if (
      message.includes("gh") &&
      (message.includes("not found") ||
        message.includes("ENOENT") ||
        message.includes("failed"))
    ) {
      return c.json(
        {
          error:
            "GitHub CLI (gh) is not installed or not authenticated. Run `shiplog setup` to fix this.",
        },
        503,
      );
    }

    if (message.includes("rate limit")) {
      return c.json({ error: message }, 429);
    }

    console.error("GET /api/repos error:", err);
    return c.json({ error: message }, 500);
  }
});
