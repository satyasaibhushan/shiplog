import { beforeAll, beforeEach, afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { ReportStore, type Database } from "../../src/hosted/store";
import { prepareReport } from "../../src/hosted/report";
import { permitsGoogle, authenticatedOwner, permitsOrigin } from "../../src/hosted/access";
import { reportsRequest } from "../../src/hosted/http";
import snapshot from "../fixtures/taskfinder-planning-export-v2.json";
const owner = "alex@example.test",
  origin = "https://shiplog.example.test";
let pg: PGlite;
let db: Database;
let store: ReportStore;
const migration = readFileSync(
  new URL("../../hosted/migrations/001-private-reports.sql", import.meta.url),
  "utf8",
);
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(migration);
  db = {
    query: async (q) => (await pg.query<Record<string, unknown>>(q.sql, q.params)).rows,
    transaction: async (qs) =>
      pg.transaction(async (tx) => {
        const results = [];
        for (const q of qs)
          results.push((await tx.query<Record<string, unknown>>(q.sql, q.params)).rows);
        return results;
      }),
  };
  store = new ReportStore(db);
});
beforeEach(async () => {
  await pg.exec("TRUNCATE shiplog_hosted_versions,shiplog_hosted_reports");
});
afterAll(async () => {
  await pg.close();
});
const input = () => ({
  snapshot: structuredClone(snapshot),
  kind: "daily",
  date: "2026-11-01",
  timezone: "America/New_York",
  expectedRevision: 0,
});
const request = (body: unknown, site = origin) =>
  new Request(origin + "/api/reports", {
    method: "POST",
    headers: { origin: site, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("owner authentication fails closed and requires Google's verified email", () => {
  expect(permitsGoogle({ email: owner, email_verified: true }, owner)).toBe(true);
  expect(permitsGoogle({ email: owner, email_verified: false }, owner)).toBe(false);
  expect(permitsGoogle({ email: owner }, owner)).toBe(false);
  expect(permitsGoogle({ email: "other@example.test", email_verified: true }, owner)).toBe(false);
  expect(permitsGoogle({ email: owner, email_verified: true }, undefined)).toBe(false);
  expect(authenticatedOwner(owner.toUpperCase(), owner)).toBe(owner);
  expect(authenticatedOwner("other@example.test", owner)).toBeUndefined();
  expect(permitsOrigin(request({}), origin)).toBe(true);
  expect(permitsOrigin(request({}, "https://evil.example"), origin)).toBe(false);
});

test("real Postgres CAS: concurrent writers, idempotent retry, history and cold-start reads", async () => {
  const original = prepareReport(input(), owner);
  const duplicate = await Promise.all([
    store.save(owner, original),
    new ReportStore(db).save(owner, original),
  ]);
  expect(duplicate.map((r) => r.revision)).toEqual([1, 1]);
  const first = input();
  first.snapshot.projects[0]!.name = "First correction";
  const second = input();
  second.snapshot.projects[0]!.name = "Second correction";
  const results = await Promise.allSettled([
    store.save(
      owner,
      prepareReport({ ...first, expectedRevision: 1, reviewedReportId: original.id }, owner),
    ),
    new ReportStore(db).save(
      owner,
      prepareReport({ ...second, expectedRevision: 1, reviewedReportId: original.id }, owner),
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const latest = (await new ReportStore(db).read(owner, original.id))[0]!;
  expect(latest.active_revision).toBe(2);
  expect(latest.versions).toHaveLength(2);
  expect((await store.read(owner, original.id, 1))[0]!.payload).toEqual(original.payload);
  await expect(store.save(owner, original)).rejects.toThrow("Report changed");
  expect(await store.read("another@example.test", original.id)).toHaveLength(0);
  expect(await store.list("another@example.test")).toHaveLength(0);
  await pg.exec(migration);
  expect((await store.read(owner, original.id))[0]!.revision).toBe(2);
});

test("snapshot periods respect DST and isolate owner/context identities", () => {
  const fall = prepareReport(input(), owner);
  const window = fall.payload.window;
  expect((Date.parse(window.endExclusive) - Date.parse(window.startInclusive)) / 3600000).toBe(25);
  const spring = prepareReport({ ...input(), date: "2026-03-08" }, owner).payload.window;
  expect((Date.parse(spring.endExclusive) - Date.parse(spring.startInclusive)) / 3600000).toBe(23);
  expect(prepareReport(input(), "another@example.test").id).not.toBe(fall.id);
  const other = input();
  other.snapshot.source.instanceId = "other-instance";
  expect(prepareReport(other, owner).id).not.toBe(fall.id);
  expect(() => prepareReport({ ...input(), timezone: "+05:30" }, owner)).toThrow();
  expect(() => prepareReport({ ...input(), date: "2026-02-30" }, owner)).toThrow();
});

test("HTTP auth/origin boundaries, real durable save, lost-response retry and edited conflict", async () => {
  let touched = false;
  const unavailable = () => {
    touched = true;
    throw Error("Private database details");
  };
  expect((await reportsRequest(request(input()), undefined, unavailable, origin)).status).toBe(401);
  expect(
    (await reportsRequest(request(input(), "https://evil.example"), owner, unavailable, origin))
      .status,
  ).toBe(403);
  expect(touched).toBe(false);
  const save = () => reportsRequest(request(input()), owner, () => store, origin);
  const first = await save();
  expect(first.status).toBe(200);
  const saved = await first.json();
  expect((await save()).status).toBe(200);
  const edited = input();
  edited.snapshot.projects[0]!.name = "Retained correction";
  const conflict = await reportsRequest(request(edited), owner, () => store, origin);
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).id).toBe(saved.id);
  const read = await reportsRequest(
    new Request(origin + "/api/reports/" + saved.id),
    owner,
    () => new ReportStore(db),
    origin,
    saved.id,
  );
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toContain("no-store");
  const denied = await reportsRequest(
    new Request(origin + "/api/reports/" + saved.id),
    "other@example.test",
    () => store,
    origin,
    saved.id,
  );
  expect(denied.status).toBe(404);
  const failure = await reportsRequest(
    new Request(origin + "/api/reports"),
    owner,
    unavailable,
    origin,
  );
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("Private database details");
  expect(
    (await reportsRequest(request({ huge: "x".repeat(1024 * 1024) }), owner, () => store, origin))
      .status,
  ).toBe(400);
});

test("database failure rolls back report placeholder and version together", async () => {
  const broken: Database = {
    ...db,
    transaction: (qs) => db.transaction([...qs, { sql: "SELECT missing_column", params: [] }]),
  };
  await expect(
    new ReportStore(broken).save(owner, prepareReport(input(), owner)),
  ).rejects.toThrow();
  expect(await store.list(owner)).toHaveLength(0);
  expect((await pg.query("SELECT * FROM shiplog_hosted_reports")).rows).toHaveLength(0);
});

test("review acknowledgement cannot authorize a different calendar report", () => {
  const a = prepareReport(input(), owner);
  expect(() =>
    prepareReport(
      { ...input(), date: "2026-11-02", expectedRevision: 1, reviewedReportId: a.id },
      owner,
    ),
  ).toThrow("exact report target");
  expect(() => prepareReport({ ...input(), expectedRevision: 1 }, owner)).toThrow(
    "exact report target",
  );
  expect(prepareReport({ ...input(), expectedRevision: 1, reviewedReportId: a.id }, owner).id).toBe(
    a.id,
  );
});
