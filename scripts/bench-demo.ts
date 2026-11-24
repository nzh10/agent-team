// Full-stack Chromium Demo E2E + Performance Benchmark harness.
//
// Reuses BOTH:
//   1. scripts/seed-demo.ts — real git clone + worktrees + project + Lead/Worker
//      sessions + objectives/issues/notes + archived workspace + history
//   2. webview/src/dev/replayFixture.ts — Workspace UI 🎬 Replay Demo played
//      through the live client dispatch pipeline
//
// Runs against the real Server (real HostRegistry/LocalHost, real HTTP/WS, real
// built dist/webview bundle) and real headless Playwright Chromium.
//
// Usage:
//   npm run bench:demo
//   npm run bench:demo -- --json
//   npm run bench:demo -- --rebuild

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";
import { ProjectStore } from "../service/src/project/store";
import { readNote, writeNote } from "../service/src/project/notes";
import { Server } from "../service/src/server/server";
import { seedDemo, type SeedDemoResult } from "./seed-demo";

function findRepoRoot(): string {
  const start = typeof __dirname === "string" ? __dirname : process.cwd();
  let dir = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "service")) &&
      fs.existsSync(path.join(dir, "webview"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(process.cwd());
    dir = parent;
  }
}

const ROOT = findRepoRoot();
const WEB_DIR = path.join(ROOT, "dist", "webview");
const WEBVIEW_WATCH_PATHS = [
  path.join(ROOT, "webview", "src"),
  path.join(ROOT, "webview", "index.html"),
  path.join(ROOT, "webview", "vite.config.ts"),
];

export interface CdpMemorySample {
  jsHeapUsedMb: number;
  jsHeapTotalMb: number;
  domNodes: number;
  documents: number;
}

export interface ServerMemorySample {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
}

export interface ReplayBenchmarkStats {
  totalFrames: number;
  dispatchedFrames: number;
  durationMs: number;
  framesPerSec: number;
  p50CommitMs: number;
  p95CommitMs: number;
  maxCommitMs: number;
}

export interface DemoBenchmarkMetrics {
  seedMs: number;
  serverStartMs: number;
  hydrationMs: number;
  workspaceSwitchSamplesMs: number[];
  workspaceSwitchP50Ms: number;
  workspaceSwitchP95Ms: number;
  workspaceSwitchMaxMs: number;
  boardOpenMs: number;
  replay: ReplayBenchmarkStats;
  clientBeforeReplay: CdpMemorySample;
  clientAfterReplay: CdpMemorySample;
  clientHeapDeltaMb: number;
  clientDomNodesDelta: number;
  serverBeforeReplay: ServerMemorySample;
  serverAfterReplay: ServerMemorySample;
  desktopOverflowPx: number;
  mobileOverflowPx: number;
  totalDurationMs: number;
}

export interface DemoSuiteResult {
  metrics: DemoBenchmarkMetrics;
  consoleErrors: string[];
  pageErrors: string[];
  journeysVerified: string[];
  portClosed: boolean;
}

export interface DemoSuiteOptions {
  rebuildWebview?: boolean;
  switchRounds?: number;
  quiet?: boolean;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mb(bytes: number): number {
  return round(bytes / (1024 * 1024), 2);
}

function latestMtimeMs(targetPath: string): number {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const childMtime = latestMtimeMs(path.join(targetPath, entry.name));
    if (childMtime > max) max = childMtime;
  }
  return max;
}

export function ensureWebviewBuilt(force = false, quiet = false): void {
  const indexHtml = path.join(WEB_DIR, "index.html");
  let needsBuild = force || !fs.existsSync(indexHtml);
  if (!needsBuild) {
    const builtMtime = fs.statSync(indexHtml).mtimeMs;
    const srcMtime = Math.max(...WEBVIEW_WATCH_PATHS.map(latestMtimeMs));
    if (srcMtime > builtMtime) needsBuild = true;
  }
  if (!needsBuild) return;
  const out = execFileSync("npm", ["run", "build", "-w", "webview"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!quiet && out.length > 0) {
    process.stderr.write(out);
  }
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`Webview build did not produce ${indexHtml}`);
  }
}

async function sampleCdpMemory(cdp: CDPSession): Promise<CdpMemorySample> {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const { metrics } = await cdp.send("Performance.getMetrics");
  const map = new Map(metrics.map((m) => [m.name, m.value]));
  return {
    jsHeapUsedMb: mb(map.get("JSHeapUsedSize") ?? 0),
    jsHeapTotalMb: mb(map.get("JSHeapTotalSize") ?? 0),
    domNodes: Math.round(map.get("Nodes") ?? 0),
    documents: Math.round(map.get("Documents") ?? 0),
  };
}

function sampleServerMemory(): ServerMemorySample {
  const mem = process.memoryUsage();
  return {
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    heapTotalMb: mb(mem.heapTotal),
  };
}

async function measureHorizontalOverflowPx(page: Page): Promise<number> {
  return page.evaluate<number>(
    `(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth))()`,
  );
}

async function verifyPortClosed(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (closed: boolean) => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(false));
    socket.once("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED"));
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Demo E2E assertion failed: ${message}`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let activeTeardown: (() => Promise<void>) | null = null;

export async function runDemoBrowserSuite(
  options: DemoSuiteOptions = {},
): Promise<DemoSuiteResult> {
  ensureWebviewBuilt(options.rebuildWebview, options.quiet);
  const suiteStarted = performance.now();

  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yaat-demo-e2e-")));
  const prevHost = process.env.AGENT_TEAM_HOST;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const journeysVerified: string[] = [];

  let seeded: SeedDemoResult | undefined;
  let server: Server | undefined;
  let port: number | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let cdp: CDPSession | undefined;

  let seedMs = 0;
  let serverStartMs = 0;
  let hydrationMs = 0;
  const workspaceSwitchSamplesMs: number[] = [];
  let boardOpenMs = 0;
  let replayStats: ReplayBenchmarkStats | undefined;
  let clientBeforeReplay: CdpMemorySample | undefined;
  let clientAfterReplay: CdpMemorySample | undefined;
  let serverBeforeReplay: ServerMemorySample | undefined;
  let serverAfterReplay: ServerMemorySample | undefined;
  let desktopOverflowPx = 0;
  let mobileOverflowPx = 0;
  let portClosed = false;

  let teardownPromise: Promise<void> | null = null;
  const teardown = (): Promise<void> => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      if (cdp) {
        await withTimeout(cdp.detach(), 5_000).catch(() => {});
      }
      if (page) {
        await withTimeout(page.close(), 5_000).catch(() => {});
      }
      if (context) {
        await withTimeout(context.close(), 5_000).catch(() => {});
      }
      if (browser) {
        await withTimeout(browser.close(), 10_000).catch(() => {});
      }
      if (server) {
        await withTimeout(server.close(), 10_000).catch(() => {});
      }
      if (port !== undefined) {
        portClosed = await verifyPortClosed(port);
      }
      if (prevHost === undefined) delete process.env.AGENT_TEAM_HOST;
      else process.env.AGENT_TEAM_HOST = prevHost;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Ignore transient ENOTEMPTY if an OS git subprocess finishes slightly later.
      }
    })();
    return teardownPromise;
  };
  activeTeardown = teardown;

  try {
    // 1. Seed real git repo + worktrees + project + sessions + objectives + issues + notes.
    const tSeed = performance.now();
    seeded = seedDemo(tmpDir, { quiet: true, writeConfig: true });
    seedMs = round(performance.now() - tSeed);

    // 2. Start real Server on 127.0.0.1:0 serving real built dist/webview.
    const tServer = performance.now();
    process.env.AGENT_TEAM_HOST = "127.0.0.1";
    server = new Server(0, tmpDir, WEB_DIR);
    port = await server.listening;
    serverStartMs = round(performance.now() - tServer);

    // 3. Launch real headless Chromium + CDP session.
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.stack ?? err.message);
    });

    // ---- Journey 1: Initial hydration, sidebar tree, git indicators, archives, search ----
    const tHydrate = performance.now();
    await page.goto(`http://127.0.0.1:${port}/?debug=1&demoPace=raf`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator(".ws-group-project .ws-group-label", { hasText: "agent-team" }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page.locator(".task-item", { hasText: "mobile panels" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.locator(".system-status-grid").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".quota-panel").waitFor({ state: "visible", timeout: 10_000 });
    hydrationMs = round(performance.now() - tHydrate);

    // Verify seeded project workers are listed under agent-team.
    for (const name of ["mobile panels", "wake-up time", "readme"]) {
      assert(
        await page.locator(".task-item", { hasText: name }).isVisible(),
        `Sidebar should list worker "${name}"`,
      );
    }

    // Expand project-level Archived toggle ("file routes" and adopted "parser crash").
    const projectArchiveToggle = page.locator(".ws-archive-toggle");
    await projectArchiveToggle.waitFor({ state: "visible", timeout: 5_000 });
    await projectArchiveToggle.click();
    await page.locator(".task-item-archived", { hasText: "file routes" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    const archivedPast = page.locator(".task-item-archived", { hasText: "parser crash" });
    await archivedPast.waitFor({ state: "visible", timeout: 5_000 });
    await archivedPast.click();
    await page.locator(".messages", { hasText: "TemplateResolver::resolve" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });

    // Global history search across all workspaces (including archived).
    const searchInput = page.locator(".search-bar input");
    await searchInput.fill("TemplateResolver");
    const searchHit = page.locator(".search-result-item", { hasText: "parser crash" }).first();
    await searchHit.waitFor({ state: "visible", timeout: 10_000 });
    await searchHit.click();
    await page.locator(".messages", { hasText: "TemplateResolver::resolve" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    if (await page.locator(".search-clear").isVisible()) {
      await page.locator(".search-clear").click();
    }
    await page.locator(".ws-group-project").click();
    await page.locator(".messages", { hasText: "分成两件事" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    // Collapse project Archived now that active workspace is no longer archived.
    await projectArchiveToggle.click();
    await archivedPast.waitFor({ state: "hidden", timeout: 5_000 });
    journeysVerified.push("hydration-sidebar-archive-search");

    // ---- Journey 2: Workspace switching latency + message history rendering ----
    const switchTargets: Array<{ click: () => Promise<void>; marker: string }> = [
      {
        click: () => page!.locator(".task-item", { hasText: "mobile panels" }).click(),
        marker: "sheet 头部已经改好",
      },
      {
        click: () => page!.locator(".task-item", { hasText: "wake-up time" }).click(),
        marker: "noteSchedule",
      },
      {
        click: () => page!.locator(".task-item", { hasText: "readme" }).click(),
        marker: "deploy-deferred.sh",
      },
      {
        click: () => page!.locator(".ws-group-project").click(),
        marker: "分成两件事",
      },
    ];
    const switchRounds = options.switchRounds ?? 2;
    for (let r = 0; r < switchRounds; r++) {
      for (const target of switchTargets) {
        const t0 = performance.now();
        await target.click();
        await page.locator(".messages", { hasText: target.marker }).waitFor({
          state: "visible",
          timeout: 10_000,
        });
        workspaceSwitchSamplesMs.push(round(performance.now() - t0));
      }
    }

    // Verify rich message elements on lead (file link, tool calls, subagent card).
    assert(
      (await page.locator(".messages .file-ref").count()) > 0,
      "Lead workspace should render clickable file reference links",
    );
    assert(
      await page
        .locator(".messages", { hasText: "Find where the wake-up time is computed" })
        .isVisible(),
      "Lead workspace should render Explore subagent card",
    );

    // Switch to mobile panels and verify markdown table, code block, git branch/dirty bar.
    await page.locator(".task-item", { hasText: "mobile panels" }).click();
    await page.locator(".messages table").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".messages pre code").first().waitFor({ state: "visible", timeout: 5_000 });
    await page.locator(".ws-info-branch", { hasText: "ui/mobile-panels" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    // Wait for dirty count (modified styles.css + untracked NOTES.md = 2) from real GitScanner.
    await page.locator(".ws-info-branch .git-dirty").waitFor({ state: "visible", timeout: 10_000 });

    // Check wake-up time branch + ahead indicator from real GitScanner.
    await page.locator(".task-item", { hasText: "wake-up time" }).click();
    await page.locator(".ws-info-branch", { hasText: "fix/wake-time" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.locator(".ws-info-branch .git-ahead").waitFor({ state: "visible", timeout: 10_000 });
    journeysVerified.push("workspace-switch-history-git-indicators");

    // ---- Journey 3: Side panels (Files, Preview, Ask Lines, Git Changes Diff, Agents/Tasks) ----
    await page.locator(".task-item", { hasText: "mobile panels" }).click();
    await page.locator(".messages", { hasText: "sheet 头部已经改好" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });

    // Files browser + preview.
    await page.locator('nav.side-rail button[aria-label="Files"]').click();
    await page.locator(".files-panel .dir-entry", { hasText: "package.json" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.locator(".files-panel .dir-entry", { hasText: "package.json" }).click();
    await page.locator(".files-panel pre.code-text").waitFor({ state: "visible", timeout: 10_000 });

    // Ask Lines flow: select lines in pre.code-text, click Ask button, verify quote in composer.
    const selectedOk = await page.evaluate<boolean>(`(() => {
      const pre = document.querySelector(".files-panel pre.code-text");
      if (!pre) return false;
      const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let n;
      while ((n = walk.nextNode())) {
        if (n.textContent && n.textContent.length > 0) nodes.push(n);
      }
      if (nodes.length < 3) return false;
      const range = document.createRange();
      range.setStart(nodes[1], 0);
      const endNode = nodes[Math.min(nodes.length - 1, 6)];
      range.setEnd(endNode, endNode.textContent.length);
      const sel = window.getSelection();
      if (!sel) return false;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return true;
    })()`);
    assert(selectedOk, "Failed to select lines inside FilesPanel code view");
    const askBtn = page.locator(".files-panel button.fp-ask");
    await askBtn.waitFor({ state: "visible", timeout: 5_000 });
    await askBtn.click();
    const composerValue = await page.locator("textarea").first().inputValue();
    assert(
      composerValue.includes("package.json:") && composerValue.includes("```json"),
      `Expected composer to contain Ask Lines quote, got: ${composerValue.slice(0, 120)}`,
    );

    // Git Changes panel + diff view for mobile panels worktree.
    await page.locator('nav.side-rail button[aria-label="Changes"]').click();
    await page.locator(".files-panel", { hasText: "styles.css" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.locator(".files-panel", { hasText: "NOTES.md" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.locator(".files-panel .change-entry", { hasText: "styles.css" }).click();
    await page
      .locator(".files-panel", { hasText: "sheet header: 44px touch targets" })
      .waitFor({ state: "visible", timeout: 10_000 });

    // Agents panel from Lead (project overview: sessions, models, effort, context, quota/system).
    await page.locator(".ws-group-project").click();
    await page.locator('nav.side-rail button[aria-label="Agents and sessions"]').click();
    await page.locator(".agents-panel").waitFor({ state: "visible", timeout: 10_000 });
    const mobileCard = page.locator('.agents-panel [aria-label="mobile panels"]');
    await mobileCard.waitFor({ state: "visible", timeout: 5_000 });
    await mobileCard.locator('button[aria-label="Unfold mobile panels"]').click();
    await mobileCard.locator('select[aria-label$="model"]').waitFor({
      state: "visible",
      timeout: 5_000,
    });
    // Close side panel before opening Board.
    await page.locator('aside.side-panel button[aria-label^="Close"]').click();
    await page.locator("aside.side-panel").waitFor({ state: "hidden", timeout: 5_000 });
    journeysVerified.push("side-panels-files-diff-asklines-agents");

    // ---- Journey 4: Board view (Objectives graph, detail drawer, Issues, Notes read/edit) ----
    const tBoard = performance.now();
    await page.locator('nav.side-rail button[aria-label="Objectives of agent-team"]').click();
    await page.locator(".board-page").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".board-page", { hasText: "Panels on phones" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    boardOpenMs = round(performance.now() - tBoard);

    // Switch to Dependencies graph view.
    await page
      .locator('.board-page [aria-label="View"] button', { hasText: "Dependencies" })
      .click();
    await page.locator(".board-page svg").first().waitFor({ state: "visible", timeout: 5_000 });
    assert(
      await page.locator(".board-page", { hasText: "Preview deploys per branch" }).isVisible(),
      "Dependency graph should display dependent objective",
    );

    // Switch back to List and open objective detail drawer.
    await page.locator('.board-page [aria-label="View"] button', { hasText: "List" }).click();
    await page.locator(".board-page .bp-card", { hasText: "Panels on phones" }).click();
    await page.locator(".board-page .bp-detail").waitFor({ state: "visible", timeout: 5_000 });
    assert(
      await page
        .locator(".board-page .bp-detail", { hasText: "44px touch targets in the sheet header" })
        .isVisible(),
      "Objective detail drawer should show seeded tasks",
    );
    assert(
      await page
        .locator(".board-page .bp-detail", { hasText: "Swipe down to close the sheet?" })
        .isVisible(),
      "Objective detail drawer should show seeded open decisions",
    );
    await page.locator('.board-page .bp-detail button[aria-label="Close details"]').click();

    // Issues tab: list, filter by state, open issue detail drawer.
    await page.locator(".board-page .bp-modes button", { hasText: "Issues" }).click();
    await page.locator(".board-page .bi-row", { hasText: "04-12#1" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await page.locator(".board-page .bi-row", { hasText: "04-12#2" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await page.locator('.board-page [aria-label="State"] button', { hasText: "Open" }).click();
    await page.locator(".board-page .bi-row", { hasText: "04-12#1" }).waitFor({
      state: "hidden",
      timeout: 5_000,
    });
    await page.locator('.board-page [aria-label="State"] button', { hasText: "Open" }).click();
    await page.locator(".board-page .bi-row", { hasText: "04-12#1" }).click();
    await page.locator('.board-page aside[aria-label="Issue 04-12#1"]').waitFor({
      state: "visible",
      timeout: 5_000,
    });

    // Notes tab: read seeded note + verify live update via ProjectNotesStore / writeNote.
    await page.locator(".board-page .bp-modes button", { hasText: "Notes" }).click();
    await page.locator('.board-page [role="treeitem"]', { hasText: "architecture.md" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await page.locator('.board-page [role="treeitem"]', { hasText: "architecture.md" }).click();
    await page.locator(".board-page .bn-preview", { hasText: "Architecture Notes" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });

    // Perform a real versioned writeNote edit on disk and verify the Board Notes preview reads it.
    const notesDir = new ProjectStore(tmpDir).notesDir(seeded.projectId);
    const currentSpec = readNote(notesDir, "mobile-spec");
    const editedMarker = "Verified live note update in Demo E2E.";
    writeNote(
      notesDir,
      "mobile-spec",
      `${currentSpec.content.trimEnd()}\n\n- ${editedMarker}\n`,
      currentSpec.version,
    );
    await page.locator('.board-page [role="treeitem"]', { hasText: "mobile-spec.md" }).click();
    await page.locator(".board-page .bn-preview", { hasText: editedMarker }).waitFor({
      state: "visible",
      timeout: 5_000,
    });

    // Close Board.
    await page.locator('.board-page header button[aria-label="Close"]').click();
    await page.locator(".board-page").waitFor({ state: "hidden", timeout: 5_000 });
    journeysVerified.push("board-objectives-graph-issues-notes");

    // ---- Journey 5: Workspace 🎬 Replay Demo — Desktop (1280x800) & Mobile (390x844) ----
    clientBeforeReplay = await sampleCdpMemory(cdp);
    serverBeforeReplay = sampleServerMemory();

    await page.locator('button[title*="Replay rendering demo"]').click();

    // Select the newly created "🎬 Replay Demo" workspace in the sidebar so the
    // streaming replay renders live in the active viewport.
    const demoWsItem = page.locator(".task-item", { hasText: "Replay Demo" });
    await demoWsItem.waitFor({ state: "visible", timeout: 10_000 });
    await demoWsItem.click();

    // Wait for all replay frames to finish streaming through the live client pipeline.
    await page.waitForFunction(
      `Boolean(window.__yaatDemoReplay && window.__yaatDemoReplay.done === true)`,
      undefined,
      { timeout: 30_000 },
    );

    const rawReplay = await page.evaluate<ReplayBenchmarkStats | null>(
      `(() => {
        const s = window.__yaatDemoReplay;
        if (!s) return null;
        return {
          totalFrames: s.totalFrames,
          dispatchedFrames: s.dispatchedFrames,
          durationMs: s.durationMs,
          framesPerSec: s.framesPerSec,
          p50CommitMs: s.p50CommitMs,
          p95CommitMs: s.p95CommitMs,
          maxCommitMs: s.maxCommitMs,
        };
      })()`,
    );
    assert(
      rawReplay && rawReplay.dispatchedFrames === rawReplay.totalFrames,
      "Replay did not finish all frames",
    );
    replayStats = {
      totalFrames: rawReplay.totalFrames,
      dispatchedFrames: rawReplay.dispatchedFrames,
      durationMs: round(rawReplay.durationMs),
      framesPerSec: round(rawReplay.framesPerSec, 1),
      p50CommitMs: round(rawReplay.p50CommitMs),
      p95CommitMs: round(rawReplay.p95CommitMs),
      maxCommitMs: round(rawReplay.maxCommitMs),
    };

    // Verify standalone Archived section from replayFixture ("old-experiment") expands and collapses.
    const standaloneArchive = page.locator(".ws-archived .ws-archived-header");
    await standaloneArchive.waitFor({ state: "visible", timeout: 5_000 });
    await standaloneArchive.click();
    await page
      .locator(".ws-archived .task-item-archived", { hasText: "old-experiment" })
      .waitFor({ state: "visible", timeout: 5_000 });
    await standaloneArchive.click();
    await page
      .locator(".ws-archived .task-item-archived", { hasText: "old-experiment" })
      .waitFor({ state: "hidden", timeout: 5_000 });

    // Assert key rendered elements from replayFixture.
    await page.locator(".messages", { hasText: "Markdown torture test" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await page.locator(".messages", { hasText: "多智能体编排面板" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await page
      .locator(".messages", { hasText: "session expired — message ends in the error state" })
      .waitFor({ state: "visible", timeout: 5_000 });
    await page
      .locator(".messages", {
        hasText: "The fixtures cover the waiting, thinking, and tool phases.",
      })
      .waitFor({ state: "visible", timeout: 5_000 });

    // Exercise subagent Cancel on the still-running "Watch CI for regressions" subagent.
    const cancelBtn = page.locator('button[title="Cancel this subagent"]');
    await cancelBtn.waitFor({ state: "visible", timeout: 5_000 });
    await cancelBtn.click();
    await cancelBtn.waitFor({ state: "hidden", timeout: 5_000 });
    await page.locator(".messages", { hasText: "Watch CI for regressions" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });

    // Check desktop horizontal overflow & capture post-replay metrics.
    desktopOverflowPx = await measureHorizontalOverflowPx(page);
    clientAfterReplay = await sampleCdpMemory(cdp);
    serverAfterReplay = sampleServerMemory();

    // Mobile viewport check (390x844): Replay Demo + mobile sidebar drawer + seeded worker.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("button.mobile-menu-btn").waitFor({ state: "visible", timeout: 5_000 });
    const replayMobileOverflow = await measureHorizontalOverflowPx(page);
    await page.locator("button.mobile-menu-btn").click();
    await page.locator(".sidebar-title", { hasText: "Workspaces" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await page.locator(".task-item", { hasText: "mobile panels" }).click();
    await page.locator(".messages", { hasText: "sheet 头部已经改好" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const workerMobileOverflow = await measureHorizontalOverflowPx(page);
    mobileOverflowPx = Math.max(replayMobileOverflow, workerMobileOverflow);
    journeysVerified.push("replay-demo-cancel-desktop-and-mobile");
  } finally {
    await teardown();
    if (activeTeardown === teardown) activeTeardown = null;
  }

  const metrics: DemoBenchmarkMetrics = {
    seedMs,
    serverStartMs,
    hydrationMs,
    workspaceSwitchSamplesMs,
    workspaceSwitchP50Ms: round(percentile(workspaceSwitchSamplesMs, 50)),
    workspaceSwitchP95Ms: round(percentile(workspaceSwitchSamplesMs, 95)),
    workspaceSwitchMaxMs: round(Math.max(0, ...workspaceSwitchSamplesMs)),
    boardOpenMs,
    replay: replayStats,
    clientBeforeReplay,
    clientAfterReplay,
    clientHeapDeltaMb: round(clientAfterReplay.jsHeapUsedMb - clientBeforeReplay.jsHeapUsedMb),
    clientDomNodesDelta: clientAfterReplay.domNodes - clientBeforeReplay.domNodes,
    serverBeforeReplay,
    serverAfterReplay,
    desktopOverflowPx,
    mobileOverflowPx,
    totalDurationMs: round(performance.now() - suiteStarted),
  };

  return {
    metrics,
    consoleErrors,
    pageErrors,
    journeysVerified,
    portClosed,
  };
}

export function formatBenchmarkTable(result: DemoSuiteResult): string {
  const m = result.metrics;
  const rows: Array<[string, string]> = [
    ["Demo seed (git clone + worktrees + board)", `${m.seedMs.toFixed(1)} ms`],
    ["Server boot (real Server + HostRegistry)", `${m.serverStartMs.toFixed(1)} ms`],
    ["Initial hydration / ready latency", `${m.hydrationMs.toFixed(1)} ms`],
    [
      `Workspace switch p50 / p95 / max (n=${m.workspaceSwitchSamplesMs.length})`,
      `${m.workspaceSwitchP50Ms.toFixed(1)} / ${m.workspaceSwitchP95Ms.toFixed(1)} / ${m.workspaceSwitchMaxMs.toFixed(1)} ms`,
    ],
    ["Board view open latency", `${m.boardOpenMs.toFixed(1)} ms`],
    [
      `Replay Demo throughput (${m.replay.dispatchedFrames} frames)`,
      `${m.replay.framesPerSec.toFixed(1)} frames/s (${m.replay.durationMs.toFixed(1)} ms)`,
    ],
    [
      "Replay Demo frame commit p50 / p95 / max",
      `${m.replay.p50CommitMs.toFixed(1)} / ${m.replay.p95CommitMs.toFixed(1)} / ${m.replay.maxCommitMs.toFixed(1)} ms`,
    ],
    [
      "Client JS Heap used (before -> after)",
      `${m.clientBeforeReplay.jsHeapUsedMb.toFixed(2)} -> ${m.clientAfterReplay.jsHeapUsedMb.toFixed(2)} MB (Δ ${m.clientHeapDeltaMb >= 0 ? "+" : ""}${m.clientHeapDeltaMb.toFixed(2)} MB)`,
    ],
    [
      "Client DOM nodes (before -> after)",
      `${m.clientBeforeReplay.domNodes} -> ${m.clientAfterReplay.domNodes} (Δ ${m.clientDomNodesDelta >= 0 ? "+" : ""}${m.clientDomNodesDelta})`,
    ],
    [
      "Server RSS / Heap (active demo)",
      `${m.serverAfterReplay.rssMb.toFixed(2)} MB RSS / ${m.serverAfterReplay.heapUsedMb.toFixed(2)} MB Heap`,
    ],
    [
      "Viewport overflow (1280x800 / 390x844)",
      `${m.desktopOverflowPx}px / ${m.mobileOverflowPx}px`,
    ],
    [
      "Console errors / Page errors",
      `${result.consoleErrors.length} / ${result.pageErrors.length}`,
    ],
    ["Total end-to-end suite duration", `${(m.totalDurationMs / 1000).toFixed(2)} s`],
  ];
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  const valueWidth = Math.max(...rows.map(([, v]) => v.length));
  const sep = `+-${"-".repeat(labelWidth)}-+-${"-".repeat(valueWidth)}-+`;
  const lines = [
    sep,
    `| ${"YAAT Demo E2E + Performance Benchmark".padEnd(labelWidth)} | ${"Measured".padEnd(valueWidth)} |`,
    sep,
    ...rows.map(([k, v]) => `| ${k.padEnd(labelWidth)} | ${v.padEnd(valueWidth)} |`),
    sep,
  ];
  return lines.join("\n");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = path.join(ROOT, "scripts", "bench-demo.ts");
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === path.resolve(self);
  }
}

if (isMainModule()) {
  const jsonOnly = process.argv.includes("--json");
  const rebuildWebview = process.argv.includes("--rebuild");
  const rawLog = console.log.bind(console);
  if (jsonOnly) {
    console.log = (...args: unknown[]) => console.error(...args);
  }
  let exiting = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (exiting) return;
    exiting = true;
    const code = sig === "SIGINT" ? 130 : 143;
    const finish = () => process.exit(code);
    if (activeTeardown) {
      void activeTeardown().finally(finish);
    } else {
      finish();
    }
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  runDemoBrowserSuite({ rebuildWebview, quiet: jsonOnly })
    .then((result) => {
      if (jsonOnly) {
        rawLog(JSON.stringify(result, null, 2));
      } else {
        rawLog(formatBenchmarkTable(result));
        rawLog("\nJSON summary:");
        rawLog(JSON.stringify(result.metrics));
      }
      if (result.consoleErrors.length > 0 || result.pageErrors.length > 0 || !result.portClosed) {
        console.error("Demo benchmark finished with errors:", {
          consoleErrors: result.consoleErrors,
          pageErrors: result.pageErrors,
          portClosed: result.portClosed,
        });
        process.exit(1);
      }
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
