import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { render, renderHook, act, fireEvent, screen, within } from "@testing-library/react";
import { App, uploadImage } from "../src/App";
import * as format from "../src/format";
import * as telemetry from "../src/telemetry";
import {
  AUTO_RELOAD,
  useServer,
  type AgentInfo,
  type Message,
  type Workspace,
} from "../src/state/useServer";

import { FakeSocket } from "./fakeSocket";

class ReactSocket extends FakeSocket {
  override receive(frame: unknown) {
    act(() => super.receive(frame));
  }
  override drop() {
    act(() => super.drop());
  }
}

const AGENT: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "🤖",
  color: "#888",
  isDefault: true,
};

const settled = (i: number): Message => ({
  id: `s${i}`,
  kind: "agent",
  agentId: "a1",
  content: `done ${i}`,
  timestamp: 1000 + i,
  status: "done",
  events: [{ kind: "tool_use", content: `**Read** f${i}`, toolUseId: `t${i}`, contentOffset: 0 }],
});

const live: Message = {
  id: "live",
  kind: "agent",
  agentId: "a1",
  content: "",
  timestamp: 5000,
  status: "streaming",
  events: [],
};

function openSocket(
  sock: FakeSocket,
  agents: AgentInfo[],
  others: string[] = [],
  sendReceipt = false,
  projectLink?: Workspace["projectLink"],
) {
  const workspace = (id: string, name: string) => ({
    id,
    name,
    project: "p",
    hostId: "local",
    cwd: "/tmp",
    agents,
    messages: [],
    createdAt: 1,
    projectLink,
  });
  act(() => sock.open());
  sock.receive({
    type: "init",
    sendReceipt,
    workspaces: [workspace("w1", "w"), ...others.map((id) => workspace(id, id))],
    config: {
      presets: [],
      models: [AGENT.model, "claude-sonnet-4-6"].map((id) => ({ id, label: id, backend: "pi" })),
      commands: [],
      hosts: {},
    },
    hosts: [],
  });
}

// App connected to workspace w1 with `messages` as its newest page.
function boot(
  messages: Message[],
  {
    agents = [AGENT],
    hasMore = false,
    others = [] as string[],
    sendReceipt = false,
    projectLink = undefined as Workspace["projectLink"],
  } = {},
) {
  render(<App />);
  const sock = FakeSocket.instances.at(-1)!;
  openSocket(sock, agents, others, sendReceipt, projectLink);
  sock.receive({ type: "workspace_messages", workspaceId: "w1", messages, hasMore });
  frame();
  return sock;
}

const frame = () =>
  act(() => {
    vi.advanceTimersByTime(20);
  });

const delta = (content: string) => ({
  type: "stream_event",
  workspaceId: "w1",
  messageId: "live",
  event: { kind: "text_delta", content },
});

const composer = () => document.querySelector("textarea")!;
const openAgents = () =>
  fireEvent.click(document.querySelector('.side-rail [aria-label="Agents and sessions"]')!);
const selectWorkspace = (name: string) =>
  fireEvent.click(
    [...document.querySelectorAll(".task-item")].find(
      (el) => el.querySelector(".task-name-text")!.firstChild!.textContent === name,
    )!,
  );

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

let scrollIntoView: MockInstance<(arg?: boolean | ScrollIntoViewOptions) => void>;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", ReactSocket);
  scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("routes a cold notification ahead of storage and switches a warm window without losing drafts", () => {
  const prior = location.href;
  const sw = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw });
  try {
    history.replaceState(null, "", "?ws=w2");
    localStorage.setItem("activeWsId", "w1");
    boot([], { others: ["w2"] });
    expect(localStorage.getItem("activeWsId")).toBe("w2");
    fireEvent.change(composer(), { target: { value: "unfinished note" } });
    const open = (wsId: string) =>
      act(() => {
        sw.dispatchEvent(
          new MessageEvent("message", { data: { type: "yaat.open-workspace", wsId } }),
        );
      });
    open("w1");
    expect(localStorage.getItem("activeWsId")).toBe("w1");
    expect(location.search).toBe("?ws=w1");
    open("w2");
    expect(composer().value).toBe("unfinished note");
  } finally {
    Reflect.deleteProperty(navigator, "serviceWorker");
    history.replaceState(null, "", prior);
  }
});

describe("render cost of a live transcript", { tags: ["app-detail"] }, () => {
  // MessageItem formats its timestamp once per render.
  const renders = () => {
    const spy = vi.spyOn(format, "formatMessageTime");
    return () => {
      const n = spy.mock.calls.length;
      spy.mockClear();
      return n;
    };
  };

  it("re-renders only the message that changed", () => {
    const sock = boot([1, 2, 3, 4, 5].map(settled).concat(live));
    const count = renders();
    sock.receive(delta("x"));
    frame();
    expect(count()).toBe(1);

    // The 3 s status broadcast and typing touch no message.
    sock.receive({
      type: "system_status",
      osName: "linux",
      osArch: "x64",
      cpuModel: "cpu",
      cpuCores: 8,
      cpuUsage: 12,
      memTotal: 100,
      memUsed: 50,
      uptime: 1,
      hostname: "h",
      quota: [],
    });
    for (const text of ["f", "fix", "fix @", "fix @Al"]) {
      fireEvent.change(composer(), { target: { value: text, selectionStart: text.length } });
    }
    expect(count()).toBe(0);

    // Activity ticks every second during a long tool: only the
    // streaming message shows it.
    sock.receive({
      type: "agent_activity",
      workspaceId: "w1",
      agentId: "a1",
      activity: "Bash · 3s",
    });
    expect(count()).toBe(1);
    expect(document.querySelector("#msg-live .turn-footer")!.textContent).toBe("Bash · 3s");
  });

  it("updates settled today message timestamps in App after local midnight rollover", () => {
    vi.setSystemTime(new Date(2026, 5, 15, 23, 59, 50));
    const todayTs = new Date(2026, 5, 15, 21, 0, 0).getTime();
    boot([{ ...settled(1), timestamp: todayTs }]);
    const timeEl = () => document.querySelector("#msg-s1 .message-time")!;
    expect(timeEl().textContent).toBe(
      new Date(todayTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );

    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(timeEl().textContent).toBe(format.formatShortDateTime(todayTs));
    expect(timeEl().getAttribute("title")).toBe(format.formatFullDateTime(todayTs));
  });
});

describe("UI telemetry middleware", { tags: ["app-detail"] }, () => {
  it("delegates only the closest allowed click or focus action", () => {
    const record = vi.spyOn(telemetry, "recordTelemetry");
    boot([]);
    const rail = document.querySelector('.side-rail [aria-label="Changes"]')!;
    fireEvent.click(rail.querySelector("svg")!);
    fireEvent.click(rail.querySelector("svg")!);
    const search = screen.getByPlaceholderText("Search messages…");
    fireEvent.click(search);
    fireEvent.focus(search);
    for (const invalid of ["workspace-secret", "chat.send", "trace.tool_toggle/secret"]) {
      rail.setAttribute("data-telemetry", invalid);
      fireEvent.click(rail);
    }
    const target = document.createElement("div");
    target.setAttribute("data-telemetry", "trace.subagent_toggle");
    const cancel = document.createElement("button");
    target.append(cancel);
    document.querySelector(".app")!.append(target);
    fireEvent.click(cancel);
    fireEvent.click(target);
    target.remove();
    expect(record.mock.calls).toEqual([
      ["panel.diff"],
      ["panel.close"],
      ["sidebar.search"],
      ["trace.subagent_toggle"],
    ]);
  });

  it("records user dispatch once and excludes automatic quota, paging, and trace hydration", () => {
    const record = vi.spyOn(telemetry, "recordTelemetry");
    const { result } = renderHook(useServer);
    const sock = FakeSocket.instances.at(-1)!;
    openSocket(sock, [AGENT]);
    act(() => {
      result.current.refreshQuota(false, ["provider"]);
      result.current.loadMessages("w1", 123);
      result.current.markSeen("w1");
      result.current.requestSubagentTrace(
        { workspaceId: "w1", messageId: "message-private", taskId: "task-private" },
        {},
        () => {},
      )();
    });
    expect(record).not.toHaveBeenCalled();
    act(() => {
      result.current.refreshQuota(true, ["provider"]);
      result.current.loadMessageDetails("w1", "message-private");
      result.current.archiveWorkspace("w1");
      result.current.unarchiveWorkspace("w1");
      result.current.interrupt("w1", ["private-1", "private-2"]);
    });
    expect(sock.frames().filter(({ type }) => type === "interrupt")).toHaveLength(2);
    expect(record.mock.calls).toEqual([
      ["quota.refresh"],
      ["trace.load_details"],
      ["workspace.archive"],
      ["workspace.restore"],
      ["chat.stop"],
    ]);
  });
});

describe("composer", () => {
  it.each(
    ["agent_updated", "init"].flatMap((projection) =>
      ["networkWaiting", "retryPending"].map((reason) => [projection, reason]),
    ),
  )("keeps Stop and Send available from %s while %s", async (projection, reason) => {
    const agent: AgentInfo = {
      ...AGENT,
      busy: false,
      state: "idle",
      networkWaiting: false,
      retryPending: false,
    };
    const waiting = { ...agent, [reason]: true };
    const sock = boot([], {
      agents: [projection === "init" ? waiting : agent],
      projectLink: { projectId: "p1", role: "lead" },
    });
    const update = (agent: AgentInfo) =>
      sock.receive({ type: "agent_updated", workspaceId: "w1", agent });
    const composerStop = () => screen.queryByRole("button", { name: "Stop Alice" });
    if (projection === "agent_updated") {
      expect(composerStop()).toBeNull();
      update(waiting);
    }
    fireEvent.click(composerStop()!);
    openAgents();
    const panelStop = () => screen.queryByRole("button", { name: "Stop" });
    fireEvent.click(panelStop()!);
    expect(sock.frames().filter(({ type }) => type === "interrupt")).toEqual([
      { type: "interrupt", workspaceId: "w1", agentId: agent.id },
      { type: "interrupt", workspaceId: "w1" },
    ]);
    fireEvent.change(composer(), { target: { value: "Manual message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});
    expect(sock.frames().filter(({ type }) => type === "send_message")).toMatchObject([
      { workspaceId: "w1", content: "Manual message" },
    ]);
    update(agent);
    expect(composerStop()).toBeNull();
    expect(panelStop()).toBeNull();
  });

  it("records only validated composer submissions from Enter and the button", async () => {
    const record = vi.spyOn(telemetry, "recordTelemetry");
    const sock = boot([], { sendReceipt: true });
    const sendIntents = () => record.mock.calls.filter(([action]) => action === "chat.send");
    const sends = () => sock.frames().filter((frame) => frame.type === "send_message");
    const enter = () => fireEvent.keyDown(composer(), { key: "Enter" });
    fireEvent.change(composer(), { target: { value: "   " } });
    enter();
    expect(sendIntents()).toHaveLength(0);
    fireEvent.change(composer(), { target: { value: "first" } });
    enter();
    enter(); // duplicate while the first send is waiting for its receipt
    expect(sends()).toHaveLength(1);
    expect(sendIntents()).toHaveLength(1);
    sock.receive({ type: "send_receipt", requestId: sends()[0].requestId });
    await act(async () => {});
    fireEvent.change(composer(), { target: { value: "second" } });
    fireEvent.click(document.querySelector(".btn-primary-slot")!);
    expect(sends()).toHaveLength(2);
    expect(sendIntents()).toHaveLength(2);
  });

  it("does not count Agents panel model or effort switches as composer submissions", () => {
    const record = vi.spyOn(telemetry, "recordTelemetry");
    const sock = boot([], { agents: [{ ...AGENT, effortLevels: ["low", "high"] }] });
    openAgents();
    fireEvent.change(screen.getByRole("combobox", { name: "Alice's model" }), {
      target: { value: "claude-sonnet-4-6" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Alice's reasoning effort" }), {
      target: { value: "high" },
    });
    expect(sock.frames().filter((frame) => frame.type === "send_message")).toMatchObject([
      { content: "/model claude-sonnet-4-6" },
      { content: "/effort high" },
    ]);
    expect(record).not.toHaveBeenCalledWith("chat.send");
  });

  it("counts each composer and Agents panel stop intent once", () => {
    const record = vi.spyOn(telemetry, "recordTelemetry");
    const sock = boot([], {
      agents: [
        {
          ...AGENT,
          state: "working",
          backgroundTasks: [{ id: "t", type: "local_bash", description: "build", since: 0 }],
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop Alice" }));
    openAgents();
    const session = within(screen.getByRole("region", { name: "w" }));
    for (const name of ["Stop", "Stop build", "Stop everything"]) {
      fireEvent.click(session.getByRole("button", { name }));
    }
    expect(
      sock
        .frames()
        .filter(
          ({ type }) => type === "interrupt" || type === "cancel_subagent" || type === "abort",
        ),
    ).toEqual([
      { type: "interrupt", workspaceId: "w1", agentId: AGENT.id },
      { type: "interrupt", workspaceId: "w1" },
      { type: "cancel_subagent", workspaceId: "w1", agentId: AGENT.id, taskId: "t" },
      { type: "abort", workspaceId: "w1" },
    ]);
    expect(record.mock.calls.filter(([action]) => action === "chat.stop")).toHaveLength(4);
  });

  it("names each agent's model in the @ list as the agent cards do", () => {
    const cursor = { ...AGENT, id: "a2", name: "Isla", model: "cursor/composer-2.5" };
    boot([], { agents: [AGENT, cursor] });
    fireEvent.change(composer(), { target: { value: "@", selectionStart: 1 } });
    const models = [...document.querySelectorAll(".mention-model")].map((e) => e.textContent);
    expect(models).toEqual(["opus 5.5", "composer 2.5"]);
  });

  it("keeps the draft when the message could not be sent", async () => {
    const sock = boot([settled(1)]);
    sock.drop();
    fireEvent.change(composer(), { target: { value: "a long prompt" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    expect(composer().value).toBe("a long prompt");
    expect(document.querySelector(".error-toast")!.textContent).toMatch(/not connected/i);
    expect(sock.frames().filter((f) => f.type === "send_message")).toEqual([]);
  });

  it("keeps a draft on a retryable seal response and clears it only after a receipt", async () => {
    const sock = boot([], { sendReceipt: true });
    const sendBtn = () => document.querySelector<HTMLButtonElement>(".btn-primary-slot")!;
    fireEvent.change(composer(), { target: { value: "preserve me" } });
    expect(sendBtn().disabled).toBe(false);
    fireEvent.keyDown(composer(), { key: "Enter" });
    const lastSend = () =>
      sock
        .frames()
        .filter((frame) => frame.type === "send_message")
        .at(-1)!;
    expect(composer().value).toBe("preserve me");
    expect(sendBtn().disabled).toBe(true);
    expect(sendBtn().getAttribute("aria-busy")).toBe("true");
    sock.receive({
      type: "error",
      message: "Retry shortly",
      retryable: true,
      requestId: lastSend().requestId,
    });
    await act(async () => {});
    expect(composer().value).toBe("preserve me");
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().getAttribute("aria-busy")).toBeNull();
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(sendBtn().disabled).toBe(true);
    expect(sendBtn().getAttribute("aria-busy")).toBe("true");
    sock.receive({ type: "send_receipt", requestId: lastSend().requestId });
    await act(async () => {});
    expect(composer().value).toBe("");
    expect(sendBtn().getAttribute("aria-busy")).toBeNull();
  });

  it("leaves another workspace's draft alone when a held send completes", async () => {
    const sock = boot([], { others: ["w2"] });
    selectWorkspace("w2");
    fireEvent.change(composer(), { target: { value: "w2 draft" } });
    selectWorkspace("w");
    // The phone wakes: a liveness probe is in flight when send is tapped.
    setVisibility("hidden");
    setVisibility("visible");
    expect(sock.frames().at(-1)).toEqual({ type: "ping" });
    fireEvent.change(composer(), { target: { value: "hello" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    selectWorkspace("w2");
    sock.receive({ type: "pong" });
    await act(async () => {});
    expect(sock.frames()).toContainEqual(
      expect.objectContaining({ type: "send_message", workspaceId: "w1", content: "hello" }),
    );
    expect(composer().value).toBe("w2 draft");
    // The sent text does not come back with its workspace.
    selectWorkspace("w");
    expect(composer().value).toBe("");
  });

  it("keeps what was typed while a send was held", async () => {
    const sock = boot([]);
    setVisibility("visible");
    fireEvent.change(composer(), { target: { value: "hello" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    fireEvent.change(composer(), { target: { value: "hello, and one more thing" } });
    sock.receive({ type: "pong" });
    await act(async () => {});
    expect(composer().value).toBe("hello, and one more thing");
  });

  it("sends and clears a draft on deliberate Enter, not on IME confirmation", async () => {
    const sock = boot([settled(1)]);
    const input = composer();
    const sends = () => sock.frames().filter((f) => f.type === "send_message");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "继续" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("继续");
    expect(sends()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(input.value).toBe("");
    expect(sends()).toMatchObject([{ content: "继续" }]);
  });
});

describe("search jumps", () => {
  function searchAndOpen(
    sock: FakeSocket,
    hit: { messageId: string; timestamp: number },
    workspaceId = "w1",
  ) {
    fireEvent.change(document.querySelector(".search-bar input")!, {
      target: { value: "needle" },
    });
    sock.receive({
      type: "search_results",
      query: "needle",
      hits: [{ workspaceId, workspaceName: "w", snippet: "needle", ...hit }],
    });
    fireEvent.click(document.querySelector(".search-result-item")!);
    frame();
  }

  const page = (ids: number[]): Message[] =>
    ids.map((i) => ({ ...settled(i), id: `m${i}`, timestamp: i }));

  it("only counts cross-workspace jumps and closes the drawer on sidebar reselect", () => {
    const record = vi.spyOn(telemetry, "recordTelemetry");
    const sock = boot(page([100]), { others: ["w2"] });
    fireEvent.click(document.querySelector(".mobile-menu-btn")!);
    expect(document.querySelector(".sidebar-open")).not.toBeNull();
    selectWorkspace("w");
    expect(document.querySelector(".sidebar-open")).toBeNull();
    const hit = { messageId: "m100", timestamp: 100 };
    searchAndOpen(sock, hit);
    expect(record).not.toHaveBeenCalledWith("workspace.switch");
    searchAndOpen(sock, hit, "w2");
    expect(record.mock.calls.filter(([action]) => action === "workspace.switch")).toEqual([
      ["workspace.switch"],
    ]);
  });

  it("is dropped when the reader leaves the workspace before it lands", () => {
    const sock = boot(page([100, 101]), { hasMore: true, others: ["w2"] });
    searchAndOpen(sock, { messageId: "m10", timestamp: 10 });
    selectWorkspace("w2");
    sock.receive({
      type: "workspace_messages",
      workspaceId: "w1",
      before: 100,
      hasMore: true,
      messages: page([50, 51]),
    });
    frame();
    const olderAsks = () =>
      sock.frames().filter((f) => f.type === "load_messages" && f.before != null).length;
    const asked = olderAsks();
    selectWorkspace("w");
    frame();
    expect(olderAsks()).toBe(asked);
  });

  it("gives up after a bounded number of pages", () => {
    const sock = boot(page([10_000]), { hasMore: true });
    searchAndOpen(sock, { messageId: "ancient", timestamp: 1 });
    let asks = 0;
    for (;;) {
      const older = sock.frames().filter((f) => f.type === "load_messages" && f.before != null);
      if (older.length === asks) break;
      const before = older[asks++].before as number;
      sock.receive({
        type: "workspace_messages",
        workspaceId: "w1",
        before,
        hasMore: true,
        messages: page([before - 2, before - 1]),
      });
      frame();
      if (asks > 50) throw new Error("never gives up");
    }
    expect(asks).toBe(10);
    expect(document.querySelector(".info-toast")!.textContent).toMatch(/no longer/);
  });

  it("says so when the hit is no longer in the history", () => {
    const sock = boot(page([100]), { hasMore: true });
    searchAndOpen(sock, { messageId: "gone", timestamp: 10 });
    sock.receive({
      type: "workspace_messages",
      workspaceId: "w1",
      before: 100,
      hasMore: false,
      messages: page([5]),
    });
    frame();
    expect(document.querySelector(".info-toast")!.textContent).toMatch(/no longer/);
  });
});

// A server that pages exactly like index.ts: `limit` messages older than
// `before` plus every message tied at `before`; hasMore when older remain.
describe("search jumps against the server's paging", () => {
  const message = (i: number, ts: number): Message => ({
    id: `m${i}`,
    kind: "agent",
    agentId: "a1",
    content: `needle ${i}`,
    timestamp: ts,
    status: "done",
  });

  function serve(all: Message[], req: Record<string, unknown>) {
    const before = (req.before as number) ?? Infinity;
    const limit = Math.min((req.limit as number) ?? 50, 200);
    const older = before === Infinity ? all : all.filter((m) => m.timestamp < before);
    const tied = before === Infinity ? [] : all.filter((m) => m.timestamp === before);
    return {
      type: "workspace_messages",
      workspaceId: "w1",
      messages: [...older.slice(-limit), ...tied],
      hasMore: older.length > limit,
      before: before === Infinity ? null : before,
    };
  }

  // Answers, in order, every load_messages sent on `sock` and not answered
  // yet, including the ones sent in reaction, until the app stops asking.
  function answerAll(sock: FakeSocket, all: () => Message[]) {
    let answered = 0;
    for (let rounds = 0; ; rounds++) {
      const asks = sock.frames().filter((f) => f.type === "load_messages");
      if (answered === asks.length) return;
      if (rounds > 50) throw new Error("the app never stops paging");
      sock.receive(serve(all(), asks[answered++]));
      frame();
    }
  }

  function searchAndOpen(sock: FakeSocket, hit: Message) {
    fireEvent.change(document.querySelector(".search-bar input")!, {
      target: { value: "needle" },
    });
    sock.receive({
      type: "search_results",
      query: "needle",
      hits: [
        {
          workspaceId: "w1",
          workspaceName: "w",
          snippet: "needle",
          messageId: hit.id,
          timestamp: hit.timestamp,
        },
      ],
    });
    fireEvent.click(document.querySelector(".search-result-item")!);
    frame();
  }

  const renderedIds = () =>
    [...document.querySelectorAll("[id^=msg-]")].map((e) => e.id.slice("msg-".length));

  it(
    "reaches an old hit through tie groups split across pages, with no gap or duplicate",
    { tags: ["history-stress"], timeout: 30_000 },
    () => {
      // Three messages per millisecond: page edges fall inside groups.
      const all = Array.from({ length: 1000 }, (_, i) => message(i, 1000 + Math.floor(i / 3)));
      render(<App />);
      const sock = FakeSocket.instances.at(-1)!;
      openSocket(sock, [AGENT]);
      answerAll(sock, () => all);
      searchAndOpen(sock, all[5]);
      answerAll(sock, () => all);
      expect(renderedIds()).toEqual(all.map((m) => m.id));
      expect(document.querySelector("#msg-m5")!.classList).toContain("message-highlight");
    },
  );

  it("keeps the history in order when an older page is answered after a resync", () => {
    // Loaded m100..m149; the jump's older-page request goes out, then the
    // socket drops before the reply and 100 more messages are written.
    let all = Array.from({ length: 150 }, (_, i) => message(i, 1000 + i));
    render(<App />);
    const first = FakeSocket.instances.at(-1)!;
    openSocket(first, [AGENT]);
    answerAll(first, () => all);
    searchAndOpen(first, all[10]);
    expect(first.frames()).toContainEqual(
      expect.objectContaining({ type: "load_messages", before: 1100 }),
    );
    first.drop();
    all = [...all, ...Array.from({ length: 100 }, (_, i) => message(150 + i, 1150 + i))];
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const next = FakeSocket.instances.at(-1)!;
    openSocket(next, [AGENT]);
    frame();
    // The newest page, then the jump's now stale older page.
    expect(
      next
        .frames()
        .filter((f) => f.type === "load_messages")
        .map((f) => f.before ?? null),
    ).toEqual([null, 1100]);
    answerAll(next, () => all);
    expect(renderedIds()).toEqual(all.map((m) => m.id));
  });
});

describe("files panel", { tags: ["app-detail"] }, () => {
  const fetchMock = vi.fn((url: string) => {
    const path = new URLSearchParams(url.split("?")[1]).get("path")!;
    const view =
      path === "."
        ? {
            kind: "dir",
            path: "/tmp",
            truncated: false,
            entries: [{ name: "b.ts", dir: false, size: 3 }],
          }
        : { kind: "text", path: `/tmp/${path}`, size: 3, content: "hi\n", truncated: false };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(view) });
  });
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => vi.unstubAllGlobals());

  const panel = () => document.querySelector('aside[aria-label="Files"]');
  const lastFetch = () => fetchMock.mock.calls.at(-1)![0];

  it.each(["C:\\captures\\one#final.png", "artifacts/one`two.png"])(
    "opens a ViewImage filename literally: %s",
    async (path) => {
      const record = vi.spyOn(telemetry, "recordTelemetry");
      boot([
        {
          ...settled(1),
          content: "",
          events: [
            {
              kind: "tool_use",
              toolName: "ViewImage",
              toolUseId: "image-1",
              content: `**ViewImage** \`${path}\``,
              toolResult: "",
              contentOffset: 0,
            },
          ],
        },
      ]);
      fireEvent.click(document.querySelector(".step-header")!);
      fireEvent.click(document.querySelector(".event-summary-line .file-ref")!);
      await act(async () => {});
      expect(lastFetch()).toBe(`api/file?ws=w1&path=${encodeURIComponent(path)}&literal=1`);
      expect(panel()!.querySelector(".fp-btn[href]")?.getAttribute("href")).toContain("&literal=1");
      expect(record.mock.calls).toEqual([["trace.step_toggle"], ["chat.file_link"]]);
    },
  );

  it("quotes lines picked in a file into the composer, under their path", async () => {
    boot([{ ...settled(1), content: "Changed `src/a.ts:3`." }]);
    const input = document.querySelector("textarea")!;
    fireEvent.input(input, { target: { value: "context first" } });
    fireEvent.click(document.querySelector(".message-content .file-ref")!);
    await act(async () => {});
    const pickAll = () =>
      act(() => {
        const range = document.createRange();
        range.selectNodeContents(panel()!.querySelector(".code-text")!);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    pickAll();
    fireEvent.click(panel()!.querySelector(".fp-ask")!);
    expect(input.value).toBe("context first\n\n`src/a.ts:1`\n```typescript\nhi\n```\n");
    expect(document.activeElement).toBe(input);
    expect(panel()).not.toBeNull();

    // A phone's panel covers the composer: it steps aside.
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true,
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    fireEvent.input(input, { target: { value: "" } });
    pickAll();
    fireEvent.click(panel()!.querySelector(".fp-ask")!);
    expect(input.value).toBe("`src/a.ts:1`\n```typescript\nhi\n```\n");
    expect(panel()).toBeNull();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", fetchMock);

    // A panel maximised over the chat covers the composer too.
    fireEvent.click(document.querySelector(".message-content .file-ref")!);
    await act(async () => {});
    fireEvent.click(panel()!.querySelector(".side-panel-max")!);
    expect(panel()!.classList.contains("maximized")).toBe(true);
    pickAll();
    fireEvent.click(panel()!.querySelector(".fp-ask")!);
    expect(panel()!.classList.contains("maximized")).toBe(false);
  });

  it("keeps where the reader went in each session's panel", async () => {
    boot([settled(1)], { others: ["w2"] });
    fireEvent.click(document.querySelector('.side-rail [aria-label="Files"]')!);
    await act(async () => {});
    fireEvent.click(panel()!.querySelector(".dir-entry")!);
    await act(async () => {});
    expect(lastFetch()).toBe("api/file?ws=w1&path=%2Ftmp%2Fb.ts");

    selectWorkspace("w2");
    await act(async () => {});
    expect(lastFetch()).toBe("api/file?ws=w2&path=.");
    selectWorkspace("w");
    await act(async () => {});
    expect(lastFetch()).toBe("api/file?ws=w1&path=%2Ftmp%2Fb.ts");
    expect(panel()!.querySelector(".code-text")!.textContent).toBe("hi\n");
  });
});

describe("changes panel", { tags: ["app-detail"] }, () => {
  const urls: string[] = [];
  const fetchMock = vi.fn((url: string) => {
    if (url === "api/diagnostics") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ issues: [] }),
      });
    }
    urls.push(url);
    const body = url.startsWith("api/diff/file")
      ? { path: "src/a.ts", binary: false, truncated: false, diff: "@@ -1 +1 @@\n-a\n+b\n" }
      : url.startsWith("api/diff")
        ? {
            top: "/tmp",
            branch: "feature",
            base: "origin/main",
            against: "a".repeat(40),
            truncated: false,
            files: [{ path: "src/a.ts", status: "modified", added: 1, removed: 1 }],
          }
        : { kind: "text", path: "/tmp/src/a.ts", size: 2, content: "b\n", truncated: false };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  beforeEach(() => {
    urls.length = 0;
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const aside = (label: string) => document.querySelector(`aside[aria-label="${label}"]`);

  it("opens the session's changes from the rail, and a changed file in the Files panel", async () => {
    const record = vi.spyOn(telemetry, "recordTelemetry");
    boot([settled(1)], { others: ["w2"] });
    fireEvent.click(document.querySelector('.side-rail [aria-label="Changes"]')!);
    await act(async () => {});
    expect(urls).toEqual(["api/diff?ws=w1&dir=%2Ftmp"]);
    const panel = aside("Changes")!;
    expect(panel.querySelector(".change-entry")).not.toBeNull();
    // Nothing to go back to, nor files to switch to.
    expect(panel.querySelector(".fp-up")).toBeNull();
    expect(panel.querySelector(".fp-toggle")).toBeNull();

    fireEvent.click(panel.querySelector(".change-entry")!);
    await act(async () => {});
    expect(panel.querySelector(".diff-view")).not.toBeNull();
    fireEvent.click(panel.querySelector('[title="Open the file"]')!);
    await act(async () => {});
    expect(aside("Changes")).toBeNull();
    expect(aside("Files")!.querySelector(".code-text")!.textContent).toBe("b\n");
    expect(urls.at(-1)).toBe("api/file?ws=w1&path=%2Ftmp%2Fsrc%2Fa.ts");
    expect(record.mock.calls).toEqual([["panel.diff"], ["panel.files"]]);

    // Another session's changes are its own.
    fireEvent.click(document.querySelector('.side-rail [aria-label="Changes"]')!);
    await act(async () => {});
    selectWorkspace("w2");
    await act(async () => {});
    expect(urls.at(-1)).toBe("api/diff?ws=w2&dir=%2Ftmp");
  });
});

describe("read state shared by every device", () => {
  // jsdom's document never has focus.
  let focused: MockInstance<() => boolean>;
  beforeEach(() => {
    focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  const row = (name: string) =>
    [...document.querySelectorAll(".task-item")].find(
      (el) => el.querySelector(".task-name-text")!.firstChild!.textContent === name,
    )!;
  const marks = (sock: FakeSocket) =>
    sock
      .frames()
      .filter((f) => f.type === "mark_seen")
      .map((f) => f.workspaceId);
  const newMessage = (workspaceId: string, id: string): unknown => ({
    type: "new_message",
    workspaceId,
    message: { ...settled(9), id, status: "streaming" },
  });
  const result = (workspaceId: string, unread = 1, lastResult = "done") => ({
    type: "workspace_attention",
    workspaceId,
    unread,
    lastResult,
  });

  it("marks the session on screen read, but not from a page in the background", () => {
    const sock = boot([settled(1)], { others: ["w2"] });
    expect(marks(sock)).toEqual([]);
    setVisibility("hidden");
    sock.receive(result("w1"));
    expect(marks(sock)).toEqual([]);
    setVisibility("visible");
    expect(marks(sock)).toEqual(["w1"]);
    sock.sent = [];
    focused.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    sock.receive(result("w1", 2));
    expect(marks(sock)).toEqual([]);
  });

  it("shows only authoritative unread results until any device reads them", () => {
    const sock = boot([settled(1)], { others: ["w2"] });
    sock.receive(newMessage("w2", "n1"));
    sock.receive(newMessage("w2", "n2"));
    expect(row("w2").querySelector(".session-attention")).toBeNull();
    sock.receive(result("w2", 2));
    expect(row("w2").querySelector(".session-attention")!.textContent).toBe("Unread result");
    sock.receive({ type: "workspace_seen", workspaceId: "w2" });
    expect(row("w2").querySelector(".session-attention")).toBeNull();
  });

  const reconnect = (sock: FakeSocket) => {
    sock.drop();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    return FakeSocket.instances.at(-1)!;
  };

  it("marks again after a reconnect when a mark went into a dead socket", () => {
    const sock = boot([settled(1)]);
    setVisibility("hidden");
    sock.receive(result("w1"));
    sock.close();
    setVisibility("visible");
    const next = reconnect(sock);
    act(() => next.open());
    next.receive({
      type: "init",
      workspaces: [
        {
          id: "w1",
          name: "w",
          project: "p",
          hostId: "local",
          cwd: "/tmp",
          agents: [AGENT],
          messages: [],
          createdAt: 1,
          unread: 1,
        },
      ],
      config: { presets: [], models: [], commands: [], hosts: {} },
      hosts: [],
    });
    expect(marks(next)).toContain("w1");
  });

  it("uses the reconnect snapshot instead of a remembered completion", () => {
    const sock = boot([settled(1)], { others: ["w2"] });
    sock.receive(result("w2"));
    expect(row("w2").querySelector(".session-attention")!.textContent).toBe("Unread result");
    openSocket(reconnect(sock), [AGENT], ["w2"]);
    expect(row("w2").querySelector(".session-attention")).toBeNull();
  });

  it("reads nothing from a page left untouched for minutes", () => {
    boot([settled(1)]);
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    // The fake server never answers the liveness probe: talk to the socket
    // the app has now.
    const sock = FakeSocket.instances.at(-1)!;
    if (sock.readyState !== FakeSocket.OPEN) openSocket(sock, [AGENT]);
    sock.sent = [];
    sock.receive(result("w1"));
    expect(marks(sock)).toEqual([]);
    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(marks(sock)).toEqual(["w1"]);
  });

  it("keeps a failure actionable after being read; later success supersedes it", () => {
    const sock = boot([settled(1)], { others: ["w2"] });
    sock.receive(result("w2", 1, "failed"));
    expect(row("w2").querySelector(".session-attention")!.textContent).toBe("Failed");
    sock.receive({ type: "workspace_seen", workspaceId: "w2" });
    expect(row("w2").querySelector(".session-attention")!.textContent).toBe("Failed");
    sock.receive(result("w2"));
    expect(row("w2").querySelector(".session-attention")!.textContent).toBe("Unread result");
  });

  it("reads nothing after reloading itself for a new build until someone touches the page", () => {
    sessionStorage.setItem(AUTO_RELOAD, "1");
    const sock = boot([settled(1)]);
    sock.receive(result("w1"));
    expect(marks(sock)).toEqual([]);
    act(() => {
      window.dispatchEvent(new Event("keydown"));
    });
    expect(marks(sock)).toEqual(["w1"]);
  });
});

describe("debug strip", { tags: ["app-detail"] }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("captures with Alt+Shift+S without opening the strip or moving focus", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "api/diagnostics") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ issues: [] }) });
      }
      if (url === "debug/snapshot") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ path: "/tmp/shortcut-snapshot.json" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    boot([settled(1)]);
    await act(async () => {});
    composer().focus();
    const uploads = () => fetchMock.mock.calls.filter(([url]) => url === "debug/snapshot").length;
    for (const init of [
      { code: "KeyS", altKey: true },
      { code: "KeyS", shiftKey: true },
      { code: "KeyS", altKey: true, shiftKey: true, ctrlKey: true },
      { code: "KeyS", altKey: true, shiftKey: true, metaKey: true },
      { code: "KeyA", altKey: true, shiftKey: true },
    ]) {
      fireEvent.keyDown(document, init);
    }
    expect(uploads()).toBe(0);
    expect(fireEvent.keyDown(document, { code: "KeyS", altKey: true, shiftKey: true })).toBe(false);
    expect(uploads()).toBe(1);
    expect(document.querySelector(".sidebar-debug-strip")).toBeNull();
    expect(document.activeElement).toBe(composer());
    // A layout's letter S works too; code KeyS still covers Alt-transformed key values.
    fireEvent.keyDown(composer(), { code: "Semicolon", key: "s", altKey: true, shiftKey: true });
    expect(uploads()).toBe(2);
    expect(document.activeElement).toBe(composer());
    fireEvent.keyDown(document, { code: "KeyS", altKey: true, shiftKey: true, repeat: true });
    expect(uploads()).toBe(2);
    await act(async () => {});
    expect(document.querySelector(".info-toast")!.textContent).toBe(
      "Snapshot saved: /tmp/shortcut-snapshot.json",
    );
    fireEvent.click(document.querySelector(".sidebar-debug")!);
    expect(
      document.querySelector('[aria-label="Capture debug snapshot"]')!.getAttribute("title"),
    ).toBe("Capture debug snapshot (Alt+Shift+S)");
  });

  it("shows uploading, saved, and failed toast feedback on explicit Snapshot clicks and keeps strip open on desktop Demo", async () => {
    let resolveUpload!: (res: {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }) => void;
    let uploads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "api/diagnostics") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ issues: [] }),
        });
      }
      if (url === "debug/snapshot") {
        uploads += 1;
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    boot([settled(1)]);
    await act(async () => {});

    const trigger = document.querySelector<HTMLButtonElement>(".sidebar-debug")!;
    fireEvent.click(trigger);
    expect(uploads).toBe(0);
    expect(document.querySelector(".sidebar-debug-strip")).not.toBeNull();

    const snapshot = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Capture debug snapshot"]',
    )!;
    fireEvent.click(snapshot);
    expect(uploads).toBe(1);
    expect(document.querySelector(".info-toast")!.textContent).toBe("Saving debug snapshot…");
    expect(document.querySelector(".sidebar-debug-status")!.textContent).toBe("Saving snapshot…");

    resolveUpload({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ path: "/tmp/snap-1.json" }),
    });
    await act(async () => {});
    expect(document.querySelector(".info-toast")!.textContent).toBe(
      "Snapshot saved: /tmp/snap-1.json",
    );
    expect(document.querySelector(".sidebar-debug-status")!.textContent).toBe("Snapshot saved");

    fireEvent.click(snapshot);
    expect(uploads).toBe(2);
    resolveUpload({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await act(async () => {});
    expect(document.querySelector(".info-toast")!.textContent).toContain("Snapshot failed:");
    expect(document.querySelector(".sidebar-debug-status")!.textContent).toBe("Snapshot failed");

    const demo = document.querySelector<HTMLButtonElement>('button[aria-label="Replay demo"]')!;
    fireEvent.click(demo);
    expect(document.querySelector(".sidebar-debug-strip")).not.toBeNull();
  });
});

describe("uploadImage", () => {
  it("uses the compressed Blob's type while keeping the original filename", async () => {
    const compressed = new Blob(["compressed"], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "Image",
      class {
        width = 4;
        height = 4;
        onload?: () => void;
        set src(_url: string) {
          this.onload?.();
        }
      },
    );
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:upload-test");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    // A canvas can fall back to PNG when the requested encoder is unavailable.
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((callback) => callback(compressed));
    try {
      await uploadImage(new File(["original"], "photo.webp", { type: "image/webp" }));
      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.85);
      expect(fetchMock).toHaveBeenCalledWith(
        "upload",
        expect.objectContaining({
          body: compressed,
          headers: { "Content-Type": "image/png", "X-Filename": "photo.webp" },
        }),
      );
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      getContext.mockRestore();
      toBlob.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("encodes non-ASCII filenames in X-Filename and preserves fallback blob Content-Type on image upload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: "屏幕截图.png", url: "uploads/1-abc.png" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("no canvas in jsdom");
    });
    try {
      const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "屏幕截图.png", {
        type: "image/png",
      });
      const res = await uploadImage(file);
      expect(res).toEqual({ name: "屏幕截图.png", url: "uploads/1-abc.png" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("upload");
      expect(init.headers).toEqual({
        "Content-Type": "image/png",
        "X-Filename": encodeURIComponent("屏幕截图.png"),
      });
      expect(init.body).toBe(file);
    } finally {
      createObjectURL.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
