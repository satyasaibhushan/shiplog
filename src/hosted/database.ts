import { neon } from "@neondatabase/serverless";
import { ReportStore, type Database } from "./store.ts";
export function productionStore() {
  const url = process.env.SHIPLOG_DATABASE_URL;
  if (!url) throw new Error("Hosted database is not configured");
  const sql = neon(url);
  const db: Database = {
    query: async (q) => (await sql.query(q.sql, q.params)) as Record<string, unknown>[],
    transaction: async (qs) =>
      (await sql.transaction(qs.map((q) => sql.query(q.sql, q.params)))) as Record<
        string,
        unknown
      >[][],
  };
  return new ReportStore(db);
}
