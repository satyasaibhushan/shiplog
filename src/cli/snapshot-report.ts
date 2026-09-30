import { initDb, closeDb } from "../core/cache.ts";
import { reportTimezone, reportWindow, type ReportKind } from "../core/report-period.ts";
import { generateTaskFinderReport, generateTaskFinderRollup } from "../core/taskfinder-report.ts";
/** This entry point runs before config/sync/provider setup. No network or model use. */
export async function snapshotReport(values: Record<string, unknown>): Promise<void> {
  const file = values["taskfinder-snapshot"],
    instance = values["taskfinder-instance"];
  if (Boolean(file) === Boolean(instance))
    throw new Error("Choose exactly one of --taskfinder-snapshot or --taskfinder-instance");
  const kinds = (["daily", "weekly", "monthly"] as const).filter((k) => values[k]);
  if (kinds.length !== 1 || values.from || values.to)
    throw new Error("Choose exactly one calendar period: --daily, --weekly, --monthly");
  if (typeof values.author !== "string" || !values.author.trim())
    throw new Error("--author is required for report identity (not contribution attribution)");
  if (
    values.at !== undefined &&
    (typeof values.at !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(values.at))
  )
    throw new Error("--at requires an ISO instant with explicit offset");
  const window = reportWindow(
    kinds[0] as ReportKind,
    values.at ? new Date(String(values.at)) : new Date(),
    reportTimezone(typeof values.timezone === "string" ? values.timezone : undefined),
  );
  const format = values.output ?? "markdown";
  if (format !== "markdown" && format !== "json")
    throw new Error("Snapshot output must be markdown or json");
  // Parse the file before opening storage. This reads only the explicitly supplied file.
  const raw = typeof file === "string" ? await Bun.file(file).json() : undefined;
  initDb();
  try {
    if (raw !== undefined) {
      const entries = await generateTaskFinderReport(raw, window, values.author.trim());
      console.log(
        format === "json"
          ? JSON.stringify({ window, entries }, null, 2)
          : entries.map((e) => e.version.summaryMarkdown).join("\n\n---\n\n"),
      );
    } else {
      const result = await generateTaskFinderRollup(String(instance), window, values.author.trim());
      console.log(
        format === "json"
          ? JSON.stringify({ window, ...result }, null, 2)
          : result.version.summaryMarkdown,
      );
    }
  } finally {
    closeDb();
  }
}
