import { useState } from "react";
import {
  FolderGit2, Search, AlertCircle, Loader2, RefreshCw, Check,
  GitFork, Building2,
} from "lucide-react";
import type { ReposResponse, Repo } from "../types.ts";

interface Props {
  repos: ReposResponse | null;
  loading: boolean;
  error: string | null;
  selected: string[];
  onSelectedChange: (repos: string[]) => void;
  onRetry: () => void;
}

export function RepoSelector({
  repos, loading, error, selected, onSelectedChange, onRetry,
}: Props) {
  const [search, setSearch] = useState("");

  const toggle = (fullName: string) => {
    onSelectedChange(
      selected.includes(fullName)
        ? selected.filter((r) => r !== fullName)
        : [...selected, fullName]
    );
  };

  const selectAll = (repoList: Repo[]) => {
    const names = repoList.map((r) => r.fullName);
    const allSelected = names.every((n) => selected.includes(n));
    if (allSelected) {
      onSelectedChange(selected.filter((r) => !names.includes(r)));
    } else {
      onSelectedChange([...new Set([...selected, ...names])]);
    }
  };

  const filterRepos = (list: Repo[]) =>
    search
      ? list.filter(
          (r) =>
            r.fullName.toLowerCase().includes(search.toLowerCase()) ||
            (r.description ?? "").toLowerCase().includes(search.toLowerCase())
        )
      : list;

  return (
    <section>
      <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-3">
        <FolderGit2 className="w-3 h-3" />
        Repositories
        {selected.length > 0 && (
          <span className="ml-auto text-accent tabular-nums">
            {selected.length} selected
          </span>
        )}
      </label>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-neutral-500 py-4 justify-center">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading repos...
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="text-xs text-red-400 bg-red-500/8 rounded-lg px-3 py-2.5 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={onRetry} className="text-neutral-400 hover:text-neutral-200">
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Repo list */}
      {repos && !loading && (
        <>
          {/* Search */}
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-neutral-500" />
            <input
              type="text"
              placeholder="Search repos..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-neutral-800/60 border border-neutral-700/50 rounded-md pl-7 pr-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
            />
          </div>

          <div className="max-h-60 overflow-y-auto space-y-1 pr-0.5">
            {/* Personal repos */}
            {filterRepos(repos.repos).length > 0 && (
              <RepoGroup
                label={repos.username}
                repos={filterRepos(repos.repos)}
                selected={selected}
                onToggle={toggle}
                onSelectAll={() => selectAll(filterRepos(repos.repos))}
              />
            )}

            {/* Org repos */}
            {repos.orgs.map((org) => {
              const filtered = filterRepos(org.repos);
              if (filtered.length === 0) return null;
              return (
                <RepoGroup
                  key={org.login}
                  label={org.login}
                  isOrg
                  repos={filtered}
                  selected={selected}
                  onToggle={toggle}
                  onSelectAll={() => selectAll(filtered)}
                />
              );
            })}

            {/* No results */}
            {search &&
              filterRepos(repos.repos).length === 0 &&
              repos.orgs.every((o) => filterRepos(o.repos).length === 0) && (
                <p className="text-xs text-neutral-500 py-3 text-center">
                  No repos match "{search}"
                </p>
              )}
          </div>
        </>
      )}
    </section>
  );
}

function RepoGroup({
  label, isOrg, repos, selected, onToggle, onSelectAll,
}: {
  label: string;
  isOrg?: boolean;
  repos: Repo[];
  selected: string[];
  onToggle: (name: string) => void;
  onSelectAll: () => void;
}) {
  const allSelected = repos.every((r) => selected.includes(r.fullName));

  return (
    <div className="mb-2">
      <button
        onClick={onSelectAll}
        className="flex items-center gap-1.5 w-full text-[10px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-300 py-1 transition-colors"
      >
        {isOrg ? <Building2 className="w-2.5 h-2.5" /> : null}
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[9px] text-neutral-600">
          {allSelected ? "deselect all" : "select all"}
        </span>
      </button>
      {repos.map((repo) => {
        const isSelected = selected.includes(repo.fullName);
        return (
          <button
            key={repo.fullName}
            onClick={() => onToggle(repo.fullName)}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors group ${
              isSelected
                ? "bg-accent/8 text-neutral-200"
                : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-300"
            }`}
          >
            <div
              className={`w-3.5 h-3.5 rounded flex-shrink-0 flex items-center justify-center border transition-colors ${
                isSelected
                  ? "bg-accent border-accent"
                  : "border-neutral-600 group-hover:border-neutral-500"
              }`}
            >
              {isSelected && <Check className="w-2.5 h-2.5 text-neutral-950" strokeWidth={3} />}
            </div>
            <span className="truncate font-medium">{repo.name}</span>
            {repo.isForked && <GitFork className="w-2.5 h-2.5 text-neutral-600 flex-shrink-0" />}
            {repo.language && (
              <span className="ml-auto text-[10px] text-neutral-600 flex-shrink-0">
                {repo.language}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
