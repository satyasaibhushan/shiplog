// Cross-repo rollup detail — narrative card + per-repo sections listing member logs.

import { useRollup } from "../hooks/useRollup.ts";
import type { DisplayLog, DisplayRepo } from "../atlasModel.ts";
import {
  FONT_MONO,
  fmtDateLabel,
  fmtRelative,
  type Theme,
} from "../theme.ts";
import type { AtlasView } from "../types.ts";
import {
  ChatIcon,
  DiffStat,
  Dot,
  Markdown,
  Mono,
  StalePill,
} from "./primitives.tsx";

interface RollupDetailViewProps {
  t: Theme;
  id: string;
  repos: DisplayRepo[];
  navigate: (v: AtlasView) => void;
  openChat: (target: {
    key: string;
    kind: string;
    title: string;
    currentSummary: string;
    parentKind: "log" | "rollup" | "pr" | "orphan";
    parentId: string;
  }) => void;
}

export function RollupDetailView({
  t,
  id,
  repos,
  navigate,
  openChat,
}: RollupDetailViewProps) {
  const { data, loading, error } = useRollup(id);

  if (loading && !data) {
    return (
      <div
        style={{
          padding: "48px 28px",
          textAlign: "center",
          color: t.textFaint,
          fontFamily: FONT_MONO,
          fontSize: 12,
        }}
      >
        loading…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        style={{ padding: "24px 28px", maxWidth: 1080, margin: "0 auto" }}
      >
        <div
          onClick={() => navigate({ name: "atlas" })}
          style={{
            color: t.textDim,
            cursor: "pointer",
            fontFamily: FONT_MONO,
            fontSize: 11,
            marginBottom: 16,
          }}
        >
          ← home
        </div>
        <div
          style={{
            padding: 14,
            background: t.surface,
            border: `1px solid ${t.orphan}33`,
            borderRadius: 5,
            color: t.orphan,
            fontSize: 13,
          }}
        >
          {error ?? "Rollup not found."}
        </div>
      </div>
    );
  }

  const { rollup, activeVersion } = data;
  const stale = rollup.stale ?? null;

  const logsById = new Map<string, { log: DisplayLog; repo: DisplayRepo }>();
  for (const r of repos) for (const l of r.logs) logsById.set(l.id, { log: l, repo: r });

  const members = rollup.logIds
    .map((lid) => logsById.get(lid))
    .filter((m): m is { log: DisplayLog; repo: DisplayRepo } => Boolean(m));

  const totals = members.reduce(
    (a, { log }) => ({
      prs: a.prs + (log.prs || 0),
      commits: a.commits + (log.commits || 0),
      add: a.add + (log.add || 0),
      rem: a.rem + (log.rem || 0),
    }),
    { prs: 0, commits: 0, add: 0, rem: 0 },
  );

  const latestModel = activeVersion?.model ?? "—";

  return (
    <div
      className="fadeUp"
      style={{ padding: "20px 28px 48px", maxWidth: 1080, margin: "0 auto" }}
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
          onClick={() => navigate({ name: "atlas" })}
          style={{ color: t.textDim, cursor: "pointer" }}
        >
          home
        </span>
        <span style={{ color: t.textFaint }}>/</span>
        <span style={{ color: t.textDim }}>rollups</span>
        <span style={{ color: t.textFaint }}>/</span>
        <span style={{ color: t.text }}>{rollup.title}</span>
      </div>

      {/* Header */}
      <div
        style={{
          marginBottom: 22,
          display: "flex",
          alignItems: "flex-end",
          gap: 20,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              color: t.textFaint,
              textTransform: "uppercase",
              letterSpacing: 2,
              marginBottom: 6,
            }}
          >
            Cross-repo rollup · {members.length} log
            {members.length !== 1 ? "s" : ""} ·{" "}
            {fmtDateLabel(rollup.createdAt)}
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: -0.4,
              lineHeight: 1.25,
              color: t.text,
              textWrap: "balance",
              maxWidth: 720,
            }}
          >
            {rollup.title}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: t.textDim,
          }}
        >
          <span>
            <Mono style={{ color: t.text }}>{totals.prs}</Mono> PRs
          </span>
          <span>
            <Mono style={{ color: t.text }}>{totals.commits}</Mono> commits
          </span>
          <DiffStat t={t} add={totals.add} rem={totals.rem} size={11} />
        </div>
      </div>

      {/* Narrative */}
      {activeVersion ? (
        <div
          style={{
            position: "relative",
            background: t.surface,
            border: `1px solid ${stale ? t.orphan : t.border}`,
            borderRadius: 6,
            padding: "20px 24px",
            marginBottom: 28,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: 2,
              background: stale ? t.orphan : t.accent,
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                color: stale ? t.orphan : t.accent,
                letterSpacing: 1.5,
                textTransform: "uppercase",
              }}
            >
              ◆ Cross-repo narrative
            </span>
            {stale && <StalePill t={t} reason={stale.reason} />}
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                color: t.textFaint,
              }}
            >
              via {latestModel}
            </span>
            <ChatIcon
              t={t}
              onClick={() =>
                openChat({
                  key: `crossrollup:${rollup.id}`,
                  kind: "cross-repo narrative",
                  title: rollup.title,
                  currentSummary: activeVersion.summaryMarkdown,
                  parentKind: "rollup",
                  parentId: rollup.id,
                })
              }
              stale={!!stale}
            />
          </div>
          <Markdown t={t} content={activeVersion.summaryMarkdown} />
        </div>
      ) : (
        <div
          style={{
            padding: "36px 20px",
            textAlign: "center",
            background: t.surface,
            border: `1px dashed ${t.border}`,
            borderRadius: 5,
            marginBottom: 28,
            color: t.textFaint,
            fontSize: 13,
          }}
        >
          No narrative generated yet.
        </div>
      )}

      {/* Members */}
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: t.textFaint,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        Repositories in this rollup
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {members.map(({ log, repo }) => (
          <div
            key={log.id}
            style={{
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: 5,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                borderBottom: `1px solid ${t.border}`,
              }}
            >
              <Dot color={repo.langColor} size={8} />
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 13,
                  color: t.text,
                  fontWeight: 500,
                }}
              >
                {repo.name}
              </span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: t.textFaint,
                }}
              >
                · {log.label}
              </span>
              <span style={{ flex: 1 }} />
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  color: t.textFaint,
                }}
              >
                {log.prs} PRs · {log.commits} commits
              </span>
              <DiffStat t={t} add={log.add} rem={log.rem} size={10} />
              <button
                onClick={() => navigate({ name: "log", id: log.id })}
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
                Open log →
              </button>
            </div>
            {log.headline && (
              <div
                style={{
                  padding: "12px 16px",
                  fontSize: 13,
                  color: t.textDim,
                  textWrap: "balance",
                }}
              >
                {log.headline}
              </div>
            )}
          </div>
        ))}
        {members.length === 0 && (
          <div
            style={{
              padding: "16px 20px",
              color: t.textFaint,
              fontSize: 12,
              fontFamily: FONT_MONO,
              fontStyle: "italic",
              border: `1px dashed ${t.border}`,
              borderRadius: 5,
              textAlign: "center",
            }}
          >
            {rollup.logIds.length > 0
              ? `${rollup.logIds.length} member logs are no longer visible on your home.`
              : "No members in this rollup."}
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 16,
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: t.textFaint,
        }}
      >
        Updated {fmtRelative(new Date(rollup.updatedAt).toISOString())}
      </div>
    </div>
  );
}
