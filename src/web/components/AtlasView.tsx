// Atlas home view — Repos tab + Rollups tab with search, pagination,
// Recent Logs section, and multi-select rollup-creation bar.

import { useMemo, useState } from "react";
import type { DisplayLog, DisplayOrg, DisplayRepo } from "../atlasModel.ts";
import type { AtlasView as ViewRoute, RollupRecord } from "../types.ts";
import {
  FONT_MONO,
  fmtRange,
  fmtRelative,
  type Theme,
} from "../theme.ts";
import { DiffStat, Dot } from "./primitives.tsx";
import { RepoCard } from "./RepoCard.tsx";

const ATLAS_PAGE_SIZE = 6;
const ROLLUP_PAGE_SIZE = 6;

interface AtlasViewProps {
  t: Theme;
  repos: DisplayRepo[];
  orgs: DisplayOrg[];
  rollups: RollupRecord[];
  currentOrg: DisplayOrg | null;
  currentRepo: DisplayRepo | null;
  rangeFilter: string;
  tab: "repos" | "rollups";
  setTab: (tab: "repos" | "rollups") => void;
  selected: string[];
  setSelected: (next: string[]) => void;
  openNewLog: (preselect?: string[]) => void;
  navigate: (v: ViewRoute) => void;
}

interface Visible {
  logs: number;
  prs: number;
  commits: number;
  filtered: boolean;
}

function applyRangeFilter(repo: DisplayRepo, filter: string): Visible {
  if (filter === "All time") {
    const prs = repo.logs.reduce((a, l) => a + (l.prs || 0), 0);
    const commits = repo.logs.reduce((a, l) => a + (l.commits || 0), 0);
    return { logs: repo.logs.length, prs, commits, filtered: false };
  }
  const days =
    filter === "Last 7 days"
      ? 7
      : filter === "Last 30 days"
        ? 30
        : filter === "This quarter"
          ? 90
          : filter === "This year"
            ? 365
            : 99999;
  const cutoff = Date.now() - days * 86400000;
  const visibleLogs = repo.logs.filter(
    (l) => new Date(l.range[1]).getTime() >= cutoff,
  );
  const prs = visibleLogs.reduce((a, l) => a + (l.prs || 0), 0);
  const commits = visibleLogs.reduce((a, l) => a + (l.commits || 0), 0);
  return { logs: visibleLogs.length, prs, commits, filtered: true };
}

function pushScore(lastPush: string): number {
  const m = /^(\d+)([hd])/.exec(lastPush || "");
  if (!m) return 99999;
  const n = Number(m[1]);
  return m[2] === "h" ? n : n * 24;
}

function SearchField({
  t,
  value,
  onChange,
  placeholder,
  width = 240,
}: {
  t: Theme;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  width?: number;
}) {
  return (
    <div style={{ position: "relative", width }}>
      <span
        style={{
          position: "absolute",
          left: 8,
          top: "50%",
          transform: "translateY(-50%)",
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: t.textFaint,
        }}
      >
        ⌕
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: 4,
          padding: "6px 8px 6px 24px",
          fontSize: 12,
          color: t.text,
          fontFamily: FONT_MONO,
          outline: "none",
        }}
      />
      {value && (
        <span
          onClick={() => onChange("")}
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            color: t.textFaint,
            fontFamily: FONT_MONO,
            fontSize: 12,
            cursor: "pointer",
            padding: "0 4px",
          }}
        >
          ×
        </span>
      )}
    </div>
  );
}

function RepoMiniRow({
  t,
  repo,
  visible,
  onClick,
}: {
  t: Theme;
  repo: DisplayRepo;
  visible: Visible;
  onClick: () => void;
}) {
  const totalAdd = repo.logs.reduce((a, l) => a + (l.add || 0), 0);
  const totalRem = repo.logs.reduce((a, l) => a + (l.rem || 0), 0);
  return (
    <div
      onClick={onClick}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLDivElement).style.background = t.surface)
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLDivElement).style.background = "transparent")
      }
      style={{
        padding: "8px 12px",
        background: "transparent",
        borderTop: `1px solid ${t.border}`,
        display: "grid",
        gridTemplateColumns:
          "18px minmax(120px, 1.4fr) minmax(100px, 1fr) 90px 90px 70px",
        alignItems: "center",
        gap: 10,
        cursor: "pointer",
        fontFamily: FONT_MONO,
        fontSize: 11,
      }}
    >
      <Dot color={repo.langColor} size={7} />
      <span
        style={{
          color: t.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {repo.name}
      </span>
      <span style={{ color: t.textFaint }}>{repo.lastPush}</span>
      <span style={{ color: t.textDim }}>
        {visible.prs} PR{visible.prs !== 1 ? "s" : ""}
      </span>
      <span style={{ color: t.textDim }}>{visible.commits} commits</span>
      {visible.logs > 0 ? (
        <DiffStat t={t} add={totalAdd} rem={totalRem} size={10} />
      ) : (
        <span style={{ color: t.textFaint, fontStyle: "italic" }}>no logs</span>
      )}
    </div>
  );
}

export function AtlasView({
  t,
  repos,
  rollups,
  currentOrg,
  currentRepo,
  rangeFilter,
  tab,
  setTab,
  selected,
  setSelected,
  openNewLog,
  navigate,
}: AtlasViewProps) {
  const [repoQ, setRepoQ] = useState("");
  const [showAllRepos, setShowAllRepos] = useState(false);
  const [rollupQ, setRollupQ] = useState("");
  const [showAllRollups, setShowAllRollups] = useState(false);

  const filteredRepos = useMemo(() => {
    let list = repos;
    if (currentOrg) list = list.filter((r) => r.owner === currentOrg.id);
    if (currentRepo) list = list.filter((r) => r.id === currentRepo.id);
    return list;
  }, [repos, currentOrg, currentRepo]);

  const shownAll = useMemo(
    () =>
      filteredRepos.map((r) => ({
        repo: r,
        visible: applyRangeFilter(r, rangeFilter),
      })),
    [filteredRepos, rangeFilter],
  );

  const matchingRepos = useMemo(() => {
    if (!repoQ) return shownAll;
    const q = repoQ.toLowerCase();
    return shownAll.filter(({ repo }) => repo.name.toLowerCase().includes(q));
  }, [shownAll, repoQ]);

  const sortedRepos = useMemo(() => {
    return matchingRepos.slice().sort((a, b) => {
      if ((b.repo.totalLogs > 0) !== (a.repo.totalLogs > 0))
        return b.repo.totalLogs - a.repo.totalLogs;
      return pushScore(a.repo.lastPush) - pushScore(b.repo.lastPush);
    });
  }, [matchingRepos]);

  const cardRepos = showAllRepos
    ? sortedRepos
    : sortedRepos.slice(0, ATLAS_PAGE_SIZE);
  const repoOverflow = sortedRepos.length - cardRepos.length;

  const logsById = useMemo(() => {
    const m = new Map<string, { log: DisplayLog; repo: DisplayRepo }>();
    for (const r of repos)
      for (const l of r.logs) m.set(l.id, { log: l, repo: r });
    return m;
  }, [repos]);

  const matchingRollups = useMemo(() => {
    if (!rollupQ) return rollups;
    const q = rollupQ.toLowerCase();
    return rollups.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.headline ?? "").toLowerCase().includes(q),
    );
  }, [rollups, rollupQ]);

  const sortedRollups = useMemo(() => {
    return matchingRollups
      .slice()
      .sort(
        (a, b) =>
          (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
      );
  }, [matchingRollups]);

  const shownRollups = showAllRollups
    ? sortedRollups
    : sortedRollups.slice(0, ROLLUP_PAGE_SIZE);
  const rollupOverflow = sortedRollups.length - shownRollups.length;

  const recent = useMemo(() => {
    const all: { log: DisplayLog; repo: DisplayRepo }[] = [];
    for (const r of filteredRepos)
      for (const l of r.logs) all.push({ log: l, repo: r });
    all.sort((a, b) => b.log.createdAt - a.log.createdAt);
    return all.slice(0, 6);
  }, [filteredRepos]);

  const toggleSelect = (id: string) => {
    setSelected(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  };

  return (
    <div
      className="fadeUp"
      style={{ padding: "24px 28px 80px", maxWidth: 1200, margin: "0 auto" }}
    >
      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 20,
          borderBottom: `1px solid ${t.border}`,
          marginBottom: 22,
          fontFamily: FONT_MONO,
          fontSize: 12,
        }}
      >
        {(
          [
            ["repos", "Repos", filteredRepos.length],
            ["rollups", "Rollups", rollups.length],
          ] as const
        ).map(([k, label, n]) => (
          <span
            key={k}
            onClick={() => setTab(k)}
            style={{
              padding: "8px 2px",
              cursor: "pointer",
              color: tab === k ? t.text : t.textDim,
              borderBottom:
                tab === k ? `2px solid ${t.accent}` : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {label}{" "}
            <span style={{ color: t.textFaint, marginLeft: 4 }}>{n}</span>
          </span>
        ))}
      </div>

      {tab === "rollups" ? (
        <>
          <div
            style={{
              marginBottom: 16,
              display: "flex",
              alignItems: "flex-end",
              gap: 16,
            }}
          >
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  color: t.text,
                  letterSpacing: -0.4,
                }}
              >
                Cross-repo rollups
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: t.textDim,
                  marginTop: 4,
                  fontFamily: FONT_MONO,
                }}
              >
                Saved (repo, range) combinations. Regenerate anytime — reuses
                underlying log summaries.
              </div>
            </div>
            <SearchField
              t={t}
              value={rollupQ}
              onChange={(v) => {
                setRollupQ(v);
                setShowAllRollups(false);
              }}
              placeholder={`Search ${rollups.length} rollups…`}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {shownRollups.map((ru) => {
              const ruLogs = ru.logIds
                .map((id) => logsById.get(id))
                .filter((x): x is { log: DisplayLog; repo: DisplayRepo } =>
                  Boolean(x),
                );
              const totals = ruLogs.reduce(
                (a, { log }) => ({
                  prs: a.prs + (log.prs || 0),
                  commits: a.commits + (log.commits || 0),
                  add: a.add + (log.add || 0),
                  rem: a.rem + (log.rem || 0),
                }),
                { prs: 0, commits: 0, add: 0, rem: 0 },
              );
              const preview = ruLogs.slice(0, 3);
              const rest = ruLogs.length - preview.length;
              const isNew =
                Date.now() - (ru.updatedAt ?? ru.createdAt) <
                48 * 3600 * 1000;
              return (
                <div
                  key={ru.id}
                  onClick={() => navigate({ name: "rollup", id: ru.id })}
                  style={{
                    padding: 16,
                    background: t.surface,
                    border: `1px solid ${isNew ? t.accent : t.border}`,
                    borderRadius: 5,
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 10,
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: t.text,
                        fontFamily: FONT_MONO,
                      }}
                    >
                      {ru.title}
                    </span>
                    {isNew && (
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 9,
                          color: t.accent,
                          textTransform: "uppercase",
                          letterSpacing: 1,
                        }}
                      >
                        new
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <span
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: t.textFaint,
                      }}
                    >
                      {fmtRelative(new Date(ru.createdAt).toISOString())}
                    </span>
                  </div>
                  {ru.headline && (
                    <div
                      style={{
                        fontSize: 13,
                        color: t.textDim,
                        marginBottom: 12,
                        textWrap: "balance",
                      }}
                    >
                      {ru.headline}
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      marginBottom: 10,
                      alignItems: "center",
                    }}
                  >
                    {preview.map(({ log, repo }) => (
                      <span
                        key={log.id}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "3px 8px",
                          background: t.surface2,
                          border: `1px solid ${t.border}`,
                          borderRadius: 3,
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          color: t.textDim,
                        }}
                      >
                        <Dot color={repo.langColor} size={6} />
                        <span style={{ color: t.text }}>{repo.name}</span>
                        <span style={{ color: t.textFaint }}>·</span>
                        <span>{log.label}</span>
                      </span>
                    ))}
                    {rest > 0 && (
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          color: t.textFaint,
                        }}
                      >
                        + {rest} more
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 14,
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      color: t.textFaint,
                      alignItems: "center",
                    }}
                  >
                    <span>{totals.prs} PRs</span>
                    <span>{totals.commits} commits</span>
                    <DiffStat t={t} add={totals.add} rem={totals.rem} size={10} />
                  </div>
                </div>
              );
            })}
            {shownRollups.length === 0 && (
              <div
                style={{
                  padding: 20,
                  textAlign: "center",
                  color: t.textFaint,
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  border: `1px dashed ${t.border}`,
                  borderRadius: 5,
                }}
              >
                {rollupQ
                  ? `No rollups match "${rollupQ}"`
                  : "No rollups yet. Select two or more repos to build one."}
              </div>
            )}
            {rollupOverflow > 0 && (
              <div
                onClick={() => setShowAllRollups(true)}
                style={{
                  padding: "11px 14px",
                  background: "transparent",
                  border: `1px dashed ${t.border}`,
                  borderRadius: 5,
                  cursor: "pointer",
                  textAlign: "center",
                  fontSize: 12,
                  color: t.textDim,
                  fontFamily: FONT_MONO,
                }}
              >
                Show {rollupOverflow} more rollup
                {rollupOverflow !== 1 ? "s" : ""} →
              </div>
            )}
            {showAllRollups && sortedRollups.length > ROLLUP_PAGE_SIZE && (
              <div
                onClick={() => setShowAllRollups(false)}
                style={{
                  padding: "9px 14px",
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "center",
                  fontSize: 11,
                  color: t.textFaint,
                  fontFamily: FONT_MONO,
                }}
              >
                Collapse
              </div>
            )}
            <div
              onClick={() => openNewLog()}
              style={{
                padding: 14,
                background: "transparent",
                border: `1px dashed ${t.border}`,
                borderRadius: 5,
                cursor: "pointer",
                textAlign: "center",
                fontSize: 12,
                color: t.textDim,
                fontFamily: FONT_MONO,
              }}
            >
              ＋ New rollup
            </div>
          </div>
        </>
      ) : (
        <>
          <div
            style={{
              marginBottom: 18,
              display: "flex",
              alignItems: "flex-end",
              gap: 16,
            }}
          >
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  color: t.text,
                  letterSpacing: -0.4,
                }}
              >
                {currentRepo
                  ? currentRepo.name
                  : currentOrg
                    ? currentOrg.name
                    : "All repositories"}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: t.textDim,
                  marginTop: 4,
                  fontFamily: FONT_MONO,
                }}
              >
                {filteredRepos.length} repos · filtered by{" "}
                {rangeFilter.toLowerCase()}
              </div>
            </div>
            <SearchField
              t={t}
              value={repoQ}
              onChange={(v) => {
                setRepoQ(v);
                setShowAllRepos(false);
              }}
              placeholder={`Search ${filteredRepos.length} repos…`}
            />
          </div>

          {cardRepos.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              {cardRepos.map(({ repo, visible }) => (
                <RepoCard
                  key={repo.id}
                  t={t}
                  repo={repo}
                  visible={visible}
                  selected={selected.includes(repo.id)}
                  onToggleSelect={() => toggleSelect(repo.id)}
                  onClick={() =>
                    navigate({
                      name: "repo",
                      owner: repo.owner,
                      repo: repo.short,
                    })
                  }
                />
              ))}
            </div>
          )}

          {cardRepos.length === 0 && (
            <div
              style={{
                padding: 28,
                textAlign: "center",
                color: t.textFaint,
                fontFamily: FONT_MONO,
                fontSize: 12,
                border: `1px dashed ${t.border}`,
                borderRadius: 5,
              }}
            >
              {repoQ
                ? `No repos match "${repoQ}"`
                : "No repositories available."}
            </div>
          )}

          {repoOverflow > 0 && !showAllRepos && (
            <div
              onClick={() => setShowAllRepos(true)}
              style={{
                marginTop: 14,
                padding: "10px 14px",
                background: "transparent",
                border: `1px dashed ${t.border}`,
                borderRadius: 5,
                cursor: "pointer",
                textAlign: "center",
                fontSize: 12,
                color: t.textDim,
                fontFamily: FONT_MONO,
              }}
            >
              Show {repoOverflow} more repos →
            </div>
          )}
          {showAllRepos && sortedRepos.length > ATLAS_PAGE_SIZE && (
            <div style={{ marginTop: 18 }}>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  color: t.textFaint,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                All {sortedRepos.length} repos
              </div>
              <div
                style={{
                  background: t.surface,
                  border: `1px solid ${t.border}`,
                  borderRadius: 5,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "8px 12px",
                    display: "grid",
                    gridTemplateColumns:
                      "18px minmax(120px, 1.4fr) minmax(100px, 1fr) 90px 90px 70px",
                    gap: 10,
                    fontFamily: FONT_MONO,
                    fontSize: 9,
                    color: t.textFaint,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                  }}
                >
                  <span />
                  <span>Repo</span>
                  <span>Last push</span>
                  <span>PRs</span>
                  <span>Commits</span>
                  <span>+/−</span>
                </div>
                {sortedRepos.slice(ATLAS_PAGE_SIZE).map(({ repo, visible }) => (
                  <RepoMiniRow
                    key={repo.id}
                    t={t}
                    repo={repo}
                    visible={visible}
                    onClick={() =>
                      navigate({
                        name: "repo",
                        owner: repo.owner,
                        repo: repo.short,
                      })
                    }
                  />
                ))}
              </div>
              <div
                onClick={() => setShowAllRepos(false)}
                style={{
                  marginTop: 10,
                  padding: "8px 14px",
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "center",
                  fontSize: 11,
                  color: t.textFaint,
                  fontFamily: FONT_MONO,
                }}
              >
                Collapse to top {ATLAS_PAGE_SIZE}
              </div>
            </div>
          )}

          {selected.length > 0 && (
            <div
              style={{
                position: "fixed",
                bottom: 20,
                left: "50%",
                transform: "translateX(-50%)",
                padding: "9px 12px",
                background: t.surface,
                border: `1px solid ${t.borderStrong}`,
                borderRadius: 5,
                display: "flex",
                alignItems: "center",
                gap: 12,
                zIndex: 50,
                boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
              }}
            >
              <span
                style={{ fontFamily: FONT_MONO, fontSize: 11, color: t.text }}
              >
                {selected.length} selected
              </span>
              <span
                style={{ width: 1, height: 18, background: t.border }}
              />
              <button
                onClick={() => setSelected([])}
                style={{
                  padding: "4px 10px",
                  fontSize: 11,
                  background: "transparent",
                  color: t.textDim,
                  border: `1px solid ${t.border}`,
                  borderRadius: 3,
                  cursor: "pointer",
                  fontFamily: FONT_MONO,
                }}
              >
                Clear
              </button>
              <button
                onClick={() => openNewLog(selected)}
                style={{
                  padding: "4px 12px",
                  fontSize: 11,
                  background: t.accent,
                  color: t.accentInk,
                  border: "none",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Roll up these →
              </button>
            </div>
          )}

          {recent.length > 0 && (
            <div style={{ marginTop: 34 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  marginBottom: 10,
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
                  Recent logs
                </div>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    color: t.textFaint,
                  }}
                >
                  across {filteredRepos.length} repos
                </span>
              </div>
              <div
                style={{
                  background: t.surface,
                  border: `1px solid ${t.border}`,
                  borderRadius: 5,
                  overflow: "hidden",
                }}
              >
                {recent.map(({ log, repo }, i) => (
                  <div
                    key={`${repo.id}:${log.id}`}
                    onClick={() => navigate({ name: "log", id: log.id })}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLDivElement).style.background =
                        t.surface2)
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLDivElement).style.background =
                        "transparent")
                    }
                    style={{
                      padding: "11px 14px",
                      display: "grid",
                      gridTemplateColumns:
                        "10px minmax(120px, 1fr) minmax(200px, 2fr) 90px 110px",
                      gap: 12,
                      alignItems: "center",
                      cursor: "pointer",
                      borderTop: i === 0 ? "none" : `1px solid ${t.border}`,
                    }}
                  >
                    <Dot color={repo.langColor} size={7} />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          color: t.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {repo.name}
                      </div>
                      <div
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          color: t.textFaint,
                        }}
                      >
                        {log.label} · {fmtRange(log.range)}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: t.textDim,
                        textWrap: "balance",
                        overflow: "hidden",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {log.headline ?? "—"}
                    </div>
                    <DiffStat t={t} add={log.add} rem={log.rem} size={10} />
                    <div
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: t.textFaint,
                        textAlign: "right",
                      }}
                    >
                      {fmtRelative(new Date(log.createdAt).toISOString())}
                      {log.isNew && (
                        <span
                          style={{
                            marginLeft: 8,
                            color: t.accent,
                            letterSpacing: 1,
                            textTransform: "uppercase",
                            fontSize: 9,
                          }}
                        >
                          new
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
