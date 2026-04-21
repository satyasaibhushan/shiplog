import { useCallback, useEffect, useState } from "react";
import type { AtlasResponse } from "../types.ts";

export function useAtlas() {
  const [data, setData] = useState<AtlasResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/atlas");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AtlasResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load atlas");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
