export type SupportedLLMProvider = "claude" | "codex" | "cursor";

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
    id: "claude",
    label: "Claude Code",
    icon: "✦",
    models: [
      { id: "sonnet", label: "Sonnet 4.6", description: "Best value - fast, smart" },
      { id: "haiku", label: "Haiku 4.5", description: "Fastest - lightweight tasks" },
      { id: "opus", label: "Opus 4.6", description: "Most capable - complex analysis" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    icon: "◈",
    models: [
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "Fast, efficient" },
      { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "Balanced" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: "Most capable" },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    icon: "◎",
    models: [
      { id: "auto", label: "Auto", description: "Cursor picks the model" },
      { id: "composer-2", label: "Composer 2", description: "Cursor's agent model" },
      { id: "kimi-k2.5", label: "Kimi K2.5", description: "Moonshot's flagship" },
    ],
  },
];

export function getDefaultModel(provider: SupportedLLMProvider): string {
  const entry = LLM_PROVIDERS.find((p) => p.id === provider);
  return entry?.models[0]?.id ?? "";
}

export function isSupportedProvider(value: string): value is SupportedLLMProvider {
  return LLM_PROVIDERS.some((provider) => provider.id === value);
}

export function isModelSupportedForProvider(
  provider: SupportedLLMProvider,
  model: string | undefined,
): boolean {
  if (!model) return false;
  return LLM_PROVIDERS
    .find((entry) => entry.id === provider)
    ?.models.some((entry) => entry.id === model) ?? false;
}

export function normalizeProviderModel(
  provider: string | undefined,
  model: string | undefined,
): { provider: SupportedLLMProvider; model: string } {
  const providerInput = provider ?? "";
  const resolvedProvider: SupportedLLMProvider = isSupportedProvider(providerInput)
    ? providerInput
    : "claude";
  const resolvedModel = isModelSupportedForProvider(resolvedProvider, model)
    ? model!
    : getDefaultModel(resolvedProvider);

  return { provider: resolvedProvider, model: resolvedModel };
}
