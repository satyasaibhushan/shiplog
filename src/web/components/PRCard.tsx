import { useState } from "react";
import {
  ChevronDown, ChevronRight, GitPullRequest, GitCommitHorizontal,
  GitMerge, CircleDot, XCircle, FileCode2, Clock,
} from "lucide-react";
import Markdown from "react-markdown";
import type { CommitGroup, GroupSummary } from "../types.ts";
import { DiffViewer } from "./DiffViewer.tsx";

interface Props {
  group: CommitGroup;
  summary: GroupSummary | null;
}

const STATE_COLORS = {
  merged: { bg: "bg-purple-500/10", text: "text-purple-400", border: "border-purple-500/20" },
  open: { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20" },
  closed: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20" },
};

const STATE_ICONS = {
  merged: GitMerge,
  open: CircleDot,
  closed: XCircle,
};

export function PRCard({ group, summary }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);

  const isPR = group.type === "pr" && group.pr;
  const state = group.pr?.state ?? "merged";
  const colors = STATE_COLORS[state] ?? STATE_COLORS.merged;
  const StateIcon = isPR ? STATE_ICONS[state] ?? GitPullRequest : GitCommitHorizontal;

  const commitCount = group.commits.length;
  const fileCount = new Set(group.commits.flatMap((c) => c.files ?? [])).size;

  return (
    <div
      className={`border rounded-xl overflow-hidden transition-colors ${
        expanded
          ? "bg-neutral-900/60 border-neutral-700/50"
          : "bg-neutral-900/30 border-neutral-800/40 hover:border-neutral-700/40"
      }`}
    >
      {/* ── Header ── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-neutral-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-neutral-500 flex-shrink-0" />
        )}

        <StateIcon className={`w-4 h-4 flex-shrink-0 ${colors.text}`} />

        <div className="flex-1 min-w-0">
          {isPR ? (
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-neutral-200 truncate">
                {group.pr!.title}
              </span>
              <span className="text-xs text-neutral-500 font-mono flex-shrink-0">
                #{group.pr!.number}
              </span>
            </div>
          ) : (
            <span className="text-sm font-medium text-neutral-300 truncate block">
              {group.label}
            </span>
          )}
          <div className="flex items-center gap-3 mt-0.5">
            {isPR && (
              <span
                className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${colors.bg} ${colors.text} ${colors.border} border`}
              >
                {state}
              </span>
            )}
            {!isPR && (
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                orphan
              </span>
            )}
            <span className="text-[10px] text-neutral-500 font-mono">
              {commitCount} commit{commitCount !== 1 ? "s" : ""}
            </span>
            {fileCount > 0 && (
              <span className="text-[10px] text-neutral-500 font-mono">
                {fileCount} file{fileCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>

        {summary?.cached && (
          <span className="text-[9px] text-neutral-600 font-mono flex-shrink-0">
            cached
          </span>
        )}
      </button>

      {/* ── Expanded Content ── */}
      {expanded && (
        <div className="border-t border-neutral-800/40">
          {/* Summary */}
          {summary?.summary && !summary.summary.startsWith("[Summarization failed") && (
            <div className="px-4 py-3 border-b border-neutral-800/30">
              <div className="prose-shiplog text-sm">
                <Markdown>{summary.summary}</Markdown>
              </div>
            </div>
          )}

          {/* Commits */}
          <div className="divide-y divide-neutral-800/30">
            {group.commits.map((commit) => {
              const isExpanded = expandedCommit === commit.sha;
              const time = new Date(commit.date).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
              return (
                <div key={commit.sha}>
                  <button
                    onClick={() =>
                      setExpandedCommit(isExpanded ? null : commit.sha)
                    }
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-neutral-800/20 transition-colors group"
                  >
                    <GitCommitHorizontal className="w-3 h-3 text-neutral-600 flex-shrink-0" />
                    <span className="text-[11px] font-mono text-accent/70 flex-shrink-0">
                      {commit.sha.slice(0, 7)}
                    </span>
                    <span className="text-xs text-neutral-300 truncate flex-1">
                      {commit.message}
                    </span>
                    <span className="text-[10px] text-neutral-600 flex-shrink-0 flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />
                      {time}
                    </span>
                    {commit.files && commit.files.length > 0 && (
                      <span className="text-[10px] text-neutral-600 flex-shrink-0 flex items-center gap-0.5">
                        <FileCode2 className="w-2.5 h-2.5" />
                        {commit.files.length}
                      </span>
                    )}
                  </button>

                  {/* Diff */}
                  {isExpanded && commit.diff && (
                    <div className="px-4 pb-3">
                      <DiffViewer diff={commit.diff} />
                    </div>
                  )}

                  {/* File list (when no diff) */}
                  {isExpanded && !commit.diff && commit.files && (
                    <div className="px-4 pb-3">
                      <div className="bg-neutral-950/50 rounded-lg border border-neutral-800/40 p-3">
                        <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-2 font-semibold">
                          Changed files
                        </p>
                        <div className="space-y-0.5">
                          {commit.files.map((f) => (
                            <div
                              key={f}
                              className="text-xs font-mono text-neutral-400"
                            >
                              {f}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
