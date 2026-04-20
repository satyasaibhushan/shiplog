import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Route both the data dir and the user config dir into a scratch space so we
// don't touch the real ~/.shiplog.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiplog-sharedcfg-"));
const DATA_DIR = join(TMP_ROOT, "data");
const HOME_DIR = join(TMP_ROOT, "home");

process.env.SHIPLOG_DATA_DIR = DATA_DIR;
process.env.HOME = HOME_DIR;

const {
  DEFAULT_CONFIG,
  DEFAULT_SYNC_CONFIG,
  saveConfig,
  loadConfig,
  mergeSharedConfig,
  getSharedConfigPath,
} = await import("../../src/cli/config.ts");

const { __resetForTests, __pendingCount, setSyncConfig } = await import(
  "../../src/core/git-sync.ts"
);

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

describe("shared config sync", () => {
  beforeEach(() => {
    __resetForTests();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(HOME_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
  });

  it("saveConfig does not write shared file when sync is disabled", async () => {
    await saveConfig({ ...DEFAULT_CONFIG, theme: "light" });
    expect(existsSync(getSharedConfigPath())).toBe(false);
  });

  it("saveConfig writes shared file and queues it when sync is enabled", async () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      theme: "light" as const,
      sync: { ...DEFAULT_SYNC_CONFIG, enabled: true },
    };
    setSyncConfig(cfg.sync);
    await saveConfig(cfg);

    expect(existsSync(getSharedConfigPath())).toBe(true);
    const shared = JSON.parse(
      await Bun.file(getSharedConfigPath()).text(),
    );
    expect(shared.theme).toBe("light");
    // `sync` is per-machine and must not leak into the shared file.
    expect(shared.sync).toBeUndefined();
    expect(__pendingCount()).toBeGreaterThan(0);
  });

  it("mergeSharedConfig overlays shared fields and preserves local sync", async () => {
    // Pretend another machine wrote this shared config.
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      getSharedConfigPath(),
      JSON.stringify({
        llm: "claude",
        defaultScope: ["merged-prs"],
        excludePatterns: [],
        gitEmails: ["other@example.com"],
        port: 9000,
        theme: "light",
      }),
    );

    const local = {
      ...DEFAULT_CONFIG,
      sync: {
        ...DEFAULT_SYNC_CONFIG,
        enabled: true,
        remoteUrl: "https://example.com/my-data.git",
      },
    };
    setSyncConfig(local.sync);

    const merged = await mergeSharedConfig(local);
    expect(merged.theme).toBe("light");
    expect(merged.port).toBe(9000);
    expect(merged.gitEmails).toEqual(["other@example.com"]);
    // Per-machine fields preserved
    expect(merged.sync.enabled).toBe(true);
    expect(merged.sync.remoteUrl).toBe("https://example.com/my-data.git");
  });

  it("mergeSharedConfig is a no-op when shared file is missing", async () => {
    const local = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_SYNC_CONFIG, enabled: true },
    };
    const merged = await mergeSharedConfig(local);
    expect(merged).toEqual(local);
  });

  it("mergeSharedConfig does not re-save when shared fields already match", async () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      theme: "light" as const,
      sync: { ...DEFAULT_SYNC_CONFIG, enabled: true },
    };
    setSyncConfig(cfg.sync);
    await saveConfig(cfg);

    const queuedBefore = __pendingCount();
    await mergeSharedConfig(cfg);
    // merge should detect equality and not enqueue another write
    expect(__pendingCount()).toBe(queuedBefore);
  });
});
