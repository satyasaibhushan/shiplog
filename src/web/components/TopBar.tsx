import { useEffect, useRef, useState } from "react";
import type { DisplayOrg, DisplayRepo } from "../atlasModel.ts";
import { FONT_MONO, FONT_SANS, type Theme, type ThemeName } from "../theme.ts";
import { CustomDateRange, Dot } from "./primitives.tsx";

export interface TopBarProps {
  t: Theme;
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  userEmail: string | null;
  hideNoContrib: boolean;
  setHideNoContrib: (next: boolean) => void;
  contributedLoading: boolean;
  globalRange: string;
  onRangeChange: (range: string) => void;
  onNewLog: () => void;
  onGoHome: () => void;
  orgs: DisplayOrg[];
  repos: DisplayRepo[];
  currentOrg: DisplayOrg | null;
  currentRepo: DisplayRepo | null;
  onPickOrg: (org: DisplayOrg | null) => void;
  onPickRepo: (repo: DisplayRepo | null) => void;
}

export function TopBar({
  t,
  theme,
  setTheme,
  userEmail,
  hideNoContrib,
  setHideNoContrib,
  contributedLoading,
  globalRange,
  onRangeChange,
  onNewLog,
  onGoHome,
  orgs,
  repos,
  currentOrg,
  currentRepo,
  onPickOrg,
  onPickRepo,
}: TopBarProps) {
  const [rangeOpen, setRangeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("2026-01-01");
  const [customTo, setCustomTo] = useState("2026-04-19");

  useEffect(() => {
    const h = () => {
      setRangeOpen(false);
      setMenuOpen(false);
    };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "10px 20px",
        borderBottom: `1px solid ${t.border}`,
        background: t.bg,
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      {/* Logo */}
      <div
        onClick={onGoHome}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
        }}
      >
        <div
          style={{
            width: 20,
            height: 20,
            background: t.accent,
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontFamily: FONT_MONO,
              fontWeight: 700,
              fontSize: 11,
              color: t.accentInk,
            }}
          >
            §
          </span>
        </div>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: -0.2,
            color: t.text,
          }}
        >
          shiplog
        </span>
      </div>

      {/* Folder nav */}
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 12,
          color: t.textFaint,
          margin: "0 10px",
        }}
      >
        /
      </span>
      <OrgPicker
        t={t}
        orgs={orgs}
        currentOrg={currentOrg}
        onPick={onPickOrg}
      />
      {currentOrg && (
        <>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              color: t.textFaint,
              margin: "0 6px",
            }}
          >
            /
          </span>
          <RepoPicker
            t={t}
            repos={repos.filter((r) => r.owner === currentOrg.id)}
            currentRepo={currentRepo}
            currentOrgName={currentOrg.name}
            onPick={onPickRepo}
          />
        </>
      )}

      <div style={{ flex: 1 }} />

      {/* Range picker */}
      <div
        style={{ position: "relative", marginRight: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => setRangeOpen(!rangeOpen)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            fontSize: 12,
            color: t.text,
            cursor: "pointer",
            fontFamily: FONT_SANS,
          }}
        >
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 9,
              color: t.textFaint,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            Range
          </span>
          <span>{globalRange}</span>
          <span style={{ fontSize: 9, color: t.textFaint }}>▾</span>
        </button>
        {rangeOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: 4,
              padding: 0,
              minWidth: 220,
              zIndex: 30,
              boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ padding: 5 }}>
              {[
                "All time",
                "Last 7 days",
                "Last 30 days",
                "This quarter",
                "This year",
              ].map((r) => (
                <div
                  key={r}
                  onClick={() => {
                    onRangeChange(r);
                    setRangeOpen(false);
                    setCustomOpen(false);
                  }}
                  style={{
                    padding: "6px 9px",
                    fontSize: 12,
                    color: t.text,
                    cursor: "pointer",
                    borderRadius: 3,
                    background: globalRange === r ? t.surface2 : "transparent",
                    fontFamily: FONT_MONO,
                  }}
                >
                  {r}
                </div>
              ))}
              <div
                onClick={() => setCustomOpen((v) => !v)}
                style={{
                  padding: "6px 9px",
                  fontSize: 12,
                  cursor: "pointer",
                  borderRadius: 3,
                  color: globalRange.startsWith("Custom") ? t.text : t.textDim,
                  background:
                    customOpen || globalRange.startsWith("Custom")
                      ? t.surface2
                      : "transparent",
                  fontFamily: FONT_MONO,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <span>Custom…</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 9, color: t.textFaint }}>
                  {customOpen ? "▴" : "▾"}
                </span>
              </div>
            </div>
            {customOpen && (
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
                  const fmt = (iso: string) =>
                    new Date(iso).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    });
                  onRangeChange(
                    `Custom · ${fmt(customFrom)} – ${fmt(customTo)}`,
                  );
                  setCustomOpen(false);
                  setRangeOpen(false);
                }}
              />
            )}
          </div>
        )}
      </div>

      <button
        onClick={onNewLog}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          background: t.accent,
          color: t.accentInk,
          border: "none",
          borderRadius: 4,
          fontSize: 12,
          fontWeight: 600,
          fontFamily: FONT_SANS,
          cursor: "pointer",
        }}
      >
        <span style={{ fontFamily: FONT_MONO, fontSize: 13, lineHeight: 1 }}>
          ＋
        </span>
        New log
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            opacity: 0.55,
            padding: "1px 5px",
            background: "rgba(0,0,0,0.12)",
            borderRadius: 2,
            marginLeft: 2,
          }}
        >
          N
        </span>
      </button>

      {/* Overflow menu */}
      <div
        style={{ position: "relative", marginLeft: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          title="Settings"
          style={{
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            cursor: "pointer",
            color: t.textDim,
          }}
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: 4,
              padding: 8,
              minWidth: 200,
              zIndex: 30,
              boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
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
              Appearance
            </div>
            <div
              style={{
                display: "flex",
                gap: 2,
                padding: 2,
                background: t.bg,
                border: `1px solid ${t.border}`,
                borderRadius: 3,
                marginBottom: 8,
              }}
            >
              {(["dark", "light"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setTheme(v)}
                  style={{
                    flex: 1,
                    padding: "5px 10px",
                    fontSize: 10,
                    cursor: "pointer",
                    border: "none",
                    borderRadius: 2,
                    background: theme === v ? t.accent : "transparent",
                    color: theme === v ? t.accentInk : t.textDim,
                    fontFamily: FONT_MONO,
                    textTransform: "lowercase",
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 9,
                color: t.textFaint,
                textTransform: "uppercase",
                letterSpacing: 1.5,
                padding: "4px 6px 6px",
              }}
            >
              Filters
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                fontSize: 11,
                color: t.textDim,
                fontFamily: FONT_MONO,
                cursor: "pointer",
                marginBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={hideNoContrib}
                onChange={(e) => setHideNoContrib(e.target.checked)}
                style={{ margin: 0, cursor: "pointer", accentColor: t.accent }}
              />
              <span style={{ flex: 1 }}>Hide repos w/ no contributions</span>
              {contributedLoading && (
                <span style={{ fontSize: 9, color: t.textFaint }}>…</span>
              )}
            </label>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 9,
                color: t.textFaint,
                textTransform: "uppercase",
                letterSpacing: 1.5,
                padding: "4px 6px 6px",
              }}
            >
              Account
            </div>
            <div
              style={{
                padding: "6px 8px",
                fontSize: 11,
                color: t.textDim,
                fontFamily: FONT_MONO,
              }}
            >
              {userEmail ?? "—"}
            </div>
            <div
              style={{
                padding: "6px 8px",
                fontSize: 11,
                color: t.textDim,
                fontFamily: FONT_MONO,
                cursor: "pointer",
              }}
            >
              Keyboard shortcuts ⌘/
            </div>
            <div
              style={{
                padding: "6px 8px",
                fontSize: 11,
                color: t.textDim,
                fontFamily: FONT_MONO,
                cursor: "pointer",
              }}
            >
              Sign out
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Org picker ──
function OrgPicker({
  t,
  orgs,
  currentOrg,
  onPick,
}: {
  t: Theme;
  orgs: DisplayOrg[];
  currentOrg: DisplayOrg | null;
  onPick: (org: DisplayOrg | null) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = () => setOpen(false);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, []);
  return (
    <div
      style={{ position: "relative" }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => setOpen(!open)}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = t.border;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor =
            "transparent";
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          background: "transparent",
          border: `1px solid transparent`,
          borderRadius: 4,
          fontSize: 12,
          color: t.text,
          cursor: "pointer",
          fontFamily: FONT_MONO,
        }}
      >
        {currentOrg ? (
          <>
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                background: t.surface2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 9,
                fontWeight: 700,
                color: t.text,
              }}
            >
              {currentOrg.avatar}
            </span>
            <span>{currentOrg.name}</span>
          </>
        ) : (
          <span style={{ color: t.textDim }}>all orgs</span>
        )}
        <span style={{ fontSize: 9, color: t.textFaint }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: "calc(100% + 6px)",
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            padding: 5,
            minWidth: 180,
            zIndex: 30,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          }}
        >
          <div
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
            style={{
              padding: "6px 9px",
              fontSize: 12,
              color: !currentOrg ? t.text : t.textDim,
              cursor: "pointer",
              borderRadius: 3,
              fontFamily: FONT_MONO,
              background: !currentOrg ? t.surface2 : "transparent",
            }}
          >
            all orgs
          </div>
          {orgs.map((o) => (
            <div
              key={o.id}
              onClick={() => {
                onPick(o);
                setOpen(false);
              }}
              style={{
                padding: "6px 9px",
                fontSize: 12,
                color: t.text,
                cursor: "pointer",
                borderRadius: 3,
                fontFamily: FONT_MONO,
                display: "flex",
                alignItems: "center",
                gap: 7,
                background: currentOrg?.id === o.id ? t.surface2 : "transparent",
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: t.surface3,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9,
                  fontWeight: 700,
                  color: t.text,
                }}
              >
                {o.avatar}
              </span>
              <span>{o.name}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: t.textFaint }}>
                {o.repoIds.length}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Repo picker ──
function RepoPicker({
  t,
  repos,
  currentRepo,
  currentOrgName,
  onPick,
}: {
  t: Theme;
  repos: DisplayRepo[];
  currentRepo: DisplayRepo | null;
  currentOrgName: string;
  onPick: (repo: DisplayRepo | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = () => setOpen(false);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const filtered = q
    ? repos.filter((r) => r.short.toLowerCase().includes(q.toLowerCase()))
    : repos;
  const shown = filtered.slice(0, 12);
  const overflow = filtered.length - shown.length;

  return (
    <div
      style={{ position: "relative" }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => setOpen(!open)}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = t.border;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor =
            "transparent";
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          background: "transparent",
          border: `1px solid transparent`,
          borderRadius: 4,
          fontSize: 12,
          color: t.text,
          cursor: "pointer",
          fontFamily: FONT_MONO,
        }}
      >
        {currentRepo ? (
          <>
            <Dot color={currentRepo.langColor} size={7} />
            <span>{currentRepo.short}</span>
          </>
        ) : (
          <span style={{ color: t.textDim }}>
            all repos{" "}
            <span style={{ color: t.textFaint }}>· {repos.length}</span>
          </span>
        )}
        <span style={{ fontSize: 9, color: t.textFaint }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: "calc(100% + 6px)",
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            padding: 0,
            minWidth: 260,
            maxHeight: 360,
            zIndex: 30,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ padding: 8, borderBottom: `1px solid ${t.border}` }}>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${repos.length} repos…`}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: t.bg,
                border: `1px solid ${t.border}`,
                borderRadius: 3,
                padding: "5px 8px",
                fontSize: 12,
                color: t.text,
                fontFamily: FONT_MONO,
                outline: "none",
              }}
            />
          </div>
          <div style={{ overflow: "auto", flex: 1, padding: 5 }}>
            {!q && (
              <div
                onClick={() => {
                  onPick(null);
                  setOpen(false);
                }}
                style={{
                  padding: "6px 9px",
                  fontSize: 12,
                  color: !currentRepo ? t.text : t.textDim,
                  cursor: "pointer",
                  borderRadius: 3,
                  fontFamily: FONT_MONO,
                  background: !currentRepo ? t.surface2 : "transparent",
                }}
              >
                all repos in {currentOrgName}
              </div>
            )}
            {shown.map((r) => (
              <div
                key={r.id}
                onClick={() => {
                  onPick(r);
                  setOpen(false);
                  setQ("");
                }}
                style={{
                  padding: "6px 9px",
                  fontSize: 12,
                  color: t.text,
                  cursor: "pointer",
                  borderRadius: 3,
                  fontFamily: FONT_MONO,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  background:
                    currentRepo?.id === r.id ? t.surface2 : "transparent",
                }}
              >
                <Dot color={r.langColor} size={7} />
                <span>{r.short}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: t.textFaint }}>
                  {r.totalLogs} log{r.totalLogs !== 1 ? "s" : ""}
                </span>
              </div>
            ))}
            {overflow > 0 && (
              <div
                style={{
                  padding: "8px 9px",
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  color: t.textFaint,
                  borderTop: `1px solid ${t.border}`,
                  marginTop: 4,
                }}
              >
                + {overflow} more — refine search
              </div>
            )}
            {filtered.length === 0 && (
              <div
                style={{
                  padding: "16px 9px",
                  fontSize: 11,
                  color: t.textFaint,
                  fontStyle: "italic",
                  fontFamily: FONT_MONO,
                }}
              >
                No repos match "{q}"
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
