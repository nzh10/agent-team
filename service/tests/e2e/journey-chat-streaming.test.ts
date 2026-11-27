import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SeedDemoResult } from "../../../scripts/seed-demo";
import { loadAll, saveWorkspace } from "../../src/workspace/state";
import type { Message } from "../../src/workspace/workspace";
import { startDemoJourney } from "./demo-journey-harness";

const imageName = "journey preview.png";
const historySize = 125;
const pressureId = "journey-pressure";
const pressureBody = `Pressure result start\n${"Synthetic settled tool output.\n".repeat(35_000)}Pressure result end`;
let historyIds: string[];
let wakeId: string;
let newestCursor: number;
let fixture: Awaited<ReturnType<typeof startDemoJourney>>;
let tab: Awaited<ReturnType<typeof fixture.openPage>> | undefined;

function prepareHistory(dir: string, { workspaces }: SeedDemoResult) {
  const sessions = loadAll(dir);
  const mobile = sessions.find((session) => session.id === workspaces.mobile)!;
  const wake = sessions.find((session) => session.id === workspaces.wake)!;
  wakeId = wake.id;
  const history = wake.messages!;
  const start = history[0].timestamp - historySize;
  const older: Message[] = Array.from({ length: historySize }, (_, i) => ({
    id: `journey-older-${i}`,
    kind: "user",
    agentId: null,
    status: "done",
    timestamp: start + i,
    content: `History entry ${i}`,
  }));
  older[4] = {
    ...older[4],
    id: pressureId,
    kind: "agent",
    agentId: wake.agents[0].id,
    content: "The pressure result is ready.",
    events: [
      {
        kind: "tool_use",
        toolName: "Bash",
        toolUseId: pressureId,
        content: "**Bash** `print synthetic output`",
        contentOffset: 0,
        toolResult: pressureBody,
      },
    ],
  };
  const fullHistory = [...older, ...history];
  historyIds = fullHistory.map((m) => `msg-${m.id}`);
  newestCursor = fullHistory.at(-50)!.timestamp;
  // HistoryDb preserves sequence numbers for existing rows. Insert the
  // fixture in chronological order instead of appending the older rows.
  saveWorkspace(dir, { ...wake, messages: [] });
  saveWorkspace(dir, { ...wake, messages: fullHistory });

  writeFileSync(
    join(mobile.cwd, imageName),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  // Supplemental history is stored at the Message boundary, not as fabricated RPC frames.
  saveWorkspace(dir, {
    ...mobile,
    messages: [
      ...mobile.messages!,
      {
        id: "journey-image",
        kind: "agent",
        agentId: mobile.agents[0].id,
        content: "The preview is ready.",
        status: "done",
        timestamp: mobile.messages!.at(-1)!.timestamp + 1,
        events: [
          {
            kind: "tool_use",
            toolUseId: "journey-view-image",
            toolName: "ViewImage",
            content: `**ViewImage** \`${imageName}\``,
            toolResult: "",
            contentOffset: 0,
          },
          {
            kind: "thinking",
            content: "",
            durationMs: 1000,
            contentOffset: "The preview is ready.".length,
          },
        ],
      },
    ],
  });
}

beforeAll(async () => {
  fixture = await startDemoJourney("yaat-chat-journey-", prepareHistory);
}, 60_000);

async function open(query = "", prepare?: (page: Page) => Promise<void>) {
  tab = await fixture.openPage({
    viewport: { width: 1280, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
    timeout: 7_000,
  });
  const { page } = tab;
  await prepare?.(page);
  await page.goto(`${fixture.origin}/${query}`);
  await page
    .locator(".messages")
    .getByText(/分成两件事/)
    .waitFor();
  return page;
}

afterEach(async () => {
  if (!tab) return;
  const { page, assertClean } = tab;
  tab = undefined;
  await page.context().close();
  assertClean();
});

afterAll(async () => fixture?.close());

const worker = (page: Page, name: string) => page.locator(".task-item", { hasText: name });
const overflow = (page: Page) =>
  page.evaluate("document.documentElement.scrollWidth - window.innerWidth");

it("quotes the agent and copies a tool-linked image without overflowing the phone file bar", async () => {
  const page = await open();
  await worker(page, "mobile panels").click();
  const image = page.locator(".messages #msg-journey-image");
  await image.getByTitle("Quote this message").click();
  await page.locator('.quote-bar-agent img[alt="Perseus"]').waitFor();
  const emptyThinking = image.locator(".step-group", { hasText: "1 thinking" });
  await emptyThinking.waitFor();
  expect(await emptyThinking.getByRole("button").count()).toBe(0);
  await image.getByRole("button", { name: "Expand steps" }).click();
  await image.getByRole("button", { name: imageName }).click();
  const preview = page.locator(".files-panel .file-image img");
  await preview.waitFor();
  await page.waitForFunction(
    "document.querySelector('.files-panel .file-image img')?.naturalWidth === 1",
  );
  expect(await preview.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  const bar = page.locator(".files-panel .fp-bar");
  const copy = bar.getByTitle("Copy image");
  expect(await bar.getByTitle("Copy path").textContent()).toBe("Copy path");
  await copy.click();
  await expect.poll(() => copy.textContent()).toBe("Copied");
  expect(
    await page.evaluate<string[]>(
      "navigator.clipboard.read().then(items => items.flatMap(item => item.types))",
    ),
  ).toEqual(["image/png"]);
  await page.setViewportSize({ width: 320, height: 740 });
  // Measure the actual control boxes against their host bar at phone width.
  await expect
    .poll(() =>
      bar.evaluate((bar) => {
        const host = bar.getBoundingClientRect();
        return Array.from(bar.querySelectorAll(".fp-btn")).every((button) => {
          const rect = button.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height >= 40 &&
            rect.left >= host.left &&
            rect.right <= host.right
          );
        });
      }),
    )
    .toBe(true);
  expect(await overflow(page)).toBe(0);
}, 40_000);

it("keeps per-workspace drafts through desktop and phone navigation and selects suggestions by key", async () => {
  const page = await open();
  const composer = page.locator("textarea.chat-input");
  const mobile = worker(page, "mobile panels");
  await composer.fill("lead draft");
  await mobile.click();
  const transcript = page.locator(".messages").getByText(/sheet 头部已经改好/);
  await transcript.waitFor();
  expect(await composer.inputValue()).toBe("");
  await composer.fill("@Per");
  const mention = page.locator(".mention-popup .mention-item.active", { hasText: "Perseus" });
  await mention.waitFor();
  const model = await page.locator(".message-model").first().textContent();
  expect(model).toBeTruthy();
  expect(await mention.locator(".mention-model").textContent()).toBe(model);
  await composer.press("Enter");
  expect(await composer.inputValue()).toBe("@Perseus ");
  await page.locator(".mention-popup").waitFor({ state: "hidden" });
  await composer.fill("/cont");
  await page.locator(".command-popup .command-item.active", { hasText: "/context" }).waitFor();
  await composer.press("Tab");
  expect(await composer.inputValue()).toBe("/context ");
  await page.locator(".command-popup").waitFor({ state: "hidden" });
  expect(await overflow(page)).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator("button.mobile-menu-btn");
  const drawer = page.locator(".sidebar.sidebar-open");
  await menu.click();
  await drawer.getByText("Workspaces", { exact: true }).waitFor();
  expect(await overflow(page)).toBe(0);
  await page.locator(".sidebar-overlay:not(.closing)").click({ position: { x: 380, y: 400 } });
  await page.locator(".sidebar-overlay").waitFor({ state: "hidden" });
  await menu.click();
  await drawer.locator(".ws-group-project").click();
  await page
    .locator(".messages")
    .getByText(/分成两件事/)
    .waitFor();
  await drawer.waitFor({ state: "hidden" });
  expect(await composer.inputValue()).toBe("lead draft");
  await composer.press("End");
  await composer.pressSequentially(" on phone");
  expect(await composer.inputValue()).toBe("lead draft on phone");
  await menu.click();
  await mobile.click();
  await transcript.waitFor();
  await drawer.waitFor({ state: "hidden" });
  expect(await composer.inputValue()).toBe("/context ");
  expect(await overflow(page)).toBe(0);
}, 40_000);

it("reads every history window, preserves the reconnect anchor and restores evicted history", async () => {
  let detailRequests = 0;
  let returning = false;
  let resumeNewest: (() => void) | undefined;
  const cursors: unknown[] = [];
  const frame = (raw: Buffer | string) => JSON.parse(raw.toString()) as Record<string, unknown>;
  const page = await open("", (page) =>
    page.routeWebSocket(`ws://${new URL(fixture.origin).host}/`, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((raw) => {
        const { type, workspaceId, before, messageId } = frame(raw);
        if (type === "load_message_details" && messageId === pressureId) detailRequests++;
        if (returning && workspaceId === wakeId && type === "load_messages") {
          // Hold the routine newest request so it cannot mask the evicted state.
          if (cursors.push(before) === 1 && before == null) {
            resumeNewest = () => upstream.send(raw);
            return;
          }
        }
        upstream.send(raw);
      });
    }),
  );
  const wake = worker(page, "wake-up time");
  await wake.click();
  const messages = page.locator(".messages");
  const older = messages.getByText("Scroll up for older messages");
  const loaded = (n: number) => messages.locator(`[data-loaded-messages="${n}"]`).waitFor();
  const settle = () =>
    page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const readRows = () =>
    messages.evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      return Array.from(
        el.querySelectorAll<HTMLElement>("[data-transcript-row] [id^=msg-]"),
        (row) => {
          const rect = row.getBoundingClientRect();
          return {
            id: row.id,
            text: row.innerText,
            top: rect.top - viewport.top,
            visible: rect.bottom > viewport.top && rect.top < viewport.bottom,
          };
        },
      );
    });
  type Row = Awaited<ReturnType<typeof readRows>>[number];
  const visible = async () => (await readRows()).filter((row) => row.visible);
  const contents = (rows: Row[]) => rows.map(({ id, text }) => ({ id, text }));
  const expectSameView = (actual: Row[], expected: Row[]) => {
    expect(contents(actual)).toEqual(contents(expected));
    for (const [i, row] of actual.entries())
      expect(Math.abs(row.top - expected[i].top), row.id).toBeLessThanOrEqual(3);
  };
  const scroll = (next: boolean) =>
    messages.evaluate((el, next) => {
      el.scrollTop = next ? el.scrollTop + Math.floor(el.clientHeight * 0.75) : 0;
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    }, next);
  const clipAnchor = (anchor: Locator) =>
    anchor.evaluate((row) => {
      const host = row.closest(".messages")!;
      host.scrollTop += row.getBoundingClientRect().top - host.getBoundingClientRect().top + 12;
    });
  const newestVisible = async () => {
    await older.waitFor();
    await loaded(50);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await settle();
    const onScreen = await visible();
    expect(onScreen.at(-1)?.id).toBe(historyIds.at(-1));
    return onScreen;
  };
  const newest = await newestVisible();
  await page.waitForFunction("document.querySelector('.messages').scrollTop >= 80");
  // The true first row is initially in a spacer, immediately after the hint.
  const before = await messages.evaluate(
    (el) =>
      el.querySelector(".history-hint")!.getBoundingClientRect().bottom -
      el.getBoundingClientRect().top +
      el.scrollTop,
  );
  await scroll(false);
  await loaded(100);
  await expect
    .poll(async () => {
      const row = (await readRows()).find(({ id }) => id === historyIds.at(-50));
      return Math.abs((row?.top ?? Infinity) - before);
    })
    .toBeLessThanOrEqual(3);
  await scroll(false);
  await loaded(historyIds.length);
  await scroll(false);
  await clipAnchor(messages.locator(`#${historyIds[0]}`));
  await settle();
  const oldest = await visible();
  expect(oldest[0]?.id).toBe(historyIds[0]);
  expect(oldest[0].top).toBeLessThan(0);

  // Close only the scratch server's browser connections, not the server or its history.
  const reconnect = page.waitForEvent("websocket").then((socket) =>
    socket.waitForEvent("framereceived", {
      predicate: ({ payload }) => {
        const { type, workspaceId } = frame(payload);
        return type === "workspace_messages" && workspaceId === wakeId;
      },
      timeout: 7_000,
    }),
  );
  for (const socket of fixture.server["wss"].clients) socket.close(1000, "Journey reconnect");
  await reconnect;
  await settle();
  await loaded(historyIds.length);
  expectSameView(await visible(), oldest);

  const seen: string[] = [];
  for (let step = 0; seen.length < historyIds.length; step++) {
    expect(step).toBeLessThan(historyIds.length);
    const mounted = (await readRows()).map(({ id }) => id);
    const start = historyIds.indexOf(mounted[0]);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(mounted).toEqual(historyIds.slice(start, start + mounted.length));
    expect(mounted.length).toBeLessThanOrEqual(45);
    if (step) expect(start).toBeLessThan(seen.length);
    seen.push(...mounted.slice(seen.length - start));
    await scroll(true);
    await settle();
  }
  expect(seen).toEqual(historyIds);
  await page.getByRole("button", { name: /Jump to latest/ }).click();
  expect((await visible()).at(-1)?.id).toBe(historyIds.at(-1));
  await scroll(false);
  const pressure = messages.locator(`#msg-${pressureId}`);
  const output = pressure.locator(".event-result code");
  const openPressure = async () => {
    await pressure.getByRole("button", { name: "Expand steps" }).click();
    expect(await output.count()).toBe(0);
    await pressure.getByRole("button", { name: /^Result ·/ }).click();
    await expect
      .poll(() => output.evaluate((el, expected) => el.textContent === expected, pressureBody))
      .toBe(true);
  };
  expect(Buffer.byteLength(pressureBody)).toBeGreaterThan(1024 * 1024);
  await openPressure();
  expect(detailRequests).toBe(1);
  await pressure.getByRole("button", { name: "Collapse step trace" }).click();
  await clipAnchor(pressure);
  await settle();
  const anchor = (await visible())[0];
  expect(anchor.id).toBe(`msg-${pressureId}`);
  expect(anchor.top).toBeLessThan(0);
  await worker(page, "mobile panels").click();
  await messages.getByText(/sheet 头部已经改好/).waitFor();
  returning = true;
  await wake.click();
  await messages.getByText("Loading conversation…", { exact: true }).waitFor();
  expect(await messages.locator("[data-loaded-messages]").count()).toBe(0);
  expect(await pressure.count()).toBe(0);
  resumeNewest!();
  await loaded(historyIds.length);
  await settle();
  const restored = (await visible())[0];
  expect(restored?.id).toBe(anchor.id);
  expect(Math.abs(restored.top - anchor.top)).toBeLessThanOrEqual(3);
  expect(cursors).toEqual([undefined, newestCursor]);
  returning = false;
  await openPressure();
  expect(detailRequests).toBe(2);

  await page.reload();
  expectSameView(await newestVisible(), newest);
  await page.locator(".search-bar input").fill("History entry 0");
  await page.locator(".search-result-item", { hasText: "History entry 0" }).click();
  await messages.locator("#msg-journey-older-0.message-highlight").waitFor();
}, 40_000);

// Replay Demo runs in the browser; only the seeded conversations above survive a reload.
it("streams Replay Demo and expands and collapses thinking and completed subagent traces", async () => {
  const page = await open("?debug=1&demoSpeed=3");
  await page.getByRole("button", { name: "Replay demo", exact: true }).click();
  await worker(page, "Replay Demo").click();
  const turn = page.locator("#msg-demo-layout-turn");
  // Use the first, longer streaming turn for liveness. Short thinking phases
  // and their exact timing are tested with a controlled clock in Browser Mode.
  await page.locator("#msg-demo-msg-1 .streaming-dot").waitFor({ state: "attached" });
  await page.waitForFunction("window.__yaatDemoReplay?.done === true", undefined, {
    timeout: 25_000,
  });
  const thinking = turn.locator(".step-group", { hasText: "1 thinking" });
  await thinking.getByRole("button", { name: "Expand steps" }).click();
  await thinking.getByText(/The geometry should stay the same/).waitFor();
  await thinking.getByRole("button", { name: "Collapse step trace" }).click();
  await thinking.getByText(/The geometry should stay the same/).waitFor({ state: "hidden" });

  const card = page.locator(".subagent-item", { hasText: "Search the syntax module" });
  await card.getByTitle("completed", { exact: true }).waitFor();
  expect(await card.getByTitle("Cancel this subagent").count()).toBe(0);
  await card.getByRole("button", { name: "Expand subagent: Search the syntax module" }).click();
  const details = card.locator(":scope > .subagent-details");
  await details.getByText("Found 2 mutation sites, verifying callers now.").waitFor();
  await card.locator(".subagent-time", { hasText: /^21s$/ }).waitFor();
  await details.getByRole("button", { name: "Collapse subagent trace" }).click();
  await details.waitFor({ state: "detached" });
}, 50_000);
