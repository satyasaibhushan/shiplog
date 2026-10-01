import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  TaskFinderSnapshotSchema,
  renderTaskFinderProject,
  snapshotScopeName,
} from "../core/taskfinder-snapshot.ts";
import { reportWindow, reportTimezone } from "../core/report-period.ts";
import { fingerprint } from "../core/report-identity.ts";

export const ImportSchema = z
  .object({
    snapshot: TaskFinderSnapshotSchema,
    kind: z.enum(["daily", "weekly", "monthly"]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().min(1),
    weekStartsOn: z.number().int().min(0).max(6).default(1),
    expectedRevision: z.number().int().nonnegative(),
    reviewedReportId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export function prepareReport(raw: unknown, owner: string) {
  const input = ImportSchema.parse(raw);
  const timezone = reportTimezone(input.timezone);
  const day = Temporal.PlainDate.from(input.date, { overflow: "reject" });
  const instant = day.toZonedDateTime({ timeZone: timezone, plainTime: "12:00" }).toInstant();
  const window = reportWindow(
    input.kind,
    new Date(instant.epochMilliseconds),
    timezone,
    input.weekStartsOn,
  );
  const snapshot = input.snapshot;
  const projects: Array<string | undefined> = snapshot.projects.map((p) => p.id).sort();
  if (snapshot.tasks.some((t) => !t.projectId)) projects.push(undefined);
  const sections = projects.map((projectId) => ({
    projectId: projectId ?? null,
    markdown: renderTaskFinderProject(snapshot, projectId, window),
  }));
  const id = fingerprint({
    owner,
    instance: snapshot.source.instanceId,
    scope: snapshot.source.scopeId,
    window: window.key,
  });
  if (input.expectedRevision > 0 && input.reviewedReportId !== id)
    throw new Error("Review must match the exact report target");
  const payload = { snapshot, window, sections };
  if (Buffer.byteLength(JSON.stringify(payload)) > 3 * 1024 * 1024)
    throw new Error("Rendered report limit is 3 MiB");
  return {
    id,
    instanceId: snapshot.source.instanceId,
    scopeId: snapshot.source.scopeId,
    title: `${snapshotScopeName(snapshot)} · ${input.kind[0]!.toUpperCase() + input.kind.slice(1)} report · ${window.from} – ${window.to}`,
    fingerprint: fingerprint(payload),
    payload,
    expectedRevision: input.expectedRevision,
  };
}
export type PreparedReport = ReturnType<typeof prepareReport>;
