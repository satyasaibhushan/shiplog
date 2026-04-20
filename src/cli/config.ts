import { join, dirname } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import { queueWrite } from "../core/git-sync.ts";

export interface SyncConfig {
  /** Master switch. When false, no git operations run. */
  enabled: boolean;
  /** HTTPS URL of the private GitHub repo used as the data store. */
  remoteUrl?: string;
  /** Whether to pull on CLI startup (non-blocking). */
  pullOnStart: boolean;
  /** Max ms to wait for the startup pull before continuing. */
  pullTimeoutMs: number;
  /** Debounce window (ms) for coalescing writes into a single commit. */
  pushDebounceMs: number;
  /**
   * Set once we've asked the user about sync (first-run prompt). Never
   * re-prompt after this is populated — change via `shiplog sync init`.
   */
  promptedAt: string | null;
}

export interface ShiplogConfig {
  llm: "claude" | "codex" | "auto";
  defaultScope: string[];
  excludePatterns: string[];
  /** Additional git emails to search for (catches commits from old laptops, unlinked emails) */
  gitEmails: string[];
  port: number;
  theme: "dark" | "light";
  sync: SyncConfig;
}

const CONFIG_DIR = join(homedir(), ".shiplog");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_DATA_DIR = join(homedir(), ".shiplog-data");

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  pullOnStart: true,
  pullTimeoutMs: 5000,
  pushDebounceMs: 2000,
  promptedAt: null,
};

export const DEFAULT_CONFIG: ShiplogConfig = {
  llm: "auto",
  defaultScope: ["merged-prs", "direct-commits"],
  excludePatterns: ["*.lock", "*.generated.*"],
  gitEmails: [],
  port: 3847,
  theme: "dark",
  sync: DEFAULT_SYNC_CONFIG,
};

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export async function loadConfig(): Promise<ShiplogConfig> {
  ensureConfigDir();

  const configFile = Bun.file(CONFIG_FILE);
  if (await configFile.exists()) {
    try {
      const userConfig = await configFile.json();
      // Merge nested `sync` explicitly so new sync keys pick up defaults
      // when loading an older config that predates the feature.
      return {
        ...DEFAULT_CONFIG,
        ...userConfig,
        sync: { ...DEFAULT_SYNC_CONFIG, ...(userConfig?.sync ?? {}) },
      };
    } catch {
      console.warn("Warning: Could not parse config file, using defaults.");
      return DEFAULT_CONFIG;
    }
  }

  // Write default config on first run
  await saveConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

// Shared config = everything except the per-machine `sync` section.
export type SharedConfig = Omit<ShiplogConfig, "sync">;

function pickShared(cfg: ShiplogConfig): SharedConfig {
  const { sync: _sync, ...shared } = cfg;
  return shared;
}

export async function saveConfig(config: ShiplogConfig): Promise<void> {
  ensureConfigDir();
  await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));

  // Mirror the shared portion into the synced data dir so other machines
  // pick it up on their next pull. Only when sync is actually enabled —
  // otherwise we'd leave a dangling file the user didn't opt into.
  if (config.sync.enabled) {
    const sharedPath = getSharedConfigPath();
    mkdirSync(dirname(sharedPath), { recursive: true });
    await Bun.write(sharedPath, JSON.stringify(pickShared(config), null, 2));
    queueWrite(config.sync, sharedPath, "config");
  }
}

/**
 * Path to the synced shared-config file inside the data dir. Not a config
 * option itself — always derived from `getDataDir()`.
 */
export function getSharedConfigPath(): string {
  return join(getDataDir(), "config.json");
}

/**
 * If a synced shared-config file exists (i.e. another machine has written
 * one), overlay its fields onto `local` and persist the result. The local
 * `sync` section is always preserved — it's per-machine.
 *
 * Call this after `pullIfDue` so the freshly-pulled shared config takes
 * effect this run.
 */
export async function mergeSharedConfig(
  local: ShiplogConfig,
): Promise<ShiplogConfig> {
  const sharedPath = getSharedConfigPath();
  const f = Bun.file(sharedPath);
  if (!(await f.exists())) return local;

  let shared: Partial<SharedConfig>;
  try {
    shared = (await f.json()) as Partial<SharedConfig>;
  } catch {
    console.warn("  shiplog sync: shared config is malformed, ignoring");
    return local;
  }

  const merged: ShiplogConfig = {
    ...local,
    ...shared,
    sync: local.sync,
  };

  // No-op if shared fields didn't actually change. Avoids a redundant
  // write + re-queue cycle when the remote just echoes our own state.
  if (JSON.stringify(pickShared(local)) === JSON.stringify(pickShared(merged))) {
    return local;
  }

  await saveConfig(merged);
  return merged;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getDbPath(): string {
  return join(CONFIG_DIR, "cache.sqlite");
}

/**
 * Root of the git-backed data directory. Overridable via SHIPLOG_DATA_DIR
 * (primarily for tests — production should just use the default).
 */
export function getDataDir(): string {
  return process.env.SHIPLOG_DATA_DIR ?? DEFAULT_DATA_DIR;
}
