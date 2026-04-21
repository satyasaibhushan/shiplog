// Log view — breadcrumb + header + stats + rollup summary + footer action.

import { useState } from "react";
import { useLog } from "../hooks/useLog.ts";
import { useLogContributions } from "../hooks/useLogContributions.ts";
import {
  FONT_MONO,
  FONT_SANS,
  fmtRange,
  fmtRelative,
  type Theme,
} from "../theme.ts";
import type {
  AtlasView,
  LogRecord,
  SummaryVersionRecord,
} from "../types.ts";
import type { GroupWithSummary } from "../hooks/useLogContributions.ts";
import {
  BranchGlyph,
  ChatIcon,
  CommitGlyph,
  DiffStat,
  Markdown,
  Mono,
  OrphanPill,
  OthersPRPill,
  PRStatePill,
  StalePill,
} from "./primitives.tsx";

interface LogViewProps {
  t: Theme;
  id: string;
  navigate: (v: AtlasView) => void;
  openChat: (target: {
    key: string;
    kind: string;
    title: string;
    currentSummary: string;
    parentKind: "log" | "rollup" | "pr" | "orphan";
    parentId: string;
  }) => void;
  onRollupInclude: (log: LogRecord) => void;
}

// Ensure the markdown starts with a `# Title` line. Older logs were generated
// with a `## Summary` prefix (now stripped) but no real title — synthesize one
// from the first paragraph so the log view always has a heading.
function ensureTitle(markdown: string, fallback: string | null | undefined): string {
  const lines = markdown.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ") && !line.startsWith("## ")) return markdown;
    if (line.startsWith("#")) break; // ## / ### — no real title, synthesize
    // Non-heading content encountered first — synthesize from it
    break;
  }
  const title = (fallback && fallback.trim()) || firstSentence(markdown) || "Log";
  return `# ${title}\n\n${markdown}`;
}

function hasTimelineHeading(markdown: string): boolean {
  return /^\s*#{1,3}\s+timeline\b/im.test(markdown);
}

function firstSentence(markdown: string): string | null {
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-") || line.startsWith("*")) continue;
    const sentence = line.split(/(?<=[.!?])\s+/)[0] ?? line;
    return sentence
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .slice(0, 120);
  }
  return null;
}

function deriveLabel(log: LogRecord): string {
  if (log.title) return log.title;
  const start = new Date(log.rangeStart);
  const end = new Date(log.rangeEnd);
  const days = Math.round(
    (end.getTime() - start.getTime()) / 86400000,
  );
  const sameMonth =
    start.getMonth() === end.getMonth() &&
    start.getFullYear() === end.getFullYear();
  if (sameMonth && days >= 25) {
    return start.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }
  if (days >= 80 && days <= 100) {
    const q = Math.floor(start.getMonth() / 3) + 1;
    return `Q${q} ${start.getFullYear()}`;
  }
  return "Log";
}

export function LogView({
  t,
  id,
  navigate,
  openChat,
  onRollupInclude,
}: LogViewProps) {
  const { data, loading, error } = useLog(id);
  const { data: contribData } = useLogContributions(id);

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
          {error ?? "Log not found."}
        </div>
      </div>
    );
  }

  const { log, activeVersion } = data;
  const label = deriveLabel(log);
  const range: [string, string] = [log.rangeStart, log.rangeEnd];
  const stale = log.stale ?? null;
  const stats = activeVersion?.stats;
  const latestModel = activeVersion?.model ?? "—";

  return (
    <div
      className="fadeUp"
      style={{ padding: "24px 28px 48px", maxWidth: 1080, margin: "0 auto" }}
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
        <span
          onClick={() =>
            navigate({ name: "repo", owner: log.owner, repo: log.repo })
          }
          style={{ color: t.textDim, cursor: "pointer" }}
        >
          {log.owner}/{log.repo}
        </span>
        <span style={{ color: t.textFaint }}>/</span>
        <span style={{ color: t.text }}>{label}</span>
      </div>

      {/* Header */}
      <div
        style={{
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: t.text,
            fontFamily: FONT_MONO,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: t.textFaint,
          }}
        >
          {fmtRange(range)}
        </div>
        <span style={{ flex: 1 }} />
        {stats && (
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
            {stats.prs != null && (
              <span>
                <Mono style={{ color: t.text }}>{stats.prs}</Mono> PRs
              </span>
            )}
            <span>
              <Mono style={{ color: t.text }}>{stats.commits}</Mono> commits
            </span>
            <DiffStat
              t={t}
              add={stats.additions}
              rem={stats.deletions}
              size={11}
            />
          </div>
        )}
      </div>

      {/* Rollup summary card */}
      {activeVersion ? (
        <div
          style={{
            position: "relative",
            background: t.surface,
            border: `1px solid ${stale ? t.orphan : t.border}`,
            borderRadius: 6,
            padding: "20px 24px",
            marginBottom: 24,
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
              ◆ Rollup
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
                  key: `rollup:${log.id}`,
                  kind: "rollup summary",
                  title: label,
                  currentSummary: activeVersion.summaryMarkdown,
                  parentKind: "log",
                  parentId: log.id,
                })
              }
              stale={!!stale}
            />
          </div>
          <Markdown
            t={t}
            content={ensureTitle(activeVersion.summaryMarkdown, log.headline)}
          />
          {activeVersion.timeline &&
            activeVersion.timeline.length > 0 &&
            !hasTimelineHeading(activeVersion.summaryMarkdown) && (
              <TimelineBlock
                t={t}
                timeline={
                  activeVersion.timeline as SummaryVersionRecord["timeline"]
                }
              />
            )}
        </div>
      ) : (
        <div
          style={{
            padding: "36px 20px",
            textAlign: "center",
            background: t.surface,
            border: `1px dashed ${t.border}`,
            borderRadius: 5,
            marginBottom: 24,
            color: t.textFaint,
            fontSize: 13,
          }}
        >
          No summary on this log yet.
        </div>
      )}

      {/* PRs + orphan commit groups */}
      {contribData && contribData.groups.length > 0 && (
        <div style={{ marginBottom: 28 }}>
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
              {contribData.stats.prGroups} PR group
              {contribData.stats.prGroups !== 1 ? "s" : ""} ·{" "}
              {contribData.stats.orphanGroups} orphan cluster
              {contribData.stats.orphanGroups !== 1 ? "s" : ""}
            </div>
            <span style={{ flex: 1 }} />
            <DiffStat
              t={t}
              add={contribData.groups.reduce(
                (s, g) => s + groupAdditions(g),
                0,
              )}
              rem={contribData.groups.reduce(
                (s, g) => s + groupDeletions(g),
                0,
              )}
              size={11}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {contribData.groups.map((g, i) => (
              <GroupRow
                key={groupKey(g, i)}
                t={t}
                group={g}
                owner={log.owner}
                repo={log.repo}
                openChat={openChat}
              />
            ))}
          </div>
        </div>
      )}

      {/* Footer action */}
      <div
        style={{
          marginTop: 24,
          padding: 14,
          background: t.surface2,
          border: `1px solid ${t.border}`,
          borderRadius: 5,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{ fontSize: 13, color: t.text, marginBottom: 2 }}
          >
            Roll this up with other repos?
          </div>
          <div
            style={{
              fontSize: 11,
              color: t.textFaint,
              fontFamily: FONT_MONO,
            }}
          >
            Combine {fmtRange(range)} across repos into a unified log. Reuses
            this summary.
          </div>
        </div>
        <button
          onClick={() => onRollupInclude(log)}
          style={{
            padding: "7px 12px",
            background: "transparent",
            color: t.text,
            border: `1px solid ${t.borderStrong}`,
            borderRadius: 3,
            fontSize: 12,
            fontFamily: FONT_SANS,
            cursor: "pointer",
          }}
        >
          Cross-repo rollup →
        </button>
      </div>

      <div
        style={{
          marginTop: 16,
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: t.textFaint,
        }}
      >
        Updated {fmtRelative(new Date(log.updatedAt).toISOString())}
      </div>
    </div>
  );
}

function TimelineBlock({
  t,
  timeline,
}: {
  t: Theme;
  timeline: SummaryVersionRecord["timeline"];
}) {
  if (!timeline || timeline.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 16,
        borderTop: `1px dashed ${t.border}`,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: t.textFaint,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 10,
        }}
      >
        ◇ Timeline
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {timeline.map((entry) => (
          <div
            key={entry.date}
            style={{
              display: "grid",
              gridTemplateColumns: "90px 1fr auto",
              gap: 12,
              alignItems: "baseline",
            }}
          >
            <Mono style={{ color: t.textFaint, fontSize: 11 }}>
              {entry.date}
            </Mono>
            <div
              style={{ fontSize: 13, color: t.textDim, lineHeight: 1.55 }}
            >
              {entry.topPRTitles.length > 0
                ? entry.topPRTitles.join(" · ")
                : `${entry.prCount} PRs, ${entry.commitCount} commits`}
            </div>
            <DiffStat
              t={t}
              add={entry.additions}
              rem={entry.deletions}
              size={10}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function groupKey(g: GroupWithSummary, i: number): string {
  return g.contentHash || `group-${i}`;
}

// PR groups report their GitHub-computed (base...head) diff; orphan groups
// sum their non-merge commits. Merge commits never contribute to +/- totals.
function groupAdditions(g: GroupWithSummary): number {
  if (g.type === "pr" && g.pr?.stats) return g.pr.stats.additions;
  return g.commits.reduce(
    (s, c) => s + (c.isMerge ? 0 : c.stats?.additions ?? 0),
    0,
  );
}

function groupDeletions(g: GroupWithSummary): number {
  if (g.type === "pr" && g.pr?.stats) return g.pr.stats.deletions;
  return g.commits.reduce(
    (s, c) => s + (c.isMerge ? 0 : c.stats?.deletions ?? 0),
    0,
  );
}

function fmtCommitDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function GroupRow({
  t,
  group,
  owner,
  repo,
  openChat,
}: {
  t: Theme;
  group: GroupWithSummary;
  owner: string;
  repo: string;
  openChat: LogViewProps["openChat"];
}) {
  const [open, setOpen] = useState(false);
  const isPR = group.type === "pr" && group.pr;
  // For PRs, prefer the GitHub PR-level diff (base...head) — matches what the
  // PR page shows and excludes files pulled in by backmerges. For orphans (or
  // legacy PRs missing stats), sum commit stats but skip merge commits.
  let adds: number;
  let dels: number;
  if (isPR && group.pr?.stats) {
    adds = group.pr.stats.additions;
    dels = group.pr.stats.deletions;
  } else {
    adds = group.commits.reduce(
      (s, c) => s + (c.isMerge ? 0 : c.stats?.additions ?? 0),
      0,
    );
    dels = group.commits.reduce(
      (s, c) => s + (c.isMerge ? 0 : c.stats?.deletions ?? 0),
      0,
    );
  }
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const prUrl =
    group.type === "pr" && group.pr
      ? `${repoUrl}/pull/${group.pr.number}`
      : null;
  const mergedLabel =
    isPR && group.pr!.mergedAt ? fmtCommitDate(group.pr!.mergedAt) : null;

  return (
    <div
      style={{
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {/* Header row — stacked title + meta */}
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: t.textFaint,
            width: 10,
          }}
        >
          {open ? "▾" : "▸"}
        </span>
        <BranchGlyph t={t} orphan={!isPR} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 6,
            }}
          >
            <span
              style={{
                fontSize: 14,
                color: t.text,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {isPR ? group.pr!.title : group.label}
            </span>
            {isPR && (
              <a
                href={prUrl!}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: t.textDim,
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                #{group.pr!.number}
                <span style={{ fontSize: 9 }}>↗</span>
              </a>
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: t.textFaint,
            }}
          >
            {isPR ? (
              <PRStatePill t={t} state={group.pr!.state} />
            ) : (
              <OrphanPill t={t} />
            )}
            {isPR && group.pr!.openedByOther && <OthersPRPill t={t} />}
            <span>
              {group.commits.length} commit
              {group.commits.length !== 1 ? "s" : ""}
            </span>
            <span>·</span>
            <DiffStat t={t} add={adds} rem={dels} size={10} />
            {mergedLabel && (
              <>
                <span>·</span>
                <span>merged {mergedLabel}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Expanded: per-group summary + chat, then commits */}
      {open && (
        <div
          style={{
            padding: "4px 16px 14px 44px",
            borderTop: group.summary ? `1px solid ${t.border}` : "none",
            position: "relative",
          }}
        >
          {group.summary ? (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  marginBottom: 4,
                }}
              >
                <ChatIcon
                  t={t}
                  size={12}
                  onClick={() =>
                    openChat({
                      key: `group:${group.contentHash}`,
                      kind:
                        group.type === "pr" && group.pr
                          ? `PR #${group.pr.number}`
                          : "orphan cluster",
                      title:
                        group.type === "pr" && group.pr
                          ? group.pr.title
                          : group.label,
                      currentSummary: group.summary ?? "",
                      parentKind: group.type === "pr" ? "pr" : "orphan",
                      parentId: group.contentHash,
                    })
                  }
                />
              </div>
              <Markdown t={t} content={group.summary} inline />
            </>
          ) : (
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: t.textFaint,
                fontStyle: "italic",
                paddingTop: 8,
              }}
            >
              No summary cached for this group.
            </div>
          )}
        </div>
      )}
      {open &&
        group.commits.map((c) => {
          const shortSha = c.sha.slice(0, 7);
          const firstLine = c.message.split("\n")[0] ?? "";
          const commitUrl = `${repoUrl}/commit/${c.sha}`;
          return (
            <div
              key={c.sha}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 16px 9px 44px",
                borderTop: `1px solid ${t.border}`,
              }}
            >
              <CommitGlyph t={t} />
              <a
                href={commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: t.sha,
                  textDecoration: "none",
                }}
              >
                {shortSha}
              </a>
              <span
                style={{
                  fontSize: 12,
                  color: t.text,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {firstLine}
              </span>
              {c.isMerge ? (
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    color: t.textFaint,
                    fontStyle: "italic",
                  }}
                >
                  merge
                </span>
              ) : (
                c.stats && (
                  <DiffStat
                    t={t}
                    add={c.stats.additions}
                    rem={c.stats.deletions}
                    size={10}
                  />
                )
              )}
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  color: t.textFaint,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span>◷</span>
                {fmtCommitDate(c.date)}
              </span>
            </div>
          );
        })}
    </div>
  );
}
