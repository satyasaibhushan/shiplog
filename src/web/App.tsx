import {
  Ship, Loader2, AlertCircle, Anchor, ChevronRight, RotateCcw,
  Sparkles, PanelLeftClose, PanelLeft,
} from "lucide-react";
import { useState } from "react";
import { useShiplog } from "./hooks/useShiplog.ts";
import { DateRangePicker } from "./components/DateRangePicker.tsx";
import { RepoSelector } from "./components/RepoSelector.tsx";
import { ScopeFilter } from "./components/ScopeFilter.tsx";
import { ContributionSummary } from "./components/ContributionSummary.tsx";

export function App() {
  const s = useShiplog();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const hasResults =
    s.phase === "fetched" || s.phase === "done" || s.phase === "summarizing";
  const isWorking = s.phase === "fetching" || s.phase === "summarizing";

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

        {/* ── Fetching state ── */}
        {s.phase === "fetching" && (
          <div className="h-full flex flex-col items-center justify-center animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-cyan-500/5 flex items-center justify-center animate-pulse-glow">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
            </div>
            <p className="mt-6 text-sm text-neutral-400">Fetching contributions from GitHub...</p>
            <p className="mt-1 text-xs text-neutral-600">
              Commits, PRs, and diffs for your selected repos
            </p>
          </div>
        )}

        {/* ── Summarizing state ── */}
        {s.phase === "summarizing" && (
          <div className="h-full flex flex-col items-center justify-center animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-cyan-500/5 flex items-center justify-center animate-pulse-glow">
              <Sparkles className="w-7 h-7 text-accent animate-pulse" />
            </div>
            <p className="mt-6 text-sm text-neutral-300 font-medium">
              Summarizing with AI...
            </p>
            {s.summaryProgress && (
              <div className="mt-4 w-72">
                <div className="flex justify-between text-xs text-neutral-500 mb-1.5">
                  <span>
                    {s.summaryProgress.phase === "map"
                      ? `Group ${s.summaryProgress.current} / ${s.summaryProgress.total}`
                      : "Creating roll-up..."}
                  </span>
                  <span>
                    {Math.round(
                      (s.summaryProgress.current / s.summaryProgress.total) * 100
                    )}
                    %
                  </span>
                </div>
                <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${
                        (s.summaryProgress.current / s.summaryProgress.total) * 100
                      }%`,
                    }}
                  />
                </div>
                {s.summaryProgress.groupLabel && (
                  <p className="mt-2 text-xs text-neutral-500 truncate">
                    {s.summaryProgress.cached ? "cached — " : ""}
                    {s.summaryProgress.groupLabel}
                  </p>
                )}
              </div>
            )}
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
