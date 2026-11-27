import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLifecycle } from "../../src/usage/lifecycle";
import { codexFields, withId } from "./fixtures/codex-wire";
import { CodexSession } from "../../src/session/codex";
import type { RpcMessage, ThreadItem, Transport, UserInput } from "../../src/session/codex-rpc";
import type { StreamEvent } from "../../src/session/types";
import { HostRegistry, LocalHost } from "../../src/session/host";
import { Workspace, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { summarizeMessage, toWireMessage } from "../../src/workspace/summary";
import type { PanelToolset } from "../../src/project/tools";

// An in-memory `codex app-server`: answers the session's requests from
// per-method handlers (a throw is a JSON-RPC error), and lets the test send
// notifications and requests of its own. The recorded behaviour lives in
// tests/snap/codex; these are the cases no recording shows.
class FakeServer {
  written: RpcMessage[] = [];
  connections = 0;
  private listeners: Array<(m: RpcMessage) => void> = [];
  private closers: Array<(r: string) => void> = [];
  private answers = new Map<number | string, (result: unknown) => void>();
  private nextId = 1000;
  // Requests of these methods are never answered.
  hold = new Set<string>();
  // Lines sent right after the answer to a method, in the same tick.
  after: Record<string, RpcMessage[]> = {};
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    initialize: () => codexFields("initialize"),
    "thread/start": () => withId("thread/start", "thread", "thr_1"),
    "thread/resume": (p) => withId("thread/resume", "thread", p.threadId),
    "turn/start": () => withId("turn/start", "turn", `turn_${this.turns()}`),
    "turn/steer": (p) => ({ ...codexFields("turn/steer"), turnId: p.expectedTurnId }),
    "turn/interrupt": () => codexFields("turn/interrupt"),
    "thread/compact/start": () => codexFields("thread/compact/start"),
  };

  transport(): Transport {
    this.connections++;
    this.listeners = [];
    this.closers = [];
    const listeners = this.listeners;
    const closers = this.closers;
    return {
      write: (m) => {
        this.written.push(m);
        if (m.method && m.id != null) void this.answer(m, listeners);
        else if (!m.method && m.id != null) this.answers.get(m.id)?.(m.error ?? m.result);
      },
      onMessage: (cb) => listeners.push(cb),
      onClose: (cb) => closers.push(cb),
      retireProcess: () => {
        this.exitConnection(closers, "codex app-server exited (0)");
        return Promise.resolve();
      },
      // A real child exits a moment after SIGTERM.
      close: () =>
        queueMicrotask(() => this.exitConnection(closers, "codex app-server exited (SIGTERM)")),
    };
  }

  private async answer(m: RpcMessage, listeners: Array<(m: RpcMessage) => void>): Promise<void> {
    if (this.hold.has(m.method!)) return;
    const handler = this.handlers[m.method!];
    let reply: RpcMessage;
    try {
      reply = {
        id: m.id,
        result: handler ? await handler((m.params ?? {}) as Record<string, unknown>) : {},
      };
    } catch (e) {
      reply = { id: m.id, error: { code: -32600, message: (e as Error).message } };
    }
    for (const cb of listeners) cb(reply);
    for (const line of this.after[m.method!] ?? []) for (const cb of listeners) cb(line);
  }

  turns(): number {
    return this.written.filter((m) => m.method === "turn/start").length;
  }

  notify(method: string, params: Record<string, unknown>): void {
    for (const cb of this.listeners) cb({ method, params: { ...codexFields(method), ...params } });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.answers.set(id, resolve);
      for (const cb of this.listeners) cb({ id, method, params });
    });
  }

  exit(reason: string): void {
    this.exitConnection(this.closers, reason);
  }

  private exitConnection(closers: Array<(r: string) => void>, reason: string): void {
    for (const cb of closers.splice(0)) cb(reason);
  }

  sent(method: string): Array<Record<string, unknown>> {
    return this.written
      .filter((m) => m.method === method)
      .map((m) => (m.params ?? {}) as Record<string, unknown>);
  }

  holdTurnStart(id: string): () => void {
    let answer!: () => void;
    this.handlers["turn/start"] = () =>
      new Promise((resolve) => {
        answer = () => resolve({ turn: { id, status: "inProgress", error: null } });
      });
    return () => answer();
  }

  userMessage(id: string, clientId: string | null): void {
    this.item("started", { type: "userMessage", id, clientId, content: [] });
  }

  agentDelta(itemId: string, delta: string, turnId?: string): void {
    this.notify("item/agentMessage/delta", {
      threadId: "thr_1",
      ...(turnId === undefined ? {} : { turnId }),
      itemId,
      delta,
    });
  }

  commandStarted(id: string, command: string): void {
    this.item("started", { type: "commandExecution", id, command, commandActions: [] });
  }

  reject(method: string, message: string): void {
    this.handlers[method] = () => {
      throw new Error(message);
    };
  }

  // The notifications of a turn's start, on thread thr_1.
  startTurn(id = `turn_${this.turns()}`): void {
    this.notify("turn/started", { ...withId("turn/started", "turn", id), threadId: "thr_1" });
  }

  completeTurn(status = "completed", error: unknown = null, id = `turn_${this.turns()}`): void {
    this.notify("turn/completed", {
      ...withId("turn/completed", "turn", id, { status, error }),
      threadId: "thr_1",
    });
  }

  item(
    phase: "started" | "completed",
    item: Record<string, unknown>,
    threadId = "thr_1",
    turnId = "t",
  ): void {
    const method = `item/${phase}`;
    const sample = codexFields(`${method}:${String(item.type)}`);
    this.notify(method, {
      ...sample,
      threadId,
      turnId,
      item: { ...(sample.item as Record<string, unknown>), ...item },
    });
  }
}

// Drain immediate replies and the workspace's zero-delay queue.
const flush = () => vi.advanceTimersByTimeAsync(1);

let server: FakeServer;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  server = new FakeServer();
  CodexSession.hooks = { transport: () => server.transport() };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  CodexSession.hooks = null;
});

type CapturedEvent = {
  event: StreamEvent;
  runState: string;
  steered: string;
  unread: string[];
};

function capture<K extends keyof CapturedEvent>(session: CodexSession, name: K) {
  const values: CapturedEvent[K][] = [];
  session.on(name, (value: CapturedEvent[K]) => values.push(value));
  return values;
}

function restoreSeedThread(sessionId: string) {
  const session = CodexSession.fromState({
    sessionId,
    config: { cwd: "/tmp", backend: "codex", model: "gpt-6-astra" },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turns: 0,
      duration_ms: 0,
    },
  });
  return { session, events: capture(session, "event") };
}

function makeSession(config: Partial<ConstructorParameters<typeof CodexSession>[0]> = {}) {
  const session = new CodexSession({
    cwd: "/tmp",
    backend: "codex",
    model: "gpt-6-astra",
    ...config,
  });
  return { session, events: capture(session, "event"), states: capture(session, "runState") };
}

async function sendAndStart(
  session: CodexSession,
  input: Parameters<CodexSession["send"]>[0],
  turnId?: string,
) {
  await session.send(input);
  server.startTurn(turnId);
}

async function sendWorkspaceTurn(ws: Workspace, text: string) {
  await ws.sendMessage(text);
  server.startTurn();
}

const turnInputTexts = () =>
  server.sent("turn/start").map((p) => (p.input as Array<{ text: string }>)[0].text);

function capacityRetryDelays(...capacityRetryDelaysMs: number[]) {
  CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs };
}

const overloaded = {
  message: "Selected model is at capacity. Please try a different model.",
  codexErrorInfo: "serverOverloaded",
  additionalDetails: null,
};

const usageLimit = {
  message: "You've hit your usage limit.",
  codexErrorInfo: "usageLimitExceeded",
  additionalDetails: null,
};

const echoTools = (handler: (args: Record<string, unknown>) => Promise<string>): PanelToolset => ({
  instructions: "You are a session of the project.",
  tools: [{ name: "echo", description: "Echo the text.", shape: { text: z.string() }, handler }],
});

describe("CodexSession automatic recovery continuation", () => {
  type RecordedUserItem = {
    type: "userMessage";
    id: string;
    clientId: string;
    content: UserInput[];
  };
  type RecordedHistoryReply = { result: { data: Array<{ items: RecordedUserItem[] }> } };
  const [firstPage, emptyPage] = readFileSync(
    join(__dirname, "fixtures/codex-recovery-history.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => (JSON.parse(line) as RecordedHistoryReply).result);
  const userItem = firstPage.data[0].items[0];
  const text = userItem.content[0].text;
  const networkFailure = {
    message: "Provider disconnected",
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    additionalDetails: null,
  };
  const batch = (id = userItem.clientId, supersedes: string[] = [], delta?: string) => ({
    inputId: id,
    reportId: id,
    trigger: "system" as const,
    text,
    recovery: { outageId: "outage", supersedes, delta },
  });
  const next = (delta = "") => batch("retry-2", [userItem.clientId], delta);

  async function startFailedBatch(session: CodexSession) {
    await sendAndStart(session, batch());
    server.item("started", userItem, "thr_1", "turn_1");
    server.item("completed", userItem, "thr_1", "turn_1");
  }

  it("reuses retained input for successive exact failed batches, without a second user item", async () => {
    const { session } = makeSession();
    await startFailedBatch(session);
    expect(server.sent("turn/start")[0]).toMatchObject({
      input: userItem.content,
      clientUserMessageId: userItem.clientId,
    });
    server.completeTurn("failed", networkFailure);
    server.handlers["thread/turns/list"] = () => firstPage;
    const onBeforeWrite = vi.fn();
    await expect(session.send(next(), { onBeforeWrite })).resolves.toBeUndefined();
    expect(onBeforeWrite).toHaveBeenCalledOnce();
    expect(server.sent("turn/start")[1]).toMatchObject({ threadId: "thr_1", input: [] });
    expect(server.sent("turn/start")[1]).not.toHaveProperty("clientUserMessageId");
    server.startTurn();
    server.completeTurn("failed", networkFailure);
    server.handlers["thread/turns/list"] = () => emptyPage;
    await session.send(batch("retry-3", [userItem.clientId, "retry-2"], ""));
    expect(server.sent("turn/start")[2]).toMatchObject({ threadId: "thr_1", input: [] });
    expect(server.sent("thread/turns/list")).toEqual(
      Array(2).fill({
        threadId: "thr_1",
        limit: 1,
        itemsView: "full",
      }),
    );
    expect(server.sent("thread/rollback")).toEqual([]);
    expect(server.sent("thread/fork")).toEqual([]);
  });

  it("resumes after a service restart and adds only the new report notices", async () => {
    const { session } = makeSession();
    await startFailedBatch(session);
    expect(session.getState()).not.toHaveProperty("codexRecoveryProof");
    server.completeTurn("failed", networkFailure);
    const saved = structuredClone(session.getState());
    expect(JSON.stringify(saved)).not.toContain(text);
    await session.dispose();
    const restored = CodexSession.fromState(saved);
    server.handlers["thread/turns/list"] = () => firstPage;
    const delta = "A new report must not be dropped.";
    const retry = next(delta);
    retry.text += `\n${delta}`;
    await restored.send(retry, {
      onBeforeWrite: () => expect(restored.getState()).not.toHaveProperty("codexRecoveryProof"),
    });
    expect(server.sent("thread/resume")).toEqual([expect.objectContaining({ threadId: "thr_1" })]);
    const newItem = {
      ...userItem,
      id: "delta-item",
      clientId: retry.inputId,
      content: [{ type: "text", text: delta, text_elements: [] }],
    };
    expect(server.sent("turn/start")[1]).toMatchObject({
      threadId: "thr_1",
      clientUserMessageId: retry.inputId,
      input: newItem.content,
    });
    server.startTurn();
    server.item("completed", newItem, "thr_1", "turn_2");
    server.completeTurn("failed", networkFailure);
    server.handlers["thread/turns/list"] = () => ({
      ...emptyPage,
      data: [{ ...emptyPage.data[0], items: [newItem] }],
    });
    await restored.send(batch("retry-3", [userItem.clientId, retry.inputId], ""));
    expect(server.sent("turn/start")[2]).toMatchObject({ input: [] });
  });

  it("does not create a thread when the saved recovery thread is gone", async () => {
    const { session } = makeSession();
    await startFailedBatch(session);
    server.completeTurn("failed", networkFailure);
    await session.dispose();
    const restored = CodexSession.fromState(session.getState());
    server.reject("thread/resume", "no rollout found for thread id thr_1");
    const onBeforeWrite = vi.fn();
    await expect(restored.send(next(), { onBeforeWrite })).resolves.toMatchObject({
      disposition: "rejected",
    });
    expect(server.sent("thread/start")).toHaveLength(1);
    expect(server.turns()).toBe(1);
    expect(onBeforeWrite).not.toHaveBeenCalled();
    expect(restored.getState()).not.toHaveProperty("codexRecoveryProof");
  });

  it("does not preserve recovery proof across a lost turn/start response", async () => {
    const { session } = makeSession();
    await startFailedBatch(session);
    server.completeTurn("failed", networkFailure);
    server.handlers["thread/turns/list"] = () => firstPage;
    server.hold.add("turn/start");
    const onBeforeWrite = vi.fn();
    const sending = expect(session.send(next(), { onBeforeWrite })).rejects.toThrow(
      "connection lost",
    );
    await vi.waitFor(() => expect(server.turns()).toBe(2));
    server.startTurn();
    server.exit("connection lost");
    await sending;
    expect(onBeforeWrite).toHaveBeenCalledOnce();
    expect(session.getState()).not.toHaveProperty("codexRecoveryProof");
  });

  it.each([
    "missing delta",
    "closed",
    "wrong tail",
    "read error",
    "generic error",
    "output",
    "tool",
  ])("does not claim or replay automatic recovery with %s evidence", async (scenario) => {
    const { session } = makeSession();
    await startFailedBatch(session);
    if (scenario === "output") {
      server.agentDelta("out", "partial output", "turn_1");
    }
    if (scenario === "tool") {
      server.item("started", { type: "commandExecution", id: "tool" }, "thr_1", "turn_1");
    }
    if (scenario === "generic error") {
      server.notify("error", {
        threadId: "thr_1",
        turnId: "turn_1",
        willRetry: true,
        error: networkFailure,
      });
    }
    if (scenario === "closed") server.exit("connection lost");
    else
      server.completeTurn(
        "failed",
        scenario === "generic error"
          ? { ...networkFailure, codexErrorInfo: "other" }
          : networkFailure,
      );
    server.handlers["thread/turns/list"] = () => {
      if (scenario === "read error") throw new Error("Cannot read turns");
      return scenario === "wrong tail" ? emptyPage : firstPage;
    };
    const onBeforeWrite = vi.fn();
    const retry = scenario === "missing delta" ? batch("retry-2", [userItem.clientId]) : next();
    await expect(session.send(retry, { onBeforeWrite })).resolves.toMatchObject({
      disposition: "rejected",
      error: expect.stringContaining("cannot safely continue") as string,
    });
    expect(onBeforeWrite).not.toHaveBeenCalled();
    expect(server.turns()).toBe(1);
    expect(session.isRunning).toBe(false);
  });

  it("forwards a paired manual turn as new notices and human text, without gating on automatic proof", async () => {
    const { session } = makeSession();
    await startFailedBatch(session);
    server.completeTurn("failed", networkFailure);
    const pair = {
      ...next("A new report"),
      panelContext: "A new report",
      inputId: "user-command",
      trigger: "user" as const,
      text: "Do this next",
    };
    await session.send(pair);
    expect(server.sent("turn/start")[1].input).toEqual([
      { type: "text", text: pair.panelContext, text_elements: [] },
      { type: "text", text: pair.text, text_elements: [] },
    ]);
    expect(server.sent("thread/turns/list")).toEqual([]);
  });
});

describe("codex app-server session", () => {
  it.each([{ expected: "0" }, { inherited: "1", expected: "1" }, { inherited: "", expected: "" }])(
    "passes the Git prompt setting to the app-server: %j",
    async (test) => {
      vi.stubEnv("GIT_TERMINAL_PROMPT", test.inherited);
      const transport = vi.fn((_session: CodexSession, _env: NodeJS.ProcessEnv) =>
        server.transport(),
      );
      CodexSession.hooks = { transport };
      const { session } = makeSession();
      await session.send("first");
      expect(transport.mock.calls[0][1].GIT_TERMINAL_PROMPT).toBe(test.expected);
      expect(process.env.GIT_TERMINAL_PROMPT).toBe(test.inherited);
    },
  );

  it.each([false, true])(
    "distinguishes RPC rejection from a lost turn/start response (lost=%s)",
    async (lost) => {
      const { session } = makeSession();
      const onBeforeWrite = vi.fn();
      if (lost) server.hold.add("turn/start");
      else server.reject("turn/start", "Request rejected");
      const sending = session.send("first", { onBeforeWrite });
      if (lost) {
        const failed = expect(sending).rejects.toThrow("Connection lost");
        await flush();
        expect(server.turns()).toBe(1);
        server.exit("Connection lost");
        await failed;
      } else {
        await expect(sending).resolves.toMatchObject({
          disposition: "rejected",
          error: "Request rejected",
        });
      }
      expect(onBeforeWrite).toHaveBeenCalledTimes(1);
    },
  );
  it("retires the idle process and resumes its thread on the next turn", async () => {
    const { session } = makeSession();
    await session.send("first");
    await expect(session.retireIdleProcess(new AbortController().signal)).rejects.toThrow("busy");
    server.startTurn();
    server.completeTurn();
    expect(session.deployBusy).toBe(false);
    await session.retireIdleProcess(new AbortController().signal);
    await session.send("second");
    expect(server.connections).toBe(2);
    expect(server.sent("thread/resume")).toEqual([expect.objectContaining({ threadId: "thr_1" })]);
  });
  it("snapshots reasoning from item start, even before or without a summary", async () => {
    const host = new LocalHost("local", "Local");
    const registry = new HostRegistry();
    registry.register(host);
    const ws = new Workspace("w", "Workspace", "p", "local", "/tmp", registry);
    ws.addAgent("A", "gpt-6-astra", "A", "#888", { backend: "codex" });
    const clock = vi.spyOn(Date, "now");
    try {
      await ws.sendMessage("go");
      const reply = ws.messages.find((m) => m.kind === "agent")!;
      const item = { id: "r1", type: "reasoning", summary: [], content: [] };
      clock.mockReturnValue(10_000);
      server.item("started", item);
      expect(summarizeMessage(reply).liveThinkingSince).toBe(10_000);
      clock.mockReturnValue(15_000);
      server.notify("item/reasoning/summaryTextDelta", {
        threadId: "thr_1",
        itemId: "r1",
        delta: "draft",
      });
      expect(summarizeMessage(reply).liveThinkingSince).toBe(10_000);
      expect(JSON.stringify(summarizeMessage(reply))).not.toContain("draft");
      clock.mockReturnValue(16_000);
      server.item("completed", item);
      expect(summarizeMessage(reply).liveThinkingSince).toBeUndefined();
      expect(summarizeMessage(reply).waitingSince).toBe(16_000);
    } finally {
      clock.mockRestore();
      await ws.dispose();
      await host.close();
    }
  });
  it("settles an image view with an empty result and its measured duration", () => {
    const { session, events } = makeSession();
    // Exercise the typed item mapping below the notification envelope: no
    // recorded imageView RPC frame exists to replay through FakeServer.
    const mapping = session as unknown as {
      itemStarted(item: ThreadItem): void;
      itemCompleted(item: ThreadItem): void;
    };
    const item: Extract<ThreadItem, { type: "imageView" }> = {
      type: "imageView",
      id: "img1",
      path: "C:\\captures\\one.png",
    };
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(10_000);
      mapping.itemStarted(item);
      clock.mockReturnValue(10_750);
      mapping.itemCompleted(item);
      // A repeated completion cannot reopen or settle the call a second time.
      mapping.itemCompleted(item);
    } finally {
      clock.mockRestore();
    }
    expect(events).toEqual([
      {
        kind: "tool_use",
        toolName: "ViewImage",
        content: "**ViewImage** `C:\\captures\\one.png`",
        toolUseId: "img1",
        startedAt: 10_000,
      },
      { kind: "tool_result", content: "", toolUseId: "img1", durationMs: 750 },
    ]);
  });

  it("forwards validated arguments only for known panel tools on the owning thread", async () => {
    const { session } = makeSession();
    const handler = vi.fn((args: Record<string, unknown>) => Promise.resolve(String(args.text)));
    session.setPanelTools(echoTools(handler));
    await session.send("hi");
    const call = (args: unknown, extra: Record<string, unknown> = {}) =>
      server.request("item/tool/call", {
        ...codexFields("item/tool/call"),
        threadId: "thr_1",
        turnId: "turn_1",
        tool: "echo",
        arguments: args,
        ...extra,
      });
    const invalid = (await call({ text: 3 })) as {
      success: boolean;
      contentItems: Array<{ text: string }>;
    };
    expect(invalid.success).toBe(false);
    expect(invalid.contentItems[0].text).toContain("text");
    expect(await call({ text: "hi" }, { tool: "start_session" })).toMatchObject({ success: false });
    // A subagent's thread has none of them.
    expect(await call({ text: "hi" }, { threadId: "thr_sub" })).toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
    expect(await call({ text: "ok" })).toEqual({
      contentItems: [{ type: "inputText", text: "ok" }],
      success: true,
    });
    expect(handler.mock.calls.map(([args]) => args)).toEqual([{ text: "ok" }]);
  });

  it("sends model, effort and Fast with every turn, changing them without a restart", async () => {
    const { session } = makeSession({ model: "gpt-6-astra[1m]" });
    await sendAndStart(session, "one");
    server.completeTurn();
    session.setEffort("high");
    session.setFastMode(true);
    await session.send("two");
    const [start] = server.sent("thread/start");
    expect(start).toMatchObject({
      model: "gpt-6-astra",
      serviceTier: "default",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      config: { model_context_window: 872_000 },
    });
    const [first, second] = server.sent("turn/start");
    expect(first).toMatchObject({
      model: "gpt-6-astra",
      serviceTier: "default",
      summary: "detailed",
    });
    expect(first).not.toHaveProperty("effort");
    expect(second).toMatchObject({ effort: "high", serviceTier: "priority" });
    expect(server.connections).toBe(1);
  });

  it("refreshes project instructions on a resumed thread without re-registering its tools", async () => {
    const { session } = makeSession();
    session.sessionId = "thr_1";
    const tools = {
      ...echoTools(() => Promise.resolve("ok")),
      instructions: "Write user-facing replies, questions and summaries in Icelandic.",
    };
    session.setPanelTools(tools);
    await session.send("hi");
    const [resume] = server.sent("thread/resume");
    expect(resume).toMatchObject({ threadId: "thr_1", developerInstructions: tools.instructions });
    expect(resume).not.toHaveProperty("dynamicTools");
    expect(server.sent("thread/start")).toEqual([]);
  });

  it("starts a fresh thread, saying so, when the stored one is gone", async () => {
    server.handlers["thread/resume"] = (p) => {
      throw new Error(`no rollout found for thread id ${String(p.threadId)}`);
    };
    server.handlers["thread/start"] = () => ({ thread: { id: "thr_new" } });
    const { session, events } = restoreSeedThread("thr_gone");
    await session.send("hi");
    expect(session.sessionId).toBe("thr_new");
    expect(events[0]).toMatchObject({ kind: "notice", level: "warning" });
    expect(events[0].content).toContain("fresh thread");
    expect(session.isRunning).toBe(true);
  });

  it("keeps the thread when the resume fails for another reason", async () => {
    server.reject("thread/resume", "permission denied");
    const { session, events } = restoreSeedThread("thr_kept");
    await session.send("hi");
    expect(session.sessionId).toBe("thr_kept");
    expect(events).toEqual([{ kind: "error", content: "[Codex error] permission denied" }]);
    expect(session.isRunning).toBe(false);
  });

  it("ends a turn its app-server died in, and resumes in a new one next time", async () => {
    const { session, events } = makeSession();
    await sendAndStart(session, "one");
    server.commandStarted("c1", "sleep 9");
    server.exit("codex app-server exited (9)");
    expect(session.isRunning).toBe(false);
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["tool_use", "**Bash**\n```bash\nsleep 9\n```"],
      ["tool_result", "(stopped)"],
      ["error", "[Codex error] codex app-server exited (9)"],
    ]);
    await session.send("two");
    expect(server.connections).toBe(2);
    expect(server.sent("thread/resume")).toHaveLength(1);
  });

  it("interrupts a turn stopped before turn/start answered, once codex started it", async () => {
    const answer = server.holdTurnStart("turn_9");
    const { session } = makeSession();
    const sending = session.send("hi");
    await flush();
    expect(await session.interrupt()).toBe(true);
    expect(session.interruptPending).toBe(true);
    expect(server.sent("turn/interrupt")).toEqual([]);
    answer();
    await sending;
    expect(server.sent("turn/interrupt")).toEqual([]);
    server.startTurn("turn_9");
    await flush();
    expect(server.sent("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_9" }]);
  });

  it("steers only into a running turn, and tells which steered message the model read", async () => {
    const { session } = makeSession();
    const steered = capture(session, "steered");
    expect(await session.steer("early", "m0")).toBe(false);
    await sendAndStart(session, "hi");
    expect(await session.steer("a", "m1")).toBe(true);
    expect(await session.steer("b", "m2")).toBe(true);
    expect(server.sent("turn/steer")[0]).toMatchObject({
      expectedTurnId: "turn_1",
      clientUserMessageId: "m1",
    });
    server.userMessage("u0", null);
    expect(steered).toEqual([]);
    // Tagged with the panel's id, in any order; untagged, in order sent.
    server.userMessage("u2", "m2");
    server.userMessage("u1", null);
    expect(steered).toEqual(["m2", "m1"]);
    server.reject("turn/steer", "no active turn to steer");
    expect(await session.steer("late", "m3")).toBe(false);
  });

  it.each([
    {
      message: "Provider interrupted",
      info: { responseStreamDisconnected: { httpStatusCode: null } },
      expected: true,
    },
    { message: "OAuth /token failed: socket hang up", info: null, expected: true },
    { message: "OAuth /token failed: HTTP 403: socket hang up", info: null, expected: undefined },
    { message: "503 Service Unavailable", info: null, expected: undefined },
  ])(
    "classifies transport on the Codex terminal error: %j",
    async ({ message, info, expected }) => {
      const { session, events } = makeSession();
      await sendAndStart(session, "hi");
      server.completeTurn("failed", { message, codexErrorInfo: info, additionalDetails: null });
      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("error");
      expect(terminal?.networkFailure).toBe(expected);
    },
  );

  it("shows a retried error as a retry and a usage limit by its spent window", async () => {
    const { session, events } = makeSession();
    const limits: unknown[] = [];
    session.on("rateLimit", (l: unknown) => limits.push(l));
    const quota: unknown[] = [];
    const sparse: unknown[] = [];
    session.on("quota", (q: unknown, delta: unknown) => {
      quota.push(q);
      sparse.push(delta);
    });
    await sendAndStart(session, "hi");
    server.notify("error", {
      threadId: "thr_1",
      turnId: "turn_1",
      willRetry: true,
      error: { message: "stream disconnected" },
    });
    server.notify("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 100 },
        secondary: null,
        planType: "pro",
      },
    });
    // Sparse: the primary window stands.
    server.notify("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: null,
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 900 },
        planType: null,
      },
    });
    server.completeTurn("failed", usageLimit);
    expect(events.map((e) => e.kind)).toEqual(["retry", "error"]);
    expect(events[1].content).toMatch(/^Usage limit reached \(seven-day\)\. Resets at /);
    expect(limits).toEqual([{ rateLimitType: "seven_day", resetsAt: 900 }]);
    expect(quota.at(-1)).toEqual({
      limitId: "codex",
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 900 },
      planType: "pro",
    });
    expect(sparse.at(-1)).toEqual({
      limitId: "codex",
      primary: null,
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 900 },
      planType: null,
    });
    expect(await session.getUsageInfo()).toEqual({
      rate_limits: {
        five_hour: { utilization: 40, resets_at: new Date(100_000).toISOString() },
        seven_day: { utilization: 100, resets_at: new Date(900_000).toISOString() },
      },
      subscription_type: "pro",
    });
  });

  it("carries on in a new turn when the model's capacity failed one, without resending the prompt", async () => {
    capacityRetryDelays(0, 0);
    const { session, events, states } = makeSession();
    const steered = capture(session, "steered");
    await sendAndStart(session, "hi");
    server.userMessage("u1", null);
    server.agentDelta("m1", "Half");
    server.completeTurn("failed", overloaded);
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "retry"]);
    expect(events[1].content).toBe(`${overloaded.message} Retrying in 0s (1/2).`);
    expect(session.isRunning).toBe(true);

    await flush();
    const turns = server.sent("turn/start");
    expect(turns).toHaveLength(2);
    expect((turns[1].input as Array<{ text: string }>)[0].text).toMatch(
      /^Continue from where you left off\. The previous turn was interrupted because the selected model was at capacity\./,
    );
    server.startTurn();
    server.userMessage("u2", null);
    server.agentDelta("m2", "done");
    server.completeTurn();
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "retry", "text_delta", "result"]);
    expect(events[2].content).toBe("\n\ndone");
    expect(steered).toEqual([]);
    expect(states).toEqual(["working", "idle"]);
  });

  it("gives up on capacity after the last retry, and a Stop while it waits ends the turn", async () => {
    capacityRetryDelays(0);
    const { session, events } = makeSession();
    await sendAndStart(session, "hi");
    server.completeTurn("failed", overloaded);
    await flush();
    server.startTurn();
    server.completeTurn("failed", overloaded);
    expect(events.map((e) => e.kind)).toEqual(["retry", "error"]);
    expect(events[1].content).toBe(`[Codex error] ${overloaded.message}`);
    expect(session.isRunning).toBe(false);

    // A new turn starts counting again.
    capacityRetryDelays(60_000);
    await sendAndStart(session, "again");
    server.completeTurn("failed", overloaded);
    expect(events.at(-1)?.kind).toBe("retry");
    expect(await session.interrupt()).toBe(true);
    expect(session.isRunning).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "result", interrupted: true });
    await flush();
    expect(server.sent("turn/start")).toHaveLength(3);
    expect(server.sent("turn/interrupt")).toEqual([]);
  });

  it("gives a capacity retry's unread steers back to the queue, and takes none while it waits", async () => {
    capacityRetryDelays(0);
    const { session } = makeSession();
    const unread = capture(session, "unread");
    await sendAndStart(session, "hi");
    server.userMessage("u1", null);
    expect(await session.steer("also this", "m1")).toBe(true);
    server.completeTurn("failed", overloaded);
    expect(unread).toEqual([["m1"]]);
    expect(await session.steer("and this", "m2")).toBe(false);
    await flush();
    expect(server.sent("turn/start")).toHaveLength(2);
    expect(server.sent("turn/steer")).toHaveLength(1);
  });

  it("attributes an autonomous model turn during capacity backoff to auto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-capacity-"));
    const { session } = makeSession({ dataDir: dir, workspaceId: "ws" });
    try {
      capacityRetryDelays(60_000);
      await sendAndStart(session, "hi");
      server.completeTurn("failed", overloaded);
      server.startTurn("turn_goal");
      server.item("started", { type: "agentMessage", id: "output" }, "thr_1", "turn_goal");
      expect(
        readLifecycle(dir, "ws").find((m) => m.turnId === "turn_goal" && m.marker === "stepStart")
          ?.trigger,
      ).toBe("auto");
    } finally {
      session.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries no compaction, and no turn when codex carried on by itself meanwhile", async () => {
    capacityRetryDelays(20);
    const { session, events } = makeSession();
    await sendAndStart(session, "hi");
    server.completeTurn("failed", overloaded);
    server.startTurn("turn_goal");
    await vi.advanceTimersByTimeAsync(40);
    expect(server.sent("turn/start")).toHaveLength(1);
    server.completeTurn("completed", null, "turn_goal");
    expect(events.map((e) => e.kind)).toEqual(["retry", "result"]);

    await sendAndStart(session, "/compact", "turn_c");
    server.completeTurn("failed", overloaded, "turn_c");
    expect(events.at(-1)).toEqual({
      kind: "error",
      content: `[Codex error] ${overloaded.message}`,
    });
    expect(session.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(server.sent("turn/start")).toHaveLength(1);
  });

  it("retries a turn codex started itself after a compaction", async () => {
    capacityRetryDelays(60_000);
    const { session, events } = makeSession();
    await sendAndStart(session, "/compact", "turn_c");
    server.completeTurn("completed", null, "turn_c");
    server.startTurn("turn_goal");
    server.completeTurn("failed", overloaded, "turn_goal");
    expect(events.at(-1)?.kind).toBe("retry");
    session.abort();
  });

  it("goes idle without a terminal event when the process is killed mid-turn", async () => {
    const { session, events, states } = makeSession();
    await sendAndStart(session, "hi");
    session.abort();
    expect(session.isRunning).toBe(false);
    expect(states).toEqual(["working", "idle"]);
    expect(events).toEqual([]);
  });

  it("runs /compact as compaction, not as a prompt", async () => {
    const { session, events } = makeSession();
    await session.send("/compact");
    expect(server.sent("turn/start")).toEqual([]);
    expect(server.sent("thread/compact/start")).toEqual([{ threadId: "thr_1" }]);
    server.startTurn("turn_c");
    const item = { type: "contextCompaction", id: "k" };
    server.item("started", item, "thr_1", "turn_c");
    const usage = {
      threadId: "thr_1",
      turnId: "turn_c",
      tokenUsage: {
        total: {
          totalTokens: 9000,
          inputTokens: 8000,
          cachedInputTokens: 6000,
          cacheWriteInputTokens: 0,
          outputTokens: 1000,
          reasoningOutputTokens: 400,
        },
        last: {
          totalTokens: 9999,
          inputTokens: 4500,
          cachedInputTokens: 4000,
          cacheWriteInputTokens: 0,
          outputTokens: 500,
          reasoningOutputTokens: 200,
        },
        modelContextWindow: 258400,
      },
    };
    server.notify("thread/tokenUsage/updated", usage);
    server.item("completed", item, "thr_1", "turn_c");
    server.completeTurn("completed", null, "turn_c");
    expect(events.map((e) => e.kind)).toEqual(["compact", "result"]);
    for (const e of events)
      expect(e.context).toEqual({ tokens: 4800, window: 258400, estimated: true });
    expect(session.usage).toMatchObject({
      input_tokens: 500,
      cache_read_tokens: 4000,
      output_tokens: 500,
      turns: 1,
    });
    expect(await session.getContextUsage()).toMatchObject({ totalTokens: 4800, maxTokens: 258400 });

    await sendAndStart(session, "/compact", "failed-compact");
    server.completeTurn("failed", overloaded, "failed-compact");
    expect(events.at(-1)).not.toHaveProperty("context");
    expect(await session.getContextUsage()).toMatchObject({ totalTokens: 4800, maxTokens: 258400 });

    await sendAndStart(session, "next", "next");
    server.notify("thread/tokenUsage/updated", usage); // Late update from the old turn.
    server.completeTurn("completed", null, "next");
    expect(events.at(-1)?.context).toBeNull();
    expect(await session.getContextUsage()).toBeNull();

    await sendAndStart(session, "invalid reasoning count", "invalid");
    server.notify("thread/tokenUsage/updated", {
      ...usage,
      turnId: "invalid",
      tokenUsage: {
        ...usage.tokenUsage,
        last: { ...usage.tokenUsage.last, reasoningOutputTokens: 501 },
      },
    });
    server.completeTurn("completed", null, "invalid");
    expect(events.at(-1)?.context).toBeNull();
  });

  it("takes a turn codex starts itself as a wake-up", async () => {
    const { session, events } = makeSession();
    await sendAndStart(session, "hi");
    server.completeTurn();
    server.startTurn("turn_goal");
    expect(session.isRunning).toBe(true);
    server.completeTurn("completed", null, "turn_goal");
    expect(events.map((e) => [e.kind, e.level])).toEqual([
      ["result", undefined],
      ["notice", "wakeup"],
      ["result", undefined],
    ]);
  });

  it("keeps an agent message whose text came without deltas, and each warning once", async () => {
    const { session, events } = makeSession();
    await sendAndStart(session, "hi");
    server.notify("warning", { threadId: "thr_1", message: "Model metadata not found." });
    server.agentDelta("a1", "Hel");
    server.item("completed", { type: "agentMessage", id: "a1", text: "Hello." });
    server.item("completed", { type: "agentMessage", id: "a2", text: "Second." });
    server.notify("warning", { threadId: "thr_1", message: "Model metadata not found." });
    server.completeTurn();
    expect(events.filter((e) => e.kind === "notice")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "text_delta").map((e) => e.content)).toEqual([
      "Hel",
      "lo.",
      "\n\nSecond.",
    ]);
  });
});

describe("codex session races", () => {
  it("does not let a stopped turn's late failure fail the next one", async () => {
    const { session, events } = makeSession();
    server.hold.add("turn/start");
    void session.send("one");
    await flush();
    session.abort();
    server.hold.clear();
    await sendAndStart(session, "two");
    // The first process exits now: its turn/start fails.
    await flush();
    expect(session.isRunning).toBe(true);
    expect(events).toEqual([]);
    expect(server.connections).toBe(2);
    server.completeTurn();
    expect(events.map((e) => e.kind)).toEqual(["result"]);
  });

  it("interrupts only once codex started the turn, and a refused interrupt leaves it running", async () => {
    const { session, events } = makeSession();
    await session.send("hi");
    expect(await session.interrupt()).toBe(true);
    expect(server.sent("turn/interrupt")).toEqual([]);
    server.reject("turn/interrupt", "no active turn");
    server.startTurn();
    await flush();
    expect(server.sent("turn/interrupt")).toHaveLength(1);
    expect(session.isRunning).toBe(true);
    expect(session.interruptPending).toBe(false);
    expect(events).toEqual([]);
  });

  it("keeps the next turn's Stop when the stopped turn's interrupt fails late", async () => {
    const { session } = makeSession();
    await sendAndStart(session, "one");
    server.hold.add("turn/interrupt");
    void session.interrupt();
    await flush();
    session.abort();
    server.hold.clear();
    await session.send("two");
    await session.interrupt();
    // The first process exits now: its turn/interrupt fails.
    await flush();
    expect(session.interruptPending).toBe(true);
    server.startTurn();
    await flush();
    expect(server.sent("turn/interrupt").map((p) => p.turnId)).toEqual(["turn_1", "turn_2"]);
  });

  it("steers a message sent before turn/start answered once the turn is known", async () => {
    const answer = server.holdTurnStart("turn_1");
    const { session } = makeSession();
    void session.send("hi");
    await flush();
    const steering = session.steer("more", "m1");
    await flush();
    expect(server.sent("turn/steer")).toEqual([]);
    answer();
    expect(await steering).toBe(true);
    expect(server.sent("turn/steer")).toEqual([
      expect.objectContaining({ expectedTurnId: "turn_1" }),
    ]);
  });

  it("does not take a userMessage tagged with an id it never sent for a steered one", async () => {
    const { session } = makeSession();
    const steered = capture(session, "steered");
    await sendAndStart(session, "hi");
    server.userMessage("u0", null);
    await session.steer("more", "m1");
    server.userMessage("u1", "other");
    expect(steered).toEqual([]);
    server.userMessage("u2", null);
    expect(steered).toEqual(["m1"]);
  });

  it("splits at a steered message read in the same tick as the steer's answer", async () => {
    const { session } = makeSession();
    const steered = capture(session, "steered");
    await sendAndStart(session, "hi");
    server.userMessage("u0", null);
    server.after["turn/steer"] = [
      {
        method: "item/started",
        params: {
          threadId: "thr_1",
          item: { type: "userMessage", id: "u1", clientId: "m1", content: [] },
        },
      },
    ];
    expect(await session.steer("more", "m1")).toBe(true);
    expect(steered).toEqual(["m1"]);
  });

  it("reports the steered messages a turn ended without reading, and never steers /compact", async () => {
    const { session } = makeSession();
    const unread = capture(session, "unread");
    await sendAndStart(session, "hi");
    expect(await session.steer("/compact", "m0")).toBe(false);
    expect(await session.steer("more", "m1")).toBe(true);
    server.completeTurn("interrupted");
    expect(unread).toEqual([["m1"]]);
  });

  it("answers no tool call from a process it is replacing, and stops its subagents' cards", async () => {
    const { session, events } = makeSession();
    session.setPanelTools(echoTools(() => Promise.resolve("ran")));
    await sendAndStart(session, "hi");
    server.item("started", {
      type: "subAgentActivity",
      id: "s1",
      kind: "started",
      agentThreadId: "thr_sub",
      agentPath: "/root/helper",
    });
    const echo = (callId: string) =>
      server.request("item/tool/call", {
        threadId: "thr_1",
        turnId: "turn_1",
        callId,
        namespace: "panel",
        tool: "echo",
        arguments: { text: "x" },
      });
    const call = echo("c");
    session.abort();
    const late = echo("c2");
    expect(await call).toMatchObject({ success: true });
    expect(await late).toMatchObject({
      message: expect.stringContaining("shutting down") as string,
    });
    expect(events.find((e) => e.kind === "subagent_done")?.subagent).toMatchObject({
      taskId: "thr_sub",
      status: "stopped",
    });
  });
});

describe("codex steering through the workspace", () => {
  const removed: string[] = [];
  function localRegistry() {
    const registry = new HostRegistry();
    registry.register(new LocalHost("local", "Local"));
    return registry;
  }
  const workspaceCallbacks: WorkspaceCallbacks = {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
  };
  function makeWorkspace(callbacks: Partial<WorkspaceCallbacks> = {}) {
    const ws = new Workspace("ws", "t", "p", "local", "/tmp", localRegistry(), {
      ...workspaceCallbacks,
      ...callbacks,
    });
    const agent = ws.addAgent("A", "gpt-6-astra", "🤖", "#888", { backend: "codex" });
    return { ws, agent };
  }
  function workspaceWithRemovalLog(callbacks: Partial<WorkspaceCallbacks> = {}) {
    removed.length = 0;
    return makeWorkspace({ onMessageRemoved: (_ws, id) => removed.push(id), ...callbacks }).ws;
  }
  async function startWorkspace() {
    const ws = workspaceWithRemovalLog();
    await sendWorkspaceTurn(ws, "first");
    return ws;
  }
  async function sendMessageRow(ws: Workspace, text: string) {
    await ws.sendMessage(text);
    return ws.messages.find((m) => m.content === text)!;
  }
  function readPromptAndSteer(clientId: string) {
    server.userMessage("u1", null);
    server.userMessage("u2", clientId);
  }
  const summary = (ws: Workspace) =>
    ws.messages.filter((m) => m.kind !== "system").map((m) => `${m.kind} ${m.status} ${m.content}`);

  it.each([false, true])(
    "notifies idle after early turn completion or transport loss (lost=%s)",
    async (lost) => {
      const idle: boolean[] = [];
      const ws = workspaceWithRemovalLog({ onAgentIdle: () => idle.push(ws.isIdle) });
      if (lost) server.hold.add("turn/start");
      else
        server.after["turn/start"] = [
          {
            method: "turn/completed",
            params: {
              ...codexFields("turn/completed"),
              ...withId("turn/completed", "turn", "turn_1", { status: "completed" }),
              threadId: "thr_1",
            },
          },
        ];
      const sending = ws.sendMessage("first");
      if (lost) {
        await flush();
        expect(server.turns()).toBe(1);
        server.exit("Connection lost");
      }
      await sending;
      expect(idle).toEqual([true]);
      expect(ws.messages.find((m) => m.kind === "user")?.status).toBe(
        lost ? "outcome_unknown" : "done",
      );
      expect(ws.messages.filter((m) => m.kind === "agent")).toHaveLength(1);
    },
  );

  it("queues paired panel context and user text as one Codex turn and two transcript rows", async () => {
    const prepareManualInput = vi
      .fn<NonNullable<WorkspaceCallbacks["prepareManualInput"]>>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({
        panelContext: {
          reportId: "outage-batch",
          text: "Panel recovery details.",
          recovery: { outageId: "outage-batch", supersedes: ["prior-attempt"] },
        },
        stage: () => {},
        rollback: () => {},
        committed: () => {},
      });
    const onReportDeliveryState = vi.fn<NonNullable<WorkspaceCallbacks["onReportDeliveryState"]>>();
    const live: ReturnType<typeof toWireMessage>[] = [];
    const { ws, agent } = makeWorkspace({
      onNewMessage: (_ws, msg) => live.push(toWireMessage(msg)),
      prepareManualInput,
      onReportDeliveryState,
    });
    await sendWorkspaceTurn(ws, "First");
    server.userMessage("first-user", null);
    const inbox = ws.ensureReportQueued(
      "inbox-msg",
      agent.id,
      { inputId: "inbox-msg", reportId: "inbox-report", text: "Queued report" },
      { workspaceId: "worker", name: "Worker", role: "worker" },
      "Queued report",
    );
    await ws.sendMessage("Please continue.");

    expect(prepareManualInput.mock.calls.at(-1)).toEqual([ws, agent.id, true]);
    expect(server.sent("turn/steer")).toEqual([]);
    const rows = live.slice(-2);
    expect(rows).toMatchObject([
      { kind: "user", content: "Panel recovery details.", from: { role: "panel" }, status: "done" },
      { kind: "user", content: "Please continue.", status: "queued", queuedFor: agent.id },
    ]);
    expect(rows[1]).not.toHaveProperty("from");
    expect(rows[1]).not.toHaveProperty("queuedEnvelope");
    expect(ws.findMessage(rows[1].id)?.queuedEnvelope?.recovery).toEqual({
      outageId: "outage-batch",
      supersedes: ["prior-attempt"],
    });
    expect(ws.getInfo().messages.slice(-2).map(toWireMessage)).toEqual(rows);
    expect(onReportDeliveryState.mock.calls).toEqual([["outage-batch", "enqueued"]]);

    server.completeTurn();
    await vi.waitFor(() => expect(server.turns()).toBe(2));
    expect(inbox.status).toBe("queued");
    expect(server.sent("turn/start")[1].input).toEqual([
      { type: "text", text: "Panel recovery details.", text_elements: [] },
      { type: "text", text: "Please continue.", text_elements: [] },
    ]);
    await vi.waitFor(() => expect(ws.findMessage(rows[1].id)?.status).toBe("done"));
    server.startTurn();
    server.userMessage("paired-user", null);
    server.completeTurn();
    expect(onReportDeliveryState.mock.calls.map(([id, state]) => [id, state])).toEqual([
      ["outage-batch", "enqueued"],
      ["outage-batch", "dispatching"],
      ["outage-batch", "sent_to_pi"],
      ["outage-batch", "settled"],
    ]);
  });

  it("steers a message into the running turn and answers it in a reply of its own", async () => {
    const ws = await startWorkspace();
    server.agentDelta("a1", "Working.");
    const steered = await sendMessageRow(ws, "also this");
    // Handed over, not read yet: still queued, and no longer cancellable.
    expect(steered.status).toBe("queued");
    expect(ws.cancelQueued(steered.id)).toBe(false);
    expect(server.sent("turn/steer")).toEqual([
      expect.objectContaining({ clientUserMessageId: steered.id, expectedTurnId: "turn_1" }),
    ]);
    readPromptAndSteer(steered.id);
    expect(steered.status).toBe("done");
    server.agentDelta("a2", "Done both.");
    server.completeTurn();
    await flush();
    expect(summary(ws)).toEqual([
      "user done first",
      "agent done Working.",
      "user done also this",
      "agent done Done both.",
    ]);
  });

  it("queues a message, cancellable, while a capacity retry waits", async () => {
    capacityRetryDelays(60_000);
    const shown: Array<{ content: string; steering?: boolean }> = [];
    const { ws } = makeWorkspace({
      onNewMessage: (_ws, m) => shown.push({ content: m.content, steering: m.steering }),
    });
    await sendWorkspaceTurn(ws, "first");
    server.completeTurn("failed", overloaded);
    const waiting = await sendMessageRow(ws, "also this");
    expect(shown.find((m) => m.content === "also this")?.steering).toBeUndefined();
    expect(server.sent("turn/steer")).toEqual([]);
    expect(ws.cancelQueued(waiting.id)).toBe(true);
    ws.agents.values().next().value!.session.abort();
  });

  it("queues a message the turn would not take, and runs it when the turn ends", async () => {
    const ws = await startWorkspace();
    server.reject("turn/steer", "activeTurnNotSteerable");
    const second = await sendMessageRow(ws, "second");
    expect(second.status).toBe("queued");
    server.completeTurn();
    await flush();
    expect(second.status).toBe("done");
    expect(turnInputTexts()).toEqual(["first", "second"]);
  });

  it("tells another session its message went into the running turn", async () => {
    const ws = await startWorkspace();
    const from = { workspaceId: "lead", name: "lead", role: "lead" as const };
    expect(ws.deliver("note", from, "[From the project lead] note")).toBe("steered");
    await flush();
    expect(server.sent("turn/steer")[0]).toMatchObject({
      input: [{ type: "text", text: "[From the project lead] note", text_elements: [] }],
    });
  });

  it("stops a turn by interrupt and runs the steered message it never read after it", async () => {
    const ws = await startWorkspace();
    const [id] = ws.agents.keys();
    server.commandStarted("c1", "sleep 30");
    // Steered, but the command still runs: the model has not read it.
    const second = await sendMessageRow(ws, "second");
    await ws.interruptAgent(id);
    expect(server.sent("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_1" }]);
    // codex drops it with the turn (codex/steer-interrupt): the panel runs it.
    server.completeTurn("interrupted");
    await flush();
    expect(second.status).toBe("done");
    expect(turnInputTexts()).toEqual(["first", "second"]);
    const [reply] = ws.messages.filter((m) => m.kind === "agent");
    expect(reply.content).toBe("*\\[interrupted\\]*");
    expect(reply.events!.find((e) => e.kind === "tool_use")).toMatchObject({
      toolResult: "(interrupted)",
      toolResultIsError: true,
    });
    expect(server.connections).toBe(1);
  });

  it("drops the empty reply when the steered message is read with the prompt", async () => {
    const ws = await startWorkspace();
    const second = await sendMessageRow(ws, "second");
    const [empty] = ws.messages.filter((m) => m.kind === "agent");
    readPromptAndSteer(second.id);
    server.agentDelta("a1", "Both.");
    server.completeTurn();
    await flush();
    expect(removed).toEqual([empty.id]);
    expect(summary(ws)).toEqual(["user done first", "user done second", "agent done Both."]);
  });

  it("carries on rather than resending a prompt when a limit refuses the turn after a steer", async () => {
    const ws = await startWorkspace();
    const [id] = ws.agents.keys();
    server.agentDelta("a1", "On it.");
    const second = await sendMessageRow(ws, "second");
    readPromptAndSteer(second.id);
    // The request that read it is the one the limit refuses.
    ws.pauseAgent(id, Date.now() + 60_000, true);
    server.completeTurn("failed", usageLimit);
    await flush();
    expect(ws.retryLast(id)).toBe(true);
    await flush();
    expect(turnInputTexts()).toEqual([
      "first",
      "[From the panel] A usage limit cut your turn off. Carry on where you left off.",
    ]);
  });

  it("closes a call the earlier reply made when its result comes after a steered message", async () => {
    const ws = await startWorkspace();
    server.commandStarted("c1", "make");
    const second = await sendMessageRow(ws, "second");
    readPromptAndSteer(second.id);
    server.item("completed", {
      type: "commandExecution",
      id: "c1",
      command: "make",
      commandActions: [],
      status: "completed",
      aggregatedOutput: "built\n",
      exitCode: 0,
      durationMs: 900,
    });
    server.completeTurn();
    await flush();
    const [before, after] = ws.messages.filter((m) => m.kind === "agent");
    expect(before.events!.find((e) => e.kind === "tool_use")).toMatchObject({
      toolResult: "built\n",
      durationMs: 900,
    });
    expect(after.events ?? []).toEqual([]);
  });

  it("does not steer past a waiting message or a rate-limit hold", async () => {
    const ws = await startWorkspace();
    const [id] = ws.agents.keys();
    ws.pauseAgent(id, Date.now() + 60_000);
    await ws.sendMessage("held");
    ws.pauseAgent(id, 0);
    await ws.sendMessage("behind");
    expect(server.sent("turn/steer")).toEqual([]);
    expect(ws.messages.filter((m) => m.status === "queued").map((m) => m.content)).toEqual([
      "held",
      "behind",
    ]);
  });

  it("gives a message caught mid-steer by a restart back to the queue", async () => {
    const ws = await startWorkspace();
    server.hold.add("turn/steer");
    void ws.sendMessage("second");
    await flush();
    const state = ws.getState();
    const restored = Workspace.fromState(state, localRegistry(), workspaceCallbacks);
    const second = restored.messages.find((m) => m.content === "second")!;
    expect(second).toMatchObject({ status: "queued" });
    expect(second.steering).toBeUndefined();
    expect(restored.cancelQueued(second.id)).toBe(true);
  });

  it("makes a steered message from another session the one its sender waits on once read", async () => {
    const ws = await startWorkspace();
    const [entry] = ws.agents.values();
    const from = { workspaceId: "lead", name: "lead", role: "lead" as const };
    ws.deliver("note", from, "[From the project lead] note");
    await flush();
    const note = ws.messages.find((m) => m.content === "note")!;
    readPromptAndSteer(note.id);
    expect(entry.delivered?.id).toBe(note.id);
    expect(entry.input?.id).toBe(note.id);
  });
});
