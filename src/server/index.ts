import { Hono } from "hono";
import { serveStatic } from "hono/bun";
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

  // API routes
  app.route("/api/repos", reposRouter);
  app.route("/api/contributions", contributionsRouter);
  app.route("/api/summary", summaryRouter);

  // Static files (bundled frontend)
  app.use("/*", serveStatic({ root: "./dist/web" }));

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
  });
}
