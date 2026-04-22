import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

// Layer 1: Commit Cache (raw GitHub data)
export const commits = sqliteTable("commits", {
  sha: text("sha").primaryKey(),
  patchId: text("patch_id"),
  repo: text("repo").notNull(),
  message: text("message").notNull(),
  author: text("author").notNull(),
  date: text("date").notNull(),
  diff: text("diff"),
  files: text("files"), // JSON array of file paths
  statsJson: text("stats_json"), // JSON: { additions, deletions, files, truncated, perFile: [{filename,add,del,status}] }
  // 1 when the commit has ≥2 parents (merge commit). Merges are excluded from
  // all diff-size aggregations so backmerges don't inflate PR/log totals.
  isMerge: integer("is_merge").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Dedup index
export const dedupIndex = sqliteTable("dedup_index", {
  patchId: text("patch_id").primaryKey(),
  commitSha: text("commit_sha")
    .notNull()
    .references(() => commits.sha),
});

// Layer 2: Summary Cache (LLM output)
export const summaries = sqliteTable("summaries", {
  contentHash: text("content_hash").primaryKey(),
  summaryType: text("summary_type").notNull(), // "pr" | "orphan" | "rollup"
  summary: text("summary").notNull(),
  provider: text("provider").notNull(), // "claude" | "codex" | "cursor"
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Pull request metadata
export const pullRequests = sqliteTable("pull_requests", {
  id: text("id").primaryKey(), // "owner/repo:number"
  repo: text("repo").notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  state: text("state").notNull(), // "merged" | "open" | "closed"
  mergedAt: text("merged_at"),
  createdAt: text("created_at").notNull(),
  commitShas: text("commit_shas"), // JSON array
  // PR-level size from GitHub (base...head compare). Matches what the PR
  // page shows, which excludes files brought in by backmerge commits.
  additions: integer("additions"),
  deletions: integer("deletions"),
  changedFiles: integer("changed_files"),
  // 1 when the PR was opened by someone else but contains user's commits
  // (discovered via orphan-commit resolution). The UI shows a distinct pill.
  openedByOther: integer("opened_by_other").notNull().default(0),
});

// Layer 3: Persistent log entity — a saved summary over a repo + date range.
export const logs = sqliteTable("logs", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  authorEmail: text("author_email").notNull(),
  rangeStart: text("range_start").notNull(),
  rangeEnd: text("range_end").notNull(),
  title: text("title"),
  activeVersionId: text("active_version_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Cross-repo rollup entity — references a set of logs.
export const rollups = sqliteTable("rollups", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorEmail: text("author_email").notNull(),
  rangeStart: text("range_start").notNull(),
  rangeEnd: text("range_end").notNull(),
  logIdsJson: text("log_ids_json").notNull(),
  activeVersionId: text("active_version_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Versioned history of every summary — generated or chat-edited.
export const summaryVersions = sqliteTable("summary_versions", {
  id: text("id").primaryKey(),
  parentKind: text("parent_kind").notNull(), // 'log' | 'rollup' | 'pr' | 'orphan'
  parentId: text("parent_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  summaryMarkdown: text("summary_markdown").notNull(),
  timelineJson: text("timeline_json"), // JSON: Array<{date,additions,deletions,prCount,commitCount,topPRTitles:string[]}>
  statsJson: text("stats_json"), // JSON: {additions, deletions, files, commits, prs}
  source: text("source").notNull(), // 'generated' | 'chat'
  chatPromptJson: text("chat_prompt_json"),
  model: text("model").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Staleness signal — machine-local, NOT synced via git-sync.
export const staleMarkers = sqliteTable(
  "stale_markers",
  {
    parentKind: text("parent_kind").notNull(),
    parentId: text("parent_id").notNull(),
    reason: text("reason").notNull(), // 'upstream_changed' | 'dep_regenerated'
    detectedAt: integer("detected_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.parentKind, t.parentId] }),
  }),
);

// Parent → child dependency edges for staleness propagation.
export const summaryDeps = sqliteTable(
  "summary_deps",
  {
    parentKind: text("parent_kind").notNull(),
    parentId: text("parent_id").notNull(),
    childKind: text("child_kind").notNull(),
    childId: text("child_id").notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.parentKind, t.parentId, t.childKind, t.childId],
    }),
  }),
);
