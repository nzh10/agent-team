import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContextOptions,
  type ConsoleMessage,
  type Page,
} from "playwright";
import { expect } from "vitest";
import { ensureWebviewBuilt } from "../../../scripts/browser-harness";
import { seedDemo, type SeedDemoResult } from "../../../scripts/seed-demo";
import { Server } from "../../src/server/server";
import { closeHistory } from "../../src/workspace/state";

type Prepare = (dir: string, seed: SeedDemoResult) => void;
type PageOptions = BrowserContextOptions & {
  timeout: number;
  ignoreConsoleError?: (message: ConsoleMessage, origin: string) => boolean;
};

export async function startDemoJourney(prefix: string, prepare?: Prepare) {
  ensureWebviewBuilt();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const previousHost = process.env.AGENT_TEAM_HOST;
  let server: Server | undefined;
  let browser: Browser | undefined;
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        if (previousHost === undefined) delete process.env.AGENT_TEAM_HOST;
        else process.env.AGENT_TEAM_HOST = previousHost;
        closeHistory(dir);
        // A Git child can still hold its working directory after close() on Windows.
        await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
      }
    }
  };
  try {
    const seed = seedDemo(dir, { quiet: true, writeConfig: true });
    prepare?.(dir, seed);
    closeHistory(dir);
    process.env.AGENT_TEAM_HOST = "127.0.0.1";
    server = new Server(0, dir, join(__dirname, "../../../dist/webview"));
    const origin = `http://127.0.0.1:${await server.listening}`;
    const chromiumBrowser = (browser = await chromium.launch());
    const openPage = async ({ timeout, ignoreConsoleError, ...options }: PageOptions) => {
      const context = await chromiumBrowser.newContext(options);
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      context.on("page", (page) => {
        page.on("console", (message) => {
          if (message.type() === "error" && !ignoreConsoleError?.(message, origin))
            consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      const assertClean = () => {
        expect(consoleErrors, "Chromium console errors").toEqual([]);
        expect(pageErrors, "Uncaught Chromium errors").toEqual([]);
      };
      return { page, assertClean };
    };
    return { dir, seed, server, origin, openPage, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runDemoJourney(
  prefix: string,
  options: PageOptions,
  run: (page: Page, fixture: Awaited<ReturnType<typeof startDemoJourney>>) => Promise<void>,
  prepare?: Prepare,
) {
  const fixture = await startDemoJourney(prefix, prepare);
  try {
    const { page, assertClean } = await fixture.openPage(options);
    await run(page, fixture);
    assertClean();
  } finally {
    await fixture.close();
  }
}
