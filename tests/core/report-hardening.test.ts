import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportWindow, dateWindow, inWindow } from "../../src/core/report-period.ts";
import { generateLog, generateRollup, type ReportAdapters } from "../../src/core/report.ts";
import {
  generateTaskFinderReport,
  generateTaskFinderRollup,
  TaskFinderSnapshotSchema,
} from "../../src/core/taskfinder-report.ts";
import { initDb, closeDb } from "../../src/core/cache.ts";
import {
  appendSummaryVersion,
  getLog,
  listLogs,
  listRollups,
  listVersions,
  setLogActiveVersion,
} from "../../src/core/entities.ts";
import fixture from "../fixtures/taskfinder-synthetic.json";
const root = mkdtempSync(join(tmpdir(), "shiplog-report-hardening-"));
const before = { config: process.env.SHIPLOG_CONFIG_DIR, data: process.env.SHIPLOG_DATA_DIR };
beforeEach(() => {
  closeDb();
  process.env.SHIPLOG_CONFIG_DIR = join(root, "config");
  process.env.SHIPLOG_DATA_DIR = join(root, "data");
  rmSync(root, { recursive: true, force: true });
  initDb();
});
afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
  if (before.config === undefined) delete process.env.SHIPLOG_CONFIG_DIR;
  else process.env.SHIPLOG_CONFIG_DIR = before.config;
  if (before.data === undefined) delete process.env.SHIPLOG_DATA_DIR;
  else process.env.SHIPLOG_DATA_DIR = before.data;
});
test("Kolkata half-open midnight, calendar week, leap-month and year boundaries", () => {
  const a = reportWindow("daily", new Date("2026-09-30T18:29:59Z"));
  const b = reportWindow("daily", new Date("2026-09-30T18:30:00Z"));
  expect(a.from).toBe("2026-09-30");
  expect(b.from).toBe("2026-10-01");
  expect(inWindow("2026-09-30T18:30:00Z", a)).toBe(false);
  expect(inWindow("2026-09-30T18:30:00Z", b)).toBe(true);
  expect(reportWindow("weekly", new Date("2027-01-01T00:00:00Z"))).toMatchObject({
    from: "2026-12-28",
    to: "2027-01-03",
  });
  expect(reportWindow("monthly", new Date("2024-02-15T00:00:00Z"))).toMatchObject({
    from: "2024-02-01",
    to: "2024-02-29",
    endExclusive: "2024-02-29T18:30:00.000Z",
  });
  expect(reportWindow("monthly", new Date("2026-12-31T18:30:00Z"))).toMatchObject({
    from: "2027-01-01",
    to: "2027-01-31",
  });
  expect(() => dateWindow("2026-02-30", "2026-03-01")).toThrow();
});
test("snapshot retries reuse entities/versions, preserve attribution, and never infer deployment", async () => {
  const day = reportWindow("daily", new Date(fixture.source.capturedAt));
  const [a, b] = await Promise.all([
    generateTaskFinderReport(fixture, day, "fixture@example.test"),
    generateTaskFinderReport(fixture, day, "fixture@example.test"),
  ]);
  expect(a.map((e) => e.log.id)).toEqual(b.map((e) => e.log.id));
  expect(listLogs()).toHaveLength(2);
  const task = a.find((e) => e.log.repo === "synthetic-sso")!;
  expect(task.log.activeVersionId).toBe(task.version.id);
  expect(task.version.summaryMarkdown).toContain("Contribution: team");
  expect(task.version.summaryMarkdown).toContain("Latency improvement: unknown");
  expect(task.version.summaryMarkdown).toContain("no UAT, QA or live verification");
  expect(task.version.summaryMarkdown).toContain("synthetic-evidence-1");
  await generateTaskFinderReport(fixture, day, "fixture@example.test");
  expect(listVersions("log", task.log.id)).toHaveLength(1);
  const changed = structuredClone(fixture);
  changed.tasks[0]!.evidence[0]!.caveat = "QA still pending; correction";
  const c = await generateTaskFinderReport(changed, day, "fixture@example.test");
  expect(c.find((e) => e.log.id === task.log.id)!.version.versionNumber).toBe(2);
  expect(listLogs()).toHaveLength(2);
});
test("weekly/monthly use active daily versions; membership and identical retries stay stable", async () => {
  const day = reportWindow("daily", new Date(fixture.source.capturedAt));
  const entries = await generateTaskFinderReport(fixture, day, "fixture@example.test");
  const first = entries[0]!;
  const newer = await appendSummaryVersion({
    parentKind: "log",
    parentId: first.log.id,
    summaryMarkdown: "Explicitly selected active correction",
    source: "chat",
    model: "fixture",
    chatPrompt: { userMessage: "Explicit correction" },
  });
  const month = reportWindow("monthly", new Date(fixture.source.capturedAt));
  const result = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    month,
    "fixture@example.test",
  );
  expect(result.version.summaryMarkdown).toContain("Explicitly selected active correction");
  expect(result.version.chatPrompt?.sourceVersions).toContainEqual({
    logId: first.log.id,
    versionId: newer.id,
  });
  const again = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    month,
    "fixture@example.test",
  );
  expect(again.version.id).toBe(result.version.id);
  await setLogActiveVersion(first.log.id, first.version.id);
  const reverted = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    month,
    "fixture@example.test",
  );
  expect(reverted.rollup.id).toBe(result.rollup.id);
  expect(reverted.version.versionNumber).toBe(2);
  expect(listRollups()).toHaveLength(1);
  const nextDay = reportWindow("daily", new Date("2026-10-02T12:00:00Z"));
  await generateTaskFinderReport(fixture, nextDay, "fixture@example.test");
  const expanded = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    month,
    "fixture@example.test",
  );
  expect(expanded.rollup.id).toBe(result.rollup.id);
  expect(expanded.rollup.logIds).toHaveLength(4);
  const week = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    reportWindow("weekly", new Date(fixture.source.capturedAt)),
    "fixture@example.test",
  );
  expect(week.rollup.id).not.toBe(result.rollup.id);
});
test("snapshot schema rejects orphan IDs and unsupported verified metric claims", () => {
  const bad = structuredClone(fixture);
  bad.tasks[0]!.projectId = "missing";
  expect(TaskFinderSnapshotSchema.safeParse(bad).success).toBe(false);
  const duplicate = structuredClone(fixture);
  duplicate.tasks.push(duplicate.tasks[0]!);
  expect(TaskFinderSnapshotSchema.safeParse(duplicate).success).toBe(false);
  const unsupported = structuredClone(fixture);
  unsupported.tasks[0]!.metrics = [{ name: "Claimed gain", value: null, unit: "%", verification: "verified", evidenceIds: [] }];
  expect(TaskFinderSnapshotSchema.safeParse(unsupported).success).toBe(false);
});
test("generated logs return active records; rollups re-read active versions, dedup, and reuse identical results", async () => {
  let called = 0;
  const adapters: ReportAdapters = {
    fetch: async (p) => {
      expect(p.from).toBe("2026-09-29T18:30:00.000Z");
      return { commits: [], pullRequests: [], stats: {} } as Awaited<
        ReturnType<NonNullable<ReportAdapters["fetch"]>>
      >;
    },
    summarize: async () => ({
      rollupSummary: "Synthetic summary",
      timeline: [],
      aggregateStats: { additions: 2, deletions: 0, files: 1, commits: 1, prs: 0 },
      groupSummaries: [],
      provider: "codex-cli",
      stats: { groupsProcessed: 0, cacheHits: 0, llmCalls: 0, totalDuration: 0 },
    }),
  };
  const input = {
    owner: "fixture",
    repo: "repo",
    rangeStart: "2026-09-30",
    rangeEnd: "2026-09-30",
    timezone: "Asia/Kolkata" as const,
    provider: "codex-cli" as const,
    model: "mock",
  };
  const a = await generateLog(input, adapters);
  const b = await generateLog(input, adapters);
  expect(a!.log.activeVersionId).toBe(a!.version.id);
  expect(b!.log.id).toBe(a!.log.id);
  expect(b!.version.id).toBe(a!.version.id);
  const stale = { ...a!.log, activeVersionId: undefined };
  const roll = {
    title: "Test rollup",
    logs: [stale, stale],
    provider: "codex-cli" as const,
    model: "mock",
  };
  const mockModel = async (prompt: string) => {
    called++;
    expect(prompt).toContain("Synthetic summary");
    return "Mock rollup";
  };
  const r = await generateRollup(roll, mockModel);
  const rr = await generateRollup(roll, mockModel);
  expect(r.rollup.activeVersionId).toBe(r.version.id);
  expect(rr.version.id).toBe(r.version.id);
  expect(called).toBe(1);
  expect(r.version.stats?.commits).toBe(1);
  expect(getLog(a!.log.id)?.activeVersionId).toBe(a!.version.id);
  await expect(generateRollup({ ...roll, logs: [] }, mockModel)).rejects.toThrow();
});
