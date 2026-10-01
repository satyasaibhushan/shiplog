import { TaskFinderSnapshotSchema, renderTaskFinderProject, snapshotText as text } from "./taskfinder-snapshot.ts";
export { TaskFinderSnapshotSchema, renderTaskFinderProject, type TaskFinderSnapshot } from "./taskfinder-snapshot.ts";
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
import { inWindow, reportTimezone, type ReportWindow } from "./report-period.ts";
import type { GenerateLogResult, GenerateRollupResult } from "./report.ts";
/** Uses the existing log/version persistence and IDs, with no source/model/sync calls. */
export async function generateTaskFinderReport(
  raw: unknown,
  window: ReportWindow,
  authorEmail: string,
  requestedScope?: string,
): Promise<GenerateLogResult[]> {
  const snapshot = TaskFinderSnapshotSchema.parse(raw);
  if (requestedScope !== undefined && requestedScope !== snapshot.source.scopeId) throw new Error("Requested scope differs from snapshot scope");
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
          scopeId: snapshot.source.scopeId === "default" ? undefined : snapshot.source.scopeId,
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
        title: project?.displayName ?? project?.name ?? "Unassigned",
      });
      const markdown = renderTaskFinderProject(snapshot, projectId, window);
      const references = snapshot.tasks
        .filter((t) => t.projectId === projectId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((t) => ({
          taskContext: t,
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
        scopeId: snapshot.source.scopeId,
        snapshotContext: {...snapshot, tasks: snapshot.tasks.filter(t=>t.projectId===projectId), projects: project ? [project] : []},
        window,
        projectId: projectId ?? null,
        projectName: project?.displayName ?? project?.name ?? "Unassigned",
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
  scopeId = "default",
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
        (context.scopeId ?? "default") !== scopeId ||
        child?.kind !== "daily" ||
        reportTimezone(child.timezone) !== reportTimezone(window.timezone) ||
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
  scopeId = "default",
): Promise<GenerateRollupResult> {
  if (window.kind !== "weekly" && window.kind !== "monthly")
    throw new Error("Daily-log aggregation requires a weekly or monthly window");
  const id =
    "rollup_" + fingerprint({ source: "task-finder", instanceId, scopeId: scopeId === "default" ? undefined : scopeId, window: window.key, authorEmail });
  const entries = taskFinderDailyVersions(instanceId, window, authorEmail, scopeId);
  const sourceVersions = entries.map((e) => ({ logId: e.log.id, versionId: e.version.id }));
  const canActivate = () => fingerprint(taskFinderDailyVersions(instanceId, window, authorEmail, scopeId).map(e => ({logId: e.log.id, versionId: e.version.id}))) === fingerprint(sourceVersions);
  return singleFlight(id + ":" + fingerprint(sourceVersions), async () => {
    if (!entries.length)
      throw new Error(
        "No active Task Finder daily reports in this period; import reviewed snapshots first",
      );
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
    if (!canActivate()) throw new Error("Report sources changed during generation; retry with current active versions");
    await setRollupLogs(
      rollup.id,
      entries.map((e) => e.log.id),
    );
    const context = { source: "task-finder", instanceId, scopeId, window, sourceVersions };
    const version = await appendReportVersion(
      {
        parentKind: "rollup",
        parentId: rollup.id,
        canActivate,
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
