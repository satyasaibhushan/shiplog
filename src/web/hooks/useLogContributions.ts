import { useCallback, useEffect, useState } from "react";
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

  const refresh = useCallback(async () => {
    if (!id) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/logs/${encodeURIComponent(id)}/contributions`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as ContributionsResponse;
      setData(json);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load contributions",
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) {
      setData(null);
      return;
    }
    void refresh();
  }, [id, refresh]);

  return { data, loading, error, refresh };
}
