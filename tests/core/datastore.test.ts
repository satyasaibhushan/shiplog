import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP = mkdtempSync(join(tmpdir(), "shiplog-datastore-"));
process.env.SHIPLOG_DATA_DIR = TMP;

// Import after env var is set so getDataDir() picks it up on first call.
const {
  slugRepo,
  slugHash,
  prPath,
  summaryPath,
  rollupPath,
  writePR,
  readPR,
  writeSummary,
  readSummary,
  writeRollup,
  readRollup,
} = await import("../../src/core/datastore.ts");

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("slugRepo / slugHash", () => {
  it("replaces / with __ for directory safety", () => {
    expect(slugRepo("anthropics/claude-code")).toBe("anthropics__claude-code");
  });

  it("sanitizes hashes with only safe chars", () => {
    expect(slugHash("owner/repo:42")).toBe("owner_repo_42");
    expect(slugHash("orphan:abcdef1234")).toBe("orphan_abcdef1234");
    expect(slugHash("rollup:ABC-123.json")).toBe("rollup_ABC-123.json");
  });
});

describe("path routing", () => {
  it("routes single-repo summaries under repos/<repo>/summaries/", () => {
    const p = summaryPath({ repos: ["foo/bar"] }, "orphan:abc");
    expect(p).toBe(join(TMP, "repos", "foo__bar", "summaries", "orphan_abc.json"));
  });

  it("routes multi-repo summaries to the top-level summaries/", () => {
    const p = summaryPath({ repos: ["foo/bar", "baz/qux"] }, "multi:xyz");
    expect(p).toBe(join(TMP, "summaries", "multi_xyz.json"));
  });

  it("puts rollups under rollups/ regardless of repo count", () => {
    expect(rollupPath("rollup:abc")).toBe(join(TMP, "rollups", "rollup_abc.json"));
  });

  it("puts PR metadata under repos/<repo>/prs/<number>.json", () => {
    expect(prPath("foo/bar", 42)).toBe(join(TMP, "repos", "foo__bar", "prs", "42.json"));
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
  it("stores and retrieves a single-repo summary", async () => {
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
    const got = await readSummary(s.scope, s.contentHash);
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
    const got = await readSummary(s.scope, s.contentHash);
    expect(got).toEqual(s);
  });

  it("returns null when a summary isn't present", async () => {
    expect(await readSummary({ repos: ["no/repo"] }, "nope")).toBeNull();
  });
});

describe("rollup round-trip", () => {
  it("stores and retrieves a rollup regardless of scope", async () => {
    const r = {
      contentHash: "rollup:xyz",
      summaryType: "rollup" as const,
      scope: { repos: ["a/b", "c/d", "e/f"] },
      summary: "Period summary.",
      provider: "codex",
      createdAt: "2026-04-20T00:00:00Z",
    };
    await writeRollup(r);
    const got = await readRollup("rollup:xyz");
    expect(got).toEqual(r);
  });
});
