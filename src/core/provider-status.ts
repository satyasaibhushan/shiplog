import { fetchModelBridgeProviders } from "./model-bridge.ts";
import {
  LLM_PROVIDERS,
  getDefaultModel,
  getProviderModels as getConfiguredProviderModels,
  mergeProviderModels,
  normalizeProviderId,
  type LLMModelOption,
  type LLMProviderInput,
  type SupportedLLMProvider,
} from "../shared/llm-models.ts";

export interface ProviderStatus {
  installed: boolean;
  authed: boolean;
  detail: string;
  models: LLMModelOption[];
  modelCatalogSource: "configured" | "runtime";
}

export type ProviderStatusMap = Record<SupportedLLMProvider, ProviderStatus>;

const STATUS_CACHE_TTL_MS = 30_000;
let cachedStatus: ProviderStatusMap | null = null;
let cacheExpiresAt = 0;
let inflightStatus: Promise<ProviderStatusMap> | null = null;

function unavailableMap(detail: string): ProviderStatusMap {
  return Object.fromEntries(
    LLM_PROVIDERS.map((provider) => [
      provider.id,
      {
        installed: false,
        authed: false,
        detail,
        models: provider.models,
        modelCatalogSource: "configured" as const,
      },
    ]),
  ) as ProviderStatusMap;
}

async function loadProviderStatus(): Promise<ProviderStatusMap> {
  try {
    const remote = await fetchModelBridgeProviders();
    const byId = new Map(remote.map((status) => [status.id, status]));
    return Object.fromEntries(
      LLM_PROVIDERS.map((provider) => {
        const status = byId.get(provider.id);
        const runtimeModels = (status?.models ?? []).map((id) => {
          const configured = provider.models.find((entry) => entry.id === id);
          return configured ?? { id, label: id, description: "Available through ModelBridge" };
        });
        return [
          provider.id,
          {
            installed: status?.available ?? false,
            authed: status?.authenticated ?? false,
            detail: status?.detail ?? "Provider is missing from ModelBridge",
            models: mergeProviderModels(provider.id, runtimeModels),
            modelCatalogSource: runtimeModels.length > 0 ? "runtime" : "configured",
          },
        ];
      }),
    ) as ProviderStatusMap;
  } catch (error) {
    return unavailableMap(error instanceof Error ? error.message : String(error));
  }
}

export async function getProviderStatus(
  options: { force?: boolean } = {},
): Promise<ProviderStatusMap> {
  const { force = false } = options;
  const now = Date.now();
  if (!force && cachedStatus && now < cacheExpiresAt) return cachedStatus;
  if (!force && inflightStatus) return inflightStatus;

  inflightStatus = loadProviderStatus();
  try {
    const next = await inflightStatus;
    cachedStatus = next;
    cacheExpiresAt = Date.now() + STATUS_CACHE_TTL_MS;
    return next;
  } finally {
    inflightStatus = null;
  }
}

export async function resolveAvailableProvider(
  provider: LLMProviderInput,
): Promise<SupportedLLMProvider> {
  const statuses = await getProviderStatus();
  if (provider !== "auto") {
    const normalized = normalizeProviderId(provider);
    if (!normalized) throw new Error(`Unknown model provider: ${provider}`);
    const status = statuses[normalized];
    if (!status.installed || !status.authed) {
      throw new Error(`${normalized} is unavailable: ${status.detail}`);
    }
    return normalized;
  }

  const available = LLM_PROVIDERS.find((entry) => {
    const status = statuses[entry.id];
    return status.installed && status.authed;
  });
  if (!available) {
    const detail = statuses[LLM_PROVIDERS[0]!.id].detail;
    throw new Error(`No ModelBridge provider is ready. ${detail}`);
  }
  return available.id;
}

export async function getAvailableModelsForProvider(
  provider: SupportedLLMProvider,
): Promise<LLMModelOption[]> {
  const status = await getProviderStatus();
  const models = status[provider].models;
  return models.length > 0 ? models : getConfiguredProviderModels(provider);
}

export async function getDefaultAvailableModel(provider: SupportedLLMProvider): Promise<string> {
  const models = await getAvailableModelsForProvider(provider);
  return models[0]?.id ?? getDefaultModel(provider);
}
