import { z } from "zod";
import {
  createLog,
  createRollup,
  getRollup,
  setRollupLogs,
  getLog,
  getVersion,
  listLogs,
  listVersions,
} from "./entities.ts";
import { appendReportVersion } from "./report-version.ts";
import { fingerprint, singleFlight } from "./report-identity.ts";
import { inWindow, type ReportWindow } from "./report-period.ts";
import type { GenerateLogResult, GenerateRollupResult } from "./report.ts";
const instant = z.string().datetime({ offset: true });
const stream = z.enum(["sso", "cmc", "automation", "personal"]);
const httpUrl = z
  .string()
  .url()
  .refine((v) => ["http:", "https:"].includes(new URL(v).protocol), "URL must use HTTP(S)");
const evidenceSchema = z.object({
  id: z.string().min(1),
  milestone: z.enum(["pr_merged", "uat_deployed", "qa_passed", "live_verified", "other"]),
  url: httpUrl,
  occurredAt: instant,
  actor: z.string().min(1),
  caveat: z.string(),
});
const taskSchema = z.object({
  source: z.string().optional(),
  inboxItemId: z.string().optional(),
  id: z.string().min(1),
  title: z.string().min(1),
  projectId: z.string().optional(),
  status: z.enum(["pending", "in_progress", "blocked", "waiting", "verification", "done"]),
  createdAt: instant,
  acceptedAt: instant.optional(),
  acceptedBy: z.string().optional(),
  completedAt: instant.optional(),
  dueDate: z.string().optional(),
  sourceRef: z.object({ url: httpUrl.optional(), externalId: z.string().optional() }).optional(),
  work: z
    .object({
      owner: z.string().optional(),
      nextAction: z.string().optional(),
      workflow: z.object({ name: z.string(), path: z.string(), revision: z.string() }).optional(),
    })
    .optional(),
  evidence: z.array(evidenceSchema).default([]),
  attribution: z
    .object({
      kind: z.enum(["personal", "team", "unknown"]),
      basis: z.string(),
      contributors: z.array(z.string()).default([]),
    })
    .optional(),
  metrics: z
    .array(
      z.object({
        name: z.string(),
        value: z.number().nullable(),
        unit: z.string(),
        verification: z.enum(["verified", "reported", "unknown"]),
        evidenceIds: z.array(z.string()),
      }),
    )
    .default([]),
});
export const TaskFinderSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.object({
      instanceId: z.string().min(1),
      capturedAt: instant,
      coverage: z.enum(["partial", "complete"]).default("partial"),
    }),
    projects: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        stream,
        linkedStreams: z.array(stream).default([]),
      }),
    ),
    tasks: z.array(taskSchema),
  })
  .superRefine((s, ctx) => {
    for (const [name, rows] of [
      ["projects", s.projects],
      ["tasks", s.tasks],
    ] as const) {
      if (new Set(rows.map((r) => r.id)).size !== rows.length)
        ctx.addIssue({ code: "custom", message: `Duplicate ${name} IDs` });
    }
    for (const t of s.tasks) {
      if (t.projectId && !s.projects.some((p) => p.id === t.projectId))
        ctx.addIssue({ code: "custom", message: `Unknown project for task ${t.id}` });
      if (new Set(t.evidence.map((e) => e.id)).size !== t.evidence.length)
        ctx.addIssue({ code: "custom", message: `Duplicate evidence IDs for task ${t.id}` });
      for (const m of t.metrics)
        if (
          m.evidenceIds.some((id) => !t.evidence.some((e) => e.id === id)) ||
          (m.verification === "verified" && (!m.evidenceIds.length || m.value === null))
        )
          ctx.addIssue({
            code: "custom",
            message: `Metric lacks supporting evidence: ${t.id}/${m.name}`,
          });
    }
  });
export type TaskFinderSnapshot = z.infer<typeof TaskFinderSnapshotSchema>;
const text = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]<>#|]/g, "\\$&");
const link = (url: string) => url.replaceAll("(", "%28").replaceAll(")", "%29");

/** A deterministic snapshot report, never a model inference or live source verification. */
export function renderTaskFinderProject(
  snapshot: TaskFinderSnapshot,
  projectId: string | undefined,
  window: ReportWindow,
): string {
  const project = snapshot.projects.find((p) => p.id === projectId);
  const tasks = snapshot.tasks
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines = [
    `# ${text(project?.name ?? "Unassigned")}`,
    "",
    `${window.from} → ${window.to} (${window.timezone}; ${window.kind})`,
    "",
    `Source: Task Finder snapshot ${text(snapshot.source.instanceId)}, captured ${snapshot.source.capturedAt}; coverage: ${snapshot.source.coverage}. Not live verified.`,
    `Primary stream: ${project?.stream ?? "unassigned"}. Overlap links: ${project?.linkedStreams.join(", ") || "none"}; count only the primary home.`,
    "",
    "## Recorded events in period",
    "",
    "These are supplied assertions, not independently verified outcomes. Merged is not deployed or live verified.",
    "",
  ];
  let events = 0;
  for (const t of tasks) {
    const evidence = t.evidence
      .filter((e) => inWindow(e.occurredAt, window))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    const accepted = inWindow(t.acceptedAt, window),
      completed = inWindow(t.completedAt, window);
    if (!accepted && !completed && !evidence.length) continue;
    events++;
    lines.push(
      `### ${text(t.title)} [task ${text(t.id)}]`,
      `Contribution: ${t.attribution?.kind ?? "unknown"}; basis: ${text(t.attribution?.basis ?? "not recorded; owner is not proof of individual contribution")}.`,
      `Contributors: ${t.attribution?.contributors.map(text).join(", ") || "unknown"}.`,
    );
    if (t.sourceRef?.url) lines.push(`[Original source](${link(t.sourceRef.url)})`);
    if (accepted)
      lines.push(
        `Accepted ${t.acceptedAt} by ${text(t.acceptedBy ?? "unknown")}. This is not agent-result review.`,
      );
    if (completed)
      lines.push(`Marked done ${t.completedAt}; this alone does not establish release or impact.`);
    for (const e of evidence)
      lines.push(
        `- ${e.milestone}: [evidence ${text(e.id)}](${link(e.url)}) · ${e.occurredAt} · actor: ${text(e.actor)} · caveat: ${text(e.caveat || "none supplied")}`,
      );
    for (const m of t.metrics)
      lines.push(
        `- Metric ${text(m.name)}: ${m.value ?? "unknown"} ${text(m.unit)} (${m.verification}, supplied assertion); evidence IDs: ${m.evidenceIds.map(text).join(", ") || "none"}.`,
      );
    lines.push("");
  }
  if (!events)
    lines.push("No recorded events in this window. This does not prove no work occurred.", "");
  lines.push(
    `## Current snapshot context as of ${snapshot.source.capturedAt}`,
    "",
    "Not a reconstruction of historical statuses or commitments.",
    "",
  );
  for (const t of tasks.filter((t) => t.status !== "done"))
    lines.push(
      `- ${text(t.title)} [task ${text(t.id)}]: ${t.status}; owner: ${text(t.work?.owner ?? "unknown")}; next: ${text(t.work?.nextAction ?? "not recorded")}; deadline: ${text(t.dueDate ?? "none")}.`,
    );
  return lines.join("\n");
}

/** Uses the existing log/version persistence and IDs, with no source/model/sync calls. */
export async function generateTaskFinderReport(
  raw: unknown,
  window: ReportWindow,
  authorEmail: string,
): Promise<GenerateLogResult[]> {
  const snapshot = TaskFinderSnapshotSchema.parse(raw);
  const signature = fingerprint({ snapshot, window, authorEmail });
  return singleFlight("taskfinder:" + signature, async () => {
    const ids: Array<string | undefined> = snapshot.projects.map((p) => p.id).sort();
    if (snapshot.tasks.some((t) => !t.projectId)) ids.push(undefined);
    const results: GenerateLogResult[] = [];
    for (const projectId of ids) {
      const project = snapshot.projects.find((p) => p.id === projectId);
      const id =
        "log_" +
        fingerprint({
          source: "task-finder",
          instanceId: snapshot.source.instanceId,
          projectId: projectId ?? null,
          window: window.key,
          authorEmail,
        });
      const log = await createLog({
        id,
        owner: "task-finder",
        repo: projectId ?? "unassigned",
        authorEmail,
        rangeStart: window.from,
        rangeEnd: window.to,
        title: project?.name ?? "Unassigned",
      });
      const markdown = renderTaskFinderProject(snapshot, projectId, window);
      const references = snapshot.tasks
        .filter((t) => t.projectId === projectId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((t) => ({
          taskId: t.id,
          projectId: t.projectId,
          source: t.source,
          sourceRef: t.sourceRef,
          inboxItemId: t.inboxItemId,
          owner: t.work?.owner,
          workflow: t.work?.workflow,
          attribution: t.attribution ?? {
            kind: "unknown",
            basis: "not recorded",
            contributors: [],
          },
          metrics: t.metrics,
          evidence: t.evidence
            .map((e) => ({ ...e, inPeriod: inWindow(e.occurredAt, window) }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        }));
      const context = {
        source: "task-finder",
        instanceId: snapshot.source.instanceId,
        window,
        projectId: projectId ?? null,
        references,
      };
      const version = await appendReportVersion(
        {
          parentKind: "log",
          parentId: log.id,
          summaryMarkdown: markdown,
          model: "deterministic-snapshot-v1",
          source: "generated",
          chatPrompt: context,
        },
        fingerprint({ markdown, context }),
      );
      results.push({ log: getLog(log.id)!, version, groupCount: references.length });
    }
    return results;
  });
}

/** Read active daily versions for a larger calendar period; reject overlaps/mixed sources. */
export function taskFinderDailyVersions(
  instanceId: string,
  window: ReportWindow,
  authorEmail: string,
) {
  return listLogs()
    .filter((l) => l.authorEmail === authorEmail)
    .flatMap((log) => {
      const version = log.activeVersionId ? getVersion(log.activeVersionId) : null;
      if (!version || version.parentKind !== "log" || version.parentId !== log.id) return [];
      // Chat edits carry their own chatPrompt, so provenance must survive an
      // active-version switch. Recover it from the retained generated history.
      const context =
        version?.chatPrompt?.source === "task-finder"
          ? version.chatPrompt
          : listVersions("log", log.id).find((v) => v.chatPrompt?.source === "task-finder")
              ?.chatPrompt;
      const child = context?.window as ReportWindow | undefined;
      if (
        context?.source !== "task-finder" ||
        context.instanceId !== instanceId ||
        child?.kind !== "daily" ||
        child.timezone !== window.timezone ||
        child.from < window.from ||
        child.to > window.to
      )
        return [];
      return [{ log, version: version!, groupCount: 0 }];
    })
    .sort(
      (a, b) =>
        a.log.rangeStart.localeCompare(b.log.rangeStart) || a.log.id.localeCompare(b.log.id),
    );
}

export async function generateTaskFinderRollup(
  instanceId: string,
  window: ReportWindow,
  authorEmail: string,
): Promise<GenerateRollupResult> {
  if (window.kind !== "weekly" && window.kind !== "monthly")
    throw new Error("Daily-log aggregation requires a weekly or monthly window");
  const id =
    "rollup_" + fingerprint({ source: "task-finder", instanceId, window: window.key, authorEmail });
  return singleFlight(id, async () => {
    const entries = taskFinderDailyVersions(instanceId, window, authorEmail);
    if (!entries.length)
      throw new Error(
        "No active Task Finder daily reports in this period; import reviewed snapshots first",
      );
    const sourceVersions = entries.map((e) => ({ logId: e.log.id, versionId: e.version.id }));
    const summaryMarkdown = [
      `# ${window.kind} Task Finder report`,
      `${window.from} → ${window.to} (${window.timezone})`,
      "",
      "Aggregated from the active versions of stored daily reports. Coverage may be partial; missing days are unknown. Not live verified.",
      "Tasks and evidence may appear on multiple days; do not add their counts or claim sole contribution. Evidence milestones remain distinct. Current-context sections retain their original snapshot dates.",
      "",
      ...entries.map(
        (e) =>
          `## ${e.log.rangeStart} · ${text(e.log.title ?? e.log.repo)}\nSource log ${e.log.id}, active version ${e.version.id}\n\n${e.version.summaryMarkdown}`,
      ),
    ].join("\n\n");
    const rollup = await createRollup({
      id,
      title: `${window.kind} Task Finder ${window.from} (${window.timezone})`,
      authorEmail,
      rangeStart: window.from,
      rangeEnd: window.to,
      logIds: entries.map((e) => e.log.id),
    });
    await setRollupLogs(
      rollup.id,
      entries.map((e) => e.log.id),
    );
    const context = { source: "task-finder", instanceId, window, sourceVersions };
    const version = await appendReportVersion(
      {
        parentKind: "rollup",
        parentId: rollup.id,
        summaryMarkdown,
        source: "generated",
        model: "deterministic-snapshot-v1",
        chatPrompt: context,
      },
      fingerprint(context),
    );
    return { rollup: getRollup(rollup.id)!, version };
  });
}
