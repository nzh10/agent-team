import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SubAgentItem } from "../../src/chat/messages";
import { App } from "../../src/App";
import { cdp, page } from "vitest/browser";
import { readTracePage, TRACE_MAX_BYTES, TRACE_MAX_EVENTS } from "../../../shared/subagent-trace";
import type { Message } from "../../src/state/useServer";
import * as telemetry from "../../src/telemetry";
import type { SubagentStatus } from "../../../shared/subagent-status";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

vi.mock("../../src/telemetry", { spy: true });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  FakeSocket.instances = [];
  delete document.documentElement.dataset.theme;
});

const statuses: SubagentStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
];
it.each(statuses)("renders %s with the correct animation and cancel affordance", async (status) => {
  const { container } = render(
    <SubAgentItem
      ev={{
        kind: "subagent_start",
        content: "",
        subagent: { taskId: "child", description: "Review", status },
      }}
      onCancel={() => {}}
    />,
  );
  const icon = container.querySelector(".subagent-status-icon")!;
  expect(icon.getAttribute("title")).toBe(status);
  const dot = container.querySelector(".streaming-dot");
  expect(!!dot).toBe(status === "running");
  expect(!!container.querySelector(".btn-cancel-subagent")).toBe(
    status === "queued" || status === "running",
  );
  if (status !== "running") {
    expect(getComputedStyle(icon).animationName).toBe("none");
    return;
  }

  const media = cdp();
  const setMotion = (value: string) =>
    media.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value }],
    });
  try {
    await setMotion("no-preference");
    expect(getComputedStyle(icon).animationName).toBe("spin");
    await setMotion("reduce");
    expect(getComputedStyle(icon).animationName).toBe("none");
    expect(getComputedStyle(dot!).animationName).toBe("none");
    await expect.element(page.elementLocator(icon)).toBeVisible();
    await expect.element(page.elementLocator(dot!)).toBeVisible();
  } finally {
    await media.send("Emulation.setEmulatedMedia", { features: [] });
  }
});

const agent = {
  id: "a",
  name: "Agent",
  avatar: "A",
  color: "#888",
  model: "model",
  isDefault: true,
};
const workspaces = ["work", "other"].map((id) => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: "/repo",
  agents: [{ ...agent, busy: id === "other" }],
  messages: [],
  createdAt: 1,
  projectLink: { projectId: "p", role: id === "work" ? "lead" : "worker" },
}));
const init = {
  type: "init",
  workspaces,
  projects: [
    {
      id: "p",
      name: "Project",
      root: "/repo",
      createdAt: 1,
      leadWorkspaceId: "work",
      objectives: [],
    },
  ],
  config: { models: [], commands: [], presets: [], hosts: {} },
};
const messages: Message[] = Array.from({ length: 30 }, (_, i) => ({
  id: `reply-${i}`,
  kind: "agent",
  agentId: "a",
  status: "done",
  timestamp: i + 2,
  content: `Reply ${i}\n\n${"A recorded paragraph to reread. ".repeat(20)}`,
}));
const owner = messages[12];
const task = {
  taskId: "child",
  description: "Review",
  status: "running" as const,
  lastTool: "Read",
};
const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

function mount() {
  vi.stubGlobal("WebSocket", FakeSocket);
  localStorage.setItem("activeWsId", "work");
  const root = document.createElement("div");
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  const view = render(<App />, { container: root });
  let sock = FakeSocket.instances.at(-1)!;
  const receive = (frame: object) => act(() => sock.receive(frame));
  const connect = () => {
    act(() => sock.open());
    receive(init);
  };
  connect();
  const requests = () => sock.frames().filter((f) => f.type === "load_subagent_trace");
  const openTrace = () =>
    fireEvent.click(view.getByRole("button", { name: "Expand subagent: Review" }));
  const details = () => root.querySelector<HTMLElement>(".subagent-item > .subagent-details");
  const events: NonNullable<Parameters<typeof readTracePage>[1]> = [];
  const meta = {
    prompt: "**Task prompt**\n\n" + "Check the repo carefully. ".repeat(12),
    summary: "**Final result**\n\n" + "All checks passed. ".repeat(12),
    usage: { totalTokens: 4000, toolUses: 3, durationMs: 6000 },
  };
  return {
    ...view,
    receive,
    requests,
    openTrace,
    details,
    events,
    meta,
    snapshot: (revision: number, summary = "First summary") =>
      receive({
        type: "workspace_messages",
        workspaceId: "work",
        before: null,
        hasMore: false,
        messages: messages.map((msg) =>
          msg === owner
            ? {
                ...owner,
                events: [
                  {
                    kind: "subagent_start",
                    content: "",
                    subagent: {
                      ...task,
                      summary,
                      transcriptRevision: revision,
                      eventCount: events.length,
                    },
                  },
                ],
              }
            : msg,
        ),
      }),
    disconnect: () => act(() => sock.drop()),
    reconnect: () => {
      const previous = sock;
      act(() => {
        sock.drop();
        window.dispatchEvent(new Event("online"));
      });
      sock = FakeSocket.instances.at(-1)!;
      expect(sock).not.toBe(previous);
      connect();
    },
    grow: (batchSize: number) =>
      act(() => {
        for (let i = 0; i < batchSize; i++) {
          events.push({ kind: "text", content: `Trace row ${events.length}: ${"🧪".repeat(640)}` });
          sock.receive({
            type: "stream_event",
            workspaceId: "work",
            messageId: owner.id,
            event: {
              kind: "subagent_enrichment",
              content: "",
              subagent: {
                taskId: task.taskId,
                description: "",
                eventCount: events.length,
                transcriptRevision: events.length,
              },
            },
          });
        }
      }),
    answer: (revision = events.length, request = requests().at(-1)!) => {
      const payload = readTracePage(
        request.requestId as number,
        [
          {
            kind: "subagent_start",
            content: "",
            subagent: {
              ...task,
              ...meta,
              transcriptRevision: revision,
              events,
            },
          },
        ],
        task.taskId,
        request,
      );
      receive(payload);
      return payload;
    },
  };
}

it("preserves a historical reading anchor on open, close, session switch and reconnect", async () => {
  await page.viewport(1280, 800);
  const view = mount();
  view.events.push({ kind: "text", content: "old trace" });
  view.snapshot(0);
  const scroller = () => view.container.querySelector<HTMLElement>(".messages")!;
  const widths = () =>
    [".main-panel", ".messages", "#msg-reply-12"].map(
      (selector) => view.container.querySelector(selector)?.getBoundingClientRect().width,
    );
  const offset = () =>
    view.container.querySelector("#msg-reply-12")!.getBoundingClientRect().top -
    scroller().getBoundingClientRect().top;
  const anchor = () => [scroller().scrollTop, offset()];
  await paint();
  // Exercise Chromium's half-pixel scroll rounding regardless of host font metrics.
  const padding = parseFloat(getComputedStyle(scroller()).paddingTop);
  const initialOffset = offset();
  const fixtureStyle = document.createElement("style");
  // Scope the adjustment to this fixture and retain it when the scroller remounts.
  fixtureStyle.textContent = `@scope { .messages { padding-top: ${padding + Math.floor(initialOffset) + 0.5 - initialOffset}px } }`;
  view.container.append(fixtureStyle);
  expect(Math.abs(offset() % 1)).toBe(0.5);
  scroller().scrollTop += offset() + 17;
  fireEvent.scroll(scroller());
  await paint();
  expect(Math.abs(offset() + 17)).toBeLessThanOrEqual(0.5);
  const original = anchor();
  const initialWidths = widths();
  const sameGeometry = () => {
    expect(anchor()).toEqual(original);
    expect(widths()).toEqual(initialWidths);
  };
  view.openTrace();
  const firstRequest = view.requests().at(-1)!;
  view.answer(0);
  expect(view.details()?.textContent).toContain("old trace");
  expect(scroller().contains(view.details())).toBe(true);
  sameGeometry();
  fireEvent.click(view.getByRole("button", { name: "Collapse subagent" }));
  expect(view.details()).toBeNull();
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Expand subagent: Review" }),
  );
  sameGeometry();

  view.openTrace();
  fireEvent.click(view.getByText("other", { selector: ".clip" }));
  view.receive({
    type: "workspace_messages",
    workspaceId: "other",
    messages: [{ ...messages[0], id: "other-reply" }],
  });
  expect(view.details()).toBeNull();
  expect(widths().slice(0, 2)).toEqual(initialWidths.slice(0, 2));
  fireEvent.click(view.getByTitle("Open the lead of Project"));
  view.snapshot(0);
  await paint();
  sameGeometry();
  view.openTrace();
  view.reconnect();
  view.events[0].content = "new trace of the same size";
  view.snapshot(1, "Final summary");
  view.receive({
    type: "subagent_trace_page",
    requestId: firstRequest.requestId,
    events: [],
    revision: 0,
  });
  view.answer(1);
  await paint();
  expect(view.details()?.textContent).toContain("new trace of the same size");
  expect(scroller().textContent).toContain("Final result");
  sameGeometry();
});

it("reports timeout, unavailable and offline states on the expanded card", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const view = mount();
    view.snapshot(0);
    view.openTrace();
    const timedOut = view.requests().at(-1)!;
    void act(() => vi.advanceTimersByTime(5000));
    expect(view.details()?.textContent).toContain("Trace request timed out.");
    view.answer(0, timedOut);
    expect(view.details()?.querySelector(".subagent-trace-page")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    const retry = view.requests().at(-1)!;
    expect(retry.requestId).not.toBe(timedOut.requestId);
    view.receive(readTracePage(retry.requestId as number, [], task.taskId, {}));
    expect(view.details()?.textContent).toContain("Trace is unavailable.");
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(view.details()?.textContent).toContain("Loading trace…");
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    view.answer(0);
    expect(view.details()?.textContent).toContain("Final result");
    view.disconnect();
    expect(view.details()?.textContent).toContain("Offline. Waiting to reconnect…");
  } finally {
    vi.useRealTimers();
  }
});

it.each([390, 1280])("balances card and markdown border insets at %ipx", async (width) => {
  await page.viewport(width, 800);
  const view = mount();
  view.meta.prompt = "## Task prompt\n\nReview the call chain.";
  view.meta.summary = "The checks passed.\n\n- One tool call\n- No errors";
  view.events.push({
    kind: "subagent_start",
    content: "",
    subagent: {
      taskId: "nested",
      description: "Child",
      status: "completed",
      prompt: "**Child prompt**",
      summary: "**Child result**",
    },
  });
  view.snapshot(0);
  function expectInsets(box: Element, first: Element, last: Element, label: string) {
    const bounds = box.getBoundingClientRect();
    const top = first.getBoundingClientRect().top - bounds.top;
    const bottom = bounds.bottom - last.getBoundingClientRect().bottom;
    expect(
      Math.abs(top - bottom),
      `${label}: ${top}px top, ${bottom}px bottom`,
    ).toBeLessThanOrEqual(1);
  }
  function checkCard(card: Element, expanded: boolean) {
    const header = card.querySelector(":scope > .subagent-header")!;
    const end = expanded
      ? card.querySelector(":scope > .subagent-details > .trace-collapse-footer")!
      : header;
    expectInsets(card, header, end, `${expanded ? "expanded" : "collapsed"} card`);
    if (expanded) {
      for (const selector of [".subagent-prompt", ".subagent-summary"]) {
        const block = card.querySelector(
          `:scope > .subagent-details > .subagent-trace-page > ${selector}`,
        )!;
        expectInsets(block, block.firstElementChild!, block.lastElementChild!, selector);
      }
    }
  }
  const card = view.container.querySelector(".subagent-item")!;
  checkCard(card, false);
  view.openTrace();
  view.answer(0);
  checkCard(card, true);
  const nested = view.details()!.querySelector<HTMLElement>(".subagent-item")!;
  checkCard(nested, false);
  fireEvent.click(within(nested).getByRole("button", { name: "Expand subagent: Child" }));
  view.answer(0);
  checkCard(nested, true);
});

it("renders native markdown, steps and concurrently refreshing nested cards inline", async () => {
  await page.viewport(1280, 800);
  const view = mount();
  const child = {
    taskId: "nested",
    description: "Check output",
    status: "failed" as const,
    prompt: "**Nested prompt**",
    summary: "**Nested result**",
    events: [{ kind: "text", content: "Initial inner trace" }],
  };
  view.events.push(
    { kind: "thinking", content: "Inspecting callers" },
    {
      kind: "tool_use",
      toolName: "Read",
      content: "**Read** `source.ts`",
      toolResult: "**Not found**",
      toolResultIsError: true,
      toolResultIsMarkdown: true,
    },
    { kind: "subagent_start", content: "", subagent: child },
    { kind: "subagent_done", content: "", subagent: child },
  );
  view.snapshot(0);
  // The full header, not only the arrow, is the click target.
  fireEvent.click(view.getByText("Review", { selector: ".subagent-desc" }));
  expect(view.details()?.textContent).toContain("Loading trace…");
  view.answer(0);
  const details = view.details()!;
  expect(details.querySelector(".subagent-prompt strong")?.textContent).toBe("Task prompt");
  expect(details.querySelector(".subagent-prompt p:last-child")?.textContent?.trim()).toBe(
    view.meta.prompt.split("\n\n")[1].trim(),
  );
  expect(details.querySelector(".subagent-summary strong")?.textContent).toBe("Final result");
  expect(details.querySelector(".subagent-usage")?.textContent).toBe("4k tokens · 3 tools");
  expect(details.querySelector(".event-thinking .event-content")?.textContent).toBe(
    "Inspecting callers",
  );
  expect(details.querySelector(".event-tool_use .event-chip")?.textContent).toBe("Read");
  const result = within(details).getByRole("button", { name: /^Result .*failed$/ });
  expect(details.querySelector(".event-result")).toBeNull();
  fireEvent.click(result);
  expect(details.querySelector(".event-failed .event-result strong")?.textContent).toBe(
    "Not found",
  );
  const nested = details.querySelector<HTMLElement>(".subagent-item")!;
  expect(details.querySelectorAll(".subagent-item")).toHaveLength(1);
  expect(nested.querySelector(".subagent-details")).toBeNull();
  fireEvent.click(within(nested).getByRole("button", { name: "Expand subagent: Check output" }));
  expect(view.requests().at(-1)).toMatchObject({ taskId: task.taskId, path: ["nested"] });
  view.answer(0);
  expect(within(nested).getByText("Initial inner trace")).toBeTruthy();

  const previous = view.requests().length;
  child.events[0].content = "Updated inner trace";
  view.grow(1);
  await waitFor(() => expect(view.requests()).toHaveLength(previous + 2));
  const refreshes = view.requests().slice(previous);
  const inner = refreshes.find((request) => Array.isArray(request.path))!;
  const outer = refreshes.find((request) => request !== inner)!;
  view.answer(view.events.length, inner);
  view.answer(view.events.length, outer);
  expect(within(nested).getByText("Updated inner trace")).toBeTruthy();
  expect(details.textContent).toContain("Trace row 4");
  expect(details.querySelectorAll(".subagent-trace-page")).toHaveLength(2);
  fireEvent.click(view.getByRole("button", { name: "Collapse subagent: Review" }));
  expect(view.details()).toBeNull();
  expect(view.container.querySelectorAll(".subagent-trace-page")).toHaveLength(0);
  view.openTrace();
  view.answer();
  expect(view.details()?.querySelectorAll(".subagent-trace-page")).toHaveLength(1);
  expect(view.getByRole("button", { name: "Expand subagent: Check output" })).toBeTruthy();
});

it("retains one bounded reading window under repeated live growth, paging and open/close cycles", async () => {
  await page.viewport(1280, 800);
  const record = vi.mocked(telemetry.recordTelemetry);
  record.mockClear();
  const view = mount();
  const assertBound = () => {
    const windows = view.container.querySelectorAll<HTMLElement>(".subagent-trace-page");
    expect(windows).toHaveLength(1);
    const [readingWindow] = windows;
    expect(+readingWindow.dataset.traceEntries!).toBeLessThanOrEqual(TRACE_MAX_EVENTS);
    expect(+readingWindow.dataset.traceBytes!).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    expect(view.details()!.querySelectorAll("*").length).toBeLessThanOrEqual(
      TRACE_MAX_EVENTS * 7 + 32,
    );
    expect(view.details()?.querySelectorAll(".subagent-events > .event")).toHaveLength(
      +readingWindow.dataset.traceEntries!,
    );
  };
  view.snapshot(0);
  for (let cycle = 0; cycle < 5; cycle++) {
    const before = view.requests().length;
    view.grow(100);
    await paint();
    expect(view.requests()).toHaveLength(before);
    view.openTrace();
    expect(view.details()?.textContent).not.toContain("Trace row");
    expect(view.answer().totalEvents).toBe(view.events.length);
    assertBound();
    const pageRequests = view.requests().length;
    view.grow(100);
    await waitFor(() => expect(view.requests()).toHaveLength(pageRequests + 1));
    const latest = view.answer();
    expect(latest.totalEvents).toBe(view.events.length);
    assertBound();
    const latestStart = latest.start;
    if (cycle === 0) {
      const pager = page.getByRole("navigation", { name: "Trace pages" });
      const earlier = pager.getByRole("button", { name: "Earlier" });
      const newer = pager.getByRole("button", { name: "Newer" });
      await expect.element(earlier).toBeEnabled();
      await expect.element(newer).toBeDisabled();
      const controlPaint = (control: typeof newer) => {
        const { backgroundColor, color, cursor, opacity } = getComputedStyle(control.element());
        return { backgroundColor, color, cursor, opacity };
      };
      await earlier.hover();
      const disabled = controlPaint(newer);
      expect(disabled.cursor).toBe("default");
      expect(+disabled.opacity).toBeLessThan(1);
      expect(controlPaint(earlier).backgroundColor).not.toBe(disabled.backgroundColor);
      await newer.hover();
      expect(newer.element().matches(":hover")).toBe(true);
      expect(controlPaint(newer)).toEqual(disabled);
    }
    fireEvent.click(view.getByRole("button", { name: "Earlier" }));
    const earlier = view.answer();
    expect(earlier.end).toBe(latestStart);
    expect(earlier.hasMore).toBe(true);
    expect(view.details()?.querySelector(".subagent-pagination span")?.textContent).toBe(
      `${earlier.start + 1}–${earlier.end} of ${earlier.totalEvents} steps`,
    );
    assertBound();
    fireEvent.click(view.getByRole("button", { name: "Latest" }));
    expect(view.answer().start).toBe(latestStart);
    fireEvent.click(view.getByRole("button", { name: "Earlier" }));
    view.answer();
    fireEvent.click(view.getByRole("button", { name: "Newer" }));
    // Close with the newer request still outstanding; a late page must be ignored.
    fireEvent.click(view.getByRole("button", { name: "Collapse subagent" }));
    view.answer();
    expect(view.details()).toBeNull();
    expect(view.container.querySelectorAll(".subagent-item")).toHaveLength(1);
  }
  const actions = record.mock.calls
    .map(([action]) => action)
    .filter((action) => action.startsWith("trace."));
  expect(actions).toEqual(
    Array.from({ length: 5 }, () => [
      "trace.subagent_toggle",
      "trace.subagent_page",
      "trace.subagent_page",
      "trace.subagent_page",
      "trace.subagent_page",
      "trace.subagent_toggle",
    ]).flat(),
  );
});

it.each([
  { theme: "light", width: 1280 },
  { theme: "dark", width: 1280 },
  { theme: "light", width: 390 },
  { theme: "dark", width: 390 },
])(
  "keeps summaries flat, resets edge and middle fenced-code margins, and aligns marks and BottomCollapse ($theme $width px)",
  async ({ theme, width }) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(width, 800);
    const view = mount();
    const failedPrompt = "```ts\nconst input = 1;\n```\n\nCheck edge cases.";
    const failedSummary = "Build failed.\n\n```sh\nexit 1\n```";
    const completedPrompt =
      "Before prompt fence.\n\n```ts\nconst midPrompt = 1;\n```\n\nAfter prompt fence.";
    const completedSummary = "Before summary fence.\n\n```sh\necho ok\n```\n\nAfter summary fence.";
    const child = {
      taskId: "nested-failed",
      description: "Inner check",
      status: "failed" as const,
      prompt: "```ts\nconst child = true;\n```",
      summary: "```txt\nerror: boom\n```",
      events: [{ kind: "thinking", content: "Inspecting failure" }],
    };
    const failedEvents = [
      { kind: "thinking", content: "Tracing outer step" },
      { kind: "subagent_start", content: "", subagent: child },
      { kind: "subagent_done", content: "", subagent: child },
    ];
    const completedEvents = [{ kind: "thinking", content: "Verifying completed step" }];

    view.receive({
      type: "workspace_messages",
      workspaceId: "work",
      before: null,
      hasMore: false,
      messages: messages.map((msg) =>
        msg === owner
          ? {
              ...owner,
              events: [
                {
                  kind: "subagent_done",
                  content: "",
                  subagent: {
                    ...task,
                    taskId: "outer-failed",
                    description: "Failed Review",
                    status: "failed",
                    transcriptRevision: 1,
                    eventCount: failedEvents.length,
                  },
                },
                {
                  kind: "subagent_done",
                  content: "",
                  subagent: {
                    ...task,
                    taskId: "outer-completed",
                    description: "Completed Review",
                    status: "completed",
                    transcriptRevision: 1,
                    eventCount: completedEvents.length,
                  },
                },
              ],
            }
          : msg,
      ),
    });

    const outerSubagentEvents = [
      {
        kind: "subagent_done" as const,
        content: "",
        subagent: {
          ...task,
          taskId: "outer-failed",
          prompt: failedPrompt,
          summary: failedSummary,
          usage: { totalTokens: 4000, toolUses: 3, durationMs: 6000 },
          transcriptRevision: 1,
          events: failedEvents,
        },
      },
      {
        kind: "subagent_done" as const,
        content: "",
        subagent: {
          ...task,
          taskId: "outer-completed",
          prompt: completedPrompt,
          summary: completedSummary,
          usage: { totalTokens: 4000, toolUses: 3, durationMs: 6000 },
          transcriptRevision: 1,
          events: completedEvents,
        },
      },
    ];
    const answerLatest = () => {
      const req = view.requests().at(-1)!;
      const payload = readTracePage(
        req.requestId as number,
        outerSubagentEvents,
        req.taskId as string,
        req,
      );
      view.receive(payload);
    };

    fireEvent.click(view.getByRole("button", { name: "Expand subagent: Failed Review" }));
    answerLatest();
    fireEvent.click(view.getByRole("button", { name: "Expand subagent: Completed Review" }));
    answerLatest();

    const resolveColor = (cssColor: string) => {
      const probe = document.createElement("span");
      probe.style.color = cssColor;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };

    const expectedIndent = width === 390 ? 8 : 18;
    const expectedAxisInset = width === 390 ? 6 : 10;

    const assertCardLayout = (card: HTMLElement, expectedBorder: string, checkNested = false) => {
      const header = card.querySelector<HTMLElement>(":scope > .subagent-header")!;
      const details = card.querySelector<HTMLElement>(":scope > .subagent-details")!;
      const trace = details.querySelector<HTMLElement>(":scope > .subagent-trace-page")!;
      const footer = details.querySelector<HTMLElement>(":scope > .trace-collapse-footer")!;
      const prompt = trace.querySelector<HTMLElement>(":scope > .subagent-prompt")!;
      const summary = trace.querySelector<HTMLElement>(":scope > .subagent-summary")!;
      const event = trace.querySelector<HTMLElement>(":scope > .subagent-events > .event")!;
      const eventRow = event.querySelector<HTMLElement>(".event-row")!;

      if (!checkNested) {
        expect(getComputedStyle(card).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      }
      expect(getComputedStyle(summary).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(prompt).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(summary).borderLeftColor).toBe(expectedBorder);

      // Every direct code-block pre inside prompt/summary has zero margins of its own.
      for (const block of [prompt, summary]) {
        for (const pre of block.querySelectorAll<HTMLElement>(":scope > .code-block > pre")) {
          expect(getComputedStyle(pre).marginTop).toBe("0px");
          expect(getComputedStyle(pre).marginBottom).toBe("0px");
        }
        const box = block.getBoundingClientRect();
        const top = block.firstElementChild!.getBoundingClientRect().top - box.top;
        const bottom = box.bottom - block.lastElementChild!.getBoundingClientRect().bottom;
        expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
      }

      // Trace indent and BottomCollapse flush alignment with header.
      expect(parseFloat(getComputedStyle(trace).paddingLeft)).toBe(expectedIndent);
      expect(
        Math.abs(footer.getBoundingClientRect().left - header.getBoundingClientRect().left),
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(footer.getBoundingClientRect().right - header.getBoundingClientRect().right),
      ).toBeLessThanOrEqual(0.5);

      // Visible marks (outer left edge) and reading axes (prompt, event, summary, and fenced pre) align at both widths.
      const markLeft = prompt.getBoundingClientRect().left;
      expect(Math.abs(event.getBoundingClientRect().left - markLeft)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(summary.getBoundingClientRect().left - markLeft)).toBeLessThanOrEqual(0.5);

      const expectedContentLeft = markLeft + expectedAxisInset;
      const contentLefts = [
        prompt.firstElementChild!.getBoundingClientRect().left,
        prompt.querySelector<HTMLElement>(":scope > .code-block > pre")!.getBoundingClientRect()
          .left,
        eventRow.getBoundingClientRect().left,
        summary.firstElementChild!.getBoundingClientRect().left,
        summary.querySelector<HTMLElement>(":scope > .code-block > pre")!.getBoundingClientRect()
          .left,
      ];
      for (const left of contentLefts) {
        expect(Math.abs(left - expectedContentLeft)).toBeLessThanOrEqual(0.5);
      }

      return { markLeft, contentLeft: expectedContentLeft, prompt, summary, trace };
    };

    const failedCard = view.container.querySelector<HTMLElement>(".subagent-item.subagent-failed")!;
    const completedCard = view.container.querySelector<HTMLElement>(
      ".subagent-item.subagent-completed",
    )!;
    const failedMetrics = assertCardLayout(failedCard, resolveColor("var(--error)"));
    const completedMetrics = assertCardLayout(completedCard, resolveColor("var(--success)"));

    // Failed and completed cards share identical reading axes at both desktop and mobile widths.
    expect(Math.abs(failedMetrics.markLeft - completedMetrics.markLeft)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(failedMetrics.contentLeft - completedMetrics.contentLeft)).toBeLessThanOrEqual(
      0.5,
    );

    // Middle-fence wrappers in completed prompt & summary own the compact 4px rhythm while <pre> keeps 0px margins.
    for (const block of [completedMetrics.prompt, completedMetrics.summary]) {
      const middleWrap = block.querySelector<HTMLElement>(":scope > .code-block")!;
      const middlePre = middleWrap.querySelector<HTMLElement>(":scope > pre")!;
      expect(getComputedStyle(middleWrap).marginTop).toBe("4px");
      expect(getComputedStyle(middleWrap).marginBottom).toBe("4px");
      expect(getComputedStyle(middlePre).marginTop).toBe("0px");
      expect(getComputedStyle(middlePre).marginBottom).toBe("0px");
    }

    // Nested failed card also renders flat with aligned reading axes, BottomCollapse, and zeroed fence margins.
    const nestedCard = failedMetrics.trace.querySelector<HTMLElement>(
      ".subagent-item.subagent-failed",
    )!;
    expect(getComputedStyle(nestedCard).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    fireEvent.click(
      within(nestedCard).getByRole("button", { name: "Expand subagent: Inner check" }),
    );
    answerLatest();
    assertCardLayout(nestedCard, resolveColor("var(--error)"), true);
  },
);

it("keeps duration and Cancel clustered on the right when a running subagent reports durationMs", async () => {
  for (const width of [1200, 320]) {
    await page.viewport(width, 720);
    const cancelled: string[] = [];
    const { container, unmount } = render(
      <div className="messages">
        <SubAgentItem
          ev={{
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "running-timed",
              description: "Review",
              model: "claude-opus-5-5",
              effort: "high",
              status: "running",
              durationMs: 4200,
              cancellable: true,
            },
          }}
          onCancel={(id) => cancelled.push(id)}
        />
      </div>,
    );
    const header = container.querySelector<HTMLElement>(".subagent-header")!;
    const time = header.querySelector<HTMLElement>(".subagent-time")!;
    const dot = header.querySelector<HTMLElement>(".streaming-dot")!;
    const cancel = header.querySelector<HTMLElement>(".btn-cancel-subagent")!;
    const headerRect = header.getBoundingClientRect();
    const timeRect = time.getBoundingClientRect();
    const dotRect = dot.getBoundingClientRect();
    const cancelRect = cancel.getBoundingClientRect();

    // Cancel sits at the right edge; duration and live dot cluster beside it instead of mid-header.
    expect(Math.abs(cancelRect.right - headerRect.right)).toBeLessThanOrEqual(1);
    expect(dotRect.left - timeRect.right).toBeLessThanOrEqual(10);
    expect(cancelRect.left - dotRect.right).toBeLessThanOrEqual(10);
    expect(timeRect.left).toBeGreaterThan(headerRect.left);
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);

    fireEvent.click(cancel);
    expect(cancelled).toEqual(["running-timed"]);
    unmount();
  }
});

it("keeps BottomCollapse reachable after scrolling a tall subagent trace and restores header on collapse", async () => {
  await page.viewport(1280, 720);
  const view = mount();
  view.meta.summary = "Line of detailed output.\n\n".repeat(60);
  view.snapshot(0);
  const scroller = view.container.querySelector<HTMLElement>(".messages")!;
  const header = view.container.querySelector<HTMLElement>(".subagent-header")!;
  for (let i = 0; i < 2; i++) {
    view.openTrace();
    view.answer(0);
    const collapseBtn = view.getByRole("button", { name: "Collapse subagent" });
    scroller.scrollTop +=
      collapseBtn.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 24;
    expect(header.getBoundingClientRect().bottom).toBeLessThan(
      scroller.getBoundingClientRect().top,
    );
    expect(collapseBtn.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().bottom,
    );
    collapseBtn.focus();
    fireEvent.click(collapseBtn);
    expect(document.activeElement).toBe(header.querySelector(".trace-header-toggle"));
    expect(view.details()).toBeNull();
    expect(header.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      scroller.getBoundingClientRect().top - 1,
    );
  }
});
