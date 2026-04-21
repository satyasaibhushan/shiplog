import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { FONT_MONO, FONT_SANS, fmtNum, type Theme } from "../theme.ts";

export function Dot({
  color = "currentColor",
  size = 6,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

export function Mono({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function DiffStat({
  t,
  add,
  rem,
  size = 11,
}: {
  t: Theme;
  add: number;
  rem: number;
  size?: number;
}) {
  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        fontSize: size,
        display: "inline-flex",
        gap: 6,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span style={{ color: t.added }}>+{fmtNum(add)}</span>
      <span style={{ color: t.removed }}>−{fmtNum(rem)}</span>
    </span>
  );
}

export function ChatIcon({
  t,
  onClick,
  size = 14,
  stale = false,
  title = "Chat with this summary",
}: {
  t: Theme;
  onClick: () => void;
  size?: number;
  stale?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      style={{
        width: size + 14,
        height: size + 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: `1px solid ${stale ? t.orphan : t.border}`,
        color: stale ? t.orphan : t.textDim,
        borderRadius: 4,
        cursor: "pointer",
        padding: 0,
        position: "relative",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M2 4.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7L4.5 13.5V11.5H4a2 2 0 0 1-2-2v-5Z" />
      </svg>
      {stale && (
        <span
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: t.orphan,
          }}
        />
      )}
    </button>
  );
}

export function StalePill({ t, reason }: { t: Theme; reason: string }) {
  return (
    <span
      title={reason}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        borderRadius: 3,
        fontFamily: FONT_MONO,
        fontSize: 10,
        background: t.orphanBg,
        color: t.orphan,
        border: `1px solid ${t.orphan}33`,
        textTransform: "uppercase",
        letterSpacing: 1,
      }}
    >
      ◇ stale · re-summarize
    </span>
  );
}

export function BranchGlyph({
  t,
  orphan = false,
}: {
  t: Theme;
  orphan?: boolean;
}) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke={orphan ? t.orphan : t.merged}
      strokeWidth="1.4"
    >
      {orphan ? (
        <circle cx="9" cy="9" r="2.5" strokeDasharray="2 2" />
      ) : (
        <>
          <circle cx="5" cy="4" r="1.5" />
          <path d="M5 5.5v7" />
          <circle cx="5" cy="14" r="1.5" />
          <path d="M5 9 Q 5 7 8 7 L 12 7" />
          <circle cx="13.5" cy="7" r="1.5" />
        </>
      )}
    </svg>
  );
}

export function CommitGlyph({ t }: { t: Theme }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke={t.textFaint}
      strokeWidth="1.4"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2v3.5M8 10.5V14" />
    </svg>
  );
}

export function PRStatePill({
  t,
  state,
}: {
  t: Theme;
  state: "merged" | "open" | "closed";
}) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    merged: { bg: t.mergedBg, fg: t.merged, label: "MERGED" },
    open: { bg: t.openBg, fg: t.open, label: "OPEN" },
    closed: { bg: "rgba(248,113,113,0.12)", fg: t.closed, label: "CLOSED" },
  };
  const m = (map[state] ?? map.merged)!;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 3,
        background: m.bg,
        color: m.fg,
        fontFamily: FONT_MONO,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 1,
      }}
    >
      {m.label}
    </span>
  );
}

export function OrphanPill({ t }: { t: Theme }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 3,
        background: t.orphanBg,
        color: t.orphan,
        fontFamily: FONT_MONO,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 1,
      }}
    >
      ORPHAN
    </span>
  );
}

export function OthersPRPill({ t }: { t: Theme }) {
  return (
    <span
      title="PR opened by someone else — only your commits are summarized"
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 3,
        background: `${t.textFaint}22`,
        color: t.textDim,
        border: `1px solid ${t.border}`,
        fontFamily: FONT_MONO,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 1,
      }}
    >
      OTHERS' PR
    </span>
  );
}

// ── Markdown — lightweight renderer matching the prototype's inline style ──
export function Markdown({
  t,
  content,
  inline = false,
}: {
  t: Theme;
  content: string;
  inline?: boolean;
}) {
  const renderInline = (s: string): string =>
    s
      .replace(
        /\*\*([^*]+)\*\*/g,
        `<strong style="color:${t.text};font-weight:600">$1</strong>`,
      )
      .replace(
        /`([^`]+)`/g,
        `<code style="font-family:${FONT_MONO};font-size:0.88em;color:${t.sha};background:${t.surface2};padding:1px 6px;border-radius:2px">$1</code>`,
      )
      .replace(
        /\[([^\]]+)\]\((https?:[^)]+)\)/g,
        `<a href="$2" target="_blank" rel="noopener noreferrer" style="color:${t.text};text-decoration:underline;text-decoration-color:${t.textFaint};text-underline-offset:3px">$1</a>`,
      );

  // Block parser: headings (# / ## / ###), bullet lists (- / *), paragraphs.
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  type Block =
    | { kind: "h1" | "h2" | "h3"; text: string }
    | { kind: "p"; text: string }
    | { kind: "ul"; items: string[] };
  const blocks: Block[] = [];
  let buf: string[] = [];
  let list: string[] | null = null;

  const flushParagraph = () => {
    if (buf.length) {
      blocks.push({ kind: "p", text: buf.join(" ") });
      buf = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "ul", items: list });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "h3", text: h3[1]! });
      continue;
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      flushParagraph();
      flushList();
      // Drop a bare "## Summary" / "## Overview" label — these are filler from
      // older prompts; the body speaks for itself.
      if (/^(summary|overview)$/i.test(h2[1]!.trim())) continue;
      blocks.push({ kind: "h2", text: h2[1]! });
      continue;
    }
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "h1", text: h1[1]! });
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!list) list = [];
      list.push(bullet[1]!);
      continue;
    }
    // Continuation of a bullet or paragraph
    if (list && /^\s{2,}/.test(raw)) {
      list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`;
      continue;
    }
    flushList();
    buf.push(line);
  }
  flushParagraph();
  flushList();

  return (
    <div
      style={{
        fontFamily: FONT_SANS,
        fontSize: inline ? 13 : 14,
        lineHeight: 1.7,
        color: t.textDim,
      }}
    >
      {blocks.map((b, i) => {
        const topMargin = i === 0 ? 0 : undefined;
        if (b.kind === "h1") {
          return (
            <h1
              key={i}
              style={{
                margin: topMargin ?? "0.4em 0 0.5em",
                fontSize: inline ? 16 : 22,
                fontWeight: 600,
                lineHeight: 1.25,
                letterSpacing: -0.4,
                color: t.text,
                fontFamily: FONT_SANS,
                textWrap: "balance",
              }}
              dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
            />
          );
        }
        if (b.kind === "h2") {
          return (
            <h2
              key={i}
              style={{
                margin: topMargin ?? "1.4em 0 0.4em",
                fontSize: inline ? 14 : 16,
                fontWeight: 600,
                color: t.text,
                fontFamily: FONT_SANS,
                letterSpacing: -0.2,
              }}
              dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
            />
          );
        }
        if (b.kind === "h3") {
          return (
            <h3
              key={i}
              style={{
                margin: topMargin ?? "1.1em 0 0.3em",
                fontSize: inline ? 13 : 14,
                fontWeight: 600,
                color: t.text,
                fontFamily: FONT_SANS,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
              dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
            />
          );
        }
        if (b.kind === "ul") {
          return (
            <ul
              key={i}
              style={{
                margin: topMargin ?? "0.6em 0 0",
                paddingLeft: 20,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {b.items.map((it, j) => (
                <li
                  key={j}
                  style={{ textWrap: "pretty" }}
                  dangerouslySetInnerHTML={{ __html: renderInline(it) }}
                />
              ))}
            </ul>
          );
        }
        return (
          <p
            key={i}
            style={{ margin: topMargin ?? "0.8em 0 0", textWrap: "pretty" }}
            dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
          />
        );
      })}
    </div>
  );
}

// ── CustomDateRange ─────────────────────────────────────────────────────────
export function CustomDateRange({
  t,
  from,
  to,
  onChange,
  onCancel,
  onApply,
}: {
  t: Theme;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <div
      style={{
        padding: 10,
        borderTop: `1px solid ${t.border}`,
        background: t.surface2,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 9,
          color: t.textFaint,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Custom range
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <input
          type="date"
          value={from}
          onChange={(e) => onChange(e.target.value, to)}
          style={{
            flex: 1,
            background: t.bg,
            border: `1px solid ${t.border}`,
            borderRadius: 3,
            padding: "4px 6px",
            color: t.text,
            fontFamily: FONT_MONO,
            fontSize: 11,
            colorScheme: t.bg === "#0b0b0c" ? "dark" : "light",
          }}
        />
        <span
          style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textFaint }}
        >
          →
        </span>
        <input
          type="date"
          value={to}
          onChange={(e) => onChange(from, e.target.value)}
          style={{
            flex: 1,
            background: t.bg,
            border: `1px solid ${t.border}`,
            borderRadius: 3,
            padding: "4px 6px",
            color: t.text,
            fontFamily: FONT_MONO,
            fontSize: 11,
            colorScheme: t.bg === "#0b0b0c" ? "dark" : "light",
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={onCancel}
          style={{
            flex: 1,
            padding: "5px 8px",
            fontSize: 11,
            background: "transparent",
            color: t.textDim,
            border: `1px solid ${t.border}`,
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: FONT_MONO,
          }}
        >
          Cancel
        </button>
        <button
          onClick={onApply}
          disabled={!from || !to}
          style={{
            flex: 1,
            padding: "5px 8px",
            fontSize: 11,
            background: t.accent,
            color: t.accentInk,
            border: "none",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: FONT_MONO,
            fontWeight: 600,
            opacity: !from || !to ? 0.5 : 1,
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
