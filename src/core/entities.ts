// Persistent-entity DB layer for the Atlas workspace.
//
// Wraps Drizzle reads/writes for `logs`, `rollups`, `summary_versions`,
// `stale_markers`, and `summary_deps`. Also contains the staleness propagation
// logic that fires whenever a generated (or chat-edited) summary version is
// inserted.
//
// All records are also persisted to the git-backed datastore via the
// `persistLog` / `persistRollupEntity` / `persistSummaryVersion` wrappers so
// the JSON tree stays in sync with SQLite.

import { randomUUID } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./cache.ts";
import * as schema from "../db/schema.ts";
import {
  persistLog,
  persistRollupEntity,
  persistSummaryVersion,
} from "./git-sync.ts";
import type {
  StoredLog,
  StoredRollup,
  StoredSummaryVersion,
  SummaryParentKind,
} from "./datastore.ts";

// ── Types exposed to routes / UI ──────────────────────────────────────────

export interface LogRecord {
  id: string;
  owner: string;
  repo: string;
  authorEmail: string;
  rangeStart: string;
  rangeEnd: string;
  title?: string;
  activeVersionId?: string;
  createdAt: number;
  updatedAt: number;
  stale?: { reason: string; detectedAt: number };
}

export interface RollupRecord {
  id: string;
  title: string;
  authorEmail: string;
  rangeStart: string;
  rangeEnd: string;
  logIds: string[];
  activeVersionId?: string;
  createdAt: number;
  updatedAt: number;
  stale?: { reason: string; detectedAt: number };
}

export interface SummaryVersionRecord {
  id: string;
  parentKind: SummaryParentKind;
  parentId: string;
  versionNumber: number;
  summaryMarkdown: string;
  timeline?: Array<{
    date: string;
    additions: number;
    deletions: number;
    prCount: number;
    commitCount: number;
    topPRTitles: string[];
  }>;
  stats?: {
    additions: number;
    deletions: number;
    files: number;
    commits: number;
    prs?: number;
    truncated?: boolean;
  };
  source: "generated" | "chat";
  chatPrompt?: Record<string, unknown>;
  model: string;
  createdAt: number;
}

// ── Logs ──────────────────────────────────────────────────────────────────

export async function createLog(input: {
  owner: string;
  repo: string;
  authorEmail: string;
  rangeStart: string;
  rangeEnd: string;
  title?: string;
}): Promise<LogRecord> {
  const db = getDb();
  const now = Date.now();
  const id = `log_${randomUUID()}`;
  const row = {
    id,
    owner: input.owner,
    repo: input.repo,
    authorEmail: input.authorEmail,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    title: input.title ?? null,
    activeVersionId: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  db.insert(schema.logs).values(row).run();

  const record = rowToLogRecord({
    ...row,
    title: row.title,
    activeVersionId: row.activeVersionId,
    createdAt: row.createdAt as unknown as Date,
    updatedAt: row.updatedAt as unknown as Date,
  });
  await persistLog(toStoredLog(record));
  return record;
}

export function getLog(id: string): LogRecord | null {
  const db = getDb();
  const row = db.select().from(schema.logs).where(eq(schema.logs.id, id)).get();
  if (!row) return null;
  return rowToLogRecord(row);
}

export function listLogs(): LogRecord[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.logs)
    .orderBy(desc(schema.logs.updatedAt))
    .all();
  return rows.map(rowToLogRecord);
}

export function listLogsForRepo(owner: string, repo: string): LogRecord[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.logs)
    .where(and(eq(schema.logs.owner, owner), eq(schema.logs.repo, repo)))
    .orderBy(desc(schema.logs.updatedAt))
    .all();
  return rows.map(rowToLogRecord);
}

export async function setLogActiveVersion(
  logId: string,
  versionId: string,
): Promise<void> {
  const db = getDb();
  const now = Date.now();
  db.update(schema.logs)
    .set({ activeVersionId: versionId, updatedAt: new Date(now) })
    .where(eq(schema.logs.id, logId))
    .run();
  const record = getLog(logId);
  if (record) await persistLog(toStoredLog(record));
}

// ── Rollups ───────────────────────────────────────────────────────────────

export async function createRollup(input: {
  title: string;
  authorEmail: string;
  rangeStart: string;
  rangeEnd: string;
  logIds: string[];
}): Promise<RollupRecord> {
  const db = getDb();
  const now = Date.now();
  const id = `rollup_${randomUUID()}`;
  db.insert(schema.rollups)
    .values({
      id,
      title: input.title,
      authorEmail: input.authorEmail,
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd,
      logIdsJson: JSON.stringify(input.logIds),
      activeVersionId: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .run();
  // Record deps: rollup -> each log so regenerating a log can propagate stale.
  for (const logId of input.logIds) {
    db.insert(schema.summaryDeps)
      .values({
        parentKind: "rollup",
        parentId: id,
        childKind: "log",
        childId: logId,
      })
      .onConflictDoNothing()
      .run();
  }
  const record = getRollup(id)!;
  await persistRollupEntity(toStoredRollup(record));
  return record;
}

export function getRollup(id: string): RollupRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.rollups)
    .where(eq(schema.rollups.id, id))
    .get();
  if (!row) return null;
  return rowToRollupRecord(row);
}

export function listRollups(): RollupRecord[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.rollups)
    .orderBy(desc(schema.rollups.updatedAt))
    .all();
  return rows.map(rowToRollupRecord);
}

export async function setRollupActiveVersion(
  rollupId: string,
  versionId: string,
): Promise<void> {
  const db = getDb();
  const now = Date.now();
  db.update(schema.rollups)
    .set({ activeVersionId: versionId, updatedAt: new Date(now) })
    .where(eq(schema.rollups.id, rollupId))
    .run();
  const record = getRollup(rollupId);
  if (record) await persistRollupEntity(toStoredRollup(record));
}

// ── Summary versions ──────────────────────────────────────────────────────

export async function appendSummaryVersion(input: {
  parentKind: SummaryParentKind;
  parentId: string;
  summaryMarkdown: string;
  timeline?: SummaryVersionRecord["timeline"];
  stats?: SummaryVersionRecord["stats"];
  source: "generated" | "chat";
  chatPrompt?: Record<string, unknown>;
  model: string;
  activate?: boolean;
}): Promise<SummaryVersionRecord> {
  const db = getDb();
  const id = `sv_${randomUUID()}`;
  const latest = latestVersion(input.parentKind, input.parentId);
  const versionNumber = (latest?.versionNumber ?? 0) + 1;
  const now = Date.now();
  db.insert(schema.summaryVersions)
    .values({
      id,
      parentKind: input.parentKind,
      parentId: input.parentId,
      versionNumber,
      summaryMarkdown: input.summaryMarkdown,
      timelineJson: input.timeline ? JSON.stringify(input.timeline) : null,
      statsJson: input.stats ? JSON.stringify(input.stats) : null,
      source: input.source,
      chatPromptJson: input.chatPrompt ? JSON.stringify(input.chatPrompt) : null,
      model: input.model,
      createdAt: new Date(now),
    })
    .run();

  const record: SummaryVersionRecord = {
    id,
    parentKind: input.parentKind,
    parentId: input.parentId,
    versionNumber,
    summaryMarkdown: input.summaryMarkdown,
    timeline: input.timeline,
    stats: input.stats,
    source: input.source,
    chatPrompt: input.chatPrompt,
    model: input.model,
    createdAt: now,
  };

  await persistSummaryVersion(toStoredSummaryVersion(record));

  // Activate: link the parent to this version and clear its stale marker.
  if (input.activate ?? true) {
    if (input.parentKind === "log") {
      await setLogActiveVersion(input.parentId, id);
    } else if (input.parentKind === "rollup") {
      await setRollupActiveVersion(input.parentId, id);
    }
    clearStale(input.parentKind, input.parentId);
  }

  // Regeneration of a child → propagate staleness to parents.
  if (input.source === "generated") {
    propagateStaleToParents(input.parentKind, input.parentId);
  }

  return record;
}

export function latestVersion(
  parentKind: SummaryParentKind,
  parentId: string,
): SummaryVersionRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.summaryVersions)
    .where(
      and(
        eq(schema.summaryVersions.parentKind, parentKind),
        eq(schema.summaryVersions.parentId, parentId),
      ),
    )
    .orderBy(desc(schema.summaryVersions.versionNumber))
    .get();
  if (!row) return null;
  return rowToVersion(row);
}

export function getVersion(id: string): SummaryVersionRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.summaryVersions)
    .where(eq(schema.summaryVersions.id, id))
    .get();
  if (!row) return null;
  return rowToVersion(row);
}

export function listVersions(
  parentKind: SummaryParentKind,
  parentId: string,
): SummaryVersionRecord[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.summaryVersions)
    .where(
      and(
        eq(schema.summaryVersions.parentKind, parentKind),
        eq(schema.summaryVersions.parentId, parentId),
      ),
    )
    .orderBy(desc(schema.summaryVersions.versionNumber))
    .all();
  return rows.map(rowToVersion);
}

// ── Staleness ─────────────────────────────────────────────────────────────

export function addDep(edge: {
  parentKind: SummaryParentKind;
  parentId: string;
  childKind: SummaryParentKind;
  childId: string;
}): void {
  const db = getDb();
  db.insert(schema.summaryDeps).values(edge).onConflictDoNothing().run();
}

function propagateStaleToParents(
  childKind: SummaryParentKind,
  childId: string,
): void {
  const db = getDb();
  const parents = db
    .select()
    .from(schema.summaryDeps)
    .where(
      and(
        eq(schema.summaryDeps.childKind, childKind),
        eq(schema.summaryDeps.childId, childId),
      ),
    )
    .all();
  const now = Date.now();
  for (const p of parents) {
    db.insert(schema.staleMarkers)
      .values({
        parentKind: p.parentKind,
        parentId: p.parentId,
        reason: "dep_regenerated",
        detectedAt: new Date(now),
      })
      .onConflictDoUpdate({
        target: [schema.staleMarkers.parentKind, schema.staleMarkers.parentId],
        set: { reason: "dep_regenerated", detectedAt: new Date(now) },
      })
      .run();
  }
}

export function clearStale(
  parentKind: SummaryParentKind,
  parentId: string,
): void {
  const db = getDb();
  db.delete(schema.staleMarkers)
    .where(
      and(
        eq(schema.staleMarkers.parentKind, parentKind),
        eq(schema.staleMarkers.parentId, parentId),
      ),
    )
    .run();
}

export function getStale(
  parentKind: SummaryParentKind,
  parentId: string,
): { reason: string; detectedAt: number } | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.staleMarkers)
    .where(
      and(
        eq(schema.staleMarkers.parentKind, parentKind),
        eq(schema.staleMarkers.parentId, parentId),
      ),
    )
    .get();
  if (!row) return null;
  const detected = row.detectedAt as unknown as Date | number | null;
  const detectedMs =
    detected instanceof Date
      ? detected.getTime()
      : typeof detected === "number"
        ? detected
        : 0;
  return { reason: row.reason, detectedAt: detectedMs };
}

export function listStaleMarkers(): Array<{
  parentKind: SummaryParentKind;
  parentId: string;
  reason: string;
  detectedAt: number;
}> {
  const db = getDb();
  const rows = db.select().from(schema.staleMarkers).all();
  return rows.map((r) => {
    const detected = r.detectedAt as unknown as Date | number | null;
    const detectedMs =
      detected instanceof Date
        ? detected.getTime()
        : typeof detected === "number"
          ? detected
          : 0;
    return {
      parentKind: r.parentKind as SummaryParentKind,
      parentId: r.parentId,
      reason: r.reason,
      detectedAt: detectedMs,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function asMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return 0;
}

function rowToLogRecord(
  row: typeof schema.logs.$inferSelect,
): LogRecord {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    authorEmail: row.authorEmail,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    title: row.title ?? undefined,
    activeVersionId: row.activeVersionId ?? undefined,
    createdAt: asMs(row.createdAt),
    updatedAt: asMs(row.updatedAt),
    stale: getStale("log", row.id) ?? undefined,
  };
}

function rowToRollupRecord(
  row: typeof schema.rollups.$inferSelect,
): RollupRecord {
  let logIds: string[] = [];
  try {
    logIds = JSON.parse(row.logIdsJson) as string[];
  } catch {}
  return {
    id: row.id,
    title: row.title,
    authorEmail: row.authorEmail,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    logIds,
    activeVersionId: row.activeVersionId ?? undefined,
    createdAt: asMs(row.createdAt),
    updatedAt: asMs(row.updatedAt),
    stale: getStale("rollup", row.id) ?? undefined,
  };
}

function rowToVersion(
  row: typeof schema.summaryVersions.$inferSelect,
): SummaryVersionRecord {
  let timeline: SummaryVersionRecord["timeline"] | undefined;
  if (row.timelineJson) {
    try {
      timeline = JSON.parse(row.timelineJson);
    } catch {}
  }
  let stats: SummaryVersionRecord["stats"] | undefined;
  if (row.statsJson) {
    try {
      stats = JSON.parse(row.statsJson);
    } catch {}
  }
  let chatPrompt: Record<string, unknown> | undefined;
  if (row.chatPromptJson) {
    try {
      chatPrompt = JSON.parse(row.chatPromptJson);
    } catch {}
  }
  return {
    id: row.id,
    parentKind: row.parentKind as SummaryParentKind,
    parentId: row.parentId,
    versionNumber: row.versionNumber,
    summaryMarkdown: row.summaryMarkdown,
    timeline,
    stats,
    source: row.source as "generated" | "chat",
    chatPrompt,
    model: row.model,
    createdAt: asMs(row.createdAt),
  };
}

function toStoredLog(r: LogRecord): StoredLog {
  return {
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    authorEmail: r.authorEmail,
    rangeStart: r.rangeStart,
    rangeEnd: r.rangeEnd,
    title: r.title,
    activeVersionId: r.activeVersionId,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toStoredRollup(r: RollupRecord): StoredRollup {
  return {
    id: r.id,
    title: r.title,
    authorEmail: r.authorEmail,
    rangeStart: r.rangeStart,
    rangeEnd: r.rangeEnd,
    logIds: r.logIds,
    activeVersionId: r.activeVersionId,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toStoredSummaryVersion(v: SummaryVersionRecord): StoredSummaryVersion {
  return {
    id: v.id,
    parentKind: v.parentKind,
    parentId: v.parentId,
    versionNumber: v.versionNumber,
    summaryMarkdown: v.summaryMarkdown,
    timeline: v.timeline,
    stats: v.stats,
    source: v.source,
    chatPrompt: v.chatPrompt,
    model: v.model,
    createdAt: new Date(v.createdAt).toISOString(),
  };
}

// Suppress unused import warning — kept for future loadMany() usage.
export const _unused = { inArray };
