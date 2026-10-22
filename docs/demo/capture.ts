// Records the README demo from the real shiplog web UI.
//
//   bun run build:all && bun docs/demo/capture.ts
//
// Seeds a scratch workspace with fictional data (seed.ts), starts the real
// server with stand-ins for `gh` and ModelBridge (bin/gh, modelbridge-stub.ts)
// so no real account data can appear, then drives Chromium through the app and
// writes docs/demo/poster.png and docs/demo/demo.webm.
//
// Encoding needs an ffmpeg with libvpx-vp9. Set FFMPEG, or it falls back to
// `ffmpeg` on PATH and then Playwright's bundled build. The README GIF
// (docs/demo/demo.gif) needs a full ffmpeg build with the palettegen filter;
// Playwright's build lacks it, so the GIF is skipped there.

import { chromium, type CDPSession, type Page } from "playwright";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = join(ROOT, "docs/demo");
const WIDTH = 1440;
const HEIGHT = 900;
const FPS = 25;
const PORT = 3947;
const BRIDGE_PORT = 4142;
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(join(ROOT, "dist/web/main.js"))) {
  console.error("capture: run `bun run build:all` first");
  process.exit(1);
}

function findFfmpeg(): string {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  if (Bun.which("ffmpeg")) return "ffmpeg";
  const cache = join(homedir(), ".cache/ms-playwright");
  const dir = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("ffmpeg-")).sort().pop() : undefined;
  if (dir) return join(cache, dir, "ffmpeg-linux");
  throw new Error("capture: no ffmpeg found; set FFMPEG");
}

// ── Scratch workspace + processes ──────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "shiplog-demo-"));
const env = {
  ...process.env,
  HOME: join(scratch, "home"),
  PATH: `${join(OUT, "bin")}:${process.env.PATH}`,
  SHIPLOG_CONFIG_DIR: join(scratch, "config"),
  SHIPLOG_DATA_DIR: join(scratch, "data"),
  MODELBRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
  MODELBRIDGE_STUB_PORT: String(BRIDGE_PORT),
  GIT_CONFIG_NOSYSTEM: "1",
};
mkdirSync(env.HOME, { recursive: true });
// The repos route reads the local git email; keep it fictional too.
writeFileSync(join(env.HOME, ".gitconfig"), "[user]\n\temail = rowan@acme.test\n\tname = Rowan Hale\n");

const seed = Bun.spawnSync(["bun", join(OUT, "seed.ts")], { env, stdout: "inherit", stderr: "inherit" });
if (seed.exitCode !== 0) throw new Error("capture: seed failed");

const bridge = Bun.spawn(["bun", join(OUT, "modelbridge-stub.ts")], { env, stdout: "ignore", stderr: "inherit" });
// cwd outside the repo so `git config user.email` cannot pick up repo-local config.
const server = Bun.spawn(["bun", join(ROOT, "src/cli/index.ts"), "--no-browser", "--port", String(PORT)], {
  env,
  cwd: scratch,
  stdout: "ignore",
  stderr: "inherit",
});
function cleanup(): void {
  server.kill();
  bridge.kill();
  rmSync(scratch, { recursive: true, force: true });
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok && ((await res.json()) as { ready: boolean }).ready) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }
  throw new Error("capture: server never reported ready");
}

// ── Frame recording ────────────────────────────────────────────────────────

interface Frame {
  at: number;
  jpeg: Buffer;
}

async function startScreencast(cdp: CDPSession, frames: Frame[]): Promise<void> {
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    frames.push({ at: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, jpeg: Buffer.from(f.data, "base64") });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
}

// Screencast frames arrive only when the page changes; resample them onto a
// constant frame rate so the video keeps real timing.
async function encode(frames: Frame[], start: number, end: number, out: string): Promise<void> {
  const ffmpeg = Bun.spawn(
    [
      findFfmpeg(), "-y", "-loglevel", "error",
      "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "-",
      "-vf", `scale=${WIDTH}:${HEIGHT}`, "-pix_fmt", "yuv420p",
      "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-threads", "8",
      "-an", out,
    ],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  );
  let i = 0;
  for (let t = start; t < end; t += 1000 / FPS) {
    while (i + 1 < frames.length && frames[i + 1]!.at <= t) i++;
    ffmpeg.stdin.write(frames[i]!.jpeg);
  }
  await ffmpeg.stdin.end();
  if ((await ffmpeg.exited) !== 0) throw new Error("capture: ffmpeg failed");
}

async function makeGif(webm: string, gif: string): Promise<void> {
  const ffmpeg = findFfmpeg();
  const filters = Bun.spawnSync([ffmpeg, "-hide_banner", "-filters"]).stdout.toString();
  if (!filters.includes("palettegen")) {
    console.warn("capture: ffmpeg has no palettegen filter; skipped demo.gif");
    return;
  }
  const run = Bun.spawnSync([
    ffmpeg, "-y", "-loglevel", "error", "-i", webm,
    "-vf", "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    gif,
  ], { stderr: "inherit" });
  if (run.exitCode !== 0) throw new Error("capture: gif encode failed");
}

// ── Storyboard ─────────────────────────────────────────────────────────────

// A visible pointer so viewers can follow the clicks. Capture-only overlay,
// injected by the recorder, not part of the app.
const CURSOR_SCRIPT = `
addEventListener("DOMContentLoaded", () => {
  const dot = document.createElement("div");
  dot.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(0,0,0,.55);pointer-events:none;z-index:2147483647;transition:transform .12s;transform:translate(-40px,-40px)";
  document.body.appendChild(dot);
  let x = -40, y = -40;
  addEventListener("mousemove", (e) => { x = e.clientX; y = e.clientY; dot.style.transform = "translate(" + x + "px," + y + "px)"; }, true);
  addEventListener("mousedown", () => { dot.style.transform = "translate(" + x + "px," + y + "px) scale(.7)"; }, true);
  addEventListener("mouseup", () => { dot.style.transform = "translate(" + x + "px," + y + "px)"; }, true);
});`;

async function glide(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("capture: target not visible");
  await page.mouse.move(box.x + Math.min(box.width / 2, 160), box.y + box.height / 2, { steps: 10 });
  await page.waitForTimeout(120);
}

async function click(page: Page, target: ReturnType<Page["locator"]>, settle = 1200): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await glide(page, target);
  await target.click();
  await page.waitForTimeout(settle);
}

async function scroll(page: Page, dy: number, ms: number): Promise<void> {
  const steps = Math.max(1, Math.round(ms / 40));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps);
    await page.waitForTimeout(40);
  }
}

const LOG_HEADLINE = "Atlas users can save dashboard views";

async function openAtlasLog(page: Page): Promise<void> {
  await page.goto(BASE);
  await page.getByText(LOG_HEADLINE).first().click();
  await page.getByText("4 PR groups", { exact: false }).waitFor();
  await page.waitForTimeout(600);
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await waitReady();
  browser = await chromium.launch();

  // Poster: the log view at 2x for a readable still.
  const still = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
  await openAtlasLog(still);
  await still.mouse.move(-10, -10);
  await still.screenshot({ path: join(OUT, "poster.png") });
  await still.close();

  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.addInitScript(CURSOR_SCRIPT);
  await openAtlasLog(page);
  await page.mouse.move(WIDTH - 260, 140);

  const frames: Frame[] = [];
  const cdp = await page.context().newCDPSession(page);
  await startScreencast(cdp, frames);
  await page.waitForTimeout(300);
  const start = Date.now();
  await page.waitForTimeout(1800);

  // Log: read the summary, then open the PR behind it.
  await scroll(page, 520, 900);
  await page.waitForTimeout(400);
  await click(page, page.getByText("Add saved dashboard views", { exact: true }).first(), 1300);

  // Home: every repo with its compiled logs.
  await click(page, page.locator("text=shiplog").first(), 1500);

  // Rollups: one narrative across repos.
  await click(page, page.getByText("Rollups", { exact: false }).first(), 600);
  await click(page, page.getByText("Usage billing, faster dashboards").first(), 2000);

  // New log: pick a range and repos.
  await page.keyboard.press("n");
  await page.waitForTimeout(600);
  await click(page, page.getByRole("button", { name: "Last 30d" }), 350);
  await click(page, page.getByText("acme/atlas", { exact: true }).last(), 250);
  await click(page, page.getByText("acme/billing-api", { exact: true }).last(), 900);
  await click(page, page.getByText("×", { exact: true }).first(), 400);

  // Back to the starting frame so the loop is seamless.
  await click(page, page.locator("text=shiplog").first(), 600);
  await click(page, page.getByText("Repos", { exact: false }).first(), 500);
  await click(page, page.getByText(LOG_HEADLINE).first(), 400);
  await page.mouse.move(WIDTH - 260, 140, { steps: 8 });
  await page.waitForTimeout(1400);
  const end = Date.now();

  await cdp.send("Page.stopScreencast");
  await browser.close();

  // Screencast timestamps use the same wall clock as Date.now().
  await encode(frames, start, end, join(OUT, "demo.webm"));
  await makeGif(join(OUT, "demo.webm"), join(OUT, "demo.gif"));
  console.log(`capture: ${frames.length} frames, ${((end - start) / 1000).toFixed(1)}s -> docs/demo/demo.webm, docs/demo/poster.png`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  cleanup();
}
