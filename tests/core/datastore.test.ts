import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP = mkdtempSync(join(tmpdir(), "shiplog-datastore-"));
process.env.SHIPLOG_DATA_DIR = TMP;

// Import after env var is set so getDataDir() picks it up on first call.
const {
  splitRepo,
  slugSegment,
  slugHash,
  prPath,
  summaryPath,
  writePR,
  readPR,
  writeSummary,
  readSummary,
} = await import("../../src/core/datastore.ts");

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("splitRepo / slugSegment / slugHash", () => {
  it("splits owner/repo into path-safe segments", () => {
    expect(splitRepo("anthropics/claude-code")).toEqual([
      "anthropics",
      "claude-code",
    ]);
  });

  it("sanitizes unsafe characters inside each segment", () => {
    expect(slugSegment("user.name")).toBe("user.name");
    expect(slugSegment("weird name")).toBe("weird_name");
  });

  it("throws on malformed repo strings", () => {
    expect(() => splitRepo("no-slash")).toThrow();
    expect(() => splitRepo("/missing-owner")).toThrow();
    expect(() => splitRepo("missing-name/")).toThrow();
  });

  it("sanitizes hashes with only safe chars", () => {
    expect(slugHash("owner/repo:42")).toBe("owner_repo_42");
    expect(slugHash("orphan:abcdef1234")).toBe("orphan_abcdef1234");
    expect(slugHash("rollup:ABC-123.json")).toBe("rollup_ABC-123.json");
  });
});

describe("path routing", () => {
  it("routes single-repo PR summaries under repos/<owner>/<repo>/summaries/<number>.json", () => {
    const p = summaryPath({ repos: ["foo/bar"] }, "pr", "foo/bar:125");
    expect(p).toBe(join(TMP, "repos", "foo", "bar", "summaries", "125.json"));
  });

  it("routes single-repo orphans under repos/<owner>/<repo>/orphans/<hash>.json", () => {
    const p = summaryPath({ repos: ["foo/bar"] }, "orphan", "orphan:abc123");
    expect(p).toBe(join(TMP, "repos", "foo", "bar", "orphans", "abc123.json"));
  });

  it("routes single-repo rollups under repos/<owner>/<repo>/rollups/<hash>.json", () => {
    const p = summaryPath({ repos: ["foo/bar"] }, "rollup", "rollup:def456");
    expect(p).toBe(join(TMP, "repos", "foo", "bar", "rollups", "def456.json"));
  });

  it("routes multi-repo summaries to the top-level summaries/", () => {
    const p = summaryPath(
      { repos: ["foo/bar", "baz/qux"] },
      "orphan",
      "orphan:xyz",
    );
    expect(p).toBe(join(TMP, "summaries", "xyz.json"));
  });

  it("routes multi-repo rollups to the top-level rollups/", () => {
    const p = summaryPath(
      { repos: ["foo/bar", "baz/qux"] },
      "rollup",
      "rollup:xyz",
    );
    expect(p).toBe(join(TMP, "rollups", "xyz.json"));
  });

  it("puts PR metadata under repos/<owner>/<repo>/prs/<number>.json", () => {
    expect(prPath("foo/bar", 42)).toBe(
      join(TMP, "repos", "foo", "bar", "prs", "42.json"),
    );
  });
});

describe("PR round-trip", () => {
  it("writes then reads back the stored PR", async () => {
    const pr = {
      id: "foo/bar:1",
      number: 1,
      repo: "foo/bar",
      title: "Test PR",
      state: "merged" as const,
      mergedAt: "2026-04-20T00:00:00Z",
      createdAt: "2026-04-19T00:00:00Z",
      commits: ["abc", "def"],
    };
    await writePR(pr);
    const got = await readPR("foo/bar", 1);
    expect(got).toEqual(pr);
  });

  it("returns null for a missing PR", async () => {
    expect(await readPR("foo/bar", 9999)).toBeNull();
  });
});

describe("summary round-trip", () => {
  it("stores and retrieves a single-repo orphan summary", async () => {
    const s = {
      contentHash: "orphan:abc123",
      summaryType: "orphan" as const,
      scope: { repos: ["anthropics/claude-code"] },
      source: { commitShas: ["sha1", "sha2"] },
      summary: "Did things.",
      provider: "claude",
      createdAt: "2026-04-20T00:00:00Z",
    };
    await writeSummary(s);
    const got = await readSummary(s.scope, s.summaryType, s.contentHash);
    expect(got).toEqual(s);
  });

  it("stores and retrieves a multi-repo summary", async () => {
    const s = {
      contentHash: "xrepo:def456",
      summaryType: "orphan" as const,
      scope: { repos: ["a/b", "c/d"] },
      summary: "Cross-repo work.",
      provider: "claude",
      createdAt: "2026-04-20T00:00:00Z",
    };
    await writeSummary(s);
    const got = await readSummary(s.scope, s.summaryType, s.contentHash);
    expect(got).toEqual(s);
  });

  it("returns null when a summary isn't present", async () => {
    expect(
      await readSummary({ repos: ["no/repo"] }, "pr", "nope"),
    ).toBeNull();
  });
});

describe("rollup round-trip", () => {
  it("stores and retrieves a single-repo rollup", async () => {
    const r = {
      contentHash: "rollup:single",
      summaryType: "rollup" as const,
      scope: { repos: ["a/b"] },
      summary: "Single-repo period summary.",
      provider: "codex",
      createdAt: "2026-04-20T00:00:00Z",
    };
    await writeSummary(r);
    const got = await readSummary(r.scope, r.summaryType, r.contentHash);
    expect(got).toEqual(r);
  });

  it("stores and retrieves a multi-repo rollup", async () => {
    const r = {
      contentHash: "rollup:xyz",
      summaryType: "rollup" as const,
      scope: { repos: ["a/b", "c/d", "e/f"] },
      summary: "Period summary.",
      provider: "codex",
      createdAt: "2026-04-20T00:00:00Z",
    };
    await writeSummary(r);
    const got = await readSummary(r.scope, r.summaryType, r.contentHash);
    expect(got).toEqual(r);
  });
});
