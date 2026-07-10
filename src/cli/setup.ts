import { $ } from "bun";
import { confirm } from "./prompt.ts";
import { checkModelBridge } from "../core/model-bridge.ts";
import { getProviderStatus } from "../core/provider-status.ts";

// ── Helpers ──────────────────────────────────────────────

async function checkCommand(command: string): Promise<{ ok: boolean; version?: string }> {
  try {
    const result = await $`which ${command}`.quiet();
    if (result.exitCode === 0) {
      const versionResult = await $`${command} --version`.quiet();
      return { ok: true, version: versionResult.stdout.toString().trim() };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function detectPlatform(): Promise<"macos-brew" | "macos" | "linux" | "unknown"> {
  if (process.platform === "darwin") {
    const brew = await checkCommand("brew");
    return brew.ok ? "macos-brew" : "macos";
  }
  if (process.platform === "linux") return "linux";
  return "unknown";
}

async function runInstall(label: string, command: string[]): Promise<boolean> {
  console.log(`\n  Installing ${label}...`);
  console.log(`  $ ${command.join(" ")}\n`);

  try {
    const proc = Bun.spawn(command, {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log(`\n  ✓ ${label} installed successfully.`);
      return true;
    }
    console.error(`\n  ✗ ${label} installation failed (exit code ${exitCode}).`);
    return false;
  } catch (err) {
    console.error(`\n  ✗ ${label} installation failed:`, err);
    return false;
  }
}

// ── gh CLI ───────────────────────────────────────────────

async function installGh(): Promise<boolean> {
  const platform = await detectPlatform();

  switch (platform) {
    case "macos-brew":
      return runInstall("GitHub CLI", ["brew", "install", "gh"]);

    case "macos":
      console.log("  Homebrew not found. Install gh manually:");
      console.log("    1. Install Homebrew: https://brew.sh");
      console.log("    2. Run: brew install gh");
      console.log("    Or download from: https://cli.github.com/");
      return false;

    case "linux":
      console.log("  Install gh for your distro:");
      console.log("    Debian/Ubuntu:  sudo apt install gh");
      console.log("    Fedora:         sudo dnf install gh");
      console.log("    Arch:           sudo pacman -S github-cli");
      console.log("    Or see: https://github.com/cli/cli/blob/trunk/docs/install_linux.md");
      return false;

    default:
      console.log("  Download gh from: https://cli.github.com/");
      return false;
  }
}

// ── Main ─────────────────────────────────────────────────

export async function checkDependencies(): Promise<void> {
  console.log("Checking dependencies...\n");

  // Check current state
  const gh = await checkCommand("gh");
  const bridge = await checkModelBridge();
  const providers = await getProviderStatus({ force: true });
  const readyProviders = Object.entries(providers).filter(
    ([, status]) => status.installed && status.authed,
  );

  console.log(`  ${gh.ok ? "✓" : "✗"} gh (GitHub CLI)${gh.version ? ` — ${gh.version}` : ""}`);
  console.log(`  ${bridge.ok ? "✓" : "✗"} ModelBridge — ${bridge.detail}`);
  for (const [id, status] of Object.entries(providers)) {
    console.log(`  ${status.installed && status.authed ? "✓" : "✗"} ${id} — ${status.detail}`);
  }

  // ── gh CLI ──

  if (!gh.ok) {
    const shouldInstall = await confirm("gh CLI is required. Install it now?");
    if (shouldInstall) {
      const success = await installGh();
      if (success) {
        console.log();
        const authCheck = await $`gh auth status`.quiet().nothrow();
        if (authCheck.exitCode !== 0) {
          console.log("  gh installed but not authenticated. Run:");
          console.log("    gh auth login\n");
        }
      }
    } else {
      console.log("\n  Skipped. You'll need gh to fetch GitHub data.\n");
    }
  }

  if (!bridge.ok) {
    console.log("\n  Start ModelBridge in another terminal:");
    console.log("    cd ~/Code/Personal/ModelBridge && bun start");
  } else if (readyProviders.length === 0) {
    console.log("\n  ModelBridge is running, but no provider is authenticated.");
    console.log("  Configure a CLI login or API key in the ModelBridge environment.");
  }

  // ── Final status ──

  console.log("\n  ── Status ──\n");

  const ghFinal = await checkCommand("gh");
  const bridgeFinal = await checkModelBridge();
  const providerFinal = await getProviderStatus({ force: true });
  const hasProvider = Object.values(providerFinal).some(
    (status) => status.installed && status.authed,
  );

  console.log(`  ${ghFinal.ok ? "✓" : "✗"} gh`);
  console.log(`  ${bridgeFinal.ok ? "✓" : "✗"} ModelBridge`);
  console.log(`  ${hasProvider ? "✓" : "✗"} model provider`);
  console.log();

  if (ghFinal.ok && bridgeFinal.ok && hasProvider) {
    console.log("  All good! Run `shiplog` to get started.\n");
  } else {
    console.log("  Some dependencies are missing. Run `shiplog setup` again after installing.\n");
  }
}
