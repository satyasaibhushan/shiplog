import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiplog-summary-cache-"));
const HOME_DIR = join(TMP_ROOT, "home");
const DATA_DIR = join(TMP_ROOT, "data");

process.env.HOME = HOME_DIR;
process.env.SHIPLOG_DATA_DIR = DATA_DIR;

const { closeDb, getDb, initDb } = await import("../../src/core/cache.ts");
const schema = await import("../../src/db/schema.ts");
const { readSummary, writeSummary } = await import("../../src/core/datastore.ts");
const {
  getCachedSummaryRow,
  invalidateCachedSummary,
} = await import("../../src/core/summarizer.ts");

afterAll(() => {
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("summary cache invalidation", () => {
  beforeEach(() => {
    closeDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(join(HOME_DIR, ".shiplog"), { recursive: true, force: true });
    initDb();
  });

  it("removes both sqlite and datastore copies", async () => {
    const entry = {
      contentHash: "anthropics/claude-code:125",
      summaryType: "pr" as const,
      scope: { repos: ["anthropics/claude-code"] },
      source: { prNumber: 125 },
      summary: "Refined auth flow and tightened error handling.",
      provider: "codex",
      createdAt: "2026-06-17T00:00:00.000Z",
    };

    getDb().insert(schema.summaries)
      .values({
        contentHash: entry.contentHash,
        summaryType: entry.summaryType,
        summary: entry.summary,
        provider: entry.provider,
      })
      .run();
    await writeSummary(entry);

    expect(getCachedSummaryRow(entry.contentHash)).toEqual({
      summary: entry.summary,
      provider: entry.provider,
    });
    expect(
      await readSummary(entry.scope, entry.summaryType, entry.contentHash),
    ).toEqual(entry);

    await invalidateCachedSummary({
      contentHash: entry.contentHash,
      summaryType: entry.summaryType,
      scope: entry.scope,
    });

    expect(getCachedSummaryRow(entry.contentHash)).toBeNull();
    expect(
      await readSummary(entry.scope, entry.summaryType, entry.contentHash),
    ).toBeNull();
  });
});