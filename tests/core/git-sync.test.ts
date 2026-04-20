import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiplog-gitsync-"));
const DATA_DIR = join(TMP_ROOT, "data");
const REMOTE_DIR = join(TMP_ROOT, "remote.git");

process.env.SHIPLOG_DATA_DIR = DATA_DIR;

const {
  ensureInitialized,
  queueWrite,
  flushPending,
  pullIfDue,
  isGitAvailable,
  __resetForTests,
  __pendingCount,
} = await import("../../src/core/git-sync.ts");

const { DEFAULT_SYNC_CONFIG } = await import("../../src/cli/config.ts");

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${args.join(" ")} failed: ${err}`);
  }
  return (await new Response(proc.stdout).text()).trim();
}

async function setupRemote(): Promise<void> {
  mkdirSync(REMOTE_DIR, { recursive: true });
  await sh(REMOTE_DIR, "git", "init", "--bare", "-b", "main");
}

async function setupDataDir(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
}

describe("git-sync", () => {
  beforeEach(async () => {
    __resetForTests();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(REMOTE_DIR, { recursive: true, force: true });
    await setupDataDir();
    await setupRemote();
  });

  it("reports git availability", async () => {
    expect(await isGitAvailable()).toBe(true);
  });

  it("ensureInitialized is a no-op when sync is disabled", async () => {
    await ensureInitialized({ ...DEFAULT_SYNC_CONFIG, enabled: false });
    expect(existsSync(join(DATA_DIR, ".git"))).toBe(false);
  });

  it("ensureInitialized sets up a git repo + gitattributes", async () => {
    await ensureInitialized({
      ...DEFAULT_SYNC_CONFIG,
      enabled: true,
      remoteUrl: `file://${REMOTE_DIR}`,
    });
    expect(existsSync(join(DATA_DIR, ".git"))).toBe(true);
    expect(existsSync(join(DATA_DIR, ".gitattributes"))).toBe(true);

    const remoteUrl = await sh(DATA_DIR, "git", "remote", "get-url", "origin");
    expect(remoteUrl).toBe(`file://${REMOTE_DIR}`);
  });

  it("ensureInitialized is idempotent", async () => {
    const cfg = {
      ...DEFAULT_SYNC_CONFIG,
      enabled: true,
      remoteUrl: `file://${REMOTE_DIR}`,
    };
    await ensureInitialized(cfg);
    await ensureInitialized(cfg); // second call shouldn't throw
    expect(existsSync(join(DATA_DIR, ".gitattributes"))).toBe(true);
  });

  it("flushPending commits and pushes queued files", async () => {
    const cfg = {
      ...DEFAULT_SYNC_CONFIG,
      enabled: true,
      remoteUrl: `file://${REMOTE_DIR}`,
      pushDebounceMs: 50,
    };
    await ensureInitialized(cfg);

    // Configure git identity so commits succeed in isolated test envs.
    await sh(DATA_DIR, "git", "config", "user.email", "test@test.test");
    await sh(DATA_DIR, "git", "config", "user.name", "Test");

    const file = join(DATA_DIR, "summaries", "abc.json");
    mkdirSync(join(DATA_DIR, "summaries"), { recursive: true });
    writeFileSync(file, '{"hello":"world"}\n');

    queueWrite(cfg, file, "summary");
    expect(__pendingCount()).toBe(1);

    await flushPending(cfg);
    expect(__pendingCount()).toBe(0);

    // Verify the commit landed on the remote.
    const remoteLog = await sh(REMOTE_DIR, "git", "log", "--oneline");
    expect(remoteLog).toContain("1 summary");
  });

  it("flushPending is a no-op when nothing is queued", async () => {
    const cfg = {
      ...DEFAULT_SYNC_CONFIG,
      enabled: true,
      remoteUrl: `file://${REMOTE_DIR}`,
    };
    await ensureInitialized(cfg);
    await flushPending(cfg); // shouldn't throw
    expect(__pendingCount()).toBe(0);
  });

  it("coalesces multiple queued writes into one commit message", async () => {
    const cfg = {
      ...DEFAULT_SYNC_CONFIG,
      enabled: true,
      remoteUrl: `file://${REMOTE_DIR}`,
      pushDebounceMs: 50,
    };
    await ensureInitialized(cfg);
    await sh(DATA_DIR, "git", "config", "user.email", "test@test.test");
    await sh(DATA_DIR, "git", "config", "user.name", "Test");

    mkdirSync(join(DATA_DIR, "summaries"), { recursive: true });
    mkdirSync(join(DATA_DIR, "repos", "foo__bar", "prs"), { recursive: true });

    const f1 = join(DATA_DIR, "summaries", "a.json");
    const f2 = join(DATA_DIR, "summaries", "b.json");
    const f3 = join(DATA_DIR, "repos", "foo__bar", "prs", "1.json");
    writeFileSync(f1, "{}");
    writeFileSync(f2, "{}");
    writeFileSync(f3, "{}");

    queueWrite(cfg, f1, "summary");
    queueWrite(cfg, f2, "summary");
    queueWrite(cfg, f3, "pr");

    await flushPending(cfg);

    const remoteMsg = await sh(REMOTE_DIR, "git", "log", "-1", "--pretty=%s");
    expect(remoteMsg).toContain("2 summary");
    expect(remoteMsg).toContain("1 pr");
  });

  it("pullIfDue is a no-op when sync is disabled", async () => {
    const r = await pullIfDue({ ...DEFAULT_SYNC_CONFIG, enabled: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sync disabled");
  });

  it("pullIfDue runs at most once per session", async () => {
    const cfg = {
      ...DEFAULT_SYNC_CONFIG,
      enabled: true,
      remoteUrl: `file://${REMOTE_DIR}`,
    };
    await ensureInitialized(cfg);
    await sh(DATA_DIR, "git", "config", "user.email", "test@test.test");
    await sh(DATA_DIR, "git", "config", "user.name", "Test");

    // Seed an initial commit + push so the remote has a main branch.
    mkdirSync(join(DATA_DIR, "summaries"), { recursive: true });
    const f = join(DATA_DIR, "summaries", "seed.json");
    writeFileSync(f, "{}");
    queueWrite(cfg, f, "summary");
    await flushPending(cfg);

    const first = await pullIfDue(cfg);
    const second = await pullIfDue(cfg);
    expect(first.ok).toBe(true);
    expect(second.reason).toBe("already pulled");
  });
});
