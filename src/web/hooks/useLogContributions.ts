import { useEffect, useState } from "react";
import type { CommitGroup } from "../types.ts";

export interface GroupWithSummary extends CommitGroup {
  contentHash: string;
  summary: string | null;
}

interface ContributionsResponse {
  groups: GroupWithSummary[];
  stats: {
    prGroups: number;
    orphanGroups: number;
    orphanCommits: number;
    commitsInPRs: number;
  };
}

export function useLogContributions(id: string | null) {
  const [data, setData] = useState<ContributionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/logs/${encodeURIComponent(id)}/contributions`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as ContributionsResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load contributions",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return { data, loading, error };
}
