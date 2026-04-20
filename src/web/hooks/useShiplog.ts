import { useState, useEffect, useCallback, useRef } from "react";
import type {
  ReposResponse,
  ContributionsResponse,
  SummarizationResult,
  SummarizationProgress,
  GenerationProgress,
  AppPhase,
} from "../types.ts";
import {
  getDefaultModel,
  normalizeProviderModel,
  isModelSupportedForProvider,
} from "../../shared/llm-models.ts";
import {
  PersistedSettingsSchema,
  type PersistedSettings,
} from "../../shared/schemas.ts";

export interface ShiplogState {
  repos: ReposResponse | null;
  reposLoading: boolean;
  reposError: string | null;

  selectedRepos: string[];
  dateFrom: string;
  dateTo: string;
  scope: string[];

  contributions: ContributionsResponse | null;
  summary: SummarizationResult | null;
  summaryProgress: SummarizationProgress | null;
  generationProgress: GenerationProgress | null;
  phase: AppPhase;
  error: string | null;
}

const STORAGE_KEY = "shiplog-settings";

function loadPersistedSettings(): PersistedSettings | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn("shiplog: localStorage read failed", err);
    return null;
  }
  if (!raw) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.warn("shiplog: failed to parse persisted settings, clearing", err);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // swallow — next write will overwrite
    }
    return null;
  }

  const parsed = PersistedSettingsSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(
      "shiplog: persisted settings failed validation, clearing",
      parsed.error.issues,
    );
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // swallow
    }
    return null;
  }
  return parsed.data;
}

function persistSettings(s: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (err) {
    console.warn("shiplog: localStorage write failed", err);
  }
}

// ── Repo list cache ────────────────────────────────────────────────────────
//
// The `/api/repos` call can take a few seconds (gh hits GitHub, lists orgs,
// dedupes forks). Caching the last successful response in localStorage means
// subsequent page loads render the selector instantly; we still refetch in
// the background and swap in the fresh data when it arrives.

const REPOS_CACHE_KEY = "shiplog-repos-cache";

function loadCachedRepos(): ReposResponse | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(REPOS_CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReposResponse;
    // Minimal shape check — we don't have a zod schema here, so guard just
    // enough to avoid rendering a corrupted shape.
    if (!parsed || !Array.isArray(parsed.repos) || !Array.isArray(parsed.orgs)) {
      throw new Error("bad shape");
    }
    return parsed;
  } catch {
    try {
      localStorage.removeItem(REPOS_CACHE_KEY);
    } catch {
      // swallow
    }
    return null;
  }
}

function saveCachedRepos(r: ReposResponse) {
  try {
    localStorage.setItem(REPOS_CACHE_KEY, JSON.stringify(r));
  } catch (err) {
    console.warn("shiplog: repos cache write failed", err);
  }
}

/**
 * Consume an SSE response body. Dispatches `progress` events to `onProgress`
 * and resolves with the `complete` event payload. Throws on `error` events or
 * an unexpected stream close.
 */
async function consumeSSE<T>(
  res: Response,
  handlers: { onProgress: (p: GenerationProgress) => void },
): Promise<T> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: T | undefined;
  let errored: Error | null = null;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (!part.trim()) continue;
      let eventType = "message";
      let data = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      if (eventType === "progress") {
        handlers.onProgress(parsed as GenerationProgress);
      } else if (eventType === "complete") {
        completed = parsed as T;
      } else if (eventType === "error") {
        const body = parsed as { error?: string };
        errored = new Error(body.error ?? "SSE stream reported an error");
        break outer;
      }
    }
  }

  if (errored) throw errored;
  if (completed === undefined) {
    throw new Error("Stream ended before completion event");
  }
  return completed;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000); // Default: last 90 days (a quarter)
  return {
    from: from.toISOString().split("T")[0]!,
    to: to.toISOString().split("T")[0]!,
  };
}

export interface StatusCheck {
  ok: boolean;
  detail: string;
}

export interface StatusResponse {
  checks: Record<string, StatusCheck>;
  hasLLM: boolean;
  ready: boolean;
}

export function useShiplog() {
  const dates = defaultDateRange();
  const saved = loadPersistedSettings();
  const initialLLM = normalizeProviderModel(saved?.llmProvider, saved?.llmModel);

  // ── Status / prerequisites ──
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Seed from the localStorage cache so the selector renders immediately.
  // The background refetch below overwrites this as soon as fresh data is
  // available.
  const cachedRepos = loadCachedRepos();
  const [repos, setRepos] = useState<ReposResponse | null>(cachedRepos);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  // Kept in sync with `repos` so the (stable) `loadRepos` callback can check
  // cache freshness without closing over a stale state value.
  const reposRef = useRef<ReposResponse | null>(cachedRepos);
  useEffect(() => {
    reposRef.current = repos;
  }, [repos]);

  const [selectedRepos, setSelectedRepos] = useState<string[]>(saved?.selectedRepos ?? []);
  const [dateFrom, setDateFrom] = useState(saved?.dateFrom ?? dates.from);
  const [dateTo, setDateTo] = useState(saved?.dateTo ?? dates.to);
  const [scope, setScope] = useState<string[]>(saved?.scope ?? ["merged-prs", "direct-commits"]);
  const [llmProvider, setLlmProvider] = useState(initialLLM.provider);
  const [llmModel, setLlmModel] = useState(initialLLM.model);

  const [contributions, setContributions] = useState<ContributionsResponse | null>(null);
  const [summary, setSummary] = useState<SummarizationResult | null>(null);
  const [summaryProgress, setSummaryProgress] = useState<SummarizationProgress | null>(null);
  const [generationProgress, setGenerationProgress] =
    useState<GenerationProgress | null>(null);
  const [phase, setPhase] = useState<AppPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  // ── Check prerequisites on mount ──
  const checkStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await fetch("/api/status");
      const data: StatusResponse = await res.json();
      setStatus(data);
      return data;
    } catch {
      setStatus(null);
      return null;
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    checkStatus().then((s) => {
      if (s?.ready) loadReposInner();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist settings on change ──
  useEffect(() => {
    persistSettings({ selectedRepos, dateFrom, dateTo, scope, llmProvider, llmModel });
  }, [selectedRepos, dateFrom, dateTo, scope, llmProvider, llmModel]);

  useEffect(() => {
    if (isModelSupportedForProvider(llmProvider, llmModel)) return;
    setLlmModel(getDefaultModel(llmProvider));
  }, [llmProvider, llmModel]);

  const updateLlmProvider = useCallback((provider: string) => {
    const next = normalizeProviderModel(provider, undefined);
    setLlmProvider(next.provider);
    setLlmModel(next.model);
  }, []);

  const updateLlmModel = useCallback((model: string) => {
    setLlmModel(model);
  }, []);

  // ── Load repos ──
  //
  // If we already have cached repos on screen, avoid flipping to the loading
  // spinner — the refetch runs silently and swaps in fresh data on success.
  // Only surface errors when we have nothing cached to fall back to.
  const loadReposInner = async () => {
    const hasCached = reposRef.current !== null;
    if (!hasCached) setReposLoading(true);
    setReposError(null);
    try {
      const res = await fetch("/api/repos");
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data: ReposResponse = await res.json();
      setRepos(data);
      saveCachedRepos(data);
    } catch (err) {
      if (!hasCached) {
        setReposError(
          err instanceof Error ? err.message : "Failed to load repos",
        );
      } else {
        console.warn("shiplog: repos refresh failed, keeping cached list", err);
      }
    } finally {
      setReposLoading(false);
    }
  };

  const loadRepos = useCallback(() => {
    checkStatus().then((s) => {
      if (s?.ready) loadReposInner();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Resolve selected repos: expand to include forks if they exist ──
  function resolveRepos(): string[] {
    if (!repos) return selectedRepos;
    const allRepos = [...repos.repos, ...repos.orgs.flatMap((o) => o.repos)];
    const expanded = new Set<string>();
    for (const name of selectedRepos) {
      expanded.add(name);
      // If this repo has a linked fork, include it too
      const repo = allRepos.find((r) => r.fullName === name);
      if (repo?.forkFullName) expanded.add(repo.forkFullName);
    }
    return [...expanded];
  }

  // ── Fetch contributions ──
  const fetchContributions = useCallback(async () => {
    if (selectedRepos.length === 0) {
      setError("Select at least one repository");
      return;
    }

    setPhase("fetching");
    setError(null);
    setContributions(null);
    setSummary(null);
    setSummaryProgress(null);

    try {
      const res = await fetch("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repos: resolveRepos(),
          from: dateFrom,
          to: dateTo,
          scope,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data: ContributionsResponse = await res.json();
      setContributions(data);
      setPhase("fetched");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch contributions");
      setPhase("error");
    }
  }, [selectedRepos, dateFrom, dateTo, scope, repos]);

  // ── Run summarization via SSE ──
  const fetchSummary = useCallback(async () => {
    if (!contributions) return;

    setPhase("summarizing");
    setSummaryProgress(null);
    setError(null);

    try {
      const res = await fetch("/api/summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          groups: contributions.groups,
          from: dateFrom,
          to: dateTo,
          repos: selectedRepos,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // Parse SSE stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventType = "message";
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            if (eventType === "progress") {
              setSummaryProgress(parsed);
            } else if (eventType === "complete") {
              setSummary(parsed);
              setPhase("done");
            } else if (eventType === "error") {
              throw new Error(parsed.error);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // If we haven't set phase to "done" by now, something went wrong
      if (phase !== "done") {
        setPhase("done");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Summarization failed");
      setPhase("error");
    }
  }, [contributions, dateFrom, dateTo, selectedRepos, phase]);

  // ── Generate: fetch + summarize in sequence (SSE for both) ──
  const generate = useCallback(async () => {
    if (selectedRepos.length === 0) {
      setError("Select at least one repository");
      return;
    }

    setPhase("fetching");
    setError(null);
    setContributions(null);
    setSummary(null);
    setSummaryProgress(null);
    setGenerationProgress(null);

    // ── Steps 1–5: fetch contributions via SSE ──
    let contribs: ContributionsResponse | null = null;
    try {
      const res = await fetch("/api/contributions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          repos: resolveRepos(),
          from: dateFrom,
          to: dateTo,
          scope,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      contribs = await consumeSSE<ContributionsResponse>(res, {
        onProgress: (p) => setGenerationProgress(p),
      });
      setContributions(contribs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch contributions");
      setPhase("error");
      return;
    }

    if (!contribs || contribs.groups.length === 0) {
      setPhase("fetched");
      return;
    }

    // ── Steps 6–7: summarize via SSE ──
    setPhase("summarizing");
    try {
      const res = await fetch("/api/summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          groups: contribs.groups,
          from: dateFrom,
          to: dateTo,
          repos: selectedRepos,
          provider: llmProvider,
          model: llmModel,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json();
        // LLM not available — show data without summary
        if (res.status === 503) {
          setError(errBody.error + " (showing raw data without AI summary)");
          setPhase("fetched");
          return;
        }
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      const result = await consumeSSE<SummarizationResult>(res, {
        onProgress: (p) => setGenerationProgress(p),
      });
      setSummary(result);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Summarization failed");
      // Still show the data we fetched
      if (contribs) setPhase("fetched");
      else setPhase("error");
    }
  }, [selectedRepos, dateFrom, dateTo, scope, repos, llmProvider, llmModel]);

  const reset = useCallback(() => {
    setContributions(null);
    setSummary(null);
    setSummaryProgress(null);
    setGenerationProgress(null);
    setPhase("idle");
    setError(null);
  }, []);

  return {
    status, statusLoading, checkStatus,
    repos, reposLoading, reposError,
    selectedRepos, setSelectedRepos,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    scope, setScope,
    llmProvider, setLlmProvider: updateLlmProvider,
    llmModel, setLlmModel: updateLlmModel,
    contributions, summary, summaryProgress, generationProgress,
    phase, error,
    generate, fetchContributions, fetchSummary, reset, loadRepos,
  };
}
