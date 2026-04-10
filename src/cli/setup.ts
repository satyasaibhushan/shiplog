import { $ } from "bun";

interface DependencyStatus {
  name: string;
  installed: boolean;
  version?: string;
}

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

export async function checkDependencies(): Promise<void> {
  console.log("Checking dependencies...\n");

  const deps: DependencyStatus[] = [];

  // Check gh CLI
  const gh = await checkCommand("gh");
  deps.push({ name: "gh (GitHub CLI)", installed: gh.ok, version: gh.version });

  // Check claude CLI
  const claude = await checkCommand("claude");
  deps.push({ name: "claude (Claude Code)", installed: claude.ok, version: claude.version });

  // Check codex CLI
  const codex = await checkCommand("codex");
  deps.push({ name: "codex (Codex CLI)", installed: codex.ok, version: codex.version });

  // Display results
  for (const dep of deps) {
    const status = dep.installed ? "✓" : "✗";
    const version = dep.version ? ` (${dep.version})` : "";
    console.log(`  ${status} ${dep.name}${version}`);
  }

  console.log();

  // Check required dependencies
  const ghDep = deps.find((d) => d.name.startsWith("gh"));
  if (!ghDep?.installed) {
    console.log("⚠ gh CLI is required. Install it:");
    console.log("  brew install gh    # macOS");
    console.log("  https://cli.github.com/");
    console.log();
  }

  const hasLLM = deps.some((d) => (d.name.startsWith("claude") || d.name.startsWith("codex")) && d.installed);
  if (!hasLLM) {
    console.log("⚠ An LLM CLI is required for summarization. Install one:");
    console.log("  claude — https://docs.anthropic.com/en/docs/claude-code");
    console.log("  codex  — https://github.com/openai/codex");
    console.log();
  }

  if (ghDep?.installed && hasLLM) {
    console.log("All dependencies are installed. You're good to go!");
  }
}
