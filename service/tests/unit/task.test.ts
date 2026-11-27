import { describe, it, expect, vi } from "vitest";
import { Workspace, WorkspaceCallbacks } from "../../src/workspace/workspace";
import { HostRegistry } from "../../src/session/host";
import { StreamEvent } from "../../src/session/types";
import { FakeHost, FakeSession } from "./fakes";

function fakeRegistry(host = new FakeHost()) {
  const registry = new HostRegistry();
  registry.register(host);
  return registry;
}

const restoreWorkspace = (state: ReturnType<Workspace["getState"]>, host?: FakeHost) =>
  Workspace.fromState(state, fakeRegistry(host));

function makeWorkspace(
  model = "gpt-5.6-terra",
  extraCb: Partial<WorkspaceCallbacks> = {},
  agentOptions: Parameters<Workspace["addAgent"]>[4] = {
    backend: model.startsWith("gpt-") ? "codex" : "claude",
  },
) {
  const host = new FakeHost();
  const registry = fakeRegistry(host);
  const done: Array<{ msgId: string; status: string }> = [];
  // What clients are told, in order.
  const log: string[] = [];
  const cb: WorkspaceCallbacks = {
    onNewMessage: (_wsId, msg) => log.push(`new ${msg.id} ${msg.status}`),
    onStreamEvent: (_wsId, msg, event) => log.push(`event ${msg.id} ${event.kind}`),
    onMessageDone: (_wsId, msgId, status) => {
      done.push({ msgId, status });
      log.push(`done ${msgId} ${status}`);
    },
    onAgentBusy: () => log.push("busy"),
    onAgentIdle: () => log.push("idle"),
    ...extraCb,
  };
  const ws = new Workspace("ws-1", "test", "proj", "local", "/tmp", registry, cb);
  const agentInfo = ws.addAgent("A", model, "🤖", "#888", agentOptions);
  const session = host.lastSession!;
  const emit = (e: Partial<StreamEvent>) => session.emit("event", e);
  const agentMsgs = () => ws.messages.filter((m) => m.kind === "agent");
  const finishTurn = () => {
    session.isRunning = false;
    emit({ kind: "result", content: "" });
  };
  return { ws, emit, done, log, agentMsgs, agentInfo, session, host, finishTurn, registry };
}

const subagentStart = (taskId: string): StreamEvent => ({
  kind: "subagent_start",
  content: "desc",
  toolUseId: `tool-${taskId}`,
  subagent: { taskId, description: "desc", status: "running", events: [] },
});

const subagentProgress = (taskId: string, innerEvent: StreamEvent): StreamEvent => ({
  kind: "subagent_progress",
  content: "",
  subagent: { taskId, description: "", _innerEvent: innerEvent },
});

describe("unread results", () => {
  it("counts only a conclusion or a failure, without counting output mid-turn or a tool-only result", () => {
    const updates = vi.fn();
    const { ws, emit, host } = makeWorkspace(undefined, { onAttention: updates });
    ws.postSystemMessage("note");
    emit({ kind: "text_delta", content: "I will read the file" });
    emit({ kind: "tool_use", content: "Read /a", toolUseId: "t1" });
    emit({ kind: "tool_result", content: "file output", toolUseId: "t1" });
    expect(ws.getInfo(false).unread).toBe(0);
    emit({ kind: "result", content: "" });
    expect(updates).not.toHaveBeenCalled();

    emit({ kind: "text_delta", content: "Interrupted partial answer" });
    emit({ kind: "result", content: "", interrupted: true });
    expect(updates).not.toHaveBeenCalled();
    emit({ kind: "text_delta", content: "Final answer" });
    expect(updates).not.toHaveBeenCalled();
    emit({ kind: "result", content: "" });
    expect(updates).toHaveBeenLastCalledWith(ws.id, 1, "done");
    emit({ kind: "error", content: "failed" });
    expect(updates).toHaveBeenLastCalledWith(ws.id, 2, "failed");
    const back = restoreWorkspace(ws.getState(), host);
    expect(back.getInfo(false)).toMatchObject({ unread: 2, lastResult: "failed" });
  });

  it("clears a stale failure when an externally started turn begins, preserving unread across restore", () => {
    const updates = vi.fn();
    const { ws, emit, host } = makeWorkspace(undefined, { onAttention: updates });
    emit({ kind: "error", content: "failed" });
    expect(updates).toHaveBeenLastCalledWith(ws.id, 1, "failed");
    updates.mockClear();

    emit({ kind: "text_delta", content: "running again" });

    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenCalledWith(ws.id, 1, undefined);
    expect(ws.getInfo(false)).toMatchObject({ unread: 1, lastResult: undefined });
    const back = restoreWorkspace(ws.getState(), host);
    expect(back.getInfo(false)).toMatchObject({ unread: 1, lastResult: undefined });
  });

  it("keeps a stale failure through a standalone Pi compaction", async () => {
    const updates = vi.fn();
    const { ws, emit, session } = makeWorkspace("provider/model", { onAttention: updates });
    session.getState().config.backend = "pi";
    emit({ kind: "error", content: "failed" });
    updates.mockClear();
    session.send = (input) => {
      session.sent.push(typeof input === "string" ? input : input.text);
      session.isRunning = false;
      return Promise.resolve();
    };

    await ws.sendMessage("/compact");

    expect(updates).not.toHaveBeenCalled();
    expect(ws.getInfo(false)).toMatchObject({ unread: 1, lastResult: "failed" });
    expect(ws.getState().attention?.lastResult).toBe("failed");
  });

  it("clears a stale failure on dispatch before a fast Codex result arrives", async () => {
    const updates = vi.fn();
    const { ws, emit, session } = makeWorkspace(undefined, { onAttention: updates });
    emit({ kind: "error", content: "failed" });
    updates.mockClear();
    session.send = (input) => {
      session.sent.push(typeof input === "string" ? input : input.text);
      session.isRunning = true;
      expect(updates).toHaveBeenCalledTimes(1);
      expect(updates).toHaveBeenCalledWith(ws.id, 1, undefined);
      expect(ws.getInfo(false)).toMatchObject({ unread: 1, lastResult: undefined });
      session.emit("event", { kind: "result", content: "" });
      return Promise.resolve();
    };

    await ws.sendMessage("resume");

    expect(updates).toHaveBeenCalledTimes(1);
    expect(ws.getInfo(false)).toMatchObject({ unread: 1, lastResult: undefined });
  });
});

describe("Workspace event aggregation", () => {
  it("accumulates text deltas into message content", () => {
    const { emit, agentMsgs } = makeWorkspace();
    emit({ kind: "text_delta", content: "Hello " });
    emit({ kind: "text_delta", content: "world" });

    expect(agentMsgs()).toHaveLength(1);
    expect(agentMsgs()[0].content).toBe("Hello world");
  });

  it("puts a block's thinking tokens on the block instead of listing them", () => {
    const { emit, agentMsgs } = makeWorkspace();
    emit({ kind: "thinking", content: "Hm", durationMs: 1200 });
    emit({ kind: "tool_use", content: "Read /a", toolUseId: "t1" });
    emit({ kind: "thinking_tokens", content: "", tokens: 42 });
    expect(agentMsgs()[0].events!.map((e) => [e.kind, e.tokens])).toEqual([
      ["thinking", 42],
      ["tool_use", undefined],
    ]);
  });

  it("pairs a tool_result onto its tool_use event", () => {
    const { emit, agentMsgs } = makeWorkspace();
    emit({ kind: "tool_use", content: "Read /a", toolUseId: "t1" });
    emit({ kind: "tool_result", content: "file contents", toolUseId: "t1" });

    const events = agentMsgs()[0].events!;
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tool_use");
    expect(events[0].toolResult).toBe("file contents");
  });

  it("marks a tool_use whose result was a failure", () => {
    const { emit, agentMsgs } = makeWorkspace();
    emit({ kind: "tool_use", content: "**start_session** x", toolUseId: "t1" });
    emit({ kind: "tool_result", content: "Not a directory", toolUseId: "t1", isError: true });
    emit({ kind: "tool_use", content: "Read /a", toolUseId: "t2" });
    emit({ kind: "tool_result", content: "body", toolUseId: "t2" });
    expect(agentMsgs()[0].events!.map((e) => e.toolResultIsError)).toEqual([true, undefined]);
  });

  it("merges the subagent lifecycle onto the start event", () => {
    const { emit, agentMsgs } = makeWorkspace();
    emit(subagentStart("task-1"));
    emit(
      subagentProgress("task-1", { kind: "tool_use", content: "Grep foo", toolUseId: "inner-1" }),
    );
    emit(
      subagentProgress("task-1", { kind: "tool_result", content: "matches", toolUseId: "inner-1" }),
    );
    emit({
      kind: "subagent_done",
      content: "",
      subagent: { taskId: "task-1", description: "", status: "completed", summary: "found it" },
    });

    const events = agentMsgs()[0].events!;
    const start = events.find((e) => e.kind === "subagent_start")!;
    expect(start.subagent?.status).toBe("completed");
    expect(start.subagent?.summary).toBe("found it");
    // Inner tool_use/tool_result were paired inside the start event.
    expect(start.subagent?.events).toHaveLength(1);
    expect(start.subagent?.events?.[0].toolResult).toBe("matches");
    // No dangling standalone progress entry remains.
    expect(events.some((e) => e.kind === "subagent_progress")).toBe(false);
  });

  it("keeps a card's time when a later end carries none, as the client does", () => {
    const { emit, agentMsgs } = makeWorkspace();
    const start = subagentStart("task-1");
    const end = (durationMs?: number): Partial<StreamEvent> => ({
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "task-1",
        description: "",
        status: "completed",
        ...(durationMs != null && { durationMs }),
      },
    });
    emit(start);
    emit(end(6000));
    emit(end());
    const card = agentMsgs()[0].events!.find((e) => e.kind === "subagent_start")!;
    expect(card.subagent?.durationMs).toBe(6000);
    // The client side: tests/snap/merge.test.ts.
  });

  it("routes late subagent events to the finalized owner message", () => {
    const { emit, done, agentMsgs } = makeWorkspace();
    emit(subagentStart("task-1"));
    emit({ kind: "result", content: "" });
    expect(done).toHaveLength(1);

    // Subagent finishes after the turn was finalized.
    emit({
      kind: "subagent_done",
      content: "",
      subagent: { taskId: "task-1", description: "", status: "completed", summary: "late" },
    });

    // No new agent message bubble was created for the late event.
    expect(agentMsgs()).toHaveLength(1);
    const start = agentMsgs()[0].events!.find((e) => e.kind === "subagent_start")!;
    expect(start.subagent?.status).toBe("completed");
    expect(start.subagent?.summary).toBe("late");
  });

  it("records the account an agent was created with", () => {
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const ws = new Workspace("ws-acct", "t", "p", "local", "/tmp", registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
    });
    const info = ws.addAgent("B", "gpt-5.6-terra", "🤖", "#888", {}, "work");
    expect(info.account).toBe("work");
    // Persisted state keeps the account label.
    expect(ws.getState().agents[0].account).toBe("work");
  });

  it("cancelSubagent delegates to the owning session's stopTask", async () => {
    const { ws, agentInfo, session } = makeWorkspace();
    await ws.cancelSubagent(agentInfo.id, "task-42");
    expect(session.stoppedTasks).toEqual(["task-42"]);
    expect(() => ws.cancelSubagent("nonexistent", "task-42")).toThrow(/Agent not found/);
  });

  it("finalizes the message on result and starts a fresh one on the next event", () => {
    const { emit, done, agentMsgs } = makeWorkspace();
    emit({ kind: "text_delta", content: "first turn" });
    emit({ kind: "result", content: "" });
    emit({ kind: "text_delta", content: "second turn" });

    expect(done).toHaveLength(1);
    expect(done[0].status).toBe("done");
    expect(agentMsgs()).toHaveLength(2);
    expect(agentMsgs()[1].content).toBe("second turn");
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("message queue", () => {
  it("dispatches immediately when the agent is idle", async () => {
    const { ws, session, agentMsgs } = makeWorkspace();
    await ws.sendMessage("first task");
    expect(session.sent).toEqual(["first task"]);
    expect(ws.messages.find((m) => m.kind === "user")!.status).toBe("done");
    expect(agentMsgs()).toHaveLength(1);
  });

  it("queues messages for a busy agent and drains FIFO on idle", async () => {
    const { ws, session, agentMsgs, finishTurn } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("second");
    await ws.sendMessage("third");
    expect(session.sent).toEqual([]);
    const queued = ws.messages.filter((m) => m.status === "queued");
    expect(queued).toHaveLength(2);
    expect(queued[0].queuedFor).toBeTruthy();
    expect(agentMsgs()).toHaveLength(0);

    // The running turn ends: only the first queued message dispatches,
    // because dispatch marks the session busy again.
    finishTurn();
    await tick();
    expect(session.sent).toEqual(["second"]);
    expect(ws.messages.filter((m) => m.status === "queued")).toHaveLength(1);
    expect(ws.messages.find((m) => m.content === "second")!.status).toBe("done");

    // Second turn ends: the next one drains.
    finishTurn();
    await tick();
    expect(session.sent).toEqual(["second", "third"]);
    expect(ws.messages.filter((m) => m.status === "queued")).toHaveLength(0);
  });

  it("drains the queue after an aborted turn too", async () => {
    const { ws, session } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("after abort");
    session.isRunning = false;
    ws.abortAll();
    await tick();
    expect(session.sent).toEqual(["after abort"]);
  });

  it("drains the queue when the session goes idle without a terminal event", async () => {
    // A stopped codex turn: busy until its process exits, then only idle.
    const { ws, session } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("after stop");
    ws.abortAll();
    await tick();
    expect(session.sent).toEqual([]);
    session.isRunning = false;
    session.emit("runState", "idle");
    await tick();
    expect(session.sent).toEqual(["after stop"]);
  });

  it("cancelQueued removes a pending message so it never runs", async () => {
    const { ws, session, finishTurn } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("doomed");
    const queued = ws.messages.find((m) => m.status === "queued")!;
    expect(ws.cancelQueued(queued.id)).toBe(true);
    expect(ws.cancelQueued(queued.id)).toBe(false);
    expect(ws.messages.find((m) => m.id === queued.id)).toBeUndefined();

    finishTurn();
    await tick();
    expect(session.sent).toEqual([]);
  });

  it("preserves the built prompt for queued messages with quotes", async () => {
    const { ws, session, finishTurn } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("follow-up", undefined, undefined, {
      messageId: "m0",
      agentId: null,
      content: "original text",
    });
    finishTurn();
    await tick();
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]).toContain("original text");
    expect(session.sent[0]).toContain("follow-up");
  });
});

describe("rate-limit retry mechanics", () => {
  it("records the last prompt and retryLast re-dispatches it", async () => {
    const { ws, session } = makeWorkspace();
    await ws.sendMessage("do the thing");
    expect(session.sent).toEqual(["do the thing"]);

    session.isRunning = false;
    const agentId = ws.getState().agents[0].id;
    // Only a rate limit's pause ends in a retry.
    expect(ws.retryLast(agentId)).toBe(false);
    ws.pauseAgent(agentId, Date.now(), true);
    expect(ws.retryLast(agentId)).toBe(true);
    await tick();
    expect(session.sent).toEqual(["do the thing", "do the thing"]);
  });

  it("abort before retryLast ensures fresh dispatch after credential switch", async () => {
    const { ws, emit, session } = makeWorkspace();
    const agentId = ws.getState().agents[0].id;
    await ws.sendMessage("rate limited prompt");
    expect(session.sent).toEqual(["rate limited prompt"]);

    // Simulate the turn ending after a rate limit (error → result).
    emit({ kind: "error", content: "Usage limit reached" });
    session.isRunning = false;

    // The server's handleRateLimit would mark the retry, abort, then retry.
    ws.pauseAgent(agentId, Date.now() + 1000, true);
    session.abort();
    expect(ws.retryLast(agentId)).toBe(true);
    await tick();
    expect(session.sent).toEqual(["rate limited prompt", "rate limited prompt"]);
  });

  it("pauseAgent holds the queue until the deadline, retryLast clears it", async () => {
    const { ws, session, finishTurn } = makeWorkspace();
    const agentId = ws.getState().agents[0].id;
    session.isRunning = true;
    await ws.sendMessage("queued work");

    ws.pauseAgent(agentId, Date.now() + 60_000, true);
    finishTurn();
    await tick();
    // Paused: the queued message must NOT dispatch.
    expect(session.sent).toEqual([]);

    // Recovery path: retryLast clears the pause; with no prompt of ours to
    // send again and a message waiting, that message resumes the agent: it
    // returns false and the caller falls back to dequeueNext.
    expect(ws.retryLast(agentId)).toBe(false);
    ws.dequeueNext(agentId);
    await tick();
    expect(session.sent).toEqual(["queued work"]);
  });
});

describe("silent-turn diagnostics", () => {
  it("renders a diagnostic instead of an empty bubble when a turn produces nothing", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("hello");
    // The turn dies without any event (network drop / CLI crash), then ends.
    emit({ kind: "result", content: "" });

    const msg = agentMsgs()[0];
    expect(msg.status).toBe("done");
    expect(msg.content).toContain("no output");
  });

  it("leaves real replies untouched", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("hello");
    emit({ kind: "text_delta", content: "real answer" });
    emit({ kind: "result", content: "" });
    expect(agentMsgs()[0].content).toBe("real answer");
  });

  it("keeps tool-only turns silent-but-visible (events present, no diagnostic)", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("hello");
    emit({ kind: "tool_use", content: "Bash ls", toolUseId: "t1" });
    emit({ kind: "result", content: "" });
    expect(agentMsgs()[0].content).toBe("");
    expect(agentMsgs()[0].events).toHaveLength(1);
  });
});

describe("banners, retries and activity", () => {
  it("keeps a single retry event per turn, updated in place", () => {
    const { ws, emit } = makeWorkspace();
    emit({ kind: "text_delta", content: "hi" });
    emit({ kind: "retry", level: "warning", content: "API retry 1/10" });
    emit({ kind: "retry", level: "warning", content: "API retry 2/10" });
    emit({ kind: "notice", level: "notice", content: "fyi" });
    const events = ws.messages.filter((m) => m.kind === "agent")[0].events!;
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["retry", "API retry 2/10"],
      ["notice", "fyi"],
    ]);
    expect(events[0].contentOffset).toBe(2);
  });

  const recoveryEvents: StreamEvent[] = [
    { kind: "text_delta", content: "recovered" },
    { kind: "thinking_delta", content: "thinking" },
    { kind: "thinking", content: "thought" },
    { kind: "tool_use", content: "**Read** `/a`", toolUseId: "read" },
    subagentStart("recovered-task"),
    { kind: "result", content: "" },
  ];
  it.each(recoveryEvents)("clears a retry on $kind", (event) => {
    const { emit, agentMsgs, session } = makeWorkspace();
    session.isRunning = true;
    emit({ kind: "retry", content: "Retrying" });
    emit(event);
    expect(agentMsgs()[0].events?.some((e) => e.kind === "retry")).toBe(false);
  });

  it.each([
    { event: { kind: "retry", content: "" }, kinds: [] },
    { event: { kind: "error", content: "final failure" }, kinds: ["error"] },
  ] satisfies { event: StreamEvent; kinds: string[] }[])(
    "clears a retry on $event.kind",
    ({ event, kinds }) => {
      const { emit, agentMsgs, session } = makeWorkspace();
      session.isRunning = true;
      emit({ kind: "retry", content: "Retrying" });
      emit(event);
      expect(agentMsgs()[0].events?.map((e) => e.kind)).toEqual(kinds);
    },
  );

  it("forwards session activity to the callback and exposes it on getInfo", () => {
    const seen: Array<[string, string | null]> = [];
    const {
      ws,
      session,
      agentInfo: agent,
    } = makeWorkspace(
      "gpt-5.6-terra",
      {
        onAgentActivity: (_ws, agentId, activity) => seen.push([agentId, activity]),
      },
      {},
    );
    session.emit("activity", "compacting context");
    expect(seen).toEqual([[agent.id, "compacting context"]]);
    expect(ws.getInfo(false).agents[0].activity).toBe("compacting context");
    session.emit("activity", null);
    expect(ws.getInfo(false).agents[0].activity).toBeNull();
  });

  it("forwards unhandled SDK messages for logging", () => {
    const seen: unknown[] = [];
    const { session } = makeWorkspace(
      "gpt-5.6-terra",
      {
        onUnhandled: (_ws, _agent, msg) => seen.push(msg),
      },
      {},
    );
    session.emit("unhandled", { type: "mystery" });
    expect(seen).toEqual([{ type: "mystery" }]);
  });

  it("restores the pinned account of a persisted agent", () => {
    const { ws } = makeWorkspace();
    const state = ws.getState();
    state.agents[0].account = "work";
    const restored = restoreWorkspace(state);
    expect(restored.getInfo(false).agents[0].account).toBe("work");
  });
});

describe("archiving", () => {
  it("tracks lastActivityAt from pushed messages and survives unloading", async () => {
    const { ws, emit } = makeWorkspace();
    const before = ws.lastActivityAt;
    await ws.sendMessage("hello");
    emit({ kind: "text_delta", content: "hi" });
    emit({ kind: "result", content: "" });
    expect(ws.lastActivityAt).toBeGreaterThanOrEqual(before);
    const stamp = ws.lastActivityAt;

    ws.unloadMessages();
    expect(ws.messages).toEqual([]);
    expect(ws.messagesLoaded).toBe(false);
    expect(ws.lastActivityAt).toBe(stamp);
    expect(ws.getInfo(false).lastMessageAt).toBe(stamp);
    // Persisting an unloaded workspace must not claim an empty history.
    expect(ws.getState().messages).toBeUndefined();
  });

  it("is idle only when no agent runs and nothing is queued", async () => {
    const { ws, session, finishTurn } = makeWorkspace();
    expect(ws.isIdle).toBe(true);
    await ws.sendMessage("go");
    expect(ws.isIdle).toBe(false);
    await ws.sendMessage("and this");
    finishTurn();
    // The queued message is still pending until the next tick dispatches it.
    expect(ws.isIdle).toBe(false);
    await tick();
    expect(session.isRunning).toBe(true);
    finishTurn();
    await tick();
    expect(ws.isIdle).toBe(true);
  });

  it("round-trips archivedAt and lastActivityAt through state", () => {
    const { ws } = makeWorkspace();
    ws.createdAt = 100;
    ws.archivedAt = 123;
    ws.lastActivityAt = 456;
    const state = ws.getState();
    expect(state).toMatchObject({ archivedAt: 123, lastActivityAt: 456 });
    const restored = restoreWorkspace({ ...state, messages: undefined });
    expect(restored.isArchived).toBe(true);
    expect(restored.lastActivityAt).toBe(456);
    expect(restored.getInfo(false).archivedAt).toBe(123);
  });

  it("derives lastActivityAt from messages for states written before the field existed", () => {
    const { ws, emit } = makeWorkspace();
    emit({ kind: "text_delta", content: "x" });
    const state = ws.getState();
    delete state.lastActivityAt;
    const restored = restoreWorkspace(state);
    expect(restored.lastActivityAt).toBe(state.messages![state.messages!.length - 1].timestamp);
  });
});

describe("error events", () => {
  it("get a contentOffset, mark the reply errored, and keep error text out of content", () => {
    const { ws, emit } = makeWorkspace();
    emit({ kind: "text_delta", content: "partial" });
    emit({ kind: "error", content: "boom" });
    const m = ws.messages.filter((x) => x.kind === "agent")[0];
    expect(m.status).toBe("error");
    expect(m.content).toBe("partial");
    expect(m.events![0]).toMatchObject({
      kind: "error",
      content: "boom",
      contentOffset: m.content.length,
    });
  });
});

describe("effort on the wire", () => {
  it("exposes the session's effort level and announces /effort changes", async () => {
    const updates: Array<{ id: string; effort: string | null }> = [];
    const {
      ws,
      session,
      agentInfo: agent,
    } = makeWorkspace(
      "gpt-5.6-sol",
      {
        onAgentUpdated: (_ws, a) => updates.push({ id: a.id, effort: a.effort }),
      },
      { effort: "high" },
    );
    expect(ws.getInfo(false).agents[0]).toMatchObject({
      effort: "high",
      // What /effort takes, for the panel to offer.
      effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });

    Object.assign(session, {
      setEffort(level: string) {
        session.getState().config.effort = level;
      },
    });
    await ws.sendMessage("/effort max");
    expect(updates).toEqual([{ id: agent.id, effort: "max" }]);
    expect(ws.getInfo(false).agents[0].effort).toBe("max");
  });
});

describe("per-message effort and context", () => {
  it("stamps the effort on new agent messages and the context on completion", async () => {
    const patches: unknown[] = [];
    const { ws, session, registry } = makeWorkspace(
      "gpt-5.6-sol",
      {
        onMessageDone: (_ws, _id, _status, _content, _events, patch) => patches.push(patch),
      },
      { effort: "xhigh" },
    );
    await ws.sendMessage("hi");
    session.emit("event", { kind: "text_delta", content: "yo" });
    session.emit("event", {
      kind: "result",
      content: "",
      context: { tokens: 42000, window: 200000 },
    });
    const m = ws.messages.filter((x) => x.kind === "agent")[0];
    expect(m.effort).toBe("xhigh");
    expect(m.context).toEqual({ tokens: 42000, window: 200000 });
    // The agent carries it too, for panels that do not load the history.
    const [agentId] = ws.agents.keys();
    expect(ws.agentInfo(ws.agents.get(agentId)!).context).toEqual({
      tokens: 42000,
      window: 200000,
    });
    const restored = Workspace.fromState(ws.getState(), registry);
    expect(restored.getInfo(false).agents[0].context).toEqual({ tokens: 42000, window: 200000 });
    expect(patches).toContainEqual({ context: { tokens: 42000, window: 200000 } });
  });

  it("distinguishes absent fresh and unloaded context from explicit unknown occupancy", async () => {
    const { ws, emit, session } = makeWorkspace();
    const fresh = ws.getInfo(false).agents[0];
    expect(fresh.context).toBeUndefined();
    expect(fresh).not.toHaveProperty("context");

    await ws.sendMessage("hi");
    emit({ kind: "result", content: "", context: null });
    session.isRunning = false;
    expect(ws.getInfo(false).agents[0].context).toBeNull();

    // Browsing an archived history loads it but must not expose occupancy.
    ws.archivedAt = 1;
    const archived = ws.getInfo(false).agents[0];
    expect(archived.context).toBeUndefined();
    expect(archived).not.toHaveProperty("context");
    ws.archivedAt = null;
    expect(ws.getInfo(false).agents[0].context).toBeNull();

    ws.unloadMessages();
    const unloaded = ws.getInfo(false).agents[0];
    expect(unloaded.context).toBeUndefined();
    expect(unloaded).not.toHaveProperty("context");
  });
});

describe("agent run state on the wire", () => {
  it("exposes the session state, falls back to busy, and blocks archiving while waiting", () => {
    const seen: string[] = [];
    const { ws, session } = makeWorkspace(
      "gpt-5.6-sol",
      {
        onAgentState: (_ws, _id, state) => seen.push(state),
      },
      {},
    );
    expect(ws.getInfo(false).agents[0].state).toBe("idle");
    session.isRunning = true;
    expect(ws.getInfo(false).agents[0].state).toBe("working");
    session.isRunning = false;

    session.emit("runState", "waiting");
    expect(seen).toEqual(["waiting"]);
    expect(ws.getInfo(false).agents[0].state).toBe("waiting");
    expect(ws.isIdle).toBe(false);
    session.emit("runState", "idle");
    expect(ws.isIdle).toBe(true);
  });
});

describe("fast mode and goal commands", () => {
  const lastReply = (ws: Workspace) => ws.messages.filter((m) => m.kind === "agent").at(-1)!;

  it("/fast toggles the session and marks the following turns", async () => {
    const { ws, session, emit, agentMsgs } = makeWorkspace("gpt-6-astra[1m]");
    await ws.sendMessage("/fast");
    expect(lastReply(ws).content).toContain("turned **on**");
    expect(session.getState().config.fast).toBe(true);
    expect(ws.agentInfo(ws.resolveAgent("A")!).fast).toBe(true);

    await ws.sendMessage("hello");
    emit({ kind: "text_delta", content: "hi" });
    expect(agentMsgs().at(-1)!.fast).toBe(true);

    await ws.sendMessage("/fast off");
    expect(lastReply(ws).content).toContain("turned **off**");
    expect(session.getState().config.fast).toBeUndefined();
    await ws.sendMessage("/fast off");
    expect(lastReply(ws).content).toContain("already **off**");
  });

  it("/fast is refused for models without fast mode", async () => {
    const { ws, session } = makeWorkspace("deepseek-v4-pro");
    await ws.sendMessage("/fast on");
    expect(lastReply(ws).content).toContain("does not support fast mode");
    expect(session.sent).toEqual([]);
  });

  it("/goal is disabled without sending or changing session state", async () => {
    const { ws, session } = makeWorkspace("gpt-6-astra");
    await ws.sendMessage("/goal make the tests green");
    expect(lastReply(ws).content).toContain("/goal is disabled");
    expect(session.sent).toEqual([]);
    expect(session.getState().config.goal).toBeUndefined();
  });
});

describe("events between turns and late results", () => {
  const seedStreamingReply = (ws: Workspace, agentId: string, content: string) =>
    ws.setMessages([
      {
        id: "stale",
        kind: "agent",
        agentId,
        content,
        timestamp: 1,
        status: "streaming",
        events: [],
      },
    ]);

  it("turns a banner that arrives while idle into a system line, not a streaming bubble", () => {
    const { ws, emit, session } = makeWorkspace();
    session.isRunning = false;
    emit({ kind: "notice", level: "notice", content: "Session compacted" });
    const last = ws.messages[ws.messages.length - 1];
    expect(last.kind).toBe("system");
    expect(last.status).toBe("done");
    expect(last.content).toContain("Session compacted");
    expect(ws.messages.some((m) => m.status === "streaming")).toBe(false);
  });

  it("drops a card update whose card is in no loaded message while nothing runs", () => {
    const { ws, emit, session } = makeWorkspace();
    session.isRunning = false;
    emit({
      kind: "subagent_done",
      content: "",
      subagent: { taskId: "gone", description: "", status: "stopped" },
    });
    expect(ws.messages.some((m) => m.kind === "agent")).toBe(false);
  });

  it("gives a card that starts while nothing runs a finished reply its updates still reach", () => {
    const { ws, emit, session, agentMsgs, log } = makeWorkspace();
    session.isRunning = false;
    log.length = 0;
    emit(subagentStart("bg-1"));
    expect(agentMsgs()).toHaveLength(1);
    const reply = agentMsgs()[0];
    expect(reply.status).toBe("done");
    expect(log).toEqual([
      `new ${reply.id} streaming`,
      `event ${reply.id} subagent_start`,
      `done ${reply.id} done`,
    ]);
    expect(ws.isIdle).toBe(true);
    emit({
      kind: "subagent_done",
      content: "",
      subagent: { taskId: "bg-1", description: "", status: "completed", summary: "ok" },
    });
    expect(agentMsgs()).toHaveLength(1);
    expect(reply.events![0].subagent).toMatchObject({ status: "completed", summary: "ok" });
  });

  it("does not count a card that starts while nothing runs as a reply to the last message", () => {
    const { ws, emit, session, agentMsgs } = makeWorkspace();
    ws.deliver("do it", { workspaceId: "ws-lead", name: "lead", role: "lead" }, "do it");
    emit({ kind: "text_delta", content: "ok" });
    emit({ kind: "result", content: "" });
    session.isRunning = false;
    emit(subagentStart("bg-1"));
    expect(agentMsgs()).toHaveLength(2);
    expect(ws.lastDelivered()[0].replies.map((m) => m.content)).toEqual(["ok"]);
  });

  it("drops a tool result whose call is in no loaded message while nothing runs", () => {
    const { ws, emit, session } = makeWorkspace();
    session.isRunning = false;
    emit({ kind: "tool_result", content: "late", toolUseId: "unknown" });
    expect(ws.messages.some((m) => m.kind === "agent")).toBe(false);
  });

  it("finishes a reply still streaming before a new prompt takes its place", async () => {
    const { ws, emit, session, agentMsgs, done, log } = makeWorkspace();
    session.isRunning = false;
    emit({ kind: "text_delta", content: "stray" });
    const stray = agentMsgs()[0];
    expect(stray.status).toBe("streaming");
    await ws.sendMessage("next");
    expect(stray.status).toBe("done");
    expect(done).toContainEqual({ msgId: stray.id, status: "done" });
    const next = agentMsgs()[1];
    expect(log.indexOf(`done ${stray.id} done`)).toBeLessThan(
      log.indexOf(`new ${next.id} streaming`),
    );
    expect(agentMsgs().filter((m) => m.status === "streaming")).toHaveLength(1);
  });

  it("a stop finishes every reply of the agent still streaming, so it can be archived", async () => {
    const { ws, session, agentInfo, done } = makeWorkspace();
    seedStreamingReply(ws, agentInfo.id, "card only");
    await ws.sendMessage("go");
    ws.abortAgent(agentInfo.id);
    session.isRunning = false;
    expect(ws.messages.find((m) => m.id === "stale")).toMatchObject({
      status: "done",
      content: "card only",
    });
    expect(done).toContainEqual({ msgId: "stale", status: "done" });
    expect(ws.messages.some((m) => m.status === "streaming")).toBe(false);
    expect(ws.isIdle).toBe(true);
  });

  it("the Stop button finishes a reply left streaming even with no turn to interrupt", async () => {
    const { ws, session, agentInfo } = makeWorkspace();
    const interrupt = vi.fn(() => Promise.resolve(true));
    Object.assign(session, { interrupt, interruptPending: false });
    seedStreamingReply(ws, agentInfo.id, "card only");
    await ws.interruptAgent(agentInfo.id);
    expect(interrupt).not.toHaveBeenCalled();
    expect(ws.messages[0].status).toBe("done");
    expect(ws.isIdle).toBe(true);

    await ws.sendMessage("go");
    const live = ws.messages.find((m) => m.kind === "agent" && m.id !== "stale")!;
    await ws.interruptAgent(agentInfo.id);
    expect(interrupt).toHaveBeenCalled();
    // The running turn ends with its result, not here.
    expect(live.status).toBe("streaming");
  });

  it("a Stop that finishes a stray reply tells clients the agent is idle", async () => {
    const { ws, emit, session, agentInfo, agentMsgs, log } = makeWorkspace();
    Object.assign(session, { interrupt: () => Promise.resolve(true), interruptPending: false });
    session.isRunning = false;
    emit({ kind: "tool_use", content: "**Read** `/a`", toolUseId: "t1" });
    expect(log.at(-1)).toBe(`event ${agentMsgs()[0].id} tool_use`);
    log.length = 0;
    await ws.interruptAgent(agentInfo.id);
    expect(log).toEqual([`done ${agentMsgs()[0].id} done`, "idle"]);
  });

  it("finishes every reply left streaming when the context is cleared", () => {
    const { ws, emit, session, agentInfo, agentMsgs, done } = makeWorkspace();
    seedStreamingReply(ws, agentInfo.id, "");
    session.isRunning = false;
    emit({ kind: "text_delta", content: "stray" });
    expect(ws.clearContext(agentInfo.id)).toBe(true);
    expect(agentMsgs().map((m) => m.status)).toEqual(["done", "done"]);
    expect(done).toContainEqual({ msgId: agentMsgs()[1].id, status: "done" });
    expect(ws.isIdle).toBe(true);
  });

  it("attaches a late tool result to the call that made it", async () => {
    const { ws, emit, session, agentMsgs, done } = makeWorkspace();
    await ws.sendMessage("run it");
    emit({ kind: "tool_use", content: "**Bash** sleep", toolUseId: "t1", toolName: "Bash" });
    emit({ kind: "result", content: "" });
    session.isRunning = false;
    const first = agentMsgs()[0];
    expect(first.status).toBe("done");
    emit({ kind: "tool_result", content: "finished", toolUseId: "t1", durationMs: 9000 });
    expect(agentMsgs()).toHaveLength(1);
    expect(first.events![0].toolResult).toBe("finished");
    expect(first.events![0].durationMs).toBe(9000);
    // The owner is re-announced so open clients pick up the result.
    expect(done.filter((d) => d.msgId === first.id).length).toBeGreaterThanOrEqual(2);
  });

  it("applies a grandchild's events inside the nested card and drops ownerless carriers", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("go");
    emit(subagentStart("outer"));
    emit(subagentProgress("outer", subagentStart("inner")));
    emit(
      subagentProgress(
        "outer",
        subagentProgress("inner", { kind: "tool_use", content: "**Read** `/a`", toolUseId: "r1" }),
      ),
    );
    // A carrier for a task nobody started: dropped, no phantom card.
    emit(subagentProgress("ghost", { kind: "thinking", content: "…" }));
    const events = agentMsgs()[0].events!;
    expect(events.map((e) => e.kind)).toEqual(["subagent_start"]);
    const inner = events[0].subagent!.events!;
    expect(inner.map((e) => e.kind)).toEqual(["subagent_start"]);
    expect(inner[0].subagent!.events!.map((e) => e.kind)).toEqual(["tool_use"]);
  });
});

describe("messages delivered from a project", () => {
  const lead = { workspaceId: "ws-lead", name: "lead", role: "lead" as const };

  it("shows the text with its sender and sends the model the prompt", async () => {
    const { ws, session } = makeWorkspace();
    expect(ws.deliver("fix the parser", lead, "[From the lead]\n\nfix the parser")).toBe("sent");
    expect(session.sent).toEqual(["[From the lead]\n\nfix the parser"]);
    const msg = ws.messages.find((m) => m.kind === "user")!;
    await Promise.resolve();
    expect(msg).toMatchObject({ content: "fix the parser", from: lead, status: "done" });
  });

  it("queues behind a busy agent and dispatches the prompt", async () => {
    const { ws, session, finishTurn } = makeWorkspace();
    session.isRunning = true;
    const worker = { workspaceId: "ws-w", name: "parser fix", role: "worker" as const };
    expect(ws.deliver("done: see branch fix/parser", worker, "[From parser fix]\n\ndone")).toBe(
      "queued",
    );
    expect(session.sent).toEqual([]);
    expect(ws.messages.find((m) => m.kind === "user")!.status).toBe("queued");
    finishTurn();
    await tick();
    expect(session.sent).toEqual(["[From parser fix]\n\ndone"]);
  });

  it("keeps the project link across a restart", () => {
    const { ws } = makeWorkspace();
    ws.projectLink = { projectId: "proj-1", role: "worker" };
    const restored = restoreWorkspace(ws.getState());
    expect(restored.getInfo(false).projectLink).toEqual({ projectId: "proj-1", role: "worker" });
  });
});

describe("interrupting a workspace", () => {
  it("falls back to a full stop for a backend without interrupts", async () => {
    const { ws } = makeWorkspace();
    await ws.sendMessage("long job");
    expect(ws.messages.find((m) => m.kind === "agent")!.status).toBe("streaming");
    await ws.interruptAll();
    const reply = ws.messages.find((m) => m.kind === "agent")!;
    expect(reply).toMatchObject({ status: "done", content: "*\\[interrupted\\]*" });
  });

  it("takes the process down on a second Stop the backend has not answered", async () => {
    const { ws, session, agentInfo } = makeWorkspace();
    let pending = false;
    const handle = session as FakeSession & {
      interrupt(): Promise<boolean>;
      interruptPending: boolean;
    };
    handle.interrupt = () => {
      pending = true;
      return new Promise<boolean>(() => {});
    };
    Object.defineProperty(handle, "interruptPending", { get: () => pending });
    const abort = vi.spyOn(session, "abort");
    await ws.sendMessage("stuck");
    void ws.interruptAgent(agentInfo.id);
    expect(abort).not.toHaveBeenCalled();
    await ws.interruptAgent(agentInfo.id);
    expect(abort).toHaveBeenCalled();
    expect(ws.messages.find((m) => m.kind === "agent")).toMatchObject({ status: "done" });
  });

  it("stops a turn whose process is still starting, which has nothing to interrupt yet", async () => {
    const { ws, session, agentInfo } = makeWorkspace();
    (session as FakeSession & { interrupt(): Promise<boolean> }).interrupt = () =>
      Promise.resolve(false);
    const abort = vi.spyOn(session, "abort");
    await ws.sendMessage("first after a restart");
    await ws.interruptAgent(agentInfo.id);
    expect(abort).toHaveBeenCalled();
  });

  it("forgets the context figure when the context is cleared", async () => {
    const { ws, emit, agentInfo, session } = makeWorkspace();
    await ws.sendMessage("hi");
    emit({ kind: "result", content: "", context: { tokens: 42000, window: 200000 } });
    session.isRunning = false;
    const entry = ws.agents.get(agentInfo.id)!;
    expect(ws.agentInfo(entry).context).toEqual({ tokens: 42000, window: 200000 });
    expect(ws.clearContext(agentInfo.id)).toBe(true);
    expect(ws.agentInfo(entry).context).toBeUndefined();
    expect(ws.agentInfo(entry)).not.toHaveProperty("context");
  });

  it("omits context on clearContext, and refuses while running", async () => {
    const updates: Array<{ context: unknown; hasContext: boolean; state: unknown; busy: unknown }> =
      [];
    const { ws, session, agentInfo } = makeWorkspace("gpt-5.6-terra", {
      onAgentUpdated: (_wsId, agent) =>
        updates.push({
          context: agent.context,
          hasContext: Object.hasOwn(agent, "context"),
          state: agent.state,
          busy: agent.busy,
        }),
    });
    await ws.sendMessage("hi");
    session.emit("event", {
      kind: "result",
      content: "",
      context: { tokens: 96_000, window: 1_000_000 },
    });
    session.isRunning = false;

    // Refuses while actively running; neither memory nor subscribers clear context.
    session.isRunning = true;
    updates.length = 0;
    expect(ws.clearContext(agentInfo.id)).toBe(false);
    expect(updates).toEqual([]);
    expect(ws.getInfo(false).agents[0].context).toEqual({ tokens: 96_000, window: 1_000_000 });

    // Clears context when idle and broadcasts the omitted value immediately.
    session.isRunning = false;
    expect(ws.clearContext(agentInfo.id)).toBe(true);
    expect(updates).toEqual([
      { context: undefined, hasContext: false, state: "idle", busy: false },
    ]);
    expect(ws.getInfo(false).agents[0].context).toBeUndefined();

    // Also omits context when cleared while waiting (non-running).
    await ws.sendMessage("again");
    session.emit("event", {
      kind: "result",
      content: "",
      context: { tokens: 12_000, window: 1_000_000 },
    });
    session.isRunning = false;
    session.emit("runState", "waiting");
    updates.length = 0;
    expect(ws.clearContext(agentInfo.id)).toBe(true);
    expect(updates).toEqual([
      { context: undefined, hasContext: false, state: "waiting", busy: false },
    ]);
    expect(ws.getInfo(false).agents[0].context).toBeUndefined();
  });

  it("keeps clear absent after late stats and leaves another agent unchanged", async () => {
    const { ws, agentInfo, session, host } = makeWorkspace();
    const other = ws.addAgent("B", "gpt-5.6-terra", "B", "#999", { backend: "codex" });
    const otherSession = host.lastSession!;
    await ws.sendMessage("first", agentInfo.id);
    let resolveStats!: (context: { tokens: number; window: number }) => void;
    const stats = new Promise<{ tokens: number; window: number }>((resolve) => {
      resolveStats = resolve;
    });
    session.emit("event", { kind: "result", content: "", context: null }, stats);
    session.isRunning = false;
    const clearedReply = ws.messages.find((m) => m.kind === "agent" && m.agentId === agentInfo.id)!;

    await ws.sendMessage("second", other.id);
    otherSession.emit("event", {
      kind: "result",
      content: "",
      context: { tokens: 12_000, window: 200_000 },
    });
    otherSession.isRunning = false;
    expect(ws.clearContext(agentInfo.id)).toBe(true);

    resolveStats({ tokens: 42_000, window: 200_000 });
    await vi.waitFor(() =>
      expect(clearedReply.context).toEqual({ tokens: 42_000, window: 200_000 }),
    );
    const live = Object.fromEntries(ws.getInfo(false).agents.map((a) => [a.id, a]));
    expect(live[agentInfo.id].context).toBeUndefined();
    expect(live[agentInfo.id]).not.toHaveProperty("context");
    expect(live[other.id].context).toEqual({ tokens: 12_000, window: 200_000 });
    expect(ws.messages.at(-1)).not.toHaveProperty("context");

    const restored = restoreWorkspace(ws.getState());
    const fresh = Object.fromEntries(restored.getInfo(false).agents.map((a) => [a.id, a]));
    expect(fresh[agentInfo.id].context).toBeUndefined();
    expect(fresh[agentInfo.id]).not.toHaveProperty("context");
    expect(fresh[other.id].context).toEqual({ tokens: 12_000, window: 200_000 });
  });

  it("restores absent context after clear, including a legacy null clear marker", async () => {
    const { ws, emit, agentInfo, session } = makeWorkspace();
    await ws.sendMessage("hi");
    emit({ kind: "result", content: "", context: { tokens: 42_000, window: 200_000 } });
    session.isRunning = false;
    expect(ws.clearContext(agentInfo.id)).toBe(true);
    expect(ws.messages.at(-1)).not.toHaveProperty("context");

    const state = ws.getState();
    const legacyClear = state.messages!.find((m) => m.content.includes("context cleared"))!;
    legacyClear.context = null;
    const restored = restoreWorkspace(state);
    const fresh = restored.getInfo(false).agents[0];
    expect(fresh.context).toBeUndefined();
    expect(fresh).not.toHaveProperty("context");

    await restored.sendMessage("/context", agentInfo.id);
    expect(restored.getMessages().at(-1)?.content).toContain("**Occupancy:** Empty");
  });

  it("renders a turn the backend reports as interrupted like a stop", async () => {
    const { ws, emit } = makeWorkspace();
    await ws.sendMessage("go");
    emit({ kind: "text_delta", content: "halfway" });
    emit({ kind: "result", content: "", interrupted: true });
    expect(ws.messages.find((m) => m.kind === "agent")).toMatchObject({
      status: "done",
      content: "halfway\n\n*\\[interrupted\\]*",
    });
  });
});

describe("/model", () => {
  const reply = (ws: Workspace) => ws.messages.filter((m) => m.kind === "agent").at(-1)!.content;

  it("shows the model and the ones of its backend it can move to", async () => {
    const { ws } = makeWorkspace("gpt-6-astra");
    await ws.sendMessage("/model");
    expect(reply(ws)).toContain("runs on **GPT-6 Astra**");
    expect(reply(ws)).toContain("`gpt-5.6-terra`");
    expect(reply(ws)).not.toContain("provider/");
  });

  it("moves the conversation to another model, with effort and fast mode it takes", async () => {
    const { ws, session, agentInfo, emit } = makeWorkspace("gpt-6-astra");
    session.getState().config.effort = "xhigh";
    session.getState().config.fast = true;
    await ws.sendMessage("/model gpt-5.6-terra");
    expect(reply(ws)).toMatch(/moves from GPT-6 Astra to \*\*GPT-5.6 Terra\*\*/);
    expect(ws.agents.get(agentInfo.id)!.info.model).toBe("gpt-5.6-terra");
    expect(session.getState().config).toMatchObject({
      model: "gpt-5.6-terra",
      effort: "xhigh",
      fast: true,
    });

    // Replies from here on say which model they ran on.
    await ws.sendMessage("go on");
    emit({ kind: "text_delta", content: "ok" });
    emit({ kind: "result", content: "" });
    expect(ws.messages.filter((m) => m.kind === "agent").at(-1)!.model).toBe("gpt-5.6-terra");
  });

  it("drops effort and fast mode a model does not take", async () => {
    const { ws, session } = makeWorkspace("provider/model");
    session.getState().config.effort = "xhigh";
    session.getState().config.fast = true;
    await ws.sendMessage("/model other/model");
    expect(session.getState().config).toMatchObject({ model: "other/model" });
    expect(session.getState().config.effort).toBeUndefined();
    expect(session.getState().config.fast).toBeUndefined();
    // Nor offered, nor taken by /effort: every path agrees.
    expect(ws.getInfo(false).agents[0].effortLevels).toEqual([]);
    await ws.sendMessage("/effort high");
    expect(session.getState().config.effort).toBeUndefined();
  });

  it("stays within its backend, and warns about a model the list does not know", async () => {
    const { ws, agentInfo } = makeWorkspace("gpt-6-astra");
    await ws.sendMessage("/model provider/model");
    expect(reply(ws)).toContain("continues only on a Codex model");
    expect(ws.agents.get(agentInfo.id)!.info.model).toBe("gpt-6-astra");
    await ws.sendMessage("/model gpt-7-unknown");
    expect(ws.agents.get(agentInfo.id)!.info.model).toBe("gpt-7-unknown");
    expect(reply(ws)).toContain("is not in the model list");
  });
});
