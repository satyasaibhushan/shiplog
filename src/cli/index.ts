#!/usr/bin/env bun

import { parseArgs } from "util";
import { startServer } from "../server/index.ts";
import { checkDependencies } from "./setup.ts";
import {
  loadConfig,
  mergeSharedConfig,
  saveConfig,
  type ShiplogConfig,
} from "./config.ts";
import { initDb, closeDb } from "../core/cache.ts";
import { select } from "./prompt.ts";
import { maybePromptForSync, runSyncInit } from "./sync-setup.ts";
import {
  ensureInitialized as ensureGitSyncInitialized,
  pullIfDue,
  flushPending,
  setSyncConfig,
} from "../core/git-sync.ts";

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
  shiplog sync init           Set up cross-machine sync via a private GitHub repo
  shiplog sync push           Flush any pending sync commits immediately
  shiplog sync status         Show current sync configuration

Options:
  -f, --from <date>           Start date (YYYY-MM-DD)
  -t, --to <date>             End date (YYYY-MM-DD)
  -r, --repos <repos>         Comma-separated repo list (owner/repo)
  -o, --output <format>       Output format: web, markdown, html, json
  -p, --port <number>         Server port (default: 3847)
  --llm <provider>            LLM provider: auto, claude, codex
  --no-browser                Don't open browser automatically
  -h, --help                  Show this help
  -v, --version               Show version

Headless mode (no browser):
  shiplog -f 2024-01-01 -t 2024-03-31 -r owner/repo -o markdown
  shiplog -f 2024-01-01 -t 2024-03-31 -r repo1,repo2 -o json > data.json

Config keys:
  llm                         LLM provider (auto, claude, codex)
  port                        Server port number
  theme                       UI theme (dark, light)
  defaultScope                Contribution scope (comma-separated)
  excludePatterns             File exclude patterns (comma-separated)
  gitEmails                   Extra git emails for finding old commits (comma-separated)
`);
  process.exit(0);
}

if (subcommand === "setup") {
  await checkDependencies();
  process.exit(0);
}

// ── Sync subcommand ──

if (subcommand === "sync") {
  const action = positionals[1];
  const config = await loadConfig();

  if (action === "init" || action === undefined) {
    // Reset `promptedAt` so the init flow runs even if we previously declined.
    const reset: ShiplogConfig = {
      ...config,
      sync: { ...config.sync, promptedAt: null },
    };
    await runSyncInit(reset);
    process.exit(0);
  }

  if (action === "push") {
    setSyncConfig(config.sync);
    await ensureGitSyncInitialized(config.sync);
    await flushPending(config.sync);
    console.log("\n  Flushed any pending commits.\n");
    process.exit(0);
  }

  if (action === "status") {
    console.log("\n  Sync:");
    console.log(`    enabled:     ${config.sync.enabled}`);
    console.log(`    remoteUrl:   ${config.sync.remoteUrl ?? "(none)"}`);
    console.log(`    pullOnStart: ${config.sync.pullOnStart}`);
    console.log(`    debounce:    ${config.sync.pushDebounceMs}ms`);
    console.log(`    promptedAt:  ${config.sync.promptedAt ?? "(never)"}\n`);
    process.exit(0);
  }

  console.error(`\n  Unknown sync action: "${action}". Use: init, push, status.\n`);
  process.exit(1);
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
    const newValue = await interactiveConfigEdit(configKey, config);
    if (newValue !== undefined) {
      setConfigValue(config, configKey, newValue);
      await saveConfig(config);
      const display = Array.isArray(newValue) ? newValue.join(", ") : String(newValue);
      console.log(`\n  ${configKey} = ${display}\n`);
    }
    process.exit(0);
  }

  // shiplog config <key> <value> (direct set)
  const parsed = parseConfigValue(configKey, value, config);
  if (parsed.error || parsed.value === undefined) {
    console.error(`\n  ${parsed.error ?? `Could not parse value for ${configKey}`}\n`);
    process.exit(1);
  }

  setConfigValue(config, configKey, parsed.value);
  await saveConfig(config);
  const display = Array.isArray(parsed.value) ? parsed.value.join(", ") : String(parsed.value);
  console.log(`\n  ${configKey} = ${display}\n`);
  process.exit(0);
}

// ── Load config for remaining commands ──

let config = await loadConfig();

// First-run sync prompt (no-op once answered; TTY-only).
config = await maybePromptForSync(config);

// Register the effective sync config for modules that persist summaries
// (summarizer uses this via the git-sync module).
setSyncConfig(config.sync);

// Initialize the git data dir and pull. We await the pull (under a tight
// timeout) so that any shared config written by another machine is applied
// this run, not the next one. If the pull times out or fails, we fall
// through to whatever local state we already have.
if (config.sync.enabled) {
  await ensureGitSyncInitialized(config.sync).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  shiplog sync: init failed — ${msg}`);
  });
  await pullIfDue(config.sync);
  config = await mergeSharedConfig(config);
  setSyncConfig(config.sync);
}

// Flush any queued writes on clean exit. `beforeExit` fires before Bun
// leaves the event loop, giving us a chance to finalize the git push.
let flushed = false;
async function flushOnExit() {
  if (flushed) return;
  flushed = true;
  await flushPending(config.sync).catch(() => {
    // flushPending already logs its own warnings; don't double-log here.
  });
}
process.on("beforeExit", () => {
  void flushOnExit();
});
process.on("SIGINT", async () => {
  await flushOnExit();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await flushOnExit();
  process.exit(143);
});

// ── Headless output mode ──
// When --output is markdown/html/json, run the full pipeline without a server.

const outputFormat = typeof values.output === "string" ? values.output : undefined;

if (outputFormat && outputFormat !== "web") {
  const validFormats = ["markdown", "html", "json"];
  if (!validFormats.includes(outputFormat)) {
    console.error(
      `\n  Unknown output format: "${outputFormat}". Must be: web, ${validFormats.join(", ")}\n`,
    );
    process.exit(1);
  }

  // Parse required params
  const reposRaw = typeof values.repos === "string" ? values.repos : "";
  const repos = reposRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (repos.length === 0) {
    console.error("\n  --repos is required for headless output.");
    console.error("  Example: shiplog -o markdown -r owner/repo1,owner/repo2\n");
    process.exit(1);
  }

  const today = new Date().toISOString().split("T")[0]!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]!;

  const from = typeof values.from === "string" ? values.from : thirtyDaysAgo;
  const to = typeof values.to === "string" ? values.to : today;
  const llmProvider = (typeof values.llm === "string" ? values.llm : config.llm) as
    | "auto"
    | "claude"
    | "codex";

  console.error(`\n  shiplog — headless mode (${outputFormat})`);
  console.error(`  Period: ${from} to ${to}`);
  console.error(`  Repos:  ${repos.join(", ")}\n`);

  // Initialize DB
  initDb();

  // Dynamic imports to keep startup fast for --help/--version
  const { fetchContributions } = await import("../core/github.ts");
  const { deduplicateCommits } = await import("../core/dedup.ts");
  const { groupCommits } = await import("../core/grouping.ts");
  const { runSummarizationPipeline } = await import("../core/summarizer.ts");
  const { renderMarkdown, renderHTML, renderJSON } = await import("./output.ts");

  try {
    // Step 1: Fetch
    console.error("  Fetching contributions...");
    const raw = await fetchContributions({
      repos,
      from,
      to,
      scope: config.defaultScope,
    });

    // Step 2: Dedup
    const dedup = deduplicateCommits(raw.commits);

    // Step 3: Group
    const grouped = groupCommits(dedup.unique, raw.pullRequests);

    // Step 4: Summarize
    let summary = null;
    if (grouped.groups.length > 0) {
      try {
        console.error("  Running AI summarization...");
        summary = await runSummarizationPipeline(
          grouped.groups,
          { from, to, repos },
          llmProvider,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ⚠ Summarization skipped: ${msg}`);
      }
    }

    // Step 5: Render output
    const outputData = {
      groups: grouped.groups,
      summary,
      params: { from, to, repos },
      stats: {
        ...raw.stats,
        duplicatesRemoved: dedup.totalRemoved,
        uniqueCommits: dedup.unique.length,
        ...grouped.stats,
      },
    };

    let output: string;
    switch (outputFormat) {
      case "markdown":
        output = renderMarkdown(outputData);
        break;
      case "html":
        output = renderHTML(outputData);
        break;
      case "json":
        output = renderJSON(outputData);
        break;
      default:
        output = renderJSON(outputData);
    }

    // Print to stdout (progress/logs go to stderr)
    console.log(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  Error: ${msg}\n`);
    await flushOnExit();
    closeDb();
    process.exit(1);
  } finally {
    closeDb();
  }

  // Flush any summary writes queued during the run before exiting, so the
  // git push includes them. `beforeExit` doesn't fire for explicit
  // process.exit() calls, hence the explicit await.
  await flushOnExit();
  process.exit(0);
}

// ── Default: start web server ──

const port = typeof values.port === "string" ? parseInt(values.port, 10) : config.port;
const noBrowser = Boolean(values["no-browser"]);

initDb();
console.log("  Database initialized.");

process.on("exit", () => closeDb());

await startServer({ port, noBrowser });

// ── Helpers ──

/**
 * Assign a parsed value to a config key. Kept as a tiny helper so the cast
 * is centralized and each call site stays fully typed.
 */
function setConfigValue<K extends keyof ShiplogConfig>(
  config: ShiplogConfig,
  key: K,
  value: ShiplogConfig[K],
): void {
  config[key] = value;
}

type ParseResult<K extends keyof ShiplogConfig> =
  | { value: ShiplogConfig[K]; error?: undefined }
  | { value?: undefined; error: string };

function parseConfigValue<K extends keyof ShiplogConfig>(
  key: K,
  raw: string,
  _config: ShiplogConfig,
): ParseResult<K> {
  switch (key) {
    case "llm": {
      const valid = ["auto", "claude", "codex"] as const;
      if (!(valid as readonly string[]).includes(raw))
        return { error: `Invalid llm: "${raw}". Must be: ${valid.join(", ")}` };
      return { value: raw as ShiplogConfig[K] };
    }
    case "theme": {
      const valid = ["dark", "light"] as const;
      if (!(valid as readonly string[]).includes(raw))
        return { error: `Invalid theme: "${raw}". Must be: ${valid.join(", ")}` };
      return { value: raw as ShiplogConfig[K] };
    }
    case "port": {
      const num = parseInt(raw, 10);
      if (isNaN(num) || num < 1 || num > 65535)
        return { error: `Invalid port: "${raw}". Must be 1-65535` };
      return { value: num as ShiplogConfig[K] };
    }
    case "defaultScope":
    case "excludePatterns":
    case "gitEmails":
      return {
        value: raw.split(",").map((s) => s.trim()) as ShiplogConfig[K],
      };
    default:
      return { error: `Unknown key: ${String(key)}` };
  }
}

async function interactiveConfigEdit<K extends keyof ShiplogConfig>(
  key: K,
  config: ShiplogConfig,
): Promise<ShiplogConfig[K] | undefined> {
  // The generic narrowing here doesn't follow switch cases, so each return
  // casts through ShiplogConfig[K] — the key/value pairing is guarded by the
  // switch shape itself.
  type V = ShiplogConfig[K];
  switch (key) {
    case "llm":
      return (await select(`Set LLM provider (current: ${config.llm})`, [
        { label: "auto", value: "auto", description: "Detect available CLI" },
        { label: "claude", value: "claude", description: "Always use Claude Code" },
        { label: "codex", value: "codex", description: "Always use Codex CLI" },
      ])) as V;
    case "theme":
      return (await select(`Set theme (current: ${config.theme})`, [
        { label: "dark", value: "dark" },
        { label: "light", value: "light" },
      ])) as V;
    case "port": {
      const { createInterface } = await import("readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<V>((resolve) => {
        rl.question(`  Enter port (current: ${config.port}): `, (answer) => {
          rl.close();
          const num = parseInt(answer.trim(), 10);
          if (isNaN(num) || num < 1 || num > 65535) {
            console.error("  Invalid port, keeping current value.");
            resolve(config.port as V);
          } else {
            resolve(num as V);
          }
        });
      });
    }
    case "defaultScope":
      return (await select(`Set default scope (current: ${config.defaultScope.join(", ")})`, [
        { label: "Merged PRs only", value: ["merged-prs"] },
        { label: "Merged PRs + direct commits", value: ["merged-prs", "direct-commits"] },
        {
          label: "All",
          value: ["merged-prs", "open-prs", "closed-prs", "direct-commits", "fork-branches"],
        },
      ])) as V;
    case "excludePatterns": {
      const { createInterface } = await import("readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<V>((resolve) => {
        rl.question(
          `  Enter patterns, comma-separated (current: ${config.excludePatterns.join(", ")}): `,
          (answer) => {
            rl.close();
            const trimmed = answer.trim();
            resolve((trimmed ? trimmed.split(",").map((s) => s.trim()) : config.excludePatterns) as V);
          },
        );
      });
    }
    default:
      return undefined;
  }
}
