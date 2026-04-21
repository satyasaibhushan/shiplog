import { useCallback, useEffect, useState } from "react";
import type { RollupDetailResponse } from "../types.ts";

export function useRollup(id: string | null) {
  const [data, setData] = useState<RollupDetailResponse | null>(null);
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
      const res = await fetch(`/api/rollups/${encodeURIComponent(id)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as RollupDetailResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rollup");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activateVersion = useCallback(
    async (versionId: string) => {
      if (!id) return;
      const res = await fetch(
        `/api/rollups/${encodeURIComponent(id)}/activate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    },
    [id, refresh],
  );

  return { data, loading, error, refresh, activateVersion };
}
