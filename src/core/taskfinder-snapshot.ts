import { z } from "zod";
import { inWindow, reportTimezone, type ReportWindow } from "./report-period.ts";
const instant = z.string().datetime({ offset: true });
const stream = z.string().min(1).max(80);
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const httpUrl = z
  .string()
  .url()
  .refine((v) => ["http:", "https:"].includes(new URL(v).protocol), "URL must use HTTP(S)");
const projectDate = z
  .object({
    kind: z.enum(["unknown", "target", "estimate", "deadline"]),
    value: calendarDate.optional(),
    timezone: z.string().optional(),
    source: z.string().optional(),
    confirmedBy: z.string().optional(),
  })
  .passthrough()
  .superRefine((d, ctx) => {
    if (d.kind === "unknown") {
      if ("value" in d || "timezone" in d)
        ctx.addIssue({ code: "custom", message: "Unknown date cannot carry an invented value" });
    } else {
      try {
        if (!d.value || !d.timezone) throw Error();
        reportTimezone(d.timezone);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Planned date requires calendar date and valid timezone",
        });
      }
    }
    if (d.kind === "deadline" && (!d.source?.trim() || !d.confirmedBy?.trim()))
      ctx.addIssue({ code: "custom", message: "Deadline requires source and confirmation" });
  });
const projectPlan = z
  .object({
    outcome: z.string().optional(),
    phase: z.string().optional(),
    status: z.enum(["planned", "active", "waiting", "complete"]).optional(),
    priority: z.enum(["high", "normal", "low"]).optional(),
    health: z.enum(["unknown", "on_track", "at_risk"]).optional(),
    healthReason: z.string().optional(),
    nextAction: z.string().optional(),
    waitingOn: z.string().optional(),
    decision: z.string().optional(),
    dependencies: z
      .array(z.object({ projectId: z.string().min(1), note: z.string() }).passthrough())
      .optional(),
    milestones: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1),
            state: z.enum(["proposed", "accepted"]),
            date: projectDate,
          })
          .passthrough(),
      )
      .optional(),
    updatedAt: instant.optional(),
    updatedBy: z.string().optional(),
  })
  .passthrough();
const evidenceSchema = z
  .object({
    id: z.string().min(1),
    milestone: z.enum(["pr_merged", "uat_deployed", "qa_passed", "live_verified", "other"]),
    url: httpUrl,
    occurredAt: z.union([instant, calendarDate]),
    precision: z.enum(["date", "instant"]).optional(),
    actor: z.string().min(1),
    caveat: z.string(),
  })
  .passthrough();
const taskSchema = z
  .object({
    source: z.string().optional(),
    inboxItemId: z.string().optional(),
    id: z.string().min(1),
    title: z.string().min(1),
    projectId: z.string().min(1).optional(),
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
  })
  .passthrough();
export const TaskFinderSnapshotSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    source: z
      .object({
        instanceId: z.string().min(1),
        scopeId: z.string().min(1).default("default"),
        capturedAt: instant,
        coverage: z.enum(["partial", "complete"]).default("partial"),
      })
      .passthrough(),
    streams: z
      .array(
        z
          .object({ id: stream, name: z.string().min(1), archived: z.boolean().optional() })
          .passthrough(),
      )
      .optional(),
    contexts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            archived: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
    projects: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          displayName: z.string().min(1).optional(),
          contextId: z.string().min(1).nullable().optional(),
          planning: projectPlan.optional(),
          planRevision: z.number().int().nonnegative().optional(),
          stream,
          linkedStreams: z.array(stream).default([]),
        })
        .passthrough(),
    ),
    tasks: z.array(taskSchema),
  })
  .passthrough()
  .superRefine((s, ctx) => {
    for (const [name, rows] of [
      ["projects", s.projects],
      ["tasks", s.tasks],
    ] as const) {
      if (new Set(rows.map((r) => r.id)).size !== rows.length)
        ctx.addIssue({ code: "custom", message: `Duplicate ${name} IDs` });
    }
    if (s.schemaVersion === 2 && s.source.scopeId !== "all") {
      const context = s.source.scopeId === "unassigned" ? null : s.source.scopeId;
      if (s.source.scopeId !== "unassigned" && s.tasks.some((t) => !t.projectId))
        ctx.addIssue({
          code: "custom",
          message: "Projectless tasks have unknown context and cannot enter an employer scope",
        });
      if (s.contexts?.some((c) => c.id !== context))
        ctx.addIssue({ code: "custom", message: "Unrelated context catalog in scoped snapshot" });
      if (s.projects.some((p) => (p.contextId ?? null) !== context))
        ctx.addIssue({ code: "custom", message: "Project context differs from snapshot scope" });
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
export const snapshotText = (value: string) =>
  value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]<>#|]/g, "\\$&");
const link = (url: string) => url.replaceAll("(", "%28").replaceAll(")", "%29");

/** A deterministic snapshot report, never a model inference or live source verification. */
export function renderTaskFinderProject(
  snapshot: TaskFinderSnapshot,
  projectId: string | undefined,
  window: ReportWindow,
): string {
  const project = snapshot.projects.find((p) => p.id === projectId);
  const streamLabel = (id: string) => snapshot.streams?.find((s) => s.id === id)?.name ?? id;
  const tasks = snapshot.tasks
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines = [
    `# ${snapshotText(project?.displayName ?? project?.name ?? "Unassigned")}`,
    "",
    `${window.from} → ${window.to} (${window.timezone}; ${window.kind})`,
    "",
    `Source: Task Finder snapshot ${snapshotText(snapshot.source.instanceId)}, captured ${snapshot.source.capturedAt}; coverage: ${snapshot.source.coverage}. Not live verified.`,
    `Primary stream: ${project ? snapshotText(streamLabel(project.stream)) : "unassigned"}. Overlap links: ${project?.linkedStreams.map((s) => snapshotText(streamLabel(s))).join(", ") || "none"}; count only the primary home.`,
    "",
    `Context: ${snapshotText(snapshot.contexts?.find((c) => c.id === project?.contextId)?.name ?? project?.contextId ?? "Unassigned / unknown")}; scope: ${snapshotText(snapshot.source.scopeId)}.`,
    "## Recorded events in period",
    "",
    "These are supplied assertions, not independently verified outcomes. Merged is not deployed or live verified.",
    "",
  ];
  if (project?.planning) {
    const p = project.planning;
    const planLines = [
      "## Project plan at snapshot time",
      `Outcome: ${snapshotText(p.outcome ?? "Not recorded")}`,
      `Phase: ${snapshotText(p.phase ?? "Not recorded")}; status: ${p.status ?? "not recorded"}; priority: ${p.priority ?? "normal"}; reported health: ${p.health ?? "unknown"}.`,
      `Next action: ${snapshotText(p.nextAction ?? "Not recorded")}`,
      `Waiting on: ${snapshotText(p.waitingOn ?? "None recorded")}; decision: ${snapshotText(p.decision ?? "None recorded")}.`,
      `Plan last recorded: ${p.updatedAt ?? "unknown"}; actor: ${snapshotText(p.updatedBy ?? "unknown")}.`,
      "Planned dates are not observed evidence or inferred missed commitments.",
    ];
    for (const m of p.milestones ?? [])
      planLines.push(
        `- ${snapshotText(m.title)} (${m.state}): ${m.date.kind}${m.date.value ? ` ${m.date.value} (${snapshotText(m.date.timezone ?? "unknown")})` : "; date not set"}; source: ${snapshotText(m.date.source ?? "unknown")}; confirmed by: ${snapshotText(m.date.confirmedBy ?? "not recorded")}.`,
      );
    for (const d of p.dependencies ?? [])
      planLines.push(`- Dependency project ${snapshotText(d.projectId)}: ${snapshotText(d.note)}`);
    // Insert before event section; the plan is current context, never historical evidence.
    const index = lines.indexOf("## Recorded events in period");
    lines.splice(index, 0, ...planLines, "");
  }
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
      `### ${snapshotText(t.title)} [task ${snapshotText(t.id)}]`,
      `Contribution: ${t.attribution?.kind ?? "unknown"}; basis: ${snapshotText(t.attribution?.basis ?? "not recorded; owner is not proof of individual contribution")}.`,
      `Contributors: ${t.attribution?.contributors.map(snapshotText).join(", ") || "unknown"}.`,
    );
    if (t.sourceRef?.url) lines.push(`[Original source](${link(t.sourceRef.url)})`);
    if (accepted)
      lines.push(
        `Accepted ${t.acceptedAt} by ${snapshotText(t.acceptedBy ?? "unknown")}. This is not agent-result review.`,
      );
    if (completed)
      lines.push(`Marked done ${t.completedAt}; this alone does not establish release or impact.`);
    for (const e of evidence)
      lines.push(
        `- ${e.milestone}: [evidence ${snapshotText(e.id)}](${link(e.url)}) · ${e.occurredAt} · actor: ${snapshotText(e.actor)} · caveat: ${snapshotText(e.caveat || "none supplied")}`,
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
      `- ${snapshotText(t.title)} [task ${snapshotText(t.id)}]: ${t.status}; owner: ${snapshotText(t.work?.owner ?? "unknown")}; next: ${snapshotText(t.work?.nextAction ?? "not recorded")}; deadline: ${snapshotText(t.dueDate ?? "none")}.`,
    );
  for (const t of tasks)
    for (const m of t.metrics) {
      const support = t.evidence.filter((e) => m.evidenceIds.includes(e.id));
      lines.push(
        `- Metric ${snapshotText(m.name)} [task ${snapshotText(t.id)}]: ${m.value ?? "unknown"} ${snapshotText(m.unit)} (${m.verification}, current snapshot assertion; not dated historical impact). Support: ${support.map((e) => `[${snapshotText(e.id)}](${link(e.url)}) at ${e.occurredAt}`).join(", ") || "none recorded; date unknown"}.`,
      );
    }
  return lines.join("\n");
}

export function snapshotScopeName(snapshot: TaskFinderSnapshot): string {
  const scope = snapshot.source.scopeId;
  return scope === "all"
    ? "All contexts"
    : scope === "unassigned"
      ? "Unassigned context"
      : scope === "default"
        ? "Legacy scope"
        : (snapshot.contexts?.find((c) => c.id === scope)?.name ?? scope);
}
