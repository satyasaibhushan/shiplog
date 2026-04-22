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

export interface ProviderStatus {
  installed: boolean;
  authed: boolean;
}

export interface ProviderStatusMap {
  claude: ProviderStatus;
  codex: ProviderStatus;
  cursor: ProviderStatus;
}

const PROBE_TIMEOUT_MS = 4000;

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
): Promise<{ output: string; exitCode: number } | null> {
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
    return { output: stdout + stderr, exitCode };
  })();

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, PROBE_TIMEOUT_MS),
  );

  return Promise.race([collect, timeout]);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
}

async function probeClaude(): Promise<ProviderStatus> {
  if (!(await isInstalled("claude"))) return { installed: false, authed: false };

  const r = await runProbe(["claude", "auth", "status"]);
  if (!r || r.exitCode !== 0) return { installed: true, authed: false };

  try {
    const parsed = JSON.parse(r.output);
    return { installed: true, authed: parsed?.loggedIn === true };
  } catch {
    return { installed: true, authed: false };
  }
}

async function probeCodex(): Promise<ProviderStatus> {
  if (!(await isInstalled("codex"))) return { installed: false, authed: false };

  const r = await runProbe(["codex", "login", "status"]);
  if (!r || r.exitCode !== 0) return { installed: true, authed: false };

  // Authed:   "Logged in using ChatGPT" / "Logged in as ..."
  // Unauthed: "Not logged in"
  const out = stripAnsi(r.output).toLowerCase();
  if (out.includes("not logged in")) return { installed: true, authed: false };
  return { installed: true, authed: out.includes("logged in") };
}

async function probeCursor(): Promise<ProviderStatus> {
  if (!(await isInstalled("cursor-agent"))) {
    return { installed: false, authed: false };
  }

  // `cursor-agent status` with stdin closed exits 0 and writes status to stdout
  // wrapped in ANSI control codes — it would otherwise render a TUI login flow.
  const r = await runProbe(["cursor-agent", "status"]);
  if (!r || r.exitCode !== 0) return { installed: true, authed: false };

  const out = stripAnsi(r.output).toLowerCase();
  if (out.includes("not logged in")) return { installed: true, authed: false };
  return { installed: true, authed: out.includes("logged in") };
}

export async function getProviderStatus(): Promise<ProviderStatusMap> {
  const [claude, codex, cursor] = await Promise.all([
    probeClaude(),
    probeCodex(),
    probeCursor(),
  ]);
  return { claude, codex, cursor };
}
