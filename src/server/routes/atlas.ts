import { Hono } from "hono";
import {
  getVersion,
  listLogs,
  listRollups,
  listStaleMarkers,
} from "../../core/entities.ts";

export const atlasRouter = new Hono();

// Extract a short headline from a summary's markdown body. Prefer the first
// real heading (the `# Title` line the rollup prompt now emits). Skip noise
// like a bare `## Summary` label; fall back to the first paragraph line.
function extractHeadline(markdown: string | undefined): string | null {
  if (!markdown) return null;
  const clean = (s: string) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .slice(0, 240);

  let firstParagraph: string | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const text = line.replace(/^#+\s*/, "").trim();
      if (!text) continue;
      if (/^summary$/i.test(text)) continue;
      return clean(text);
    }
    if (firstParagraph === null) firstParagraph = clean(line);
  }
  return firstParagraph;
}

// GET /api/atlas — data for the Atlas home view.
//
// Returns logs + rollups, each already annotated with stale markers and the
// headline / stats from the active version, so the client doesn't need per-log
// round-trips to render the Atlas.
atlasRouter.get("/", (c) => {
  const logs = listLogs();
  const rollups = listRollups();
  const staleMap = new Map<string, { reason: string; detectedAt: number }>();
  for (const m of listStaleMarkers()) {
    staleMap.set(`${m.parentKind}:${m.parentId}`, {
      reason: m.reason,
      detectedAt: m.detectedAt,
    });
  }

  const enrichLog = (log: (typeof logs)[number]) => {
    const version = log.activeVersionId ? getVersion(log.activeVersionId) : null;
    const stale = staleMap.get(`log:${log.id}`);
    return {
      ...log,
      headline: extractHeadline(version?.summaryMarkdown),
      stats: version?.stats ?? null,
      stale: stale ?? null,
    };
  };

  const enrichRollup = (rollup: (typeof rollups)[number]) => {
    const version = rollup.activeVersionId
      ? getVersion(rollup.activeVersionId)
      : null;
    const stale = staleMap.get(`rollup:${rollup.id}`);
    return {
      ...rollup,
      headline: extractHeadline(version?.summaryMarkdown),
      stats: version?.stats ?? null,
      stale: stale ?? null,
    };
  };

  const enrichedLogs = logs.map(enrichLog);
  const enrichedRollups = rollups.map(enrichRollup);
  const recent = [...enrichedLogs]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10);

  return c.json({
    logs: enrichedLogs,
    rollups: enrichedRollups,
    recent,
  });
});
