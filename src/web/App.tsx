import {
  Ship, Loader2, AlertCircle, Anchor, ChevronRight, RotateCcw,
  Sparkles, PanelLeftClose, PanelLeft,
  CheckCircle2, XCircle, ExternalLink, RefreshCw, Terminal,
} from "lucide-react";
import { useState } from "react";
import { useShiplog, type StatusCheck } from "./hooks/useShiplog.ts";
import { DateRangePicker } from "./components/DateRangePicker.tsx";
import { RepoSelector } from "./components/RepoSelector.tsx";
import { ScopeFilter } from "./components/ScopeFilter.tsx";
import { ContributionSummary } from "./components/ContributionSummary.tsx";
import { ModelSelector } from "./components/ModelSelector.tsx";
import { GenerationStepper } from "./components/GenerationStepper.tsx";

// ── Setup Screen ──

function SetupScreen({
  checks,
  hasLLM,
  onRetry,
  retrying,
}: {
  checks: Record<string, StatusCheck>;
  hasLLM: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="h-screen flex items-center justify-center bg-neutral-950 px-6">
      <div className="max-w-lg w-full animate-fade-in">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
            <Ship className="w-5 h-5 text-accent" strokeWidth={2.2} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-neutral-100 tracking-tight">
              shiplog
            </h1>
            <p className="text-xs text-neutral-500">
              Let's get you set up
            </p>
          </div>
        </div>

        <div className="bg-neutral-900/60 border border-neutral-800/60 rounded-xl overflow-hidden">
          <SetupRow
            label="GitHub CLI (gh)"
            check={checks.gh}
            helpUrl="https://cli.github.com"
            helpText="Install gh CLI"
            command="brew install gh"
            required
          />
          <SetupRow
            label="GitHub Auth"
            check={checks.ghAuth}
            helpText="Authenticate"
            command="gh auth login"
            required
          />
          <div className="px-4 py-2 bg-neutral-800/20">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              AI Summarization (at least one)
            </p>
          </div>
          <SetupRow
            label="Claude Code CLI"
            check={checks.claude}
            helpUrl="https://docs.anthropic.com/en/docs/claude-code"
            helpText="Install Claude"
            command="npm install -g @anthropic-ai/claude-code"
            required={!hasLLM}
          />
          <SetupRow
            label="Codex CLI"
            check={checks.codex}
            helpUrl="https://github.com/openai/codex"
            helpText="Install Codex"
            command="npm install -g @openai/codex"
            required={!hasLLM}
          />
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={onRetry}
            disabled={retrying}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-neutral-950 font-semibold text-sm transition-all hover:brightness-110 disabled:opacity-50 active:scale-[0.98]"
          >
            {retrying ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Re-check
          </button>
          <p className="text-xs text-neutral-500">
            Run the commands above in your terminal, then click re-check.
          </p>
        </div>
      </div>
    </div>
  );
}

function SetupRow({
  label,
  check,
  helpUrl,
  helpText,
  command,
  required,
}: {
  label: string;
  check?: StatusCheck;
  helpUrl?: string;
  helpText?: string;
  command?: string;
  required?: boolean;
}) {
  const ok = check?.ok ?? false;
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800/40 last:border-b-0">
      {ok ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
      ) : (
        <XCircle className={`w-4 h-4 flex-shrink-0 ${required ? "text-red-400" : "text-neutral-600"}`} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${ok ? "text-neutral-300" : required ? "text-neutral-200" : "text-neutral-500"}`}>
            {label}
          </span>
          {!required && !ok && (
            <span className="text-[9px] uppercase tracking-wider text-neutral-600 bg-neutral-800/60 px-1.5 py-0.5 rounded">
              optional
            </span>
          )}
        </div>
        <p className="text-[11px] text-neutral-500 truncate">
          {check?.detail ?? "Checking..."}
        </p>
      </div>
      {!ok && command && (
        <code className="hidden sm:flex items-center gap-1 text-[10px] font-mono text-accent/70 bg-neutral-800/60 px-2 py-1 rounded">
          <Terminal className="w-2.5 h-2.5" />
          {command}
        </code>
      )}
      {!ok && helpUrl && (
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-accent hover:underline flex items-center gap-0.5 flex-shrink-0"
        >
          {helpText} <ExternalLink className="w-2.5 h-2.5" />
        </a>
      )}
    </div>
  );
}

// ── Main App ──

export function App() {
  const s = useShiplog();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const hasResults =
    s.phase === "fetched" || s.phase === "done" || s.phase === "summarizing";
  const isWorking = s.phase === "fetching" || s.phase === "summarizing";

  // Loading status
  if (s.statusLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-neutral-950">
        <Loader2 className="w-6 h-6 text-accent animate-spin" />
      </div>
    );
  }

  // Setup screen — show when gh or gh auth is missing
  if (s.status && !s.status.ready) {
    return (
      <SetupScreen
        checks={s.status.checks}
        hasLLM={s.status.hasLLM}
        onRetry={s.checkStatus}
        retrying={s.statusLoading}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-950">
      {/* ── Sidebar ── */}
      <aside
        className={`${
          sidebarOpen ? "w-80" : "w-0"
        } flex-shrink-0 transition-all duration-300 overflow-hidden border-r border-neutral-800/60`}
      >
        <div className="w-80 h-full flex flex-col bg-neutral-900/40">
          {/* Logo */}
          <div className="px-5 pt-5 pb-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
              <Ship className="w-[18px] h-[18px] text-accent" strokeWidth={2.2} />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-neutral-100">
                shiplog
              </h1>
              <p className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 font-medium">
                Contribution log
              </p>
            </div>
          </div>

          <div className="h-px bg-neutral-800/60" />

          {/* Config controls */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
            <DateRangePicker
              from={s.dateFrom}
              to={s.dateTo}
              onFromChange={s.setDateFrom}
              onToChange={s.setDateTo}
            />
            <RepoSelector
              repos={s.repos}
              loading={s.reposLoading}
              error={s.reposError}
              selected={s.selectedRepos}
              onSelectedChange={s.setSelectedRepos}
              onRetry={s.loadRepos}
            />
            <ScopeFilter scope={s.scope} onChange={s.setScope} />
            <ModelSelector
              provider={s.llmProvider}
              model={s.llmModel}
              onProviderChange={s.setLlmProvider}
              onModelChange={s.setLlmModel}
              claudeStatus={s.status?.checks.claude}
              codexStatus={s.status?.checks.codex}
            />
          </div>

          {/* Actions */}
          <div className="p-4 border-t border-neutral-800/60 space-y-2">
            {s.error && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/8 rounded-lg px-3 py-2.5 mb-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span className="leading-relaxed">{s.error}</span>
              </div>
            )}
            <button
              onClick={s.generate}
              disabled={isWorking || s.selectedRepos.length === 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-neutral-950 font-semibold text-sm transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
            >
              {isWorking ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {s.phase === "fetching" ? "Fetching..." : "Summarizing..."}
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate Summary
                </>
              )}
            </button>
            {hasResults && (
              <button
                onClick={s.reset}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-neutral-400 text-sm hover:text-neutral-200 hover:bg-neutral-800/50 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-y-auto relative">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="absolute top-4 left-4 z-10 p-1.5 rounded-md text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/60 transition-colors"
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        >
          {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeft className="w-4 h-4" />}
        </button>

        {/* ── Idle state ── */}
        {s.phase === "idle" && (
          <div className="h-full flex flex-col items-center justify-center animate-fade-in px-6">
            <Anchor className="w-16 h-16 text-neutral-800 mb-6" strokeWidth={1} />
            <h2 className="text-2xl font-semibold text-neutral-300 tracking-tight mb-2">
              What did you build?
            </h2>
            <p className="text-sm text-neutral-500 max-w-sm text-center leading-relaxed">
              Select a date range and repositories, then hit{" "}
              <span className="text-accent font-medium">Generate</span> to
              discover what you shipped.
            </p>
            <div className="mt-10 flex items-center gap-2 text-[11px] text-neutral-600 uppercase tracking-widest">
              <ChevronRight className="w-3 h-3" />
              Configure in the sidebar
            </div>
          </div>
        )}

        {/* ── Working state (fetching + summarizing) ── */}
        {(s.phase === "fetching" || s.phase === "summarizing") && (
          <div className="h-full flex flex-col items-center justify-center animate-fade-in px-6">
            <div className="w-14 h-14 rounded-2xl bg-cyan-500/5 flex items-center justify-center animate-pulse-glow mb-8">
              {s.phase === "summarizing" ? (
                <Sparkles className="w-6 h-6 text-accent animate-pulse" />
              ) : (
                <Loader2 className="w-7 h-7 text-accent animate-spin" />
              )}
            </div>
            <GenerationStepper progress={s.generationProgress} />
          </div>
        )}

        {/* ── Error state (no data at all) ── */}
        {s.phase === "error" && !s.contributions && (
          <div className="h-full flex flex-col items-center justify-center animate-fade-in">
            <AlertCircle className="w-12 h-12 text-red-400/60 mb-4" />
            <p className="text-sm text-neutral-300 font-medium mb-1">Something went wrong</p>
            <p className="text-xs text-neutral-500 max-w-sm text-center">{s.error}</p>
          </div>
        )}

        {/* ── Results ── */}
        {hasResults && s.contributions && (
          <div className="p-6 lg:p-8 max-w-5xl mx-auto animate-fade-in">
            <ContributionSummary
              contributions={s.contributions}
              summary={s.summary}
              dateFrom={s.dateFrom}
              dateTo={s.dateTo}
            />
          </div>
        )}
      </main>
    </div>
  );
}
