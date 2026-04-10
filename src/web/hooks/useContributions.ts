// TODO: Implement in Phase 5
import { useState } from "react";

export function useContributions() {
  const [contributions, setContributions] = useState([]);
  const [loading, setLoading] = useState(false);

  async function fetchContributions(_params: {
    from: string;
    to: string;
    repos: string[];
    scope: string[];
  }) {
    setLoading(true);
    try {
      // TODO: Call /api/contributions
      setContributions([]);
    } finally {
      setLoading(false);
    }
  }

  return { contributions, loading, fetchContributions };
}
