// Frontend type definitions — mirrors API response shapes

export type {
  GenerationProgress,
  GenerationStepId,
} from "../shared/progress.ts";
export {
  GENERATION_STEPS,
  TOTAL_GENERATION_STEPS,
} from "../shared/progress.ts";

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
  email: string | null;
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
  stats?: {
    additions: number;
    deletions: number;
    files: number;
    truncated?: boolean;
  };
  /** True for merge commits (≥2 parents). Excluded from diff-size aggregations. */
  isMerge?: boolean;
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
  /** PR-level diff size from GitHub (base...head). Undefined for legacy cached PRs. */
  stats?: {
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  /** True if the PR was opened by someone else but includes the user's commits. */
  openedByOther?: boolean;
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

// ── Atlas workspace types ─────────────────────────────────────────────────

export type SummaryParentKind = "log" | "rollup" | "pr" | "orphan";

export interface StaleInfo {
  reason: string;
  detectedAt: number;
}

export interface LogRecord {
  id: string;
  owner: string;
  repo: string;
  authorEmail: string;
  rangeStart: string;
  rangeEnd: string;
  title?: string;
  activeVersionId?: string;
  createdAt: number;
  updatedAt: number;
  stale?: StaleInfo | null;
  headline?: string | null;
  stats?: SummaryStats | null;
}

export interface RollupRecord {
  id: string;
  title: string;
  authorEmail: string;
  rangeStart: string;
  rangeEnd: string;
  logIds: string[];
  activeVersionId?: string;
  createdAt: number;
  updatedAt: number;
  stale?: StaleInfo | null;
  headline?: string | null;
  stats?: SummaryStats | null;
}

export interface TimelineEntry {
  date: string;
  additions: number;
  deletions: number;
  prCount: number;
  commitCount: number;
  topPRTitles: string[];
}

export interface SummaryStats {
  additions: number;
  deletions: number;
  files: number;
  commits: number;
  prs?: number;
  truncated?: boolean;
}

export interface SummaryVersionRecord {
  id: string;
  parentKind: SummaryParentKind;
  parentId: string;
  versionNumber: number;
  summaryMarkdown: string;
  timeline?: TimelineEntry[];
  stats?: SummaryStats;
  source: "generated" | "chat";
  chatPrompt?: Record<string, unknown>;
  model: string;
  createdAt: number;
}

export interface AtlasResponse {
  logs: LogRecord[];
  rollups: RollupRecord[];
  recent: LogRecord[];
}

export interface LogDetailResponse {
  log: LogRecord;
  activeVersion: SummaryVersionRecord | null;
  versions: SummaryVersionRecord[];
}

export interface RollupDetailResponse {
  rollup: RollupRecord;
  activeVersion: SummaryVersionRecord | null;
  versions: SummaryVersionRecord[];
}

export type AtlasView =
  | { name: "atlas" }
  | { name: "repo"; owner: string; repo: string }
  | { name: "log"; id: string }
  | { name: "rollup"; id: string };
