// Sync onboarding: first-run prompt, `shiplog sync init`, SQLite→JSON migration.
//
// Keeps the UX decisions in one file so the CLI entry point just calls
// `maybePromptForSync(config)` at startup and doesn't need to know the details.

import { confirm, textPrompt } from "./prompt.ts";
import {
  mergeSharedConfig,
  saveConfig,
  type ShiplogConfig,
  type SyncConfig,
} from "./config.ts";
import {
  ensureInitialized,
  flushPending,
  pullIfDue,
  remoteHasHeads,
  setSyncConfig,
} from "../core/git-sync.ts";
import { writeRollup, writeSummary } from "../core/datastore.ts";
import { getDb } from "../core/cache.ts";
import * as schema from "../db/schema.ts";

const DEFAULT_DATA_REPO_NAME = "shiplog-data";

// ── First-run prompt ──────────────────────────────────────────────────────

/**
 * On the very first CLI invocation, ask whether to enable cross-machine sync.
 * Returns the (possibly updated) config.
 *
 * Never re-prompts once `sync.promptedAt` is set. Call `shiplog sync init`
 * to configure sync later.
 */
export async function maybePromptForSync(
  config: ShiplogConfig,
): Promise<ShiplogConfig> {
  if (config.sync.promptedAt) return config;

  // Non-interactive shells (CI, piped input) — record that we've "seen" the
  // user so we don't block on the next run, but don't flip the switch.
  if (!process.stdin.isTTY) {
    return await recordPrompted(config);
  }

  console.log(
    "\n  Shiplog can sync summaries and config across machines via a\n" +
      "  private GitHub repo. This uses your existing `gh` auth.",
  );

  const enable = await confirm("Enable sync now?", false);

  if (!enable) {
    const updated = await recordPrompted(config);
    console.log(
      "\n  Skipped. Run `shiplog sync init` later if you change your mind.\n",
    );
    return updated;
  }

  return await runSyncInit(config);
}

async function recordPrompted(config: ShiplogConfig): Promise<ShiplogConfig> {
  const updated: ShiplogConfig = {
    ...config,
    sync: { ...config.sync, promptedAt: new Date().toISOString() },
  };
  await saveConfig(updated);
  return updated;
}

// ── `shiplog sync init` entry point ───────────────────────────────────────

/**
 * Full sync setup — prompts for the data repo name, creates/verifies it via
 * `gh`, configures git credentials, initializes the local data directory,
 * migrates existing SQLite summaries, and pushes the initial commit.
 */
export async function runSyncInit(
  config: ShiplogConfig,
): Promise<ShiplogConfig> {
  const repoName = await textPrompt(
    "Data repo name",
    DEFAULT_DATA_REPO_NAME,
  );

  let login: string;
  try {
    login = await getGhUser();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  Could not resolve GitHub user: ${msg}`);
    console.error("  Run `gh auth login` and try again.\n");
    return await recordPrompted(config);
  }

  const fullName = `${login}/${repoName}`;
  const remoteUrl = `https://github.com/${fullName}.git`;

  console.log(`\n  → Configuring ${fullName}...`);

  try {
    await ensureGhRepoExists(fullName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  Could not create/verify ${fullName}: ${msg}`);
    console.error("  Sync left disabled.\n");
    return await recordPrompted(config);
  }

  await ensureGhAuthSetupGit();

  const syncConfig: SyncConfig = {
    ...config.sync,
    enabled: true,
    remoteUrl,
    promptedAt: new Date().toISOString(),
  };

  setSyncConfig(syncConfig);
  await ensureInitialized(syncConfig);

  // If the remote repo already contains data (e.g. set up from another
  // machine), pull it first so the shared config is merged into ours before
  // we write — otherwise our local defaults would clobber the remote on
  // the next push. Skip on empty remotes to avoid a spurious pull warning.
  if (await remoteHasContent(syncConfig)) {
    await pullIfDue(syncConfig);
  }
  const mergedConfig = await mergeSharedConfig({
    ...config,
    sync: syncConfig,
  });
  const newConfig: ShiplogConfig = { ...mergedConfig, sync: syncConfig };
  await saveConfig(newConfig);

  // Best-effort one-time migration of already-cached summaries. Failures
  // here don't block setup — we just re-summarize on the next run.
  try {
    const migrated = await migrateSqliteSummariesToDatastore();
    if (migrated > 0) {
      console.log(`  → Migrated ${migrated} summaries from local cache.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Migration skipped: ${msg}`);
  }

  // Flush the migration commit + push immediately so the remote repo has
  // state right after setup.
  await flushPending(syncConfig);

  // Verify the push actually landed — we've seen cases where pipe'd git
  // commands don't surface the real failure and leave the user with a
  // green checkmark but an empty remote.
  if (!(await remoteHasHeads(remoteUrl))) {
    console.warn(
      `\n  ⚠ Setup completed locally, but the push to ${fullName} didn't land.`,
    );
    console.warn(
      `    Check auth with \`gh auth status\` and retry: shiplog sync push\n`,
    );
    return newConfig;
  }

  console.log(`\n  ✅ Sync enabled. Data syncs to ${fullName}.\n`);
  return newConfig;
}

// ── `gh` helpers ──────────────────────────────────────────────────────────

async function getGhUser(): Promise<string> {
  const proc = Bun.spawn(["gh", "api", "/user", "--jq", ".login"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(err || `gh api /user exited ${code}`);
  }
  const login = (await new Response(proc.stdout).text()).trim();
  if (!login) throw new Error("gh api /user returned empty login");
  return login;
}

async function ensureGhRepoExists(fullName: string): Promise<void> {
  const view = Bun.spawn(["gh", "repo", "view", fullName, "--json", "name"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await view.exited) === 0) {
    console.log(`  → Using existing repo ${fullName}`);
    return;
  }

  console.log(`  → Creating private repo ${fullName}`);
  const create = Bun.spawn(
    ["gh", "repo", "create", fullName, "--private"],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await create.exited;
  if (code !== 0) {
    throw new Error(`gh repo create failed (exit ${code})`);
  }
}

async function remoteHasContent(cfg: SyncConfig): Promise<boolean> {
  if (!cfg.remoteUrl) return false;
  const proc = Bun.spawn(["git", "ls-remote", "--heads", cfg.remoteUrl], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) return false;
  const out = (await new Response(proc.stdout).text()).trim();
  return out.length > 0;
}

async function ensureGhAuthSetupGit(): Promise<void> {
  const proc = Bun.spawn(["gh", "auth", "setup-git"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    console.warn(`  ⚠ gh auth setup-git failed: ${err || `exit ${code}`}`);
  }
}

// ── SQLite → JSON migration ───────────────────────────────────────────────

/**
 * Migrate summaries that already live in the SQLite cache to the JSON
 * datastore. Best-effort:
 *  - "rollup" entries: writable (scope isn't part of routing for rollups).
 *  - "pr" entries: repo is extractable from contentHash ("owner/repo:N").
 *  - "orphan" entries: no repo information is stored in the legacy cache,
 *    so we skip them. They'll regenerate on the next run if needed.
 */
export async function migrateSqliteSummariesToDatastore(): Promise<number> {
  const db = getDb();
  const rows = db.select().from(schema.summaries).all();
  let count = 0;

  for (const row of rows) {
    const createdAt =
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date().toISOString();

    if (row.summaryType === "rollup") {
      await writeRollup({
        contentHash: row.contentHash,
        summaryType: "rollup",
        scope: { repos: [] },
        summary: row.summary,
        provider: row.provider,
        createdAt,
      });
      count++;
      continue;
    }

    if (row.summaryType === "pr") {
      const match = row.contentHash.match(/^([^/]+)\/([^:]+):(\d+)$/);
      if (!match) continue;
      const repo = `${match[1]}/${match[2]}`;
      await writeSummary({
        contentHash: row.contentHash,
        summaryType: "pr",
        scope: { repos: [repo] },
        source: { prNumber: parseInt(match[3]!, 10) },
        summary: row.summary,
        provider: row.provider,
        createdAt,
      });
      count++;
      continue;
    }

    // "orphan" entries have no repo info in the legacy cache — skip.
  }

  return count;
}
