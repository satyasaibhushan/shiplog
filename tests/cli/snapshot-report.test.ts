import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("snapshot CLI runs offline, persists idempotently and aggregates active daily reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "shiplog-cli-snapshot-"));
  const config = join(root, "config"),
    data = join(root, "data");
  mkdirSync(config, { recursive: true });
  // Even a configured remote must not be consulted by this snapshot-only entry point.
  writeFileSync(
    join(config, "config.json"),
    JSON.stringify({
      sync: {
        enabled: true,
        remoteUrl: "https://example.invalid/never-contact",
        pullOnStart: true,
      },
    }),
  );
  const run = async (args: string[]) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "src/cli/index.ts",
        "report",
        ...args,
        "--author",
        "fixture@example.test",
        "--at",
        "2026-09-30T18:31:00Z",
        "--output",
        "json",
      ],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: { ...process.env, SHIPLOG_CONFIG_DIR: config, SHIPLOG_DATA_DIR: data },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text(),
      stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    return JSON.parse(stdout);
  };
  try {
    const args = ["--daily", "--taskfinder-snapshot", "tests/fixtures/taskfinder-synthetic.json"];
    const a = await run(args),
      b = await run(args);
    expect(a.entries[0].log.id).toBe(b.entries[0].log.id);
    expect(a.entries[0].version.id).toBe(b.entries[0].version.id);
    const month = await run(["--monthly", "--taskfinder-instance", "synthetic-taskfinder"]);
    expect(month.window.timezone).toBe("Asia/Kolkata");
    expect(month.rollup.activeVersionId).toBe(month.version.id);
    expect(month.version.summaryMarkdown).toContain("Not live verified");
    expect(existsSync(join(data, ".git"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
