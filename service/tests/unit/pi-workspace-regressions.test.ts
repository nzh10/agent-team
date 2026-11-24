import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listNotes, readNote, writeNote } from "../../src/project/notes";
import { PanelHttpServer } from "../../src/session/panel-http";
import { PiSession } from "../../src/session/pi";
import type { Host, HostSessionHandle } from "../../src/session/host";
import { HostRegistry } from "../../src/session/host";
import type {
  PromptEnvelope,
  SendHooks,
  SendReceipt,
  SessionConfig,
  SessionState,
  StreamEvent,
  UsageStats,
} from "../../src/session/types";
import { summarizeEvent, toWireMessage } from "../../src/workspace/summary";
import { Workspace, type Message, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { setupProjects } from "./projectHarness";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class StubSession extends EventEmitter implements HostSessionHandle {
  sessionId: string | null = "sess-1";
  usage: UsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 0,
    duration_ms: 0,
  };
  isRunning = false;
  resetCalled = 0;
  abortCalled = 0;
  sendImpl: (input: string | PromptEnvelope, hooks?: SendHooks) => Promise<SendReceipt> = (
    _input,
    hooks,
  ) => {
    hooks?.onBeforeWrite?.({
      inputId: "in",
      generation: 0,
      beforeLeafId: null,
      beforeEntryCount: 0,
      startedAt: Date.now(),
    });
    return Promise.resolve({ disposition: "started" });
  };
  interruptImpl: () => Promise<boolean> = () => Promise.resolve(true);

  constructor(private readonly config: SessionConfig) {
    super();
  }

  send(input: string | PromptEnvelope, hooks?: SendHooks): Promise<SendReceipt> {
    return this.sendImpl(input, hooks);
  }
  abort(): void {
    this.abortCalled++;
    this.isRunning = false;
  }
  resetContext(): void {
    this.resetCalled++;
    this.sessionId = null;
  }
  interrupt(): Promise<boolean> {
    return this.interruptImpl();
  }
  getState(): SessionState {
    return { sessionId: this.sessionId, config: this.config, usage: this.usage };
  }
}

function makeWorkspace(overrides: Partial<WorkspaceCallbacks> = {}) {
  const dir = tempDir("yaat-w5-ws-");
  const session = new StubSession({ cwd: dir, backend: "pi", model: "mock/model" });
  const host: Host = {
    id: "local",
    label: "local",
    type: "local",
    connected: true,
    getInfo: () => ({ id: "local", label: "local", type: "local", connected: true }),
    createSession: () => session,
    destroySession: () => Promise.resolve(),
    restoreSession: () => session,
  };
  const registry = new HostRegistry();
  registry.register(host);
  const newMsgs: Message[] = [];
  const removed: string[] = [];
  const cb: WorkspaceCallbacks = {
    onNewMessage: (_wsId, msg) => newMsgs.push(msg),
    onStreamEvent: () => undefined,
    onMessageDone: () => undefined,
    onMessageRemoved: (_wsId, msgId) => removed.push(msgId),
    ...overrides,
  };
  const ws = new Workspace("ws-1", "Lead", "proj", "local", dir, registry, cb);
  const agent = ws.addAgent("A", "mock/model", "🤖", "#000", { backend: "pi" });
  const agentMsgs = () => ws.messages.filter((msg) => msg.kind === "agent");
  return { ws, agent, session, newMsgs, removed, dir, registry, agentMsgs };
}

describe("Pi workspace lifecycle regressions", () => {
  it("rolls back in-memory queued message when synchronous save throws", () => {
    let fail = true;
    const { ws, agent, newMsgs } = makeWorkspace({
      onSaveNow: () => {
        if (fail) throw new Error("disk full");
      },
    });
    const beforeCount = newMsgs.length;
    expect(() =>
      ws.ensureReportQueued(
        "rep-msg-1",
        agent.id,
        { inputId: "rep-msg-1", text: "report body", reportId: "rep-1" },
        { workspaceId: "w-1", name: "Worker", role: "worker" },
        "report body",
      ),
    ).toThrow("disk full");
    expect(ws.findMessage("rep-msg-1")).toBeUndefined();
    expect(ws.takeChanged().has("rep-msg-1")).toBe(false);
    expect(newMsgs).toHaveLength(beforeCount);

    fail = false;
    ws.ensureReportQueued(
      "rep-msg-1",
      agent.id,
      { inputId: "rep-msg-1", text: "report body", reportId: "rep-1" },
      { workspaceId: "w-1", name: "Worker", role: "worker" },
      "report body",
    );
    expect(ws.findMessage("rep-msg-1")?.status).toBe("queued");
  });

  function deferSend(session: StubSession) {
    let resolve!: (receipt: SendReceipt) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<SendReceipt>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let beforeWrite: (() => void) | undefined;
    session.sendImpl = (input, hooks) => {
      const envelope = input as PromptEnvelope;
      beforeWrite = () =>
        hooks?.onBeforeWrite?.({
          inputId: envelope.inputId,
          reportId: envelope.reportId,
          generation: 0,
          beforeLeafId: null,
          beforeEntryCount: 0,
          startedAt: Date.now(),
        });
      return promise;
    };
    return { promise, resolve, reject, write: () => beforeWrite!() };
  }

  it.each(["acceptance", "first stream event"])(
    "opens one cold-start reply at %s",
    async (opensAt) => {
      const { ws, agent, session, agentMsgs, registry } = makeWorkspace();
      const turn = deferSend(session);
      const unseen = ws.unseen;
      const sending = ws.sendMessage("cold start");
      const input = ws.messages.find((m) => m.kind === "user")!;
      expect(input.status).toBe("starting");
      expect(input.dispatchAttempt).toBeUndefined();
      expect(ws.cancelQueued(input.id)).toBe(false);
      expect(ws.unseen).toBe(unseen + 1);
      expect(agentMsgs()).toHaveLength(0);
      const restoredStatus = () => {
        const restored = Workspace.fromState(structuredClone(ws.getState()), registry);
        restored.settleStartingOnRestore();
        restored.settlePlainDispatchingOnRestore();
        return restored.findMessage(input.id)!.status;
      };
      expect(restoredStatus()).toBe("error");

      turn.write();
      expect(input.status).toBe("dispatching");
      expect(input.dispatchAttempt?.inputId).toBe(input.id);
      expect(agentMsgs()).toHaveLength(0);
      expect(restoredStatus()).toBe("outcome_unknown");

      session.isRunning = true;
      const text = () => session.emit("event", { kind: "text_delta", content: "answer" });
      const accept = () => session.emit("user_message_accepted", { inputId: input.id });
      if (opensAt === "acceptance") accept();
      else text();
      expect(agentMsgs()).toHaveLength(1);
      if (opensAt === "acceptance") text();
      else accept();
      turn.resolve({ disposition: "started" });
      await sending;
      expect(input.status).toBe("done");
      expect(agentMsgs()).toHaveLength(1);
      expect(ws.unseen).toBe(unseen + 2);
      expect(ws.agents.get(agent.id)?.input?.replies).toEqual([agentMsgs()[0].id]);
      expect(agentMsgs()[0].content).toBe("answer");
    },
  );

  it.each(["handled", "rejected", "retryable"] as const)(
    "never opens an empty reply when Pi returns %s",
    async (kind) => {
      const { ws, session, removed, agentMsgs } = makeWorkspace();
      const turn = deferSend(session);
      const sending = ws.sendMessage("/extension-cmd");
      turn.write();
      turn.resolve(
        kind === "handled"
          ? { disposition: "handled" }
          : {
              disposition: "rejected",
              retryable: kind === "retryable",
              error: "Not accepted",
            },
      );
      await sending;
      expect(removed).toHaveLength(0);
      if (kind === "rejected") {
        expect(agentMsgs()).toHaveLength(1);
        expect(agentMsgs()[0]).toMatchObject({
          status: "error",
          events: [{ kind: "error", content: "[send failed] Not accepted" }],
        });
      } else {
        expect(agentMsgs()).toHaveLength(0);
      }
      const input = ws.messages.find((m) => m.kind === "user")!;
      expect(input.status).toBe(
        kind === "handled" ? "done" : kind === "rejected" ? "error" : "queued",
      );
      if (kind === "retryable") expect(ws.cancelQueued(input.id)).toBe(true);
      expect(ws.isIdle).toBe(true);
    },
  );

  it.each([false, true])(
    "settles send failure without crossing the write boundary (written=%s)",
    async (written) => {
      const { ws, session, agentMsgs } = makeWorkspace();
      const turn = deferSend(session);
      const sending = ws.sendMessage("send fails");
      if (written) turn.write();
      turn.reject(new Error("transport closed"));
      await sending;
      expect(ws.messages.find((m) => m.kind === "user")?.status).toBe(
        written ? "outcome_unknown" : "error",
      );
      expect(agentMsgs()).toHaveLength(written ? 0 : 1);
    },
  );

  it.each(["interrupt", "abort", "remove"] as const)(
    "retires a deferred dispatch on %s without making a reply",
    async (action) => {
      const { ws, agent, session, agentMsgs } = makeWorkspace();
      const turn = deferSend(session);
      const sending = ws.sendMessage("deferred");
      const input = ws.messages.find((m) => m.kind === "user")!;
      session.isRunning = true;
      if (action === "abort") turn.write();
      if (action === "interrupt") await ws.interruptAll();
      else if (action === "abort") ws.abortAll();
      else ws.removeAgent(agent.id);
      expect(input.status).toBe(action === "abort" ? "outcome_unknown" : "error");
      expect(ws.isIdle).toBe(true);
      expect(() => turn.write()).toThrow("Prompt dispatch cancelled");
      turn.reject(new Error("late failure"));
      await sending;
      expect(agentMsgs()).toHaveLength(0);
    },
  );

  it("stops a retry before writing even though it has no new user message", async () => {
    const { ws, agent, session, agentMsgs } = makeWorkspace();
    const first = deferSend(session);
    const sending = ws.sendMessage("retry me");
    first.write();
    session.isRunning = true;
    session.emit("user_message_accepted", {
      inputId: ws.messages.find((m) => m.kind === "user")!.id,
    });
    first.resolve({ disposition: "started" });
    await sending;
    session.isRunning = false;
    session.emit("event", { kind: "result", content: "" });
    ws.pauseAgent(agent.id, Date.now(), true);
    const retry = deferSend(session);
    expect(ws.retryLast(agent.id)).toBe(true);
    session.isRunning = true;
    await ws.interruptAll();
    expect(ws.isIdle).toBe(true);
    expect(() => retry.write()).toThrow("Prompt dispatch cancelled");
    retry.reject(new Error("late failure"));
    await retry.promise.catch(() => undefined);
    expect(agentMsgs()).toHaveLength(1);
  });

  it("keeps pre-write configuration warnings out of a handled command's reply", async () => {
    const { ws, session, agentMsgs } = makeWorkspace();
    const turn = deferSend(session);
    const sending = ws.sendMessage("/extension-cmd");
    session.isRunning = true;
    session.emit("event", { kind: "notice", level: "warning", content: "Effort reset" });
    expect(agentMsgs()).toHaveLength(0);
    expect(ws.messages.at(-1)).toMatchObject({ kind: "system", content: "Effort reset" });
    turn.write();
    session.isRunning = false;
    turn.resolve({ disposition: "handled" });
    await sending;
    expect(agentMsgs()).toHaveLength(0);
    expect(ws.isIdle).toBe(true);
  });

  it("cancels a waiting report and promotes the next queued input before creating a reply", async () => {
    const delivery = vi.fn();
    const onMessageDone = vi.fn();
    const { ws, agent, session, agentMsgs } = makeWorkspace({
      onReportDeliveryState: delivery,
      onMessageDone,
    });
    const first = deferSend(session);
    const sending = ws.sendMessage("first");
    first.write();
    session.isRunning = true;
    session.emit("user_message_accepted", {
      inputId: ws.messages.find((m) => m.kind === "user")!.id,
    });
    first.resolve({ disposition: "started" });
    await sending;
    const report = ws.ensureReportQueued(
      "report",
      agent.id,
      { inputId: "report", text: "report", reportId: "r1" },
      { workspaceId: "worker", name: "Worker", role: "worker" },
      "report",
    );
    expect(report.status).toBe("queued");
    expect(ws.cancelQueued(report.id)).toBe(true);
    expect(ws.findMessage(report.id)).toBeUndefined();
    expect(delivery).toHaveBeenCalledWith("r1", "error", { errorMessage: "Cancelled by user" });
    await ws.sendMessage("next");
    const next = ws.messages.find((m) => m.content === "next")!;
    expect(next.status).toBe("queued");

    const second = deferSend(session);
    session.isRunning = false;
    session.emit("event", { kind: "result", content: "" });
    ws.dequeueNext(agent.id);
    expect(next.status).toBe("starting");
    expect(onMessageDone).toHaveBeenCalledWith(ws.id, next.id, "starting", "next", undefined, {
      queuedFor: agent.id,
      steering: false,
    });
    expect(ws.cancelQueued(next.id)).toBe(false);
    expect(agentMsgs()).toHaveLength(1);
    second.write();
    expect(agentMsgs()).toHaveLength(1);
    second.resolve({ disposition: "handled" });
    await second.promise;
    expect(next.status).toBe("done");
    expect(agentMsgs()).toHaveLength(1);
  });

  it("does not abort a newly started next turn when an older interrupt times out", async () => {
    const { ws, agent, session } = makeWorkspace();
    session.isRunning = true;
    session.interruptImpl = () => {
      // Simulate the old turn retiring and a new turn beginning before interrupt resolves false.
      ws.deliver("next prompt", { workspaceId: "w", name: "W", role: "worker" }, "next prompt");
      const entry = ws.agents.get(agent.id)!;
      entry.input = { id: "new-turn-id", replies: [] };
      entry.currentMsg = {
        id: "new-reply-id",
        kind: "agent",
        agentId: agent.id,
        content: "",
        timestamp: Date.now(),
        status: "streaming",
      };
      session.isRunning = true;
      return Promise.resolve(false);
    };
    const entry = ws.agents.get(agent.id)!;
    entry.input = { id: "old-turn-id", replies: [] };
    entry.currentMsg = {
      id: "old-reply-id",
      kind: "agent",
      agentId: agent.id,
      content: "",
      timestamp: Date.now(),
      status: "streaming",
    };
    await ws.interruptAgent(agent.id);
    expect(session.abortCalled).toBe(0);
  });

  it("clearContext resets PiSession confirmation state, file, and anchors", () => {
    const dir = tempDir("yaat-w5-clear-");
    const pi = PiSession.fromState({
      sessionId: "old-id",
      sessionFile: path.join(dir, "old.jsonl"),
      normalizedCwd: dir,
      expectedLeafAnchorId: "leaf-9",
      minEntryCount: 9,
      hasConfirmedTurns: true,
      config: { cwd: dir, backend: "pi" },
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 1,
        duration_ms: 10,
      },
    });
    cleanups.push(() => pi.dispose());
    pi.resetContext();
    expect(pi.getState()).toMatchObject({
      sessionId: null,
      sessionFile: null,
      hasConfirmedTurns: false,
      expectedLeafAnchorId: null,
      minEntryCount: 0,
    });
  });

  it("PanelHttpServer rejects in-flight POST /call if route is unregistered during body read", async () => {
    const panel = new PanelHttpServer();
    cleanups.push(() => panel.close());
    const { port } = await panel.listen();
    const handler = vi.fn(() => Promise.resolve("should-not-run"));
    const token = panel.registerSession({
      sessionKey: "s1",
      getToolset: () => ({
        instructions: "",
        tools: [{ name: "ping", description: "ping", shape: {}, handler }],
      }),
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/sessions/s1/call",
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      panel["server"].once("request", (incoming) => {
        incoming.once("data", () => {
          panel.unregisterSession("s1");
          req.end('ng","params":{}}');
        });
      });
      req.write('{"name":"pi');
    });
    expect(status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("merges disk status.json sessionFile (with path sessionId) when childRuns omits paths", () => {
    const dir = tempDir("yaat-w5-merge-");
    const sessionFile = path.join(dir, "parent.jsonl");
    const childFile = path.join(dir, "child.jsonl");
    const asyncDir = path.join(dir, "run-1");
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(sessionFile, '{"type":"session","version":3,"id":"p1"}\n');
    fs.writeFileSync(
      childFile,
      '{"type":"session","version":3,"id":"c1"}\n{"type":"message","id":"m1","parentId":null,"message":{"role":"assistant","content":[{"type":"text","text":"DISK_CHILD_TEXT"}]}}\n',
    );
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: "run-1",
        sessionId: sessionFile,
        mode: "workflow",
        state: "completed",
        steps: [{ workflowKey: "task-1", status: "completed", sessionFile: childFile }],
      }),
    );
    const pi = PiSession.fromState({
      sessionId: "p1",
      sessionFile,
      normalizedCwd: dir,
      config: { cwd: dir, backend: "pi" },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
      activeAsyncRuns: [
        {
          runId: "run-1",
          mode: "workflow",
          asyncDir,
          startedAt: Date.now(),
          ownerMessageId: "msg-1",
          toolCallId: "tc-1",
          children: [
            { taskId: "tc-1:0", stepIndex: 0, canonicalChildId: "step:0", status: "running" },
          ],
        },
      ],
    });
    cleanups.push(() => pi.dispose());
    const events: StreamEvent[] = [];
    pi.on("event", (ev: StreamEvent) => events.push(ev));
    (pi as unknown as { handleEvent(e: unknown): void }).handleEvent({
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent-notify",
        details: {
          runId: "run-1",
          status: "completed",
          childRuns: [{ workflowKey: "task-1", status: "completed" }],
        },
      },
    });
    const done = events.find((e) => e.kind === "subagent_done");
    expect(done?.subagent?.events).toEqual([{ kind: "text", content: "DISK_CHILD_TEXT" }]);
  });

  it("rejects a symlinked notes base directory escaping the project", () => {
    const projectDir = tempDir("yaat-w5-proj-");
    const outsideDir = tempDir("yaat-w5-outside-");
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "top-secret");
    const symlinkNotes = path.join(projectDir, "notes");
    fs.symlinkSync(outsideDir, symlinkNotes);

    expect(() => listNotes(symlinkNotes)).toThrow(/symbolic link/i);
    expect(() => readNote(symlinkNotes, "secret")).toThrow(/symbolic link/i);
    expect(() => writeNote(symlinkNotes, "leak", "payload", null)).toThrow(/symbolic link/i);
  });

  it("cancelQueued flushes history before marking journal-backed report cancelled", () => {
    const order: string[] = [];
    const { ws, agent } = makeWorkspace({
      onSaveNow: () => order.push("save"),
      onReportDeliveryState: (reportId, state) => order.push(`journal:${reportId}:${state}`),
    });
    ws.ensureReportQueued(
      "rep-cancel",
      agent.id,
      { inputId: "rep-cancel", text: "body", reportId: "rep-99" },
      { workspaceId: "w-1", name: "Worker", role: "worker" },
      "body",
    );
    order.length = 0;
    expect(ws.cancelQueued("rep-cancel")).toBe(true);
    expect(order).toEqual(["save", "journal:rep-99:error"]);
  });

  it("probeDispatchedReport waits for SSE control connection instead of failing immediately", async () => {
    const panel = new PanelHttpServer();
    cleanups.push(() => panel.close());
    const { baseUrl } = await panel.listen();
    const token = panel.registerSession({ sessionKey: "s-sse", getToolset: () => null });

    const probePromise = panel.probeDispatchedReport("s-sse", null, "rep-1", 2_000);
    // The probe registers its waiter synchronously, before fetch opens the stream.
    expect(panel.isControlConnected("s-sse")).toBe(false);
    const ctrl = new AbortController();
    cleanups.push(() => ctrl.abort());
    const sse = await fetch(`${baseUrl}/v1/sessions/s-sse/control`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes("probe_dispatched_inputs")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
    }
    const line = buf
      .split("\n")
      .find((l) => l.startsWith("data:") && l.includes("probe_dispatched_inputs"))!;
    const msg = JSON.parse(line.slice(5).trim()) as { controlId: string };
    await fetch(`${baseUrl}/v1/sessions/s-sse/control-reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        controlId: msg.controlId,
        result: { found: true, anchorMissing: false, matchedEntryId: "e-1" },
      }),
    });
    await expect(probePromise).resolves.toEqual({
      found: true,
      anchorMissing: false,
      matchedEntryId: "e-1",
    });
  });

  it("preserves cancellable in summary, strips internal wire fields, and blocks sealed ensureFor", async () => {
    const summarized = summarizeEvent({
      kind: "subagent_start",
      content: "",
      subagent: { taskId: "t:0", description: "child", status: "running", cancellable: false },
    });
    expect(summarized.subagent?.cancellable).toBe(false);

    const wire = toWireMessage({
      id: "m1",
      kind: "user",
      agentId: null,
      content: "hi",
      timestamp: 1,
      status: "queued",
      queuedEnvelope: { inputId: "m1", text: "secret prompt" },
      dispatchAttempt: {
        inputId: "m1",
        generation: 0,
        beforeLeafId: null,
        beforeEntryCount: 0,
        startedAt: 1,
      },
    });
    expect("queuedEnvelope" in wire).toBe(false);
    expect("dispatchAttempt" in wire).toBe(false);

    const h = setupProjects();
    const project = h.manager.ensureFor(h.root);
    await h.manager.sealProject(project.id, "done");
    expect(() => h.manager.ensureFor(h.root)).toThrow(/sealed/i);
  });

  it("requeues retryable busy prompt rejections instead of permanently failing reports", async () => {
    vi.useFakeTimers();
    cleanups.push(() => {
      vi.useRealTimers();
    });
    const { ws, session } = makeWorkspace();
    let calls = 0;
    session.sendImpl = (_input, hooks) => {
      calls++;
      hooks?.onBeforeWrite?.({
        inputId: "in",
        generation: 0,
        beforeLeafId: null,
        beforeEntryCount: 0,
        startedAt: Date.now(),
      });
      if (calls === 1) {
        return Promise.resolve({
          disposition: "rejected",
          error: "Agent is already processing. Specify streamingBehavior",
          retryable: true,
        });
      }
      return Promise.resolve({ disposition: "started" });
    };
    await ws.sendMessage("hello");
    const userMsg = ws.getMessages().find((m) => m.kind === "user")!;
    expect(userMsg.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(2);
    expect(userMsg.status).toBe("dispatching");
  });
});
