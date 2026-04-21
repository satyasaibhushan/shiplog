// New log modal — range chips, repo multi-select, overlap notice, 3×2 model grid.

import { useMemo, useState } from "react";
import type { DisplayRepo } from "../atlasModel.ts";
import type { GenerationProgress } from "../types.ts";
import {
  FONT_MONO,
  FONT_SANS,
  fmtRange,
  type Theme,
} from "../theme.ts";
import { CustomDateRange, Dot } from "./primitives.tsx";
import { GenerationStepper } from "./GenerationStepper.tsx";

interface NewLogModalProps {
  t: Theme;
  repos: DisplayRepo[];
  defaultRepoIds?: string[];
  defaultRange?: [string, string];
  onClose: () => void;
  onCreated: (logId: string) => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const RANGES: Array<[string, string, () => [string, string]]> = [
  ["thisweek", "This week", () => [daysAgo(6), today()]],
  ["lastweek", "Last week", () => [daysAgo(13), daysAgo(7)]],
  ["last30", "Last 30d", () => [daysAgo(29), today()]],
  ["month", "This month", () => {
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), 1)
      .toISOString()
      .slice(0, 10);
    return [start, today()];
  }],
  ["q1", "Q1 2026", () => ["2026-01-01", "2026-03-31"]],
];

const MODELS: Array<{
  id: string;
  label: string;
  subtitle: string;
  vendor: string;
  provider: "claude" | "codex";
  model: string;
}> = [
  {
    id: "claude-haiku",
    label: "Haiku 4.5",
    subtitle: "fast · lightweight",
    vendor: "Claude",
    provider: "claude",
    model: "haiku",
  },
  {
    id: "claude-sonnet",
    label: "Sonnet 4.6",
    subtitle: "balanced default",
    vendor: "Claude",
    provider: "claude",
    model: "sonnet",
  },
  {
    id: "claude-opus",
    label: "Opus 4.7",
    subtitle: "deepest reasoning",
    vendor: "Claude",
    provider: "claude",
    model: "opus",
  },
  {
    id: "codex-mini",
    label: "Codex Mini",
    subtitle: "fast code edits",
    vendor: "Codex",
    provider: "codex",
    model: "gpt-5-mini",
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    subtitle: "general narrative",
    vendor: "Codex",
    provider: "codex",
    model: "gpt-5",
  },
  {
    id: "gpt-5-pro",
    label: "GPT-5 Pro",
    subtitle: "high fidelity",
    vendor: "Codex",
    provider: "codex",
    model: "gpt-5-pro",
  },
];

export function NewLogModal({
  t,
  repos,
  defaultRepoIds,
  defaultRange,
  onClose,
  onCreated,
}: NewLogModalProps) {
  const initialIds =
    defaultRepoIds && defaultRepoIds.length
      ? defaultRepoIds
      : repos[0]
        ? [repos[0].id]
        : [];

  const [selectedIds, setSelectedIds] = useState<string[]>(initialIds);
  // When the modal is opened from a repo page (defaultRepoIds provided),
  // start with the selector collapsed — the user has already picked.
  const preselectedFromContext =
    !!defaultRepoIds && defaultRepoIds.length > 0;
  const [repoPickerOpen, setRepoPickerOpen] = useState(
    !preselectedFromContext,
  );
  const [repoSearch, setRepoSearch] = useState("");
  const [orgFilter, setOrgFilter] = useState<string>("all");
  const [rangeKey, setRangeKey] = useState<string>(
    defaultRange ? "custom" : "thisweek",
  );
  const [rangeValue, setRangeValue] = useState<[string, string]>(
    defaultRange ?? (RANGES[0]![2]() as [string, string]),
  );
  const [customOpen, setCustomOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(rangeValue[0]);
  const [customTo, setCustomTo] = useState(rangeValue[1]);
  const [modelId, setModelId] = useState("claude-sonnet");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [rFrom, rTo] = rangeValue;

  const orgs = useMemo(() => {
    const set = new Set<string>();
    for (const r of repos) set.add(r.org);
    return Array.from(set).sort();
  }, [repos]);

  const filteredRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    return repos.filter((r) => {
      if (orgFilter !== "all" && r.org !== orgFilter) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [repos, repoSearch, orgFilter]);

  const selectedRepoNames = useMemo(
    () =>
      selectedIds
        .map((id) => repos.find((r) => r.id === id)?.name ?? id)
        .filter(Boolean),
    [selectedIds, repos],
  );

  const overlaps = useMemo(() => {
    const out: { repo: string; label: string }[] = [];
    for (const id of selectedIds) {
      const r = repos.find((x) => x.id === id);
      if (!r) continue;
      for (const log of r.logs) {
        if (log.range[1] >= rFrom && log.range[0] <= rTo)
          out.push({ repo: r.name, label: log.label });
      }
    }
    return out;
  }, [selectedIds, repos, rFrom, rTo]);

  const toggleRepo = (id: string) =>
    setSelectedIds((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );

  const pickPreset = (key: string, value: [string, string]) => {
    setRangeKey(key);
    setRangeValue(value);
    setCustomOpen(false);
  };

  const canSubmit =
    selectedIds.length > 0 && rFrom && rTo && !submitting && repos.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setProgress(null);

    const model = MODELS.find((m) => m.id === modelId) ?? MODELS[1]!;

    try {
      // Create a log per selected repo sequentially; report the first created id.
      let firstId: string | null = null;
      for (const id of selectedIds) {
        const repo = repos.find((r) => r.id === id);
        if (!repo) continue;
        const res = await fetch("/api/logs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            owner: repo.owner,
            repo: repo.short,
            rangeStart: rFrom,
            rangeEnd: rTo,
            provider: model.provider,
            model: model.model,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let createdId: string | null = null;
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            if (!part.trim()) continue;
            let event = "message";
            let data = "";
            for (const line of part.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7).trim();
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (!data) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            if (event === "progress") {
              setProgress(parsed as GenerationProgress);
            } else if (event === "complete") {
              const body = parsed as { log?: { id?: string } };
              createdId = body.log?.id ?? null;
              break outer;
            } else if (event === "error") {
              throw new Error(
                (parsed as { error?: string }).error ?? "Failed",
              );
            }
          }
        }
        if (!createdId)
          throw new Error(`Log for ${repo.name} did not complete`);
        firstId ??= createdId;
      }
      if (!firstId) throw new Error("No logs were created");
      onCreated(firstId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create log");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: t.overlay,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 620,
          maxHeight: "90vh",
          overflow: "auto",
          background: t.bg,
          border: `1px solid ${t.borderStrong}`,
          borderRadius: 8,
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div
          style={{
            padding: "16px 22px",
            borderBottom: `1px solid ${t.border}`,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: t.text }}>
              Compile a new log
            </div>
            <div
              style={{
                fontSize: 11,
                color: t.textFaint,
                marginTop: 2,
                fontFamily: FONT_MONO,
              }}
            >
              Pick repo(s) and a range.
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <span
            onClick={onClose}
            style={{
              cursor: "pointer",
              color: t.textFaint,
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </span>
        </div>

        <div
          style={{
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          {/* Range */}
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                color: t.textFaint,
                letterSpacing: 1.5,
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Range
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {RANGES.map(([k, label, fn]) => {
                const selected = rangeKey === k;
                return (
                  <button
                    key={k}
                    onClick={() => pickPreset(k, fn())}
                    style={{
                      padding: "5px 11px",
                      fontSize: 11,
                      fontFamily: FONT_MONO,
                      background: selected ? t.accent : t.surface,
                      color: selected ? t.accentInk : t.textDim,
                      border: `1px solid ${selected ? t.accent : t.border}`,
                      borderRadius: 3,
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
              <button
                onClick={() => setCustomOpen((v) => !v)}
                style={{
                  padding: "5px 11px",
                  fontSize: 11,
                  fontFamily: FONT_MONO,
                  background: rangeKey === "custom" ? t.accent : t.surface,
                  color: rangeKey === "custom" ? t.accentInk : t.textDim,
                  border: `1px solid ${
                    customOpen || rangeKey === "custom" ? t.accent : t.border
                  }`,
                  borderRadius: 3,
                  cursor: "pointer",
                }}
              >
                Custom…
              </button>
            </div>
            {customOpen && (
              <div
                style={{
                  marginTop: 8,
                  border: `1px solid ${t.border}`,
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <CustomDateRange
                  t={t}
                  from={customFrom}
                  to={customTo}
                  onChange={(f, tt) => {
                    setCustomFrom(f);
                    setCustomTo(tt);
                  }}
                  onCancel={() => setCustomOpen(false)}
                  onApply={() => {
                    setRangeKey("custom");
                    setRangeValue([customFrom, customTo]);
                    setCustomOpen(false);
                  }}
                />
              </div>
            )}
          </div>

          {/* Repos */}
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  color: t.textFaint,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                }}
              >
                Repos · {selectedIds.length}
              </div>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => setRepoPickerOpen((v) => !v)}
                style={{
                  padding: "2px 8px",
                  fontSize: 10,
                  fontFamily: FONT_MONO,
                  background: "transparent",
                  color: t.textDim,
                  border: `1px solid ${t.border}`,
                  borderRadius: 3,
                  cursor: "pointer",
                  letterSpacing: 1,
                  textTransform: "uppercase",
                }}
              >
                {repoPickerOpen ? "Collapse" : "Change"}
              </button>
            </div>

            {!repoPickerOpen ? (
              <div
                onClick={() => setRepoPickerOpen(true)}
                style={{
                  padding: "10px 12px",
                  border: `1px solid ${t.border}`,
                  borderRadius: 3,
                  background: t.surface,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {selectedIds.length === 0 ? (
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      color: t.textFaint,
                      fontStyle: "italic",
                    }}
                  >
                    No repo selected — click to pick.
                  </span>
                ) : (
                  selectedRepoNames.map((name) => {
                    const r = repos.find((x) => x.name === name);
                    return (
                      <span
                        key={name}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "3px 8px",
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          color: t.text,
                          background: t.surface2,
                          borderRadius: 3,
                        }}
                      >
                        {r && <Dot color={r.langColor} size={6} />}
                        {name}
                      </span>
                    );
                  })
                )}
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginBottom: 6,
                  }}
                >
                  <input
                    type="text"
                    placeholder="Search repos…"
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "6px 10px",
                      fontSize: 12,
                      fontFamily: FONT_MONO,
                      background: t.surface,
                      color: t.text,
                      border: `1px solid ${t.border}`,
                      borderRadius: 3,
                      outline: "none",
                    }}
                  />
                  <select
                    value={orgFilter}
                    onChange={(e) => setOrgFilter(e.target.value)}
                    style={{
                      padding: "6px 10px",
                      fontSize: 12,
                      fontFamily: FONT_MONO,
                      background: t.surface,
                      color: t.text,
                      border: `1px solid ${t.border}`,
                      borderRadius: 3,
                      outline: "none",
                      cursor: "pointer",
                    }}
                  >
                    <option value="all">All orgs</option>
                    {orgs.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    maxHeight: 180,
                    overflow: "auto",
                    border: `1px solid ${t.border}`,
                    borderRadius: 3,
                  }}
                >
                  {filteredRepos.length === 0 && (
                    <div
                      style={{
                        padding: "12px 14px",
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                        color: t.textFaint,
                        fontStyle: "italic",
                      }}
                    >
                      {repos.length === 0
                        ? "No repos available."
                        : "No repos match your filters."}
                    </div>
                  )}
                  {filteredRepos.map((r, i) => (
                    <label
                      key={r.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "7px 11px",
                        cursor: "pointer",
                        background: selectedIds.includes(r.id)
                          ? t.surface2
                          : "transparent",
                        borderTop:
                          i === 0 ? "none" : `1px solid ${t.border}`,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(r.id)}
                        onChange={() => toggleRepo(r.id)}
                        style={{ accentColor: t.accent }}
                      />
                      <Dot color={r.langColor} size={6} />
                      <span
                        style={{
                          fontSize: 12,
                          color: t.text,
                          fontFamily: FONT_MONO,
                        }}
                      >
                        {r.name}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span
                        style={{
                          fontSize: 10,
                          color: t.textFaint,
                          fontFamily: FONT_MONO,
                        }}
                      >
                        {r.logs.length} logs
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Overlap notice */}
          {overlaps.length > 0 && (
            <div
              style={{
                padding: "11px 14px",
                background: t.surface2,
                borderRadius: 4,
                borderLeft: `3px solid ${t.accent}`,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: t.text,
                  fontWeight: 500,
                  marginBottom: 4,
                }}
              >
                ◇ {overlaps.length} existing log
                {overlaps.length !== 1 ? "s" : ""} cover part of this range
              </div>
              <div
                style={{ fontSize: 11, color: t.textDim, lineHeight: 1.55 }}
              >
                We'll reuse cached summaries for the overlap and only call the
                LLM for the uncovered slice.{" "}
                <span style={{ color: t.accent }}>
                  ~40s &amp; 18k tokens saved.
                </span>
              </div>
            </div>
          )}

          {/* Model grid */}
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                color: t.textFaint,
                letterSpacing: 1.5,
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Model
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
              }}
            >
              {MODELS.map((m) => {
                const selected = modelId === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setModelId(m.id)}
                    style={{
                      padding: "9px 10px",
                      fontSize: 11,
                      textAlign: "left",
                      cursor: "pointer",
                      background: selected ? t.surface2 : t.surface,
                      border: `1px solid ${selected ? t.accent : t.border}`,
                      borderRadius: 3,
                      color: t.text,
                      fontFamily: FONT_MONO,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        marginBottom: 3,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 9,
                          color: t.textFaint,
                          textTransform: "uppercase",
                          letterSpacing: 1,
                        }}
                      >
                        {m.vendor}
                      </span>
                    </div>
                    <div style={{ color: t.text, fontWeight: 500 }}>
                      {m.label}
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        color: t.textFaint,
                        marginTop: 2,
                      }}
                    >
                      {m.subtitle}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {progress && (
            <div style={{ paddingTop: 4 }}>
              <GenerationStepper t={t} progress={progress} />
            </div>
          )}

          {error && (
            <div
              style={{
                padding: "10px 12px",
                background: "rgba(248,113,113,0.10)",
                border: `1px solid ${t.closed}33`,
                color: t.closed,
                borderRadius: 3,
                fontSize: 12,
                fontFamily: FONT_MONO,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "12px 22px",
            borderTop: `1px solid ${t.border}`,
            background: t.surface,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              color: t.textFaint,
            }}
          >
            {selectedIds.length} repo{selectedIds.length !== 1 ? "s" : ""} ·{" "}
            {fmtRange([rFrom, rTo])}
          </div>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: "6px 12px",
              background: "transparent",
              color: t.textDim,
              border: `1px solid ${t.border}`,
              borderRadius: 3,
              fontSize: 12,
              cursor: submitting ? "default" : "pointer",
              fontFamily: FONT_SANS,
              opacity: submitting ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!canSubmit}
            style={{
              padding: "6px 14px",
              background: canSubmit ? t.accent : t.surface2,
              color: canSubmit ? t.accentInk : t.textFaint,
              border: "none",
              borderRadius: 3,
              fontSize: 12,
              fontWeight: 600,
              cursor: canSubmit ? "pointer" : "default",
              fontFamily: FONT_SANS,
            }}
          >
            {submitting ? "Compiling…" : "Compile log →"}
          </button>
        </div>
      </div>
    </div>
  );
}
