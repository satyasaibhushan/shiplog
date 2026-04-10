// SQLite caching layer
// TODO: Implement in Phase 2

import { getDbPath } from "../cli/config.ts";

export function getCacheDb() {
  const dbPath = getDbPath();
  // TODO: Initialize and return Drizzle DB instance
  return { path: dbPath };
}
