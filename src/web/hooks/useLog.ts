import { useCallback, useEffect, useState } from "react";
import type { LogDetailResponse } from "../types.ts";

export function useLog(id: string | null) {
  const [data, setData] = useState<LogDetailResponse | null>(null);
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
      const res = await fetch(`/api/logs/${encodeURIComponent(id)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as LogDetailResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load log");
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
      const res = await fetch(`/api/logs/${encodeURIComponent(id)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
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
