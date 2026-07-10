export const SUPPORTED_LLM_PROVIDERS = [
  "claude-cli",
  "codex-cli",
  "cursor-cli",
  "copilot-cli",
  "claude-api",
  "codex-api",
] as const;

export const LEGACY_LLM_PROVIDERS = ["claude", "codex", "cursor"] as const;

export type SupportedLLMProvider = (typeof SUPPORTED_LLM_PROVIDERS)[number];
export type LegacyLLMProvider = (typeof LEGACY_LLM_PROVIDERS)[number];
export type LLMProviderInput = SupportedLLMProvider | LegacyLLMProvider | "auto";

export interface LLMModelOption {
  id: string;
  label: string;
  description: string;
}

export interface LLMProviderOption {
  id: SupportedLLMProvider;
  label: string;
  icon: string;
  models: LLMModelOption[];
}

export const LLM_PROVIDERS: LLMProviderOption[] = [
  {
    id: "claude-cli",
    label: "Claude CLI",
    icon: "✦",
    models: [
      { id: "sonnet", label: "Sonnet 4.6", description: "Fast, capable default" },
      { id: "haiku", label: "Haiku 4.5", description: "Fastest for lightweight tasks" },
      { id: "opus", label: "Opus 4.6", description: "Best for complex analysis" },
    ],
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    icon: "◈",
    models: [
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "Fast and efficient" },
      { id: "gpt-5.5", label: "GPT-5.5", description: "Current capable default" },
    ],
  },
  {
    id: "cursor-cli",
    label: "Cursor CLI",
    icon: "◎",
    models: [
      { id: "auto", label: "Auto", description: "Let Cursor choose" },
      { id: "composer-2", label: "Composer 2", description: "Cursor agent model" },
      { id: "kimi-k2.5", label: "Kimi K2.5", description: "Moonshot flagship" },
    ],
  },
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    icon: "⌁",
    models: [{ id: "auto", label: "Auto", description: "Let Copilot choose" }],
  },
  {
    id: "claude-api",
    label: "Claude API",
    icon: "◆",
    models: [
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "Configured API default",
      },
    ],
  },
  {
    id: "codex-api",
    label: "Codex API",
    icon: "◇",
    models: [{ id: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "Configured API default" }],
  },
];

const LEGACY_PROVIDER_MAP: Record<LegacyLLMProvider, SupportedLLMProvider> = {
  claude: "claude-cli",
  codex: "codex-cli",
  cursor: "cursor-cli",
};

export function normalizeProviderId(provider: string): SupportedLLMProvider | null {
  if (SUPPORTED_LLM_PROVIDERS.includes(provider as SupportedLLMProvider)) {
    return provider as SupportedLLMProvider;
  }
  if (LEGACY_LLM_PROVIDERS.includes(provider as LegacyLLMProvider)) {
    return LEGACY_PROVIDER_MAP[provider as LegacyLLMProvider];
  }
  return null;
}

export function getProviderModels(provider: SupportedLLMProvider): LLMModelOption[] {
  return LLM_PROVIDERS.find((entry) => entry.id === provider)?.models ?? [];
}

export function mergeProviderModels(
  provider: SupportedLLMProvider,
  runtimeModels: LLMModelOption[] | null | undefined,
): LLMModelOption[] {
  const configured = getProviderModels(provider);
  if (!runtimeModels || runtimeModels.length === 0) return configured;

  const runtimeById = new Map(runtimeModels.map((model) => [model.id, model]));
  const merged: LLMModelOption[] = [];
  const seen = new Set<string>();

  for (const model of configured) {
    if (!runtimeById.has(model.id)) continue;
    merged.push(model);
    seen.add(model.id);
  }

  for (const model of runtimeModels) {
    if (seen.has(model.id)) continue;
    merged.push(model);
    seen.add(model.id);
  }

  return merged.length > 0 ? merged : configured;
}

export function getDefaultModel(provider: SupportedLLMProvider): string {
  return getProviderModels(provider)[0]?.id ?? "";
}

export function isSupportedProvider(value: string): value is SupportedLLMProvider {
  return SUPPORTED_LLM_PROVIDERS.includes(value as SupportedLLMProvider);
}

export function isModelSupportedForProvider(
  provider: SupportedLLMProvider,
  model: string | undefined,
): boolean {
  if (!model) return false;
  return getProviderModels(provider).some((entry) => entry.id === model);
}

export function normalizeProviderModel(
  provider: string | undefined,
  model: string | undefined,
): { provider: SupportedLLMProvider; model: string } {
  const resolvedProvider = normalizeProviderId(provider ?? "") ?? "claude-cli";
  const resolvedModel = isModelSupportedForProvider(resolvedProvider, model)
    ? model!
    : getDefaultModel(resolvedProvider);

  return { provider: resolvedProvider, model: resolvedModel };
}
