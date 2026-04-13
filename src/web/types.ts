// Frontend type definitions — mirrors API response shapes

export interface Repo {
  name: string;
  owner: string;
  fullName: string;
  isForked: boolean;
  org?: string;
  description?: string;
  language?: string;
  updatedAt?: string;
  /** If this org repo has a personal fork, this is the fork's fullName */
  forkFullName?: string;
}

export interface OrgWithRepos {
  login: string;
  description?: string;
  repos: Repo[];
}

export interface ReposResponse {
  username: string;
  repos: Repo[];
  orgs: OrgWithRepos[];
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
  repo: string;
  diff?: string;
  files?: string[];
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  state: "merged" | "open" | "closed";
  repo: string;
  mergedAt?: string;
  createdAt: string;
  commits: string[];
}

export interface CommitGroup {
  type: "pr" | "orphan";
  label: string;
  commits: Commit[];
  pr?: PullRequest;
}

export interface ContributionsResponse {
  groups: CommitGroup[];
  commits: Commit[];
  pullRequests: PullRequest[];
  stats: {
    totalCommits: number;
    totalPRs: number;
    mergedPRs: number;
    openPRs: number;
    closedPRs: number;
    reposProcessed: number;
    filesChanged: number;
    cachedCommits: number;
    fetchedCommits: number;
    duplicatesRemoved: number;
    uniqueCommits: number;
    prGroups: number;
    orphanGroups: number;
    orphanCommits: number;
    commitsInPRs: number;
  };
}

export interface GroupSummary {
  groupLabel: string;
  groupType: "pr" | "orphan";
  summary: string;
  contentHash: string;
  cached: boolean;
}

export interface SummarizationResult {
  groupSummaries: GroupSummary[];
  rollupSummary: string;
  provider: string;
  stats: {
    groupsProcessed: number;
    cacheHits: number;
    llmCalls: number;
    totalDuration: number;
  };
}

export interface SummarizationProgress {
  phase: "map" | "reduce" | "complete" | "error";
  current: number;
  total: number;
  groupLabel?: string;
  cached?: boolean;
  error?: string;
}

export type AppPhase =
  | "idle"
  | "fetching"
  | "fetched"
  | "summarizing"
  | "done"
  | "error";

export const SCOPE_OPTIONS = [
  { value: "merged-prs", label: "Merged PRs", description: "Completed, shipped work" },
  { value: "open-prs", label: "Open PRs", description: "Work in progress" },
  { value: "closed-prs", label: "Closed PRs", description: "Abandoned / rejected" },
  { value: "direct-commits", label: "Direct commits", description: "Pushes without a PR" },
] as const;

export const DATE_PRESETS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "This quarter", days: 90 },
  { label: "Last 6 months", days: 180 },
  { label: "This year", days: 365 },
] as const;
