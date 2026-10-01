-- Separate reporting projection; never a replacement Task Finder task store.
-- Apply explicitly to the reviewed database before deploying. No startup DDL.
CREATE TABLE IF NOT EXISTS shiplog_hosted_reports (
 owner_email text NOT NULL, id text NOT NULL, instance_id text NOT NULL,
 scope_id text NOT NULL, title text NOT NULL, revision integer NOT NULL DEFAULT 0,
 active_fingerprint text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_email,id)
);
CREATE TABLE IF NOT EXISTS shiplog_hosted_versions (
 owner_email text NOT NULL, report_id text NOT NULL, revision integer NOT NULL,
 fingerprint text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_email,report_id,revision),
 FOREIGN KEY(owner_email,report_id) REFERENCES shiplog_hosted_reports(owner_email,id)
);
