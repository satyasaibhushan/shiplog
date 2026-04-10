// LLM integration (claude/codex abstraction)
// TODO: Implement in Phase 4

import { $ } from "bun";

export type LLMProvider = "claude" | "codex" | "auto";

export interface SummaryResult {
  summary: string;
  provider: LLMProvider;
}

async function detectProvider(): Promise<"claude" | "codex" | null> {
  try {
    const claude = await $`which claude`.quiet();
    if (claude.exitCode === 0) return "claude";
  } catch {}

  try {
    const codex = await $`which codex`.quiet();
    if (codex.exitCode === 0) return "codex";
  } catch {}

  return null;
}

export async function summarize(
  diffs: string,
  prompt: string,
  provider: LLMProvider = "auto",
): Promise<SummaryResult> {
  const resolvedProvider = provider === "auto" ? await detectProvider() : provider;

  if (!resolvedProvider) {
    throw new Error(
      "No LLM CLI found. Install claude or codex. Run `shiplog setup` for details.",
    );
  }

  // TODO: Implement actual LLM invocation
  // claude: echo "<diffs>" | claude -p "<prompt>"
  // codex:  echo "<diffs>" | codex exec "<prompt>"
  return { summary: "", provider: resolvedProvider };
}
