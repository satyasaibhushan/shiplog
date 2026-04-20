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

  run("idx_commits_repo", `CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo)`);
  run("idx_commits_patch_id", `CREATE INDEX IF NOT EXISTS idx_commits_patch_id ON commits(patch_id)`);
  run("idx_commits_date", `CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date)`);
  run("idx_pr_repo", `CREATE INDEX IF NOT EXISTS idx_pr_repo ON pull_requests(repo)`);
  run("idx_summaries_type", `CREATE INDEX IF NOT EXISTS idx_summaries_type ON summaries(summary_type)`);

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
