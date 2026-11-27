// Offline production-bundle benchmark. See service/tests/corpus/README.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { INACTIVE_TRANSCRIPT_BUDGET } from "../webview/src/state/transcriptRetention";
import {
  CpuSources,
  memory,
  profileSwitch,
  snapshotNativeCounters,
  snapshotRetainers,
  stopAllocationSample,
} from "./bench-heavy-transcript-cdp";
import {
  fixtures,
  messageId,
  seedHeavyTranscript,
  type Fixture,
} from "./bench-heavy-transcript-seed";

const root = fileURLToPath(new URL("../", import.meta.url));
const [primary, secondary, light] = fixtures;
const tail = (ws: Fixture) => `#msg-${messageId(ws, ws.count - 1)}`;

type FontControl = "baseline" | "sarasa" | "katex";
type Options = {
  dryRun: boolean;
  ax: false | "renderer" | "cdp";
  noLiveRegions: boolean;
  fontControl?: FontControl;
};

type Probe = {
  transcriptMounts: number;
  suppressedLiveAttributes: number;
  arm(selector: string, requireMath: boolean, onClick: boolean): void;
  ready: boolean;
  frameMs: number;
};
type ProbeWindow = Window & { benchHeavy: Probe };

async function addFrameProbe(page: Page, coldSelector: string, options: Options) {
  const install = (selector: string, ax: boolean, noLiveRegions: boolean) => {
    // Close the real socket on command, rather than fabricating server frames
    // or routing every profiled frame through a Playwright proxy.
    let socket: WebSocket | undefined;
    const NativeSocket = window.WebSocket;
    const watch = (current: WebSocket) => {
      socket = current;
      current.addEventListener(
        "close",
        () => {
          if (socket === current) socket = undefined;
        },
        { once: true },
      );
    };
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        watch(this);
      }
    };
    window.addEventListener("bench-heavy-disconnect", () =>
      socket?.close(4000, "offline benchmark"),
    );
    const probe: Probe = {
      transcriptMounts: 0,
      suppressedLiveAttributes: 0,
      ready: false,
      frameMs: 0,
      arm(target, math, onClick) {
        probe.ready = false;
        const start = () => {
          performance.clearMarks("bench-heavy-start");
          performance.clearMarks("bench-heavy-end");
          performance.mark("bench-heavy-start");
          let queued = false;
          const observer = new MutationObserver(check);
          observer.observe(document, { childList: true, subtree: true });
          function check() {
            if (
              queued ||
              !document.querySelector(target) ||
              (math && !document.querySelector(".messages .katex"))
            )
              return;
            queued = true;
            observer.disconnect();
            // Give the renderer a frame after the ready DOM mutation. This
            // is not a guarantee of pixel presentation on a physical display.
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                performance.mark("bench-heavy-end");
                probe.frameMs = performance.now();
                probe.ready = true;
              }),
            );
          }
          check();
        };
        if (onClick) document.addEventListener("click", start, { once: true, capture: true });
        else start();
      },
    };
    if (ax) {
      let current: Element | null = null;
      new MutationObserver(() => {
        const next = document.querySelector(".messages");
        if (next && next !== current) probe.transcriptMounts++;
        current = next;
      }).observe(document, { childList: true, subtree: true });
    }
    if (noLiveRegions) {
      // Diagnostic control only: intercept React's writes before they can
      // reach Blink. Never remove these semantics in production as a fix.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- forwarded with the original receiver below
      const write = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (name === "aria-live" || (name === "role" && value === "status")) {
          probe.suppressedLiveAttributes++;
          return;
        }
        write.call(this, name, value);
      };
    }
    (window as unknown as ProbeWindow).benchHeavy = probe;
    probe.arm(selector, false, false);
  };
  // tsx keeps JS function names via a module-local helper. Playwright
  // serializes only the callback, so provide the no-op in its isolated scope.
  await page.addInitScript(
    `(() => { const __name = (fn) => fn; (${install.toString()})(${JSON.stringify(coldSelector)}, ${Boolean(options.ax)}, ${options.noLiveRegions}); })()`,
  );
}

function monitorHistory(page: Page) {
  const pages: Array<{ older: boolean; bytes: number }> = [];
  let inits = 0,
    details = 0,
    sockets = 0;
  page.on("websocket", (socket) => {
    sockets++;
    socket.on("framereceived", ({ payload }) => {
      const data = JSON.parse(payload.toString()) as { type: string; before?: number | null };
      if (data.type === "init") inits++;
      if (data.type === "message_details") details++;
      if (data.type === "workspace_messages")
        pages.push({
          older: data.before != null,
          bytes: Buffer.byteLength(payload),
        });
    });
  });
  return { pages, counts: () => ({ inits, details, sockets }) };
}

async function waitForFrame(page: Page) {
  await page.waitForFunction(() => (window as unknown as ProbeWindow).benchHeavy.ready);
}

function mountCount(page: Page) {
  return page.locator(".messages .message").count();
}

async function assertCount(page: Page, count: number) {
  await page
    .locator(`.messages-content[data-loaded-messages="${count}"]`)
    .waitFor({ state: "attached" });
  const mounted = await mountCount(page);
  assert(
    mounted > 0 && mounted <= Math.min(count, 45),
    `Mounted ${mounted} out of ${count} loaded messages`,
  );
}

async function revealEarlier(page: Page, selector: string) {
  for (let i = 0; i < 40 && !(await page.locator(selector).count()); i++) {
    await page.locator(".messages").evaluate(async (el) => {
      el.scrollTop -= el.clientHeight;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
  }
  await page.locator(selector).first().waitFor({ state: "attached" });
}

async function offset(page: Page, selector: string) {
  return page
    .locator(selector)
    .evaluate(
      (el) => el.getBoundingClientRect().top - el.closest(".messages")!.getBoundingClientRect().top,
    );
}

async function pageOlder(page: Page, ws: Fixture, pages: number) {
  for (let i = 1; i <= pages; i++) {
    const anchor = `#msg-${messageId(ws, ws.count - i * 50)}`;
    // A real DOM scroll event drives the production onScroll handler. Set
    // the offset directly so this does not depend on wheel speed or device.
    const before = await page.locator(".messages").evaluate((el, anchor) => {
      el.scrollTop = 0;
      const row = el.querySelector(anchor);
      const y =
        row?.getBoundingClientRect().top ??
        el.querySelector(".history-hint")!.getBoundingClientRect().bottom;
      return y - el.getBoundingClientRect().top;
    }, anchor);
    await assertCount(page, (i + 1) * 50);
    const after = await offset(page, anchor);
    assert(
      Math.abs(after - before) < 3,
      `Older page moved the reading anchor: ${before} -> ${after}`,
    );
  }
}

function isolateServer(base: string) {
  // Keep only what the local runtime needs. VITEST is the service's guard
  // against native Codex startup, and a missing Pi executable fails closed.
  const env = process.env;
  const allowed = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
    "TMPDIR",
  ]);
  for (const key of Object.keys(env)) if (!allowed.has(key.toUpperCase())) delete env[key];
  const home = join(base, "home");
  mkdirSync(home);
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    PI_CODING_AGENT_DIR: join(home, ".pi"),
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_STATE_HOME: home,
    AGENT_TEAM_HOME: home,
    AGENT_TEAM_HOST: "127.0.0.1",
    YAAT_PI_BIN: join(home, "missing-pi"),
    AGY_ACP_BIN: join(home, "missing-acp"),
    VITEST: "true",
    GIT_CONFIG_NOSYSTEM: "1",
  });
}

function buildWebview(webDir: string) {
  assert(
    !existsSync(join(root, "webview", "public", "replay.jsonl")),
    "Build from a clean worktree without a local replay capture",
  );
  const npm = process.env.npm_execpath;
  assert(npm, "Use npm run bench:heavy (the benchmark uses npm's workspace build)");
  execFileSync(
    process.execPath,
    [
      npm,
      "run",
      "build",
      "-w",
      "webview",
      "--",
      "--outDir",
      webDir,
      "--sourcemap",
      "hidden",
      "--logLevel",
      "error",
    ],
    {
      cwd: root,
      stdio: ["ignore", 2, 2],
    },
  );
  assert(existsSync(join(webDir, "index.html")));
}

async function run(base: string, options: Options, signal: AbortSignal) {
  const { dryRun, ax, noLiveRegions, fontControl } = options;
  const webDir = join(base, "dist", "webview");
  const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!dryRun) buildWebview(webDir);
  isolateServer(base);
  const fixture = seedHeavyTranscript(base);
  assert.deepEqual([fixture.workspaces, fixture.active, fixture.messages], [93, 8, 1902]);
  assert(fixture.storedBytes > 40 * 1024 ** 2 && fixture.summaryBytes < fixture.storedBytes / 5);
  // Deliver any shutdown signal queued during the synchronous build/seed.
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal.throwIfAborted();
  if (dryRun) return { revision, fixture, dryRun };

  const { Server } = await import("../service/src/server/server");
  const server = new Server(0, base, webDir);
  try {
    const origin = `http://127.0.0.1:${await server.listening}`;
    signal.throwIfAborted();
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-background-networking",
        ...(ax === "renderer" ? ["--force-renderer-accessibility"] : []),
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    // Closing the browser rejects pending Playwright operations and lets
    // the normal finally blocks close the server and delete its scratch data.
    const interrupt = () => {
      void browser.close().catch(() => {});
    };
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      signal.throwIfAborted();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        serviceWorkers: "block",
      });
      const external: string[] = [];
      // No seeded link points out of the sandbox. Fail if the browser tries
      // reaching anything but this server, including external WebSockets.
      await context.route(
        (url) => url.origin !== origin,
        (route) => {
          external.push("http");
          return route.abort();
        },
      );
      await context.routeWebSocket(
        (url) => url.host !== new URL(origin).host,
        (ws) => {
          external.push("websocket");
          void ws.close();
        },
      );
      let fontFacesRemoved = 0;
      if (fontControl && fontControl !== "baseline") {
        const font =
          fontControl === "sarasa"
            ? /font-family\s*:\s*["']?Sarasa Mono SC/i
            : /font-family\s*:\s*["']?KaTeX_/i;
        await context.route(
          (url) => url.origin === origin && url.pathname.endsWith(".css"),
          async (route) => {
            const response = await route.fetch();
            const body = (await response.text()).replace(/@font-face\s*\{[^}]*\}/gi, (face) => {
              if (!font.test(face)) return face;
              fontFacesRemoved++;
              return "";
            });
            // Playwright decoded the source response; these describe the
            // original compressed body, not the rewritten CSS.
            const headers = { ...response.headers() };
            delete headers["content-encoding"];
            delete headers["content-length"];
            await route.fulfill({ response, headers, body });
          },
        );
      }
      const page = await context.newPage();
      const requestedFonts = new Set<string>();
      page.on("request", (req) => {
        if (req.resourceType() === "font") requestedFonts.add(req.url());
      });
      page.setDefaultTimeout(20_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const client = monitorHistory(page);
      await addFrameProbe(page, tail(primary), options);
      const cdp = await context.newCDPSession(page);
      const sources = new CpuSources(webDir);
      await cdp.send("Performance.enable");
      if (ax === "cdp") await cdp.send("Accessibility.enable");
      const curve: Array<
        Awaited<ReturnType<typeof memory>> & {
          label: string;
          mountedMessages: number;
          loadedMessages: number;
          inactivePayloadBytes: number;
        }
      > = [];
      async function checkpoint(label: string) {
        const stats = await memory(cdp);
        const counts = await page.evaluate(() => {
          const list = document.querySelector<HTMLElement>(".messages-content");
          return {
            mountedMessages: list?.querySelectorAll(".message").length ?? 0,
            loadedMessages: Number(list?.dataset.loadedMessages ?? 0),
            inactivePayloadBytes: Number(list?.dataset.inactiveTranscriptBytes ?? 0),
          };
        });
        assert(
          counts.inactivePayloadBytes <= INACTIVE_TRANSCRIPT_BUDGET,
          "Expendable inactive history exceeded 1 MiB",
        );
        curve.push({ label, ...stats, ...counts });
      }
      await checkpoint("blank");
      const cold = await profileSwitch(cdp, sources, async () => {
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await waitForFrame(page).catch(async (error) => {
          const [rows, math] = await Promise.all([
            mountCount(page),
            page.locator(".messages .katex").count(),
          ]);
          throw new Error(
            `Cold transcript did not settle: ${JSON.stringify({ rows, math, errors, ...client.counts() })}`,
            { cause: error },
          );
        });
      });
      const coldNavigationMs = +(
        await page.evaluate(() => (window as unknown as ProbeWindow).benchHeavy.frameMs)
      ).toFixed(2);
      await assertCount(page, 50);
      await checkpoint("first lead, 50 rows");
      if (fontControl) {
        // Math can be outside the first mounted window; the font control
        // must still load KaTeX before comparing its face registrations.
        await revealEarlier(page, ".messages .katex");
        if (fontControl !== "baseline")
          assert(fontFacesRemoved > 0, "No matching @font-face declarations removed");
        // End the cold-input timer earlier, but measure fonts only after
        // asynchronous font-display loading and the next layout frame.
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        });
        const counters = await snapshotNativeCounters(cdp);
        assert.deepEqual(external, []);
        assert.deepEqual(errors, []);
        return {
          revision,
          browser: browser.version(),
          fontControl,
          fontFacesRemoved,
          fontRequests: requestedFonts.size,
          cold,
          curve,
          counters,
        };
      }
      const axCurve: Array<
        Pick<Probe, "transcriptMounts" | "suppressedLiveAttributes"> & {
          label: string;
          counters: Awaited<ReturnType<typeof snapshotNativeCounters>>;
        }
      > = [];
      async function axCheckpoint(label: string) {
        if (!ax) return;
        const probe = await page.evaluate(() => {
          const { transcriptMounts, suppressedLiveAttributes } = (window as unknown as ProbeWindow)
            .benchHeavy;
          return { transcriptMounts, suppressedLiveAttributes };
        });
        axCurve.push({ label, ...probe, counters: await snapshotNativeCounters(cdp) });
      }
      await axCheckpoint("cold 50");
      const opened = new Set([primary.id]);
      let switches = 0;
      const sidebar = (ws: Fixture) =>
        page
          .locator(ws === fixtures[ws.project] ? ".ws-group-project" : ".task-item")
          .filter({ has: page.getByText(ws.name, { exact: true }) });
      async function select(ws: Fixture, marker = tail(ws)) {
        await sidebar(ws).click();
        await page.locator(marker).waitFor({ state: "attached" });
        opened.add(ws.id);
        switches++;
      }
      const arm = (selector: string, requireMath: boolean) =>
        page.evaluate(
          ([sel, math]) => (window as unknown as ProbeWindow).benchHeavy.arm(sel, math, true),
          [selector, requireMath] as const,
        );
      async function warmSamples(count: number, marker = tail(primary)) {
        const samples = [];
        for (let i = 0; i < 3; i++) {
          await select(light);
          await arm(marker, false);
          samples.push(
            await profileSwitch(cdp, sources, async () => {
              await select(primary, marker);
              await waitForFrame(page);
            }),
          );
          await assertCount(page, count);
        }
        return samples;
      }
      const warm50 = await warmSamples(50);
      await axCheckpoint("after six warm switches at 50");
      await pageOlder(page, primary, 2);
      await checkpoint("first lead, 150 rows");
      await axCheckpoint("same scroller after two prepends to 150");
      const anchor = `#msg-${messageId(primary, primary.count - 100)}`;
      const readOffset = await offset(page, anchor);
      const warm150 = await warmSamples(150, anchor);
      await axCheckpoint("after six warm switches at 150");
      assert(
        Math.abs((await offset(page, anchor)) - readOffset) < 3,
        "Returning to the lead lost its reading anchor",
      );
      await page.locator(".jump-latest").click();
      const bottomGap = () =>
        page
          .locator(".messages")
          .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      assert((await bottomGap()) < 3, "Jump to latest did not follow the tail");
      await select(secondary);
      await pageOlder(page, secondary, 2);
      await checkpoint("second lead, 150 rows; first lead inactive");

      await select(primary);
      const group = page.locator(".ws-group").filter({ has: sidebar(primary) });
      const folded = group.getByRole("button", { name: /^Show \d+ folded sessions?$/ });
      if (await folded.count()) await folded.click();
      await group.locator(".ws-archive-toggle").click();
      // Three compact bursts bracket the observed p90 (6 switches) and
      // avoid spending idle minutes. Targets are synthetic, not inferred.
      for (const [i, targets] of [
        [3, 4, 8, 9, 10, 11],
        [12, 13, 14, 15, 16, 17],
        [18, 19, 20, 21, 5, 6],
      ].entries()) {
        for (const target of targets) await select(fixtures[target]);
        await checkpoint(`switch burst ${i + 1}; ${opened.size} distinct sessions`);
      }
      for (const target of [21, 3, 4]) {
        await select(fixtures[target]);
        const before = client.counts().details;
        await page.getByRole("button", { name: "Expand steps", exact: true }).last().click();
        await page
          .locator(".messages .step-group.open .event")
          .first()
          .waitFor({ state: "attached" });
        await expectUntil(() => client.counts().details > before, "Trace details did not arrive");
      }
      await select(primary);
      const primaryLoaded = Number(
        await page.locator(".messages-content").getAttribute("data-loaded-messages"),
      );
      if (primaryLoaded === 50) {
        await pageOlder(page, primary, 2);
        await page.locator(".jump-latest").click();
      }
      await assertCount(page, 150);
      const boardButton = page.getByRole("button", { name: `Objectives of ${primary.name}` });
      await boardButton.click();
      await page.locator(".board-page .bp-card").first().waitFor();
      await page.getByRole("button", { name: "Dependencies", exact: true }).click();
      await page.locator(".board-page svg").first().waitFor();
      await page.locator('.board-page header button[aria-label="Close"]').click();
      const rail = (label: string) => page.locator(`nav.side-rail button[aria-label="${label}"]`);
      const closePanel = () => page.locator('aside.side-panel button[aria-label^="Close"]').click();
      await rail("Files").click();
      await page.locator(".files-panel .dir-entry", { hasText: "sample.txt" }).waitFor();
      await closePanel();
      await rail("Changes").click();
      await page.locator(".files-panel .change-entry", { hasText: "sample.txt" }).click();
      await page.locator(".files-panel", { hasText: "Synthetic change" }).waitFor();
      await closePanel();
      await rail("Session stats").click();
      await page.locator(".session-stats", { hasText: "No session stats recorded." }).waitFor();
      await closePanel();
      await rail("Agents and sessions").click();
      await page.locator('.agents-panel [aria-label="Synthetic session 3"]').waitFor();
      await page.getByRole("region", { name: "Quota used" }).waitFor();
      await closePanel();

      async function diagram(fromTail: number, language: string) {
        const row = `#msg-${messageId(primary, primary.count - 1 - fromTail)}`;
        const preview = `${row} .diagram-preview--${language} svg`;
        const button = page.locator(row).getByRole("button", { name: "Preview diagram" });
        await revealEarlier(page, row);
        await button.scrollIntoViewIfNeeded();
        await arm(preview, false);
        return profileSwitch(cdp, sources, async () => {
          await button.click();
          await waitForFrame(page);
        });
      }
      await checkpoint("first lead, 150 rows before diagrams");
      await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });
      const mermaid = await diagram(4, "mermaid");
      await checkpoint("first lead + Mermaid preview");
      const graphviz = await diagram(10, "graphviz");
      await checkpoint("first lead + Mermaid and Graphviz previews");
      const survivingDiagramPhaseAllocationsMiB = await stopAllocationSample(cdp, sources);
      const heap = await snapshotRetainers(cdp, primary.id);
      const axProbe = await page.evaluate(() => {
        const { transcriptMounts, suppressedLiveAttributes } = (window as unknown as ProbeWindow)
          .benchHeavy;
        return { transcriptMounts, suppressedLiveAttributes };
      });
      if (noLiveRegions)
        assert(axProbe.suppressedLiveAttributes > 0, "No live-region writes intercepted");
      assert.equal(
        heap.transcriptArrays.activeMessages,
        150,
        "Snapshot did not recognize the active transcript array",
      );
      assert(
        heap.transcriptArrays.inactiveWorkspaces > 0,
        "Snapshot did not recognize cached inactive transcripts",
      );
      const previous = client.counts();
      const receivedPages = client.pages.length;
      const visibleIds = () =>
        page.locator(".messages").evaluate((el) => {
          const view = el.getBoundingClientRect();
          return [...el.querySelectorAll(".message[id]")]
            .filter((row) => {
              const rect = row.getBoundingClientRect();
              return rect.bottom > view.top && rect.top < view.bottom;
            })
            .map((row) => row.id);
        });
      const beforeReconnect = await visibleIds();
      assert(beforeReconnect.length > 0);
      const reconnectOffset = await offset(page, `#${beforeReconnect[0]}`);
      await page.evaluate(() => window.dispatchEvent(new Event("bench-heavy-disconnect")));
      await expectUntil(
        () => client.counts().inits > previous.inits && client.pages.length > receivedPages,
        "Real WebSocket reconnect did not receive init and history",
      );
      await assertCount(page, 150);
      assert.deepEqual(
        await visibleIds(),
        beforeReconnect,
        "Reconnect changed the visible transcript",
      );
      assert(
        Math.abs((await offset(page, `#${beforeReconnect[0]}`)) - reconnectOffset) <= 3,
        "Reconnect moved the reading position",
      );
      await select(light);
      await checkpoint("light session after real socket reconnect");
      const lightHeap = await snapshotRetainers(cdp, light.id);
      assert(
        client.pages.filter((p) => p.older).length >= 4,
        "Expected at least four history prepends",
      );
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      return {
        revision,
        browser: browser.version(),
        fixture,
        coldNavigationMs,
        cold,
        warm50,
        warm150,
        mermaid,
        graphviz,
        survivingDiagramPhaseAllocationsMiB,
        options,
        fontRequests: requestedFonts.size,
        axProbe,
        axCurve,
        curve,
        heap,
        lightHeap,
        journey: {
          switches,
          distinct: opened.size,
          ...client.counts(),
          newestPages: client.pages.filter((p) => !p.older).length,
          olderPages: client.pages.filter((p) => p.older).length,
          wirePageMaxKiB: +(Math.max(...client.pages.map((p) => p.bytes)) / 1024).toFixed(1),
        },
      };
    } finally {
      signal.removeEventListener("abort", interrupt);
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

async function expectUntil(done: () => boolean, error: string) {
  const deadline = performance.now() + 20_000;
  while (!done()) {
    assert(performance.now() < deadline, error);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const args = process.argv.slice(2);
const fontArg = args.find((arg) => /^--font-control=(baseline|sarasa|katex)$/.test(arg));
const options: Options = {
  dryRun: args.includes("--dry-run"),
  ax: args.includes("--ax") ? "renderer" : args.includes("--ax-cdp") && "cdp",
  noLiveRegions: args.includes("--no-live-regions"),
  ...(fontArg && { fontControl: fontArg.split("=")[1] as FontControl }),
};
assert(
  new Set(args).size === args.length &&
    args.every((arg) =>
      ["--dry-run", "--ax", "--ax-cdp", "--no-live-regions", fontArg].includes(arg),
    ) &&
    !(args.includes("--ax") && args.includes("--ax-cdp")) &&
    (!options.noLiveRegions || options.ax) &&
    !(options.ax && options.fontControl) &&
    (!options.dryRun || args.length === 1),
  "Usage: npm run bench:heavy -- [--dry-run | (--ax | --ax-cdp) [--no-live-regions] | --font-control=baseline|sarasa|katex]",
);
const base = mkdtempSync(join(tmpdir(), "yaat-heavy-transcript-"));
const abort = new AbortController();
const onInterrupt = () => abort.abort(new Error("Benchmark interrupted"));
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onInterrupt);
const write = console.log.bind(console);
console.log = console.error.bind(console);
try {
  write(JSON.stringify(await run(base, options, abort.signal), null, 2));
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  // The absolute path is always an exclusive, newly created mkdtemp folder.
  assert(dirname(base) === tmpdir());
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
