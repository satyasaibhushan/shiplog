import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getDbPath, getConfigDir } from "../cli/config.ts";
import { existsSync, mkdirSync } from "fs";
import * as schema from "../db/schema.ts";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database | null = null;

/**
 * Initialize the SQLite database and create tables if they don't exist.
 * Called once on startup — subsequent calls return the cached instance.
 */
export function initDb() {
  if (_db) return _db;

  const configDir = getConfigDir();
  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to create shiplog config directory at ${configDir}: ${msg}`,
    );
  }

  const dbPath = getDbPath();
  try {
    _sqlite = new Database(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to open shiplog cache database at ${dbPath}: ${msg}. ` +
        `Check filesystem permissions — the directory must be writable.`,
    );
  }

  // Init schema. Each step gets a descriptive error so a partial setup is
  // easy to diagnose (e.g. a read-only fs would surface here).
  const run = (label: string, sql: string) => {
    try {
      _sqlite!.run(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to initialize shiplog cache (${label}): ${msg}`);
    }
  };

  // ALTER TABLE ADD COLUMN has no IF NOT EXISTS form in SQLite; skip on duplicate.
  const addColumnIfMissing = (label: string, sql: string) => {
    try {
      _sqlite!.run(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) {
        throw new Error(`Failed to initialize shiplog cache (${label}): ${msg}`);
      }
    }
  };

  run("journal_mode", "PRAGMA journal_mode = WAL");

  run(
    "commits table",
    `CREATE TABLE IF NOT EXISTS commits (
      sha TEXT PRIMARY KEY,
      patch_id TEXT,
      repo TEXT NOT NULL,
      message TEXT NOT NULL,
      author TEXT NOT NULL,
      date TEXT NOT NULL,
      diff TEXT,
      files TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )`,
  );

  run(
    "dedup_index table",
    `CREATE TABLE IF NOT EXISTS dedup_index (
      patch_id TEXT PRIMARY KEY,
      commit_sha TEXT NOT NULL REFERENCES commits(sha)
    )`,
  );

  run(
    "summaries table",
    `CREATE TABLE IF NOT EXISTS summaries (
      content_hash TEXT PRIMARY KEY,
      summary_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )`,
  );

  run(
    "pull_requests table",
    `CREATE TABLE IF NOT EXISTS pull_requests (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      merged_at TEXT,
      created_at TEXT NOT NULL,
      commit_shas TEXT
    )`,
  );

  // Retained per-file stats column. Older caches lack this column, so we add it
  // idempotently rather than forcing a schema reset.
  addColumnIfMissing(
    "commits.stats_json",
    `ALTER TABLE commits ADD COLUMN stats_json TEXT`,
  );
  addColumnIfMissing(
    "commits.is_merge",
    `ALTER TABLE commits ADD COLUMN is_merge INTEGER NOT NULL DEFAULT 0`,
  );
  addColumnIfMissing(
    "pull_requests.additions",
    `ALTER TABLE pull_requests ADD COLUMN additions INTEGER`,
  );
  addColumnIfMissing(
    "pull_requests.deletions",
    `ALTER TABLE pull_requests ADD COLUMN deletions INTEGER`,
  );
  addColumnIfMissing(
    "pull_requests.changed_files",
    `ALTER TABLE pull_requests ADD COLUMN changed_files INTEGER`,
  );
  addColumnIfMissing(
    "pull_requests.opened_by_other",
    `ALTER TABLE pull_requests ADD COLUMN opened_by_other INTEGER NOT NULL DEFAULT 0`,
  );

  run(
    "logs table",
    `CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      author_email TEXT NOT NULL,
      range_start TEXT NOT NULL,
      range_end TEXT NOT NULL,
      title TEXT,
      active_version_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );

  run(
    "rollups table",
    `CREATE TABLE IF NOT EXISTS rollups (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author_email TEXT NOT NULL,
      range_start TEXT NOT NULL,
      range_end TEXT NOT NULL,
      log_ids_json TEXT NOT NULL,
      active_version_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );

  run(
    "summary_versions table",
    `CREATE TABLE IF NOT EXISTS summary_versions (
      id TEXT PRIMARY KEY,
      parent_kind TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      summary_markdown TEXT NOT NULL,
      timeline_json TEXT,
      stats_json TEXT,
      source TEXT NOT NULL,
      chat_prompt_json TEXT,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );

  run(
    "stale_markers table",
    `CREATE TABLE IF NOT EXISTS stale_markers (
      parent_kind TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      PRIMARY KEY(parent_kind, parent_id)
    )`,
  );

  run(
    "summary_deps table",
    `CREATE TABLE IF NOT EXISTS summary_deps (
      parent_kind TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      child_kind TEXT NOT NULL,
      child_id TEXT NOT NULL,
      PRIMARY KEY(parent_kind, parent_id, child_kind, child_id)
    )`,
  );

  run("idx_commits_repo", `CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo)`);
  run("idx_commits_patch_id", `CREATE INDEX IF NOT EXISTS idx_commits_patch_id ON commits(patch_id)`);
  run("idx_commits_date", `CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date)`);
  run("idx_pr_repo", `CREATE INDEX IF NOT EXISTS idx_pr_repo ON pull_requests(repo)`);
  run("idx_summaries_type", `CREATE INDEX IF NOT EXISTS idx_summaries_type ON summaries(summary_type)`);
  run("idx_logs_owner_repo", `CREATE INDEX IF NOT EXISTS idx_logs_owner_repo ON logs(owner, repo)`);
  run("idx_logs_range", `CREATE INDEX IF NOT EXISTS idx_logs_range ON logs(range_start, range_end)`);
  run(
    "idx_summary_versions_parent",
    `CREATE INDEX IF NOT EXISTS idx_summary_versions_parent ON summary_versions(parent_kind, parent_id, version_number)`,
  );
  run(
    "idx_summary_deps_child",
    `CREATE INDEX IF NOT EXISTS idx_summary_deps_child ON summary_deps(child_kind, child_id)`,
  );

  _db = drizzle(_sqlite, { schema });
  return _db;
}

/**
 * Get the Drizzle DB instance. Throws if not initialized.
 */
export function getDb() {
  if (!_db) {
    return initDb();
  }
  return _db;
}

/**
 * Close the database connection. Call on shutdown.
 */
export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
