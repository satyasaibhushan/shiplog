import { describe, expect, it } from "bun:test";
import {
  ContributionsRequestSchema,
  SummaryRequestSchema,
  PersistedSettingsSchema,
  CommitGroupSchema,
} from "../../src/shared/schemas.ts";

describe("ContributionsRequestSchema", () => {
  it("accepts a valid request", () => {
    const result = ContributionsRequestSchema.safeParse({
      repos: ["owner/repo"],
      from: "2024-01-01",
      to: "2024-03-31",
      scope: ["merged-prs", "direct-commits"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed repo names", () => {
    const result = ContributionsRequestSchema.safeParse({
      repos: ["not-a-slash"],
      from: "2024-01-01",
      to: "2024-03-31",
    });
    expect(result.success).toBe(false);
  });

  it("rejects bad date format", () => {
    const result = ContributionsRequestSchema.safeParse({
      repos: ["owner/repo"],
      from: "01/01/2024",
      to: "2024-03-31",
    });
    expect(result.success).toBe(false);
  });

  it("rejects from > to", () => {
    const result = ContributionsRequestSchema.safeParse({
      repos: ["owner/repo"],
      from: "2024-06-01",
      to: "2024-01-01",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty repos", () => {
    const result = ContributionsRequestSchema.safeParse({
      repos: [],
      from: "2024-01-01",
      to: "2024-03-31",
    });
    expect(result.success).toBe(false);
  });
});

describe("SummaryRequestSchema", () => {
  it("rejects when groups is a string", () => {
    const result = SummaryRequestSchema.safeParse({
      groups: "not-an-array",
      from: "2024-01-01",
      to: "2024-03-31",
      repos: ["owner/repo"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty groups", () => {
    const result = SummaryRequestSchema.safeParse({
      groups: [],
      from: "2024-01-01",
      to: "2024-03-31",
      repos: ["owner/repo"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid payload with an orphan group", () => {
    const result = SummaryRequestSchema.safeParse({
      groups: [
        {
          type: "orphan",
          label: "5 commits",
          commits: [
            {
              sha: "abc123",
              message: "fix",
              author: "me",
              date: "2024-01-01T00:00:00Z",
              repo: "owner/repo",
            },
          ],
        },
      ],
      from: "2024-01-01",
      to: "2024-03-31",
      repos: ["owner/repo"],
    });
    expect(result.success).toBe(true);
  });
});

describe("CommitGroupSchema", () => {
  it("accepts a PR group with nested PR", () => {
    const result = CommitGroupSchema.safeParse({
      type: "pr",
      label: "PR #1: fix",
      commits: [],
      pr: {
        id: "owner/repo:1",
        number: 1,
        title: "fix",
        state: "merged",
        repo: "owner/repo",
        createdAt: "2024-01-01T00:00:00Z",
        commits: ["abc123"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown PR state", () => {
    const result = CommitGroupSchema.safeParse({
      type: "pr",
      label: "PR #1",
      commits: [],
      pr: {
        id: "owner/repo:1",
        number: 1,
        title: "fix",
        state: "wat",
        repo: "owner/repo",
        createdAt: "2024-01-01T00:00:00Z",
        commits: [],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("PersistedSettingsSchema", () => {
  it("accepts the minimum fields", () => {
    const result = PersistedSettingsSchema.safeParse({
      selectedRepos: [],
      dateFrom: "2024-01-01",
      dateTo: "2024-03-31",
      scope: ["merged-prs"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects when selectedRepos is not an array", () => {
    const result = PersistedSettingsSchema.safeParse({
      selectedRepos: "foo",
      dateFrom: "2024-01-01",
      dateTo: "2024-03-31",
      scope: ["merged-prs"],
    });
    expect(result.success).toBe(false);
  });
});
