import { Hono } from "hono";
import { fetchContributions } from "../../core/github.ts";
import { deduplicateCommits } from "../../core/dedup.ts";
import { groupCommits } from "../../core/grouping.ts";

export const contributionsRouter = new Hono();

// POST /api/contributions — fetch, deduplicate, group contributions
// Body: { repos: string[], from: string, to: string, scope?: string[] }
contributionsRouter.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { repos, from, to, scope } = body;

    // ── Validation ──

    if (!repos || !Array.isArray(repos) || repos.length === 0) {
      return c.json(
        {
          error:
            "`repos` is required and must be a non-empty array of repo names (e.g. ['owner/repo'])",
        },
        400,
      );
    }

    if (!from || typeof from !== "string") {
      return c.json(
        { error: "`from` date is required (YYYY-MM-DD format)" },
        400,
      );
    }

    if (!to || typeof to !== "string") {
      return c.json(
        { error: "`to` date is required (YYYY-MM-DD format)" },
        400,
      );
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from)) {
      return c.json(
        { error: `Invalid \`from\` date: "${from}". Must be YYYY-MM-DD.` },
        400,
      );
    }
    if (!dateRegex.test(to)) {
      return c.json(
        { error: `Invalid \`to\` date: "${to}". Must be YYYY-MM-DD.` },
        400,
      );
    }

    if (new Date(from) > new Date(to)) {
      return c.json(
        { error: "`from` date must be before `to` date." },
        400,
      );
    }

    // Validate repo names are in "owner/repo" format
    for (const repo of repos) {
      if (typeof repo !== "string" || !repo.includes("/")) {
        return c.json(
          {
            error: `Invalid repo name: "${repo}". Must be in "owner/repo" format.`,
          },
          400,
        );
      }
    }

    // Default scope: merged PRs + direct commits
    const validScopes = [
      "merged-prs",
      "open-prs",
      "closed-prs",
      "direct-commits",
      "fork-branches",
    ];
    const contributionScope =
      scope && Array.isArray(scope) && scope.length > 0
        ? scope.filter((s: string) => validScopes.includes(s))
        : ["merged-prs", "direct-commits"];

    // ── Step 1: Fetch raw contributions from GitHub ──

    const raw = await fetchContributions({
      repos,
      from,
      to,
      scope: contributionScope,
    });

    // ── Step 2: Deduplicate commits by patch-id ──

    const dedupResult = deduplicateCommits(raw.commits);

    // ── Step 3: Group into PR groups + orphan clusters ──

    const groupingResult = groupCommits(
      dedupResult.unique,
      raw.pullRequests,
    );

    // ── Response ──

    return c.json({
      groups: groupingResult.groups,
      commits: dedupResult.unique,
      pullRequests: raw.pullRequests,
      stats: {
        ...raw.stats,
        duplicatesRemoved: dedupResult.totalRemoved,
        uniqueCommits: dedupResult.unique.length,
        prGroups: groupingResult.stats.prGroups,
        orphanGroups: groupingResult.stats.orphanGroups,
        orphanCommits: groupingResult.stats.orphanCommits,
        commitsInPRs: groupingResult.stats.commitsInPRs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

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

    console.error("POST /api/contributions error:", err);
    return c.json({ error: message }, 500);
  }
});
