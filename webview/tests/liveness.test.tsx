import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import {
  useServer,
  PROBE_TIMEOUT_MS,
  HEARTBEAT_MS,
  HIDDEN_FLUSH_MS,
  type Message,
  type Workspace,
} from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

const init = {
  type: "init",
  workspaces: [],
  config: { presets: [], models: [], commands: [], hosts: {} },
  hosts: [],
};

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

const W: Workspace = {
  id: "w",
  name: "w",
  project: "p",
  hostId: "h",
  cwd: "/",
  agents: [],
  messages: [],
  createdAt: 0,
};

function openSnapshot(ws: FakeSocket, workspaces = [W]) {
  ws.open();
  ws.receive({ ...init, workspaces });
}

// A hook connected to a fake server that has sent `init` with workspace "w".
function connected(
  wrapper?: ({ children }: { children: ReactNode }) => ReactNode,
  workspaces = [W],
) {
  const hook = renderHook(() => useServer(), wrapper ? { wrapper } : undefined);
  const ws = FakeSocket.instances.at(-1)!;
  act(() => openSnapshot(ws, workspaces));
  return { result: hook.result, unmount: hook.unmount, ws };
}

const workspacePage = (messages: Message[], before: number | null = null, hasMore = false) => ({
  type: "workspace_messages",
  workspaceId: "w",
  messages,
  before,
  hasMore,
});

const streamEvent = (event: Record<string, unknown>, messageId = "m1") => ({
  type: "stream_event",
  workspaceId: "w",
  messageId,
  event,
});

const liveMessage = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  kind: "agent",
  agentId: "a",
  content: "Hello",
  timestamp: 1,
  status: "streaming",
  events: [],
  ...over,
});

const frame = () =>
  act(() => {
    vi.advanceTimersByTime(32);
  });

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  setVisibility("visible");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("connection liveness", () => {
  it("replaces a socket that stops answering when the app returns to the foreground", () => {
    const { result } = renderHook(() => useServer());
    const first = FakeSocket.instances[0];
    act(() => {
      first.open();
      first.receive(init);
    });
    expect(result.current.connected).toBe(true);

    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    expect(first.frames().at(-1)).toEqual({ type: "ping" });

    // No pong: the socket is dead even though the browser never said so.
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    expect(result.current.connected).toBe(false);
    expect(FakeSocket.instances).toHaveLength(2);

    act(() => {
      FakeSocket.instances[1].open();
    });
    expect(result.current.connected).toBe(true);
  });

  it("keeps a healthy socket when the server answers the probe", () => {
    renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    act(() => {
      ws.open();
      ws.receive(init);
    });
    act(() => setVisibility("visible"));
    act(() => ws.receive({ type: "pong" }));
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(ws.readyState).toBe(FakeSocket.OPEN);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("probes on a timer while visible", () => {
    renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    act(() => {
      ws.open();
      ws.receive(init);
    });
    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS);
    });
    expect(ws.frames().filter((f) => f.type === "ping")).toHaveLength(1);
  });

  it("reconnects immediately on foreground instead of waiting out the back-off", () => {
    renderHook(() => useServer());
    const first = FakeSocket.instances[0];
    act(() => {
      first.open();
      first.onclose?.();
    });
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => setVisibility("visible"));
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => {
      FakeSocket.instances[1].open();
      FakeSocket.instances[1].receive(init);
    });
    // The back-off timer was cancelled, so no third socket appears.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("uses the reconnected snapshot's timers even if no new thinking text arrives", () => {
    const { result, ws } = connected();
    const page = (over: Record<string, unknown>) => ({
      type: "workspace_messages",
      workspaceId: "w",
      hasMore: false,
      before: null,
      messages: [liveMessage(over)],
    });
    act(() => ws.receive(page({ waitingSince: 1_000 })));
    expect(result.current.workspaces[0].messages[0].waitingSince).toBe(1_000);

    act(() => ws.drop());
    act(() => setVisibility("visible"));
    const next = FakeSocket.instances.at(-1)!;
    expect(next).not.toBe(ws);
    act(() => {
      openSnapshot(next);
      next.receive(page({ liveThinkingSince: 3_000 }));
    });
    const reply = () => result.current.workspaces[0].messages[0];
    expect(reply().liveThinkingSince).toBe(3_000);
    expect(reply().liveThinking).toBeUndefined();
    expect(reply().waitingSince).toBeUndefined();

    act(() => next.receive(streamEvent({ kind: "text_delta", content: "!", waitingSince: 8_000 })));
    frame();
    expect(reply().liveThinkingSince).toBeUndefined();
    expect(reply().waitingSince).toBe(8_000);
  });
});

describe("resync detail refetch", () => {
  it("re-fetches bodies for a message the user was watching live", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    const w = { id: "w", name: "w", project: "p", hostId: "h", cwd: "/", agents: [], messages: [] };
    const page = (messages: unknown[]) => ({
      type: "workspace_messages",
      workspaceId: "w",
      hasMore: false,
      before: null,
      messages,
    });
    act(() => {
      ws.open();
      ws.receive({ ...init, workspaces: [{ ...w, createdAt: 0 }] });
      ws.receive(
        page([
          { id: "m1", kind: "agent", agentId: "a", content: "", timestamp: 1, status: "streaming" },
        ]),
      );
      // Streamed live: full thinking body on the client.
      ws.receive({
        type: "stream_event",
        workspaceId: "w",
        messageId: "m1",
        event: { kind: "thinking", content: "long reasoning" },
      });
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(result.current.workspaces[0].messages[0].events?.[0].content).toBe("long reasoning");

    // Reconnect resync: the server sends the same message as a summary.
    act(() => {
      ws.receive(
        page([
          {
            id: "m1",
            kind: "agent",
            agentId: "a",
            content: "",
            timestamp: 1,
            status: "streaming",
            events: [{ kind: "thinking", content: "", contentLength: 14 }],
            detail: "summary",
          },
        ]),
      );
    });
    expect(ws.frames().at(-1)).toEqual({
      type: "load_message_details",
      workspaceId: "w",
      messageId: "m1",
    });

    act(() => {
      ws.receive({
        type: "message_details",
        workspaceId: "w",
        messageId: "m1",
        events: [{ kind: "thinking", content: "long reasoning" }],
      });
    });
    const m = result.current.workspaces[0].messages[0];
    expect(m.detail).toBeUndefined();
    expect(m.events?.[0].content).toBe("long reasoning");
  });
});

describe("message_done status patch", () => {
  it("applies the effort and context reported at the end of the turn", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    const w = { id: "w", name: "w", project: "p", hostId: "h", cwd: "/", agents: [], messages: [] };
    act(() => {
      ws.open();
      ws.receive({ ...init, workspaces: [{ ...w, createdAt: 0 }] });
      ws.receive({
        type: "new_message",
        workspaceId: "w",
        message: {
          id: "m1",
          kind: "agent",
          agentId: "a",
          content: "",
          timestamp: 1,
          status: "streaming",
        },
      });
      ws.receive({
        type: "message_done",
        workspaceId: "w",
        messageId: "m1",
        status: "done",
        content: "ok",
        effort: "medium",
        context: { tokens: 4000, window: 264600 },
      });
    });
    const m = result.current.workspaces[0].messages[0];
    expect(m.effort).toBe("medium");
    expect(m.context).toEqual({ tokens: 4000, window: 264600 });
  });

  it("ends a live thinking block and records the turn's thinking", () => {
    const { result, ws } = connected();
    act(() => {
      ws.receive({ type: "new_message", workspaceId: "w", message: liveMessage() });
      ws.receive(streamEvent({ kind: "thinking_delta", content: "" }));
      ws.receive(streamEvent({ kind: "thinking_delta", content: "weighing it" }));
      ws.receive({
        type: "message_done",
        workspaceId: "w",
        messageId: "m1",
        status: "done",
        content: "ok",
        thinking: { tokens: 1200, durationMs: 45_000 },
      });
    });
    const m = result.current.workspaces[0].messages[0];
    expect(m.liveThinking).toBeUndefined();
    expect(m.liveThinkingSince).toBeUndefined();
    expect(m.thinking).toEqual({ tokens: 1200, durationMs: 45_000 });
  });
});

describe("message_done ordering", () => {
  it("applies events still waiting for a frame before finishing the message", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    const w = { id: "w", name: "w", project: "p", hostId: "h", cwd: "/", agents: [], messages: [] };
    act(() => {
      ws.open();
      ws.receive({ ...init, workspaces: [{ ...w, createdAt: 0 }] });
      ws.receive({
        type: "new_message",
        workspaceId: "w",
        message: {
          id: "m1",
          kind: "agent",
          agentId: "a",
          content: "",
          timestamp: 1,
          status: "streaming",
        },
      });
      ws.receive({
        type: "stream_event",
        workspaceId: "w",
        messageId: "m1",
        event: {
          kind: "subagent_start",
          content: "",
          subagent: { taskId: "t", description: "d" },
        },
      });
      ws.receive({
        type: "stream_event",
        workspaceId: "w",
        messageId: "m1",
        event: {
          kind: "subagent_enrichment",
          content: "",
          subagent: {
            taskId: "t",
            description: "",
            lastTool: "Read",
            eventCount: 1,
            transcriptRevision: 1,
          },
        },
      });
      // No animation frame yet: message_done arrives with the stripped copy.
      ws.receive({
        type: "message_done",
        workspaceId: "w",
        messageId: "m1",
        status: "done",
        content: "ok",
        events: [
          {
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "t",
              description: "d",
              eventCount: 1,
              transcriptRevision: 1,
              lastTool: "Read",
            },
          },
        ],
      });
    });
    const m = result.current.workspaces[0].messages[0];
    expect(m.status).toBe("done");
    expect(m.events?.[0].subagent).toMatchObject({
      eventCount: 1,
      transcriptRevision: 1,
      lastTool: "Read",
    });
  });
});

describe("snapshot replies after events still waiting for a frame", () => {
  it("does not apply them again on top of a page that already has them", () => {
    const { result, ws } = connected();
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    // Same frame: a delta, a tool call, then a resync page that has both.
    act(() => {
      ws.receive(streamEvent({ kind: "text_delta", content: " world" }));
      ws.receive(streamEvent({ kind: "tool_use", content: "**Read** a", toolUseId: "t1" }));
      ws.receive({
        type: "workspace_messages",
        workspaceId: "w",
        before: null,
        messages: [
          liveMessage({
            content: "Hello world",
            events: [{ kind: "tool_use", content: "**Read** a", toolUseId: "t1" }],
          }),
        ],
      });
    });
    frame();
    const m = result.current.workspaces[0].messages[0];
    expect(m.content).toBe("Hello world");
    expect(m.events).toHaveLength(1);
  });

  it("does not repeat them on top of fetched details", () => {
    const { result, ws } = connected();
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    const call = { kind: "tool_use", content: "**Read** a", toolUseId: "t1" };
    act(() => {
      ws.receive(streamEvent(call));
      ws.receive({ type: "message_details", workspaceId: "w", messageId: "m1", events: [call] });
    });
    frame();
    expect(result.current.workspaces[0].messages[0].events).toHaveLength(1);
  });

  it("routes a requested trace page outside message state and drops cancelled or oversize replies", () => {
    const { result, ws } = connected(({ children }) => <StrictMode>{children}</StrictMode>);
    const target = { workspaceId: "w", messageId: "m1", taskId: "T" };
    const receive = vi.fn();
    const events = [{ kind: "text", content: "detail" }];
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    const message = result.current.workspaces[0].messages[0];
    const sendPage = (events: unknown[]) => {
      const request = ws.frames().at(-1)!;
      ws.receive({
        type: "subagent_trace_page",
        requestId: request.requestId,
        events,
        totalEvents: events.length,
        revision: 1,
      });
    };
    act(() => {
      result.current.requestSubagentTrace(target, {}, receive)();
      sendPage(events);
    });
    act(() => {
      result.current.requestSubagentTrace(target, {}, receive);
      sendPage([{ ...events[0], content: "🧪".repeat(10_000) }]);
    });
    act(() => {
      result.current.requestSubagentTrace(target, {}, receive);
      sendPage(Array(25).fill(events[0]));
    });
    expect(receive).not.toHaveBeenCalled();
    act(() => {
      result.current.requestSubagentTrace(target, {}, receive);
      sendPage(events);
    });
    expect(receive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ events }));
    expect(result.current.workspaces[0].messages[0]).toBe(message);
  });

  it("ignores a stream_event without an event", () => {
    const { result, ws } = connected();
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    act(() => ws.receive({ type: "stream_event", workspaceId: "w" }));
    frame();
    expect(result.current.workspaces[0].messages[0].content).toBe("Hello");
  });

  it("keeps applying events while the tab is hidden and gets no frames", () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    const { result, ws } = connected();
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    // Scheduled for a frame, then the tab hides before one comes.
    act(() => ws.receive(streamEvent({ kind: "text_delta", content: " a" })));
    act(() => setVisibility("hidden"));
    act(() => ws.receive(streamEvent({ kind: "text_delta", content: " b" })));
    act(() => {
      vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    });
    expect(result.current.workspaces[0].messages[0].content).toBe("Hello a b");
  });
});

describe("sending", () => {
  const sentMessages = () =>
    FakeSocket.instances.flatMap((s) => s.frames()).filter((f) => f.type === "send_message");

  it.each(["accepted", "rejected", "disconnect", "timeout"])(
    "distinguishes a sent frame's %s outcome",
    async (event) => {
      const { result, ws } = connected();
      let sent!: ReturnType<typeof result.current.sendMessage>;
      await act(async () => {
        ws.receive({ ...init, sendReceipt: true });
        sent = result.current.sendMessage("w", "send once");
        const { requestId } = sentMessages()[0];
        if (event === "accepted") ws.receive({ type: "send_receipt", requestId });
        if (event === "rejected")
          ws.receive({ type: "error", requestId, message: "Invalid input" });
        if (event === "disconnect") ws.drop();
        if (event === "timeout") {
          for (let i = 0; i < Math.ceil(120_000 / HEARTBEAT_MS); i++) {
            vi.advanceTimersByTime(HEARTBEAT_MS);
            ws.receive({ type: "pong" });
          }
        }
        await sent;
      });
      expect(await sent).toBe(event === "disconnect" || event === "timeout" ? "unknown" : event);
      if (event === "disconnect" || event === "timeout") {
        expect(result.current.lastError).toMatch(/unconfirmed.*check/i);
        expect(result.current.lastError).not.toMatch(/failed|retry/i);
      }
      expect(sentMessages()).toHaveLength(1);
    },
  );

  it("renders the same queue target, steering badge and actions live as in a fresh snapshot", () => {
    const live = connected();
    const fresh = connected();
    const queued = {
      id: "queued",
      kind: "user",
      agentId: null,
      content: "Queued",
      timestamp: 2,
      status: "queued",
    };
    const page = (message: Record<string, unknown>) => ({
      type: "workspace_messages",
      workspaceId: "w",
      messages: [message],
    });
    const update = (message: Record<string, unknown>) => ({
      type: "message_done",
      workspaceId: "w",
      messageId: queued.id,
      content: queued.content,
      ...message,
    });
    const visible = (client: ReturnType<typeof connected>) => {
      const message = client.result.current.workspaces[0].messages[0];
      return {
        queuedFor: message.queuedFor,
        steering: Boolean(message.steering),
        canCancel: message.status === "queued" && !message.steering,
      };
    };
    act(() => live.ws.receive(page({ ...queued, queuedFor: "original", steering: true })));
    act(() => {
      live.ws.receive(update({ status: "queued", queuedFor: "successor", steering: false }));
      fresh.ws.receive(page({ ...queued, queuedFor: "successor" }));
    });
    expect(visible(live)).toEqual(visible(fresh));
    expect(visible(live)).toEqual({ queuedFor: "successor", steering: false, canCancel: true });
    act(() => {
      live.ws.receive(update({ status: "done", queuedFor: null, steering: false }));
      fresh.ws.receive(page({ ...queued, status: "done" }));
    });
    expect(visible(live)).toEqual(visible(fresh));
    expect(visible(live)).toEqual({ queuedFor: undefined, steering: false, canCancel: false });
  });

  it("reports a message it could not send instead of dropping it silently", async () => {
    const { result, ws } = connected();
    act(() => ws.drop());
    let sent: string | undefined;
    await act(async () => {
      sent = await result.current.sendMessage("w", "a long prompt");
    });
    expect(sent).toBe("not_sent");
    expect(sentMessages()).toEqual([]);
    expect(result.current.lastError).toMatch(/not connected/i);
  });

  it("holds a send until a pending probe is answered", async () => {
    const { result, ws } = connected();
    act(() => setVisibility("visible"));
    expect(ws.frames().at(-1)).toEqual({ type: "ping" });
    let sent: Promise<string> | undefined;
    act(() => {
      sent = result.current.sendMessage("w", "hi");
    });
    expect(sentMessages()).toEqual([]);
    await act(async () => {
      ws.receive({ type: "pong" });
      await sent;
    });
    expect(await sent).toBe("unknown"); // This server does not advertise receipts.
    expect(sentMessages()).toMatchObject([{ content: "hi" }]);
  });

  it("does not write into a socket the probe finds dead (phone just woke up)", async () => {
    const { result, ws } = connected();
    act(() => setVisibility("visible"));
    let sent: Promise<string> | undefined;
    act(() => {
      sent = result.current.sendMessage("w", "hi");
    });
    await act(async () => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
      await sent;
    });
    expect(await sent).toBe("not_sent");
    expect(ws.readyState).toBe(FakeSocket.CLOSED);
    expect(sentMessages()).toEqual([]);
  });
});

describe("connection attempts", () => {
  it("replaces an attempt that hangs in CONNECTING (network switch)", () => {
    const { ws } = connected();
    act(() => ws.drop());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const attempt = FakeSocket.instances.at(-1)!;
    expect(attempt).not.toBe(ws);
    expect(attempt.readyState).toBe(FakeSocket.CONNECTING);
    act(() => setVisibility("visible"));
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(attempt.readyState).toBe(FakeSocket.CLOSED);
    expect(FakeSocket.instances.at(-1)).not.toBe(attempt);
  });

  it("keeps an attempt that opens within the deadline", () => {
    const { ws } = connected();
    act(() => ws.drop());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const attempt = FakeSocket.instances.at(-1)!;
    act(() => setVisibility("visible"));
    act(() => {
      attempt.open();
      attempt.receive(init);
    });
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(FakeSocket.instances.at(-1)).toBe(attempt);
    expect(attempt.readyState).toBe(FakeSocket.OPEN);
  });

  it("gives the attempt that replaces a dead socket the same deadline", () => {
    const { ws } = connected();
    act(() => setVisibility("visible"));
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    // Replaced; on the phone's new network the replacement hangs too.
    const replacement = FakeSocket.instances.at(-1)!;
    expect(replacement).not.toBe(ws);
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(replacement.readyState).toBe(FakeSocket.CLOSED);
    expect(FakeSocket.instances.at(-1)).not.toBe(replacement);
  });

  it("does not reconnect after unmounting", () => {
    const { ws, unmount } = connected();
    unmount();
    // The browser reports the close asynchronously.
    act(() => ws.onclose?.());
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("history pages", () => {
  const settled = (timestamp: number, patch: Partial<Message> = {}): Message => ({
    id: `m${timestamp}`,
    kind: "agent",
    agentId: "a",
    content: "",
    timestamp,
    status: "done",
    ...patch,
  });
  const page = (a: number, b: number, extra: Record<string, unknown> = {}) => ({
    ...workspacePage(
      Array.from({ length: b - a + 1 }, (_, k) => settled(a + k)),
      null,
      true,
    ),
    ...extra,
  });
  const ids = (r: { current: ReturnType<typeof useServer> }) =>
    r.current.workspaces[0].messages.map((m) => m.id);

  it("leaves no hole when a message came live before the resync reply", () => {
    const { result, ws } = connected();
    act(() => ws.receive(page(1, 50)));
    act(() => {
      // Written while away (m51..m110) and just now (m111).
      ws.receive({ type: "new_message", workspaceId: "w", message: page(111, 111).messages[0] });
      ws.receive(page(62, 111));
    });
    expect(ids(result)).toEqual(page(62, 111).messages.map((m) => m.id));
    expect(result.current.workspaces[0].hasMore).toBe(true);
  });

  it("does not take an older page as the history of an archived workspace", () => {
    const { result, ws } = connected();
    act(() => ws.receive(page(51, 100)));
    act(() => {
      result.current.loadMessages("w", 51);
    });
    act(() => ws.receive({ type: "workspace_archived", workspaceId: "w", archivedAt: 5 }));
    act(() => ws.receive(page(1, 50, { before: 51, hasMore: false })));
    const w = result.current.workspaces[0];
    expect(w.messagesLoaded).toBe(false);
    expect(w.messages).toEqual([]);
  });

  const other = { ...W, id: "other", name: "other" };
  const large = "界".repeat(Math.ceil(1_048_576 / 3));
  const queued = settled(2, { kind: "user", status: "queued", steering: true, queuedFor: "a" });

  it("flushes a detached event on switch, keeping its owner until the queue and child settle", () => {
    const { result, ws } = connected(undefined, [W, other]);
    const current = () => result.current.workspaces[0];
    const select = result.current.setActiveTranscript;
    const prefix = settled(0, { content: large });
    const owner = settled(1, { content: large });
    const child = (kind: string, status: "running" | "completed") => ({
      kind,
      content: "",
      subagent: { taskId: "child", description: "detached task", status },
    });
    const started = child("subagent_start", "running");
    act(() => {
      select("w");
      ws.receive(workspacePage([prefix, owner, queued], null, true));
    });
    act(() => {
      result.current.loadMessages("w", 0);
    });
    // Switch before the scheduled stream frame is applied.
    act(() => {
      ws.receive(streamEvent(started, owner.id));
      select(other.id);
    });
    expect(current()).toMatchObject({
      messagesLoaded: true,
      hasMore: true,
      loadingOlder: false,
      messages: [{ id: owner.id, events: [started] }, queued],
    });
    act(() => ws.receive(workspacePage([settled(-1), prefix], 0)));
    expect(ids(result)).toEqual([owner.id, queued.id]);
    act(() => {
      select("w");
      result.current.loadMessages("w", 1);
    });
    act(() => ws.receive(workspacePage([settled(-1), prefix, owner], 1)));
    expect(ids(result)).toEqual(["m-1", prefix.id, owner.id, queued.id]);
    expect(current().messages[2].events).toEqual([started]);
    act(() => {
      select(other.id);
      ws.receive({
        type: "message_done",
        workspaceId: "w",
        messageId: queued.id,
        status: "done",
        content: queued.content,
        queuedFor: null,
        steering: false,
        queued: false,
      });
      ws.receive(streamEvent(child("subagent_done", "completed"), owner.id));
    });
    frame();
    expect(current()).toMatchObject({ messages: [], messagesLoaded: false, queued: false });
  });

  it("keeps an overlapping live tail after eviction and reconciles queue state on reconnect", () => {
    const { result, ws } = connected(undefined, [W, other]);
    const current = () => result.current.workspaces[0];
    const select = result.current.setActiveTranscript;
    const tied = settled(2, { id: "earlier-tie" });
    const streaming = settled(3, { status: "streaming", content: "live" });
    act(() => {
      select("w");
      ws.receive(workspacePage([settled(0, { content: large })]));
    });
    act(() => select(other.id));
    expect(current().messagesLoaded).toBe(false);
    act(() => {
      for (const message of [tied, queued, streaming]) {
        ws.receive({ type: "new_message", workspaceId: "w", message, queued: true });
      }
    });
    act(() => {
      select("w");
      result.current.loadMessages("w", undefined, 1);
      ws.receive(workspacePage([streaming], null, true));
    });
    expect(current()).toMatchObject({
      messagesLoaded: true,
      hasMore: true,
      messages: [tied, queued, streaming],
    });
    act(() => {
      ws.drop();
      vi.advanceTimersByTime(2_000);
    });
    const next = FakeSocket.instances.at(-1)!;
    const done = { ...streaming, status: "done" as const, content: "finished while disconnected" };
    act(() => {
      openSnapshot(next, [{ ...W, queued: false, unread: 3 }, other]);
      result.current.loadMessages("w");
      next.receive(workspacePage([tied, done]));
    });
    expect(current()).toMatchObject({
      messages: [tied, done],
      messagesLoaded: true,
      queued: false,
      unread: 3,
    });
  });
});
