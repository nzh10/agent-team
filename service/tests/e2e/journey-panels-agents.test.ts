/// <reference lib="dom" />

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SeedDemoResult } from "../../../scripts/seed-demo";
import * as codex from "../../src/session/codex";
import { recordUsage } from "../../src/usage/ledger";
import { LocalHost } from "../../src/session/host";
import { runDemoJourney } from "./demo-journey-harness";

const alpha = "journey/alpha";
const beta = "journey/beta";
const source = "const first = 1;\nconst second = 2;\nconst third = 3;\n";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
  "base64",
);

beforeEach(() => {
  // Stub only external discovery; agent settings and storage use real HTTP and WebSocket.
  vi.spyOn(codex, "probeCodexAuth").mockResolvedValue({
    cliAvailable: false,
    authenticated: false,
    status: "unavailable",
    checkedAt: 0,
  });
});

afterEach(() => vi.restoreAllMocks());

function prepareModels({ baseDir }: SeedDemoResult) {
  vi.spyOn(LocalHost.prototype, "discoverPiModels").mockResolvedValue([
    {
      id: alpha,
      provider: "journey",
      modelId: "alpha",
      name: "Alpha",
      effortLevels: ["low", "high"],
    },
    {
      id: beta,
      provider: "journey",
      modelId: "beta",
      name: "Beta",
      effortLevels: ["low", "high", "max"],
    },
  ]);
  appendFileSync(
    join(baseDir, "config.toml"),
    `
[pi]
offline = true

[[agent_presets]]
name = "Reader"
avatar = "R"
color = "#006699"
model = "${alpha}"
effort = "low"

[[agent_presets]]
name = "Reviewer"
avatar = "V"
color = "#884499"
model = "${beta}"
effort = "max"
`,
  );
}

function journey(
  run: (page: Page, seed: SeedDemoResult) => Promise<void>,
  prepare?: (seed: SeedDemoResult) => void,
) {
  return runDemoJourney(
    "yaat-panels-",
    {
      viewport: { width: 1440, height: 900 },
      timeout: 8_000,
      ignoreConsoleError: (message, origin) => {
        // The missing-file journey asserts the HTTP status and recovery itself.
        const url = message.location().url;
        return (
          url.startsWith(`${origin}/api/file?`) &&
          /[\\/]missing\.ts$/.test(new URL(url).searchParams.get("path") ?? "") &&
          message.text().startsWith("Failed to load resource:") &&
          message.text().includes("404")
        );
      },
    },
    async (page, { origin, seed }) => {
      await page.goto(origin);
      await page.locator(".ws-group-project").click();
      await transcript(page, "分成两件事");
      await run(page, seed);
    },
    (_dir, seed) => prepare?.(seed),
  );
}

const rail = (page: Page, name: string) =>
  page.locator("nav.side-rail").getByRole("button", { name, exact: true });
const transcript = (page: Page, marker: string) =>
  page.locator(".messages", { hasText: marker }).waitFor();
const worker = (page: Page, name: string) => page.locator(".task-item", { hasText: name });
const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

it("opens the usage ledger and reopens the same observation after reload", async () => {
  await journey(
    async (page) => {
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        const [overview] = await Promise.all([
          page.waitForResponse((res) => new URL(res.url()).pathname === "/api/usage/overview"),
          page.getByRole("button", { name: "Usage", exact: true }).click(),
        ]);
        expect(await overview.json()).toMatchObject({
          count: 1,
          cacheRead: 143166,
          input: 23325,
          unpriced: 1,
          ranking: [{ model: "offline-acceptance-model", tokens: 166698 }],
        });
        const dashboard = page.getByRole("dialog", { name: "Usage dashboard" });
        await expect.poll(() => dashboard.locator('svg[role="img"]').count()).toBe(2);
        const [journey] = await Promise.all([
          page.waitForResponse((res) => new URL(res.url()).pathname === "/api/usage/journey"),
          dashboard.getByRole("button", { name: "Records", exact: true }).click(),
        ]);
        expect(await journey.json()).toMatchObject({
          total: 1,
          page: 1,
          pageSize: 30,
          rows: [{ id: "70", cacheRead: 143166, model: "offline-acceptance-model-high" }],
          nextCursor: null,
        });
        await dashboard
          .getByText("offline-acceptance-model-high", { exact: true })
          .first()
          .waitFor();
        const [refreshed] = await Promise.all([
          page.waitForResponse((res) => {
            const url = new URL(res.url());
            return url.pathname === "/api/usage/journey" && url.searchParams.get("refresh") === "1";
          }),
          dashboard.getByRole("button", { name: "Refresh", exact: true }).click(),
        ]);
        expect(await refreshed.json()).toMatchObject({ page: 1, total: 1, sourcesPending: false });
      }
    },
    ({ baseDir }) =>
      recordUsage(baseDir, {
        source: "acp",
        unit: "inference",
        id: "70",
        sessionId: "offline-acp",
        timestamp: Date.now() - 1000,
        model: "offline-acceptance-model-high",
        input: 23325,
        cacheRead: 143166,
        cacheWrite: 0,
        output: 207,
        price: { kind: "unpriced", usd: null },
      }),
  );
}, 45_000);

it("browses workspace files, quotes real selected lines, and recovers from a missing file", async () => {
  await journey(
    async (page, { worktrees }) => {
      await rail(page, "Agents and sessions").click();
      const agentsPanel = page.getByRole("complementary", { name: "Agents", exact: true });
      await expect
        .poll(() => agentsPanel.evaluate((el) => el === document.activeElement))
        .toBe(true);
      await page.getByRole("button", { name: /Unfold .*lead/i }).click();
      await page.getByRole("button", { name: "+ Agent", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add Agent" });
      await dialog.getByText("No models available").waitFor({ state: "attached" });
      expect(await dialog.getByRole("button", { name: "Add", exact: true }).isDisabled()).toBe(
        true,
      );
      expect(
        await dialog.getByRole("textbox").evaluate((el) => el === document.activeElement),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await agentsPanel.waitFor();

      await worker(page, "mobile panels").click();
      await transcript(page, "sheet 头部已经改好");
      await rail(page, "Files").click();
      const panel = page.locator(".files-panel");
      const entry = (name: string) =>
        panel.locator(".dir-entry-name").getByText(name, { exact: true });
      const up = panel.getByTitle("Parent folder");
      // Directory names also include a visual slash.
      await panel.getByRole("button", { name: /^journey files\// }).click();
      await panel.getByRole("button", { name: /^nested\// }).click();
      await entry("sample.ts").waitFor();
      expect(await entry("..").count()).toBe(0);
      await entry("sample.ts").click();
      const code = panel.locator(".code-text");
      await code.locator(".hljs-keyword", { hasText: "const" }).first().waitFor();
      expect(await panel.locator(".code-gutter").textContent()).toBe("1\n2\n3");
      expect(await code.textContent()).toBe(source);
      expect(await panel.locator(".fp-path").textContent()).toBe("journey files/nested/sample.ts");

      const ask = panel.getByTitle("Ask about these lines in the chat");
      const composer = page.locator("textarea").first();
      await composer.fill("Explain this:");
      const select = (start: number, end: number) =>
        code.evaluate(
          (el, offsets) => {
            const at = (offset: number): [Node, number] => {
              const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              for (let node = walk.nextNode(); node; node = walk.nextNode()) {
                const length = node.textContent!.length;
                if (offset <= length) return [node, offset];
                offset -= length;
              }
              throw new Error("Selection extends past the source");
            };
            const range = document.createRange();
            range.setStart(...at(offsets[0]));
            range.setEnd(...at(offsets[1]));
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
          },
          [start, end],
        );
      await select(1, 4);
      await panel.getByRole("button", { name: "Ask · L1", exact: true }).waitFor();
      await select(18, 42);
      await panel.getByRole("button", { name: "Ask · L2–3", exact: true }).waitFor();
      await code.evaluate(() => window.getSelection()!.removeAllRanges());
      await ask.waitFor({ state: "hidden" });
      for (const area of ["body", ".messages"]) {
        await select(18, 42);
        await ask.waitFor();
        await page.locator(area).evaluate((el) => window.getSelection()!.selectAllChildren(el));
        await ask.waitFor({ state: "hidden" });
      }
      await select(18, 42);
      await ask.click();
      await ask.waitFor({ state: "hidden" });
      const quotePath =
        process.platform === "win32"
          ? join(worktrees.mobilePanels, "journey files", "nested", "sample.ts")
          : "journey files/nested/sample.ts";
      expect(await composer.inputValue()).toBe(
        `Explain this:\n\n\`${quotePath}:2-3\`\n\`\`\`typescript\nconst second = 2;\nconst third = 3;\n\`\`\`\n`,
      );

      await up.click();
      await entry("preview.png").click();
      const img = panel.getByRole("img", { name: /preview\.png$/ });
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        panel.getByRole("link", { name: "Raw" }).click(),
      ]);
      await popup.waitForLoadState();
      expect(new URL(popup.url()).pathname).toBe("/api/file/raw");
      await expect
        .poll(() => popup.locator("img").evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBe(1);
      await popup.close();
      await up.click();
      await entry("broken.md").click();
      await panel.getByRole("button", { name: "Source", exact: true }).click();
      await panel.locator(".code-text", { hasText: "missing.ts#L2" }).waitFor();
      await panel.getByRole("button", { name: "Preview", exact: true }).click();
      const missing = page.getByText("missing.ts:2", { exact: true });
      const [response] = await Promise.all([
        page.waitForResponse(
          (res) => new URL(res.url()).pathname === "/api/file" && res.url().includes("missing.ts"),
        ),
        missing.press("Enter"),
      ]);
      expect(response.status()).toBe(404);
      await panel.getByText("No such file or directory").waitFor();
      await up.click();
      await entry("sample.ts").waitFor();

      await page.getByTitle("Maximise over the chat").click();
      await page.getByTitle("Back beside the chat").waitFor();
      await worker(page, "wake-up time").click();
      await transcript(page, "noteSchedule");
      await page.getByTitle("Maximise over the chat").waitFor();
      await entry("WAKE-TIME.md").waitFor();
      await entry("sample.ts").waitFor({ state: "hidden" });
    },
    ({ worktrees }) => {
      const nested = join(worktrees.mobilePanels, "journey files", "nested");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "sample.ts"), source);
      writeFileSync(join(nested, "preview.png"), png);
      writeFileSync(join(nested, "broken.md"), "Open [missing.ts:2](missing.ts#L2).\n");
    },
  );
}, 45_000);

it("counts and quotes real tracked and untracked diff lines", async () => {
  let removed: string;
  const css = "webview/src/styles.css";
  const added = "/* synthetic replacement */";
  await journey(
    async (page) => {
      await worker(page, "mobile panels").click();
      await transcript(page, "sheet 头部已经改好");
      await rail(page, "Files").click();
      const panel = page.locator(".files-panel");
      await panel.locator(".dir-view").waitFor();
      await panel.getByTitle("Changes against the base branch").click();
      const modified = panel.getByTitle(css, { exact: true });
      const untracked = panel.getByTitle("NOTES.md", { exact: true });
      await untracked.waitFor();
      expect(await untracked.locator(".change-status").textContent()).toBe("U");
      expect(await modified.locator(".change-status").textContent()).toBe("M");
      expect(await panel.locator(".changes-head").textContent()).toMatch(
        /^(against .+|not committed) · 2 files$/,
      );
      expect((await panel.locator(".fp-bar .change-count").textContent())?.trim()).toBe("+6 −1");
      await modified.click();
      const deleted = panel.locator(".diff-del").filter({ hasText: removed });
      const replacement = panel.locator(".diff-add").filter({ hasText: added });
      await deleted.waitFor();
      await replacement.locator(".diff-code .hljs-comment").waitFor();
      expect((await panel.locator(".fp-bar .change-count").textContent())?.trim()).toBe("+3 −1");
      expect(await deleted.locator(".diff-num").allTextContents()).toEqual(["1", ""]);
      expect(await replacement.locator(".diff-num").allTextContents()).toEqual(["", "1"]);
      const first = deleted.locator(".diff-code");
      const last = replacement.locator(".diff-code");
      const end = await last.elementHandle();
      await first.evaluate((start, end) => {
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(end, end.childNodes.length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
      }, end);
      const ask = panel.getByRole("button", { name: "Ask · L1", exact: true });
      await ask.click();
      expect(await page.locator("textarea").first().inputValue()).toContain(
        `styles.css:1\`\n\`\`\`diff\n-${removed}\n+${added}\n\`\`\``,
      );
      await panel.getByTitle("All changes").click();
      await untracked.click();
      await expect
        .poll(async () => (await panel.locator(".fp-bar .change-count").textContent())?.trim())
        .toBe("+3");
      await panel.getByTitle("All changes").click();
      await panel.getByTitle("Files", { exact: true }).click();
      await panel.locator(".dir-entry", { hasText: "package.json" }).waitFor();
    },
    ({ worktrees }) => {
      const file = join(worktrees.mobilePanels, css);
      const contents = readFileSync(file, "utf8");
      removed = contents.split(/\r?\n/, 1)[0]!;
      writeFileSync(file, contents.replace(/^[^\r\n]*/, added));
    },
  );
}, 45_000);

it("uses lead and worker agent cards to manage an agent with destructive confirmations", async () => {
  await journey(async (page) => {
    const agents = rail(page, "Agents and sessions");
    await agents.click();
    await page.locator(".agents-panel").waitFor();
    expect(await page.locator(".agents-panel .ap-agent").count()).toBe(0);
    expect(await page.locator(".side-panel-sub").textContent()).toBe(
      "agent-team · 4 sessions · idle",
    );
    const mobile = card(page, "mobile panels");
    const wake = card(page, "wake-up time");
    const fold = mobile.getByRole("button", { name: "Fold mobile panels", exact: true });
    const unfold = mobile.getByRole("button", { name: "Unfold mobile panels", exact: true });
    await unfold.click();
    const usage = mobile
      .locator(".ap-agent", { has: page.getByText("Perseus", { exact: true }) })
      .locator(".ap-context");
    await usage.waitFor();
    expect(await usage.textContent()).toMatch(/\S+ \/ 1M/);
    await fold.click();
    await usage.waitFor({ state: "hidden" });
    await unfold.click();
    const add = mobile.getByRole("button", { name: "+ Agent", exact: true });
    const dialog = page.getByRole("dialog", { name: "Add Agent" });
    const name = dialog.getByRole("textbox", { name: "Name (or use preset)" });
    const model = dialog.getByLabel("Model", { exact: true });
    const effort = dialog.getByLabel("Reasoning effort");
    await add.click();
    await expect.poll(() => model.inputValue()).toBe(alpha);
    expect(await effort.inputValue()).toBe("low");
    await dialog.getByText("Reviewer", { exact: true }).click();
    expect(await name.getAttribute("placeholder")).toBe("Reviewer");
    expect(await model.inputValue()).toBe(beta);
    expect(await effort.inputValue()).toBe("max");
    await model.selectOption(alpha);
    expect(await effort.inputValue()).toBe("");
    await effort.selectOption("high");
    await model.selectOption(beta);
    expect(await effort.inputValue()).toBe("high");
    await name.fill("Journey reviewer");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const custom = mobile.getByText("Journey reviewer", { exact: true });
    expect(await custom.count()).toBe(0);

    await add.click();
    await name.fill("Journey reviewer");
    await model.selectOption(beta);
    await effort.selectOption("high");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await custom.waitFor();
    const reviewerModel = mobile.getByLabel("Journey reviewer's model");
    expect(await reviewerModel.inputValue()).toBe(beta);
    expect(await reviewerModel.locator("option").allTextContents()).toEqual(["alpha", "beta"]);
    expect(await mobile.getByLabel("Journey reviewer's reasoning effort").inputValue()).toBe(
      "high",
    );

    await page.getByTitle("Maximise over the chat").click();
    await page.getByTitle("Back beside the chat").waitFor();
    await mobile.getByTitle("Open this session").click();
    await transcript(page, "Journey reviewer joined the team");
    await page.getByTitle("Maximise over the chat").waitFor();
    await fold.waitFor();
    await wake.waitFor({ state: "hidden" });
    expect(await page.locator(".side-panel-sub").textContent()).toBe(
      "mobile panels · 2 agents · idle",
    );
    const agentModel = mobile.getByLabel("Journey reviewer's model");
    const agentEffort = mobile.getByLabel("Journey reviewer's reasoning effort");
    await agentModel.selectOption(alpha);
    await transcript(page, "Journey reviewer moves from Beta to Alpha");
    await expect.poll(() => agentModel.inputValue()).toBe(alpha);
    await agentEffort.selectOption("low");
    await transcript(page, "/effort low");
    await expect.poll(() => agentEffort.inputValue()).toBe("low");

    const clear = mobile.getByRole("button", { name: "Clear Perseus's context", exact: true });
    const clearDialog = page.getByRole("dialog", { name: "Clear Perseus's context?" });
    await clear.click();
    await clearDialog.getByRole("button", { name: "Cancel" }).click();
    expect(
      await page
        .locator(".messages")
        .getByText(/context cleared/)
        .count(),
    ).toBe(0);
    await usage.waitFor();
    await clear.click();
    await clearDialog.getByRole("button", { name: "Clear context", exact: true }).click();
    await transcript(page, "Perseus context cleared");
    await expect.poll(() => usage.count()).toBe(0);

    const remove = mobile.getByRole("button", { name: "Remove Journey reviewer", exact: true });
    const removeDialog = page.getByRole("dialog", { name: "Remove Journey reviewer?" });
    await remove.click();
    await removeDialog.getByRole("button", { name: "Cancel" }).click();
    await custom.waitFor();
    await remove.click();
    await removeDialog.getByRole("button", { name: "Remove agent", exact: true }).click();
    await transcript(page, "Journey reviewer left the team");
    await custom.waitFor({ state: "hidden" });
    expect(
      await page
        .locator(".messages")
        .getByText(/Perseus context cleared/)
        .count(),
    ).toBe(1);

    await page.locator(".ws-group-project").click();
    await transcript(page, "分成两件事");
    await wake.getByTitle("Open this session").click();
    await transcript(page, "noteSchedule");
    await wake.getByRole("button", { name: "Fold wake-up time", exact: true }).waitFor();
    await mobile.waitFor({ state: "hidden" });
  }, prepareModels);
}, 45_000);

it("sets the theme before app startup and preserves the workspace across theme changes", async () => {
  await journey(async (page) => {
    const origin = new URL(page.url()).origin;
    const browser = page.context().browser()!;
    for (const mobile of [false, true]) {
      const system = mobile ? "dark" : "light";
      const opposite = mobile ? "light" : "dark";
      const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
      const context = await browser.newContext({ viewport, colorScheme: system, hasTouch: mobile });
      try {
        const tab = await context.newPage();
        const manifest = await tab.request.get(`${origin}/manifest.webmanifest`);
        expect(await manifest.json()).toMatchObject({ theme_color: "#f2f2f2" });
        const entry = "**/assets/index-*.js";
        const bootstrap = async (theme: "light" | "dark") => {
          let resume!: () => void;
          const bundleReady = new Promise<void>((resolve) => {
            resume = resolve;
          });
          await tab.route(entry, async (route) => {
            await bundleReady;
            await route.continue();
          });
          try {
            await tab.goto(origin, { waitUntil: "commit" });
            await tab.waitForFunction(
              (value) => document.documentElement.dataset.theme === value,
              theme,
            );
            expect(await tab.locator("#root .app").count()).toBe(0);
            const early = await tab.evaluate(() => ({
              scheme: document.documentElement.style.colorScheme,
              chrome: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
            }));
            expect(early.scheme).toBe(theme);
            expect(early.chrome).toBe(theme === "dark" ? "#141416" : "#f2f2f2");
          } finally {
            resume();
            await tab.unrouteAll({ behavior: "wait" });
          }
          await tab.locator(".ws-group-project").waitFor({ state: "attached" });
        };
        const openDrawer = async () => {
          if (mobile) await tab.getByRole("button", { name: /^Open workspace menu/ }).click();
        };
        const toggle = tab.getByRole("button", { name: "Dark theme" });
        const applied = async (theme: "light" | "dark") => {
          await expect
            .poll(() => toggle.getAttribute("aria-pressed"))
            .toBe(String(theme === "dark"));
          const colors = await tab.evaluate(() => ({
            applied: document.documentElement.dataset.theme,
            scheme: getComputedStyle(document.documentElement).colorScheme,
            meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
            chrome: getComputedStyle(document.documentElement)
              .getPropertyValue("--bg-secondary")
              .trim(),
          }));
          expect(colors).toEqual({
            applied: theme,
            scheme: theme,
            meta: colors.chrome,
            chrome: colors.chrome,
          });
        };

        await bootstrap(system);
        await openDrawer();
        await tab.locator(".ws-group-project").click();
        await transcript(tab, "分成两件事");
        await openDrawer();
        await applied(system);
        await tab.evaluate(() => document.fonts.ready.then(() => undefined));
        const geometry = () =>
          tab.evaluate(() =>
            [".messages", ".input-row", ".ws-group-project"].map((selector) => {
              const { width, height } = document.querySelector(selector)!.getBoundingClientRect();
              return [width, height];
            }),
          );
        const before = await geometry();
        await tab.emulateMedia({ colorScheme: opposite });
        await applied(opposite);
        await toggle.click();
        await applied(system);
        expect(await geometry()).toEqual(before);
        await transcript(tab, "分成两件事");
        // Both explicit choices win over the opposite OS setting at startup.
        for (const choice of [system, opposite] as const) {
          if (choice === opposite) await toggle.click();
          await tab.emulateMedia({ colorScheme: choice === system ? opposite : system });
          await applied(choice);
          await bootstrap(choice);
          await openDrawer();
          await applied(choice);
          await transcript(tab, "分成两件事");
        }
      } finally {
        await context.close();
      }
    }
  });
}, 45_000);
