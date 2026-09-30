/** Calendar report windows are half-open instants; labels are local dates. */
export type ReportKind = "daily" | "weekly" | "monthly";
export type ReportTimezone = "Asia/Kolkata" | "UTC";
export interface ReportWindow {
  kind: ReportKind | "custom";
  timezone: ReportTimezone;
  from: string;
  to: string;
  startInclusive: string;
  endExclusive: string;
  key: string;
}
const dayMs = 86_400_000;
export function reportTimezone(value = "Asia/Kolkata"): ReportTimezone {
  if (value !== "Asia/Kolkata" && value !== "UTC")
    throw new Error("Supported reporting timezones: Asia/Kolkata, UTC");
  return value;
}
export function dateWindow(
  from: string,
  to: string,
  timezone: ReportTimezone = "Asia/Kolkata",
  kind: ReportWindow["kind"] = "custom",
): ReportWindow {
  reportTimezone(timezone);
  const date = (s: string) => {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
      !Number.isFinite(Date.parse(s)) ||
      new Date(s).toISOString().slice(0, 10) !== s
    )
      throw new Error(`Invalid calendar date: ${s}`);
    return Date.parse(s);
  };
  const start = date(from),
    end = date(to);
  if (start > end) throw new Error("Report start must not follow end");
  const offset = timezone === "Asia/Kolkata" ? 330 * 60_000 : 0;
  return {
    kind,
    timezone,
    from,
    to,
    startInclusive: new Date(start - offset).toISOString(),
    endExclusive: new Date(end + dayMs - offset).toISOString(),
    key: `${kind}:${timezone}:${from}:${to}`,
  };
}
export function reportWindow(
  kind: ReportKind,
  now = new Date(),
  timezone: ReportTimezone = "Asia/Kolkata",
): ReportWindow {
  reportTimezone(timezone);
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid report instant");
  const local = new Date(now.getTime() + (timezone === "Asia/Kolkata" ? 330 * 60_000 : 0));
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let end = start;
  if (kind === "weekly") {
    start -= ((local.getUTCDay() + 6) % 7) * dayMs;
    end = start + 6 * dayMs;
  } else if (kind === "monthly") {
    start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
    end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0);
  } else if (kind !== "daily") throw new Error("Invalid report kind");
  return dateWindow(
    new Date(start).toISOString().slice(0, 10),
    new Date(end).toISOString().slice(0, 10),
    timezone,
    kind,
  );
}
export function inWindow(instant: string | undefined, window: ReportWindow): boolean {
  if (!instant) return false;
  const at = Date.parse(instant);
  return (
    Number.isFinite(at) &&
    at >= Date.parse(window.startInclusive) &&
    at < Date.parse(window.endExclusive)
  );
}
