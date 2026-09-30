import { computeTimeline, computeGroupHash, computeSummary } from "../../src/core/summarizer.ts";
import type { CommitGroup } from "../../src/core/grouping.ts";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportWindow, dateWindow, inWindow } from "../../src/core/report-period.ts";
import { generateLog, generateRollup, type ReportAdapters } from "../../src/core/report.ts";
import {
  generateTaskFinderReport,
  generateTaskFinderRollup,
  TaskFinderSnapshotSchema,
  renderTaskFinderProject,
} from "../../src/core/taskfinder-report.ts";
import { initDb, closeDb } from "../../src/core/cache.ts";
import {
  appendSummaryVersion,
  getLog,
  getRollup,
  createLog,
  listLogs,
  listRollups,
  listVersions,
  setLogActiveVersion,
} from "../../src/core/entities.ts";
import fixture from "../fixtures/taskfinder-synthetic.json";
const root = mkdtempSync(join(tmpdir(), "shiplog-report-hardening-"));
const before = { config: process.env.SHIPLOG_CONFIG_DIR, data: process.env.SHIPLOG_DATA_DIR };
beforeEach(() => {
  closeDb();
  process.env.SHIPLOG_CONFIG_DIR = join(root, "config");
  process.env.SHIPLOG_DATA_DIR = join(root, "data");
  rmSync(root, { recursive: true, force: true });
  initDb();
});
afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
  if (before.config === undefined) delete process.env.SHIPLOG_CONFIG_DIR;
  else process.env.SHIPLOG_CONFIG_DIR = before.config;
  if (before.data === undefined) delete process.env.SHIPLOG_DATA_DIR;
  else process.env.SHIPLOG_DATA_DIR = before.data;
});
test("Kolkata half-open midnight, calendar week, leap-month and year boundaries", () => {
  const a = reportWindow("daily", new Date("2026-09-30T18:29:59Z"), "Asia/Kolkata");
  const b = reportWindow("daily", new Date("2026-09-30T18:30:00Z"), "Asia/Kolkata");
  expect(a.from).toBe("2026-09-30");
  expect(b.from).toBe("2026-10-01");
  expect(inWindow("2026-09-30T18:30:00Z", a)).toBe(false);
  expect(inWindow("2026-09-30T18:30:00Z", b)).toBe(true);
  expect(reportWindow("weekly", new Date("2027-01-01T00:00:00Z"), "Asia/Kolkata")).toMatchObject({
    from: "2026-12-28",
    to: "2027-01-03",
  });
  expect(reportWindow("monthly", new Date("2024-02-15T00:00:00Z"), "Asia/Kolkata")).toMatchObject({
    from: "2024-02-01",
    to: "2024-02-29",
    endExclusive: "2024-02-29T18:30:00.000Z",
  });
  expect(reportWindow("monthly", new Date("2026-12-31T18:30:00Z"), "Asia/Kolkata")).toMatchObject({
    from: "2027-01-01",
    to: "2027-01-31",
  });
  expect(() => dateWindow("2026-02-30", "2026-03-01")).toThrow();
});
test("snapshot retries reuse entities/versions, preserve attribution, and never infer deployment", async () => {
  const day = reportWindow("daily", new Date(fixture.source.capturedAt), "Asia/Kolkata");
  const [a, b] = await Promise.all([
    generateTaskFinderReport(fixture, day, "fixture@example.test"),
    generateTaskFinderReport(fixture, day, "fixture@example.test"),
  ]);
  expect(a.map((e) => e.log.id)).toEqual(b.map((e) => e.log.id));
  expect(listLogs()).toHaveLength(2);
  const task = a.find((e) => e.log.repo === "synthetic-sso")!;
  expect(task.log.activeVersionId).toBe(task.version.id);
  expect(task.version.summaryMarkdown).toContain("Contribution: team");
  expect(task.version.summaryMarkdown).toContain("Latency improvement [task synthetic-task-1]: unknown");
  expect(task.version.summaryMarkdown).toContain("no UAT, QA or live verification");
  expect(task.version.summaryMarkdown).toContain("synthetic-evidence-1");
  await generateTaskFinderReport(fixture, day, "fixture@example.test");
  expect(listVersions("log", task.log.id)).toHaveLength(1);
  const changed = structuredClone(fixture);
  changed.tasks[0]!.evidence[0]!.caveat = "QA still pending; correction";
  const c = await generateTaskFinderReport(changed, day, "fixture@example.test");
  expect(c.find((e) => e.log.id === task.log.id)!.version.versionNumber).toBe(2);
  expect(listLogs()).toHaveLength(2);
});
test("weekly/monthly use active daily versions; membership and identical retries stay stable", async () => {
  const day = reportWindow("daily", new Date(fixture.source.capturedAt), "Asia/Kolkata");
  const entries = await generateTaskFinderReport(fixture, day, "fixture@example.test");
  const first = entries[0]!;
  const newer = await appendSummaryVersion({
    parentKind: "log",
    parentId: first.log.id,
    summaryMarkdown: "Explicitly selected active correction",
    source: "chat",
    model: "fixture",
    chatPrompt: { userMessage: "Explicit correction" },
  });
  const month = reportWindow("monthly", new Date(fixture.source.capturedAt), "Asia/Kolkata");
  const result = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    month,
    "fixture@example.test",
  );
  expect(result.version.summaryMarkdown).toContain("Explicitly selected active correction");
  expect(result.version.chatPrompt?.sourceVersions).toContainEqual({
    logId: first.log.id,
    versionId: newer.id,
  });
  const again = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    month,
    "fixture@example.test",
  );
  expect(again.version.id).toBe(result.version.id);
  await setLogActiveVersion(first.log.id, first.version.id);
  const reverted = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    month,
    "fixture@example.test",
  );
  expect(reverted.rollup.id).toBe(result.rollup.id);
  expect(reverted.version.versionNumber).toBe(2);
  expect(listRollups()).toHaveLength(1);
  const nextDay = reportWindow("daily", new Date("2026-10-02T12:00:00Z"), "Asia/Kolkata");
  await generateTaskFinderReport(fixture, nextDay, "fixture@example.test");
  const expanded = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    month,
    "fixture@example.test",
  );
  expect(expanded.rollup.id).toBe(result.rollup.id);
  expect(expanded.rollup.logIds).toHaveLength(4);
  const week = await generateTaskFinderRollup(
    "synthetic-taskfinder",
    reportWindow("weekly", new Date(fixture.source.capturedAt), "Asia/Kolkata"),
    "fixture@example.test",
  );
  expect(week.rollup.id).not.toBe(result.rollup.id);
});
test("snapshot schema rejects orphan IDs and unsupported verified metric claims", () => {
  const bad = structuredClone(fixture);
  bad.tasks[0]!.projectId = "missing";
  expect(TaskFinderSnapshotSchema.safeParse(bad).success).toBe(false);
  const duplicate = structuredClone(fixture);
  duplicate.tasks.push(duplicate.tasks[0]!);
  expect(TaskFinderSnapshotSchema.safeParse(duplicate).success).toBe(false);
  const unsupported = structuredClone(fixture);
  unsupported.tasks[0]!.metrics = [{ name: "Claimed gain", value: null, unit: "%", verification: "verified", evidenceIds: [] }];
  expect(TaskFinderSnapshotSchema.safeParse(unsupported).success).toBe(false);
});
test("generated logs return active records; rollups re-read active versions, dedup, and reuse identical results", async () => {
  let called = 0;
  const adapters: ReportAdapters = {
    fetch: async (p) => {
      expect(p.from).toBe("2026-09-29T18:30:00.000Z");
      return { commits: [], pullRequests: [], stats: {} } as Awaited<
        ReturnType<NonNullable<ReportAdapters["fetch"]>>
      >;
    },
    summarize: async () => ({
      rollupSummary: "Synthetic summary",
      timeline: [],
      aggregateStats: { additions: 2, deletions: 0, files: 1, commits: 1, prs: 0 },
      groupSummaries: [],
      provider: "codex-cli",
      stats: { groupsProcessed: 0, cacheHits: 0, llmCalls: 0, totalDuration: 0 },
    }),
  };
  const input = {
    owner: "fixture",
    repo: "repo",
    rangeStart: "2026-09-30",
    rangeEnd: "2026-09-30",
    timezone: "Asia/Kolkata" as const,
    provider: "codex-cli" as const,
    model: "mock",
  };
  const a = await generateLog(input, adapters);
  const b = await generateLog(input, adapters);
  expect(a!.log.activeVersionId).toBe(a!.version.id);
  expect(b!.log.id).toBe(a!.log.id);
  expect(b!.version.id).toBe(a!.version.id);
  const stale = { ...a!.log, activeVersionId: undefined };
  const roll = {
    title: "Test rollup",
    logs: [stale, stale],
    provider: "codex-cli" as const,
    model: "mock",
  };
  const mockModel = async (prompt: string) => {
    called++;
    expect(prompt).toContain("Synthetic summary");
    return "Mock rollup";
  };
  const r = await generateRollup(roll, mockModel);
  const rr = await generateRollup(roll, mockModel);
  expect(r.rollup.activeVersionId).toBe(r.version.id);
  expect(rr.version.id).toBe(r.version.id);
  expect(called).toBe(1);
  expect(r.version.stats?.commits).toBe(1);
  expect(getLog(a!.log.id)?.activeVersionId).toBe(a!.version.id);
  await expect(generateRollup({ ...roll, logs: [] }, mockModel)).rejects.toThrow();
});

test("timeline and cache identity use reporting timezone at midnight", async () => {
  const groups = [{ type: "pr", label: "Boundary", commits: [{sha: "boundary", date: "2026-09-30T18:30:00Z", stats: {additions: 1, deletions: 0}}], pr: {id: "fixture/pr/1", mergedAt: "2026-09-30T18:30:00Z", title: "Boundary"} }] as CommitGroup[];
  expect(computeTimeline(groups, "UTC")[0]!.date).toBe("2026-09-30");
  expect(computeTimeline(groups, "Asia/Kolkata")[0]).toMatchObject({date: "2026-10-01", commitCount: 1, prCount: 1});
  expect(computeGroupHash(groups[0]!, "UTC")).not.toBe(computeGroupHash(groups[0]!, "Asia/Kolkata"));
  const result = await generateLog({owner: "fixture", repo: "boundary", rangeStart: "2026-10-01", rangeEnd: "2026-10-01", timezone: "Asia/Kolkata", provider: "codex-cli", model: "mock"}, {
    fetch: async () => ({commits: [], pullRequests: [], stats: {}}) as never,
    summarize: async (_groups, params) => {
      expect(params.timezone).toBe("Asia/Kolkata");
      return {rollupSummary: "Boundary", timeline: computeTimeline(groups, params.timezone), aggregateStats: {additions: 1, deletions: 0, files: 1, commits: 1, prs: 1}, groupSummaries: [], provider: "codex-cli", stats: {groupsProcessed: 1, cacheHits: 0, llmCalls: 0, totalDuration: 0}};
    },
  });
  expect(result!.version.timeline![0]!.date).toBe("2026-10-01");
  await generateRollup({title: "Boundary month", logs: [result!.log], provider: "codex-cli", model: "mock"}, async prompt => {
    expect(prompt).toContain("- 2026-10-01 [fixture/boundary]");
    expect(prompt).not.toContain("- 2026-09-30");
    return "Boundary rollup";
  });
});
test("later supported metrics stay in dated snapshot context, never historical events", () => {
  const raw = structuredClone(fixture);
  raw.tasks[0]!.acceptedAt = "2022-08-01T08:00:00Z";
  const snapshot = TaskFinderSnapshotSchema.parse(raw);
  snapshot.tasks[0]!.metrics = [{name: "Gain", value: 42, unit: "%", verification: "verified", evidenceIds: [snapshot.tasks[0]!.evidence[0]!.id]}];
  const markdown = renderTaskFinderProject(snapshot, snapshot.tasks[0]!.projectId, reportWindow("monthly", new Date("2022-08-01T08:00:00Z"), "Asia/Kolkata"));
  const [events, context] = markdown.split("## Current snapshot context");
  expect(events).toContain("Accepted 2022-08-01");
  expect(events).not.toContain("42");
  expect(context).toContain("42 %");
  expect(context).toContain(snapshot.tasks[0]!.evidence[0]!.occurredAt);
  expect(context).toContain(snapshot.tasks[0]!.evidence[0]!.url);
});
test("empty project IDs reject explicitly; absent IDs retain unassigned tasks", async () => {
  const raw = structuredClone(fixture);
  raw.tasks[0]!.projectId = "";
  expect(TaskFinderSnapshotSchema.safeParse(raw).success).toBe(false);
  const parsed = TaskFinderSnapshotSchema.parse(fixture);
  delete parsed.tasks[0]!.projectId;
  const reports = await generateTaskFinderReport(parsed, reportWindow("daily", new Date(fixture.source.capturedAt), "Asia/Kolkata"), "fixture@example.test");
  expect(reports.find(r => r.log.repo === "unassigned")!.version.summaryMarkdown).toContain(parsed.tasks[0]!.title);
});
test("a delayed old rollup cannot coalesce with or overwrite a refreshed active source", async () => {
  const log = await createLog({owner: "fixture", repo: "race", authorEmail: "fixture@example.test", rangeStart: "2026-10-01", rangeEnd: "2026-10-01"});
  await appendSummaryVersion({parentKind: "log", parentId: log.id, summaryMarkdown: "source v1", source: "generated", model: "mock"});
  const input = {title: "Concurrent", logs: [log], provider: "codex-cli" as const, model: "mock"};
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { started = r; });
  const old = generateRollup(input, async prompt => {
    expect(prompt).toContain("source v1"); started(); await gate; return "old output";
  });
  const oldResult = old.then(() => "unexpected success", e => String(e));
  await entered;
  const v2 = await appendSummaryVersion({parentKind: "log", parentId: log.id, summaryMarkdown: "source v2", source: "chat", model: "mock"});
  const fresh = await generateRollup(input, async prompt => {expect(prompt).toContain("source v2"); return "fresh output";});
  await appendSummaryVersion({parentKind: "log", parentId: log.id, summaryMarkdown: "source v3", source: "chat", model: "mock"});
  release();
  expect(await oldResult).toContain("sources changed");
  expect(getRollup(fresh.rollup.id)!.activeVersionId).toBe(fresh.version.id);
  expect(fresh.version.chatPrompt!.sourceVersions).toEqual([{logId: log.id, versionId: v2.id}]);
  expect(getRollup(fresh.rollup.id)!.stale).toBeDefined();
});
test("Task Finder concurrent refresh captures version changes rather than period-only coalescing", async () => {
  const day = reportWindow("daily", new Date(fixture.source.capturedAt), "Asia/Kolkata");
  const reports = await generateTaskFinderReport(fixture, day, "fixture@example.test");
  const month = reportWindow("monthly", new Date(fixture.source.capturedAt), "Asia/Kolkata");
  const old = generateTaskFinderRollup("synthetic-taskfinder", month, "fixture@example.test");
  const oldResult = old.then(r => r, e => String(e));
  const changed = await appendSummaryVersion({parentKind: "log", parentId: reports[0]!.log.id, summaryMarkdown: "Concurrent snapshot correction", source: "chat", model: "fixture"});
  const fresh = await generateTaskFinderRollup("synthetic-taskfinder", month, "fixture@example.test");
  await oldResult;
  expect(fresh.version.summaryMarkdown).toContain("Concurrent snapshot correction");
  expect(fresh.version.chatPrompt!.sourceVersions).toContainEqual({logId: reports[0]!.log.id, versionId: changed.id});
  expect(getRollup(fresh.rollup.id)!.activeVersionId).toBe(fresh.version.id);
  expect(getRollup(fresh.rollup.id)!.stale).toBeUndefined();
});

test("actual ordinary, overview and expanded orphan prompts use local calendar dates", async () => {
  const group: CommitGroup = {type: "orphan", label: "Synthetic boundary commit", commits: [{
    sha: "synthetic-boundary", repo: "fixture/repo", date: "2026-09-30T18:30:00Z", message: "Synthetic change",
    author: "fixture", files: ["src/boundary.ts"], stats: {additions: 1, deletions: 0, perFile: [{filename: "src/boundary.ts", additions: 1, deletions: 0}]},
    diff: "diff --git a/src/boundary.ts b/src/boundary.ts\n--- a/src/boundary.ts\n+++ b/src/boundary.ts\n@@ -0,0 +1 @@\n+export const boundary = true;\n",
  } as CommitGroup["commits"][number]]};
  for (const timezone of ["Asia/Kolkata", "UTC"] as const) {
    const day = timezone === "Asia/Kolkata" ? "2026-10-01" : "2026-09-30";
    const ordinary: string[] = [];
    await computeSummary(group, "codex-cli", `ordinary-${timezone}`, "mock", {}, timezone, async prompt => {
      ordinary.push(prompt); return "Synthetic summary";
    });
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]).toContain(`1 commits between ${day} and ${day}`);
    const large = structuredClone(group);
    large.commits[0]!.diff += "+synthetic line\n".repeat(6800);
    const prompts: string[] = [];
    await computeSummary(large, "codex-cli", `overview-${timezone}`, "mock", {}, timezone, async prompt => {
      prompts.push(prompt);
      return prompts.length === 1 ? "Synthetic overview\nEXPAND_FILES: src/boundary.ts" : "Synthetic expanded summary";
    });
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain(`Period: ${day} to ${day}`);
      expect(prompt).not.toContain(timezone === "Asia/Kolkata" ? "Period: 2026-09-30" : "Period: 2026-10-01");
    }
  }
});

test("configured IANA calendars handle DST, quarter-hour offsets and adjacent windows", () => {
  const spring = reportWindow("daily",new Date("2026-03-08T12:00:00Z"),"America/New_York");
  const autumn = reportWindow("daily",new Date("2026-11-01T12:00:00Z"),"America/New_York");
  expect((Date.parse(spring.endExclusive)-Date.parse(spring.startInclusive))/3600000).toBe(23);
  expect((Date.parse(autumn.endExclusive)-Date.parse(autumn.startInclusive))/3600000).toBe(25);
  for (const day of [spring,autumn]) {
    const next=reportWindow("daily",new Date(day.endExclusive),"America/New_York");
    expect(next.startInclusive).toBe(day.endExclusive);
    expect(inWindow(day.endExclusive,day)).toBe(false);
    expect(inWindow(day.endExclusive,next)).toBe(true);
  }
  for(const instant of ["2026-11-01T01:30:00-04:00","2026-11-01T01:30:00-05:00"])
    expect([autumn,reportWindow("daily",new Date(autumn.endExclusive),"America/New_York")].filter(w=>inWindow(instant,w))).toHaveLength(1);
  expect(reportWindow("daily",new Date("2026-09-30T18:15:00Z"),"Asia/Kathmandu")).toMatchObject({from:"2026-10-01",startInclusive:"2026-09-30T18:15:00.000Z"});
  expect(reportWindow("weekly",new Date("2027-01-01T12:00:00Z"),"America/New_York",0)).toMatchObject({from:"2026-12-27",to:"2027-01-02"});
  expect(()=>reportWindow("daily",new Date(),"Mars/Olympus")).toThrow();
  expect(()=>reportWindow("weekly",new Date(),"UTC",9)).toThrow();
});
test("arbitrary catalogs preserve context and isolate previous-job rollups",async()=>{
  const day=reportWindow("daily",new Date("2026-10-01T12:00:00Z"),"America/New_York");
  const make=(context:string)=>({schemaVersion:2, source:{instanceId:"alex-work",scopeId:context,capturedAt:"2026-10-01T12:00:00Z",coverage:"partial"},streams:[{id:"clinical-research",name:"Clinical Research"}],contexts:[{id:context,name:context==="northwind"?"Northwind Health":"Contoso Lab"}],projects:[{id:context+"-platform",name:"Platform",contextId:context,stream:"clinical-research",linkedStreams:[],planning:{outcome:"Validated study",milestones:[{id:"trial",title:"Trial review",state:"proposed",date:{kind:"estimate",value:"2026-12-01",timezone:"America/New_York"}}]}}],tasks:[{id:context+"-task",title:"Alex contribution",projectId:context+"-platform",status:"done",createdAt:"2026-10-01T09:00:00Z",evidence:[{id:context+"-evidence",milestone:"other",occurredAt:"2026-10-01",precision:"date",url:"https://example.test/"+context,actor:"Alex",caveat:"Team contribution"}]}]});
  const a=await generateTaskFinderReport(make("northwind"),day,"alex@example.test");
  const b=await generateTaskFinderReport(make("contoso"),day,"alex@example.test");
  expect(a[0]!.log.id).not.toBe(b[0]!.log.id);
  const context=a[0]!.version.chatPrompt!.snapshotContext as {projects:{planning:{outcome:string}}[]};
  expect(context.projects[0]!.planning.outcome).toBe("Validated study");
  expect(b[0]!.version.summaryMarkdown).toContain("Clinical Research");
  expect(b[0]!.version.summaryMarkdown).toContain("Contoso Lab");
  const month=reportWindow("monthly",new Date("2026-10-01T12:00:00Z"),"America/New_York");
  const roll=await generateTaskFinderRollup("alex-work",month,"alex@example.test","contoso");
  expect(roll.rollup.logIds).toEqual([b[0]!.log.id]);
  expect(roll.version.summaryMarkdown).not.toContain("Northwind");
  expect(roll.version.summaryMarkdown).not.toContain("northwind-evidence");
  expect(listVersions("log",a[0]!.log.id)).toHaveLength(1);
  expect(TaskFinderSnapshotSchema.safeParse({...make("contoso"),schemaVersion:999}).success).toBe(false);
  expect(TaskFinderSnapshotSchema.parse({...make("contoso"),schemaVersion:1,extraContext:{role:"Researcher"}}).extraContext).toEqual({role:"Researcher"});
});

test("actual Task Finder scoped API export parses and retains stable IDs and date precision",async()=>{
  const raw=await Bun.file(new URL("../fixtures/taskfinder-export-v2.json",import.meta.url)).json();
  const snapshot=TaskFinderSnapshotSchema.parse(raw);
  const results=await generateTaskFinderReport(snapshot,reportWindow("daily",new Date("2026-10-01T12:00:00Z"),"America/New_York"),"alex@example.test");
  expect(results).toHaveLength(1);
  expect(results[0]!.version.summaryMarkdown).toContain(raw.tasks[0].evidence[0].id);
  const refs=results[0]!.version.chatPrompt!.references as {taskId:string;evidence:{occurredAt:string;precision:string}[]}[];
  expect(refs[0]!.taskId).toBe(raw.tasks[0].id);
  expect(refs[0]!.evidence[0]).toMatchObject({occurredAt:"2026-10-01",precision:"date"});
  expect(JSON.stringify(results)).not.toContain("northwind");
});

test("renaming a project updates active labels without replacing identity or historical versions",async()=>{
  const day=reportWindow("daily",new Date(fixture.source.capturedAt),"Asia/Kolkata");
  const old=(await generateTaskFinderReport(fixture,day,"fixture@example.test"))[0]!;
  const changed=structuredClone(fixture);
  changed.projects.find(p=>p.id===old.log.repo)!.name="Renamed research project";
  const current=(await generateTaskFinderReport(changed,day,"fixture@example.test")).find(r=>r.log.id===old.log.id)!;
  expect(current.log.title).toBe("Renamed research project");
  expect(listVersions("log",old.log.id).find(v=>v.id===old.version.id)!.summaryMarkdown).toBe(old.version.summaryMarkdown);
  const roll=await generateTaskFinderRollup("synthetic-taskfinder",reportWindow("monthly",new Date(fixture.source.capturedAt),"Asia/Kolkata"),"fixture@example.test");
  expect(roll.version.summaryMarkdown).toContain("· Renamed research project");
  await setLogActiveVersion(old.log.id,old.version.id);
  expect(getLog(old.log.id)!.title).toBe(old.log.title);
});

test("pre-upgrade Kolkata windows and generated labels remain selectable after rename",async()=>{
  const legacyWindow={kind:"daily",timezone:"Asia/Kolkata",from:"2026-10-01",to:"2026-10-01",startInclusive:"2026-09-30T18:30:00.000Z",endExclusive:"2026-10-01T18:30:00.000Z",key:"daily:Asia/Kolkata:2026-10-01:2026-10-01"};
  const log=await createLog({id:"legacy-before-upgrade",owner:"task-finder",repo:"legacy-project",title:"Original project",authorEmail:"fixture@example.test",rangeStart:legacyWindow.from,rangeEnd:legacyWindow.to});
  const original=await appendSummaryVersion({parentKind:"log",parentId:log.id,summaryMarkdown:"# Original project\n\nHistorical evidence",source:"generated",model:"deterministic-snapshot-v1",chatPrompt:{source:"task-finder",instanceId:"old-instance",window:legacyWindow,projectId:"legacy-project",references:[]}});
  await appendSummaryVersion({parentKind:"log",parentId:log.id,summaryMarkdown:"# Renamed project\n\nNew evidence",source:"generated",model:"deterministic-snapshot-v1",chatPrompt:{source:"task-finder",instanceId:"old-instance",window:legacyWindow,projectName:"Renamed project"}});
  expect(getLog(log.id)!.title).toBe("Renamed project");
  await setLogActiveVersion(log.id,original.id);
  expect(getLog(log.id)!.title).toBe("Original project");
  const a=reportWindow("daily",new Date("2026-10-01T12:00:00Z"),"Asia/Calcutta");
  expect(a.key).toBe(legacyWindow.key);
  const roll=await generateTaskFinderRollup("old-instance",reportWindow("monthly",new Date("2026-10-01T12:00:00Z"),"Asia/Calcutta"),"fixture@example.test");
  expect(roll.rollup.logIds).toEqual([log.id]);
  expect(roll.version.summaryMarkdown).toContain("· Original project");
});
test("concrete employer snapshots reject unknown tasks and unrelated catalogs",async()=>{
  const raw=await Bun.file(new URL("../fixtures/taskfinder-export-v2.json",import.meta.url)).json();
  const unknown=structuredClone(raw); delete unknown.tasks[0].projectId;
  expect(TaskFinderSnapshotSchema.safeParse(unknown).success).toBe(false);
  const unrelated=structuredClone(raw); unrelated.contexts.push({id:"northwind",name:"Previous employer confidential label"});
  expect(TaskFinderSnapshotSchema.safeParse(unrelated).success).toBe(false);
  const legacy=structuredClone(raw); legacy.source.scopeId="unassigned";legacy.projects=[];legacy.contexts=[];delete legacy.tasks[0].projectId;
  expect(TaskFinderSnapshotSchema.safeParse(legacy).success).toBe(true);
});

test("actual Task Finder planning export preserves proposed dates, deadlines and dependencies",async()=>{
 const raw=await Bun.file(new URL("../fixtures/taskfinder-planning-export-v2.json",import.meta.url)).json();
 const snapshot=TaskFinderSnapshotSchema.parse(raw);
 const reports=await generateTaskFinderReport(snapshot,reportWindow("monthly",new Date("2026-11-01T12:00:00Z"),"America/New_York"),"alex@example.test");
 const report=reports.find(r=>r.version.summaryMarkdown.includes("A verified research outcome"))!;
 expect(report.version.summaryMarkdown).toContain("Trial review (proposed): estimate 2026-11-01 (America/New\\_York)");
 expect(report.version.summaryMarkdown).toContain("Funding submission (accepted): deadline 2026-12-01 (Asia/Kathmandu)");
 expect(report.version.summaryMarkdown).toContain("Next study (proposed): unknown; date not set");
 expect(report.version.summaryMarkdown).toContain("Dependency project");
 expect(report.version.summaryMarkdown).toContain("Prepare decision note");
 expect(reports).toHaveLength(2); // Empty dependency project is retained too.
 const persisted=report.version.chatPrompt!.snapshotContext as {projects:{planning:unknown}[]};
 expect(persisted.projects[0]!.planning).toEqual(snapshot.projects.find(p=>p.id===report.log.repo)!.planning);
});
