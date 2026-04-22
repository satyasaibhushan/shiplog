// Root view router — holds theme/view/selection/modal state and composes
// TopBar + AtlasView/RepoView/LogView/RollupDetailView + NewLogModal + ChatModal.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";
import { useAtlas } from "./hooks/useAtlas.ts";
import { useContributedRepos } from "./hooks/useContributedRepos.ts";
import { useRepos } from "./hooks/useRepos.ts";
import { buildAtlasModel } from "./atlasModel.ts";
import {
  FONT_MONO,
  FONT_SANS,
  THEMES,
  type Theme,
  type ThemeName,
} from "./theme.ts";
import type {
  AtlasView,
  LogRecord,
  SummaryVersionRecord,
} from "./types.ts";
import { AtlasView as AtlasViewComponent } from "./components/AtlasView.tsx";
import { ChatModal, type ChatTarget } from "./components/ChatModal.tsx";
import { LogView } from "./components/LogView.tsx";
import { NewLogModal } from "./components/NewLogModal.tsx";
import { RepoView } from "./components/RepoView.tsx";
import { RollupDetailView } from "./components/RollupDetailView.tsx";
import { TopBar } from "./components/TopBar.tsx";

const THEME_KEY = "shiplog_theme_v2";
const HIDE_NO_CONTRIB_KEY = "shiplog_hide_no_contrib_v1";

interface StatusCheck {
  ok: boolean;
  detail: string;
}

interface StatusResponse {
  checks: Record<string, StatusCheck>;
  hasLLM: boolean;
  ready: boolean;
}

function useStatus() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const check = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/status");
      const json = (await res.json()) as StatusResponse;
      setStatus(json);
      return json;
    } catch {
      setStatus(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);
  return { status, loading, check };
}

export function App() {
  const { status, loading: statusLoading, check: recheckStatus } = useStatus();

  const [theme, setThemeState] = useState<ThemeName>(() => {
    if (typeof window === "undefined") return "dark";
    const saved = window.localStorage.getItem(THEME_KEY);
    return saved === "light" ? "light" : "dark";
  });
  const t = THEMES[theme];
  const setTheme = (next: ThemeName) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const reposHook = useRepos();
  const atlasHook = useAtlas();
  const contributedHook = useContributedRepos();
  const model = useMemo(
    () => buildAtlasModel(reposHook.data, atlasHook.data),
    [reposHook.data, atlasHook.data],
  );

  const [hideNoContrib, setHideNoContribState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const saved = window.localStorage.getItem(HIDE_NO_CONTRIB_KEY);
    return saved === null ? true : saved === "1";
  });
  const setHideNoContrib = (next: boolean) => {
    setHideNoContribState(next);
    try {
      window.localStorage.setItem(HIDE_NO_CONTRIB_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  // Predicate applied only to the atlas (home) view. Pickers, search, and
  // direct navigation still see the full repo list. A repo counts as
  // contributed if the user has commits in either the canonical repo or its
  // personal fork (`forkFullName`, wired by /api/repos dedup). Repos with an
  // existing log are also kept — commit-search may lag behind or miss them.
  const contributedSet = contributedHook.data;
  const isContributedRepo = (r: (typeof model.repos)[number]) => {
    if (!hideNoContrib || !contributedSet) return true;
    if (contributedSet.has(r.id)) return true;
    const fork = r._raw?.forkFullName;
    if (fork && contributedSet.has(fork)) return true;
    return r.totalLogs > 0;
  };

  const [view, setView] = useState<AtlasView>({ name: "atlas" });

  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [currentRepoId, setCurrentRepoId] = useState<string | null>(null);
  const currentOrg = currentOrgId
    ? model.orgs.find((o) => o.id === currentOrgId) ?? null
    : null;
  const currentRepo = currentRepoId
    ? model.repos.find((r) => r.id === currentRepoId) ?? null
    : null;

  const [rangeFilter, setRangeFilter] = useState("All time");
  const [tab, setTab] = useState<"repos" | "rollups">("repos");
  const [selected, setSelected] = useState<string[]>([]);

  const [newLog, setNewLog] = useState<{
    open: boolean;
    defaultRepoIds?: string[];
    defaultRange?: [string, string];
  }>({ open: false });

  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null);
  const [chatVersions, setChatVersions] = useState<SummaryVersionRecord[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const openNewLog = useCallback(
    (preselect?: string[], range?: [string, string]) => {
      setNewLog({
        open: true,
        defaultRepoIds: preselect,
        defaultRange: range,
      });
    },
    [],
  );

  const closeNewLog = useCallback(() => setNewLog({ open: false }), []);

  const handleLogCreated = useCallback(
    (logId: string) => {
      closeNewLog();
      setSelected([]);
      atlasHook.refresh();
      setToast("Log compiled — opening…");
      setTimeout(() => setToast(null), 2200);
      setView({ name: "log", id: logId });
    },
    [atlasHook, closeNewLog],
  );

  const openChat = useCallback(
    async (target: ChatTarget) => {
      setChatTarget(target);
      setChatVersions([]);
      const kind = target.parentKind;
      const endpoint =
        kind === "log"
          ? `/api/logs/${encodeURIComponent(target.parentId)}/versions`
          : kind === "rollup"
            ? `/api/rollups/${encodeURIComponent(target.parentId)}/versions`
            : null;
      if (!endpoint) return;
      try {
        const res = await fetch(endpoint);
        if (!res.ok) return;
        const json = (await res.json()) as {
          versions: SummaryVersionRecord[];
        };
        setChatVersions(json.versions ?? []);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const closeChat = useCallback(() => {
    setChatTarget(null);
    setChatVersions([]);
  }, []);

  const handleChatCommitted = useCallback(() => {
    atlasHook.refresh();
    closeChat();
  }, [atlasHook, closeChat]);

  const onRollupInclude = useCallback((log: LogRecord) => {
    setSelected((prev) =>
      prev.includes(log.id) ? prev : [...prev, log.id],
    );
    setTab("rollups");
    setView({ name: "atlas" });
    setToast("Added to rollup selection — pick more logs, then click Roll up →");
    setTimeout(() => setToast(null), 2800);
  }, []);

  // Keyboard shortcuts: N opens NewLogModal; Escape closes modals.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const editable =
        tag === "input" ||
        tag === "textarea" ||
        (e.target as HTMLElement | null)?.isContentEditable;
      if (e.key === "Escape") {
        if (chatTarget) closeChat();
        else if (newLog.open) closeNewLog();
      }
      if (
        (e.key === "n" || e.key === "N") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !editable &&
        !newLog.open &&
        !chatTarget
      ) {
        e.preventDefault();
        const preselect = currentRepo ? [currentRepo.id] : undefined;
        openNewLog(preselect);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [chatTarget, closeChat, closeNewLog, currentRepo, newLog.open, openNewLog]);

  if (statusLoading) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: t.bg,
        }}
      >
        <Loader2
          size={24}
          color={t.accent}
          style={{ animation: "spin 1s linear infinite" }}
        />
      </div>
    );
  }

  if (status && !status.ready) {
    return (
      <SetupScreen
        theme={theme}
        checks={status.checks}
        hasLLM={status.hasLLM}
        onRetry={recheckStatus}
        retrying={statusLoading}
      />
    );
  }

  const filteredRepos = currentOrg
    ? model.repos.filter((r) => r.owner === currentOrg.id)
    : model.repos;
  // Scope of the "hide repos with no contributions" toggle: atlas view only.
  // The toggle should never hide a repo the user has explicitly navigated to.
  const atlasRepos = currentRepo
    ? [currentRepo]
    : filteredRepos.filter(isContributedRepo);
  const viewRepos = atlasRepos;

  const repoForRepoView =
    view.name === "repo"
      ? model.repos.find(
          (r) => r.owner === view.owner && r.short === view.repo,
        ) ?? null
      : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: t.bg,
        color: t.text,
        fontFamily: FONT_SANS,
      }}
    >
      <TopBar
        t={t}
        theme={theme}
        setTheme={setTheme}
        userEmail={reposHook.data?.email ?? null}
        hideNoContrib={hideNoContrib}
        setHideNoContrib={setHideNoContrib}
        contributedLoading={contributedHook.loading}
        globalRange={rangeFilter}
        onRangeChange={setRangeFilter}
        onNewLog={() => {
          const preselect = currentRepo ? [currentRepo.id] : undefined;
          openNewLog(preselect);
        }}
        onGoHome={() => {
          setView({ name: "atlas" });
        }}
        orgs={model.orgs}
        repos={model.repos}
        currentOrg={currentOrg}
        currentRepo={currentRepo}
        onPickOrg={(o) => {
          setCurrentOrgId(o?.id ?? null);
          setCurrentRepoId(null);
          setView({ name: "atlas" });
        }}
        onPickRepo={(r) => {
          setCurrentRepoId(r?.id ?? null);
          if (r) {
            setCurrentOrgId(r.owner);
            setView({ name: "repo", owner: r.owner, repo: r.short });
          } else {
            setView({ name: "atlas" });
          }
        }}
      />

      <main>
        {view.name === "atlas" && (
          <AtlasViewComponent
            t={t}
            repos={viewRepos}
            orgs={model.orgs}
            rollups={model.rollups}
            currentOrg={currentOrg}
            currentRepo={currentRepo}
            rangeFilter={rangeFilter}
            tab={tab}
            setTab={setTab}
            selected={selected}
            setSelected={setSelected}
            openNewLog={openNewLog}
            navigate={(v) => {
              if (v.name === "repo") {
                const repo = model.repos.find(
                  (r) => r.owner === v.owner && r.short === v.repo,
                );
                if (repo) {
                  setCurrentOrgId(repo.owner);
                  setCurrentRepoId(repo.id);
                }
              }
              setView(v);
            }}
          />
        )}
        {view.name === "repo" && repoForRepoView && (
          <RepoView
            t={t}
            repo={repoForRepoView}
            onBack={() => {
              setCurrentRepoId(null);
              setView({ name: "atlas" });
            }}
            onOpenLog={(log) => setView({ name: "log", id: log.id })}
            onNewLogForRange={(range, repo) =>
              openNewLog([repo.id], range ?? undefined)
            }
          />
        )}
        {view.name === "repo" && !repoForRepoView && (
          <MissingView
            t={t}
            text={`Repo ${view.owner}/${view.repo} is not in your home feed.`}
            onBack={() => setView({ name: "atlas" })}
          />
        )}
        {view.name === "log" && (
          <LogView
            t={t}
            id={view.id}
            navigate={(v) => {
              if (v.name === "repo") {
                const repo = model.repos.find(
                  (r) => r.owner === v.owner && r.short === v.repo,
                );
                if (repo) setCurrentRepoId(repo.id);
              }
              setView(v);
            }}
            openChat={openChat}
            onRollupInclude={onRollupInclude}
          />
        )}
        {view.name === "rollup" && (
          <RollupDetailView
            t={t}
            id={view.id}
            repos={model.repos}
            navigate={setView}
            openChat={openChat}
          />
        )}
      </main>

      {newLog.open && (
        <NewLogModal
          t={t}
          repos={
            newLog.defaultRepoIds && newLog.defaultRepoIds.length
              ? model.repos
              : filteredRepos.length
                ? filteredRepos
                : model.repos
          }
          defaultRepoIds={newLog.defaultRepoIds}
          defaultRange={newLog.defaultRange}
          onClose={closeNewLog}
          onCreated={handleLogCreated}
        />
      )}

      {chatTarget && (
        <ChatModal
          t={t}
          target={chatTarget}
          versions={chatVersions}
          onClose={closeChat}
          onCommitted={handleChatCommitted}
        />
      )}

      {toast && <Toast t={t} text={toast} />}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function MissingView({
  t,
  text,
  onBack,
}: {
  t: Theme;
  text: string;
  onBack: () => void;
}) {
  return (
    <div
      style={{
        padding: "48px 28px",
        maxWidth: 720,
        margin: "0 auto",
        textAlign: "center",
      }}
    >
      <div
        onClick={onBack}
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
          border: `1px solid ${t.border}`,
          borderRadius: 5,
          color: t.textDim,
          fontSize: 13,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function Toast({ t, text }: { t: Theme; text: string }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "10px 16px",
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        color: t.text,
        fontSize: 12,
        fontFamily: FONT_MONO,
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
        zIndex: 50,
      }}
    >
      {text}
    </div>
  );
}

// ── Setup screen (retained, restyled with theme tokens) ──

function SetupScreen({
  theme,
  checks,
  hasLLM,
  onRetry,
  retrying,
}: {
  theme: ThemeName;
  checks: Record<string, StatusCheck>;
  hasLLM: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = THEMES[theme];
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: t.bg,
        padding: "0 24px",
        fontFamily: FONT_SANS,
      }}
    >
      <div style={{ width: "100%", maxWidth: 520 }} className="fadeUp">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 28,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: t.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                fontFamily: FONT_MONO,
                fontWeight: 700,
                fontSize: 18,
                color: t.accentInk,
              }}
            >
              §
            </span>
          </div>
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: -0.2,
                color: t.text,
              }}
            >
              shiplog
            </div>
            <div
              style={{ fontSize: 11, color: t.textFaint, fontFamily: FONT_MONO }}
            >
              Let's get you set up
            </div>
          </div>
        </div>

        <div
          style={{
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <SetupRow
            t={t}
            label="GitHub CLI (gh)"
            check={checks.gh}
            helpUrl="https://cli.github.com"
            helpText="Install gh CLI"
            command="brew install gh"
            required
          />
          <SetupRow
            t={t}
            label="GitHub Auth"
            check={checks.ghAuth}
            helpText="Authenticate"
            command="gh auth login"
            required
          />
          <div
            style={{
              padding: "8px 14px",
              background: t.surface2,
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 1.2,
              color: t.textFaint,
              fontFamily: FONT_MONO,
            }}
          >
            AI Summarization (at least one)
          </div>
          <SetupRow
            t={t}
            label="Claude Code CLI"
            check={checks.claude}
            helpUrl="https://docs.anthropic.com/en/docs/claude-code"
            helpText="Install Claude"
            command="npm install -g @anthropic-ai/claude-code"
            required={!hasLLM}
          />
          <SetupRow
            t={t}
            label="Codex CLI"
            check={checks.codex}
            helpUrl="https://github.com/openai/codex"
            helpText="Install Codex"
            command="npm install -g @openai/codex"
            required={!hasLLM}
          />
        </div>

        <div
          style={{
            marginTop: 20,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <button
            onClick={onRetry}
            disabled={retrying}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 16px",
              background: t.accent,
              color: t.accentInk,
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: retrying ? "wait" : "pointer",
              opacity: retrying ? 0.6 : 1,
              fontFamily: FONT_SANS,
            }}
          >
            {retrying ? (
              <Loader2
                size={14}
                style={{ animation: "spin 1s linear infinite" }}
              />
            ) : (
              <RefreshCw size={14} />
            )}
            Re-check
          </button>
          <span style={{ fontSize: 11, color: t.textFaint }}>
            Run the commands above, then click re-check.
          </span>
        </div>
      </div>
    </div>
  );
}

function SetupRow({
  t,
  label,
  check,
  helpUrl,
  helpText,
  command,
  required,
}: {
  t: Theme;
  label: string;
  check?: StatusCheck;
  helpUrl?: string;
  helpText?: string;
  command?: string;
  required?: boolean;
}) {
  const ok = check?.ok ?? false;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderBottom: `1px solid ${t.border}`,
      }}
    >
      {ok ? (
        <CheckCircle2 size={16} color={t.open} />
      ) : (
        <XCircle size={16} color={required ? t.closed : t.textFaint} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 500,
            color: ok ? t.textDim : required ? t.text : t.textFaint,
          }}
        >
          <span>{label}</span>
          {!required && !ok && (
            <span
              style={{
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: 1.2,
                color: t.textFaint,
                background: t.surface2,
                padding: "2px 6px",
                borderRadius: 3,
                fontFamily: FONT_MONO,
              }}
            >
              optional
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: t.textFaint,
            fontFamily: FONT_MONO,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {check?.detail ?? "Checking…"}
        </div>
      </div>
      {!ok && command && (
        <code
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10,
            fontFamily: FONT_MONO,
            color: t.accent,
            background: t.surface2,
            padding: "3px 8px",
            borderRadius: 3,
          }}
        >
          <Terminal size={10} />
          {command}
        </code>
      )}
      {!ok && helpUrl && (
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontSize: 10,
            color: t.accent,
            textDecoration: "none",
          }}
        >
          {helpText} <ExternalLink size={10} />
        </a>
      )}
    </div>
  );
}

