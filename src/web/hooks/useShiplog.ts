import { useState, useEffect, useCallback } from "react";
import type {
  ReposResponse,
  ContributionsResponse,
  SummarizationResult,
  SummarizationProgress,
  AppPhase,
} from "../types.ts";

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
  phase: AppPhase;
  error: string | null;
}

const STORAGE_KEY = "shiplog-settings";

interface PersistedSettings {
  selectedRepos: string[];
  dateFrom: string;
  dateTo: string;
  scope: string[];
  llmProvider?: string;
  llmModel?: string;
}

function loadPersistedSettings(): PersistedSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function persistSettings(s: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
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

  // ── Status / prerequisites ──
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [repos, setRepos] = useState<ReposResponse | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  const [selectedRepos, setSelectedRepos] = useState<string[]>(saved?.selectedRepos ?? []);
  const [dateFrom, setDateFrom] = useState(saved?.dateFrom ?? dates.from);
  const [dateTo, setDateTo] = useState(saved?.dateTo ?? dates.to);
  const [scope, setScope] = useState<string[]>(saved?.scope ?? ["merged-prs", "direct-commits"]);
  const [llmProvider, setLlmProvider] = useState(saved?.llmProvider ?? "claude");
  const [llmModel, setLlmModel] = useState(saved?.llmModel ?? "sonnet");

  const [contributions, setContributions] = useState<ContributionsResponse | null>(null);
  const [summary, setSummary] = useState<SummarizationResult | null>(null);
  const [summaryProgress, setSummaryProgress] = useState<SummarizationProgress | null>(null);
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

  // ── Load repos ──
  const loadReposInner = async () => {
    setReposLoading(true);
    setReposError(null);
    try {
      const res = await fetch("/api/repos");
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data: ReposResponse = await res.json();
      setRepos(data);
    } catch (err) {
      setReposError(err instanceof Error ? err.message : "Failed to load repos");
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
  }, [selectedRepos, dateFrom, dateTo, scope]);

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

  // ── Generate: fetch + summarize in sequence ──
  const generate = useCallback(async () => {
    if (selectedRepos.length === 0) {
      setError("Select at least one repository");
      return;
    }

    // Step 1: Fetch contributions
    setPhase("fetching");
    setError(null);
    setContributions(null);
    setSummary(null);
    setSummaryProgress(null);

    let contribs: ContributionsResponse;
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
      contribs = await res.json();
      setContributions(contribs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch contributions");
      setPhase("error");
      return;
    }

    if (contribs.groups.length === 0) {
      setPhase("fetched");
      return;
    }

    // Step 2: Summarize
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
            if (eventType === "progress") setSummaryProgress(parsed);
            else if (eventType === "complete") { setSummary(parsed); setPhase("done"); }
            else if (eventType === "error") throw new Error(parsed.error);
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      setPhase((prev) => (prev === "summarizing" ? "done" : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Summarization failed");
      // Still show the data we fetched
      if (contribs) setPhase("fetched");
      else setPhase("error");
    }
  }, [selectedRepos, dateFrom, dateTo, scope]);

  const reset = useCallback(() => {
    setContributions(null);
    setSummary(null);
    setSummaryProgress(null);
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
    llmProvider, setLlmProvider,
    llmModel, setLlmModel,
    contributions, summary, summaryProgress,
    phase, error,
    generate, fetchContributions, fetchSummary, reset, loadRepos,
  };
}
