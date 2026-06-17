// Provider availability probe.
//
// For each LLM CLI we care about two things:
//   - installed: is the binary on PATH?
//   - authed:    does the CLI consider the user logged in?
//
// Running an LLM prompt against an unauth'd CLI fails with confusing output
// (cursor renders a login TUI to stdout, for example). The UI uses this to
// hide provider tiles that aren't actually usable, rather than letting the
// user pick a broken option.

import { $ } from "bun";
import {
  getDefaultModel,
  getProviderModels as getConfiguredProviderModels,
  mergeProviderModels,
  type LLMModelOption,
  type SupportedLLMProvider,
} from "../shared/llm-models.ts";

export interface ProviderStatus {
  installed: boolean;
  authed: boolean;
  models: LLMModelOption[];
  modelCatalogSource: "configured" | "runtime";
}

export interface ProviderStatusMap {
  claude: ProviderStatus;
  codex: ProviderStatus;
  cursor: ProviderStatus;
}

const PROBE_TIMEOUT_MS = 4000;
const MODEL_DISCOVERY_TIMEOUT_MS = 12000;
const STATUS_CACHE_TTL_MS = 30000;

let cachedStatus: ProviderStatusMap | null = null;
let cacheExpiresAt = 0;
let inflightStatus: Promise<ProviderStatusMap> | null = null;

async function isInstalled(cmd: string): Promise<boolean> {
  try {
    const r = await $`which ${cmd}`.quiet().nothrow();
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Spawn a probe command with stdin closed and a hard timeout. Returns the
 * captured stdout+stderr text plus the exit code, or null on timeout.
 */
async function runProbe(
  args: string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ output: string; stdout: string; stderr: string; exitCode: number } | null> {
  const proc = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const collect = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { output: stdout + stderr, stdout, stderr, exitCode };
  })();

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, timeoutMs),
  );

  return Promise.race([collect, timeout]);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
}

function configuredStatus(
  provider: SupportedLLMProvider,
  installed: boolean,
  authed: boolean,
): ProviderStatus {
  return {
    installed,
    authed,
    models: getConfiguredProviderModels(provider),
    modelCatalogSource: "configured",
  };
}

interface CodexCatalogResponse {
  models?: Array<{
    slug?: string;
    display_name?: string;
    description?: string;
    visibility?: string;
    supported_in_api?: boolean;
  }>;
}

async function discoverCodexModels(): Promise<LLMModelOption[] | null> {
  const r = await runProbe(["codex", "debug", "models"], MODEL_DISCOVERY_TIMEOUT_MS);
  if (!r || r.exitCode !== 0) return null;

  try {
    const parsed = JSON.parse(r.stdout) as CodexCatalogResponse;
    const items = Array.isArray(parsed.models) ? parsed.models : [];
    const out: LLMModelOption[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      const id = item.slug?.trim();
      if (!id || seen.has(id)) continue;
      if (item.supported_in_api === false) continue;
      if (item.visibility && item.visibility !== "list") continue;
      out.push({
        id,
        label: item.display_name?.trim() || id,
        description: item.description?.trim() || "Runtime-discovered model",
      });
      seen.add(id);
    }

    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function probeClaude(): Promise<ProviderStatus> {
  if (!(await isInstalled("claude"))) return configuredStatus("claude", false, false);

  const r = await runProbe(["claude", "auth", "status"]);
  if (!r || r.exitCode !== 0) return configuredStatus("claude", true, false);

  try {
    const parsed = JSON.parse(r.output);
    return configuredStatus("claude", true, parsed?.loggedIn === true);
  } catch {
    return configuredStatus("claude", true, false);
  }
}

async function probeCodex(): Promise<ProviderStatus> {
  if (!(await isInstalled("codex"))) return configuredStatus("codex", false, false);

  const r = await runProbe(["codex", "login", "status"]);
  if (!r || r.exitCode !== 0) return configuredStatus("codex", true, false);

  // Authed:   "Logged in using ChatGPT" / "Logged in as ..."
  // Unauthed: "Not logged in"
  const out = stripAnsi(r.output).toLowerCase();
  if (out.includes("not logged in")) return configuredStatus("codex", true, false);

  const authed = out.includes("logged in");
  if (!authed) return configuredStatus("codex", true, false);

  const discovered = await discoverCodexModels();
  return {
    installed: true,
    authed: true,
    models: mergeProviderModels("codex", discovered),
    modelCatalogSource: discovered ? "runtime" : "configured",
  };
}

async function probeCursor(): Promise<ProviderStatus> {
  if (!(await isInstalled("cursor-agent"))) {
    return configuredStatus("cursor", false, false);
  }

  // `cursor-agent status` with stdin closed exits 0 and writes status to stdout
  // wrapped in ANSI control codes — it would otherwise render a TUI login flow.
  const r = await runProbe(["cursor-agent", "status"]);
  if (!r || r.exitCode !== 0) return configuredStatus("cursor", true, false);

  const out = stripAnsi(r.output).toLowerCase();
  if (out.includes("not logged in")) return configuredStatus("cursor", true, false);
  return configuredStatus("cursor", true, out.includes("logged in"));
}

export async function getProviderStatus(
  options: { force?: boolean } = {},
): Promise<ProviderStatusMap> {
  const { force = false } = options;
  const now = Date.now();

  if (!force && cachedStatus && now < cacheExpiresAt) {
    return cachedStatus;
  }
  if (!force && inflightStatus) {
    return inflightStatus;
  }

  inflightStatus = (async () => {
    const [claude, codex, cursor] = await Promise.all([
      probeClaude(),
      probeCodex(),
      probeCursor(),
    ]);
    const next = { claude, codex, cursor };
    cachedStatus = next;
    cacheExpiresAt = Date.now() + STATUS_CACHE_TTL_MS;
    return next;
  })();

  try {
    return await inflightStatus;
  } finally {
    inflightStatus = null;
  }
}

export async function getAvailableModelsForProvider(
  provider: SupportedLLMProvider,
): Promise<LLMModelOption[]> {
  const status = await getProviderStatus();
  const models = status[provider].models;
  return models.length > 0 ? models : getConfiguredProviderModels(provider);
}

export async function getDefaultAvailableModel(
  provider: SupportedLLMProvider,
): Promise<string> {
  const models = await getAvailableModelsForProvider(provider);
  return models[0]?.id ?? getDefaultModel(provider);
}
