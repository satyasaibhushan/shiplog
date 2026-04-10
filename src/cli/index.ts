#!/usr/bin/env bun

import { parseArgs } from "util";
import { startServer } from "../server/index.ts";
import { checkDependencies } from "./setup.ts";
import { loadConfig, saveConfig, type ShiplogConfig } from "./config.ts";
import { initDb, closeDb } from "../core/cache.ts";
import { select } from "./prompt.ts";

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
  shiplog config              Show current configuration
  shiplog config <key> <val>  Set a config value
  shiplog config --reset      Reset to defaults

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

Config keys:
  llm                         LLM provider (auto, claude, codex)
  port                        Server port number
  theme                       UI theme (dark, light)
  defaultScope                Contribution scope (comma-separated)
  excludePatterns             File exclude patterns (comma-separated)
`);
  process.exit(0);
}

if (subcommand === "setup") {
  await checkDependencies();
  process.exit(0);
}

// ── Config subcommand ──

if (subcommand === "config") {
  const key = positionals[1];
  const value = positionals[2];

  // shiplog config --reset
  if (Bun.argv.includes("--reset")) {
    const { DEFAULT_CONFIG } = await import("./config.ts");
    await saveConfig(DEFAULT_CONFIG);
    console.log("  Config reset to defaults.\n");
    const config = await loadConfig();
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  }

  // shiplog config (no args — show current)
  if (!key) {
    const config = await loadConfig();
    console.log("\n  Current configuration:\n");
    for (const [k, v] of Object.entries(config)) {
      const display = Array.isArray(v) ? v.join(", ") : String(v);
      console.log(`  ${k.padEnd(18)} ${display}`);
    }
    console.log();
    process.exit(0);
  }

  // shiplog config <key> (no value — interactive edit)
  const config = await loadConfig();
  const validKeys = Object.keys(config);

  if (!validKeys.includes(key)) {
    console.error(`\n  Unknown config key: "${key}"`);
    console.error(`  Valid keys: ${validKeys.join(", ")}\n`);
    process.exit(1);
  }

  const configKey = key as keyof ShiplogConfig;

  if (!value) {
    // Interactive selection for known keys
    const newValue = await interactiveConfigEdit(configKey, config);
    if (newValue !== undefined) {
      (config as Record<string, unknown>)[configKey] = newValue;
      await saveConfig(config);
      const display = Array.isArray(newValue) ? newValue.join(", ") : String(newValue);
      console.log(`\n  ${configKey} = ${display}\n`);
    }
    process.exit(0);
  }

  // shiplog config <key> <value> (direct set)
  const parsed = parseConfigValue(configKey, value, config);
  if (parsed.error) {
    console.error(`\n  ${parsed.error}\n`);
    process.exit(1);
  }

  (config as Record<string, unknown>)[configKey] = parsed.value;
  await saveConfig(config);
  const display = Array.isArray(parsed.value) ? parsed.value.join(", ") : String(parsed.value);
  console.log(`\n  ${configKey} = ${display}\n`);
  process.exit(0);
}

// ── Default: start server ──

const config = await loadConfig();
const port = values.port ? parseInt(values.port, 10) : config.port;
const noBrowser = values["no-browser"] ?? false;

// Initialize database on startup
initDb();
console.log("  Database initialized.");

// Clean up on exit
process.on("exit", () => closeDb());

await startServer({ port, noBrowser });

// ── Helpers ──

function parseConfigValue(
  key: keyof ShiplogConfig,
  raw: string,
  _config: ShiplogConfig,
): { value?: unknown; error?: string } {
  switch (key) {
    case "llm": {
      const valid = ["auto", "claude", "codex"];
      if (!valid.includes(raw)) return { error: `Invalid llm: "${raw}". Must be: ${valid.join(", ")}` };
      return { value: raw };
    }
    case "theme": {
      const valid = ["dark", "light"];
      if (!valid.includes(raw)) return { error: `Invalid theme: "${raw}". Must be: ${valid.join(", ")}` };
      return { value: raw };
    }
    case "port": {
      const num = parseInt(raw, 10);
      if (isNaN(num) || num < 1 || num > 65535) return { error: `Invalid port: "${raw}". Must be 1-65535` };
      return { value: num };
    }
    case "defaultScope":
      return { value: raw.split(",").map((s) => s.trim()) };
    case "excludePatterns":
      return { value: raw.split(",").map((s) => s.trim()) };
    default:
      return { error: `Unknown key: ${key}` };
  }
}

async function interactiveConfigEdit(
  key: keyof ShiplogConfig,
  config: ShiplogConfig,
): Promise<unknown> {
  switch (key) {
    case "llm":
      return select(`Set LLM provider (current: ${config.llm})`, [
        { label: "auto", value: "auto", description: "Detect available CLI" },
        { label: "claude", value: "claude", description: "Always use Claude Code" },
        { label: "codex", value: "codex", description: "Always use Codex CLI" },
      ]);

    case "theme":
      return select(`Set theme (current: ${config.theme})`, [
        { label: "dark", value: "dark" },
        { label: "light", value: "light" },
      ]);

    case "port": {
      const { createInterface } = await import("readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<number>((resolve) => {
        rl.question(`  Enter port (current: ${config.port}): `, (answer) => {
          rl.close();
          const num = parseInt(answer.trim(), 10);
          if (isNaN(num) || num < 1 || num > 65535) {
            console.error("  Invalid port, keeping current value.");
            resolve(config.port);
          } else {
            resolve(num);
          }
        });
      });
    }

    case "defaultScope":
      return select(`Set default scope (current: ${config.defaultScope.join(", ")})`, [
        { label: "Merged PRs only", value: ["merged-prs"] },
        { label: "Merged PRs + direct commits", value: ["merged-prs", "direct-commits"] },
        { label: "All", value: ["merged-prs", "open-prs", "closed-prs", "direct-commits", "fork-branches"] },
      ]);

    case "excludePatterns": {
      const { createInterface } = await import("readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<string[]>((resolve) => {
        rl.question(
          `  Enter patterns, comma-separated (current: ${config.excludePatterns.join(", ")}): `,
          (answer) => {
            rl.close();
            const trimmed = answer.trim();
            if (!trimmed) {
              resolve(config.excludePatterns);
            } else {
              resolve(trimmed.split(",").map((s) => s.trim()));
            }
          },
        );
      });
    }

    default:
      return undefined;
  }
}
