import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { ensureWebviewBuilt } from "../../../scripts/browser-harness";
import type { Server } from "../../src/server/server";
import type { WorkspaceState } from "../../src/workspace/workspace";
import { observeBrowserErrors } from "./pilot-assertions";
import { pilotServer } from "./pilot-server";

export { pilotModel, sandboxAgent } from "./pilot-server";

export async function pilotBrowser(
  setup: (root: string) => WorkspaceState[],
  exercise: (page: Page, server: Server) => Promise<void>,
) {
  ensureWebviewBuilt(false, true);
  await pilotServer(
    setup,
    async (origin, server, firstWorkspaceId) => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 800 },
          reducedMotion: "reduce",
        });
        page.setDefaultTimeout(6_000);
        const checkErrors = observeBrowserErrors(page);
        await page.addInitScript((id) => {
          if (!localStorage.getItem("activeWsId")) localStorage.setItem("activeWsId", id);
        }, firstWorkspaceId);
        await page.goto(origin);
        try {
          await exercise(page, server);
        } catch (error) {
          console.error(
            await page
              .locator("body")
              .innerText()
              .catch(() => "(page unavailable)"),
          );
          throw error;
        }
        checkErrors();
      } finally {
        await browser.close();
      }
    },
    join(__dirname, "../../../dist/webview"),
  );
}

export const selectSession = (page: Page, name: string) =>
  page.locator(".sidebar").getByText(name, { exact: true }).click();

export async function refreshSession(page: Page, ready: () => Promise<unknown>) {
  await page.reload();
  await ready();
}
