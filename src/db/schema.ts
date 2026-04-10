import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

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
  provider: text("provider").notNull(), // "claude" | "codex"
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
});
