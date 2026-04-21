import { useMemo, useRef, useState, type MouseEvent } from "react";
import type { DisplayLog, DisplayRepo } from "../atlasModel.ts";
import { FONT_MONO, type Theme, dayIdx, fmtRange } from "../theme.ts";

interface RepoTimelineProps {
  t: Theme;
  repo: DisplayRepo;
  onOpenLog: (log: DisplayLog) => void;
  onNewLogForRange: (range: [string, string], repo: DisplayRepo) => void;
  compact?: boolean;
  months?: string[];
  epoch?: string;
  endIso?: string;
}

// Default last-8-months window anchored in April 2026 to match the prototype's
// visual. Callers can override these to re-scope.
const DEFAULT_MONTHS = [
  "Sep 25",
  "Oct",
  "Nov",
  "Dec",
  "Jan 26",
  "Feb",
  "Mar",
  "Apr",
];
const DEFAULT_EPOCH = "2025-09-01";
const DEFAULT_END = "2026-04-30";

export function RepoTimeline({
  t,
  repo,
  onOpenLog,
  onNewLogForRange,
  compact = false,
  months = DEFAULT_MONTHS,
  epoch = DEFAULT_EPOCH,
  endIso = DEFAULT_END,
}: RepoTimelineProps) {
  const totalDays = dayIdx(endIso, epoch);
  const toPct = (iso: string): number =>
    Math.max(0, Math.min(100, (dayIdx(iso, epoch) / totalDays) * 100));
  const pctToDate = (pct: number): string => {
    const d = new Date(epoch);
    d.setDate(d.getDate() + Math.round((pct / 100) * totalDays));
    return d.toISOString().slice(0, 10);
  };
  const barRef = useRef<HTMLDivElement | null>(null);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const placed = useMemo(() => {
    const sorted = repo.logs
      .slice()
      .sort(
        (a, b) =>
          new Date(b.range[1]).getTime() -
          new Date(b.range[0]).getTime() -
          (new Date(a.range[1]).getTime() - new Date(a.range[0]).getTime()),
      );
    const rows: DisplayLog[][] = [];
    const out: { log: DisplayLog; row: number }[] = [];
    for (const log of sorted) {
      let placed_ = false;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (
          row.every(
            (o) =>
              o.range[1] < log.range[0] || o.range[0] > log.range[1],
          )
        ) {
          row.push(log);
          out.push({ log, row: i });
          placed_ = true;
          break;
        }
      }
      if (!placed_) {
        rows.push([log]);
        out.push({ log, row: rows.length - 1 });
      }
    }
    return { out, rowCount: rows.length || 1 };
  }, [repo.logs]);

  const handleBarClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const center = pctToDate(pct);
    const hit = repo.logs.find(
      (l) => center >= l.range[0] && center <= l.range[1],
    );
    if (hit) {
      onOpenLog(hit);
      return;
    }
    const d = new Date(center);
    const from = new Date(d);
    from.setDate(from.getDate() - 3);
    const to = new Date(d);
    to.setDate(to.getDate() + 3);
    onNewLogForRange(
      [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
      repo,
    );
  };

  const rowH = (compact ? 12 : 24) / placed.rowCount;

  return (
    <div style={{ width: "100%" }}>
      {!compact && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: FONT_MONO,
            fontSize: 9,
            color: t.textFaint,
            textTransform: "uppercase",
            letterSpacing: 1,
            marginBottom: 6,
          }}
        >
          {months.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
      <div
        ref={barRef}
        onMouseMove={(e) => {
          if (compact) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverPct(((e.clientX - rect.left) / rect.width) * 100);
        }}
        onMouseLeave={() => {
          setHoverPct(null);
          setHoverId(null);
        }}
        onClick={handleBarClick}
        style={{
          position: "relative",
          height: compact ? 14 : 30,
          background: t.gap,
          borderRadius: 3,
          overflow: "hidden",
          cursor: "pointer",
        }}
      >
        {!compact &&
          months.map((_, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${(i / (months.length - 1)) * 100}%`,
                top: 0,
                bottom: 0,
                width: 1,
                background: "rgba(255,255,255,0.04)",
              }}
            />
          ))}
        {placed.out.map(({ log, row }) => {
          const left = toPct(log.range[0]);
          const width = toPct(log.range[1]) - left;
          const isHover = hoverId === log.id;
          return (
            <div
              key={log.id}
              onMouseEnter={() => setHoverId(log.id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={(e) => {
                e.stopPropagation();
                onOpenLog(log);
              }}
              title={`${log.label} — ${fmtRange(log.range)}`}
              style={{
                position: "absolute",
                left: `${left}%`,
                width: `${Math.max(width, 1)}%`,
                top: 1 + row * (rowH + 1),
                height: rowH,
                background: log.isNew ? t.accent : t.compiledDim,
                border: `1px solid ${
                  isHover
                    ? t.text
                    : log.isNew
                      ? t.accent
                      : t.compiledDim
                }`,
                borderRadius: 2,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                overflow: "hidden",
                boxShadow: isHover
                  ? `0 0 0 1px ${t.text}`
                  : log.isNew
                    ? `0 0 0 1px ${t.accent}`
                    : "none",
                filter: isHover ? "brightness(1.15)" : "none",
                transition:
                  "filter 120ms, box-shadow 120ms, border-color 120ms",
                paddingLeft: 4,
              }}
            >
              {!compact && width > 6 && (
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 9,
                    color: log.isNew ? t.accentInk : t.text,
                    whiteSpace: "nowrap",
                    fontWeight: 500,
                  }}
                >
                  {log.label}
                </span>
              )}
            </div>
          );
        })}
        {!compact && hoverPct != null && hoverId == null && (
          <>
            <div
              style={{
                position: "absolute",
                left: `${hoverPct}%`,
                top: 0,
                bottom: 0,
                width: 1,
                background: t.accent,
                pointerEvents: "none",
                opacity: 0.6,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: `${hoverPct}%`,
                top: "100%",
                transform: "translate(-50%, 4px)",
                padding: "2px 6px",
                background: t.text,
                color: t.bg,
                fontFamily: FONT_MONO,
                fontSize: 9,
                borderRadius: 2,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                fontWeight: 600,
              }}
            >
              click to compile · {pctToDate(hoverPct)}
            </div>
          </>
        )}
      </div>
      {!compact && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 8,
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: t.textFaint,
          }}
        >
          <span
            style={{ display: "flex", alignItems: "center", gap: 5 }}
          >
            <span
              style={{
                width: 14,
                height: 10,
                background: t.compiledDim,
                borderRadius: 2,
              }}
            />{" "}
            compiled
          </span>
          <span
            style={{ display: "flex", alignItems: "center", gap: 5 }}
          >
            <span
              style={{
                width: 14,
                height: 10,
                background: t.accent,
                borderRadius: 2,
              }}
            />{" "}
            new
          </span>
          <span
            style={{ display: "flex", alignItems: "center", gap: 5 }}
          >
            <span
              style={{
                width: 14,
                height: 10,
                background: t.gap,
                borderRadius: 2,
                border: `1px solid ${t.border}`,
              }}
            />{" "}
            uncompiled — click to start a log
          </span>
        </div>
      )}
    </div>
  );
}
