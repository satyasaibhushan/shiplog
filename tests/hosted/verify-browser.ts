import { chromium } from "playwright";
import { build } from "esbuild";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { ReportStore, type Database } from "../../src/hosted/store";
import { reportsRequest } from "../../src/hosted/http";
import fixture from "../fixtures/taskfinder-planning-export-v2.json";
const output = resolve(process.env.EVIDENCE_DIR ?? "/tmp/shiplog-hosted-ui");
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "shiplog-hosted-browser-"));
await build({
  entryPoints: [resolve("tests/hosted/ui/fixture.tsx")],
  bundle: true,
  jsx: "automatic",
  outdir: scratch,
  define: { "process.env.NODE_ENV": '"production"' },
});
const pg = new PGlite();
await pg.exec(readFileSync("hosted/migrations/001-private-reports.sql", "utf8"));
const db: Database = {
  query: async (q) => (await pg.query<Record<string, unknown>>(q.sql, q.params)).rows,
  transaction: async (qs) =>
    pg.transaction(async (tx) => {
      const results = [];
      for (const q of qs)
        results.push((await tx.query<Record<string, unknown>>(q.sql, q.params)).rows);
      return results;
    }),
};
const store = new ReportStore(db);
let authorized = false;
let lose = false;
let origin = "";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/api/reports")) {
      const response = await reportsRequest(
        req,
        authorized ? "alex@example.test" : undefined,
        () => store,
        origin,
        path.split("/")[3],
      );
      if (lose && req.method === "POST" && response.ok) {
        lose = false;
        return Response.json({ error: "Synthetic lost response" }, { status: 503 });
      }
      return response;
    }
    if (path === "/fixture.js") return new Response(Bun.file(join(scratch, "fixture.js")));
    if (path === "/fixture.css") return new Response(Bun.file(join(scratch, "fixture.css")));
    return new Response(
      '<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      { headers: { "content-type": "text/html" } },
    );
  },
});
origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  assert.equal((await page.request.get(origin + "/api/reports")).status(), 401);
  authorized = true;
  await page.goto(origin);
  await page
    .getByText("No reports saved. Import a reviewed snapshot to begin.", { exact: true })
    .waitFor();
  await page.getByText("Import a reviewed snapshot", { exact: true }).click();
  const upload = async (value: unknown) =>
    page
      .getByLabel("Snapshot JSON", { exact: true })
      .setInputFiles({
        name: "reviewed.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(value)),
      });
  await upload(fixture);
  lose = true;
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Synthetic lost response" }).waitFor();
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await page.getByRole("region", { name: "Report detail", exact: true }).waitFor();
  assert.equal((await store.list("alex@example.test"))[0]!.revision, 1);
  const changed = structuredClone(fixture);
  changed.projects[0]!.name = "Research programme revised";
  changed.projects[0]!.displayName = "Research programme revised · Example employer";
  await upload(changed);
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Report changed" }).waitFor();
  await page.getByRole("button", { name: "Review current report", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>('section[aria-label="Report detail"] select')
        ?.value === "2",
  );
  await page.getByLabel("Saved version", { exact: true }).selectOption("1");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>('section[aria-label="Report detail"] select')
        ?.value === "1",
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "Research programme revised · Example employer", exact: true })
      .count(),
    0,
  );
  await page.getByLabel("Period", { exact: true }).selectOption("weekly");
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".reports li").length === 2);
  await page.getByLabel("Period", { exact: true }).selectOption("monthly");
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".reports li").length === 3);
  await page.getByText("Import a reviewed snapshot", { exact: true }).click();
  await page.screenshot({ path: join(output, "reports-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "reports-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      verified: true,
      output,
      flows: [
        "unauthorized denied",
        "actual Dashboard with real PostgreSQL-backed HTTP handlers and synthetic owner session",
        "lost response identical retry",
        "edited retry conflict preserved and explicit revision acceptance",
        "immutable old version",
        "daily weekly monthly",
        "mobile overflow",
      ],
      errors,
    }),
  );
} finally {
  await browser.close();
  server.stop();
  await pg.close();
}
