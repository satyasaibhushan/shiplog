import { describe, expect, it } from "bun:test";
import { remapPullRequestCommits, type DedupResult } from "../../src/core/dedup.ts";
import type { Commit, PullRequest } from "../../src/core/github.ts";

function commit(sha: string, overrides: Partial<Commit> = {}): Commit {
  return {
    sha,
    message: `commit ${sha}`,
    author: "alice",
    date: "2026-01-01T00:00:00Z",
    repo: "owner/repo",
    ...overrides,
  };
}

function pr(num: number, shas: string[]): PullRequest {
  return {
    id: `owner/repo:${num}`,
    number: num,
    title: `PR #${num}`,
    state: "merged",
    repo: "owner/repo",
    mergedAt: "2026-01-02T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    commits: shas,
  };
}

function dedup(unique: Commit[], duplicates: Map<string, string[]>): DedupResult {
  const removed = [...duplicates.values()].reduce((n, s) => n + s.length - 1, 0);
  return { unique, duplicates, totalRemoved: removed };
}

describe("remapPullRequestCommits", () => {
  it("remaps a dropped duplicate SHA to the kept SHA", () => {
    const unique = [commit("aaa")];
    const duplicates = new Map<string, string[]>([["patch1", ["aaa", "bbb"]]]);
    const prs = [pr(1, ["bbb"])];

    const { pullRequests, emptiedPrCount } = remapPullRequestCommits(prs, dedup(unique, duplicates));

    expect(pullRequests[0]!.commits).toEqual(["aaa"]);
    expect(emptiedPrCount).toBe(0);
  });

  it("drops SHAs that are not in the unique commit set at all", () => {
    const unique = [commit("aaa")];
    const duplicates = new Map<string, string[]>();
    const prs = [pr(1, ["aaa", "ghost-sha"])];

    const { pullRequests } = remapPullRequestCommits(prs, dedup(unique, duplicates));

    expect(pullRequests[0]!.commits).toEqual(["aaa"]);
  });

  it("counts PRs that end up empty after dedup/filter", () => {
    const unique = [commit("aaa")];
    const duplicates = new Map<string, string[]>();
    const prs = [pr(1, ["ghost-1", "ghost-2"])];

    const { emptiedPrCount } = remapPullRequestCommits(prs, dedup(unique, duplicates));

    expect(emptiedPrCount).toBe(1);
  });

  it("does not count PRs that were already empty", () => {
    const unique = [commit("aaa")];
    const duplicates = new Map<string, string[]>();
    const prs = [pr(1, [])];

    const { emptiedPrCount } = remapPullRequestCommits(prs, dedup(unique, duplicates));

    expect(emptiedPrCount).toBe(0);
  });

  it("deduplicates SHAs after remap (two dropped SHAs collapse to same kept SHA)", () => {
    const unique = [commit("aaa")];
    const duplicates = new Map<string, string[]>([["patch1", ["aaa", "bbb", "ccc"]]]);
    const prs = [pr(1, ["bbb", "ccc"])];

    const { pullRequests } = remapPullRequestCommits(prs, dedup(unique, duplicates));

    expect(pullRequests[0]!.commits).toEqual(["aaa"]);
  });

  it("skips remap when no kept SHA survives in unique", () => {
    // All SHAs in the duplicate set were pruned (shouldn't happen in practice
    // but the helper must not crash).
    const unique: Commit[] = [];
    const duplicates = new Map<string, string[]>([["patch1", ["aaa", "bbb"]]]);
    const prs = [pr(1, ["aaa", "bbb"])];

    const { pullRequests, emptiedPrCount } = remapPullRequestCommits(prs, dedup(unique, duplicates));

    expect(pullRequests[0]!.commits).toEqual([]);
    expect(emptiedPrCount).toBe(1);
  });
});
