// Chat modal — version-history drawer, proposed vs current pane, ⌘↵ composer.

import { useEffect, useState } from "react";
import { useChatSession } from "../hooks/useChatSession.ts";
import {
  FONT_MONO,
  FONT_SANS,
  fmtRelative,
  type Theme,
} from "../theme.ts";
import type { SummaryParentKind, SummaryVersionRecord } from "../types.ts";
import { Markdown } from "./primitives.tsx";

export interface ChatTarget {
  key: string;
  kind: string;
  title: string;
  currentSummary: string;
  parentKind: SummaryParentKind;
  parentId: string;
}

interface ChatModalProps {
  t: Theme;
  target: ChatTarget;
  versions: SummaryVersionRecord[];
  onClose: () => void;
  onCommitted?: () => void;
}

export function ChatModal({
  t,
  target,
  versions,
  onClose,
  onCommitted,
}: ChatModalProps) {
  const session = useChatSession(target.parentKind, target.parentId);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const latest = versions[versions.length - 1];
  const latestModel = session.model || latest?.model || "sonnet";
  const currentContent = session.proposed || target.currentSummary;

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || session.streaming) return;
    setDraft("");
    setMessages((m) => [...m, { role: "user", content: prompt }]);
    const result = await session.send(prompt);
    if (result) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content:
            "Here's an updated version incorporating your request. Review below and Replace to commit.",
        },
      ]);
    }
  };

  const commit = async () => {
    if (!session.proposed) {
      onClose();
      return;
    }
    const res = await session.commit(
      messages.find((m) => m.role === "user")?.content ?? "",
    );
    if (res) {
      onCommitted?.();
      onClose();
    }
  };

  const canCommit =
    !!session.proposed &&
    !session.committing &&
    (target.parentKind === "log" || target.parentKind === "rollup");

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: t.overlay,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 860,
          maxWidth: "100%",
          height: "82vh",
          display: "flex",
          flexDirection: "column",
          background: t.bg,
          border: `1px solid ${t.borderStrong}`,
          borderRadius: 8,
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 20px",
            borderBottom: `1px solid ${t.border}`,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                color: t.textFaint,
                textTransform: "uppercase",
                letterSpacing: 1.5,
                marginBottom: 2,
              }}
            >
              Chat with · {target.kind}
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: t.text,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {target.title}
            </div>
          </div>
          <button
            onClick={() => setShowHistory((v) => !v)}
            title="Version history"
            style={{
              padding: "6px 10px",
              background: showHistory ? t.surface2 : "transparent",
              color: t.textDim,
              border: `1px solid ${t.border}`,
              borderRadius: 3,
              fontSize: 11,
              fontFamily: FONT_MONO,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            ↶ {versions.length} version
            {versions.length !== 1 ? "s" : ""}
          </button>
          <span
            onClick={onClose}
            style={{
              cursor: "pointer",
              color: t.textFaint,
              fontSize: 20,
              lineHeight: 1,
              padding: "0 6px",
            }}
          >
            ×
          </span>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* History drawer */}
          {showHistory && (
            <div
              style={{
                width: 220,
                borderRight: `1px solid ${t.border}`,
                background: t.surface,
                overflow: "auto",
                padding: 10,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 9,
                  color: t.textFaint,
                  textTransform: "uppercase",
                  letterSpacing: 1.5,
                  padding: "4px 6px 8px",
                }}
              >
                History
              </div>
              {versions
                .slice()
                .reverse()
                .map((v, i) => (
                  <div
                    key={v.id}
                    style={{
                      padding: 10,
                      borderRadius: 3,
                      marginBottom: 4,
                      background: i === 0 ? t.surface2 : "transparent",
                      border:
                        i === 0
                          ? `1px solid ${t.border}`
                          : `1px solid transparent`,
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          color: t.text,
                        }}
                      >
                        v{v.versionNumber}
                      </span>
                      {i === 0 && (
                        <span
                          style={{
                            fontFamily: FONT_MONO,
                            fontSize: 9,
                            color: t.accent,
                            textTransform: "uppercase",
                            letterSpacing: 1,
                          }}
                        >
                          current
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: t.textFaint,
                        marginBottom: 3,
                      }}
                    >
                      {fmtRelative(new Date(v.createdAt).toISOString())}
                    </div>
                    <div
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: t.textDim,
                      }}
                    >
                      {v.model}
                    </div>
                    {v.source === "chat" && (
                      <div
                        style={{
                          fontSize: 11,
                          color: t.textDim,
                          marginTop: 6,
                          lineHeight: 1.4,
                          fontStyle: "italic",
                        }}
                      >
                        chat edit
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}

          {/* Main column */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
            }}
          >
            {/* Summary pane */}
            <div
              style={{
                padding: 20,
                borderBottom: `1px solid ${t.border}`,
                overflow: "auto",
                maxHeight: "50%",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    color: session.proposed ? t.accent : t.textFaint,
                    textTransform: "uppercase",
                    letterSpacing: 1.5,
                  }}
                >
                  {session.proposed
                    ? "◆ proposed — replaces current"
                    : "◆ current"}
                </span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    color: t.textFaint,
                  }}
                >
                  {latestModel}
                </span>
              </div>
              <Markdown t={t} content={currentContent} />
            </div>

            {/* Chat log */}
            <div
              style={{
                flex: 1,
                overflow: "auto",
                padding: 20,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                minHeight: 0,
              }}
            >
              {messages.length === 0 ? (
                <div
                  style={{
                    margin: "auto",
                    textAlign: "center",
                    maxWidth: 380,
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      color: t.textDim,
                      marginBottom: 10,
                    }}
                  >
                    Ask for an edit, or paste context to include.
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {[
                      "Make this tighter — 3 sentences max.",
                      "Explain the migration path for existing users.",
                      "Quantify the impact and reference the PR.",
                    ].map((s) => (
                      <button
                        key={s}
                        onClick={() => setDraft(s)}
                        style={{
                          padding: "7px 10px",
                          background: t.surface,
                          border: `1px solid ${t.border}`,
                          borderRadius: 3,
                          color: t.textDim,
                          fontSize: 11,
                          fontFamily: FONT_MONO,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      alignSelf:
                        m.role === "user" ? "flex-end" : "flex-start",
                      maxWidth: "80%",
                      padding: "10px 14px",
                      borderRadius: 5,
                      background:
                        m.role === "user" ? t.surface2 : "transparent",
                      border: `1px solid ${t.border}`,
                      fontSize: 13,
                      color: t.text,
                      lineHeight: 1.5,
                    }}
                  >
                    {m.content}
                  </div>
                ))
              )}
              {session.streaming && (
                <div
                  style={{
                    alignSelf: "flex-start",
                    padding: "10px 14px",
                    color: t.textDim,
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: t.accent,
                      marginRight: 8,
                      animation: "blink 1s infinite",
                    }}
                  />
                  drafting…
                </div>
              )}
              {session.error && (
                <div
                  style={{
                    alignSelf: "flex-start",
                    padding: "10px 14px",
                    color: t.orphan,
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    border: `1px solid ${t.orphan}33`,
                    borderRadius: 3,
                  }}
                >
                  {session.error}
                </div>
              )}
            </div>

            {/* Composer */}
            <div
              style={{
                borderTop: `1px solid ${t.border}`,
                padding: 14,
                background: t.surface,
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-end",
                }}
              >
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Refine this summary… (⌘↵ to send)"
                  style={{
                    flex: 1,
                    minHeight: 44,
                    maxHeight: 140,
                    resize: "vertical",
                    padding: "10px 12px",
                    background: t.bg,
                    border: `1px solid ${t.border}`,
                    borderRadius: 4,
                    color: t.text,
                    fontFamily: FONT_SANS,
                    fontSize: 13,
                    outline: "none",
                  }}
                />
                <button
                  onClick={() => void send()}
                  disabled={!draft.trim() || session.streaming}
                  style={{
                    padding: "10px 14px",
                    background: draft.trim() ? t.accent : t.surface2,
                    color: draft.trim() ? t.accentInk : t.textFaint,
                    border: "none",
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: FONT_SANS,
                    cursor:
                      draft.trim() && !session.streaming
                        ? "pointer"
                        : "default",
                  }}
                >
                  Send
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  marginTop: 10,
                  gap: 10,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    color: t.textFaint,
                  }}
                >
                  Replacing{" "}
                  {versions.length > 0 && `v${versions.length}`} · committing
                  creates v{versions.length + 1}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  onClick={onClose}
                  style={{
                    padding: "6px 12px",
                    background: "transparent",
                    color: t.textDim,
                    border: `1px solid ${t.border}`,
                    borderRadius: 3,
                    fontSize: 11,
                    fontFamily: FONT_SANS,
                    cursor: "pointer",
                  }}
                >
                  Discard
                </button>
                <button
                  onClick={() => void commit()}
                  disabled={!canCommit}
                  style={{
                    padding: "6px 14px",
                    background: canCommit ? t.accent : t.surface2,
                    color: canCommit ? t.accentInk : t.textFaint,
                    border: "none",
                    borderRadius: 3,
                    fontSize: 11,
                    fontFamily: FONT_SANS,
                    fontWeight: 600,
                    cursor: canCommit ? "pointer" : "default",
                  }}
                >
                  Replace summary →
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
