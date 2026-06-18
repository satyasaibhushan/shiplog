// Provider-availability lookup shared across the app.
//
// The server probe takes ~1s (claude/codex/cursor CLIs in parallel), so we
// fetch it once at app boot, cache the result at module scope, and hand the
// same snapshot to every component that needs it. Opening the "new log"
// modal — which is the only real consumer today — should therefore be
// instant, not block on a fresh probe.

import { useCallback, useEffect, useState } from "react";
import {
  getProviderModels,
  type LLMModelOption,
} from "../../shared/llm-models.ts";

export interface ProviderStatus {
  installed: boolean;
  authed: boolean;
  models: LLMModelOption[];
  modelCatalogSource: "configured" | "runtime";
}

export type ProviderId = "claude" | "codex" | "cursor";
export type ProviderStatusMap = Record<ProviderId, ProviderStatus>;

// Module-level cache. Populated by the first `loadStatus()` call (invoked
// either lazily by a hook consumer or eagerly via `prefetchProviderStatus`).
let cache: ProviderStatusMap | null = null;
let inflight: Promise<ProviderStatusMap> | null = null;

const OPTIMISTIC: ProviderStatusMap = {
  claude: {
    installed: true,
    authed: true,
    models: getProviderModels("claude"),
    modelCatalogSource: "configured",
  },
  codex: {
    installed: true,
    authed: true,
    models: getProviderModels("codex"),
    modelCatalogSource: "configured",
  },
  cursor: {
    installed: true,
    authed: true,
    models: getProviderModels("cursor"),
    modelCatalogSource: "configured",
  },
};

async function loadStatus(forceRefresh: boolean = false): Promise<ProviderStatusMap> {
  if (!forceRefresh && cache) return cache;
  if (inflight) return inflight;
  const previous = cache;
  inflight = (async () => {
    try {
      const url = forceRefresh ? "/api/providers?refresh=1" : "/api/providers";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ProviderStatusMap;
      cache = data;
      return data;
    } catch {
      if (previous) return previous;
      // On probe failure, optimistically assume everything works. The LLM
      // call will surface the real error at invoke time, which is at least
      // specific about what went wrong — better than blocking the whole UI
      // because one request flaked.
      cache = OPTIMISTIC;
      return OPTIMISTIC;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Kick off the provider probe without waiting for a component to mount.
 * Call this once at app boot (e.g. from `main.tsx`) so the data is warm
 * by the time any UI surface needs it.
 */
export function prefetchProviderStatus(): void {
  void loadStatus();
}

export interface UseProviderStatusResult {
  /** `null` while the first fetch is still in flight. */
  status: ProviderStatusMap | null;
  /** `true` while a manual refresh is in flight (initial load excluded). */
  refreshing: boolean;
  /** Re-probe the server, bypassing the module cache. */
  refresh: () => Promise<void>;
}

// Subscribers for cross-component cache updates. When any consumer triggers
// `refresh()`, every mounted hook needs to pick up the new map — otherwise
// the component that pressed the button updates but siblings show stale data.
const subscribers = new Set<(s: ProviderStatusMap) => void>();

function publishStatus(status: ProviderStatusMap): void {
  for (const sub of subscribers) sub(status);
}

/**
 * Returns the cached provider status plus a `refresh()` callback. `status`
 * is `null` while the first fetch is still in flight; consumers should
 * render a neutral state (no disabled tiles, no banners) until it resolves.
 */
export function useProviderStatus(): UseProviderStatusResult {
  const [status, setStatus] = useState<ProviderStatusMap | null>(cache);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const sub = (s: ProviderStatusMap) => setStatus(s);
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const next = await loadStatus(cache ? true : false);
      if (cancelled) return;
      publishStatus(next);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    // Bust the module cache so `loadStatus()` hits the network again.
    cache = null;
    inflight = null;
    setRefreshing(true);
    try {
      const fresh = await loadStatus(true);
      // Fan out to every mounted hook instance, not just this one.
      publishStatus(fresh);
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { status, refreshing, refresh };
}
