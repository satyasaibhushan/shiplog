import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";

export interface ShiplogConfig {
  llm: "claude" | "codex" | "auto";
  defaultScope: string[];
  excludePatterns: string[];
  /** Additional git emails to search for (catches commits from old laptops, unlinked emails) */
  gitEmails: string[];
  port: number;
  theme: "dark" | "light";
}

const CONFIG_DIR = join(homedir(), ".shiplog");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const DEFAULT_CONFIG: ShiplogConfig = {
  llm: "auto",
  defaultScope: ["merged-prs", "direct-commits"],
  excludePatterns: ["*.lock", "*.generated.*"],
  gitEmails: [],
  port: 3847,
  theme: "dark",
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
      return { ...DEFAULT_CONFIG, ...userConfig };
    } catch {
      console.warn("Warning: Could not parse config file, using defaults.");
      return DEFAULT_CONFIG;
    }
  }

  // Write default config on first run
  await saveConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export async function saveConfig(config: ShiplogConfig): Promise<void> {
  ensureConfigDir();
  await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getDbPath(): string {
  return join(CONFIG_DIR, "cache.sqlite");
}
