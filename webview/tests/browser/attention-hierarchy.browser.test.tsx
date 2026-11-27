import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, cdp, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { App } from "../../src/App";
import { FOLDED_IDLE_STORAGE_KEY } from "../../src/sidebar/Sidebar";
import { collectSnapshot, SNAPSHOT_SELECTORS } from "../../src/dev/debugSnapshot";
import type { AgentInfo, Message, Project, Workspace } from "../../src/state/useServer";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

const NOW = 1_800_000_000_000;
const agent: AgentInfo = {
  id: "agent",
  name: "Agent",
  model: "model",
  avatar: "A",
  color: "#888",
  isDefault: true,
};
const project: Project = {
  id: "proj",
  name: "Project",
  root: "/repo",
  createdAt: NOW,
  leadWorkspaceId: "lead",
  objectives: [],
};
function workspace(id: string, order: number, fields: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    project: "repo",
    hostId: "local",
    cwd: "/repo",
    agents: [agent],
    messages: [],
    createdAt: NOW + order,
    projectLink: { projectId: project.id, role: id === "lead" ? "lead" : "worker" },
    ...fields,
  };
}
const lead = workspace("lead", 0);
const a = workspace("A", 1);
const b = workspace("B", 2);
const config = { presets: [], models: [], commands: [], hosts: {} };
const frame = (n: number, over: Partial<Message> = {}): Message => ({
  id: `m${n}`,
  kind: "agent",
  agentId: agent.id,
  status: "done",
  timestamp: NOW + n,
  content: `Reply ${n}\n\n${"The transcript is long enough to read in the middle. ".repeat(10)}`,
  ...over,
});
const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const contrastOf = (foreground: string, backgrounds: string[]) => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const luminance = () => {
    const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3), (byte) => {
      const c = byte / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  ctx.clearRect(0, 0, 1, 1);
  for (const background of backgrounds) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 1, 1);
  }
  const a = luminance();
  ctx.fillStyle = foreground;
  ctx.fillRect(0, 0, 1, 1);
  const b = luminance();
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const row = (name: string) =>
  document.querySelector<HTMLElement>(`.task-item:has(.clip[title="${name}"])`);
const order = () =>
  [...document.querySelectorAll(".task-item .task-name-text > .clip")].map(
    (item) => item.textContent,
  );
const cue = (name: string) => row(name)?.querySelector(".session-attention")?.textContent;
const sendPage = (sock: FakeSocket, workspaceId: string, messages: Message[]) =>
  act(() => sock.receive({ type: "workspace_messages", workspaceId, messages, hasMore: false }));
function connect(workspaces: Workspace[], extra = {}) {
  const sock = FakeSocket.instances.at(-1)!;
  const receive = (value: object) => act(() => sock.receive(value));
  act(() => sock.open());
  receive({ type: "init", workspaces, projects: [project], config, ...extra });
  return { sock, receive };
}
function mount(active = "lead") {
  localStorage.setItem("activeWsId", active);
  vi.stubGlobal("WebSocket", FakeSocket);
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  return render(<App />, { container: root });
}

let touch = false;
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeSocket.instances = [];
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  if (touch) await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  touch = false;
});

it.each([
  [1280, "light"],
  [1280, "dark"],
  [390, "light"],
  [390, "dark"],
] as const)(
  "keeps attention, quiet waits and stable worker positions at %ipx (%s)",
  async (width, theme) => {
    await page.viewport(width, 800);
    document.documentElement.dataset.theme = theme;
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const asking = workspace("Asking", 1, { awaitsUser: true, unread: 1 });
    const done = workspace("Result", 2, { agents: [{ ...agent, busy: true, lastStreamAt: NOW }] });
    const running = workspace("Running", 3, {
      agents: [{ ...agent, busy: true, lastStreamAt: NOW - 119_875 }],
    });
    const old = workspace("Read and idle", -1, { lastResult: "done" });
    const view = mount();
    const { sock, receive } = connect([lead, asking, done, running, old]);
    sendPage(sock, lead.id, [frame(0)]);
    if (width < 768) fireEvent.click(get(".mobile-menu-btn"));
    expect(order()).toEqual(["Running", "Result", "Asking"]);
    expect(cue("Asking")).toBe("Your turn");
    expect(row("Read and idle")).toBeNull();
    const idleToggle = view.getByRole("button", { name: "Show 1 folded session" });
    expect(idleToggle.textContent).toContain("... (1)");
    expect(idleToggle.getAttribute("aria-expanded")).toBe("false");
    expect(idleToggle.textContent).toContain("▸");
    expect(document.body.textContent).not.toContain("Idle / Done");
    expect(cue("Result")).toBeUndefined();
    expect(row("Running")?.querySelector(".task-status.running")).toBeTruthy();
    expect(row("Running")?.querySelector(".session-silence")).toBeNull();
    clock = NOW + 125;
    await expect
      .poll(() => row("Running")?.querySelector(".session-silence")?.textContent)
      .toBe("Quiet");
    expect(row("Running")?.querySelector(".session-silence")?.getAttribute("title")).toBe(
      "No new events for 120s",
    );
    expect(row("Running")?.textContent).not.toMatch(/thinking|stuck/i);

    const runningRow = row("Running")!;
    fireEvent.pointerDown(runningRow);
    receive({
      type: "new_message",
      workspaceId: done.id,
      message: frame(1, { status: "streaming", content: "" }),
    });
    receive({
      type: "stream_event",
      workspaceId: done.id,
      messageId: "m1",
      agentId: agent.id,
      streamAt: clock,
      event: { kind: "tool_use", content: "Read" },
    });
    expect(cue("Result")).toBeUndefined();
    receive({ type: "workspace_attention", workspaceId: done.id, lastResult: "done", unread: 1 });
    receive({ type: "agent_idle", workspaceId: done.id, agentId: agent.id });
    expect(cue("Result")).toBe("Unread result");
    expect(view.getByRole("status", { name: "Project: 1 need you · 1 unread" })).toBeTruthy();

    // A snapshot (as on reconnect) has the same cues without a local turn history.
    receive({
      type: "init",
      workspaces: [
        old,
        { ...running, queued: false },
        { ...done, agents: [agent], lastResult: "done", unread: 1 },
        asking,
        lead,
      ],
      projects: [project],
      config,
    });
    expect(cue("Asking")).toBe("Your turn");
    expect(cue("Result")).toBe("Unread result");
    expect(row("Running")?.querySelector(".session-silence")?.textContent).toBe("Quiet");
    expect(row("Running")?.querySelector(".session-silence")?.getAttribute("title")).toBe(
      "No new events for 120s",
    );
    const retryLabel = "Retrying (1/2 in 0s): 503 fixture service unavailable";
    receive({
      type: "stream_event",
      workspaceId: running.id,
      messageId: "not loaded",
      agentId: agent.id,
      streamAt: clock,
      retryLabel,
      event: { kind: "retry", content: retryLabel },
    });
    await expect
      .poll(() => row("Running")?.querySelector(".session-silence")?.textContent)
      .toBe("Retrying (attempt 1)");
    receive({
      type: "stream_event",
      workspaceId: running.id,
      messageId: "not loaded",
      agentId: agent.id,
      streamAt: clock,
      retryLabel: null,
      event: { kind: "text_delta", content: "Progress" },
    });
    await expect.poll(() => row("Running")?.querySelector(".session-silence")).toBeNull();
    receive({ type: "agent_idle", workspaceId: running.id, agentId: agent.id });
    expect(row("Running")).toBe(runningRow);
    expect(order()).toEqual(["Running", "Result", "Asking"]);
    fireEvent.pointerUp(runningRow);
    receive({
      type: "new_message",
      workspaceId: running.id,
      queued: true,
      message: frame(8, { kind: "user", status: "queued" }),
    });
    expect(row("Running")?.querySelector(".session-silence")?.textContent).toBe("Queued");
    expect(view.queryByRole("button", { name: /^Fold (?:idle|\(\+)/ })).toBeNull();
    receive({ type: "message_removed", workspaceId: running.id, messageId: "m8", queued: false });
    expect(row("Running")?.querySelector(".session-silence")).toBeNull();
    // Merged Fold (+1) sits in the Idle (1) row instead of stacking a second toggle row.
    expect(document.querySelectorAll(".ws-idle-row")).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Fold (+1)" }));
    expect(order()).toEqual(["Result", "Asking"]);
    const foldedToggle = view.getByRole("button", { name: "Show 2 folded sessions" });
    expect(foldedToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(foldedToggle);
    expect(foldedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(foldedToggle.textContent).toContain("▸");
    expect(foldedToggle.textContent).not.toContain("▾");
    // Unfolded idle workers render below the Idle (2) disclosure row.
    const idleRow = foldedToggle.closest(".ws-idle-row")!;
    const unfolded = row("Read and idle")!;
    expect(unfolded.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      idleRow.getBoundingClientRect().bottom - 1,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    for (const el of [get(".main-panel"), get(".sidebar")])
      expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    const snapshot = collectSnapshot();
    expect(snapshot.elements.map((e) => e.selector)).toEqual(
      SNAPSHOT_SELECTORS.filter((s) => document.querySelector(s)),
    );
  },
);

it("keeps a constrained active project attention label ellipsized beside its actions", async () => {
  await page.viewport(390, 800);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mount();
  connect([
    lead,
    workspace("Asking", 1, { awaitsUser: true }),
    workspace("Failed", 2, { lastResult: "failed" }),
    workspace("Unread", 3, { lastResult: "done", unread: 1 }),
  ]);
  fireEvent.click(get(".mobile-menu-btn"));
  const header = get(".ws-group-header.active");
  await page.elementLocator(header).hover();
  const pill = header.querySelector<HTMLElement>(".ws-group-attention")!;
  const text = pill.querySelector<HTMLElement>(".clip")!;
  expect(pill.textContent).toBe("1 need you · 1 failed · 1 unread");
  expect(pill.getBoundingClientRect().height).toBe(18);
  expect(text.clientWidth).toBeGreaterThan(0);
  expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
  expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
  const pillBox = pill.getBoundingClientRect();
  const textBox = text.getBoundingClientRect();
  const style = getComputedStyle(pill);
  expect(textBox.left).toBeGreaterThanOrEqual(
    pillBox.left + Number.parseFloat(style.paddingLeft) - 1,
  );
  expect(textBox.right).toBeLessThanOrEqual(
    pillBox.right - Number.parseFloat(style.paddingRight) + 1,
  );
});

it("clears a failed row and project count on resume across live updates and a fresh snapshot", async () => {
  await page.viewport(1280, 800);
  const resumed = workspace("Resumed", 1, { lastResult: "failed", unread: 0 });
  const unread = workspace("Unread", 2, { unread: 1 });
  const view = mount();
  const { receive } = connect([lead, resumed, unread]);
  expect(cue("Resumed")).toBe("Failed");
  expect(view.getByRole("status", { name: "Project: 1 failed · 1 unread" })).toBeTruthy();

  receive({ type: "agent_busy", workspaceId: resumed.id, agentId: agent.id, streamAt: NOW });
  expect(row("Resumed")?.querySelector(".task-status.running")).toBeTruthy();
  expect(cue("Resumed")).toBeUndefined();
  receive({ type: "workspace_attention", workspaceId: resumed.id, unread: 0 });
  expect(cue("Resumed")).toBeUndefined();
  expect(view.getByRole("status", { name: "Project: 1 unread" })).toBeTruthy();
  receive({ type: "agent_idle", workspaceId: resumed.id, agentId: agent.id });
  expect(row("Resumed")?.querySelector(".task-status.running")).toBeNull();
  expect(cue("Resumed")).toBeUndefined();
  expect(view.getByRole("status", { name: "Project: 1 unread" })).toBeTruthy();

  receive({
    type: "init",
    workspaces: [lead, { ...resumed, agents: [agent], lastResult: undefined }, unread],
    projects: [project],
    config,
  });
  expect(row("Resumed")?.querySelector(".task-status.running")).toBeNull();
  expect(cue("Resumed")).toBeUndefined();
  expect(view.getByRole("status", { name: "Project: 1 unread" })).toBeTruthy();
});

it("prunes a saved fold after an authoritative empty init, not before it", async () => {
  await page.viewport(1280, 800);
  localStorage.setItem(FOLDED_IDLE_STORAGE_KEY, JSON.stringify(["deleted"]));
  mount();
  const sock = FakeSocket.instances.at(-1)!;
  expect(JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)!)).toEqual(["deleted"]);
  act(() => sock.open());
  expect(JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)!)).toEqual(["deleted"]);
  act(() => sock.receive({ type: "init", workspaces: [], projects: [], config }));
  expect(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)).toBeNull();
});

const painted = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

it.each([1280, 390])(
  "keeps the transcript width fixed when an inline trace adds overflow at %ipx",
  async (width) => {
    await page.viewport(width, 720);
    const view = mount();
    const { sock } = connect([lead]);
    sendPage(sock, lead.id, [
      frame(1, {
        content: "Short reply",
        events: [
          {
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "trace",
              description: "Reviewer",
              status: "completed",
              transcriptRevision: 1,
            },
          },
        ],
      }),
    ]);
    const scroller = get(".messages");
    const geometry = () => [
      scroller.clientWidth,
      scroller.getBoundingClientRect().width,
      get(".message").getBoundingClientRect().right,
    ];
    const jump = () => view.queryByRole("button", { name: /Jump to latest/ });
    await painted();
    expect(getComputedStyle(scroller).scrollbarGutter).toBe("stable");
    expect(scroller.scrollHeight).toBe(scroller.clientHeight);
    const collapsed = geometry();
    fireEvent.click(view.getByRole("button", { name: "Expand subagent: Reviewer" }));
    const request = sock.frames().find((f) => f.type === "load_subagent_trace");
    expect(request).toBeDefined();
    act(() =>
      sock.receive({
        type: "subagent_trace_page",
        requestId: request!.requestId,
        events: [],
        start: 0,
        end: 0,
        totalEvents: 0,
        revision: 1,
        hasMore: false,
        truncated: false,
        result: "A line of trace details.\n\n".repeat(80),
      }),
    );
    await painted();
    expect(get(".subagent-item > .subagent-details .subagent-summary")).toBeTruthy();
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(geometry()).toEqual(collapsed);
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    fireEvent.click(view.getByRole("button", { name: "Collapse subagent" }));
    await painted();
    expect(jump()).toBeNull();
    expect(scroller.scrollTop).toBe(0);
    expect(geometry()).toEqual(collapsed);
  },
);

it("keeps the empty workspace prompt vertically centered in the scroller", async () => {
  await page.viewport(1280, 800);
  mount();
  const { sock } = connect([lead]);
  sendPage(sock, lead.id, []);
  await painted();
  const scroller = get(".messages");
  const padding = getComputedStyle(scroller);
  expect(get(".messages .empty-state").getBoundingClientRect().height).toBeCloseTo(
    scroller.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom),
    0,
  );
});

it("reattaches at the bottom when the viewport grows without scrolling", async () => {
  await page.viewport(1280, 420);
  const view = mount();
  const { sock } = connect([lead]);
  sendPage(sock, lead.id, [
    frame(1, { content: "A transcript paragraph.\n\n".repeat(16) }),
    frame(2, { content: "Latest reply." }),
  ]);
  const scroller = get(".messages");
  const jump = () => view.queryByRole("button", { name: /Jump to latest/ });
  await painted();
  expect(scroller.scrollTop).toBeGreaterThan(8);
  scroller.scrollTop = 0;
  await expect.poll(jump).not.toBeNull();
  const scroll = vi.fn();
  scroller.addEventListener("scroll", scroll);
  await page.viewport(1280, 1200);
  await expect.poll(jump).toBeNull();
  expect(scroller.scrollTop).toBe(0);
  expect(scroller.scrollHeight).toBe(scroller.clientHeight);
  expect(scroll).not.toHaveBeenCalled();
});

it("restores A's exact reading anchor after sending in B, without following new A messages", async () => {
  await page.viewport(1280, 800);
  const view = mount("A");
  const { sock, receive } = connect([lead, a, b]);
  const history = Array.from({ length: 30 }, (_, index) => frame(index));
  sendPage(sock, a.id, history);
  const scroller = () => get(".messages");
  const offset = () =>
    get("#msg-m10").getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  const gap = () => scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop;
  expect(gap()).toBeLessThanOrEqual(1);
  scroller().scrollTop += offset() + 17;
  fireEvent.scroll(scroller());
  const original = offset();
  expect(original).toBeCloseTo(-17, 0);
  fireEvent.click(row("B")!);
  sendPage(sock, b.id, [frame(99, { content: "Session B" })]);
  const composer = get<HTMLTextAreaElement>(".chat-input");
  fireEvent.change(composer, { target: { value: "Please continue in B" } });
  fireEvent.click(within(get(".input-row")).getByRole("button", { name: "Send" }));
  await expect
    .poll(() => sock.frames().find((f) => f.type === "send_message"))
    .toMatchObject({ workspaceId: "B", content: "Please continue in B" });
  receive({ type: "new_message", workspaceId: "A", message: frame(30) });
  fireEvent.click(row("A")!);
  sendPage(sock, a.id, [...history, frame(30)]);
  expect(offset()).toBeCloseTo(original, 0);
  receive({
    type: "new_message",
    workspaceId: "A",
    message: frame(31, { status: "streaming", content: "" }),
  });
  const beforeGrowth = scroller().scrollHeight;
  receive({
    type: "stream_event",
    workspaceId: "A",
    messageId: "m31",
    event: { kind: "text_delta", content: "Growing reply.\n\n".repeat(80) },
  });
  await expect.poll(() => scroller().scrollHeight).toBeGreaterThan(beforeGrowth);
  await painted();
  expect(offset()).toBeCloseTo(original, 0);
  expect(view.queryByRole("button", { name: /Jump to latest/ })).not.toBeNull();
  const snapshot = collectSnapshot();
  expect(snapshot.activeTurn?.id).toBe("msg-m31");
  expect(snapshot.html).toContain('id="msg-m31"');
  expect(snapshot.html).not.toContain('id="msg-m10"');

  // A newer snapshot no longer overlaps the previously loaded window.
  // The original anchor must survive replacement, not just live appends.
  const disjoint = {
    type: "workspace_messages",
    workspaceId: "A",
    hasMore: true,
    messages: Array.from({ length: 50 }, (_, index) => frame(index + 50)),
  };
  receive(disjoint);
  expect(sock.frames()).toContainEqual(
    expect.objectContaining({
      type: "load_messages",
      workspaceId: "A",
      before: NOW + 50,
    }),
  );
  expect(document.getElementById("msg-m10")).toBeNull();
  // A reconnect invalidates the previous request; the same cursor is sent again.
  const olderRequests = () =>
    sock.frames().filter((f) => f.type === "load_messages" && f.before === NOW + 50).length;
  expect(olderRequests()).toBe(1);
  receive({ type: "init", workspaces: [lead, a, b], projects: [project], config });
  expect(olderRequests()).toBe(2);
  // Another latest-page reply can arrive before the outstanding older page.
  receive(disjoint);
  expect(olderRequests()).toBe(2);
  // Scrolling to the bottom while paging back to the anchor hides Jump to latest
  // only because m99 is in view — it must not reattach following.
  scroller().scrollTop = scroller().scrollHeight;
  fireEvent.scroll(scroller());
  expect(view.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  receive({
    type: "workspace_messages",
    workspaceId: "A",
    before: NOW + 50,
    hasMore: false,
    messages: Array.from({ length: 50 }, (_, index) => frame(index)),
  });
  expect(offset()).toBeCloseTo(original, 0);
  expect(view.getByRole("button", { name: /Jump to latest/ })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /Jump to latest/ }));
  expect(gap()).toBeLessThanOrEqual(1);
  expect(view.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  fireEvent.click(row("B")!);
  fireEvent.click(row("A")!);
  expect(gap()).toBeLessThanOrEqual(1);
});

it("hides Jump to latest while reading a tall latest message without yanking on stream updates", async () => {
  await page.viewport(1280, 720);
  const view = mount("A");
  const { sock, receive } = connect([lead, a, b]);
  const tall = frame(10, {
    status: "streaming",
    content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of a very long reply.`).join(
      "\n\n",
    ),
  });
  sendPage(sock, a.id, [...Array.from({ length: 8 }, (_, i) => frame(i)), tall]);
  const scroller = () => get(".messages");
  const jump = () => view.queryByRole("button", { name: /Jump to latest/ });
  const gap = () => scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop;

  await painted();
  expect(gap()).toBeLessThanOrEqual(1);

  // Scroll up > 150px inside the tall latest message so auto-follow disengages,
  // while keeping the top/middle of the latest message inside the viewport.
  const tallEl = get("#msg-m10");
  scroller().scrollTop +=
    tallEl.getBoundingClientRect().top - scroller().getBoundingClientRect().top + 120;
  fireEvent.scroll(scroller());
  await painted();

  expect(gap()).toBeGreaterThan(150);
  expect(jump()).toBeNull();

  // Streaming appends to that tall latest message must NOT yank scrollTop down.
  const lockedTop = scroller().scrollTop;
  const beforeGrowth = scroller().scrollHeight;
  receive({
    type: "stream_event",
    workspaceId: a.id,
    messageId: "m10",
    event: { kind: "text_delta", content: "\n\nMore streaming paragraphs.\n\n".repeat(12) },
  });
  await expect.poll(() => scroller().scrollHeight).toBeGreaterThan(beforeGrowth);
  await painted();

  expect(scroller().scrollTop).toBe(lockedTop);
  expect(jump()).toBeNull();

  // Switching away and back preserves the reading position without showing Jump to latest.
  fireEvent.click(row("B")!);
  sendPage(sock, b.id, [frame(99, { content: "Session B" })]);
  fireEvent.click(row("A")!);
  await painted();
  expect(scroller().scrollTop).toBeCloseTo(lockedTop, 0);
  expect(jump()).toBeNull();
});

it("shows Jump to latest immediately when a new message arrives below a tall message being read", async () => {
  await page.viewport(1280, 720);
  const view = mount("A");
  const { sock, receive } = connect([lead, a]);
  const tall = frame(10, {
    content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of a very long reply.`).join(
      "\n\n",
    ),
  });
  sendPage(sock, a.id, [frame(0), tall]);
  const scroller = () => get(".messages");
  const jump = () => view.queryByRole("button", { name: /Jump to latest/ });
  const gap = () => scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop;

  await painted();
  const tallEl = get("#msg-m10");
  scroller().scrollTop +=
    tallEl.getBoundingClientRect().top - scroller().getBoundingClientRect().top + 80;
  fireEvent.scroll(scroller());
  await painted();

  expect(gap()).toBeGreaterThan(150);
  expect(jump()).toBeNull();
  const readingTop = scroller().scrollTop;

  // A new message arrives below the tall message: now the latest message is off-screen.
  receive({
    type: "new_message",
    workspaceId: a.id,
    message: frame(11, { status: "streaming", content: "Newer message below viewport." }),
  });
  await expect.poll(jump).not.toBeNull();
  expect(scroller().scrollTop).toBe(readingTop);

  // Clicking Jump to latest scrolls to the bottom and hides the button.
  fireEvent.click(jump()!);
  expect(gap()).toBeLessThanOrEqual(1);
  expect(jump()).toBeNull();
});

it("toggles Jump to latest when scrolling above a tall latest message and back into it", async () => {
  await page.viewport(1280, 720);
  const view = mount("A");
  const { sock, receive } = connect([lead, a]);
  const history = Array.from({ length: 12 }, (_, i) => frame(i));
  const tall = frame(12, {
    status: "streaming",
    content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of a very long reply.`).join(
      "\n\n",
    ),
  });
  sendPage(sock, a.id, [...history, tall]);
  const scroller = () => get(".messages");
  const jump = () => view.queryByRole("button", { name: /Jump to latest/ });
  const gap = () => scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop;

  await painted();
  // Scroll up into older history so the latest message is completely below the viewport.
  scroller().scrollTop = 0;
  fireEvent.scroll(scroller());
  await expect.poll(jump).not.toBeNull();
  expect(get("#msg-m12").getBoundingClientRect().top).toBeGreaterThanOrEqual(
    scroller().getBoundingClientRect().bottom,
  );

  // Scroll back down until the top of the tall latest message enters the viewport,
  // still well above the very bottom of the transcript.
  scroller().scrollTop +=
    get("#msg-m12").getBoundingClientRect().top - scroller().getBoundingClientRect().bottom + 100;
  fireEvent.scroll(scroller());
  await expect.poll(jump).toBeNull();
  expect(gap()).toBeGreaterThan(150);

  // Streaming still does not yank the reader who hasn't returned to the very bottom.
  const midTop = scroller().scrollTop;
  const beforeGrowth = scroller().scrollHeight;
  receive({
    type: "stream_event",
    workspaceId: a.id,
    messageId: "m12",
    event: { kind: "text_delta", content: "\n\nTail extension.\n\n".repeat(10) },
  });
  await expect.poll(() => scroller().scrollHeight).toBeGreaterThan(beforeGrowth);
  await painted();
  expect(scroller().scrollTop).toBe(midTop);
  expect(jump()).toBeNull();
});

it("keeps 307px project headers readable with right-aligned status, centered Archive pill, and one-click worker archive", async () => {
  await page.viewport(1280, 800);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const agentTeam: Project = {
    id: "at",
    name: "agent-team",
    root: "/repo/agent-team",
    createdAt: NOW,
    leadWorkspaceId: "at-lead",
    objectives: [],
  };
  const makeLead = (over: Partial<Workspace> = {}) =>
    workspace("at-lead", 0, {
      name: "agent-team",
      projectLink: { projectId: "at", role: "lead" },
      ...over,
    });
  const makeWorker = (id: string, order: number, over: Partial<Workspace> = {}) =>
    workspace(id, order, {
      projectLink: { projectId: "at", role: "worker" },
      ...over,
    });

  const view = mount("at-lead");
  const sidebarEl = get(".sidebar");
  sidebarEl.style.width = "307px";

  const { sock, receive } = connect([]);
  const load = (workspaces: Workspace[], projects: Project[] = [agentTeam]) =>
    receive({ type: "init", workspaces, projects, config });

  const header = () => get(".ws-group-project");
  const label = () => get(".ws-group-project .ws-group-label");
  const status = () => get(".ws-group-project .ws-group-status");
  const actions = () => get(".ws-group-project .ws-group-actions");
  const rect = (el: Element) => el.getBoundingClientRect();
  const textRect = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect();
  };

  // Case 1: 1 need you on header aligns flush with Your turn on the worker row,
  // and agent-team stays unclipped at 307px.
  const waitingWorker = makeWorker("Worker A", 1, { awaitsUser: true });
  const idleWorker = makeWorker("Worker Idle", 2);
  const runningWorker = makeWorker("Worker Busy", 3, {
    agents: [{ ...agent, busy: true, lastStreamAt: NOW }],
  });
  load([makeLead(), waitingWorker, idleWorker, runningWorker]);

  expect(label().scrollWidth).toBeLessThanOrEqual(label().clientWidth);
  expect(rect(label()).width).toBeGreaterThan(60);
  const headerRect = rect(header());
  const statusRect = rect(status());
  const workerCueRect = rect(row("Worker A")!.querySelector(".session-attention")!);
  expect(headerRect.right - statusRect.right).toBeLessThanOrEqual(10);
  expect(Math.abs(statusRect.right - workerCueRect.right)).toBeLessThanOrEqual(1);
  // Hidden actions must not reserve dead width on pointer devices.
  expect(getComputedStyle(actions()).pointerEvents).toBe("none");
  expect(getComputedStyle(actions()).opacity).toBe("0");

  // Hover reveals +, Archive, × cleanly beside the status without moving or resizing the header.
  const labelLeftBefore = rect(label()).left;
  const headerHeightBefore = rect(header()).height;
  await page.elementLocator(header()).hover();
  await expect.poll(() => getComputedStyle(actions()).opacity).toBe("1");
  expect(getComputedStyle(actions()).pointerEvents).toBe("auto");
  expect(getComputedStyle(status()).visibility).toBe("visible");
  expect(rect(status()).right).toBeLessThanOrEqual(rect(actions()).left + 1);
  expect(rect(label()).left).toBe(labelLeftBefore);
  expect(rect(header()).height).toBe(headerHeightBefore);

  // Archive pill text is vertically centered inside its rounded border.
  const archivePill = get(".ws-group-project .ws-group-archive");
  // Flex items blockify inline-flex to flex in computed styles.
  expect(getComputedStyle(archivePill).display).toBe("flex");
  expect(getComputedStyle(archivePill).alignItems).toBe("center");
  expect(getComputedStyle(archivePill).justifyContent).toBe("center");
  const pillBox = rect(archivePill);
  const pillTextBox = textRect(archivePill);
  const pillCenter = (pillBox.top + pillBox.bottom) / 2;
  const textCenter = (pillTextBox.top + pillTextBox.bottom) / 2;
  expect(Math.abs(textCenter - pillCenter)).toBeLessThanOrEqual(1.5);

  // Move pointer away, then verify keyboard focus reveals actions beside status cleanly.
  await page.elementLocator(get(".sidebar-header")).hover();
  await expect.poll(() => getComputedStyle(actions()).opacity).toBe("0");
  archivePill.focus();
  expect(getComputedStyle(actions()).opacity).toBe("1");
  expect(getComputedStyle(actions()).pointerEvents).toBe("auto");
  expect(getComputedStyle(status()).visibility).toBe("visible");
  expect(rect(status()).right).toBeLessThanOrEqual(rect(actions()).left + 1);
  archivePill.blur();

  // Case 2: Quiet / Queued / Retrying on lead header keep agent-team unclipped and right-aligned.
  const leadCases: Array<[Partial<Workspace>, string]> = [
    [{ queued: true }, "Queued"],
    [{ agents: [{ ...agent, busy: true, lastStreamAt: NOW - 150_000 }] }, "Quiet"],
    [
      {
        agents: [
          {
            ...agent,
            busy: true,
            lastStreamAt: NOW,
            retryLabel: "Retrying (1/2 in 5s): 503",
          },
        ],
      },
      "Retrying (attempt 1)",
    ],
  ];
  for (const [leadPatch, expectedText] of leadCases) {
    load([makeLead(leadPatch), idleWorker]);
    expect(status().textContent).toBe(expectedText);
    expect(label().scrollWidth).toBeLessThanOrEqual(label().clientWidth);
    expect(rect(label()).width).toBeGreaterThan(60);
    expect(rect(header()).right - rect(status()).right).toBeLessThanOrEqual(10);
  }

  // Case 3: When idle.length === 0 && foldable.length > 0, show compact Fold (M)
  // that folds into ▸ ... (M), and verify one-click Archive on eligible worker rows.
  load([makeLead(), idleWorker, runningWorker]);
  const foldIdleBtn = view.getByRole("button", { name: "Fold (1)" });
  expect(foldIdleBtn).toBeTruthy();

  // Running worker must NOT offer Archive session; idle worker MUST.
  expect(row("Worker Busy")!.querySelector(".task-archive")).toBeNull();
  const archiveWorkerBtn = row("Worker Idle")!.querySelector<HTMLButtonElement>(".task-archive")!;
  expect(archiveWorkerBtn).not.toBeNull();
  expect(archiveWorkerBtn.getAttribute("aria-label")).toBe("Archive session");
  fireEvent.click(archiveWorkerBtn);
  expect(sock.frames()).toContainEqual({
    type: "archive_workspace",
    workspaceId: "Worker Idle",
  });

  // Clicking Fold (1) collapses into ▸ ... (1).
  fireEvent.click(foldIdleBtn);
  expect(view.getByRole("button", { name: "Show 1 folded session" })).toBeTruthy();
  expect(view.queryByRole("button", { name: /^Fold (?:idle|\(\+)/ })).toBeNull();
});

it("keeps Quiet unclipped, hit-testable on long project names, and reachable via pointer hover and Tab navigation", async () => {
  await page.viewport(1280, 800);
  let clock = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => clock);

  const longProj: Project = {
    id: "proj",
    name: "very-long-project-name-for-narrow-sidebar-regression",
    root: "/repo/long",
    createdAt: NOW,
    leadWorkspaceId: "lead",
    objectives: [],
  };
  const quietLead = workspace("lead", 0, {
    name: longProj.name,
    git: { branch: "feat/sidebar-header-layout", dirty: 0, ahead: 0, behind: 0 },
    agents: [{ ...agent, busy: true, lastStreamAt: NOW - 120_000 }],
  });
  const quietWorker = workspace("QuietWorker", 1, {
    agents: [{ ...agent, busy: true, lastStreamAt: NOW - 120_000 }],
  });
  mount("lead");
  const sidebarEl = get(".sidebar");
  sidebarEl.style.width = "307px";
  const { receive } = connect([]);
  receive({ type: "init", workspaces: [quietLead, quietWorker], projects: [longProj], config });

  const leadHeader = get(".ws-group-project");
  const leadQuiet = leadHeader.querySelector<HTMLElement>(".session-silence-quiet")!;
  const leadActions = leadHeader.querySelector<HTMLElement>(".ws-group-actions")!;
  const workerRow = row("QuietWorker")!;
  const workerQuiet = workerRow.querySelector<HTMLElement>(".session-silence-quiet")!;
  const workerHover = workerRow.querySelector<HTMLElement>(".task-hover")!;
  expect(leadQuiet.textContent).toBe("Quiet");
  expect(leadQuiet.getAttribute("title")).toBe("No new events for 120s");
  expect(workerQuiet.textContent).toBe("Quiet");
  expect(workerQuiet.getAttribute("title")).toBe("No new events for 120s");

  clock = NOW + 30_000;

  // Hover the quiet long-named lead header with +, Archive, × inline, then hover Quiet itself.
  await page.elementLocator(leadHeader).hover();
  await expect.poll(() => getComputedStyle(leadActions).opacity).toBe("1");
  await page.elementLocator(leadQuiet).hover();
  const leadBox = leadQuiet.getBoundingClientRect();
  expect(getComputedStyle(leadQuiet).visibility).toBe("visible");
  expect(leadQuiet.scrollWidth).toBeLessThanOrEqual(leadQuiet.clientWidth);
  expect(leadBox.width).toBeGreaterThan(20);
  expect(leadBox.right).toBeLessThanOrEqual(leadActions.getBoundingClientRect().left + 1);
  expect(
    document.elementFromPoint(leadBox.left + leadBox.width / 2, leadBox.top + leadBox.height / 2),
  ).toBe(leadQuiet);
  await expect.poll(() => leadQuiet.getAttribute("title")).toBe("No new events for 150s");

  // Hover the quiet worker row, then move the pointer onto its Quiet badge.
  await page.elementLocator(workerRow).hover();
  await expect.poll(() => getComputedStyle(workerHover).opacity).toBe("1");
  await page.elementLocator(workerQuiet).hover();
  const workerBox = workerQuiet.getBoundingClientRect();
  expect(getComputedStyle(workerQuiet).visibility).toBe("visible");
  expect(workerQuiet.scrollWidth).toBeLessThanOrEqual(workerQuiet.clientWidth);
  expect(workerBox.width).toBeGreaterThan(20);
  expect(workerBox.right).toBeLessThanOrEqual(workerHover.getBoundingClientRect().left + 1);
  expect(
    document.elementFromPoint(
      workerBox.left + workerBox.width / 2,
      workerBox.top + workerBox.height / 2,
    ),
  ).toBe(workerQuiet);
  await expect.poll(() => workerQuiet.getAttribute("title")).toBe("No new events for 150s");

  // Keyboard Tab navigation reaches both Quiet badges, refreshes elapsed detail,
  // displays a visible role="tooltip" inside the sidebar, and dismisses on Escape.
  clock = NOW + 45_000;
  const sidebarBox = sidebarEl.getBoundingClientRect();
  const tabTo = async (target: HTMLElement, maxTabs = 12) => {
    for (let i = 0; i < maxTabs && document.activeElement !== target; i += 1) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(target);
  };

  leadHeader.querySelector<HTMLElement>(".ws-group-toggle")!.focus();
  await tabTo(leadQuiet);
  const leadFocus = getComputedStyle(leadQuiet);
  expect(leadHeader.classList.contains("active")).toBe(true);
  expect(leadFocus.outlineColor).toBe("rgb(255, 255, 255)");
  expect(
    contrastOf(leadFocus.outlineColor, [getComputedStyle(leadHeader).backgroundColor]),
  ).toBeGreaterThanOrEqual(3);
  const leadTip = leadQuiet.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(leadTip).not.toBeNull();
  expect(leadTip.textContent).toBe("No new events for 165s");
  expect(leadQuiet.getAttribute("aria-describedby")).toBe(leadTip.id);
  const leadTipBox = leadTip.getBoundingClientRect();
  expect(leadTipBox.width).toBeGreaterThan(0);
  expect(leadTipBox.left).toBeGreaterThanOrEqual(sidebarBox.left);
  expect(leadTipBox.right).toBeLessThanOrEqual(sidebarBox.right);
  await userEvent.keyboard("{Escape}");
  expect(leadQuiet.querySelector('[role="tooltip"]')).toBeNull();

  // Tab from the project header actions into the quiet worker's Quiet badge.
  leadHeader.querySelector<HTMLElement>(".task-delete")!.focus();
  await tabTo(workerQuiet);
  const workerTip = workerQuiet.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(workerTip).not.toBeNull();
  expect(workerTip.textContent).toBe("No new events for 165s");
  expect(workerQuiet.getAttribute("aria-describedby")).toBe(workerTip.id);
  const workerTipBox = workerTip.getBoundingClientRect();
  expect(workerTipBox.width).toBeGreaterThan(0);
  expect(workerTipBox.left).toBeGreaterThanOrEqual(sidebarBox.left);
  expect(workerTipBox.right).toBeLessThanOrEqual(sidebarBox.right);
  await userEvent.keyboard("{Escape}");
  expect(workerQuiet.querySelector('[role="tooltip"]')).toBeNull();
});

it.each(["light", "dark"] as const)(
  "keeps status dots distinguishable across selected rows, Sidebar, AgentsPanel, and Header (%s)",
  async (theme) => {
    await page.viewport(1280, 800);
    document.documentElement.dataset.theme = theme;
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const resolveColor = (cssVar: string) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${cssVar})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const accent = resolveColor("--accent");
    const purple = resolveColor("--purple");
    const muted = resolveColor("--text-muted");
    const onSolid = resolveColor("--on-solid");
    const expectPulsingDot = (dot: HTMLElement, color: string) => {
      const cs = getComputedStyle(dot);
      expect(cs.backgroundColor).toBe(color);
      expect(cs.animationName).toBe("pulse");
      expect(cs.animationIterationCount).toBe("infinite");
      // Seek to keyframe 0% so opacity does not race an arbitrary animation frame.
      for (const anim of dot.getAnimations()) {
        anim.pause();
        anim.currentTime = 0;
      }
      expect(getComputedStyle(dot).opacity).toBe("1");
    };

    const expectActiveWorkingDot = (dot: HTMLElement) => {
      const cs = getComputedStyle(dot);
      expect(cs.backgroundColor).toBe(onSolid);
      expect(cs.animationName).toBe("active-row-pulse");
      expect(cs.animationIterationCount).toBe("infinite");
      for (const anim of dot.getAnimations()) {
        anim.pause();
        anim.currentTime = 750;
      }
      // The selected-row pulse changes scale, never color or opacity.
      expect(getComputedStyle(dot).backgroundColor).toBe(onSolid);
      expect(getComputedStyle(dot).opacity).toBe("1");
    };

    const workingProj: Project = {
      id: "proj-work",
      name: "WorkingProj",
      root: "/repo/work",
      createdAt: NOW + 5,
      leadWorkspaceId: "work-lead",
      objectives: [],
    };
    const waitingProj: Project = {
      id: "proj-wait",
      name: "WaitingProj",
      root: "/repo/wait",
      createdAt: NOW + 10,
      leadWorkspaceId: "wait-lead",
      objectives: [],
    };
    const sleepingProj: Project = {
      id: "proj-sleep",
      name: "SleepingProj",
      root: "/repo/sleep",
      createdAt: NOW + 20,
      leadWorkspaceId: "sleep-lead",
      objectives: [],
    };

    const busyWithCue = workspace("BusyCue", 1, {
      awaitsUser: true,
      agents: [{ ...agent, busy: true, state: "working", lastStreamAt: NOW }],
    });
    const waitingWorker = workspace("Waiting", 2, {
      agents: [{ ...agent, state: "waiting" }],
    });
    const sleepingWorker = workspace("Sleeping", 3, {
      agents: [{ ...agent, state: "sleeping" }],
    });
    const idleWorker = workspace("IdleWorker", 4, {
      lastResult: "done",
      unread: 1,
      queued: false,
      agents: [{ ...agent, busy: false, state: "idle" }],
    });
    const workLead = workspace("work-lead", 6, {
      name: "WorkingProj",
      projectLink: { projectId: workingProj.id, role: "lead" },
      agents: [{ ...agent, busy: true, state: "working", lastStreamAt: NOW }],
    });
    const waitLead = workspace("wait-lead", 11, {
      name: "WaitingProj",
      projectLink: { projectId: waitingProj.id, role: "lead" },
      agents: [{ ...agent, state: "waiting" }],
    });
    const sleepLead = workspace("sleep-lead", 21, {
      name: "SleepingProj",
      projectLink: { projectId: sleepingProj.id, role: "lead" },
      agents: [{ ...agent, state: "sleeping" }],
    });

    const view = mount("lead");
    const { receive } = connect([]);
    receive({
      type: "init",
      workspaces: [
        lead,
        busyWithCue,
        waitingWorker,
        sleepingWorker,
        idleWorker,
        workLead,
        waitLead,
        sleepLead,
      ],
      projects: [project, workingProj, waitingProj, sleepingProj],
      config,
    });

    // Open Agents panel on the project lead so all project workers render together.
    fireEvent.click(view.getByRole("button", { name: /^Agents/ }));

    const runningDot = row("BusyCue")!.querySelector<HTMLElement>(".task-status")!;
    const waitingDot = row("Waiting")!.querySelector<HTMLElement>(".task-status")!;
    const sleepingDot = row("Sleeping")!.querySelector<HTMLElement>(".task-status")!;
    const idleDot = row("IdleWorker")!.querySelector<HTMLElement>(".task-status")!;
    const projectHeaderFor = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".ws-group-project")].find((el) =>
        el.textContent?.includes(name),
      )!;
    const headerDotFor = (name: string) =>
      projectHeaderFor(name).querySelector<HTMLElement>(".task-status")!;
    const combinedHeader = projectHeaderFor("Project");
    const combinedHeaderDot = combinedHeader.querySelector<HTMLElement>(".task-status")!;
    const workHeaderDot = headerDotFor("WorkingProj");
    const waitHeaderDot = headerDotFor("WaitingProj");
    const sleepHeaderDot = headerDotFor("SleepingProj");

    const apWorking = get(".ap-dot.ss-working");
    const apWaiting = get(".ap-dot.ss-waiting");
    const apSleeping = get(".ap-dot.ss-sleeping");

    // Combined project header: attention summary (1 need you) does NOT hide the running blue dot.
    expect(combinedHeader.querySelector(".ws-group-attention")?.textContent).toContain(
      "1 need you",
    );
    expect(combinedHeaderDot.classList.contains("running")).toBe(true);

    // Unselected rows keep the accent pulse; the selected lead uses an opaque scale pulse.
    expect(runningDot.classList.contains("running")).toBe(true);
    expect(workHeaderDot.classList.contains("running")).toBe(true);
    expect(row("BusyCue")!.querySelector(".session-attention")?.textContent).toBe("Your turn");
    for (const dot of [runningDot, workHeaderDot, apWorking]) {
      expectPulsingDot(dot, accent);
    }
    expectActiveWorkingDot(combinedHeaderDot);

    // Waiting: pulsing --purple across Sidebar worker, Sidebar project header, and AgentsPanel.
    for (const dot of [waitingDot, waitHeaderDot, apWaiting]) {
      expectPulsingDot(dot, purple);
    }
    expect(waitingDot.classList.contains("waiting")).toBe(true);
    expect(waitHeaderDot.classList.contains("waiting")).toBe(true);

    // Sleeping: steady --purple across Sidebar worker, Sidebar project header, and AgentsPanel.
    for (const dot of [sleepingDot, sleepHeaderDot, apSleeping]) {
      expect(getComputedStyle(dot).backgroundColor).toBe(purple);
      expect(getComputedStyle(dot).animationName).toBe("none");
    }
    expect(sleepingDot.classList.contains("sleeping")).toBe(true);
    expect(sleepHeaderDot.classList.contains("sleeping")).toBe(true);

    // Idle: muted steady dot, eligible for Archive until agent_busy arrives.
    expect(idleDot.classList.contains("idle")).toBe(true);
    expect(getComputedStyle(idleDot).backgroundColor).toBe(muted);
    expect(getComputedStyle(idleDot).opacity).toBe("0.5");
    expect(getComputedStyle(idleDot).animationName).toBe("none");
    expect(row("IdleWorker")!.querySelector(".task-archive")).not.toBeNull();
    fireEvent.click(row("IdleWorker")!);
    expect(getComputedStyle(idleDot).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(idleDot).boxShadow).not.toBe("none");
    expect(getComputedStyle(idleDot).opacity).toBe("1");

    // Regression: agent_busy arriving before agent_state restores an opaque selected-row pulse.
    receive({ type: "agent_busy", workspaceId: "IdleWorker", agentId: agent.id, streamAt: NOW });
    const startingDot = row("IdleWorker")!.querySelector<HTMLElement>(".task-status")!;
    expect(startingDot.classList.contains("running")).toBe(true);
    expect(row("IdleWorker")!.classList.contains("task-item-active")).toBe(true);
    expect(row("IdleWorker")!.querySelector(".task-archive")).toBeNull();
    expectActiveWorkingDot(startingDot);

    // Chat Header retains hue; selected rows distinguish state without fading their marks.
    fireEvent.click(row("BusyCue")!);
    expectActiveWorkingDot(runningDot);
    expectPulsingDot(get(".agent-status-dot.agent-status-busy"), accent);

    fireEvent.click(row("Waiting")!);
    expect(getComputedStyle(waitingDot).backgroundColor).toBe(onSolid);
    expect(getComputedStyle(waitingDot).animationName).toBe("none");
    expectPulsingDot(get(".agent-status-dot.agent-status-waiting"), purple);

    fireEvent.click(row("Sleeping")!);
    expect(getComputedStyle(sleepingDot).backgroundColor).toBe(onSolid);
    expect(getComputedStyle(sleepingDot).borderTopLeftRadius).toBe("2px");
    expect(getComputedStyle(sleepingDot).animationName).toBe("none");
    const headerSleeping = get(".agent-status-dot.agent-status-sleeping");
    expect(getComputedStyle(headerSleeping).backgroundColor).toBe(purple);
    expect(getComputedStyle(headerSleeping).animationName).toBe("none");
  },
);

it.each(["light", "dark"] as const)(
  "keeps selected-row descendants and actions on their contrast floors (%s)",
  async (theme) => {
    await page.viewport(1280, 800);
    document.documentElement.dataset.theme = theme;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const isolated = workspace("Isolated", 5, {
      projectLink: { projectId: project.id, role: "worker", isolated: true },
    });
    const sealedProj: Project = {
      id: "sealed-project",
      name: "SealedProj",
      root: "/repo/sealed",
      createdAt: NOW + 10,
      leadWorkspaceId: "sealed-lead",
      status: "sealed",
      sealedReason: "Read-only archive",
      objectives: [],
    };
    const sealedLead = workspace("sealed-lead", 11, {
      name: "SealedProj",
      projectLink: { projectId: sealedProj.id, role: "lead" },
    });
    mount("Isolated");
    connect([lead, isolated, sealedLead], { projects: [project, sealedProj] });

    const selected = row("Isolated")!;
    expect(selected.classList.contains("active")).toBe(true);
    const role = selected.querySelector<HTMLElement>(".task-role-tag")!;
    expect(role.textContent).toBe("isolated");
    expect(
      contrastOf(getComputedStyle(role).color, [getComputedStyle(selected).backgroundColor]),
    ).toBeGreaterThanOrEqual(theme === "light" ? 3 : 4.5);

    const archive = selected.querySelector<HTMLElement>(".task-archive")!;
    const actionContrast = (element: HTMLElement) => {
      const rowBackground = getComputedStyle(row("Isolated")!).backgroundColor;
      const style = getComputedStyle(element);
      return contrastOf(style.color, [rowBackground, style.backgroundColor]);
    };
    // Rest, pointer hover and keyboard reveal all use a contrast-safe glass surface.
    expect(actionContrast(archive)).toBeGreaterThanOrEqual(4.5);
    const restingBackground = getComputedStyle(archive).backgroundColor;
    await page.elementLocator(selected).hover();
    await page.elementLocator(archive).hover();
    await expect.poll(() => getComputedStyle(archive).opacity).toBe("1");
    expect(getComputedStyle(archive).backgroundColor).not.toBe(restingBackground);
    expect(actionContrast(archive)).toBeGreaterThanOrEqual(4.5);
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    archive.focus();
    await expect
      .poll(() => getComputedStyle(selected.querySelector<HTMLElement>(".task-hover")!).opacity)
      .toBe("1");
    expect(actionContrast(archive)).toBeGreaterThanOrEqual(4.5);

    const sealedHeader = [
      ...document.querySelectorAll<HTMLElement>(".ws-group-header.ws-group-project"),
    ].find((element) => element.textContent?.includes("SealedProj"))!;
    fireEvent.click(sealedHeader);
    expect(sealedHeader.classList.contains("active")).toBe(true);
    const sealed = sealedHeader.querySelector<HTMLElement>(".ws-group-sealed")!;
    expect(
      contrastOf(getComputedStyle(sealed).color, [
        getComputedStyle(sealedHeader).backgroundColor,
        getComputedStyle(sealed).backgroundColor,
      ]),
    ).toBeGreaterThanOrEqual(4.5);

    // Touch has no hover: the same selected-row action stays visible and readable at rest.
    touch = true;
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.viewport(390, 800);
    fireEvent.click(get(".mobile-menu-btn"));
    fireEvent.click(row("Isolated")!);
    fireEvent.click(get(".mobile-menu-btn"));
    const touchArchive = row("Isolated")!.querySelector<HTMLElement>(".task-archive")!;
    const touchDelete = row("Isolated")!.querySelector<HTMLElement>(".task-delete")!;
    await expect.poll(() => getComputedStyle(touchArchive).opacity).toBe("1");
    for (const control of [touchArchive, touchDelete]) {
      expect(control.getBoundingClientRect().width).toBe(22);
      expect(control.getBoundingClientRect().height).toBe(18);
    }
    expect(actionContrast(touchArchive)).toBeGreaterThanOrEqual(4.5);
  },
);

// Headless Chromium may keep hover disabled after touch emulation is turned off.
it("keeps selected worker cues visible on hover-none touch devices, including sealed workers with no actions", async () => {
  touch = true;
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.viewport(390, 800);
  expect(matchMedia("(hover: none)").matches).toBe(true);
  vi.spyOn(Date, "now").mockReturnValue(NOW);

  const sealedProj: Project = {
    id: "sealed-proj",
    name: "SealedProj",
    root: "/repo/sealed",
    createdAt: NOW + 10,
    leadWorkspaceId: "sealed-lead",
    status: "sealed",
    sealedReason: "Read-only archive",
    objectives: [],
  };
  const quietWorker = workspace("TouchQuiet", 1, {
    agents: [{ ...agent, busy: true, lastStreamAt: NOW - 150_000 }],
  });
  const sealedLead = workspace("sealed-lead", 11, {
    name: "SealedProj",
    projectLink: { projectId: sealedProj.id, role: "lead" },
  });
  const sealedWorker = workspace("SealedCue", 12, {
    projectLink: { projectId: sealedProj.id, role: "worker" },
    awaitsUser: true,
  });

  mount("lead");
  const { receive } = connect([]);
  receive({
    type: "init",
    workspaces: [lead, quietWorker, sealedLead, sealedWorker],
    projects: [project, sealedProj],
    config,
  });

  // Open mobile sidebar, select the quiet worker (closes drawer), then reopen sidebar.
  fireEvent.click(get(".mobile-menu-btn"));
  fireEvent.click(row("TouchQuiet")!);
  fireEvent.click(get(".mobile-menu-btn"));

  const activeQuietRow = row("TouchQuiet")!;
  expect(activeQuietRow.classList.contains("active")).toBe(true);
  const quietBadge = activeQuietRow.querySelector<HTMLElement>(".session-silence")!;
  const quietHover = activeQuietRow.querySelector<HTMLElement>(".task-hover")!;
  expect(quietBadge.textContent).toBe("Quiet");
  expect(getComputedStyle(quietBadge).visibility).toBe("visible");
  expect(quietBadge.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(getComputedStyle(quietHover).opacity).toBe("1");
  expect(quietBadge.getBoundingClientRect().right).toBeLessThanOrEqual(
    quietHover.getBoundingClientRect().left + 1,
  );

  // Select the sealed worker (which has neither Archive nor Delete), reopen sidebar, and verify its cue stays visible.
  fireEvent.click(row("SealedCue")!);
  fireEvent.click(get(".mobile-menu-btn"));
  const activeSealedRow = row("SealedCue")!;
  expect(activeSealedRow.classList.contains("active")).toBe(true);
  expect(activeSealedRow.querySelector(".task-archive")).toBeNull();
  expect(activeSealedRow.querySelector(".task-delete")).toBeNull();
  expect(getComputedStyle(activeSealedRow.querySelector(".task-hover")!).display).toBe("none");
  const sealedCue = activeSealedRow.querySelector<HTMLElement>(".session-attention")!;
  expect(sealedCue.textContent).toBe("Your turn");
  expect(getComputedStyle(sealedCue).visibility).toBe("visible");
  expect(sealedCue.getBoundingClientRect().width).toBeGreaterThan(0);
});
