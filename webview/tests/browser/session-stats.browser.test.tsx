import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { SessionStatsPage, StatsTurn } from "../../../shared/session-stats";
import type { TelemetryBatch } from "../../../shared/telemetry";
import { SessionStats } from "../../src/panels/SessionStats";
import { App } from "../../src/App";
import { buildFrames, DEMO_WS_ID } from "../../src/dev/replayFixture";
import type { Project, Workspace } from "../../src/state/useServer";
import { configureTelemetry } from "../../src/telemetry";
import { FakeSocket, initFrame } from "../fakeSocket";
import { deferred } from "../helpers/deferred";
import { project, workspace as makeWorkspace } from "../helpers/fixtures";
import "../../src/styles.css";

const workspace = (id: string, name: string) => makeWorkspace(id, { name });
const ws = workspace("local:primary", "Primary workspace");
const other = workspace("other", "Other workspace");
const statsUrl = (id: string, offset = 0) =>
  `api/workspaces/${encodeURIComponent(id)}/stats?offset=${offset}&limit=20`;
const compactedAt = Date.UTC(2026, 9, 1, 12, 30);
const longModel = `provider/${"long-model-name".repeat(8)}`;
const turns = Array.from({ length: 21 }, (_, index): StatsTurn => ({
  turnId: index === 20 ? "turn-21" : `turn-${21 - index}`,
  ...(index === 0 ? { key: "parent-turn-21", source: "pi", sessionId: "parent-session" } : {}),
  ...(index === 20 ? { key: "child-turn-21", source: "pi", sessionId: "child-session" } : {}),
  trigger: index === 0 ? "manual" : "wake",
  steps:
    index === 0
      ? [
          { stepId: "user", kind: "user", trigger: "steer" },
          {
            stepId: "model",
            kind: "model",
            model: longModel,
            inferenceId: "inference-1",
            promptTokens: 300,
            promptDelta: 0,
            stepStart: 1000,
            firstDelta: 1125,
            stepEnd: 2000,
          },
          { stepId: "legacy-model", kind: "model", boundary: "gap" },
          {
            stepId: "tool",
            kind: "tool",
            toolCallId: "tool-1",
            toolStart: 2000,
            toolResult: 2150,
          },
          {
            stepId: "compact",
            kind: "compaction",
            compaction: compactedAt,
          },
          { stepId: "after-compaction", kind: "model", boundary: "compaction" },
          {
            stepId: "after-switch",
            kind: "model",
            model: "provider/next",
            boundary: "model switch",
          },
        ]
      : [],
}));
const statsPage = (offset: number) =>
  Response.json({
    turns: turns.slice(offset, offset + 20),
    total: turns.length,
    offset,
    limit: 20,
  } satisfies SessionStatsPage);

function connect(
  sock: FakeSocket,
  workspaces: Workspace[],
  telemetryEnabled = false,
  projects: Project[] = [],
) {
  act(() => {
    sock.open();
    sock.receive(
      initFrame(workspaces, {
        projects,
        config: { presets: [], models: [], hosts: {}, telemetryEnabled },
      }),
    );
  });
}

function boot(workspaces: Workspace[] = [ws], telemetryEnabled = false, projects: Project[] = []) {
  localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  render(<App />, { container: root });
  const sock = FakeSocket.instances.at(-1)!;
  connect(sock, workspaces, telemetryEnabled, projects);
  return sock;
}

afterEach(() => {
  cleanup();
  configureTelemetry(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it.each([
  { width: 1440, rail: "side-rail", layout: "wide" },
  { width: 390, rail: "header-rail", layout: "narrow" },
])(
  "opens stats from $rail, expands turns and loads older stats on $layout",
  async ({ width, rail, layout }) => {
    await page.viewport(width, 820);
    const fetchStats = vi.fn((url: string) =>
      Promise.resolve(
        url === statsUrl(ws.id)
          ? statsPage(0)
          : url === statsUrl(ws.id, 20)
            ? statsPage(20)
            : new Response(null, { status: 404 }),
      ),
    );
    const batches: Promise<TelemetryBatch>[] = [];
    const capture = (body: Blob | string) => {
      const text = typeof body === "string" ? Promise.resolve(body) : body.text();
      batches.push(text.then((value) => JSON.parse(value) as TelemetryBatch));
    };
    vi.stubGlobal("fetch", (url: string, options?: RequestInit) => {
      if (url.startsWith("api/workspaces/")) return fetchStats(url);
      if (url === "api/telemetry") capture(options?.body as string);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    // Exercise mixed transports deterministically: reject the first final flush,
    // so the browser's keepalive POST carries that batch instead.
    vi.spyOn(navigator, "sendBeacon")
      .mockImplementation((url, blob) => {
        expect(url).toBe("api/telemetry");
        capture(blob as Blob);
        return true;
      })
      .mockReturnValueOnce(false);
    if (layout === "narrow") {
      const linked: Workspace = {
        ...ws,
        projectLink: { projectId: "p", role: "lead" },
        git: { branch: "feature/stats-inspector", dirty: 0, ahead: 0, behind: 0 },
        pr: {
          number: 1234,
          url: "https://example.test/pull/1234",
          title: "Stats inspector",
          state: "open",
          draft: false,
          checks: "success",
        },
      };
      boot([linked], true, [project("p", { leadWorkspaceId: ws.id, status: "sealed" })]);
    } else boot([ws], true);
    expect(fetchStats).not.toHaveBeenCalled();

    const opener = page.elementLocator(document.querySelector(`.${rail}`)!).getByRole("button", {
      name: "Session stats",
    });
    expect(opener.element().getBoundingClientRect().right).toBeLessThanOrEqual(width);
    await opener.click();
    await expect.element(opener).toHaveAttribute("aria-pressed", "true");
    const panel = page.getByRole("complementary", { name: "Session stats" });
    await expect.element(panel.getByText("20 of 21 turns · Newest first")).toBeVisible();
    window.dispatchEvent(new Event("pagehide"));
    expect(batches).toHaveLength(1);
    const bounds = panel.element().getBoundingClientRect();
    expect(bounds.right).toBeLessThanOrEqual(width);
    if (layout === "narrow") expect(bounds.width).toBe(width);
    else expect(bounds.width).toBeLessThan(width);

    const newest = panel.getByText("Turn 21 · manual · 7 steps", { exact: true });
    expect(panel.element().querySelector("summary")).toBe(newest.element());
    await expect.element(panel.getByText("Observed timing:", { exact: true })).toBeVisible();
    await expect
      .element(
        panel.getByText(
          "Durations are based on server-observed lifecycle events, not provider billing latency.",
        ),
      )
      .toBeVisible();
    await expect.element(panel.getByText("turn-21", { exact: true })).not.toBeVisible();
    await newest.click();
    await expect.element(panel.getByText("turn-21", { exact: true })).toBeVisible();
    await expect.element(panel.getByText("pi", { exact: true })).toBeVisible();
    await expect.element(panel.getByText("parent-session", { exact: true })).toBeVisible();
    const steps = panel.element().querySelectorAll(".session-stats-step");
    const list = steps[0].closest("ol")!;
    const turn = list.parentElement!;
    const inside = turn.getBoundingClientRect().left + turn.clientLeft;
    expect(getComputedStyle(list).listStyleType).toBe("none");
    for (const [index, step] of [...steps].entries()) {
      const summary = step.querySelector("summary")!;
      expect(summary.textContent).toMatch(new RegExp(`^${index + 1}\\. `));
      expect(getComputedStyle(summary).display).toBe("list-item");
      const row = step.closest("li")!;
      expect(getComputedStyle(row).borderTopWidth).toBe("1px");
      expect(row.getBoundingClientRect().left).toBe(inside);
      expect(row.getBoundingClientRect().right).toBe(inside + turn.clientWidth);
      if (layout === "narrow")
        expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    const [user, model, legacy, tool, compaction, afterCompaction, afterSwitch] = steps;
    const toggle = (step: Element) => page.elementLocator(step.querySelector("summary")!);
    const detail = (step: Element, value: string) =>
      page.elementLocator(
        [...step.querySelectorAll("dd")].find((field) => field.textContent === value)!,
      );
    await expect.element(detail(model, longModel)).not.toBeVisible();
    for (const [step, values] of [
      [user, ["user", "steer"]],
      [model, [longModel, "300", "0", "125ms", "1s", "inference-1"]],
      [tool, ["150ms", "tool-1"]],
      [compaction, [new Date(compactedAt).toLocaleString()]],
      [afterCompaction, ["compaction"]],
      [afterSwitch, ["provider/next", "model switch"]],
    ] as const) {
      await toggle(step).click();
      for (const value of values) await expect.element(detail(step, value)).toBeVisible();
    }
    await toggle(legacy).click();
    await expect.element(detail(legacy, "legacy-model")).toBeVisible();
    await expect.element(detail(legacy, "gap")).toBeVisible();
    for (const label of [
      "Model",
      "Inference ID",
      "Prompt tokens",
      "Prompt delta",
      "Time to first delta",
      "Step duration",
    ]) {
      const field = [...legacy.querySelectorAll("dt")].find((term) => term.textContent === label)!;
      await expect.element(page.elementLocator(field.nextElementSibling!)).toHaveTextContent(/^—$/);
    }
    await newest.click();
    await expect.element(detail(legacy, "legacy-model")).not.toBeVisible();
    await newest.click();
    await expect.element(detail(legacy, "legacy-model")).toBeVisible();
    await toggle(legacy).click();
    await expect.element(detail(legacy, "legacy-model")).not.toBeVisible();
    const body = panel.element().querySelector(".side-panel-body")!;
    expect(body.scrollWidth).toBe(body.clientWidth);
    expect(fetchStats).toHaveBeenCalledTimes(1);

    await panel.getByRole("button", { name: "Load older turns" }).click();
    await expect.element(panel.getByText("21 of 21 turns · Newest first")).toBeVisible();
    await expect.element(panel.getByText("Turn 1 · wake · 0 steps", { exact: true })).toBeVisible();
    await expect
      .element(panel.getByRole("button", { name: "Load older turns" }))
      .not.toBeInTheDocument();
    await expect.element(panel.getByText(longModel, { exact: true })).toBeVisible();
    expect(fetchStats.mock.calls.map(([url]) => url)).toEqual([
      statsUrl(ws.id),
      statsUrl(ws.id, 20),
    ]);

    await panel.getByRole("button", { name: "Close Session stats" }).click();
    await expect.element(panel).not.toBeInTheDocument();
    window.dispatchEvent(new Event("pagehide"));
    // A timed flush can POST an earlier batch, leaving only the tail for pagehide.
    const events = (await Promise.all(batches)).flatMap((batch) => batch.events);
    expect(
      events.map(({ ts, ...event }) => {
        expect(typeof ts).toBe("number");
        return event;
      }),
    ).toEqual(
      [
        "panel.stats",
        "stats.turn_toggle",
        ...Array<string>(7).fill("stats.step_toggle"),
        "stats.turn_toggle",
        "stats.turn_toggle",
        "stats.step_toggle",
        "stats.load_more",
        "panel.close",
      ].map((action) => ({
        action,
        layout,
        outcome: "trigger",
      })),
    );
  },
);

it("keeps step disclosures touch-sized on a landscape phone", async () => {
  await page.viewport(844, 390);
  vi.stubGlobal("fetch", () => Promise.resolve(statsPage(0)));
  const { getByText } = render(<SessionStats workspaceId={ws.id} connected agents={[]} />);
  await page.getByText("Turn 21 · manual · 7 steps").click();
  const summary = getByText("1. User");
  expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await page.elementLocator(summary).click();
  expect(summary.closest("details")!.open).toBe(true);
});

it("aborts the previous workspace request and retries an error without leaking stale stats", async () => {
  await page.viewport(1440, 820);
  const { promise: previousResponse, resolve: finishPrevious } = deferred<Response>();
  let attempts = 0;
  const fetchStats = vi.fn((url: string, _options: RequestInit) => {
    if (url === statsUrl(ws.id)) return previousResponse;
    if (url === statsUrl(other.id) && ++attempts > 1)
      return Promise.resolve(Response.json({ turns: [], total: 0, offset: 0, limit: 20 }));
    return Promise.resolve(new Response(null, { status: 500 }));
  });
  vi.stubGlobal("fetch", (url: string, options: RequestInit) =>
    url.startsWith("api/workspaces/")
      ? fetchStats(url, options)
      : new Response(null, { status: 404 }),
  );
  boot([ws, other]);
  await page.getByRole("button", { name: "Session stats", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Session stats" });
  await expect.element(panel.getByText("Loading session stats…")).toBeVisible();
  const muted = getComputedStyle(panel.getByText("Loading session stats…").element()).color;
  const signal = fetchStats.mock.calls[0][1].signal;
  await page
    .elementLocator(document.querySelector(".sidebar")!)
    .getByText(other.name, { exact: true })
    .click();
  await expect.element(panel.getByRole("alert")).toHaveTextContent("Could not load session stats.");
  const alert = panel.getByRole("alert").element();
  const token = document.createElement("span");
  token.style.color = "var(--error)";
  alert.append(token);
  expect(getComputedStyle(alert).color).toBe(getComputedStyle(token).color);
  expect(getComputedStyle(alert).color).not.toBe(muted);
  token.remove();
  expect(signal?.aborted).toBe(true);
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect.element(panel.getByText("No session stats recorded.")).toBeVisible();
  await act(async () => {
    finishPrevious(statsPage(0));
    await previousResponse;
  });
  await expect.element(panel.getByText("No session stats recorded.")).toBeVisible();
  expect(fetchStats.mock.calls.map(([url]) => url)).toEqual([
    statsUrl(ws.id),
    statsUrl(other.id),
    statsUrl(other.id),
  ]);
});

it("continues streaming the transcript while the turn and step inspectors are open", async () => {
  await page.viewport(1440, 820);
  const fetchStats = vi.fn((url: string) =>
    Promise.resolve(
      url === statsUrl(DEMO_WS_ID) ? statsPage(0) : new Response(null, { status: 404 }),
    ),
  );
  vi.stubGlobal("fetch", fetchStats);
  const demo = buildFrames();
  const workspace = demo.find(
    (frame) =>
      frame.type === "workspace_created" && (frame.workspace as Workspace).id === DEMO_WS_ID,
  )!.workspace as Workspace;
  const replyId = "demo-msg-2";
  const start = demo.find(
    (frame) => frame.type === "new_message" && (frame.message as { id: string }).id === replyId,
  );
  const chunks = demo.filter(
    (frame) => frame.type === "stream_event" && frame.messageId === replyId,
  );
  const sock = boot([workspace]);
  const busyEvent = { workspaceId: DEMO_WS_ID, agentId: workspace.agents[0].id };
  act(() => {
    sock.receive({ ...busyEvent, type: "agent_busy", streamAt: Date.now() });
    sock.receive(start);
  });
  await page.getByRole("button", { name: "Session stats", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Session stats" });
  await panel.getByText("Turn 21 · manual · 7 steps", { exact: true }).click();
  const model = panel.element().querySelectorAll(".session-stats-step")[1];
  await page.elementLocator(model.querySelector("summary")!).click();
  const transcript = page.elementLocator(document.querySelector(".messages")!);
  act(() => chunks.slice(0, 10).forEach((frame) => sock.receive(frame)));
  await expect
    .element(transcript.getByText("Markdown torture test", { exact: true }))
    .toBeVisible();
  act(() => chunks.slice(10).forEach((frame) => sock.receive(frame)));
  await expect
    .element(transcript.getByText("Horizontal rule above. 中文渲染测试：多智能体编排面板。"))
    .toBeVisible();
  await expect.element(panel.getByText(longModel, { exact: true })).toBeVisible();
  expect(fetchStats.mock.calls.filter(([url]) => url === statsUrl(DEMO_WS_ID))).toHaveLength(1);
  act(() => {
    sock.receive(
      demo.find((frame) => frame.type === "message_done" && frame.messageId === replyId),
    );
    sock.receive({ ...busyEvent, type: "agent_idle" });
  });
  await expect.element(panel.getByText("20 of 21 turns · Newest first")).toBeVisible();
  await expect.element(panel.getByText(longModel, { exact: true })).not.toBeVisible();
  expect(fetchStats.mock.calls.filter(([url]) => url === statsUrl(DEMO_WS_ID))).toHaveLength(2);
  await panel.getByRole("button", { name: "Close Session stats" }).click();
  await expect
    .element(transcript.getByText("Horizontal rule above. 中文渲染测试：多智能体编排面板。"))
    .toBeVisible();
});

it("refreshes stats on reconnect and matches a newly opened inspector", async () => {
  await page.viewport(1440, 820);
  const fetchStats = vi.fn((url: string) =>
    Promise.resolve(
      url === statsUrl(ws.id)
        ? Response.json({
            turns: newest,
            total: newest.length,
            offset: 0,
            limit: 20,
          } satisfies SessionStatsPage)
        : new Response(null, { status: 404 }),
    ),
  );
  let newest = turns.slice(0, 1);
  vi.stubGlobal("fetch", fetchStats);
  const socket = boot();
  const open = page.getByRole("button", { name: "Session stats", exact: true });
  await open.click();
  const panel = page.getByRole("complementary", { name: "Session stats" });
  await expect.element(panel.getByText("1 of 1 turns · Newest first")).toBeVisible();

  newest = [{ turnId: "reconnected", trigger: "wake", steps: [] }, ...newest];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  act(() => socket.drop());
  expect(fetchStats.mock.calls.filter(([url]) => url === statsUrl(ws.id))).toHaveLength(1);
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  const replacement = FakeSocket.instances.at(-1)!;
  expect(replacement).not.toBe(socket);
  connect(replacement, [ws]);
  vi.useRealTimers();

  const summary = () =>
    [...panel.element().querySelectorAll("summary")].map((item) => item.textContent);
  await expect.element(panel.getByText("2 of 2 turns · Newest first")).toBeVisible();
  const reconnected = summary();
  expect(reconnected[0]).toBe("Turn 2 · wake · 0 steps");
  await panel.getByRole("button", { name: "Close Session stats" }).click();
  await open.click();
  await expect.element(panel.getByText("2 of 2 turns · Newest first")).toBeVisible();
  expect(summary()).toEqual(reconnected);
  expect(fetchStats.mock.calls.filter(([url]) => url === statsUrl(ws.id))).toHaveLength(3);
});
