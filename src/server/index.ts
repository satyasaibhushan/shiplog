import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { $ } from "bun";
import open from "open";
import { reposRouter } from "./routes/repos.ts";
import { contributionsRouter } from "./routes/contributions.ts";
import { summaryRouter } from "./routes/summary.ts";

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

    // codex CLI?
    try {
      const r = await $`which codex`.quiet();
      checks.codex = {
        ok: r.exitCode === 0,
        detail: r.exitCode === 0 ? "Available" : "Not found",
      };
    } catch {
      checks.codex = { ok: false, detail: "Not installed" };
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
  app.use("/main.js", serveStatic({ path: "./dist/web/main.js" }));
  app.use("/styles.css", serveStatic({ path: "./dist/web/styles.css" }));

  // SPA fallback — serve index.html for all non-API, non-asset routes
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));

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
