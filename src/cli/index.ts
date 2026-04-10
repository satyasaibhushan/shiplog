#!/usr/bin/env bun

import { parseArgs } from "util";
import { startServer } from "../server/index.ts";
import { checkDependencies } from "./setup.ts";
import { loadConfig } from "./config.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string", short: "f" },
    to: { type: "string", short: "t" },
    repos: { type: "string", short: "r" },
    output: { type: "string", short: "o" },
    port: { type: "string", short: "p" },
    llm: { type: "string" },
    "no-browser": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  allowPositionals: true,
  strict: false,
});

const subcommand = positionals[0];

if (values.version) {
  const pkg = await Bun.file("package.json").json();
  console.log(`shiplog v${pkg.version}`);
  process.exit(0);
}

if (values.help) {
  console.log(`
shiplog — Visualize and summarize your GitHub contributions

Usage:
  shiplog                     Start the web UI
  shiplog setup               Check dependencies
  shiplog config              Manage configuration

Options:
  -f, --from <date>           Start date (YYYY-MM-DD)
  -t, --to <date>             End date (YYYY-MM-DD)
  -r, --repos <repos>         Comma-separated repo list
  -o, --output <format>       Output format: web, markdown, html, json
  -p, --port <number>         Server port (default: 3847)
  --llm <provider>            LLM provider: claude, codex
  --no-browser                Don't open browser automatically
  -h, --help                  Show this help
  -v, --version               Show version
`);
  process.exit(0);
}

if (subcommand === "setup") {
  await checkDependencies();
  process.exit(0);
}

if (subcommand === "config") {
  const config = await loadConfig();
  console.log("Current configuration:");
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}

// Default: start the web server
const config = await loadConfig();
const port = values.port ? parseInt(values.port, 10) : config.port;
const noBrowser = values["no-browser"] ?? false;

await startServer({ port, noBrowser });
