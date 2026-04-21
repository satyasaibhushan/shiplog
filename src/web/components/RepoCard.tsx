import type { MouseEvent } from "react";
import type { DisplayRepo } from "../atlasModel.ts";
import { FONT_MONO, type Theme } from "../theme.ts";
import { DiffStat, Dot, Mono } from "./primitives.tsx";
import { RepoTimeline } from "./RepoTimeline.tsx";

export interface RepoVisible {
  logs: number;
  prs: number;
  commits: number;
  filtered: boolean;
}

export function RepoCard({
  t,
  repo,
  visible,
  onClick,
  selected,
  onToggleSelect,
}: {
  t: Theme;
  repo: DisplayRepo;
  visible: RepoVisible;
  onClick: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const latest = repo.logs
    .slice()
    .sort((a, b) => (a.range[1] < b.range[1] ? 1 : -1))[0];
  return (
    <div
      onClick={(e: MouseEvent) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (onToggleSelect) onToggleSelect();
        } else {
          onClick();
        }
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLDivElement).style.borderColor =
            t.borderStrong;
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLDivElement).style.borderColor = t.border;
      }}
      style={{
        padding: "16px 18px",
        background: selected ? t.surface2 : t.surface,
        border: `1px solid ${selected ? t.accent : t.border}`,
        borderRadius: 5,
        cursor: "pointer",
        transition: "border-color 120ms",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        position: "relative",
      }}
    >
      {selected && (
        <span
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            fontFamily: FONT_MONO,
            fontSize: 9,
            color: t.accent,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          selected
        </span>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot color={repo.langColor} size={7} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            fontFamily: FONT_MONO,
            color: t.text,
          }}
        >
          {repo.name}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textFaint }}
        >
          {repo.lastPush}
        </span>
      </div>

      {latest ? (
        <div
          style={{ display: "flex", alignItems: "baseline", gap: 8 }}
        >
          <DiffStat t={t} add={latest.add} rem={latest.rem} size={10} />
          <span style={{ flex: 1 }} />
          <Mono style={{ fontSize: 10, color: t.textFaint }}>
            {visible.logs} log{visible.logs !== 1 ? "s" : ""}
            {visible.filtered ? " in range" : ""}
          </Mono>
        </div>
      ) : (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: t.textFaint,
            fontStyle: "italic",
          }}
        >
          no logs yet — click to compile
        </div>
      )}

      <RepoTimeline
        t={t}
        repo={repo}
        onOpenLog={() => {}}
        onNewLogForRange={() => {}}
        compact
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: t.textFaint,
        }}
      >
        <span>
          <Mono style={{ color: t.textDim }}>{visible.prs}</Mono> PRs ·{" "}
          <Mono style={{ color: t.textDim }}>{visible.commits}</Mono> commits
        </span>
      </div>
    </div>
  );
}
