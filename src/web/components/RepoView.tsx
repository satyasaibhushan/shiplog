// Repo view — repo header, stats panel + coverage timeline, compiled logs list.

import type { DisplayLog, DisplayRepo } from "../atlasModel.ts";
import { FONT_MONO, FONT_SANS, fmtRange, type Theme } from "../theme.ts";
import { DiffStat, Dot, Mono } from "./primitives.tsx";
import { RepoTimeline } from "./RepoTimeline.tsx";

interface RepoViewProps {
  t: Theme;
  repo: DisplayRepo;
  onBack: () => void;
  onOpenLog: (log: DisplayLog) => void;
  onNewLogForRange: (range: [string, string] | null, repo: DisplayRepo) => void;
}

export function RepoView({
  t,
  repo,
  onBack,
  onOpenLog,
  onNewLogForRange,
}: RepoViewProps) {
  const totals = repo.logs.reduce(
    (a, l) => ({
      prs: a.prs + (l.prs || 0),
      commits: a.commits + (l.commits || 0),
      add: a.add + (l.add || 0),
      rem: a.rem + (l.rem || 0),
    }),
    { prs: 0, commits: 0, add: 0, rem: 0 },
  );

  return (
    <div
      className="fadeUp"
      style={{ padding: "20px 28px 40px", maxWidth: 1080, margin: "0 auto" }}
    >
      {/* Breadcrumb */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 16,
          fontFamily: FONT_MONO,
          fontSize: 11,
        }}
      >
        <span
          onClick={onBack}
          style={{ color: t.textDim, cursor: "pointer" }}
        >
          home
        </span>
        <span style={{ color: t.textFaint }}>/</span>
        <span style={{ color: t.text }}>{repo.name}</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 20,
          marginBottom: 20,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 6,
            }}
          >
            <Dot color={repo.langColor} size={9} />
            <span
              style={{
                fontSize: 22,
                fontWeight: 600,
                fontFamily: FONT_MONO,
                color: t.text,
              }}
            >
              {repo.name}
            </span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: t.textFaint,
              fontFamily: FONT_MONO,
            }}
          >
            {repo.lang ?? "—"} · last push {repo.lastPush} ·{" "}
            {repo.logs.length} log{repo.logs.length !== 1 ? "s" : ""} compiled
          </div>
        </div>
        <button
          onClick={() => onNewLogForRange(null, repo)}
          style={{
            padding: "7px 12px",
            background: t.accent,
            color: t.accentInk,
            border: "none",
            borderRadius: 3,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: FONT_SANS,
            cursor: "pointer",
          }}
        >
          ＋ New log
        </button>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            display: "flex",
            alignItems: "baseline",
            gap: 16,
          }}
        >
          <div>
            <Mono
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: t.text,
                letterSpacing: -0.5,
              }}
            >
              {totals.prs}
            </Mono>
            <span
              style={{
                fontSize: 10,
                color: t.textFaint,
                fontFamily: FONT_MONO,
                marginLeft: 6,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              PRs
            </span>
          </div>
          <div>
            <Mono
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: t.text,
                letterSpacing: -0.5,
              }}
            >
              {totals.commits}
            </Mono>
            <span
              style={{
                fontSize: 10,
                color: t.textFaint,
                fontFamily: FONT_MONO,
                marginLeft: 6,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              commits
            </span>
          </div>
          <span style={{ flex: 1 }} />
          <DiffStat t={t} add={totals.add} rem={totals.rem} size={12} />
        </div>
        <div
          style={{
            padding: "12px 16px",
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
          }}
        >
          <RepoTimeline
            t={t}
            repo={repo}
            onOpenLog={onOpenLog}
            onNewLogForRange={(r) => onNewLogForRange(r, repo)}
            compact
          />
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 9,
              color: t.textFaint,
              marginTop: 6,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            Coverage · last 8 months
          </div>
        </div>
      </div>

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
        Compiled logs
      </div>
      {repo.logs.length === 0 ? (
        <div
          style={{
            padding: "36px 20px",
            textAlign: "center",
            background: t.surface,
            border: `1px dashed ${t.border}`,
            borderRadius: 5,
          }}
        >
          <div style={{ fontSize: 14, color: t.text, marginBottom: 6 }}>
            No logs compiled yet
          </div>
          <button
            onClick={() => onNewLogForRange(null, repo)}
            style={{
              padding: "7px 13px",
              background: t.accent,
              color: t.accentInk,
              border: "none",
              borderRadius: 3,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: FONT_SANS,
              cursor: "pointer",
            }}
          >
            Compile first log →
          </button>
        </div>
      ) : (
        <div
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          {repo.logs
            .slice()
            .sort((a, b) => (a.range[1] < b.range[1] ? 1 : -1))
            .map((log) => (
              <div
                key={log.id}
                onClick={() => onOpenLog(log)}
                style={{
                  padding: "14px 18px",
                  background: t.surface,
                  border: `1px solid ${t.border}`,
                  borderRadius: 5,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    minWidth: 110,
                  }}
                >
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 13,
                      fontWeight: 600,
                      color: t.text,
                    }}
                  >
                    {log.label}
                  </span>
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: t.textFaint,
                    }}
                  >
                    {fmtRange(log.range)}
                  </span>
                </div>
                <span
                  style={{
                    flex: 1,
                    fontSize: 13,
                    color: t.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {log.headline ?? ""}
                </span>
                <div
                  style={{
                    display: "flex",
                    gap: 18,
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: t.textFaint,
                    alignItems: "center",
                  }}
                >
                  <DiffStat t={t} add={log.add} rem={log.rem} size={11} />
                  <span>{log.prs} PRs</span>
                  <span>{log.commits} commits</span>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
