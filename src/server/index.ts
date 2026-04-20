import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { $ } from "bun";
import open from "open";
import { join, relative } from "path";
import { reposRouter } from "./routes/repos.ts";
import { contributionsRouter } from "./routes/contributions.ts";
import { summaryRouter } from "./routes/summary.ts";

// Hono's `serveStatic` resolves paths against process.cwd(), which breaks
// when `shiplog` is launched from any directory other than the repo root.
// Anchor to the built `dist/web` alongside the source, expressed relative to
// cwd so Hono's resolver still reaches it.
const WEB_DIR_ABS = join(import.meta.dir, "../../dist/web");
function webAsset(name: string): string {
  const rel = relative(process.cwd(), join(WEB_DIR_ABS, name));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Craft a human-readable detail line from a failed `codex exec` run.
 *
 * codex prints a verbose header (workdir, model, approval, session id, …)
 * before the actual error, so a naive "first line of stderr" is useless.
 * We scan for the most informative line, preferring explicit error/warning
 * markers and falling back to the last non-empty stderr line.
 */
function summarizeCodexFailure(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  const combined = `${stderr}\n${stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Skip codex's metadata header (workdir/model/… lines separated by `----`
  // dividers) and lines that are clearly not diagnostic.
  const noise = /^(workdir|model|provider|approval|sandbox|reasoning|session id|--+|mcp startup|tokens used|user|codex)\b/i;

  const errorLine = combined.find(
    (l) => /\b(error|fatal|failed|unauthori[sz]ed|forbidden|timeout|429|quota|rate.?limit)\b/i.test(l) && !noise.test(l),
  );
  if (errorLine) return errorLine.slice(0, 160);

  const lastMeaningful = [...combined].reverse().find((l) => !noise.test(l));
  if (lastMeaningful) return lastMeaningful.slice(0, 160);

  return `exit ${exitCode ?? "?"} (check codex auth/config)`;
}

interface ServerOptions {
  port: number;
  noBrowser: boolean;
}

export async function startServer({ port, noBrowser }: ServerOptions): Promise<void> {
  const app = new Hono();

  // ── Prerequisite status check ──
  app.get("/api/status", async (c) => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    // gh CLI installed?
    try {
      const r = await $`gh --version`.quiet();
      const ver = r.stdout.toString().split("\n")[0] ?? "";
      checks.gh = { ok: r.exitCode === 0, detail: ver.trim() };
    } catch {
      checks.gh = { ok: false, detail: "Not installed. Get it at https://cli.github.com" };
    }

    // gh authenticated?
    if (checks.gh.ok) {
      try {
        const r = await $`gh auth status`.quiet();
        const out = r.stdout.toString() + r.stderr.toString();
        const match = out.match(/Logged in to .* account (\S+)/);
        checks.ghAuth = {
          ok: r.exitCode === 0,
          detail: match ? `Authenticated as ${match[1]}` : "Authenticated",
        };
      } catch {
        checks.ghAuth = {
          ok: false,
          detail: "Not authenticated. Run: gh auth login",
        };
      }
    } else {
      checks.ghAuth = { ok: false, detail: "Install gh CLI first" };
    }

    // claude CLI?
    try {
      const r = await $`which claude`.quiet();
      checks.claude = {
        ok: r.exitCode === 0,
        detail: r.exitCode === 0 ? "Available" : "Not found",
      };
    } catch {
      checks.claude = { ok: false, detail: "Not installed" };
    }

    // codex CLI? Also do a quick smoke test since codex often has auth/model issues.
    //
    // The smoke test needs its own try/catch: Bun's `$` throws on non-zero
    // exit codes, and without a nested handler a smoke-test failure (codex
    // installed but broken) gets reported as "Not installed" — which is
    // misleading and sends the user down the wrong rabbit hole.
    let codexInstalled = false;
    try {
      const which = await $`which codex`.quiet();
      codexInstalled = which.exitCode === 0;
    } catch {
      codexInstalled = false;
    }

    if (!codexInstalled) {
      checks.codex = { ok: false, detail: "Not installed" };
    } else {
      // Use `.nothrow()` so non-zero exit returns a result instead of
      // throwing — we want to read stdout/stderr ourselves to craft a
      // useful detail, not rely on the generic "Failed with exit code N"
      // message on Bun's thrown ShellError.
      try {
        // `--skip-git-repo-check` so the probe works regardless of where
        // `shiplog` was invoked from (e.g. `~`), not just inside a git repo.
        const test = await $`echo "respond with OK" | codex exec --skip-git-repo-check -`
          .quiet()
          .nothrow();
        const stdout = test.stdout.toString();
        const stderr = test.stderr.toString();
        const out = (stdout + stderr).toLowerCase();
        if (test.exitCode === 0 && !out.includes("error")) {
          checks.codex = { ok: true, detail: "Available" };
        } else {
          checks.codex = {
            ok: false,
            detail: `Installed but failing: ${summarizeCodexFailure(stdout, stderr, test.exitCode)}`,
          };
        }
      } catch (err) {
        // Shouldn't happen with .nothrow(), but keep a belt-and-suspenders
        // fallback in case Bun throws for a different reason (e.g. the
        // child was killed by a signal).
        const msg = err instanceof Error ? err.message : String(err);
        checks.codex = {
          ok: false,
          detail: `Installed but failing: ${msg.slice(0, 160)}`,
        };
      }
    }

    const hasLLM = checks.claude.ok || checks.codex.ok;
    const allGood = checks.gh.ok && checks.ghAuth.ok;

    return c.json({ checks, hasLLM, ready: allGood });
  });

  // API routes
  app.route("/api/repos", reposRouter);
  app.route("/api/contributions", contributionsRouter);
  app.route("/api/summary", summaryRouter);

  // Static files (bundled frontend)
  app.use("/main.js", serveStatic({ path: webAsset("main.js") }));
  app.use("/styles.css", serveStatic({ path: webAsset("styles.css") }));

  // SPA fallback — serve index.html for all non-API, non-asset routes
  app.get("*", serveStatic({ path: webAsset("index.html") }));

  const url = `http://localhost:${port}`;
  console.log(`\n  shiplog is running at ${url}\n`);

  if (!noBrowser) {
    await open(url);
  }

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });

  Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 255, // seconds — LLM calls can take 60s+ each; max allowed by Bun
  });
}
