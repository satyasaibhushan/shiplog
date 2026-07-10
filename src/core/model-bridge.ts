import type { SupportedLLMProvider } from "../shared/llm-models.ts";

const DEFAULT_URL = "http://127.0.0.1:4141";
const STATUS_TIMEOUT_MS = 15_000;

export interface ModelBridgeProviderStatus {
  id: SupportedLLMProvider;
  name: string;
  available: boolean;
  authenticated: boolean;
  ready: boolean;
  detail: string;
  models: string[];
  structuredOutput: "strict" | "validated";
}

interface ProviderResponse {
  providers: ModelBridgeProviderStatus[];
}

interface GenerateResponse {
  provider: SupportedLLMProvider;
  model?: string;
  text: string;
  durationMs: number;
}

interface ErrorResponse {
  error?: { code?: string; message?: string };
}

function baseUrl(): string {
  return (Bun.env.MODELBRIDGE_URL ?? DEFAULT_URL).replace(/\/$/, "");
}

function headers(includeContentType = false): Headers {
  const result = new Headers({ accept: "application/json" });
  if (includeContentType) result.set("content-type", "application/json");
  if (Bun.env.MODELBRIDGE_TOKEN) {
    result.set("authorization", `Bearer ${Bun.env.MODELBRIDGE_TOKEN}`);
  }
  return result;
}

async function bridgeFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl()}${path}`, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`ModelBridge timed out after ${Math.round(timeoutMs / 1000)}s`, {
        cause: error,
      });
    }
    throw new Error(
      `ModelBridge is unavailable at ${baseUrl()}. Start it with \`bun start\` in ~/Code/Personal/ModelBridge.`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function bridgeError(response: Response): Promise<Error> {
  const payload = (await response.json().catch(() => ({}))) as ErrorResponse;
  return new Error(payload.error?.message ?? `ModelBridge returned HTTP ${response.status}`);
}

export async function fetchModelBridgeProviders(): Promise<ModelBridgeProviderStatus[]> {
  const response = await bridgeFetch(
    "/v1/providers",
    { method: "GET", headers: headers() },
    STATUS_TIMEOUT_MS,
  );
  if (!response.ok) throw await bridgeError(response);
  const payload = (await response.json()) as ProviderResponse;
  return payload.providers;
}

export async function invokeModelBridge(
  prompt: string,
  provider: SupportedLLMProvider,
  model: string | undefined,
  timeoutMs: number,
): Promise<string> {
  const response = await bridgeFetch(
    "/v1/generate",
    {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        provider,
        ...(model ? { model } : {}),
        prompt,
        output: { type: "text" },
        timeoutMs,
      }),
    },
    timeoutMs + 5_000,
  );
  if (!response.ok) throw await bridgeError(response);
  const payload = (await response.json()) as GenerateResponse;
  return payload.text.trim();
}

export async function checkModelBridge(): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await bridgeFetch("/health", { method: "GET" }, STATUS_TIMEOUT_MS);
    return response.ok
      ? { ok: true, detail: baseUrl() }
      : { ok: false, detail: `HTTP ${response.status} from ${baseUrl()}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
