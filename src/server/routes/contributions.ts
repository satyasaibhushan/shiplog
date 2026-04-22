import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { fetchContributions } from "../../core/github.ts";
import { asGitHubApiError } from "../../core/retry.ts";
import { deduplicateCommits, remapPullRequestCommits } from "../../core/dedup.ts";
import { groupCommits } from "../../core/grouping.ts";
import { loadConfig } from "../../cli/config.ts";
import {
  ContributionsRequestSchema,
  formatZodError,
} from "../../shared/schemas.ts";
import {
  makeProgress,
  type GenerationProgress,
} from "../../shared/progress.ts";

export const contributionsRouter = new Hono();

// POST /api/contributions — fetch, deduplicate, group contributions
// Body: { repos: string[], from: string, to: string, scope?: string[] }
//
// Accept: text/event-stream  → SSE stream (progress events + final result)
// Accept: application/json   → plain JSON (waits for completion)
contributionsRouter.post("/", async (c) => {
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

  const acceptSSE = c.req.header("Accept")?.includes("text/event-stream");

  async function runPipeline(
    onProgress?: (p: GenerationProgress) => void,
  ): Promise<ReturnType<typeof buildResponseBody>> {
    const config = await loadConfig();

    // Steps 1–4: fetch + PR listing + backfill (instrumented inside fetchContributions)
    const raw = await fetchContributions(
      {
        repos,
        from,
        to,
        scope: contributionScope,
        gitEmails: config.gitEmails,
      },
      onProgress,
    );

    // ── Step 5: Dedupe & group ──
    onProgress?.(
      makeProgress("dedupe-and-group", {
        current: 0,
        total: 3,
        detail: "deduplicating commits",
      }),
    );

    const dedupResult = deduplicateCommits(raw.commits);

    onProgress?.(
      makeProgress("dedupe-and-group", {
        current: 1,
        total: 3,
        detail: `deduped ${dedupResult.totalRemoved} duplicate(s)`,
      }),
    );

    const { emptiedPrCount } = remapPullRequestCommits(
      raw.pullRequests,
      dedupResult,
    );
    if (emptiedPrCount > 0) {
      console.warn(
        `[contributions] ${emptiedPrCount} PR(s) ended up with zero commits after dedup/filter`,
      );
    }

    onProgress?.(
      makeProgress("dedupe-and-group", {
        current: 2,
        total: 3,
        detail: "grouping commits by PR",
      }),
    );

    const groupingResult = groupCommits(dedupResult.unique, raw.pullRequests);

    onProgress?.(
      makeProgress("dedupe-and-group", {
        current: 3,
        total: 3,
        detail: `${groupingResult.stats.prGroups} PR group(s), ${groupingResult.stats.orphanGroups} orphan cluster(s)`,
        stepDone: true,
      }),
    );

    return buildResponseBody(raw, dedupResult, groupingResult);
  }

  if (acceptSSE) {
    return streamSSE(c, async (stream) => {
      try {
        const result = await runPipeline((progress) => {
          // fire-and-forget; SSE writes are buffered internally
          void stream.writeSSE({
            event: "progress",
            data: JSON.stringify(progress),
          });
        });

        await stream.writeSSE({
          event: "complete",
          data: JSON.stringify(result),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: message }),
        });
      }
    });
  }

  try {
    const result = await runPipeline();
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Typed GitHub errors carry a `kind` so we can pick the right status
    // code without string-matching. Falls through to the legacy string
    // checks below for anything that isn't a GitHubApiError yet.
    const gh = asGitHubApiError(err);
    if (gh) {
      if (gh.kind === "rate-limit") return c.json({ error: gh.message }, 429);
      if (gh.kind === "auth") return c.json({ error: gh.message }, 401);
      if (gh.kind === "network") return c.json({ error: gh.message }, 502);
      if (gh.kind === "not-found") return c.json({ error: gh.message }, 404);
      // "other" falls through to the 500 path
    }

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

    console.error("POST /api/contributions error:", err);
    return c.json({ error: message }, 500);
  }
});

function buildResponseBody(
  raw: Awaited<ReturnType<typeof fetchContributions>>,
  dedupResult: ReturnType<typeof deduplicateCommits>,
  groupingResult: ReturnType<typeof groupCommits>,
) {
  return {
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
  };
}
