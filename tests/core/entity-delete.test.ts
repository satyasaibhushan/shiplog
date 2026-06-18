import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiplog-entity-delete-"));
const HOME_DIR = join(TMP_ROOT, "home");
const DATA_DIR = join(TMP_ROOT, "data");
const CONFIG_DIR = join(TMP_ROOT, "config");

process.env.HOME = HOME_DIR;
process.env.SHIPLOG_DATA_DIR = DATA_DIR;
process.env.SHIPLOG_CONFIG_DIR = CONFIG_DIR;

const { closeDb, initDb } = await import("../../src/core/cache.ts");
const {
  appendSummaryVersion,
  createLog,
  createRollup,
  deleteLog,
  deleteRollup,
  getLog,
  getRollup,
  getStale,
  listVersions,
} = await import("../../src/core/entities.ts");
const {
  readLog,
  readRollupEntity,
  readSummaryVersion,
} = await import("../../src/core/datastore.ts");

afterAll(() => {
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("entity deletion", () => {
  beforeEach(() => {
    closeDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    initDb();
  });

  it("deleteLog removes the log, its versions, and flags parent rollups stale", async () => {
    const log = await createLog({
      owner: "acme",
      repo: "widget",
      authorEmail: "dev@acme.test",
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
      title: "January",
    });
    const v1 = await appendSummaryVersion({
      parentKind: "log",
      parentId: log.id,
      summaryMarkdown: "# January\n\nShipped the widget.",
      source: "generated",
      model: "codex",
    });

    // A rollup that depends on this log should be marked stale on delete.
    const rollup = await createRollup({
      title: "Q1",
      authorEmail: "dev@acme.test",
      rangeStart: "2026-01-01",
      rangeEnd: "2026-03-31",
      logIds: [log.id],
    });

    expect(getLog(log.id)).not.toBeNull();
    expect(await readLog(log.id)).not.toBeNull();
    expect(listVersions("log", log.id)).toHaveLength(1);
    expect(await readSummaryVersion("log", log.id, v1.versionNumber)).not.toBeNull();

    const removed = await deleteLog(log.id);
    expect(removed).toBe(true);

    expect(getLog(log.id)).toBeNull();
    expect(await readLog(log.id)).toBeNull();
    expect(listVersions("log", log.id)).toHaveLength(0);
    expect(await readSummaryVersion("log", log.id, v1.versionNumber)).toBeNull();

    // Parent rollup flagged stale so the UI prompts a regeneration.
    expect(getStale("rollup", rollup.id)?.reason).toBe("dep_regenerated");
  });

  it("deleteLog returns false when the log is already gone", async () => {
    expect(await deleteLog("log_does_not_exist")).toBe(false);
  });

  it("deleteRollup removes the rollup and its versions but keeps member logs", async () => {
    const log = await createLog({
      owner: "acme",
      repo: "widget",
      authorEmail: "dev@acme.test",
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
    });
    const rollup = await createRollup({
      title: "Q1",
      authorEmail: "dev@acme.test",
      rangeStart: "2026-01-01",
      rangeEnd: "2026-03-31",
      logIds: [log.id],
    });
    const rv = await appendSummaryVersion({
      parentKind: "rollup",
      parentId: rollup.id,
      summaryMarkdown: "# Q1\n\nCross-repo narrative.",
      source: "generated",
      model: "codex",
    });

    expect(getRollup(rollup.id)).not.toBeNull();
    expect(await readRollupEntity(rollup.id)).not.toBeNull();
    expect(await readSummaryVersion("rollup", rollup.id, rv.versionNumber)).not.toBeNull();

    const removed = await deleteRollup(rollup.id);
    expect(removed).toBe(true);

    expect(getRollup(rollup.id)).toBeNull();
    expect(await readRollupEntity(rollup.id)).toBeNull();
    expect(listVersions("rollup", rollup.id)).toHaveLength(0);
    expect(await readSummaryVersion("rollup", rollup.id, rv.versionNumber)).toBeNull();

    // Member log is untouched.
    expect(getLog(log.id)).not.toBeNull();
  });

  it("deleteRollup returns false when the rollup is already gone", async () => {
    expect(await deleteRollup("rollup_does_not_exist")).toBe(false);
  });
});
