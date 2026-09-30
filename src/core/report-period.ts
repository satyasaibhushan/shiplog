import { Temporal } from "@js-temporal/polyfill";
/** Calendar labels in a configured IANA timezone, bounded by actual local midnights. */
export type ReportKind = "daily" | "weekly" | "monthly";
export type ReportTimezone = string;
export interface ReportWindow {
  kind: ReportKind | "custom";
  timezone: ReportTimezone;
  weekStartsOn?: number;
  from: string;
  to: string;
  startInclusive: string;
  endExclusive: string;
  key: string;
}
export function reportTimezone(value = "UTC"): ReportTimezone {
  if (!value || /^[+-]/.test(value)) throw new Error("Use a valid IANA reporting timezone");
  try { return new Intl.DateTimeFormat("en", {timeZone:value}).resolvedOptions().timeZone; }
  catch { throw new Error(`Invalid IANA reporting timezone: ${value}`); }
}
export function dateWindow(from: string, to: string, timezone: ReportTimezone = "UTC", kind: ReportWindow["kind"] = "custom"): ReportWindow {
  timezone = reportTimezone(timezone);
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use an ISO calendar date");
    return Temporal.PlainDate.from(value, {overflow:"reject"});
  };
  const start = parse(from), end = parse(to);
  if (Temporal.PlainDate.compare(start,end)>0) throw new Error("Report start must not follow end");
  const instant = (d: Temporal.PlainDate) => d.toZonedDateTime(timezone).toInstant().toString({smallestUnit:"millisecond"});
  return {kind,timezone,from,to,startInclusive:instant(start),endExclusive:instant(end.add({days:1})),key:`${kind}:${timezone}:${from}:${to}`};
}
export function reportWindow(kind: ReportKind, now = new Date(), timezone: ReportTimezone = "UTC", weekStartsOn = 1): ReportWindow {
  timezone = reportTimezone(timezone);
  if (!Number.isInteger(weekStartsOn) || weekStartsOn<0 || weekStartsOn>6) throw new Error("weekStartsOn must be 0 (Sunday) through 6 (Saturday)");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid report instant");
  let start = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timezone).toPlainDate();
  let end = start;
  if (kind === "weekly") {
    start = start.subtract({days:(start.dayOfWeek % 7 - weekStartsOn + 7) % 7});
    end = start.add({days:6});
  } else if (kind === "monthly") {
    start = start.with({day:1});
    end = start.add({months:1}).subtract({days:1});
  } else if (kind !== "daily") throw new Error("Invalid report kind");
  const window = dateWindow(start.toString(),end.toString(),timezone,kind);
  return kind === "weekly" ? {...window,weekStartsOn} : window;
}
export function inWindow(instant: string | undefined, window: ReportWindow): boolean {
  if (!instant) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(instant)) return instant >= window.from && instant <= window.to;
  const at = Date.parse(instant);
  return Number.isFinite(at) && at >= Date.parse(window.startInclusive) && at < Date.parse(window.endExclusive);
}
