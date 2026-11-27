// Offline production-bundle benchmark. See service/tests/corpus/README.md.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INACTIVE_TRANSCRIPT_BUDGET } from "../webview/src/state/transcriptRetention";
import {
  browserViewport,
  ensureWebviewBuilt,
  launchChromium,
  loopbackOrigin,
  openProfilePage,
  round,
  sampleCdpMemory,
  startLoopbackServer,
} from "./browser-harness";
import {
  fixtures,
  messageId,
  seedHeavyTranscript,
  type Fixture,
} from "./bench-heavy-transcript-seed";
import { REPO_ROOT } from "./script-paths.mjs";
import { seedGit } from "./seed-corpus";

const [primary, secondary, light] = fixtures;
const tail = (ws: Fixture) => `#msg-${messageId(ws, ws.count - 1)}`;

function isolateRuntime(base: string) {
  // This CLI owns its process. Do not load the Server or execute Git before
  // dropping inherited credentials, provider settings and global Git config.
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
  for (const key of Object.keys(process.env))
    if (!allowed.has(key.toUpperCase())) delete process.env[key];
  const home = join(base, "home");
  mkdirSync(home);
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    PI_CODING_AGENT_DIR: join(home, ".pi"),
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_STATE_HOME: home,
    AGENT_TEAM_HOME: home,
    YAAT_PI_BIN: join(home, "missing-pi"),
    AGY_ACP_BIN: join(home, "missing-acp"),
    VITEST: "true",
    GIT_CONFIG_NOSYSTEM: "1",
  });
}

async function run(base: string, dryRun: boolean, signal: AbortSignal) {
  const webDir = join(base, "webview");
  if (!dryRun) {
    assert(
      !existsSync(join(REPO_ROOT, "webview/public/replay.jsonl")),
      "Remove the local replay capture from webview/public before benchmarking",
    );
    ensureWebviewBuilt(true, true, webDir);
  }
  isolateRuntime(base);
  const revision = seedGit("-C", REPO_ROOT, "rev-parse", "--short", "HEAD").toString().trim();
  const fixture = seedHeavyTranscript(base);
  assert.deepEqual([fixture.workspaces, fixture.active, fixture.messages], [93, 8, 1902]);
  assert(fixture.storedBytes > 40 * 1024 ** 2 && fixture.summaryBytes < fixture.storedBytes / 5);
  // Deliver a pending shutdown signal after the synchronous build and seed.
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal.throwIfAborted();
  if (dryRun) return { revision, fixture, dryRun };

  const server = await startLoopbackServer(base, webDir);
  try {
    const origin = loopbackOrigin(await server.listening);
    signal.throwIfAborted();
    const browser = await launchChromium({
      args: ["--disable-background-networking"],
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    const closeBrowser = () => browser.close();
    const interrupt = () => {
      void closeBrowser().catch(() => {});
    };
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      signal.throwIfAborted();
      const context = await browser.newContext({
        viewport: browserViewport,
        serviceWorkers: "block",
      });
      let externalRequests = 0;
      await context.route(
        (url) => url.origin !== origin,
        (route) => {
          externalRequests++;
          return route.abort();
        },
      );
      const socketOrigin = origin.replace(/^http:/, "ws:");
      await context.routeWebSocket(
        (url) => url.origin !== socketOrigin,
        (ws) => {
          externalRequests++;
          void ws.close();
        },
      );
      const { page, cdp, consoleErrors, pageErrors } = await openProfilePage(context);
      page.setDefaultTimeout(20_000);
      const chat = page.locator(".messages");
      const list = chat.locator(".messages-content");
      const sample = async (label: string, loaded: number) => {
        await chat
          .locator(`.messages-content[data-loaded-messages="${loaded}"]`)
          .waitFor({ state: "attached" });
        const mounted = await chat.locator(".message").count();
        const inactivePayloadBytes = Number(
          await list.getAttribute("data-inactive-transcript-bytes"),
        );
        assert(mounted > 0 && mounted <= 45, `Mounted ${mounted} out of ${loaded} loaded messages`);
        assert(
          inactivePayloadBytes <= INACTIVE_TRANSCRIPT_BUDGET,
          "Expendable inactive history exceeded its budget",
        );
        return { label, loaded, mounted, inactivePayloadBytes, ...(await sampleCdpMemory(cdp)) };
      };
      const ready = async (ws: Fixture) => {
        await chat.locator(tail(ws)).waitFor({ state: "attached" });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
      };
      const select = async (ws: Fixture) => {
        await page.locator(".sidebar").getByText(ws.name, { exact: true }).click();
        await ready(ws);
      };
      const pageOlder = async (ws: Fixture) => {
        for (const loaded of [100, 150]) {
          await chat.evaluate((el) => {
            el.scrollTop = 0;
          });
          const anchor = `#msg-${messageId(ws, ws.count - loaded + 50)}`;
          await list
            .and(chat.locator(`[data-loaded-messages="${loaded}"]`))
            .locator(anchor)
            .waitFor({ state: "attached" });
        }
      };
      const start = performance.now();
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await ready(primary);
      const coldNavigationMs = round(performance.now() - start);
      const curve = [await sample("primary initial", 50)];
      const switchMs = [];
      for (let i = 0; i < 3; i++) {
        await select(light);
        const start = performance.now();
        await select(primary);
        switchMs.push(round(performance.now() - start));
      }
      await pageOlder(primary);
      curve.push(await sample("primary paged", 150));
      await select(secondary);
      await pageOlder(secondary);
      curve.push(await sample("secondary paged, primary inactive", 150));
      await select(light);
      curve.push(await sample("light, both leads inactive", light.count));
      signal.throwIfAborted();
      assert.equal(externalRequests, 0, "Browser tried to make an external request");
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(pageErrors, []);
      return { revision, browser: browser.version(), fixture, coldNavigationMs, switchMs, curve };
    } finally {
      signal.removeEventListener("abort", interrupt);
      await closeBrowser();
    }
  } finally {
    await server.close();
  }
}

const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 1 && args[0] === "--dry-run"),
  "Usage: npm run bench:heavy -- [--dry-run]",
);
const base = mkdtempSync(join(tmpdir(), "yaat-heavy-transcript-"));
const abort = new AbortController();
const onInterrupt = () => abort.abort(new Error("Benchmark interrupted"));
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onInterrupt);
const report = console.log.bind(console);
console.log = console.error.bind(console);
try {
  report(JSON.stringify(await run(base, args.length > 0, abort.signal), null, 2));
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
