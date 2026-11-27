import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type LaunchOptions } from "playwright";
import { REPO_ROOT } from "./script-paths.mjs";

const loopback = "127.0.0.1";
export const WEB_DIR = join(REPO_ROOT, "dist", "webview");
export const browserViewport = { width: 1280, height: 800 };
export const loopbackOrigin = (port: number) => `http://${loopback}:${port}`;

function latestMtimeMs(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  return stat.isDirectory()
    ? readdirSync(path).reduce(
        (latest, entry) => Math.max(latest, latestMtimeMs(join(path, entry))),
        stat.mtimeMs,
      )
    : stat.mtimeMs;
}

export function ensureWebviewBuilt(force = false, quiet = false, outDir = WEB_DIR): void {
  const index = join(outDir, "index.html");
  if (!force && existsSync(index)) {
    const built = statSync(index).mtimeMs;
    if (
      ["src", "index.html", "vite.config.ts"].every(
        (file) => latestMtimeMs(join(REPO_ROOT, "webview", file)) <= built,
      )
    )
      return;
  }
  const npm = process.env.npm_execpath;
  if (!npm && process.platform === "win32") {
    throw new Error(
      "Run the browser benchmark or test via npm so the webview build can find npm's CLI",
    );
  }
  const output = execFileSync(
    npm ? process.execPath : "npm",
    [
      ...(npm ? [npm] : []),
      "run",
      "build",
      "-w",
      "webview",
      ...(outDir === WEB_DIR ? [] : ["--", "--outDir", outDir]),
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!quiet && output.length) process.stderr.write(output);
  if (!existsSync(index)) throw new Error(`Webview build did not produce ${index}`);
}

export async function startLoopbackServer(baseDir: string, webDir = WEB_DIR) {
  // The heavy benchmark isolates the process environment before loading the server.
  const { Server } = await import("../service/src/server/server");
  const previous = process.env.AGENT_TEAM_HOST;
  process.env.AGENT_TEAM_HOST = loopback;
  try {
    return new Server(0, baseDir, webDir);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_HOST;
    else process.env.AGENT_TEAM_HOST = previous;
  }
}

export const launchChromium = (options?: LaunchOptions) =>
  chromium.launch({ headless: true, ...options });

export async function openProfilePage(context: BrowserContext) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  return { page, cdp, consoleErrors, pageErrors };
}

export function round(n: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

export const mb = (bytes: number) => round(bytes / 1024 ** 2);

export async function sampleCdpMemory(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const { metrics } = await cdp.send("Performance.getMetrics");
  const values = new Map(metrics.map(({ name, value }) => [name, value]));
  return {
    jsHeapUsedMb: mb(values.get("JSHeapUsedSize") ?? 0),
    jsHeapTotalMb: mb(values.get("JSHeapTotalSize") ?? 0),
    domNodes: Math.round(values.get("Nodes") ?? 0),
    documents: Math.round(values.get("Documents") ?? 0),
  };
}

export type CdpMemorySample = Awaited<ReturnType<typeof sampleCdpMemory>>;

export function verifyPortClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: loopback, port });
    const done = (closed: boolean) => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(false));
    socket.once("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED"));
  });
}
