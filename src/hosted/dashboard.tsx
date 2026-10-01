"use client";
import { useEffect, useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import {
  TaskFinderSnapshotSchema,
  snapshotScopeName,
  type TaskFinderSnapshot,
} from "../core/taskfinder-snapshot";
type Row = {
  id: string;
  title: string;
  scope_id: string;
  instance_id: string;
  revision: number;
  updated_at: string;
};
type Detail = {
  id: string;
  title: string;
  revision: number;
  active_revision: number;
  versions: Array<{ revision: number; created_at: string }>;
  payload: {
    snapshot: TaskFinderSnapshot;
    window: { timezone: string };
    sections: Array<{ projectId: string | null; markdown: string }>;
  };
};
async function read<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw Error("Unable to load reports. Check access and database configuration.");
  return r.json();
}
export function HostedDashboard({ timezone, date }: { timezone: string; date: string }) {
  const [rows, setRows] = useState<Row[]>();
  const [detail, setDetail] = useState<Detail>();
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (detail) {
      detailRef.current?.focus();
      detailRef.current?.scrollIntoView({ block: "start" });
    }
  }, [detail]);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<TaskFinderSnapshot>();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ id: string; revision: number; target: string }>();
  const [conflict, setConflict] = useState<{ id: string; target: string }>();
  const readSequence = useRef(0);
  const [kind, setKind] = useState("daily");
  const [day, setDay] = useState(date);
  const [zone, setZone] = useState(timezone);
  const [week, setWeek] = useState(1);
  const target = JSON.stringify([
    snapshot?.source.instanceId,
    snapshot?.source.scopeId,
    kind,
    day,
    zone,
    week,
  ]);
  const canReview =
    conflict?.target === target &&
    detail?.id === conflict?.id &&
    detail?.revision === detail?.active_revision;
  const acknowledged =
    canReview &&
    review?.target === target &&
    review?.id === detail?.id &&
    review?.revision === detail?.active_revision;
  function resetReview() {
    setReview(undefined);
    setConflict(undefined);
  }
  async function reload() {
    setRows(await read<Row[]>("/api/reports"));
  }
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
  }, []);
  async function open(id: string, version?: number) {
    const sequence = ++readSequence.current;
    setReview(undefined);
    setDetail(undefined);
    setError("");
    try {
      const results = await read<Detail[]>(
        `/api/reports/${id}${version ? `?revision=${version}` : ""}`,
      );
      if (sequence === readSequence.current) setDetail(results[0]);
    } catch (e) {
      setError(String(e));
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!snapshot || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          snapshot,
          kind,
          date: day,
          timezone: zone,
          weekStartsOn: week,
          expectedRevision: acknowledged ? review!.revision : 0,
          ...(acknowledged ? { reviewedReportId: review!.id } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          setReview(undefined);
          setConflict({ id: result.id, target });
        }
        throw Error(result.error ?? "Import failed");
      }
      setConflict(undefined);
      resetReview();
      await reload();
      await open(result.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header>
        <h1>Reports</h1>
        <p>Private project reports from reviewed Task Finder snapshots.</p>
      </header>
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Import a reviewed snapshot</summary>
        <p>
          This saves a reporting copy. It does not accept tasks, run agents or contact source
          systems.
        </p>
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>Snapshot and calendar</legend>
            <label>
              Snapshot JSON
              <input
                type="file"
                accept=".json,application/json"
                onChange={async (e) => {
                  setError("");
                  setSnapshot(undefined);
                  resetReview();
                  setConflict(undefined);
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    if (file.size > 1024 * 1024) throw Error();
                    setSnapshot(TaskFinderSnapshotSchema.parse(JSON.parse(await file.text())));
                  } catch {
                    setError("Use a valid Task Finder snapshot under 1 MiB.");
                  }
                }}
              />
            </label>
            {snapshot && (
              <p role="status">
                Source {snapshot.source.instanceId} · Scope {snapshotScopeName(snapshot)} ·{" "}
                {snapshot.projects.length} projects · {snapshot.tasks.length} tasks · captured{" "}
                {snapshot.source.capturedAt}
              </p>
            )}
            <div className="controls">
              <label>
                Period
                <select
                  aria-label="Period"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    resetReview();
                  }}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Calendar date
                <input
                  required
                  type="date"
                  value={day}
                  onChange={(e) => {
                    setDay(e.target.value);
                    resetReview();
                  }}
                />
              </label>
              <label>
                IANA timezone
                <input
                  required
                  value={zone}
                  onChange={(e) => {
                    setZone(e.target.value);
                    resetReview();
                  }}
                />
              </label>
              <label>
                Week starts
                <select
                  aria-label="Week starts"
                  value={week}
                  onChange={(e) => {
                    setWeek(Number(e.target.value));
                    resetReview();
                  }}
                >
                  {[
                    "Sunday",
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                  ].map((name, i) => (
                    <option value={i} key={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button disabled={!snapshot || busy}>{busy ? "Saving…" : "Save report"}</button>
            {conflict && (
              <p>
                The saved report changed.{" "}
                <button type="button" onClick={() => void open(conflict.id)}>
                  Review current report
                </button>
              </p>
            )}
            {canReview && detail && (
              <label>
                <input
                  type="checkbox"
                  checked={!!acknowledged}
                  onChange={(e) =>
                    setReview(
                      e.target.checked
                        ? { id: detail.id, revision: detail.revision, target }
                        : undefined,
                    )
                  }
                />
                I reviewed revision {detail.active_revision}; append this snapshot as a new version.
              </label>
            )}
          </fieldset>
        </form>
      </details>
      <section aria-label="Saved reports">
        <h2>Saved reports</h2>
        {!rows ? (
          <p role="status">Loading reports…</p>
        ) : rows.length === 0 ? (
          <p>No reports saved. Import a reviewed snapshot to begin.</p>
        ) : (
          <ul className="reports">
            {rows.map((row) => (
              <li key={row.id}>
                <button onClick={() => void open(row.id)}>{row.title}</button>
                <small>
                  Revision {row.revision} · {row.updated_at}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
      {detail && (
        <section ref={detailRef} tabIndex={-1} aria-label="Report detail">
          <h2>{detail.title}</h2>
          <label>
            Saved version
            <select
              aria-label="Saved version"
              value={detail.revision}
              onChange={(e) => void open(detail.id, Number(e.target.value))}
            >
              {detail.versions.map((v) => (
                <option key={v.revision} value={v.revision}>
                  Revision {v.revision}
                  {v.revision === detail.active_revision ? " · current" : ""} · {v.created_at}
                </option>
              ))}
            </select>
          </label>
          <p>
            Scope {snapshotScopeName(detail.payload.snapshot)} · {detail.payload.window.timezone}.
            Snapshot evidence is not live verification.
          </p>
          {detail.payload.sections.map((section, i) => (
            <article key={section.projectId ?? i}>
              <ReactMarkdown
                components={{
                  a: ({ children, href }) => (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {section.markdown}
              </ReactMarkdown>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
