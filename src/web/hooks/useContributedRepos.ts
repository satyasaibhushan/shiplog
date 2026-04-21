import { useCallback, useEffect, useState } from "react";

export function useContributedRepos() {
  const [data, setData] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/repos/contributed${force ? "?refresh=1" : ""}`,
      );
      if (!res.ok) return;
      const json = (await res.json()) as { repos?: string[] };
      setData(new Set(json.repos ?? []));
    } catch {
      // Fail open — the caller treats null as "unknown, show everything"
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
