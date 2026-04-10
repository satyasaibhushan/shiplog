// PR grouping + orphan clustering
// TODO: Implement in Phase 3

import type { Commit, PullRequest } from "./github.ts";

export interface CommitGroup {
  type: "pr" | "orphan";
  label: string;
  commits: Commit[];
  pr?: PullRequest;
}

export function groupCommits(
  _commits: Commit[],
  _prs: PullRequest[],
): CommitGroup[] {
  // TODO: Group commits under PRs and cluster orphans
  return [];
}
