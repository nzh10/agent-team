import { describe, it, expect, vi } from "vitest";
import { summarizeMessage } from "../../src/workspace/summary";
import { EventEmitter } from "events";
import { Workspace, WorkspaceCallbacks } from "../../src/workspace/workspace";
import { HostRegistry, Host, HostSessionHandle, HostInfo, LocalHost } from "../../src/session/host";
import {
  PromptEnvelope,
  SessionConfig,
  SessionState,
  StreamEvent,
  UsageStats,
} from "../../src/session/types";

const emptyUsage: UsageStats = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  turns: 0,
  duration_ms: 0,
};

// Like ClaudeSession: abort() clears the running flag synchronously.
class FakeSession extends EventEmitter implements HostSessionHandle {
  sessionId: string | null = null;
  usage: UsageStats = { ...emptyUsage };
  isRunning = false;
  sent: string[] = [];
  constructor(private config: SessionConfig) {
    super();
  }
  send(prompt: string | PromptEnvelope): Promise<void> {
    this.sent.push(typeof prompt === "string" ? prompt : prompt.text);
    this.isRunning = true;
    return Promise.resolve();
  }
  abort(): void {
    this.isRunning = false;
  }
  // As ClaudeSession's: never while a turn runs.
  due = false;
  get wakeDue(): boolean {
    return this.due && !this.isRunning;
  }
  pendingWake: { prompt: string; reason: string } | null = null;
  takeWake(): { prompt: string; reason: string } | null {
    const w = this.pendingWake;
    this.pendingWake = null;
    this.due = false;
    return w;
  }
  getState(): SessionState {
    return { sessionId: this.sessionId, config: this.config, usage: this.usage };
  }
}

class FakeHost implements Host {
  readonly id = "local";
  readonly label = "Local";
  readonly type = "local" as const;
  readonly connected = true;
  sessions = new Map<string, FakeSession>();
  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }
  createSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const s = new FakeSession(config);
    this.sessions.set(agentId, s);
    return s;
  }
  replaceSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const old = this.sessions.get(agentId);
    old?.removeAllListeners();
    void this.destroySession(agentId);
    return this.createSession(agentId, config);
  }
  destroySession(agentId: string): Promise<void> {
    this.sessions.get(agentId)?.abort();
    this.sessions.delete(agentId);
    return Promise.resolve();
  }
  restoreSession(agentId: string, state: SessionState): HostSessionHandle {
    return this.createSession(agentId, state.config);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeWorkspace(cb: Partial<WorkspaceCallbacks> = {}) {
  const host = new FakeHost();
  const registry = new HostRegistry();
  registry.register(host);
  const ws = new Workspace("ws-1", "t", "p", "local", "/tmp", registry, {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
    ...cb,
  });
  const agent = ws.addAgent("A", "gpt-5.6-terra", "a", "#888", {
    backend: "codex",
    providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-secret" },
  });
  const session = host.sessions.get(agent.id)!;
  return { ws, host, agent, session };
}

describe("Workspace teardown", () => {
  it("dispose does not start a queued prompt and releases the sessions", async () => {
    const { ws, host, session } = makeWorkspace();
    await ws.sendMessage("running");
    await ws.sendMessage("queued");
    await ws.dispose();
    await tick();
    expect(session.sent).toEqual(["running"]);
    expect(host.sessions.size).toBe(0);
    expect(session.listenerCount("event")).toBe(0);
  });

  it("a real LocalHost forgets the sessions of a disposed workspace", async () => {
    const host = new LocalHost("local", "Local");
    const registry = new HostRegistry();
    registry.register(host);
    const ws = new Workspace("ws-d", "d", "p", "local", "/tmp", registry);
    ws.addAgent("A", "gpt-5.6-terra", "a", "#888", { backend: "codex" });
    await ws.dispose();
    expect((host as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it("removing an agent mid-turn finishes its reply and drops its queue", async () => {
    const done: string[] = [];
    const { ws, agent } = makeWorkspace({
      onMessageDone: (_ws, id, status) => done.push(`${id}:${status}`),
    });
    await ws.sendMessage("go");
    await ws.sendMessage("later");
    const reply = ws.messages.find((m) => m.kind === "agent")!;
    const queued = ws.messages.find((m) => m.status === "queued")!;

    expect(ws.removeAgent(agent.id)).toEqual([queued.id]);
    expect(reply.status).toBe("done");
    expect(done).toContain(`${reply.id}:done`);
    expect(ws.messages.some((m) => m.id === queued.id)).toBe(false);
    expect(ws.isIdle).toBe(true);
    expect(ws.removeAgent(agent.id)).toBeNull();
  });
});

describe("Tool result aggregation invariant", () => {
  it.each(["turn", "subagent"])(
    "folds matched %s tool results without leaving standalone rows",
    async (scope) => {
      const { ws, session } = makeWorkspace();
      try {
        await ws.sendMessage("go");
        const reply = ws.messages.find((m) => m.kind === "agent")!;
        if (scope === "subagent") {
          session.emit("event", {
            kind: "subagent_start",
            content: "",
            subagent: { taskId: "child", status: "running", events: [] },
          });
        }
        const emit = (event: StreamEvent) =>
          session.emit(
            "event",
            scope === "turn"
              ? event
              : {
                  kind: "subagent_progress",
                  content: "",
                  subagent: { taskId: "child", _innerEvent: event },
                },
          );
        for (const id of ["first", "second"]) {
          emit({ kind: "tool_use", content: "**Read** `file.ts`", toolUseId: id });
        }
        for (const id of ["second", "first"]) {
          emit({
            kind: "tool_result",
            content: id,
            toolUseId: id,
            isError: true,
            isMarkdown: true,
            durationMs: 17,
          });
        }
        const events =
          scope === "turn"
            ? reply.events
            : reply.events?.find((e) => e.kind === "subagent_start")?.subagent?.events;
        expect(events).toMatchObject(
          ["first", "second"].map((id) => ({
            kind: "tool_use",
            toolUseId: id,
            toolResult: id,
            toolResultIsError: true,
            toolResultIsMarkdown: true,
            durationMs: 17,
          })),
        );
      } finally {
        await ws.dispose();
      }
    },
  );
});

describe("Streaming timers", () => {
  it("snapshots the active timer but never the live thinking text", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { ws, session } = makeWorkspace();
      await ws.sendMessage("go");
      const reply = ws.messages.find((m) => m.kind === "agent")!;
      expect(summarizeMessage(reply).waitingSince).toBe(1_000);

      clock.mockReturnValue(8_000);
      session.emit("event", { kind: "thinking_delta", content: "draft", startedAt: 7_500 });
      session.emit("event", { kind: "thinking_delta", content: " more" });
      const midThinking = summarizeMessage(reply);
      expect(midThinking.liveThinkingSince).toBe(7_500);
      expect(midThinking.waitingSince).toBeUndefined();
      expect(JSON.stringify(midThinking)).not.toContain("draft");
      expect(JSON.stringify(ws.getState())).not.toContain("liveThinkingSince");

      session.emit("event", { kind: "thinking", content: "finished", durationMs: 500 });
      session.emit("event", { kind: "tool_use", content: "Read", toolUseId: "read" });
      expect(reply.liveThinkingSince).toBeUndefined();
      expect(reply.waitingSince).toBeUndefined();
      clock.mockReturnValue(10_000);
      session.emit("event", { kind: "tool_result", content: "OK", toolUseId: "read" });
      expect(summarizeMessage(reply).waitingSince).toBe(10_000);
      expect(JSON.stringify(ws.getState())).not.toContain("waitingSince");

      session.emit("event", { kind: "result", content: "" });
      expect(reply.liveThinkingSince).toBeUndefined();
      expect(reply.waitingSince).toBeUndefined();
      expect(reply.events).toContainEqual(
        expect.objectContaining({ kind: "thinking", durationMs: 500 }),
      );
    } finally {
      clock.mockRestore();
    }
  });
});

describe("Workspace model switching", () => {
  const models = [
    {
      id: "gpt-5.6-terra",
      label: "Terra",
      backend: "codex" as const,
      effortLevels: ["high", "low"],
    },
    { id: "demo/model", label: "Demo", backend: "pi" as const, effortLevels: ["low"] },
  ];

  it("lists both backends and replaces the session in place before the first turn", async () => {
    const onAgentUpdated = vi.fn();
    const { ws, host, agent, session } = makeWorkspace({
      modelOptions: () => models,
      onAgentUpdated,
    });
    expect(ws.getInfo().agents[0].canSwitchBackend).toBe(true);
    await ws.sendMessage("/model");
    expect(ws.messages.at(-1)?.content).toContain("`demo/model`");

    await ws.sendMessage("/model demo/model");
    const replacement = host.sessions.get(agent.id)!;
    expect(replacement).not.toBe(session);
    expect(session.listenerCount("event")).toBe(0);
    expect(replacement.getState().config).toMatchObject({
      cwd: "/tmp",
      model: "demo/model",
      backend: "pi",
    });
    expect(onAgentUpdated).toHaveBeenLastCalledWith(
      ws.id,
      expect.objectContaining({
        id: agent.id,
        model: "demo/model",
        name: "A",
        avatar: "a",
        color: "#888",
        isDefault: true,
        canSwitchBackend: true,
      }),
    );
    await ws.sendMessage("/model gpt-5.6-terra");
    expect(host.sessions.get(agent.id)?.getState().config.backend).toBe("codex");
  });

  it("does not let a model switch overtake the first prompt", async () => {
    const { ws, agent, session, host } = makeWorkspace({ modelOptions: () => models });
    const sending = ws.sendMessage("first prompt");
    const switching = ws.sendMessage("/model demo/model");
    await Promise.all([sending, switching]);
    expect(session.sent).toEqual(["first prompt"]);
    expect(host.sessions.get(agent.id)).toBe(session);
    expect(ws.messages.at(-1)?.content).toContain("cannot move");
  });

  it.each([
    {
      prompt: "/model",
      reply: "**A** runs on **Terra** (`gpt-5.6-terra`).\nAvailable: **gpt-5.6-terra**",
      empty: true,
    },
    { prompt: "hello", reply: "Hi there.", empty: false },
  ])("recognizes pre-upgrade history after '$prompt'", async ({ prompt, reply, empty }) => {
    const { ws, host, agent } = makeWorkspace();
    const state = ws.getState();
    state.messages!.push(
      { id: "user", kind: "user", agentId: null, content: prompt, status: "done", timestamp: 1 },
      {
        id: "reply",
        kind: "agent",
        agentId: agent.id,
        turnId: "turn-legacy",
        content: reply,
        status: "done",
        timestamp: 2,
        events: [],
      },
    );
    const registry = new HostRegistry();
    registry.register(host);
    const restored = Workspace.fromState(state, registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      modelOptions: () => models,
    });
    expect(restored.getInfo().agents[0].canSwitchBackend).toBe(empty);
    await restored.sendMessage("/model demo/model");
    expect(host.sessions.get(agent.id)?.getState().config.backend).toBe(empty ? "pi" : "codex");
  });

  it("rebinds panel tools on a replacement managed by LocalHost", async () => {
    const host = new LocalHost("local", "Local");
    const registry = new HostRegistry();
    registry.register(host);
    const tools = { instructions: "Project instructions", tools: [] };
    const onSessionReplaced = vi.fn((_ws: Workspace, session: HostSessionHandle) => {
      session.setPanelTools?.(tools);
    });
    const ws = new Workspace("ws-p", "p", "p", "local", "/tmp", registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      modelOptions: () => models,
      onSessionReplaced,
    });
    ws.projectLink = { projectId: "proj", role: "lead" };
    const agent = ws.addAgent(
      "A",
      "gpt-5.6-terra",
      "a",
      "#888",
      {
        backend: "codex",
        effort: "low",
      },
      "account",
    );
    const original = ws.agents.get(agent.id)!.session;
    const disposed = vi.spyOn(original, "dispose");
    try {
      await ws.sendMessage("/model demo/model");
      const replacement = ws.agents.get(agent.id)!.session;
      expect(disposed).toHaveBeenCalledOnce();
      expect(original.listenerCount("event")).toBe(0);
      expect(replacement.getState().config.effort).toBe("low");
      expect(ws.agents.get(agent.id)?.info.account).toBe("account");
      expect(ws.projectLink).toEqual({ projectId: "proj", role: "lead" });
      expect(onSessionReplaced).toHaveBeenCalledWith(ws, replacement);
      const replacementDisposed = vi.spyOn(replacement, "dispose");
      await ws.dispose();
      expect(replacementDisposed).toHaveBeenCalledOnce();
    } finally {
      await host.close();
    }
  });

  it("does not leave the backend while busy, with a persisted session ID, or after a turn", async () => {
    const { ws, host, agent, session } = makeWorkspace({ modelOptions: () => models });
    const refuses = async () => {
      expect(ws.getInfo().agents[0].canSwitchBackend).toBe(false);
      await ws.sendMessage("/model demo/model");
      expect(ws.messages.at(-1)?.content).toContain("cannot move");
      expect(host.sessions.get(agent.id)).toBe(session);
    };
    session.isRunning = true;
    await refuses();
    session.isRunning = false;
    session.sessionId = "existing";
    await refuses();
    session.sessionId = null;
    await ws.sendMessage("go");
    session.emit("event", { kind: "text_delta", content: "done" });
    session.emit("event", { kind: "result", content: "" });
    session.isRunning = false;
    ws.clearContext(agent.id);
    await refuses();
  });
});

describe("Workspace persistence", () => {
  it("never writes account tokens into the state", () => {
    const { ws } = makeWorkspace();
    expect(JSON.stringify(ws.getState())).not.toContain("sk-secret");
  });

  it("background-task churn is reported as transient", () => {
    const updates: Array<boolean | undefined> = [];
    const { session } = makeWorkspace({
      onAgentUpdated: (_ws, _agent, transient) => updates.push(transient),
    });
    session.emit("backgroundTasks", []);
    expect(updates).toEqual([true]);
  });

  it("a reply cut off by a restart is marked interrupted, and orphaned queue entries go", () => {
    const registry = new HostRegistry();
    registry.register(new FakeHost());
    const agent = {
      id: "agent-1",
      name: "A",
      model: "gpt-5.6-terra",
      avatar: "a",
      color: "#888",
      isDefault: true,
      session: {
        sessionId: null,
        config: { cwd: "/tmp", backend: "codex" as const },
        usage: emptyUsage,
      },
    };
    const ws = Workspace.fromState(
      {
        id: "ws-r",
        name: "r",
        project: "p",
        hostId: "local",
        cwd: "/tmp",
        createdAt: 1,
        agents: [agent],
        messages: [
          { id: "u", kind: "user", agentId: null, content: "go", timestamp: 2, status: "done" },
          {
            id: "r",
            kind: "agent",
            agentId: "agent-1",
            content: "half",
            timestamp: 3,
            status: "streaming",
          },
          {
            id: "q1",
            kind: "user",
            agentId: null,
            content: "next",
            timestamp: 4,
            status: "queued",
            queuedFor: "agent-1",
          },
          {
            id: "q2",
            kind: "user",
            agentId: null,
            content: "lost",
            timestamp: 5,
            status: "queued",
            queuedFor: "agent-gone",
          },
        ],
      },
      registry,
    );
    const reply = ws.messages.find((m) => m.id === "r")!;
    expect(reply.status).toBe("done");
    expect(reply.content).toBe("half\n\n*\\[interrupted\\]*");
    expect(ws.messages.map((m) => m.id)).toEqual(["u", "r", "q1"]);
  });
});

describe("Workspace wake-ups", () => {
  it("sends a wake-up the backend let pass once the agent is free, after its queue", async () => {
    const { ws, session } = makeWorkspace();
    const finish = async () => {
      session.isRunning = false;
      session.emit("event", { kind: "result", content: "" });
      await tick();
    };
    await ws.sendMessage("first");
    await ws.sendMessage("queued");
    session.pendingWake = { prompt: "Check the runs.", reason: "runs" };
    session.due = true;
    session.emit("wakeDue");
    await tick();
    expect(session.sent).toEqual(["first"]);
    await finish();
    expect(session.sent).toEqual(["first", "queued"]);
    await finish();
    expect(session.sent).toEqual(["first", "queued", "Check the runs."]);
    const reply = ws.messages.at(-1)!;
    expect(reply.kind).toBe("agent");
    expect(reply.events?.[0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(ws.messages.filter((m) => m.kind === "user").map((m) => m.content)).toEqual([
      "first",
      "queued",
    ]);
  });

  it("holds a due wake-up while the queue is paused, and sends it once the pause ends", async () => {
    const { ws, agent, session } = makeWorkspace();
    ws.pauseAgent(agent.id, Date.now() + 60_000);
    session.pendingWake = { prompt: "Check the runs.", reason: "runs" };
    session.due = true;
    session.emit("wakeDue");
    await tick();
    expect(session.sent).toEqual([]);
    ws.endPause(agent.id);
    await tick();
    expect(session.sent).toEqual(["Check the runs."]);
  });

  it("a pending rate-limit retry goes before a due wake-up", async () => {
    const { ws, agent, session } = makeWorkspace();
    await ws.sendMessage("first");
    session.isRunning = false;
    session.emit("event", { kind: "error", content: "Usage limit reached (session)." });
    await tick();
    ws.pauseAgent(agent.id, Date.now() - 1, true);
    session.pendingWake = { prompt: "Check the runs.", reason: "runs" };
    session.due = true;
    session.emit("wakeDue");
    await tick();
    expect(session.sent).toEqual(["first"]);
    expect(ws.retryLast(agent.id)).toBe(true);
    expect(session.sent).toEqual(["first", "first"]);
    session.isRunning = false;
    session.emit("event", { kind: "result", content: "" });
    await tick();
    expect(session.sent).toEqual(["first", "first", "Check the runs."]);
  });
});
