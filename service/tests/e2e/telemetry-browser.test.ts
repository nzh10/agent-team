import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { ensureWebviewBuilt } from "../../../scripts/bench-demo";
import { seedDemo } from "../../../scripts/seed-demo";
import { Server } from "../../src/server/server";
import type { TelemetryStore } from "../../src/storage/telemetry";
import {
  closeHistory,
  loadAll,
  loadWorkspaceMessages,
  saveWorkspace,
} from "../../src/workspace/state";

async function dispose(
  dir: string,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  server: Server | undefined,
) {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      closeHistory(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

const webDir = join(__dirname, "../../../dist/webview");
const action = "confirm.clear_context";

async function summary(origin: string): Promise<ReturnType<TelemetryStore["summary"]>> {
  return (await (await fetch(`${origin}/api/telemetry/summary`)).json()) as ReturnType<
    TelemetryStore["summary"]
  >;
}

it.each([true, false])(
  "real Chromium UI interaction telemetry (enabled=%s)",
  async (enabled) => {
    ensureWebviewBuilt();
    const dir = mkdtempSync(join(tmpdir(), "yaat-telemetry-browser-"));
    let server: Server | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      seedDemo(dir, { quiet: true, writeConfig: true });
      appendFileSync(join(dir, "config.toml"), `\n[telemetry]\nenabled = ${enabled}\n`);
      server = new Server(0, dir, webDir);
      const origin = `http://127.0.0.1:${await server.listening}`;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(10_000);
      let posts = 0;
      page.context().on("request", (req) => {
        if (req.method() === "POST" && req.url() === `${origin}/api/telemetry`) posts++;
      });
      await page.goto(origin);
      const rail = page.locator("nav.side-rail");
      const files = rail.getByRole("button", { name: "Files", exact: true });
      const agents = rail.getByRole("button", { name: "Agents and sessions" });
      const opener = page.getByRole("button", { name: /Clear .*'s context/ }).first();
      const dialog = page.getByRole("dialog", { name: /Clear .*'s context\?/ });
      const openAgents = async () => {
        await agents.click();
        const unfold = page.locator('.ap-session.active .ap-toggle[aria-expanded="false"]');
        if (await unfold.isVisible()) await unfold.click();
      };

      const firstFlush = enabled
        ? page.waitForResponse(
            (res) => res.url() === `${origin}/api/telemetry` && res.status() === 204,
          )
        : undefined;
      await page.locator(".ws-archive-toggle").click();
      await files.click();
      await openAgents();
      await opener.click();
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await opener.click();
      // Destructive dialogs default to Cancel. Confirm via the focused button.
      await dialog.getByRole("button", { name: "Clear context", exact: true }).press("Enter");
      await dialog.waitFor({ state: "hidden" });
      await files.click();
      if (firstFlush) await firstFlush;
      else {
        // Give a wrongly scheduled periodic flush time to send before leaving.
        await expect(
          page.waitForRequest(`${origin}/api/telemetry`, { timeout: 5500 }),
        ).rejects.toThrow("Timeout");
      }

      await openAgents();
      await opener.click();
      await dialog.waitFor();
      // Abandoning an open dialog does not count as an explicit cancel.
      await page.goto("about:blank");
      if (enabled) {
        await expect.poll(async () => (await summary(origin)).recentChains?.[0]?.length).toBe(10);
        const report = await summary(origin);
        expect(report.counts.filter((row) => row.action === action)).toEqual([
          { action, layout: "wide", outcome: "cancel", count: 1 },
          { action, layout: "wide", outcome: "confirm", count: 1 },
          { action, layout: "wide", outcome: "open", count: 3 },
        ]);
        expect(
          report.recentChains.map((chain) => chain.map((row) => [row.action, row.outcome])),
        ).toEqual([
          [
            ["sidebar.archive_toggle", "trigger"],
            ["panel.files", "trigger"],
            ["panel.agents", "trigger"],
            [action, "open"],
            [action, "cancel"],
            [action, "open"],
            [action, "confirm"],
            ["panel.files", "trigger"],
            ["panel.agents", "trigger"],
            [action, "open"],
          ],
        ]);
        expect(report.transitions).toContainEqual(
          expect.objectContaining({
            from_action: "panel.files",
            to_action: "panel.agents",
            from_layout: "wide",
            to_layout: "wide",
          }),
        );
      } else {
        expect(posts).toBe(0);
        expect(await summary(origin)).toMatchObject({ enabled: false, recentChains: [] });
        expect(readdirSync(dir).filter((name) => name.startsWith("telemetry.db"))).toEqual([]);
      }
    } finally {
      await dispose(dir, browser, server);
    }
  },
  60_000,
);

it("counts transcript and panel actions without recording destinations", async () => {
  ensureWebviewBuilt();
  const dir = mkdtempSync(join(tmpdir(), "yaat-telemetry-browser-"));
  let server: Server | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const seeded = seedDemo(dir, { quiet: true, writeConfig: true });
    const archived = loadAll(dir).find(({ id }) => id === seeded.workspaces.past)!;
    const history = loadWorkspaceMessages(dir, archived.id);
    const last = history.at(-1)!;
    const older = Array.from({ length: 50 }, (_, i) => ({
      id: `telemetry-history-${i}`,
      kind: "user" as const,
      status: "done" as const,
      agentId: null,
      timestamp: history[0].timestamp - 50 + i,
      content: `Earlier reply ${i}`,
    }));
    // The history store appends new IDs regardless of timestamp.
    saveWorkspace(dir, { ...archived, messages: [] });
    saveWorkspace(dir, {
      ...archived,
      messages: [
        ...older,
        ...history.slice(0, -1),
        {
          ...last,
          content: `${last.content}\n\n\`\`\`dot\ndigraph { sample -> result; }\n\`\`\``,
        },
      ],
    });
    closeHistory(dir);
    appendFileSync(join(dir, "config.toml"), "\n[telemetry]\nenabled = true\n");
    server = new Server(0, dir, webDir);
    const origin = `http://127.0.0.1:${await server.listening}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(10_000);
    await page.goto(origin);

    await page.locator(".messages", { hasText: "分成两件事" }).waitFor();
    await page.locator(".ws-group-project.active .ws-group-label").click();
    await page.locator(".ws-archive-toggle").click();
    await page.locator(".task-item-archived", { hasText: "parser crash" }).click();
    const { label } = seeded.fileLinks[0];
    await page.locator(".messages .file-ref", { hasText: label }).click();
    const preview = page.locator(".files-panel .code-view");
    await preview.waitFor();
    await page.getByRole("button", { name: "Close Files", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    await page.locator("nav.side-rail").getByRole("button", { name: "Files", exact: true }).click();
    await preview.waitFor();

    const chat = page.locator(".messages");
    await chat.getByRole("button", { name: "Preview diagram", exact: true }).click();
    await chat.locator(".diagram-preview svg").waitFor();
    await chat.getByRole("button", { name: "Show code", exact: true }).click();
    await chat.getByRole("button", { name: "Quote this message", exact: true }).last().click();
    await page.locator(".quote-bar-content").click();
    await chat.locator(".message-highlight").waitFor();
    await chat.evaluate((el) => {
      el.scrollTop = 0;
    });
    await chat.getByText("Beginning of conversation", { exact: true }).waitFor();
    await page.goto("about:blank");

    const actions = [
      "sidebar.archive_toggle",
      "workspace.switch",
      "chat.file_link",
      "panel.close",
      "panel.files",
      "chat.diagram_preview",
      "chat.quote_jump",
      "chat.history_page",
    ];
    await expect
      .poll(async () => (await summary(origin)).counts)
      .toEqual(
        [...actions]
          .sort()
          .map((action) => ({ action, layout: "wide", outcome: "trigger", count: 1 })),
      );
    expect(
      (await summary(origin)).recentChains.map((chain) => chain.map((row) => row.action)),
    ).toEqual([actions]);
  } finally {
    await dispose(dir, browser, server);
  }
}, 60_000);
