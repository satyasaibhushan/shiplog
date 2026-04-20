import { Hono } from "hono";
import { fetchContributions } from "../../core/github.ts";
import { deduplicateCommits, remapPullRequestCommits } from "../../core/dedup.ts";
import { groupCommits } from "../../core/grouping.ts";
import { loadConfig } from "../../cli/config.ts";
import {
  ContributionsRequestSchema,
  formatZodError,
} from "../../shared/schemas.ts";

export const contributionsRouter = new Hono();

// POST /api/contributions — fetch, deduplicate, group contributions
// Body: { repos: string[], from: string, to: string, scope?: string[] }
contributionsRouter.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ContributionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }

    const { repos, from, to, scope } = parsed.data;

    // Default scope: merged PRs + direct commits
    const contributionScope =
      scope && scope.length > 0 ? scope : ["merged-prs", "direct-commits"];

    // ── Step 1: Fetch raw contributions from GitHub ──

    const config = await loadConfig();
    const raw = await fetchContributions({
      repos,
      from,
      to,
      scope: contributionScope,
      gitEmails: config.gitEmails,
    });

    // ── Step 2: Deduplicate commits by patch-id ──

    const dedupResult = deduplicateCommits(raw.commits);

    // ── Step 2b: Remap PR commit SHAs after dedup & drop missing SHAs ──
    const { emptiedPrCount } = remapPullRequestCommits(
      raw.pullRequests,
      dedupResult,
    );
    if (emptiedPrCount > 0) {
      console.warn(
        `[contributions] ${emptiedPrCount} PR(s) ended up with zero commits after dedup/filter`,
      );
    }

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
