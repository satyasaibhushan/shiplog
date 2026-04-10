// GitHub data fetching via gh CLI
// TODO: Implement in Phase 2

export interface Repo {
  name: string;
  owner: string;
  fullName: string;
  isForked: boolean;
  org?: string;
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
  number: number;
  title: string;
  state: "merged" | "open" | "closed";
  repo: string;
  mergedAt?: string;
  createdAt: string;
  commits: string[]; // commit SHAs
}

export async function listRepos(): Promise<Repo[]> {
  // TODO: gh api /user/repos
  return [];
}

export async function fetchCommits(
  _repo: string,
  _from: string,
  _to: string,
): Promise<Commit[]> {
  // TODO: gh api commits in date range
  return [];
}

export async function fetchPullRequests(
  _repo: string,
  _from: string,
  _to: string,
): Promise<PullRequest[]> {
  // TODO: gh api PRs in date range
  return [];
}
