import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { $ } from "bun";
import open from "open";
import { join, relative } from "path";
import { checkModelBridge } from "../core/model-bridge.ts";
import { getProviderStatus } from "../core/provider-status.ts";
import { reposRouter } from "./routes/repos.ts";
import { contributionsRouter } from "./routes/contributions.ts";
import { summaryRouter } from "./routes/summary.ts";
import { atlasRouter } from "./routes/atlas.ts";
import { logsRouter } from "./routes/logs.ts";
import { rollupsRouter } from "./routes/rollups.ts";
import { chatRouter } from "./routes/chat.ts";
import { staleRouter } from "./routes/stale.ts";
import { providersRouter } from "./routes/providers.ts";

// Hono's `serveStatic` resolves paths against process.cwd(), which breaks
// when `shiplog` is launched from any directory other than the repo root.
// Anchor to the built `dist/web` alongside the source, expressed relative to
// cwd so Hono's resolver still reaches it.
const WEB_DIR_ABS = join(import.meta.dir, "../../dist/web");
function webAsset(name: string): string {
  const rel = relative(process.cwd(), join(WEB_DIR_ABS, name));
  return rel.startsWith(".") ? rel : `./${rel}`;
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

    checks.modelBridge = await checkModelBridge();
    const providers = await getProviderStatus({ force: true });
    const hasLLM = Object.values(providers).some(
      (provider) => provider.installed && provider.authed,
    );
    checks.modelProvider = {
      ok: hasLLM,
      detail: hasLLM ? "At least one provider is ready" : "No provider is ready",
    };
    const allGood = checks.gh.ok && checks.ghAuth.ok && checks.modelBridge.ok && hasLLM;

    return c.json({ checks, hasLLM, ready: allGood });
  });

  // API routes
  app.route("/api/repos", reposRouter);
  app.route("/api/contributions", contributionsRouter);
  app.route("/api/summary", summaryRouter);
  app.route("/api/atlas", atlasRouter);
  app.route("/api/logs", logsRouter);
  app.route("/api/rollups", rollupsRouter);
  app.route("/api/chat", chatRouter);
  app.route("/api/stale", staleRouter);
  app.route("/api/providers", providersRouter);

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
