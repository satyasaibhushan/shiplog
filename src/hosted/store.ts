import type { PreparedReport } from "./report.ts";
export interface Statement {
  sql: string;
  params: unknown[];
}
export interface Database {
  query(statement: Statement): Promise<Record<string, unknown>[]>;
  transaction(statements: Statement[]): Promise<Record<string, unknown>[][]>;
}
export class Conflict extends Error {}
export class ReportStore {
  constructor(private db: Database) {}
  async list(owner: string) {
    return this.db.query({
      sql: "SELECT id,instance_id,scope_id,title,revision,updated_at FROM shiplog_hosted_reports WHERE owner_email=$1 AND revision>0 ORDER BY updated_at DESC LIMIT 200",
      params: [owner],
    });
  }
  async read(owner: string, id: string, revision?: number) {
    return this.db.query({
      sql: `SELECT r.id,r.title,r.instance_id,r.scope_id,r.revision AS active_revision,v.revision,v.payload,v.created_at,
    (SELECT jsonb_agg(history ORDER BY history.revision DESC) FROM
      (SELECT revision,created_at FROM shiplog_hosted_versions WHERE owner_email=$1 AND report_id=$2 ORDER BY revision DESC LIMIT 200) history) AS versions
   FROM shiplog_hosted_reports r JOIN shiplog_hosted_versions v ON v.owner_email=r.owner_email AND v.report_id=r.id
   WHERE r.owner_email=$1 AND r.id=$2 AND v.revision=COALESCE($3::integer,r.revision)`,
      params: [owner, id, revision ?? null],
    });
  }
  async save(owner: string, report: PreparedReport) {
    // The row-level UPDATE lock and revision predicate apply across processes and
    // cold starts. An old/slow request cannot activate over a newer revision.
    const result = await this.db.transaction([
      {
        sql: `INSERT INTO shiplog_hosted_reports(owner_email,id,instance_id,scope_id,title)
     SELECT $1,$2,$3,$4,$5 WHERE $6::integer=0 ON CONFLICT(owner_email,id) DO NOTHING`,
        params: [
          owner,
          report.id,
          report.instanceId,
          report.scopeId,
          report.title,
          report.expectedRevision,
        ],
      },
      {
        sql: `WITH changed AS (
     UPDATE shiplog_hosted_reports SET
      revision=CASE WHEN active_fingerprint=$3 THEN revision ELSE revision+1 END,
      active_fingerprint=$3,title=$4,
      updated_at=CASE WHEN active_fingerprint=$3 THEN updated_at ELSE now() END
     WHERE owner_email=$1 AND id=$2 AND (revision=$5 OR active_fingerprint=$3)
     RETURNING id,owner_email,revision,active_fingerprint
    ), saved AS (
     INSERT INTO shiplog_hosted_versions(owner_email,report_id,revision,fingerprint,payload)
     SELECT owner_email,id,revision,active_fingerprint,$6::jsonb FROM changed
     ON CONFLICT(owner_email,report_id,revision) DO NOTHING RETURNING revision
    ) SELECT id,revision FROM changed`,
        params: [
          owner,
          report.id,
          report.fingerprint,
          report.title,
          report.expectedRevision,
          JSON.stringify(report.payload),
        ],
      },
    ]);
    const row = result[1]?.[0];
    if (!row)
      throw new Conflict(
        "Report changed. Review its current version before retrying with that revision.",
      );
    return row;
  }
}
