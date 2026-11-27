// Exercise the seeded Demo and the client Replay Demo against a real loopback
// server and the production bundle. Usage: npm run bench:demo -- [--json] [--rebuild]

import { deepStrictEqual, strictEqual } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { Browser, Locator, Page } from "playwright";
import type { Server } from "../service/src/server/server";
import { loadWorkspaceMessages } from "../service/src/workspace/state";
import {
  browserViewport,
  ensureWebviewBuilt,
  launchChromium,
  loopbackOrigin,
  mb,
  openProfilePage,
  round,
  sampleCdpMemory,
  startLoopbackServer,
  verifyPortClosed,
  type CdpMemorySample,
} from "./browser-harness";
import { isScriptMain } from "./script-paths.mjs";
import { seedDemo } from "./seed-demo";

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

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
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
  let consoleErrors: string[];
  let pageErrors: string[];
  const journeysVerified: string[] = [];

  let server: Server | undefined;
  let port: number | undefined;
  let browser: Browser | undefined;
  let metrics: Omit<DemoBenchmarkMetrics, "totalDurationMs">;
  let portClosed = false;

  let teardownPromise: Promise<void> | null = null;
  const teardown = (): Promise<void> => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      if (browser) {
        await withTimeout(browser.close(), 10_000).catch(() => {});
      }
      if (server) {
        await withTimeout(server.close(), 10_000).catch(() => {});
      }
      if (port !== undefined) {
        portClosed = await verifyPortClosed(port);
      }
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
    const tSeed = performance.now();
    const seeded = seedDemo(tmpDir, { quiet: true, writeConfig: true });
    const seedMs = round(performance.now() - tSeed);

    const tServer = performance.now();
    server = await startLoopbackServer(tmpDir);
    port = await server.listening;
    const serverStartMs = round(performance.now() - tServer);

    browser = await launchChromium();
    const context = await browser.newContext({
      viewport: browserViewport,
      permissions: ["clipboard-read", "clipboard-write"],
      colorScheme: "light",
    });
    const profiled = await openProfilePage(context);
    const { page, cdp } = profiled;
    ({ consoleErrors, pageErrors } = profiled);

    const visible = (locator: Locator, timeout = 5_000) => locator.waitFor({ timeout });
    const lead = page.locator(".ws-group-project .ws-group-label", { hasText: "agent-team" });
    const worker = (name: string) => page.locator(".task-item", { hasText: name });
    const transcript = (marker: string) =>
      visible(page.locator(".messages", { hasText: marker }), 10_000);

    // ---- Journey 1: Initial hydration, sidebar tree, git indicators, archives, search ----
    const tHydrate = performance.now();
    await page.goto(`${loopbackOrigin(port)}/?debug=1&demoPace=raf`, {
      waitUntil: "domcontentloaded",
    });
    await visible(lead, 15_000);
    await visible(worker("mobile panels"), 10_000);
    await visible(page.locator(".system-status-grid"), 10_000);
    await visible(page.locator(".quota-panel"), 10_000);
    const hydrationMs = round(performance.now() - tHydrate);

    for (const name of ["mobile panels", "wake-up time", "readme"]) {
      assert(await worker(name).isVisible(), `Sidebar should list worker "${name}"`);
    }

    const projectArchiveToggle = page.locator(".ws-archive-toggle");
    await visible(projectArchiveToggle);
    await projectArchiveToggle.click();
    await visible(page.locator(".task-item-archived", { hasText: "file routes" }));
    const archivedPast = page.locator(".task-item-archived", { hasText: "parser crash" });
    await visible(archivedPast);
    await archivedPast.click();
    await transcript("TemplateResolver::resolve");

    for (const { label, file, line, end } of seeded.fileLinks) {
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) => {
            const url = new URL(r.url());
            return (
              url.pathname === "/api/file" &&
              r.request().method() === "GET" &&
              url.searchParams.get("ws") === seeded.workspaces.past &&
              path.normalize(url.searchParams.get("path") ?? "") === file
            );
          },
          { timeout: 10_000 },
        ),
        page.locator(".messages .file-ref", { hasText: label }).click({ timeout: 5000 }),
      ]);
      assert(response.ok(), `File preview returned ${response.status()} for ${label}`);
      const marker = fs.readFileSync(file, "utf8").split("\n")[line - 1];
      const code = page.locator(".files-panel .code-text", { hasText: marker });
      await code.waitFor();
      assert(
        (await code.textContent())?.split("\n")[line - 1] === marker,
        `Missing ${label} target line`,
      );
      const viewer = page.locator(".files-panel .code-view");
      const [view, mark, text] = await Promise.all([
        viewer.boundingBox(),
        viewer.locator(".code-mark").boundingBox(),
        code.boundingBox(),
      ]);
      const lineHeight = await page.evaluate<number>(
        'parseFloat(getComputedStyle(document.querySelector(".files-panel .code-text")).lineHeight)',
      );
      assert(
        view &&
          mark &&
          text &&
          mark.y >= view.y &&
          mark.y < view.y + view.height &&
          mark.y - text.y === (line - 1) * lineHeight &&
          mark.height === (end - line + 1) * lineHeight,
        `Incorrect highlight for ${label}: ${JSON.stringify({ view, mark, text, lineHeight })}`,
      );
      await page.locator('aside.side-panel button[aria-label^="Close"]').click();
    }
    journeysVerified.push("archived-reply-file-links");

    // Search from the lead so opening an archived hit must switch transcripts.
    await lead.click();
    await transcript("分成两件事");
    const searchInput = page.locator(".search-bar input");
    await searchInput.fill("TemplateResolver");
    const searchHit = page.locator(".search-result-item", { hasText: "parser crash" }).first();
    await searchHit.click({ timeout: 10_000 });
    await transcript("TemplateResolver::resolve");
    strictEqual(await searchInput.inputValue(), "", "Opening a result should clear search");
    await lead.click();
    await transcript("分成两件事");
    // Collapse project Archived now that active workspace is no longer archived.
    await projectArchiveToggle.click();
    await archivedPast.waitFor({ state: "hidden", timeout: 5_000 });
    journeysVerified.push("hydration-sidebar-archive-search");

    // ---- Journey 2: Workspace switching latency + message history rendering ----
    const switchTargets = [
      { target: worker("mobile panels"), marker: "sheet 头部已经改好" },
      { target: worker("wake-up time"), marker: "noteSchedule" },
      { target: worker("readme"), marker: "deploy-deferred.sh" },
      { target: lead, marker: "分成两件事" },
    ];
    const workspaceSwitchSamplesMs: number[] = [];
    const switchRounds = options.switchRounds ?? 2;
    for (let r = 0; r < switchRounds; r++) {
      for (const { target, marker } of switchTargets) {
        const t0 = performance.now();
        await target.click();
        await transcript(marker);
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
    await worker("mobile panels").click();
    await visible(page.getByRole("cell", { name: "目录行高", exact: true }), 10_000);
    await visible(page.locator(".ws-info-branch", { hasText: "ui/mobile-panels" }), 10_000);
    // Wait for dirty count (modified styles.css + untracked NOTES.md = 2) from real GitScanner.
    await page.locator(".ws-info-branch .git-dirty").waitFor({ state: "visible", timeout: 10_000 });

    const workerReply = page.locator(".message-agent", { hasText: "sheet 头部已经改好" });
    const actions = workerReply.locator(".message-actions");
    const messageCopy = actions
      .locator(".btn-quote + .btn-copy-message")
      .and(actions.getByRole("button", { name: "Copy message", exact: true }));
    const size = (button: Locator) =>
      button.evaluate((el) => {
        const { width, height } = el.getBoundingClientRect();
        return [width, height];
      });
    const clipboard = async () =>
      (await page.evaluate<string>("navigator.clipboard.readText()")).replaceAll("\r\n", "\n");
    const raw = loadWorkspaceMessages(tmpDir, seeded.workspaces.mobile).find((msg) =>
      msg.content.startsWith("sheet 头部已经改好"),
    )?.content;
    const quote = actions.getByRole("button", { name: "Quote this message" });
    deepStrictEqual(await size(messageCopy), await size(quote));
    const opacity = (button: Locator) => button.evaluate((el) => getComputedStyle(el).opacity);
    const waitForOpacity = async (button: Locator, value = "1") => {
      await page.waitForFunction(({ el, value }) => el && getComputedStyle(el).opacity === value, {
        el: await button.elementHandle(),
        value,
      });
    };
    const checkDesktopControl = async (
      host: Locator,
      button: Locator,
      previous: Locator,
      hoverPeer?: Locator,
    ) => {
      await page.mouse.move(0, 0);
      await button.blur();
      await waitForOpacity(button, "0");
      await host.hover();
      await waitForOpacity(button);
      if (hoverPeer) await waitForOpacity(hoverPeer);
      await page.mouse.move(0, 0);
      await previous.focus();
      await page.keyboard.press("Tab");
      await button.and(page.locator(":focus-visible")).waitFor();
      await waitForOpacity(button);
      strictEqual(await button.evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
    };
    const checkMessageCopy = () => checkDesktopControl(workerReply, messageCopy, quote);
    await checkMessageCopy();
    await page.keyboard.press("Enter");
    await actions.getByRole("button", { name: "Copied", exact: true }).waitFor();
    assert(raw && (await clipboard()) === raw, "Message Copy should preserve raw markdown");

    const copyFrom = async (host: Locator, expected: string) => {
      await host.getByRole("button", { name: "Copy", exact: true }).click();
      await host.getByRole("button", { name: "Copied", exact: true }).waitFor();
      strictEqual(await clipboard(), expected);
    };
    const command = "npx vitest run tests/agents-panel.test.tsx tests/files-panel.test.tsx";
    await copyFrom(workerReply.locator(".code-block", { hasText: command }), command);
    const steps = workerReply.locator(".step-group", {
      has: page.getByText("Bash", { exact: true }),
    });
    await steps.getByRole("button", { name: "Expand steps" }).click();
    const bash = steps.locator(".event-tool_use", { hasText: command });
    await bash.getByRole("button", { name: /^Result ·/ }).click();
    const output = bash.locator(".event-result", { hasText: "31 passed (31)" });
    await copyFrom(output, " Test Files  2 passed (2)\n      Tests  31 passed (31)");
    await bash.getByRole("button", { name: /^Hide result ·/ }).click();
    await bash.locator(".event-result").waitFor({ state: "hidden" });
    await steps
      .locator(".trace-collapse-footer")
      .getByRole("button", { name: "Collapse steps" })
      .press("Enter");
    await steps.getByRole("button", { name: "Expand steps" }).and(page.locator(":focus")).waitFor();

    const checkDiagrams = async (touch = false) => {
      const dimensions = touch ? [36, 32] : [27, 22];
      for (const [language, renderer, label] of [
        ["mermaid", "mermaid", "Preview"],
        ["dot", "graphviz", "SidePanel"],
      ]) {
        const code = workerReply.locator(`pre:has(code.language-${language})`);
        const block = code.locator("..");
        const preview = block.locator(`:scope > .diagram-preview--${renderer}`);
        const toggle = block.getByRole("button", { name: "Preview diagram", pressed: false });
        const copy = block.getByRole("button", { name: "Copy", exact: true });
        await code.waitFor();
        const source = (await code.textContent())!;
        strictEqual(await code.getAttribute("hidden"), null);
        strictEqual(await toggle.textContent(), "");
        strictEqual(await toggle.getAttribute("title"), "Preview diagram");
        deepStrictEqual(await size(copy), dimensions, `${language} Copy size`);
        deepStrictEqual(await size(toggle), dimensions, `${language} Preview size`);
        if (touch) {
          strictEqual(await opacity(toggle), "1");
          strictEqual(await opacity(copy), "1");
          await toggle.click();
        } else {
          await checkDesktopControl(block, toggle, copy, copy);
          await page.keyboard.press("Enter");
        }
        await preview.locator("svg text", { hasText: label }).waitFor();
        await code.and(block.locator("pre[hidden]")).waitFor({ state: "attached" });
        const show = block.getByRole("button", { name: "Show code", pressed: true });
        const [copyBox, showBox, hostBox] = await Promise.all([
          copy.boundingBox(),
          show.boundingBox(),
          block.boundingBox(),
        ]);
        assert(
          copyBox &&
            showBox &&
            hostBox &&
            showBox.x >= copyBox.x + copyBox.width - 1 &&
            showBox.x >= hostBox.x &&
            copyBox.x + copyBox.width <= hostBox.x + hostBox.width,
          `${language} diagram actions should fit without overlap`,
        );
        await copyFrom(block, source.replace(/\r?\n$/, ""));
        deepStrictEqual(
          await size(block.getByRole("button", { name: "Copied", exact: true })),
          dimensions,
        );
        await show.click();
        await block.locator(":scope > .diagram-preview").waitFor({ state: "detached" });
        await code.waitFor();
        strictEqual(await code.getAttribute("hidden"), null);
        strictEqual(await code.textContent(), source, `${language} restored source`);
      }
    };
    await checkDiagrams();

    const themeButton = (pressed: boolean) =>
      page.getByRole("button", { name: "Dark theme", pressed });
    await themeButton(false).click();
    await themeButton(true).waitFor();
    await checkMessageCopy();
    await checkDiagrams();
    await themeButton(true).click();
    await themeButton(false).waitFor();
    strictEqual(await page.locator("html").getAttribute("data-theme"), "light");
    await workerReply.waitFor();

    // Check wake-up time branch + ahead indicator from real GitScanner.
    await worker("wake-up time").click();
    await visible(page.locator(".ws-info-branch", { hasText: "fix/wake-time" }), 10_000);
    await page.locator(".ws-info-branch .git-ahead").waitFor({ state: "visible", timeout: 10_000 });
    journeysVerified.push("workspace-switch-history-git-indicators");

    // ---- Journey 3: Side panels (Files, Preview, Ask Lines, Git Changes Diff, Agents/Tasks) ----
    await worker("mobile panels").click();
    await visible(workerReply, 10_000);

    // Files browser + preview.
    await page.locator('nav.side-rail button[aria-label="Files"]').click();
    const files = page.locator(".files-panel");
    const packageFile = files.locator(".dir-entry", { hasText: "package.json" });
    await packageFile.click({ timeout: 10_000 });
    await visible(files.locator("pre.code-text"), 10_000);

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
    // The Files panel remembers its last path across rail switches.
    await files.getByTitle("Parent folder").click();

    // Git Changes panel + diff view for mobile panels worktree.
    await page.locator('nav.side-rail button[aria-label="Changes"]').click();
    await visible(files.filter({ hasText: "styles.css" }), 10_000);
    await visible(files.filter({ hasText: "NOTES.md" }), 10_000);
    await page.locator(".files-panel .change-entry", { hasText: "styles.css" }).click();
    await visible(files.filter({ hasText: "sheet header: 44px touch targets" }), 10_000);

    await files.getByTitle("All changes").click();
    await files.getByTitle("NOTES.md", { exact: true }).click();
    await files.locator(".diff-add", { hasText: "# Mobile panels" }).waitFor();
    await files.getByTitle("All changes").click();
    await page.locator('nav.side-rail button[aria-label="Files"]').click();
    await packageFile.waitFor();
    const fresh = "Fresh on-disk Demo change";
    fs.writeFileSync(path.join(seeded.worktrees.mobilePanels, "fresh.txt"), `${fresh}\n`);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await files.getByTitle("fresh.txt", { exact: true }).click();
    await files.locator(".diff-add", { hasText: fresh }).waitFor();

    // Agents panel from Lead (project overview: sessions, models, effort, context, quota/system).
    await lead.click();
    await page.locator('nav.side-rail button[aria-label="Agents and sessions"]').click();
    const agents = page.getByRole("complementary", { name: "Agents", exact: true });
    await visible(agents, 10_000);
    const mobileCard = agents.getByRole("region", { name: "mobile panels", exact: true });
    await visible(mobileCard);
    await mobileCard.getByRole("button", { name: "Unfold mobile panels" }).click();
    await visible(mobileCard.locator('select[aria-label$="model"]'));
    await page.locator('aside.side-panel button[aria-label^="Close"]').click();
    await page.locator("aside.side-panel").waitFor({ state: "hidden", timeout: 5_000 });
    journeysVerified.push("side-panels-files-diff-asklines-agents");

    // ---- Journey 4: Board view (Objectives graph, detail drawer, Issues, Notes) ----
    const tBoard = performance.now();
    await page.getByRole("button", { name: "Objectives of agent-team", exact: true }).click();
    const board = page.getByRole("dialog", { name: /^agent-team (objectives|issues|notes)$/ });
    const card = (name: string) => board.locator(".bp-card", { hasText: name });
    const phoneCard = card("Panels on phones");
    await visible(phoneCard, 10_000);
    const boardOpenMs = round(performance.now() - tBoard);

    const boardButton = (group: string, name: string | RegExp) =>
      board.getByRole("group", { name: group, exact: true }).getByRole("button", { name });
    await boardButton("View", "Dependencies").click();
    await visible(board.locator("svg").first());
    await visible(board.locator(".bp-node", { hasText: "Preview deploys per branch" }));

    await boardButton("View", "List").click();
    const active = boardButton("Status", /^Active\b/);
    await active.click();
    await visible(card("Search in the Files panel"));
    await phoneCard.waitFor({ state: "hidden", timeout: 5_000 });
    await active.click();
    await phoneCard.click();
    const phoneDetail = board.getByRole("complementary", { name: "Panels on phones", exact: true });
    await visible(phoneDetail.getByText("44px touch targets in the sheet header"));
    await visible(phoneDetail.getByText("Swipe down to close the sheet?"));
    await phoneDetail.getByRole("button", { name: "Close details" }).click();

    await boardButton("Show", /^Issues/).click();
    const row = (id: string) => board.locator(".bi-row", { hasText: id });
    await visible(row("04-12#1"));
    await visible(row("04-12#2"));
    const openIssues = boardButton("State", /^Open/);
    await openIssues.click();
    await row("04-12#1").waitFor({ state: "hidden", timeout: 5_000 });
    await openIssues.click();
    await row("04-12#1").click();
    await visible(board.getByRole("complementary", { name: "Issue 04-12#1" }));

    await boardButton("Show", /^Notes\b/).click();
    await board.getByRole("treeitem", { name: "architecture.md" }).click();
    await visible(board.getByRole("heading", { name: "Architecture Notes" }));
    await board.getByRole("treeitem", { name: "mobile-spec.md" }).click();
    await visible(board.getByRole("heading", { name: "Mobile Panels Spec" }));
    await board.getByRole("button", { name: "Close", exact: true }).click();
    await board.waitFor({ state: "hidden", timeout: 5_000 });
    journeysVerified.push("board-objectives-graph-issues-notes");

    // ---- Journey 5: Workspace 🎬 Replay Demo — Desktop (1280x800) & Mobile (390x844) ----
    const clientBeforeReplay = await sampleCdpMemory(cdp);
    const serverBeforeReplay = sampleServerMemory();

    await page.getByRole("button", { name: "Replay demo", exact: true }).click();

    // Select the newly created "🎬 Replay Demo" workspace in the sidebar so the
    // streaming replay renders live in the active viewport.
    await worker("Replay Demo").click({ timeout: 10_000 });

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
    const replayStats = {
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
    const oldExperiment = page.locator(".ws-archived .task-item-archived", {
      hasText: "old-experiment",
    });
    await standaloneArchive.click({ timeout: 5_000 });
    await visible(oldExperiment);
    await standaloneArchive.click();
    await oldExperiment.waitFor({ state: "hidden", timeout: 5_000 });

    for (const marker of [
      "Markdown torture test",
      "多智能体编排面板",
      "session expired — message ends in the error state",
      "The fixtures cover the waiting, thinking, and tool phases.",
    ]) {
      await visible(page.locator(".messages", { hasText: marker }));
    }

    // Exercise subagent Cancel on the still-running "Watch CI for regressions" subagent.
    const running = page.locator(".subagent-item", { hasText: "Watch CI for regressions" });
    const cancelBtn = running.getByRole("button", { name: "Cancel", exact: true });
    await cancelBtn.waitFor({ state: "visible", timeout: 5_000 });
    await cancelBtn.click();
    await cancelBtn.waitFor({ state: "hidden", timeout: 5_000 });
    await running.getByTitle("stopped", { exact: true }).waitFor();
    await running.and(page.locator(".subagent-stopped")).waitFor();
    await page
      .locator("#msg-demo-layout-turn")
      .getByText(/The fixtures cover the waiting, thinking, and tool phases/)
      .waitFor();
    await page.getByRole("button", { name: /^Jump to quoted message from Demo:/ }).click();
    await page.locator("#msg-demo-msg-1.message-highlight").waitFor();

    const desktopOverflowPx = await measureHorizontalOverflowPx(page);
    const clientAfterReplay = await sampleCdpMemory(cdp);
    const serverAfterReplay = sampleServerMemory();

    // Mobile viewport check (390x844): Replay Demo + mobile sidebar drawer + seeded worker.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("button.mobile-menu-btn").waitFor({ state: "visible", timeout: 5_000 });
    const replayMobileOverflow = await measureHorizontalOverflowPx(page);
    await page.locator("button.mobile-menu-btn").click();
    await page.locator(".sidebar-title", { hasText: "Workspaces" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await worker("mobile panels").click();
    await visible(workerReply, 10_000);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    assert(await page.evaluate('matchMedia("(hover: none)").matches'), "Expected touch controls");
    await waitForOpacity(messageCopy);
    await checkDiagrams(true);
    const workerMobileOverflow = await measureHorizontalOverflowPx(page);
    journeysVerified.push("replay-demo-cancel-desktop-and-mobile");
    metrics = {
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
      mobileOverflowPx: Math.max(replayMobileOverflow, workerMobileOverflow),
    };
  } finally {
    await teardown();
    if (activeTeardown === teardown) activeTeardown = null;
  }
  return {
    metrics: { ...metrics, totalDurationMs: round(performance.now() - suiteStarted) },
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

if (isScriptMain("bench-demo.ts")) {
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
