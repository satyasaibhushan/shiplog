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

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString().split("T")[0]!,
    to: to.toISOString().split("T")[0]!,
  };
}

export function useShiplog() {
  const dates = defaultDateRange();

  const [repos, setRepos] = useState<ReposResponse | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState(dates.from);
  const [dateTo, setDateTo] = useState(dates.to);
  const [scope, setScope] = useState<string[]>(["merged-prs", "direct-commits"]);

  const [contributions, setContributions] = useState<ContributionsResponse | null>(null);
  const [summary, setSummary] = useState<SummarizationResult | null>(null);
  const [summaryProgress, setSummaryProgress] = useState<SummarizationProgress | null>(null);
  const [phase, setPhase] = useState<AppPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  // ── Load repos on mount ──
  const loadRepos = useCallback(async () => {
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
  }, []);

  useEffect(() => { loadRepos(); }, [loadRepos]);

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
          repos: selectedRepos,
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
          repos: selectedRepos,
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
    repos, reposLoading, reposError,
    selectedRepos, setSelectedRepos,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    scope, setScope,
    contributions, summary, summaryProgress,
    phase, error,
    generate, fetchContributions, fetchSummary, reset, loadRepos,
  };
}
