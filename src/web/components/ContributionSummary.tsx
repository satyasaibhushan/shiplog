import {
  GitCommit, GitPullRequest, Files, CalendarDays,
  FolderGit2, Clock, Zap, Database,
} from "lucide-react";
import Markdown from "react-markdown";
import type { ContributionsResponse, SummarizationResult } from "../types.ts";
import { PRCard } from "./PRCard.tsx";
import { CommitTimeline } from "./CommitTimeline.tsx";
import { ExportButton } from "./ExportButton.tsx";

interface Props {
  contributions: ContributionsResponse;
  summary: SummarizationResult | null;
  dateFrom: string;
  dateTo: string;
}

export function ContributionSummary({
  contributions,
  summary,
  dateFrom,
  dateTo,
}: Props) {
  const { stats, groups, commits } = contributions;

  return (
    <div className="space-y-6 stagger">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-neutral-100 tracking-tight">
            Your Ship Log
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5 font-mono">
            {dateFrom} — {dateTo}
          </p>
        </div>
        <ExportButton summary={summary} contributions={contributions} />
      </div>

      {/* ── Roll-up summary ── */}
      {summary?.rollupSummary && (
        <div className="relative bg-neutral-900/60 border border-neutral-800/60 rounded-xl p-5 overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-cyan-500/60 via-purple-500/40 to-transparent" />
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-semibold text-neutral-200">
              AI Summary
            </h3>
            {summary.provider && (
              <span className="ml-auto text-[10px] font-mono text-neutral-600">
                via {summary.provider}
              </span>
            )}
          </div>
          <div className="prose-shiplog text-sm">
            <Markdown>{summary.rollupSummary}</Markdown>
          </div>
          {summary.stats && (
            <div className="mt-4 pt-3 border-t border-neutral-800/40 flex gap-4 text-[10px] text-neutral-500 font-mono">
              <span>{summary.stats.llmCalls} LLM calls</span>
              <span>{summary.stats.cacheHits} cached</span>
              <span>{(summary.stats.totalDuration / 1000).toFixed(1)}s</span>
            </div>
          )}
        </div>
      )}

      {/* ── Stats grid ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          icon={<GitCommit className="w-4 h-4" />}
          label="Commits"
          value={stats.uniqueCommits ?? stats.totalCommits}
          sub={
            stats.duplicatesRemoved > 0
              ? `${stats.duplicatesRemoved} dupes removed`
              : undefined
          }
        />
        <StatCard
          icon={<GitPullRequest className="w-4 h-4" />}
          label="Pull Requests"
          value={stats.totalPRs}
          sub={[
            stats.mergedPRs > 0 ? `${stats.mergedPRs} merged` : "",
            stats.openPRs > 0 ? `${stats.openPRs} open` : "",
          ]
            .filter(Boolean)
            .join(", ")}
        />
        <StatCard
          icon={<Files className="w-4 h-4" />}
          label="Files Changed"
          value={stats.filesChanged}
        />
        <StatCard
          icon={<FolderGit2 className="w-4 h-4" />}
          label="Repos"
          value={stats.reposProcessed}
        />
      </div>

      {/* ── Timeline ── */}
      {commits.length > 0 && (
        <div className="bg-neutral-900/40 border border-neutral-800/40 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <CalendarDays className="w-4 h-4 text-neutral-500" />
            <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
              Activity Timeline
            </h3>
          </div>
          <CommitTimeline commits={commits} />
        </div>
      )}

      {/* ── Groups ── */}
      {groups.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-neutral-500" />
            <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
              {stats.prGroups} PR group{stats.prGroups !== 1 ? "s" : ""}
              {stats.orphanGroups > 0
                ? ` + ${stats.orphanGroups} orphan cluster${stats.orphanGroups !== 1 ? "s" : ""}`
                : ""}
            </h3>
          </div>
          {groups.map((group, i) => {
            const groupSummary = summary?.groupSummaries?.find(
              (gs) => gs.groupLabel === group.label
            );
            return (
              <PRCard key={i} group={group} summary={groupSummary ?? null} />
            );
          })}
        </div>
      ) : (
        <div className="text-center py-12 text-neutral-500 text-sm">
          <Clock className="w-8 h-8 mx-auto mb-3 text-neutral-700" />
          No contributions found between{" "}
          <span className="font-mono text-neutral-400">{dateFrom}</span> and{" "}
          <span className="font-mono text-neutral-400">{dateTo}</span>.
          <br />
          <span className="text-xs text-neutral-600 mt-1 block">
            Try a wider date range (e.g. "Last 6 months" or "This year") or select different repos.
          </span>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <div className="bg-neutral-900/40 border border-neutral-800/40 rounded-xl px-4 py-3">
      <div className="flex items-center gap-2 text-neutral-500 mb-1">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="text-2xl font-bold text-neutral-100 font-mono tabular-nums">
        {value.toLocaleString()}
      </p>
      {sub && (
        <p className="text-[10px] text-neutral-500 mt-0.5">{sub}</p>
      )}
    </div>
  );
}
