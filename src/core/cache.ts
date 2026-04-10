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
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const dbPath = getDbPath();
  _sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read/write performance
  _sqlite.run("PRAGMA journal_mode = WAL");

  // Create tables if they don't exist
  _sqlite.run(`
    CREATE TABLE IF NOT EXISTS commits (
      sha TEXT PRIMARY KEY,
      patch_id TEXT,
      repo TEXT NOT NULL,
      message TEXT NOT NULL,
      author TEXT NOT NULL,
      date TEXT NOT NULL,
      diff TEXT,
      files TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  _sqlite.run(`
    CREATE TABLE IF NOT EXISTS dedup_index (
      patch_id TEXT PRIMARY KEY,
      commit_sha TEXT NOT NULL REFERENCES commits(sha)
    )
  `);

  _sqlite.run(`
    CREATE TABLE IF NOT EXISTS summaries (
      content_hash TEXT PRIMARY KEY,
      summary_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  _sqlite.run(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      merged_at TEXT,
      created_at TEXT NOT NULL,
      commit_shas TEXT
    )
  `);

  // Create indexes for common lookups
  _sqlite.run(`CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo)`);
  _sqlite.run(`CREATE INDEX IF NOT EXISTS idx_commits_patch_id ON commits(patch_id)`);
  _sqlite.run(`CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date)`);
  _sqlite.run(`CREATE INDEX IF NOT EXISTS idx_pr_repo ON pull_requests(repo)`);
  _sqlite.run(`CREATE INDEX IF NOT EXISTS idx_summaries_type ON summaries(summary_type)`);

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
