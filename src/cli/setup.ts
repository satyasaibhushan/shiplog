import { $ } from "bun";
import { select, confirm } from "./prompt.ts";

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

// ── LLM CLIs ─────────────────────────────────────────────

type LLMChoice = "claude" | "codex" | "both" | "skip";

async function promptLLMChoice(claudeInstalled: boolean, codexInstalled: boolean): Promise<LLMChoice> {
  const options: { label: string; value: LLMChoice; description?: string }[] = [];

  if (!claudeInstalled) {
    options.push({ label: "Claude Code", value: "claude", description: "Anthropic" });
  }
  if (!codexInstalled) {
    options.push({ label: "Codex CLI", value: "codex", description: "OpenAI" });
  }
  if (!claudeInstalled && !codexInstalled) {
    options.push({ label: "Both", value: "both" });
  }
  options.push({ label: "Skip for now", value: "skip" });

  return select("Which LLM CLI would you like to install?", options);
}

async function installClaude(): Promise<boolean> {
  return runInstall("Claude Code", ["bun", "install", "-g", "@anthropic-ai/claude-code"]);
}

async function installCodex(): Promise<boolean> {
  return runInstall("Codex CLI", ["bun", "install", "-g", "codex"]);
}

// ── Main ─────────────────────────────────────────────────

export async function checkDependencies(): Promise<void> {
  console.log("Checking dependencies...\n");

  // Check current state
  const gh = await checkCommand("gh");
  const claude = await checkCommand("claude");
  const codex = await checkCommand("codex");

  console.log(`  ${gh.ok ? "✓" : "✗"} gh (GitHub CLI)${gh.version ? ` — ${gh.version}` : ""}`);
  console.log(`  ${claude.ok ? "✓" : "✗"} claude (Claude Code)${claude.version ? ` — ${claude.version}` : ""}`);
  console.log(`  ${codex.ok ? "✓" : "✗"} codex (Codex CLI)${codex.version ? ` — ${codex.version}` : ""}`);

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

  // ── LLM CLIs ──

  const hasLLM = claude.ok || codex.ok;

  if (!hasLLM) {
    const choice = await promptLLMChoice(claude.ok, codex.ok);

    switch (choice) {
      case "claude":
        await installClaude();
        break;
      case "codex":
        await installCodex();
        break;
      case "both":
        await installClaude();
        await installCodex();
        break;
      case "skip":
        console.log("\n  Skipped. You can install one later and re-run `shiplog setup`.");
        break;
    }
  }

  // ── Final status ──

  console.log("\n  ── Status ──\n");

  const ghFinal = await checkCommand("gh");
  const claudeFinal = await checkCommand("claude");
  const codexFinal = await checkCommand("codex");

  console.log(`  ${ghFinal.ok ? "✓" : "✗"} gh`);
  console.log(`  ${claudeFinal.ok ? "✓" : "✗"} claude`);
  console.log(`  ${codexFinal.ok ? "✓" : "✗"} codex`);
  console.log();

  if (ghFinal.ok && (claudeFinal.ok || codexFinal.ok)) {
    console.log("  All good! Run `shiplog` to get started.\n");
  } else {
    console.log("  Some dependencies are missing. Run `shiplog setup` again after installing.\n");
  }
}
