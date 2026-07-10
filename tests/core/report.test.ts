import { describe, expect, it } from "bun:test";
import {
  renderProjectReport,
  reportRange,
  type GenerateLogResult,
  type GenerateRollupResult,
} from "../../src/core/report.ts";
import type { LogRecord, SummaryVersionRecord } from "../../src/core/entities.ts";

function entry(
  owner: string,
  repo: string,
  summary: string,
  stats?: SummaryVersionRecord["stats"],
): GenerateLogResult {
  const log: LogRecord = {
    id: `log_${owner}_${repo}`,
    owner,
    repo,
    authorEmail: "me@local",
    rangeStart: "2026-07-01",
    rangeEnd: "2026-07-07",
    createdAt: 0,
    updatedAt: 0,
  };
  const version: SummaryVersionRecord = {
    id: `v_${owner}_${repo}`,
    parentKind: "log",
    parentId: log.id,
    versionNumber: 1,
    summaryMarkdown: summary,
    stats,
    source: "generated",
    model: "test",
    createdAt: 0,
  };
  return { log, version, groupCount: 1 };
}

describe("reportRange", () => {
  it("daily covers a single day", () => {
    const r = reportRange("daily", new Date("2026-07-10T12:00:00Z"));
    expect(r).toEqual({ from: "2026-07-10", to: "2026-07-10" });
  });

  it("weekly covers 7 days ending today", () => {
    const r = reportRange("weekly", new Date("2026-07-10T12:00:00Z"));
    expect(r).toEqual({ from: "2026-07-04", to: "2026-07-10" });
  });
});

describe("renderProjectReport", () => {
  it("renders title, range, and one section per project", () => {
    const md = renderProjectReport({
      from: "2026-07-01",
      to: "2026-07-07",
      title: "Weekly report",
      entries: [
        entry("acme", "api", "Shipped the auth flow.", {
          additions: 100,
          deletions: 20,
          files: 5,
          commits: 3,
          prs: 1,
        }),
        entry("acme", "web", "Fixed the dashboard."),
      ],
    });
    expect(md).toContain("# Weekly report");
    expect(md).toContain("_2026-07-01 → 2026-07-07_");
    expect(md).toContain("## acme/api");
    expect(md).toContain("+100 / -20 across 5 file(s), 3 commit(s), 1 PR(s)");
    expect(md).toContain("Shipped the auth flow.");
    expect(md).toContain("## acme/web");
    expect(md).toContain("Fixed the dashboard.");
    expect(md).not.toContain("## Overview");
  });

  it("puts the rollup summary in an Overview section first", () => {
    const e = entry("acme", "api", "Details here.");
    const rollup: GenerateRollupResult = {
      rollup: {
        id: "rollup_1",
        title: "Weekly report",
        authorEmail: "me@local",
        rangeStart: "2026-07-01",
        rangeEnd: "2026-07-07",
        logIds: [e.log.id],
        createdAt: 0,
        updatedAt: 0,
      },
      version: { ...e.version, parentKind: "rollup", summaryMarkdown: "Big picture." },
    };
    const md = renderProjectReport({
      from: "2026-07-01",
      to: "2026-07-07",
      title: "Weekly report",
      entries: [e],
      rollup,
    });
    expect(md.indexOf("## Overview")).toBeGreaterThan(-1);
    expect(md.indexOf("Big picture.")).toBeLessThan(md.indexOf("## acme/api"));
  });

  it("notes when there is no activity", () => {
    const md = renderProjectReport({
      from: "2026-07-01",
      to: "2026-07-07",
      title: "Weekly report",
      entries: [],
    });
    expect(md).toContain("_No activity found in this range._");
  });
});
