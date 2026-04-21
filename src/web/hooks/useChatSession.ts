import { useCallback, useState } from "react";
import type { SummaryParentKind } from "../types.ts";

interface ChatComplete {
  proposedSummary: string;
  model: string;
}

export function useChatSession(
  parentKind: SummaryParentKind,
  parentId: string,
) {
  const [proposed, setProposed] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (
      message: string,
      opts?: { provider?: string; model?: string },
    ): Promise<string | null> => {
      setError(null);
      setStreaming(true);
      setProposed("");
      try {
        const res = await fetch(
          `/api/chat/${encodeURIComponent(parentKind)}/${encodeURIComponent(parentId)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              message,
              provider: opts?.provider,
              model: opts?.model,
            }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        // Parse SSE stream — the chat route emits a single "complete" event
        // today (no token streaming from the LLM CLIs), so we just wait for it.
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let result: ChatComplete | null = null;
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
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            if (eventType === "complete") {
              result = parsed as ChatComplete;
            } else if (eventType === "error") {
              throw new Error((parsed as { error?: string }).error ?? "Chat failed");
            }
          }
        }

        if (!result) throw new Error("Chat ended without a result");
        setProposed(result.proposedSummary);
        setModel(result.model);
        return result.proposedSummary;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Chat failed");
        return null;
      } finally {
        setStreaming(false);
      }
    },
    [parentKind, parentId],
  );

  const commit = useCallback(
    async (userMessage: string, proposedSummary?: string) => {
      if (parentKind !== "log" && parentKind !== "rollup") {
        setError("Commit is only supported for logs and rollups");
        return null;
      }
      setCommitting(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/chat/${encodeURIComponent(parentKind)}/${encodeURIComponent(parentId)}/commit`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              proposedSummary: proposedSummary ?? proposed,
              userMessage,
              model: model || "sonnet",
            }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as {
          version: { id: string; versionNumber: number };
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : "Commit failed");
        return null;
      } finally {
        setCommitting(false);
      }
    },
    [parentKind, parentId, proposed, model],
  );

  const reset = useCallback(() => {
    setProposed("");
    setError(null);
  }, []);

  return { proposed, model, streaming, committing, error, send, commit, reset };
}
