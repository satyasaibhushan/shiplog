// Seeds a throwaway shiplog workspace with fictional data for the README demo.
// Writes through the real entity and cache layers, so the web UI reads it the
// same way it reads generated logs. Summaries are hand-written fixture text,
// not model output. Run only with SHIPLOG_CONFIG_DIR and SHIPLOG_DATA_DIR set
// to scratch directories: it refuses to touch ~/.shiplog.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { initDb, getDb, closeDb } from "../../src/core/cache.ts";
import { appendSummaryVersion, createLog, createRollup } from "../../src/core/entities.ts";
import { deduplicateCommits, remapPullRequestCommits } from "../../src/core/dedup.ts";
import { groupCommits } from "../../src/core/grouping.ts";
import { computeGroupHash } from "../../src/core/summarizer.ts";
import { DEFAULT_CONFIG } from "../../src/cli/config.ts";
import type { Commit, PullRequest } from "../../src/core/github.ts";
import * as schema from "../../src/db/schema.ts";

const configDir = process.env.SHIPLOG_CONFIG_DIR;
const dataDir = process.env.SHIPLOG_DATA_DIR;
if (!configDir || !dataDir) {
  console.error("seed: set SHIPLOG_CONFIG_DIR and SHIPLOG_DATA_DIR to scratch directories");
  process.exit(1);
}

export const DEMO_EMAIL = "rowan@acme.test";
const MODEL = "sonnet";

mkdirSync(configDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
// promptedAt keeps the first-run sync prompt from blocking the server.
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify(
    { ...DEFAULT_CONFIG, llm: "claude-cli", sync: { ...DEFAULT_CONFIG.sync, promptedAt: "2026-10-01T00:00:00.000Z" } },
    null,
    2,
  ),
);

initDb();
const db = getDb();

interface PRSpec {
  number: number;
  title: string;
  state: PullRequest["state"];
  day: string;
  additions: number;
  deletions: number;
  files: string[];
  commits: string[];
  summary: string;
}
interface OrphanSpec {
  day: string;
  message: string;
  file: string;
  additions: number;
  deletions: number;
}
interface LogSpec {
  repo: string;
  rangeStart: string;
  rangeEnd: string;
  title?: string;
  prs: PRSpec[];
  orphans: OrphanSpec[];
  versions: string[];
}

let shaCounter = 0;
function nextSha(): string {
  shaCounter += 1;
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`shiplog-demo-${shaCounter}`);
  return hasher.digest("hex");
}

function makeCommit(repo: string, date: string, message: string, file: string, additions: number, deletions: number): Commit {
  const sha = nextSha();
  return {
    sha,
    message,
    author: "rowanhale",
    date,
    repo,
    // A distinct diff per commit keeps patch-id dedup from collapsing fixtures.
    diff: `diff --git a/${file} b/${file}\n+// ${message} (${sha.slice(0, 7)})\n`,
    files: [file],
    stats: { additions, deletions, files: 1, truncated: false, perFile: [{ filename: file, additions, deletions, status: "modified" }] },
    isMerge: false,
  };
}

function cacheCommit(c: Commit): void {
  db.insert(schema.commits)
    .values({
      sha: c.sha,
      repo: c.repo,
      message: c.message,
      author: c.author,
      date: c.date,
      diff: c.diff ?? null,
      files: JSON.stringify(c.files ?? []),
      statsJson: JSON.stringify(c.stats),
      isMerge: 0,
    })
    .onConflictDoNothing()
    .run();
}

function cachePR(pr: PullRequest): void {
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
      openedByOther: 0,
    })
    .onConflictDoNothing()
    .run();
}

type Timeline = NonNullable<Parameters<typeof appendSummaryVersion>[0]["timeline"]>;
type Stats = NonNullable<Parameters<typeof appendSummaryVersion>[0]["stats"]>;

async function seedLog(spec: LogSpec): Promise<{ id: string; timeline: Timeline; stats: Stats }> {
  const [owner, repo] = spec.repo.split("/") as [string, string];
  const commits: Commit[] = [];
  const prs: PullRequest[] = [];
  const prSummaries = new Map<string, string>();
  const byDay = new Map<string, { additions: number; deletions: number; prCount: number; commitCount: number; topPRTitles: string[] }>();
  const bump = (day: string, add: number, del: number, prTitle?: string) => {
    const entry = byDay.get(day) ?? { additions: 0, deletions: 0, prCount: 0, commitCount: 0, topPRTitles: [] };
    entry.additions += add;
    entry.deletions += del;
    entry.commitCount += 1;
    if (prTitle && !entry.topPRTitles.includes(prTitle)) {
      entry.topPRTitles.push(prTitle);
      entry.prCount += 1;
    }
    byDay.set(day, entry);
  };

  for (const p of spec.prs) {
    const shas: string[] = [];
    p.commits.forEach((message, i) => {
      const add = Math.round(p.additions / p.commits.length);
      const del = Math.round(p.deletions / p.commits.length);
      const c = makeCommit(spec.repo, `${p.day}T${String(9 + i).padStart(2, "0")}:15:00Z`, message, p.files[i % p.files.length]!, add, del);
      commits.push(c);
      shas.push(c.sha);
      bump(p.day, add, del, p.title);
    });
    const pr: PullRequest = {
      id: `${spec.repo}:${p.number}`,
      number: p.number,
      title: p.title,
      state: p.state,
      repo: spec.repo,
      createdAt: `${p.day}T08:00:00Z`,
      ...(p.state === "merged" ? { mergedAt: `${p.day}T17:30:00Z` } : {}),
      commits: shas,
      stats: { additions: p.additions, deletions: p.deletions, changedFiles: p.files.length },
    };
    prs.push(pr);
    prSummaries.set(pr.id, p.summary);
  }
  for (const o of spec.orphans) {
    const c = makeCommit(spec.repo, `${o.day}T14:40:00Z`, o.message, o.file, o.additions, o.deletions);
    commits.push(c);
    bump(o.day, o.additions, o.deletions);
  }
  commits.forEach(cacheCommit);
  prs.forEach(cachePR);

  // Cache per-group summaries under the same hashes the log view looks up.
  const dedup = deduplicateCommits(commits);
  remapPullRequestCommits(prs, dedup);
  const grouping = groupCommits(dedup.unique, prs);
  for (const g of grouping.groups) {
    const summary = g.type === "pr" && g.pr
      ? prSummaries.get(g.pr.id)!
      : `Housekeeping: ${g.commits.map((c) => c.message.toLowerCase()).join("; ")}.`;
    db.insert(schema.summaries)
      .values({ contentHash: computeGroupHash(g), summaryType: g.type, summary, provider: "claude-cli" })
      .onConflictDoNothing()
      .run();
  }

  const timeline = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
  const stats = {
    additions: commits.reduce((n, c) => n + (c.stats?.additions ?? 0), 0),
    deletions: commits.reduce((n, c) => n + (c.stats?.deletions ?? 0), 0),
    files: new Set(commits.flatMap((c) => c.files ?? [])).size,
    commits: commits.length,
    prs: prs.length,
  };

  const log = await createLog({ owner, repo, authorEmail: DEMO_EMAIL, rangeStart: spec.rangeStart, rangeEnd: spec.rangeEnd, ...(spec.title ? { title: spec.title } : {}) });
  for (const [i, markdown] of spec.versions.entries()) {
    await appendSummaryVersion({
      parentKind: "log",
      parentId: log.id,
      summaryMarkdown: markdown,
      timeline,
      stats,
      source: i === 0 ? "generated" : "chat",
      ...(i === 0 ? {} : { chatPrompt: { instruction: "Lead with the customer-facing change" } }),
      model: MODEL,
    });
  }
  return { id: log.id, timeline, stats };
}

const atlas = await seedLog({
  repo: "acme/atlas",
  rangeStart: "2026-09-28",
  title: "Sprint 41",
  rangeEnd: "2026-10-21",
  prs: [
    {
      number: 412, title: "Add saved dashboard views", state: "merged", day: "2026-09-30", additions: 842, deletions: 120,
      files: ["src/views/SavedViews.tsx", "src/api/views.ts", "src/views/ViewPicker.tsx"],
      commits: ["Add saved view model and API", "Render view picker in the toolbar", "Persist last used view per workspace"],
      summary: "Users can now save a dashboard layout with its filters and switch between saved views from the toolbar. The last used view is restored per workspace.",
    },
    {
      number: 418, title: "Cache chart queries per workspace", state: "merged", day: "2026-10-06", additions: 391, deletions: 214,
      files: ["src/data/queryCache.ts", "src/data/charts.ts"],
      commits: ["Introduce workspace-scoped query cache", "Invalidate cached charts on data import"],
      summary: "Chart queries are cached per workspace and invalidated when new data is imported, cutting repeat dashboard loads from several seconds to well under one.",
    },
    {
      number: 421, title: "Fix timezone drift in weekly charts", state: "merged", day: "2026-10-09", additions: 96, deletions: 41,
      files: ["src/data/buckets.ts", "src/data/buckets.test.ts"],
      commits: ["Bucket weekly charts in the workspace timezone", "Cover DST boundaries in bucket tests"],
      summary: "Weekly charts now bucket events in the workspace timezone, fixing totals that shifted by a day around daylight saving changes.",
    },
    {
      number: 425, title: "Export dashboards as PDF", state: "open", day: "2026-10-16", additions: 510, deletions: 32,
      files: ["src/export/pdf.ts", "src/export/ExportMenu.tsx"],
      commits: ["Render dashboards to PDF on the server", "Add export menu with page size options"],
      summary: "Work in progress: server-side PDF export for dashboards with A4 and Letter page sizes. Not merged yet.",
    },
  ],
  orphans: [
    { day: "2026-10-13", message: "Bump chart library to 5.2", file: "package.json", additions: 14, deletions: 14 },
    { day: "2026-10-13", message: "Fix lint warnings in toolbar", file: "src/views/Toolbar.tsx", additions: 9, deletions: 12 },
  ],
  versions: [
    `# Saved views and faster dashboards for Atlas

Most of this period went into making Atlas dashboards quicker to come back to. Saved views let people keep a layout with its filters and switch between them from the toolbar, and the last view is restored per workspace.

Dashboard loads also got faster. Chart queries are now cached per workspace and cleared on data import, so opening the same dashboard twice no longer reruns every query.

A timezone bug in weekly charts was fixed, and PDF export is in review but not merged.

## Timeline
- 2026-09-30: shipped saved dashboard views
- 2026-10-06: added a per-workspace chart query cache
- 2026-10-09: fixed weekly chart totals around daylight saving changes
- 2026-10-13: dependency bump and toolbar lint cleanup
- 2026-10-16: opened the PDF export pull request`,
    `# Atlas users can save dashboard views and reopen them instantly

Customers can now save a dashboard layout with its filters and come back to it from the toolbar. Atlas remembers the last view per workspace, so a returning user lands where they left off.

Those return visits are also faster: chart queries are cached per workspace and refreshed when new data is imported.

Weekly charts no longer shift totals by a day around daylight saving changes. PDF export is open for review and has not shipped.

## Timeline
- 2026-09-30: shipped saved dashboard views
- 2026-10-06: added a per-workspace chart query cache
- 2026-10-09: fixed weekly chart totals around daylight saving changes
- 2026-10-13: dependency bump and toolbar lint cleanup
- 2026-10-16: opened the PDF export pull request`,
  ],
});

const billing = await seedLog({
  repo: "acme/billing-api",
  rangeStart: "2026-10-01",
  title: "Sprint 41",
  rangeEnd: "2026-10-21",
  prs: [
    {
      number: 88, title: "Meter API calls per workspace", state: "merged", day: "2026-10-02", additions: 455, deletions: 38,
      files: ["internal/metering/counter.go", "internal/metering/flush.go"],
      commits: ["Count API calls per workspace in memory", "Flush usage counters every minute"],
      summary: "API usage is counted per workspace and flushed to storage every minute, giving billing an accurate usage record.",
    },
    {
      number: 91, title: "Generate draft invoices nightly", state: "merged", day: "2026-10-08", additions: 610, deletions: 75,
      files: ["internal/invoices/draft.go", "cmd/nightly/main.go", "internal/invoices/draft_test.go"],
      commits: ["Build draft invoices from metered usage", "Schedule nightly invoice job", "Test proration for mid-month upgrades"],
      summary: "A nightly job turns metered usage into draft invoices, including proration for workspaces that upgrade mid-month.",
    },
    {
      number: 93, title: "Retry failed webhook deliveries", state: "merged", day: "2026-10-14", additions: 233, deletions: 61,
      files: ["internal/webhooks/retry.go", "internal/webhooks/retry_test.go"],
      commits: ["Retry webhooks with exponential backoff", "Stop retrying after 24 hours"],
      summary: "Invoice webhooks are retried with exponential backoff for up to 24 hours instead of being dropped after one failure.",
    },
  ],
  orphans: [{ day: "2026-10-15", message: "Raise metering flush log level", file: "internal/metering/flush.go", additions: 3, deletions: 3 }],
  versions: [
    `# Usage-based billing groundwork in billing-api

API calls are now metered per workspace and flushed every minute, which gives billing a usage record it can trust.

On top of that, a nightly job drafts invoices from metered usage and prorates mid-month upgrades. Invoice webhooks that fail are retried with backoff for a day instead of being lost.

## Timeline
- 2026-10-02: started metering API calls per workspace
- 2026-10-08: nightly draft invoices with proration
- 2026-10-14: webhook delivery retries
- 2026-10-15: logging tweak in the metering flush`,
  ],
});

const mobile = await seedLog({
  repo: "acme/mobile-app",
  rangeStart: "2026-10-05",
  title: "Sprint 41",
  rangeEnd: "2026-10-21",
  prs: [
    {
      number: 204, title: "Queue field note edits while offline", state: "merged", day: "2026-10-07", additions: 528, deletions: 90,
      files: ["app/src/main/java/notes/OfflineQueue.kt", "app/src/main/java/notes/SyncWorker.kt"],
      commits: ["Store pending note edits locally", "Replay queued edits when back online"],
      summary: "Field notes can be edited without a connection; edits are queued on the device and replayed when the app is back online.",
    },
    {
      number: 207, title: "Show a conflict banner after sync", state: "merged", day: "2026-10-12", additions: 187, deletions: 22,
      files: ["app/src/main/java/notes/ConflictBanner.kt"],
      commits: ["Detect conflicting note edits", "Show conflict banner with keep-both option"],
      summary: "When an offline edit conflicts with a newer server copy, the app shows a banner and lets the user keep both versions.",
    },
  ],
  orphans: [],
  versions: [
    `# Offline editing for field notes in the mobile app

Field teams can keep editing notes without a signal. Edits are queued on the device and replayed once the app reconnects.

If someone else changed the same note in the meantime, a banner explains the conflict and offers to keep both copies.

## Timeline
- 2026-10-07: offline queue for note edits
- 2026-10-12: conflict banner after sync`,
  ],
});

function sumStats(logs: Array<{ stats: Stats }>): Stats {
  return logs.reduce<Stats>(
    (t, { stats: s }) => ({ additions: t.additions + s.additions, deletions: t.deletions + s.deletions, files: t.files + s.files, commits: t.commits + s.commits, prs: (t.prs ?? 0) + (s.prs ?? 0) }),
    { additions: 0, deletions: 0, files: 0, commits: 0, prs: 0 },
  );
}

function mergeTimelines(logs: Array<{ timeline: Timeline }>): Timeline {
  const byDay = new Map<string, Timeline[number]>();
  for (const t of logs.flatMap((l) => l.timeline)) {
    const e = byDay.get(t.date);
    byDay.set(t.date, e
      ? { date: t.date, additions: e.additions + t.additions, deletions: e.deletions + t.deletions, prCount: e.prCount + t.prCount, commitCount: e.commitCount + t.commitCount, topPRTitles: [...e.topPRTitles, ...t.topPRTitles] }
      : { ...t });
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

await seedLog({
  repo: "acme/atlas",
  rangeStart: "2026-09-01",
  rangeEnd: "2026-09-27",
  prs: [
    {
      number: 397, title: "Move chart rendering to a web worker", state: "merged", day: "2026-09-08", additions: 664, deletions: 402,
      files: ["src/charts/worker.ts", "src/charts/Chart.tsx"],
      commits: ["Render charts off the main thread", "Fall back to inline rendering without worker support"],
      summary: "Chart rendering moved to a web worker so large dashboards stay responsive while they draw.",
    },
    {
      number: 403, title: "Add workspace usage page", state: "merged", day: "2026-09-17", additions: 377, deletions: 18,
      files: ["src/settings/Usage.tsx", "src/api/usage.ts"],
      commits: ["Add usage endpoint for workspace admins", "Render usage page under settings"],
      summary: "Workspace admins get a usage page under settings that shows seats and dashboard counts.",
    },
  ],
  orphans: [{ day: "2026-09-22", message: "Tidy chart worker types", file: "src/charts/worker.ts", additions: 21, deletions: 30 }],
  versions: [
    `# Atlas dashboards stay responsive and admins can see workspace usage

Chart rendering now happens in a web worker, so big dashboards no longer freeze the page while they draw. Browsers without worker support fall back to the old path.

Workspace admins also have a usage page under settings with seat and dashboard counts.

## Timeline
- 2026-09-08: moved chart rendering to a web worker
- 2026-09-17: added the workspace usage page
- 2026-09-22: cleaned up worker types`,
  ],
});

await seedLog({
  repo: "acme/design-system",
  rangeStart: "2026-09-14",
  title: "Sprint 40",
  rangeEnd: "2026-10-04",
  prs: [
    {
      number: 57, title: "Add date range picker", state: "merged", day: "2026-09-16", additions: 498, deletions: 12,
      files: ["src/DateRangePicker/DateRangePicker.tsx", "src/DateRangePicker/presets.ts"],
      commits: ["Add date range picker with presets", "Support keyboard navigation in the calendar"],
      summary: "A shared date range picker with presets and keyboard navigation, now used by Atlas filters.",
    },
    {
      number: 60, title: "Ship dark theme tokens", state: "merged", day: "2026-09-29", additions: 213, deletions: 140,
      files: ["tokens/dark.json", "tokens/build.ts"],
      commits: ["Define dark theme color tokens", "Generate CSS variables for both themes"],
      summary: "Dark theme color tokens with generated CSS variables for both themes.",
    },
  ],
  orphans: [],
  versions: [
    `# A shared date range picker and dark theme tokens for the design system

The design system gained a date range picker with presets and full keyboard support, which Atlas now uses for its filters.

Dark theme tokens landed too, with CSS variables generated for both themes from one source.

## Timeline
- 2026-09-16: date range picker
- 2026-09-29: dark theme tokens`,
  ],
});

const rollup = await createRollup({
  title: "October 2026: billing, dashboards and offline notes",
  authorEmail: DEMO_EMAIL,
  rangeStart: "2026-09-28",
  rangeEnd: "2026-10-21",
  logIds: [atlas.id, billing.id, mobile.id],
});
await appendSummaryVersion({
  parentKind: "rollup",
  parentId: rollup.id,
  summaryMarkdown: `# Usage billing, faster dashboards and offline notes across three products

The largest piece of work this month was the start of usage-based billing. The billing API now meters calls per workspace, drafts invoices every night with proration, and retries invoice webhooks instead of dropping them.

In Atlas, saved dashboard views and a per-workspace query cache make returning to a dashboard quick. A daylight saving bug in weekly charts was fixed. PDF export is in review and has not shipped.

The mobile app gained offline editing for field notes, with a clear conflict banner when two edits collide.

## Timeline
- 2026-09-30: Atlas saved views
- 2026-10-02: API call metering
- 2026-10-06: Atlas chart query cache
- 2026-10-07: offline note edits on mobile
- 2026-10-08: nightly draft invoices
- 2026-10-12: mobile conflict banner
- 2026-10-14: webhook retries`,
  timeline: mergeTimelines([atlas, billing, mobile]),
  stats: sumStats([atlas, billing, mobile]),
  source: "generated",
  model: MODEL,
});

closeDb();
console.log(JSON.stringify({ logs: { atlas: atlas.id, billing: billing.id, mobile: mobile.id }, rollup: rollup.id }));
