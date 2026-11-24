import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelHttpServer, type PanelReadyReport } from "../../src/session/panel-http";
import { PiRpcClient, type PiRpcSpawnOptions } from "../../src/session/pi-rpc";
import { HostRegistry, LocalHost } from "../../src/session/host";
import { Workspace, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { closeHistory, loadAll, saveIndex, saveWorkspace } from "../../src/workspace/state";
import { PiSession, type PiSessionOptions } from "../../src/session/pi";
import type {
  ActiveAsyncRunRecord,
  ExtensionUiEvent,
  SessionConfig,
  SessionState,
  StreamEvent,
} from "../../src/session/types";

import { piFrame, piFrames, piReply } from "../snap/pi-wire";

type Frame = { id: string; type: string; [key: string]: unknown };
const dirs: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function config(dir: string): SessionConfig {
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ packages: [] }));
  return {
    cwd: dir,
    backend: "pi",
    uploadsDir: dir,
    piAgentDir: home,
    piSessionDir: path.join(dir, "sessions"),
    workspaceId: "workspace",
    agentId: "agent",
  };
}

function harness(
  override: {
    config?: Partial<SessionConfig>;
    options?: Partial<PiSessionOptions>;
    ready?: (ready: PanelReadyReport) => void;
    state?: (config: SessionConfig) => SessionState;
    disposition?: string;
    delayedQuota?: boolean;
    holdPromptReply?: boolean;
    enabledModels?: string[];
    models?: Array<{
      provider: string;
      id: string;
      reasoning?: boolean;
      thinkingLevelMap?: Partial<Record<string, string | null>>;
    }>;
  } = {},
) {
  const dir = temp();
  const cfg = { ...config(dir), ...override.config };
  if (override.enabledModels)
    fs.writeFileSync(
      path.join(cfg.piAgentDir!, "settings.json"),
      JSON.stringify({ packages: [], enabledModels: override.enabledModels }),
    );
  const state = override.state?.(cfg);
  const panel = new PanelHttpServer();
  cleanup.push(() => panel.close());
  const register = vi.spyOn(panel, "registerSession");
  const clients: {
    rpc: PiRpcClient;
    wire: Frame[];
    event: (frame: object) => void;
    respond: (frame: Frame, data?: unknown, success?: boolean) => void;
    end: ReturnType<typeof vi.fn>;
  }[] = [];
  const order: string[] = [];
  let disposition = override.disposition ?? "started";
  const factory = vi.fn((opts: PiRpcSpawnOptions) => {
    expect(register).toHaveBeenCalledTimes(clients.length + 1);
    expect(opts.env?.YAAT_PANEL_TOKEN).toMatch(/^[a-f\d]{64}$/);
    const sessionFile = opts.args?.includes("--session")
      ? opts.args[opts.args.indexOf("--session") + 1]
      : path.join(dir, "session.jsonl");
    const sessionHeader = opts.args?.includes("--session")
      ? (JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]) as {
          id: string;
          cwd?: string;
        })
      : undefined;
    const sessionId = opts.args?.includes("--session-id")
      ? opts.args[opts.args.indexOf("--session-id") + 1]
      : sessionHeader!.id;
    const proofState = state ?? session.getState();
    const ready: PanelReadyReport = {
      sessionProof: {
        sessionId: sessionId ?? null,
        sessionFile: sessionFile ?? null,
        cwd: fs.realpathSync.native(proofState.normalizedCwd ?? proofState.config.cwd),
        headerCwd: sessionHeader?.cwd ?? dir,
        entryCount: proofState.minEntryCount ?? 0,
        leafId: proofState.expectedLeafAnchorId ?? null,
        anchorOnActiveBranch: true,
        anchorExistsInFile: true,
      },
      ownerToolNames: ["write_note"],
      requiredExtensionsRegistered: true,
      subagentsRpcReady: true,
      subagentsSessionId: sessionId ?? null,
    };
    override.ready?.(ready);
    const headers = {
      authorization: `Bearer ${opts.env?.YAAT_PANEL_TOKEN ?? ""}`,
      "content-type": "application/json",
    };
    const endpoint = `${opts.env?.YAAT_PANEL_URL ?? ""}/v1/sessions/${opts.env?.YAAT_PANEL_KEY ?? ""}`;
    const bridgeReady = fetch(`${endpoint}/toolset`, { headers })
      .then(async (response) => {
        if (!response.ok) throw new Error(`bridge toolset fetch failed: ${response.status}`);
        await response.text();
        return fetch(`${endpoint}/ready`, { method: "POST", headers, body: JSON.stringify(ready) });
      })
      .then(async (response) => {
        if (!response.ok) throw new Error(`bridge ready failed: ${response.status}`);
        await response.text();
      });
    cleanup.push(() => bridgeReady);
    const stdout = new PassThrough();
    const wire: Frame[] = [];
    const event = (frame: object) => stdout.write(JSON.stringify(frame) + "\n");
    const respond = (frame: Frame, data?: unknown, success = true) =>
      event({
        ...piReply(frame.type),
        command: frame.type,
        id: frame.id,
        success,
        data,
        ...(!success && { error: "preflight denied" }),
      });
    const stdin = new Writable({
      write(chunk: Buffer, _, callback) {
        const frame = JSON.parse(chunk.toString()) as Frame;
        wire.push(frame);
        switch (frame.type) {
          case "get_state":
            respond(frame, {
              sessionId,
              sessionFile,
              thinkingLevel: "low",
              model: { provider: "mock", id: "test" },
            });
            break;
          case "get_available_models":
            respond(frame, {
              models: override.models ?? [{ provider: "mock", id: "test", contextWindow: 100 }],
            });
            break;
          case "get_available_thinking_levels":
            respond(frame, { levels: ["low", "high"] });
            break;
          case "get_commands":
            respond(frame, { commands: [{ name: "skill:test", source: "skill" }] });
            break;
          case "compact":
          case "steer":
            break;
          case "prompt":
            order.push("write");
            if (override.holdPromptReply) break;
            if (override.delayedQuota && frame.message === "/quota")
              setTimeout(() => respond(frame, { disposition }), 31_000);
            else respond(frame, { disposition }, disposition !== "rejected");
            break;
          case "get_session_stats":
            respond(frame, {
              tokens: { input: 99, output: 7 },
              cost: 3,
              contextUsage: { tokens: null, contextWindow: 100 },
            });
            break;
          default:
            respond(frame);
            break;
        }
        callback();
      },
    });
    const end = vi.fn(() => stdout.end());
    stdin.on("finish", end);
    const rpc = new PiRpcClient({ stdin, stdout }, { requestTimeoutMs: 800 });
    clients.push({ rpc, event, wire, respond, end });
    return rpc;
  });
  const options = {
    panelHttp: panel,
    rpcFactory: factory,
    readyTimeoutMs: 500,
    ...override.options,
  };
  const session = state ? PiSession.fromState(state, options) : new PiSession(cfg, options);
  cleanup.push(() => session.dispose());
  const events: StreamEvent[] = [];
  session.on("event", (event: StreamEvent) => events.push(event));
  const done = vi.fn();
  session.on("done", done);
  return {
    dir,
    cfg,
    state,
    session,
    panel,
    register,
    factory,
    clients,
    events,
    done,
    order,
    setDisposition: (value: string) => {
      disposition = value;
    },
  };
}

function saved(cfg: SessionConfig, runs: ActiveAsyncRunRecord[] = []): SessionState {
  const session = new PiSession(cfg);
  const state = { ...session.getState(), sessionId: "saved", activeAsyncRuns: runs };
  cleanup.push(() => session.dispose());
  return state;
}

function confirmed(cfg: SessionConfig): SessionState {
  const file = path.join(cfg.cwd, "saved.jsonl");
  writeSession(file, "saved", cfg.cwd, [
    conversationEntry("one", null, "user", "first"),
    conversationEntry("two", "one", "assistant", "reply"),
    conversationEntry("three", "two", "user", "next"),
    conversationEntry("anchor", "three", "assistant", "reply"),
  ]);
  return {
    ...saved(cfg),
    sessionFile: file,
    expectedLeafAnchorId: "anchor",
    minEntryCount: 4,
    hasConfirmedTurns: true,
  };
}

function assistantUpdate(type: string, contentIndex: number, fields: Record<string, unknown> = {}) {
  return {
    ...piFrame("message_update"),
    assistantMessageEvent: { type, contentIndex, ...fields },
  };
}

function assistantStart() {
  return piFrame("message_start", { role: "assistant" });
}

function assistantEnd(content: Array<Record<string, unknown>>, stopReason = "stop") {
  const frame = piFrame("message_end", { role: "assistant" });
  return { ...frame, message: { ...frame.message, content, stopReason } };
}

function workspaceFor(h: ReturnType<typeof harness>, callbacks: Partial<WorkspaceCallbacks>) {
  const registry = new HostRegistry();
  const host = new LocalHost("local", "Local");
  vi.spyOn(host, "createSession").mockReturnValue(h.session);
  registry.register(host);
  const ws = new Workspace("ws", "test", "project", "local", h.dir, registry, {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
    ...callbacks,
  });
  return { ws, registry };
}

function conversationEntry(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    message: {
      role,
      content: role === "assistant" ? [{ type: "text", text }] : text,
    },
  };
}

function writeSession(
  file: string,
  sessionId: string,
  cwd: string,
  entries: Array<Record<string, unknown>>,
  tail = "",
) {
  const records = [{ type: "session", version: 3, id: sessionId, cwd }, ...entries];
  fs.writeFileSync(file, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n${tail}`);
}

function anchored(cfg: SessionConfig): SessionState {
  const file = path.join(cfg.cwd, "anchored.jsonl");
  writeSession(file, "saved", cfg.cwd, [conversationEntry("input", null, "user", "first")]);
  return {
    ...saved(cfg),
    sessionFile: file,
    expectedLeafAnchorId: "input",
    minEntryCount: 1,
    hasUnanchoredInput: false,
    persistedSessionAnchor: {
      sessionFile: file,
      sessionId: "saved",
      leafId: "input",
      entryCount: 1,
    },
  };
}

describe("Pi boundary steering", () => {
  async function setup() {
    const h = harness();
    const claim = vi.fn(() => true);
    const finish = vi.fn();
    const source = vi.fn(() => ({ envelope: { text: "follow", inputId: "B" }, claim, finish }));
    h.session.setBoundarySteerSource(source);
    await h.session.send("first");
    const client = h.clients[0];
    const boundary = (open = () => true) => h.register.mock.calls[0][0].onSteerBoundary!(open);
    client.event(piFrame("agent_start"));
    client.event(piFrame("message_end", { role: "user" }));
    const write = () =>
      vi.waitFor(() => {
        const frame = client.wire.find((item) => item.type === "steer");
        expect(frame).toBeDefined();
        return frame!;
      });
    return { ...h, client, boundary, write, claim, finish, source };
  }

  it("never writes after the boundary expires during the durable claim", async () => {
    const h = await setup();
    let open = true;
    h.claim.mockImplementation(() => {
      open = false;
      return true;
    });
    await h.boundary(() => open);
    expect(h.finish.mock.calls).toEqual([["rejected"]]);
    expect(h.client.wire.some((frame) => frame.type === "steer")).toBe(false);
  });

  it("treats a malformed reply after write as unknown, never a rejection", async () => {
    const h = await setup();
    const handoff = h.boundary();
    const frame = await h.write();
    // Drop the acknowledgement payload after the real write. Without proof of
    // rejection this input must not be sent a second time.
    const broken = piReply("steer");
    delete broken.data;
    delete broken.success;
    h.client.event({ ...broken, id: frame.id });
    await handoff;
    expect(h.finish.mock.calls).toEqual([["outcome_unknown"]]);
  });

  it("keeps the matched input across another user message and assigns end-only output to its reply", async () => {
    const h = await setup();
    const handoff = h.boundary();
    const frame = await h.write();
    h.client.event({ ...piReply("steer"), id: frame.id });
    await handoff;
    let owner = "A";
    const replies: Record<string, string> = { A: "initial", B: "" };
    h.finish.mockImplementation(() => {
      owner = "B";
    });
    h.session.on("event", (event: StreamEvent) => {
      if (event.kind === "text_delta") replies[owner] += event.content;
    });
    const user = piFrame("message_end", { role: "user" });
    for (const text of [frame.message, "another input"])
      h.client.event({ ...user, message: { ...user.message, content: [{ type: "text", text }] } });
    h.client.event(piFrame("message_update", { update: "text_end" }));
    expect(replies).toEqual({ A: "initial", B: "xxxxx" });
    expect(h.finish.mock.calls).toEqual([["read"]]);
  });

  it("resets a delayed thinking offset when the steered input is read", async () => {
    const h = await setup();
    const c = h.client;
    c.event(assistantStart());
    c.event(assistantUpdate("text_delta", 0, { delta: "before" }));
    const handoff = h.boundary();
    const frame = await h.write();
    c.respond(frame, { disposition: "queued" });
    await handoff;
    const user = piFrame("message_end", { role: "user" });
    c.event({
      ...user,
      message: { ...user.message, content: [{ type: "text", text: frame.message }] },
    });
    c.event(assistantStart());
    c.event(assistantUpdate("thinking_start", 0));
    // The start belongs to the new reply, but only its first nonempty delta
    // proves that Pi read the steer and splits the panel message.
    c.event(assistantUpdate("thinking_delta", 0, { delta: "plan" }));
    c.event(assistantUpdate("text_start", 1));
    c.event(assistantUpdate("text_delta", 1, { delta: "after" }));
    c.event(assistantUpdate("thinking_end", 0, { content: "plan" }));
    c.event(assistantUpdate("text_end", 1, { content: "after" }));
    expect(h.finish).toHaveBeenCalledExactlyOnceWith("read");
    expect(h.events.filter((event) => event.kind === "thinking")).toEqual([
      expect.objectContaining({ content: "plan", contentOffset: 0 }),
    ]);
  });

  it.each(["read", "interrupted", "crash", "rejected", "handled"])(
    "settles a claimed steer as %s without clearing Pi's queue",
    async (outcome) => {
      const h = await setup();
      expect(h.claim).not.toHaveBeenCalled();
      const handoff = h.boundary();
      const frame = await h.write();
      expect(h.claim).toHaveBeenCalledTimes(1);
      h.client.respond(
        frame,
        { disposition: outcome === "handled" ? "handled" : "queued" },
        outcome !== "rejected",
      );
      await handoff;
      if (outcome === "crash") h.client.rpc.emit("exit", 1, null);
      else {
        h.client.event({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: frame.message }] },
        });
        if (outcome === "read" || outcome === "interrupted")
          expect(h.finish).not.toHaveBeenCalled();
        const interrupted = outcome === "interrupted" ? h.session.interrupt() : undefined;
        h.client.event({
          type: "message_end",
          message: { role: "assistant", stopReason: interrupted ? "aborted" : "stop", content: [] },
        });
        h.client.event({ type: "agent_settled" });
        await interrupted;
      }
      const expected = ["interrupted", "crash"].includes(outcome) ? "outcome_unknown" : outcome;
      expect(h.finish.mock.calls).toEqual([[expected]]);
      expect(h.client.wire.some((frame) => frame.type === "clear_queue")).toBe(false);
    },
  );
});

describe("PiSession dispatch and stream state", () => {
  it("allows a slow quota command to finish without retiring Pi", async () => {
    const h = harness({ delayedQuota: true, disposition: "handled" });
    await h.session.ensureStarted();
    vi.useFakeTimers();
    try {
      const cmd = h.session.send("/quota");
      await vi.advanceTimersByTimeAsync(31_001);
      expect(await cmd).toEqual({ disposition: "handled" });
      await h.session.send("/handled");
      expect(h.factory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["/compact", "/compact Keep\ndecisions"])(
    "runs %s as a standalone command and checkpoints the new leaf",
    async (command) => {
      const h = harness({ state: confirmed });
      vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
      vi.spyOn(h.panel, "requestSessionCheckpoint").mockResolvedValue({
        sessionId: "saved",
        sessionFile: h.state!.sessionFile!,
        leafId: "compaction",
        entryCount: 5,
      });
      await h.session.ensureStarted();
      const c = h.clients[0];
      const pending = h.session.send(command);
      await vi.waitFor(() => expect(c.wire.at(-1)?.type).toBe("compact"));
      const frame = c.wire.at(-1)!;
      expect(frame.customInstructions).toBe(command === "/compact" ? undefined : "Keep\ndecisions");
      await expect(h.session.send("next")).rejects.toThrow(/busy/);
      c.event({ type: "compaction_start", reason: "manual" });
      const result = { summary: "Summary", firstKeptEntryId: "kept", tokensBefore: 1234 };
      c.event({
        type: "compaction_end",
        reason: "manual",
        result,
        aborted: false,
        willRetry: false,
      });
      c.respond(frame, result);
      await expect(pending).resolves.toEqual({ disposition: "handled" });
      expect(h.session.getState()).toMatchObject({
        expectedLeafAnchorId: "compaction",
        minEntryCount: 5,
      });
      expect(h.done).toHaveBeenCalledTimes(1);
      expect(h.events.map((e) => e.content)).toContain("Context compacted (manual): 1234 tokens");
      expect(h.session.isRunning).toBe(false);
    },
  );

  it("refuses compact with attachments before dispatch", async () => {
    const h = harness();
    fs.writeFileSync(path.join(h.dir, "a.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const before = vi.fn();
    await expect(
      h.session.send(
        { inputId: "img", text: "/compact", attachmentIds: ["a.png"] },
        { onBeforeWrite: before },
      ),
    ).rejects.toThrow(/attachments/);
    expect(before).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("settles an interrupted workspace command even when the compact RPC rejects after its end event", async () => {
    const h = harness();
    const { ws } = workspaceFor(h, {});
    const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
    const pending = ws.sendMessage("/compact", agent.id);
    await vi.waitFor(() => expect(h.clients[0]?.wire.at(-1)?.type).toBe("compact"));
    const c = h.clients[0];
    const frame = c.wire.at(-1)!;
    c.event({ type: "compaction_start", reason: "manual" });
    const stop = h.session.interrupt();
    await vi.waitFor(() => expect(c.wire.at(-1)?.type).toBe("abort"));
    c.event({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false });
    c.respond(frame, undefined, false);
    expect(await stop).toBe(true);
    await pending;
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(
      ws
        .getMessages()
        .filter((m) => m.kind !== "system")
        .map((m) => m.status),
    ).toEqual(["done", "done"]);
    expect(
      ws
        .getMessages()
        .at(-1)
        ?.events?.map((e) => e.content),
    ).toContain("Compaction aborted (manual)");
  });

  it("replays the failed empty-session compact from Pi 1.6.0 without leaving a running turn", async () => {
    const h = harness();
    await h.session.ensureStarted();
    const c = h.clients[0];
    const pending = h.session.send("/compact");
    await vi.waitFor(() => expect(c.wire.at(-1)?.type).toBe("compact"));
    for (const line of fs
      .readFileSync(path.join(__dirname, "fixtures/pi-compact-empty.jsonl"), "utf8")
      .trim()
      .split("\n")) {
      const frame = JSON.parse(line) as Frame;
      c.event(frame.id ? { ...frame, id: c.wire.at(-1)!.id } : frame);
    }
    await expect(pending).resolves.toEqual({ disposition: "handled" });
    expect(h.events.filter((e) => e.kind === "error")).toEqual([
      { kind: "error", content: "Compaction failed: Nothing to compact (session too small)" },
    ]);
    expect(h.session.isRunning).toBe(false);
  });

  it("uses the post-compaction leaf for the next dispatch even when its checkpoint arrives late", async () => {
    const h = harness({ state: confirmed });
    await h.session.send("first");
    const c = h.clients[0];
    let release!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => ({
      sessionId: "saved",
      sessionFile: h.state!.sessionFile!,
      entryCount: 8,
      leafId: "compaction",
    }));
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    vi.spyOn(h.panel, "requestSessionCheckpoint").mockReturnValue(checkpoint);
    for (const line of fs
      .readFileSync(path.join(__dirname, "fixtures/pi-compact-overflow.jsonl"), "utf8")
      .trim()
      .split("\n")) {
      c.event(JSON.parse(line) as Frame);
    }
    expect(h.events.map((e) => e.content)).toContain(
      "Context compacted (overflow): 5002 → ~2209 tokens",
    );
    expect(h.done).toHaveBeenCalledTimes(1);
    const hook = vi.fn();
    const next = h.session.send("next", { onBeforeWrite: hook });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hook).not.toHaveBeenCalled();
    release();
    await next;
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ beforeLeafId: "compaction", beforeEntryCount: 8 }),
    );
  });

  it("does not write past an unverified compaction until the checkpoint succeeds", async () => {
    const h = harness({ state: confirmed });
    await h.session.ensureStarted();
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    const checkpoint = vi
      .spyOn(h.panel, "requestSessionCheckpoint")
      .mockRejectedValue(new Error("control unavailable"));
    h.clients[0].event({
      type: "compaction_end",
      reason: "manual",
      result: { tokensBefore: 500 },
      aborted: false,
      willRetry: false,
    });
    const hook = vi.fn();
    await expect(h.session.send("next", { onBeforeWrite: hook })).resolves.toMatchObject({
      disposition: "rejected",
      retryable: true,
    });
    expect(hook).not.toHaveBeenCalled();
    checkpoint.mockResolvedValue({
      sessionId: "saved",
      sessionFile: h.state!.sessionFile!,
      entryCount: 7,
      leafId: "compacted",
    });
    await expect(h.session.send("next", { onBeforeWrite: hook })).resolves.toEqual({
      disposition: "started",
    });
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ beforeLeafId: "compacted" }));
  });

  it("surfaces out-of-turn compactions without creating an agent turn", async () => {
    const h = harness();
    await h.session.ensureStarted();
    const c = h.clients[0];
    c.event({ type: "compaction_start", reason: "threshold" });
    await expect(h.session.send("/compact")).resolves.toMatchObject({
      disposition: "rejected",
      retryable: true,
    });
    c.event({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
    c.event({
      type: "compaction_end",
      reason: "overflow",
      errorMessage: "Overflow recovery failed",
      aborted: false,
      willRetry: false,
    });
    expect(h.events.map((e) => e.content)).toEqual([
      "Compacting context (threshold)",
      "Compaction aborted (threshold)",
      "Overflow recovery failed",
    ]);
    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.isRunning).toBe(false);
  });
  it.each([["mock/model-*"], ["*"]])(
    "filters RPC models by enabledModels %j without conflating thinking levels",
    async (enabledModels) => {
      const h = harness({
        enabledModels: [enabledModels],
        models: [
          { provider: "mock", id: "model-x" },
          { provider: "other", id: "nested/name" },
        ],
      });
      await h.session.ensureStarted();
      expect(h.session.getAvailableModels().map((model) => model.id)).toEqual(
        enabledModels === "*" ? ["mock/model-x", "other/nested/name"] : ["mock/model-x"],
      );
      expect(h.session.getAvailableThinkingLevels()).toEqual(["low", "high"]);
    },
  );

  it("discovers levels from each model's metadata, not the catalog session level list", async () => {
    const models = [
      { id: "plain", reasoning: false },
      { id: "basic", reasoning: true },
      { id: "restricted", reasoning: true, thinkingLevelMap: { off: null, minimal: null } },
      {
        id: "extended",
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "extra", max: "max" },
      },
    ];
    const h = harness({ models: models.map((model) => ({ ...model, provider: "mock" })) });
    await h.session.ensureStarted();
    expect(h.session.getAvailableModels().map((m) => m.effortLevels)).toEqual([
      ["off"],
      ["off", "minimal", "low", "medium", "high"],
      ["low", "medium", "high"],
      ["minimal", "low", "medium", "high", "xhigh", "max"],
    ]);
  });

  it("restores a persistently claimed steer as unknown and drains only the next FIFO input", async () => {
    const h = harness();
    const { ws } = workspaceFor(h, { onSaveNow: () => saveWorkspace(h.dir, ws.getState()) });
    cleanup.push(() => closeHistory(h.dir));
    const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
    saveIndex(h.dir, [ws.id]);
    await ws.sendMessage("first", agent.id);
    const client = h.clients[0];
    client.event({ type: "agent_start" });
    client.event({ type: "message_end", message: { role: "user" } });
    ws.deliver(
      "lead follow",
      { role: "lead", name: "Lead", workspaceId: "lead" },
      "[From the lead] follow",
    );
    await ws.sendMessage("next", agent.id);
    const boundary = h.register.mock.calls[0][0].onSteerBoundary!(() => true);
    const frame = await vi.waitFor(() => {
      const steer = client.wire.find((item) => item.type === "steer");
      expect(steer?.message).toContain("[From the lead] follow");
      return steer!;
    });
    client.respond(frame, { disposition: "queued" });
    await boundary;
    const persisted = loadAll(h.dir)[0];
    expect(persisted.messages?.find((msg) => msg.content === "lead follow")?.status).toBe(
      "dispatching",
    );
    const fresh = harness();
    const registry = new HostRegistry();
    const host = new LocalHost("local", "Local");
    vi.spyOn(host, "restoreSession").mockReturnValue(fresh.session);
    registry.register(host);
    const restored = Workspace.fromState(persisted, registry);
    restored.settlePlainDispatchingOnRestore();
    restored.dequeueNext(agent.id);
    await vi.waitFor(() =>
      expect(
        fresh.clients[0]?.wire.filter((item) => item.type === "prompt").map((item) => item.message),
      ).toEqual(["next"]),
    );
    expect(restored.getMessages().find((msg) => msg.content === "lead follow")?.status).toBe(
      "outcome_unknown",
    );
    client.event({ type: "agent_settled" });
    await ws.dispose();
    await restored.dispose();
  });

  it("discards the old preset before starting the first turn on the new model", async () => {
    const h = harness({ config: { model: "mock/extended" } });
    const { ws } = workspaceFor(h, {
      modelOptions: () => [
        { id: "mock/extended", label: "Extended", backend: "pi", effortLevels: ["high", "xhigh"] },
        { id: "mock/test", label: "Test", backend: "pi", effortLevels: ["low", "high"] },
      ],
    });
    const a = ws.addAgent("Pi", "mock/extended", "", "", { backend: "pi" });
    expect(ws.getInfo().agents[0].effortLevels).toEqual(["high", "xhigh"]);
    await ws.sendMessage("/effort", a.id);
    expect(ws.getMessages().at(-1)?.content).toContain("Available: `high` · `xhigh`");
    await ws.sendMessage("/effort xhigh", a.id);
    expect(ws.getInfo().agents[0].effort).toBe("xhigh");
    await ws.sendMessage("/model mock/test", a.id);
    expect(ws.getInfo().agents[0].effortLevels).toEqual(["low", "high"]);
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.session.getState().config.effort).toBeUndefined();
    const levels = vi.fn();
    h.session.on("thinking_levels", levels);
    await h.session.send("hello");
    expect(levels).toHaveBeenCalledTimes(1);
    expect(h.session.getAvailableThinkingLevels("mock/extended")).toBeUndefined();
    expect(h.clients[0].wire.filter((f) => f.type === "set_thinking_level")).toEqual([]);
    expect(h.events.filter((e) => e.level === "warning")).toEqual([]);
  });

  it.each(["startup", "idle"])(
    "publishes and persists a rejected %s preset without a turn",
    async (when) => {
      const effort = when === "startup" ? "max" : undefined;
      const h = harness({ config: { model: "mock/test", effort } });
      const persisted = vi.fn();
      const { ws, registry } = workspaceFor(h, {
        onAgentUpdated: (_id, agent, transient) => {
          if (transient) return;
          persisted(agent.effort);
          saveWorkspace(h.dir, ws.getState());
        },
      });
      cleanup.push(() => closeHistory(h.dir));
      ws.addAgent("Pi", "mock/test", "", "", { backend: "pi", effort });
      saveIndex(h.dir, [ws.id]);
      saveWorkspace(h.dir, ws.getState());
      await h.session.ensureStarted();
      if (when === "idle") {
        expect(persisted).not.toHaveBeenCalled();
        h.session.setEffort("max");
      }
      await vi.waitFor(() => expect(persisted).toHaveBeenCalledExactlyOnceWith(null));
      const restored = Workspace.fromState(loadAll(h.dir)[0], registry);
      cleanup.push(() => restored.dispose());
      expect(restored.getInfo().agents[0].effort).toBeNull();
      expect(h.events).toContainEqual(
        expect.objectContaining({
          level: "warning",
          content: "mock/test has no effort max; using low.",
        }),
      );
      expect(h.session.getState().config.effort).toBeUndefined();
      expect(h.session.effectiveEffort).toBe("low");
      expect(h.clients[0].wire.filter((f) => f.type === "set_thinking_level")).toEqual([]);
    },
  );

  it("reports an unknown outcome when a started prompt loses its Pi process before acceptance", async () => {
    const h = harness();
    const unknown = vi.fn();
    h.session.on("prompt_outcome_unknown", unknown);
    await expect(h.session.send({ inputId: "started", text: "prompt" })).resolves.toMatchObject({
      disposition: "started",
    });
    h.clients[0].rpc.emit("exit", 1, null);
    expect(unknown).toHaveBeenCalledTimes(1);
    expect(unknown.mock.calls[0][0]).toMatchObject({
      inputId: "started",
      reason: "Pi process exited (1)",
    });
    expect(h.session.isRunning).toBe(false);
  });

  it("locks synchronously, captures before the real stdin write, and separates receipts from settlement", async () => {
    const h = harness({ disposition: "rejected", config: { model: "mock/test", effort: "high" } });
    const s = h.session;
    const accepted = vi.fn();
    s.on("user_message_accepted", accepted);
    const commands = vi.fn();
    s.on("commands", commands);
    const before = vi.fn(() => {
      h.order.push("hook");
      expect(s.sessionId).toBeTruthy();
    });
    expect(s.canSteer).toBe(false);
    const first = s.send({ text: "hello", inputId: "first" }, { onBeforeWrite: before });
    expect(s.isRunning).toBe(true);
    expect(s.runState).toBe("working");
    await expect(s.send("concurrent")).rejects.toThrow(/busy/);
    await expect(first).resolves.toEqual({ disposition: "rejected", error: "preflight denied" });
    expect(h.order).toEqual(["hook", "write"]);
    expect(before).toHaveBeenCalledWith(
      expect.objectContaining({
        inputId: "first",
        beforeLeafId: null,
        beforeEntryCount: 0,
        generation: 0,
      }),
    );
    expect(commands).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "skill:test" })]),
    );
    expect(s.getAvailableThinkingLevels()).toEqual(["low", "high"]);
    expect(s.effectiveEffort).toBe("high");
    expect(s.runState).toBe("idle");
    h.setDisposition("handled");
    await expect(s.send("/handled")).resolves.toEqual({ disposition: "handled" });
    expect(s.runState).toBe("idle");
    expect(s.getState().hasConfirmedTurns).toBe(false);
    h.setDisposition("started");
    await expect(
      s.send({ text: "started", inputId: "third", reportId: "report" }),
    ).resolves.toEqual({ disposition: "started" });
    const { event } = h.clients[0];
    event({ type: "agent_start" });
    for (let i = 0; i < 2; i++) event({ type: "message_end", message: { role: "user" } });
    expect(accepted.mock.calls).toEqual([
      [{ inputId: "third", reportId: "report", generation: 0 }],
    ]);
    event({ type: "agent_end", willRetry: true });
    expect(s.isRunning).toBe(true);
    expect(h.done).not.toHaveBeenCalled();
    event({ type: "agent_settled" });
    event({ type: "agent_settled" });
    expect(s.runState).toBe("idle");
    expect(s.getState().hasConfirmedTurns).toBe(true);
    expect(h.done).toHaveBeenCalledTimes(1);
    event({ type: "agent_start" });
    expect(s.isRunning).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ kind: "notice", level: "wakeup" });
    event({ type: "agent_settled" });
    expect(h.done).toHaveBeenCalledTimes(2);
  });

  it("clears a finally failed retry and emits its final error once", async () => {
    const h = harness();
    await h.session.send("work");
    const { event } = h.clients[0];
    for (const frame of piFrames("messages/retry-failed"))
      if (frame.type !== "response") event(frame);
    expect(h.events.filter((e) => e.kind === "retry" || e.kind === "error")).toEqual([
      { kind: "retry", content: "Retrying (1/2 in 1s): 503 fixture service unavailable" },
      { kind: "retry", content: "Retrying (2/2 in 2s): 503 fixture service unavailable" },
      { kind: "retry", content: "" },
      { kind: "error", content: "503 final failure" },
    ]);
    expect(h.done).toHaveBeenCalledTimes(1);
  });

  it("starts a top-level session with no Panel tools even from a nested Pi shell", async () => {
    const nested = [
      "PI_SUBAGENT_CHILD",
      "PI_SUBAGENT_PARENT_SESSION",
      "PI_SUBAGENT_RUNNER_PID",
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
    ];
    for (const name of nested) vi.stubEnv(name, "inherited");
    const { session, factory } = harness();
    await session.ensureStarted();
    for (const name of nested) expect(factory.mock.calls[0][0].env).not.toHaveProperty(name);
    const spawn = factory.mock.calls[0][0];
    const headers = {
      authorization: `Bearer ${spawn.env?.YAAT_PANEL_TOKEN ?? ""}`,
      "content-type": "application/json",
    };
    const endpoint = `${spawn.env?.YAAT_PANEL_URL ?? ""}/v1/sessions/${spawn.env?.YAAT_PANEL_KEY ?? ""}`;
    const toolset = await fetch(`${endpoint}/toolset`, { headers });
    expect(toolset.status).toBe(200);
    expect(await toolset.json()).toMatchObject({ tools: [], instructions: "" });
    const call = await fetch(`${endpoint}/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "write_note", params: {} }),
    });
    expect(call.status).toBe(403);
    await call.text();
  });

  it.each([
    ["single", { agent: "A", task: "one" }, 1],
    ["parallel", { tasks: [{ agent: "A" }, { agent: "B" }] }, 2],
    ["chain", { chain: [{ agent: "A" }, { agent: "B" }] }, 2],
    ["workflow", { workflow: true }, 1],
    ["management", { action: "status" }, 0],
  ] as const)(
    "formats and tracks %s tool calls without inventing background runs",
    async (mode, args, count) => {
      const { session, clients, events } = harness();
      await session.send("work");
      const { event } = clients[0];
      event({ type: "agent_start" });
      event({ type: "tool_execution_start", toolName: "subagent", toolCallId: "call", args });
      event({
        type: "tool_execution_end",
        toolName: "subagent",
        toolCallId: "call",
        result: { details: { mode, results: [] } },
      });
      expect(events.filter((entry) => entry.kind === "subagent_start")).toHaveLength(count);
      expect(events.filter((entry) => entry.kind === "subagent_done")).toHaveLength(count);
      event({ type: "agent_settled" });
      expect(session.runState).toBe("idle");
    },
  );

  it("projects resolved foreground execution by child index, not launch overrides or plugin metadata", async () => {
    const { session, clients, events } = harness();
    await session.send("work");
    const { event } = clients[0];
    event({ type: "agent_start" });
    event({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "call",
      args: { tasks: [{ agent: "A", model: "requested", thinking: "low" }, { agent: "B" }] },
    });
    for (const start of events.filter((entry) => entry.kind === "subagent_start")) {
      expect(start.subagent).not.toHaveProperty("model");
      expect(start.subagent).not.toHaveProperty("effort");
    }
    event({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "call",
      result: {
        details: {
          results: [
            { index: 1, model: "provider/b", thinking: "off" },
            {
              index: 0,
              model: "provider/a",
              thinking: "high",
              progressSummary: { durationMs: 321 },
              requestedModel: "requested",
              worktree: true,
              toolCalls: [{ name: "read" }],
            },
          ],
        },
      },
    });
    const done = events
      .filter((entry) => entry.kind === "subagent_done")
      .map((entry) => entry.subagent!);
    expect(done).toMatchObject([
      { taskId: "call:0", model: "provider/a", effort: "high" },
      { taskId: "call:1", model: "provider/b", effort: "off" },
    ]);
    expect(done[0].durationMs).toBe(321);
    for (const key of ["thinking", "requestedModel", "worktree", "toolCalls", "index"]) {
      expect(done[0]).not.toHaveProperty(key);
    }
    event({ type: "agent_settled" });
  });

  it("does not publish pending async model candidates and updates running cards after observation", async () => {
    const { session, clients, events, dir } = harness();
    await session.send("work");
    const { event } = clients[0];
    const writeStatus = (state: string, step: Record<string, unknown>) =>
      fs.writeFileSync(
        path.join(dir, "status.json"),
        JSON.stringify({
          runId: "observed",
          sessionId: session.sessionId,
          state,
          steps: [step],
        }),
      );
    writeStatus("running", { status: "pending", model: "p/candidate", thinking: "low" });
    event({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "call",
      args: { agent: "Scout", async: true },
    });
    event({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "call",
      result: { details: { asyncDir: dir, runId: "observed" } },
    });
    const progress = () => events.filter((ev) => ev.kind === "subagent_progress");
    await session.reconcileAsyncRuns();
    expect(progress()).toEqual([]);
    writeStatus("running", {
      status: "running",
      model: "p/candidate",
      resolvedModel: { provider: "p", model: "observed" },
      thinking: "high",
      lastActivityAt: 5,
    });
    await session.reconcileAsyncRuns();
    await session.reconcileAsyncRuns();
    expect(progress()).toHaveLength(1);
    expect(progress()[0].subagent).toEqual({
      taskId: "call:0",
      description: "",
      status: "running",
      cancellable: true,
      model: "p/observed",
      effort: "high",
    });
    event({ type: "agent_settled" });
    const saved = session.getState();
    expect(saved.activeAsyncRuns?.[0].children[0].execution).toEqual({
      model: "p/observed",
      effort: "high",
    });
    writeStatus("completed", { status: "completed", model: "p/candidate" });
    const restored = harness({ state: () => saved });
    await restored.session.reconcileAsyncRuns();
    expect(restored.events.find((ev) => ev.kind === "subagent_done")?.subagent).toMatchObject({
      model: "p/observed",
      effort: "high",
    });
  });

  it("uses observed wire execution without status files and ignores queued siblings' candidates", async () => {
    const { session, clients, events, dir } = harness();
    await session.send("work");
    const { event } = clients[0];
    event({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "call",
      args: { tasks: [{ agent: "A" }, { agent: "B" }], async: true },
    });
    event({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "call",
      result: { details: { asyncDir: dir, runId: "wire" } },
    });
    event({
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent-notify",
        details: {
          runId: "wire",
          status: "failed",
          children: [
            {
              status: "completed",
              model: "p/candidate",
              resolvedModel: { provider: "p", model: "wire" },
              thinking: "high",
            },
            { status: "queued", model: "p/never-ran", thinking: "low" },
          ],
        },
      },
    });
    const done = events.filter((ev) => ev.kind === "subagent_done").map((ev) => ev.subagent);
    expect(done).toMatchObject([
      { taskId: "call:0", status: "completed", model: "p/wire", effort: "high" },
      { taskId: "call:1", status: "failed" },
    ]);
    expect(done[1]).not.toHaveProperty("model");
    expect(done[1]).not.toHaveProperty("effort");
    event({ type: "agent_settled" });
  });

  it("enforces MIME, missing files, and the aggregate 12 MiB raw budget before dispatch", async () => {
    const { dir, session, factory, clients } = harness();
    const before = vi.fn();
    const png = Buffer.alloc(6 * 1024 * 1024);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    fs.writeFileSync(path.join(dir, "a.png"), png);
    fs.writeFileSync(path.join(dir, "b.png"), Buffer.concat([png, Buffer.alloc(1)]));
    fs.writeFileSync(path.join(dir, "unsafe.svg"), "<svg/>");
    fs.writeFileSync(path.join(dir, "fake.png"), "not a PNG");
    const send = (attachmentIds: string[]) =>
      session.send({ inputId: "img", text: "", attachmentIds }, { onBeforeWrite: before });
    await expect(send(["unsafe.svg"])).rejects.toThrow(/MIME/);
    await expect(send(["fake.png"])).rejects.toThrow(/MIME/);
    await expect(send(["missing.png"])).rejects.toThrow(/ENOENT/);
    await expect(send(["a.png", "b.png"])).rejects.toThrow(/12 MiB/);
    expect(before).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(session.runState).toBe("idle");
    await expect(send(["uploads/a.png", "a.png"])).resolves.toEqual({ disposition: "started" });
    expect(before).toHaveBeenCalledTimes(1);
    expect(
      clients[0].wire.find((frame) => frame.type === "prompt")?.images as unknown[],
    ).toHaveLength(2);
  });

  it("does not reopen a completed foreground card for an unrelated async notice", async () => {
    const h = harness();
    await h.session.send("work");
    const { event } = h.clients[0];
    for (const frame of piFrames("pi-subagents-foreground").filter((f) =>
      ["agent_start", "tool_execution_start", "tool_execution_end"].includes(f.type),
    ))
      event(frame);
    const cards = () =>
      h.events.filter((e) => e.kind === "subagent_start" || e.kind === "subagent_done");
    const before = cards();
    expect(before.filter((e) => e.kind === "subagent_done")).toHaveLength(2);
    event(
      piFrames("pi-subagents-async").find(
        (f) => f.type === "message_start" && f.message?.customType === "subagent-notify",
      )!,
    );
    expect(cards()).toEqual(before);
  });

  it("times thinking even when no intermediate deltas arrive", async () => {
    const { session, clients, events } = harness();
    await session.send("stream");
    const { event } = clients[0];
    event(piFrame("agent_start"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(10000);
    event(piFrame("message_update", { update: "thinking_start" }));
    clock.mockReturnValue(17000);
    event(piFrame("message_update", { update: "thinking_end" }));
    expect(events.map((e) => [e.kind, e.startedAt, e.durationMs])).toEqual([
      ["thinking_delta", 10000, undefined],
      ["thinking_delta", undefined, 7000],
      ["thinking", undefined, 7000],
    ]);
  });

  it("places delayed openai-completions thinking before text and freezes its duration", async () => {
    const { session, clients, events } = harness();
    await session.send("stream");
    const { event } = clients[0];
    event({ type: "agent_start" });
    event(assistantStart());
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    event(assistantUpdate("thinking_start", 0));
    clock.mockReturnValue(1_500);
    event(assistantUpdate("thinking_delta", 0, { delta: "plan" }));
    clock.mockReturnValue(2_000);
    event(assistantUpdate("text_start", 1));
    clock.mockReturnValue(3_000);
    event(assistantUpdate("text_delta", 1, { delta: "Answer" }));
    clock.mockReturnValue(4_000);
    event(assistantUpdate("thinking_delta", 0, { delta: "late" }));
    clock.mockReturnValue(9_000);
    event(assistantUpdate("thinking_end", 0, { content: "plan" }));
    clock.mockReturnValue(10_000);
    event(assistantUpdate("text_end", 1, { content: "Answer" }));
    expect(events.find((entry) => entry.kind === "thinking")).toMatchObject({
      content: "plan",
      contentOffset: 0,
      durationMs: 1_000,
    });
    expect(events.filter((entry) => entry.kind === "thinking_delta").at(-1)).toMatchObject({
      content: "",
      durationMs: 1_000,
    });
  });

  it("places message-end-only thinking before already streamed text", async () => {
    const { session, clients, events } = harness();
    await session.send("stream");
    const { event } = clients[0];
    event({ type: "agent_start" });
    event(assistantStart());
    event(assistantUpdate("text_delta", 1, { delta: "Answer" }));
    event(
      assistantEnd([
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Answer" },
      ]),
    );
    expect(events.find((entry) => entry.kind === "thinking")).toMatchObject({
      content: "plan",
      contentOffset: 0,
    });
  });

  it("bases a later assistant message's thinking offset after earlier reply text", async () => {
    const { session, clients, events } = harness();
    await session.send("stream");
    const { event } = clients[0];
    const first = "First.";
    event({ type: "agent_start" });
    event(assistantStart());
    event(assistantUpdate("text_delta", 0, { delta: "Fir" }));
    event(assistantUpdate("text_end", 0, { content: first }));
    event(assistantUpdate("toolcall_start", 1, { id: "call-1", toolName: "read" }));
    event(
      assistantUpdate("toolcall_end", 1, {
        toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      }),
    );
    event({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: {},
    });
    event({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [], details: {} },
    });
    event(
      assistantEnd(
        [
          { type: "text", text: first },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ],
        "toolUse",
      ),
    );
    event(assistantStart());
    event(assistantUpdate("thinking_start", 0));
    event(assistantUpdate("thinking_delta", 0, { delta: "next plan" }));
    event(assistantUpdate("text_start", 1));
    event(assistantUpdate("text_delta", 1, { delta: "Second" }));
    event(assistantUpdate("thinking_end", 0, { content: "next plan" }));
    event(assistantUpdate("text_end", 1, { content: "Second" }));
    expect(events.find((entry) => entry.kind === "thinking")).toMatchObject({
      content: "next plan",
      contentOffset: first.length,
    });
  });

  it("keeps early thinking_end duration and ordering unchanged", async () => {
    const { session, clients, events } = harness();
    await session.send("stream");
    const { event } = clients[0];
    event({ type: "agent_start" });
    event(assistantStart());
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    event(assistantUpdate("thinking_start", 0));
    clock.mockReturnValue(1_700);
    event(assistantUpdate("thinking_end", 0, { content: "plan" }));
    clock.mockReturnValue(2_000);
    event(assistantUpdate("text_start", 1));
    event(assistantUpdate("text_delta", 1, { delta: "Answer" }));
    expect(events.find((entry) => entry.kind === "thinking")).toMatchObject({
      contentOffset: 0,
      durationMs: 700,
    });
  });

  it("preserves delayed thinking offsets through Workspace aggregation", async () => {
    const h = harness();
    const { ws } = workspaceFor(h, {});
    const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
    await ws.sendMessage("stream", agent.id);
    const { event } = h.clients[0];
    event({ type: "agent_start" });
    event(assistantStart());
    event(assistantUpdate("thinking_start", 0));
    event(assistantUpdate("thinking_delta", 0, { delta: "plan" }));
    event(assistantUpdate("text_start", 1));
    event(assistantUpdate("text_delta", 1, { delta: "Answer" }));
    event(assistantUpdate("toolcall_start", 2, { id: "call-1", toolName: "read" }));
    event({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: {},
    });
    event(assistantUpdate("thinking_end", 0, { content: "plan" }));
    event(assistantUpdate("text_end", 1, { content: "Answer" }));
    event(
      assistantUpdate("toolcall_end", 2, {
        toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      }),
    );
    event({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [], details: {} },
    });
    event(
      assistantEnd([
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Answer" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ]),
    );
    event({ type: "agent_settled" });
    const reply = ws.getMessages().find((msg) => msg.kind === "agent");
    expect(reply).toMatchObject({ content: "Answer", status: "done" });
    expect(
      reply?.events?.map((entry) => ({
        kind: entry.kind,
        contentOffset: entry.contentOffset,
      })),
    ).toEqual([
      { kind: "tool_use", contentOffset: 6 },
      { kind: "thinking", contentOffset: 0 },
    ]);
  });

  it("recovers authoritative end-only output and replaces provisional usage with stats", async () => {
    const { session, clients, events } = harness();
    await session.send("stream");
    const { event } = clients[0];
    event({ type: "agent_start" });
    const orphan = piFrame("tool_execution_end");
    event(orphan); // Drop start and all deltas, not the authoritative closing frames.
    event(piFrame("message_end", { role: "assistant" }));
    event(piFrame("agent_settled"));
    const result = events.find(
      (e) => e.kind === "tool_result" && e.toolUseId === orphan.toolCallId,
    );
    expect(result).toBeDefined();
    expect(result?.durationMs).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      kind: "result",
      content: "xxxxx",
      context: { tokens: 412, window: 100 },
    });
    expect(session.usage.input_tokens).toBe(412);
    await vi.waitFor(() => expect(session.usage.input_tokens).toBe(99));
    expect(await session.getContextUsage()).toBeNull();
    expect(await session.getUsageInfo()).toMatchObject({ cost: 3, tokens: { output: 7 } });
  });

  it("decodes real Pi 1.6 session_start extension UI frames without opening or answering a dialog", async () => {
    const { session, clients } = harness();
    await session.send("extension UI");
    const events = vi.fn<(e: ExtensionUiEvent) => void>(),
      unhandled = vi.fn<(e: Frame) => void>();
    session.on("extension_ui", events);
    session.on("unhandled", unhandled);
    const frames = fs
      .readFileSync(path.join(__dirname, "fixtures/pi-1.6-extension-ui.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Frame);
    for (const frame of frames) clients[0].event(frame);
    expect(events.mock.calls.map(([event]) => event.change)).toEqual([
      { kind: "notify", level: "info", message: "hello", id: frames[0].id },
      { kind: "notify", level: "warning", message: "warning", id: frames[1].id },
      { kind: "status", key: "progress", text: "ready" },
      {
        kind: "widget",
        key: "panel",
        placement: "aboveEditor",
        lines: ["<b>not HTML</b>", "line two"],
      },
      { kind: "widget", key: "panel", placement: "belowEditor", lines: ["moved"] },
      { kind: "status", key: "progress" },
      { kind: "widget", key: "panel", placement: "aboveEditor" },
    ]);
    expect(events.mock.calls[0][0]).toMatchObject({
      workspaceId: "workspace",
      agentId: "agent",
      processGeneration: 0,
    });
    expect(unhandled.mock.calls.map(([frame]) => frame.method)).toEqual([
      "setTitle",
      "set_editor_text",
    ]);
    expect(session.pendingUiDialogs).toEqual([]);
    expect(clients[0].wire.some((frame) => frame.type === "extension_ui_response")).toBe(false);
  });

  it.each(["reset", "exit", "dispose"])(
    "bounds live state and releases the retired generation on %s",
    async (end) => {
      const h = harness();
      const unhandled = vi.fn();
      const { ws } = workspaceFor(h, { onUnhandled: unhandled });
      const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
      await h.session.ensureStarted();
      const c = h.clients[0];
      const send = (method: string, fields: object) =>
        c.event({ type: "extension_ui_request", method, id: "ui", ...fields });
      for (let i = 0; i < 25; i++) {
        send("setStatus", { statusKey: `s${i}`, statusText: "x".repeat(255) + "🐈" });
        send("setWidget", {
          widgetKey: `w${i}`,
          widgetLines: Array<string>(20).fill("x".repeat(300)),
        });
      }
      send("setStatus", { statusKey: "s20", statusText: "" }); // Pi clears only on undefined.
      const [snapshot] = ws.getExtensionUi();
      expect(snapshot).toMatchObject({
        workspaceId: ws.id,
        agentId: agent.id,
        processGeneration: 0,
      });
      expect(snapshot.statuses).toHaveLength(16);
      expect(snapshot.statuses[0]).toEqual({ key: "s9", text: "x".repeat(255) });
      expect(snapshot.statuses.at(-1)).toEqual({ key: "s20", text: "" });
      expect(snapshot.widgets).toHaveLength(8);
      expect(snapshot.widgets[0]).toMatchObject({
        key: "w17",
        lines: Array<string>(12).fill("x".repeat(256)),
      });
      for (const [method, fields] of [
        ["futureMethod", {}],
        ["setStatus", { statusKey: "x".repeat(129) }],
        ["setStatus", { statusKey: "s20", statusText: null }],
        ["setWidget", { widgetKey: "w17", widgetLines: 42 }],
        ["setWidget", { widgetKey: "w17", widgetLines: [42] }],
        ["notify", { message: 42 }],
        ["select", { id: null }],
      ] as const)
        send(method, fields);
      expect(ws.getExtensionUi()).toEqual([snapshot]);
      expect(unhandled).toHaveBeenCalledTimes(7);
      send("setWidget", { widgetKey: "w17", widgetLines: [42, "valid"] });
      expect(ws.getExtensionUi()[0].widgets.at(-1)?.lines).toEqual(["valid"]);
      expect(unhandled).toHaveBeenCalledTimes(8);
      expect(c.wire.some((frame) => frame.type === "extension_ui_response")).toBe(false);
      if (end === "reset") h.session.resetContext();
      else if (end === "exit") c.rpc.emit("exit", 1, null);
      else await h.session.dispose();
      send("setStatus", { statusKey: "late", statusText: "obsolete" });
      expect(ws.getExtensionUi()).toEqual([
        { workspaceId: ws.id, agentId: agent.id, processGeneration: 1, statuses: [], widgets: [] },
      ]);
      ws.removeAgent(agent.id);
      expect(ws.getExtensionUi()).toEqual([]);
    },
  );

  it("services the RPC stream during dialogs, consumes valid answers once, and cancels on timeout and interrupt", async () => {
    const { session, clients } = harness({ options: { dialogFallbackTimeoutMs: 25 } });
    await session.send("dialog");
    const { event, wire } = clients[0];
    const resolved = vi.fn();
    session.on("ui_dialog_resolved", resolved);
    event({
      type: "extension_ui_request",
      id: "confirm",
      method: "confirm",
      title: "Permission",
      timeout: 1000,
    });
    event({ type: "extension_ui_request", id: "expires", method: "input", title: "Input" });
    expect(session.pendingUiDialogs).toHaveLength(2);
    await expect(clients[0].rpc.getState()).resolves.toMatchObject({
      sessionId: session.sessionId,
    });
    session.respondToUiDialog("confirm", { requestId: "confirm", confirmed: false });
    session.respondToUiDialog("confirm", { requestId: "confirm", confirmed: true });
    await vi.waitFor(() => expect(session.pendingUiDialogs).toHaveLength(0));
    expect(wire.filter((frame) => frame.type === "extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: "confirm", confirmed: false },
      { type: "extension_ui_response", id: "expires", cancelled: true },
    ]);
    expect(resolved).toHaveBeenCalledTimes(2);
    event({ type: "extension_ui_request", id: "abort", method: "editor", timeout: 1000 });
    const interrupted = session.interrupt();
    event({ type: "agent_settled", aborted: true });
    await expect(interrupted).resolves.toBe(true);
    expect(wire).toContainEqual({ type: "extension_ui_response", id: "abort", cancelled: true });
    expect(wire.some((frame) => frame.type === "clear_queue")).toBe(false);
  });
});

describe("PiSession persisted first-input anchor", () => {
  it("treats a startup cut before write as never written", async () => {
    const h = harness();
    await h.session.ensureStarted();
    const state = h.session.getState();
    expect(state.hasUnanchoredInput).toBe(false);
    expect(state.persistedSessionAnchor).toBeUndefined();

    const restored = harness({ state: () => state });
    await restored.session.ensureStarted();
    const args = restored.factory.mock.calls[0][0].args ?? [];
    expect(args).toContain("--session-dir");
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--session");
  });

  it("rolls back the write claim when the pre-write snapshot hook throws", async () => {
    const h = harness();
    await expect(
      h.session.send("never written", {
        onBeforeWrite: () => {
          throw new Error("pre-write save failed");
        },
      }),
    ).rejects.toThrow("pre-write save failed");
    expect(h.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
    expect(h.session.getState().hasUnanchoredInput).toBe(false);

    const restored = harness({ state: () => h.session.getState() });
    await restored.session.ensureStarted();
    expect(restored.factory.mock.calls[0][0].args).toContain("--session-dir");
    expect(restored.factory.mock.calls[0][0].args).not.toContain("--session");
  });

  it("fails an after-write cut without a file as ambiguous instead of starting blank", async () => {
    const h = harness({ options: { anchorTimeoutMs: 25, anchorPollIntervalMs: 2 } });
    await h.session.send({ inputId: "claimed", text: "first" });
    const state = h.session.getState();
    expect(state.hasUnanchoredInput).toBe(true);
    expect(state.persistedSessionAnchor).toBeUndefined();
    expect(fs.existsSync(path.join(h.dir, "session.jsonl"))).toBe(false);

    const restored = harness({ state: () => state });
    await expect(restored.session.ensureStarted()).rejects.toThrow(/recovery is ambiguous/);
    expect(restored.factory).not.toHaveBeenCalled();
    expect(restored.clients).toHaveLength(0);
  });

  it("atomically saves durable first-input proof before settle without accepting or resending it", async () => {
    const h = harness({ options: { anchorTimeoutMs: 500, anchorPollIntervalMs: 5 } });
    const { ws } = workspaceFor(h, { onSaveNow: () => saveWorkspace(h.dir, ws.getState()) });
    cleanup.push(() => closeHistory(h.dir));
    const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
    saveIndex(h.dir, [ws.id]);
    saveWorkspace(h.dir, ws.getState());
    await ws.sendMessage("first input", agent.id);
    const file = path.join(h.dir, "session.jsonl");
    writeSession(file, h.session.sessionId!, h.dir, [
      conversationEntry("input", null, "user", "first input"),
    ]);

    let persisted: SessionState | undefined;
    await vi.waitFor(() => {
      persisted = loadAll(h.dir)[0].agents[0].session;
      expect(persisted.persistedSessionAnchor).toEqual({
        sessionFile: fs.realpathSync.native(file),
        sessionId: h.session.sessionId,
        leafId: "input",
        entryCount: 1,
      });
    });
    expect(persisted!.hasUnanchoredInput).toBe(false);
    expect(persisted!.hasConfirmedTurns).toBe(false);
    expect(h.session.isRunning).toBe(true);
    expect(h.done).not.toHaveBeenCalled();
    expect(ws.getMessages().find((msg) => msg.content === "first input")?.status).toBe(
      "dispatching",
    );
    expect(
      h.clients[0].wire.filter((frame) => frame.type === "prompt").map((frame) => frame.message),
    ).toEqual(["first input"]);

    const restored = harness({ state: () => persisted! });
    await restored.session.ensureStarted();
    expect(restored.factory.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(["--session", fs.realpathSync.native(file)]),
    );
    expect(restored.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
  });

  it("proves and saves the anchor at the write boundary before the prompt reply", async () => {
    const h = harness({
      holdPromptReply: true,
      options: { anchorTimeoutMs: 500, anchorPollIntervalMs: 5 },
    });
    const { ws } = workspaceFor(h, { onSaveNow: () => saveWorkspace(h.dir, ws.getState()) });
    cleanup.push(() => closeHistory(h.dir));
    const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
    saveIndex(h.dir, [ws.id]);
    saveWorkspace(h.dir, ws.getState());
    const pending = ws.sendMessage("before reply", agent.id);
    await vi.waitFor(() =>
      expect(h.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(true),
    );
    const file = path.join(h.dir, "session.jsonl");
    writeSession(file, h.session.sessionId!, h.dir, [
      conversationEntry("input", null, "user", "before reply"),
    ]);
    await vi.waitFor(() =>
      expect(loadAll(h.dir)[0].agents[0].session.persistedSessionAnchor).toMatchObject({
        leafId: "input",
        entryCount: 1,
      }),
    );
    expect(h.done).not.toHaveBeenCalled();
    expect(ws.getMessages().find((msg) => msg.content === "before reply")?.status).toBe(
      "dispatching",
    );
    const prompt = h.clients[0].wire.find((frame) => frame.type === "prompt")!;
    h.clients[0].respond(prompt, { disposition: "started" });
    await pending;
    expect(h.clients[0].wire.filter((frame) => frame.type === "prompt")).toHaveLength(1);
  });

  it("retries the atomic snapshot commit after an anchor-save failure", async () => {
    const h = harness({
      holdPromptReply: true,
      options: { anchorTimeoutMs: 500, anchorPollIntervalMs: 5 },
    });
    let failNextAnchorSave = true;
    const { ws } = workspaceFor(h, {
      onSaveNow: () => {
        if (failNextAnchorSave && h.session.getState().persistedSessionAnchor) {
          failNextAnchorSave = false;
          throw new Error("snapshot write failed");
        }
        saveWorkspace(h.dir, ws.getState());
      },
    });
    cleanup.push(() => closeHistory(h.dir));
    const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
    saveIndex(h.dir, [ws.id]);
    saveWorkspace(h.dir, ws.getState());
    const pending = ws.sendMessage("retry save", agent.id);
    await vi.waitFor(() =>
      expect(h.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(true),
    );
    writeSession(path.join(h.dir, "session.jsonl"), h.session.sessionId!, h.dir, [
      conversationEntry("input", null, "user", "retry save"),
    ]);
    await vi.waitFor(() => {
      expect(failNextAnchorSave).toBe(false);
      expect(loadAll(h.dir)[0].agents[0].session.persistedSessionAnchor).toMatchObject({
        leafId: "input",
        entryCount: 1,
      });
    });
    expect(h.done).not.toHaveBeenCalled();
    const prompt = h.clients[0].wire.find((frame) => frame.type === "prompt")!;
    h.clients[0].respond(prompt, { disposition: "started" });
    await pending;
  });

  it("matches the finalized skill-expanded user message instead of the raw RPC text", async () => {
    const h = harness({ options: { anchorTimeoutMs: 500, anchorPollIntervalMs: 5 } });
    await h.session.send("/skill:example");
    const expanded =
      '<skill name="example" location="/tmp/example.md">\nExpanded instructions\n</skill>';
    const file = path.join(h.dir, "session.jsonl");
    writeSession(file, h.session.sessionId!, h.dir, [
      conversationEntry("input", null, "user", expanded),
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(h.session.getState().persistedSessionAnchor).toBeUndefined();
    h.clients[0].event({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: expanded }] },
    });
    await vi.waitFor(() =>
      expect(h.session.getState().persistedSessionAnchor).toMatchObject({
        leafId: "input",
        entryCount: 1,
      }),
    );

    const restored = harness({ state: () => h.session.getState() });
    await restored.session.ensureStarted();
    expect(restored.factory.mock.calls[0][0].args).toContain("--session");
    expect(restored.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
  });

  it("gives finalization a fresh proof window before the original write deadline expires", async () => {
    const h = harness({ options: { anchorTimeoutMs: 120, anchorPollIntervalMs: 5 } });
    await h.session.send("raw");
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    const finalized = "finalized by an input hook";
    h.clients[0].event({
      type: "message_end",
      message: { role: "user", content: finalized },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    writeSession(path.join(h.dir, "session.jsonl"), h.session.sessionId!, h.dir, [
      conversationEntry("input", null, "user", finalized),
    ]);
    await vi.waitFor(() =>
      expect(h.session.getState().persistedSessionAnchor).toMatchObject({
        leafId: "input",
        entryCount: 1,
      }),
    );
    expect(h.session.getState().hasConfirmedTurns).toBe(false);
    expect(h.done).not.toHaveBeenCalled();
  });

  it("rechecks an expired first-input probe when Pi settles with a valid checkpoint", async () => {
    const h = harness({ options: { anchorTimeoutMs: 20, anchorPollIntervalMs: 2 } });
    await h.session.send("late write");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(h.session.getState()).toMatchObject({
      hasUnanchoredInput: true,
      hasConfirmedTurns: false,
    });
    expect(h.session.getState().persistedSessionAnchor).toBeUndefined();
    const file = path.join(h.dir, "session.jsonl");
    writeSession(file, h.session.sessionId!, h.dir, [
      conversationEntry("input", null, "user", "late write"),
    ]);
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    vi.spyOn(h.panel, "requestSessionCheckpoint").mockResolvedValue({
      sessionId: h.session.sessionId,
      sessionFile: file,
      leafId: "input",
      entryCount: 1,
    });
    h.clients[0].event({ type: "agent_settled" });
    await vi.waitFor(() =>
      expect(h.session.getState()).toMatchObject({
        hasConfirmedTurns: true,
        hasUnanchoredInput: false,
        persistedSessionAnchor: { leafId: "input", entryCount: 1 },
      }),
    );

    const restored = harness({ state: () => h.session.getState() });
    await restored.session.ensureStarted();
    expect(restored.factory.mock.calls[0][0].args).toContain("--session");
    expect(restored.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
  });

  it("anchors a delayed complete prefix but refuses a malformed unterminated tail on restore", async () => {
    const h = harness({ options: { anchorTimeoutMs: 500, anchorPollIntervalMs: 5 } });
    await h.session.send("delayed");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(h.session.getState().persistedSessionAnchor).toBeUndefined();
    const file = path.join(h.dir, "session.jsonl");
    const assistant = `${JSON.stringify(conversationEntry("reply", "input", "assistant", "later"))}\n`;
    writeSession(
      file,
      h.session.sessionId!,
      h.dir,
      [conversationEntry("input", null, "user", "delayed")],
      assistant.slice(0, 24),
    );
    await vi.waitFor(() =>
      expect(h.session.getState().persistedSessionAnchor).toMatchObject({
        leafId: "input",
        entryCount: 1,
      }),
    );

    // Pi appends LF when it loads a torn tail but leaves the malformed bytes.
    // Refuse before that becomes a complete corrupt line on the next YAAT restore.
    const restored = harness({ state: () => h.session.getState() });
    await expect(restored.session.ensureStarted()).rejects.toThrow(/torn record/);
    expect(restored.factory).not.toHaveBeenCalled();
  });

  it("accepts a valid unterminated record through Pi's LF repair and a later append", async () => {
    const h = harness({ state: anchored });
    const file = h.state!.sessionFile!;
    fs.appendFileSync(
      file,
      JSON.stringify(conversationEntry("reply", "input", "assistant", "done")),
    );
    const first = harness({
      state: () => h.state!,
      ready: (report) => {
        report.sessionProof.entryCount = 2;
        report.sessionProof.leafId = "reply";
      },
    });
    await first.session.ensureStarted();
    expect(first.factory.mock.calls[0][0].args).toContain("--session");

    // This is Pi 1.6.0's actual repair: add LF, retain all records, then append.
    fs.appendFileSync(file, "\n");
    fs.appendFileSync(
      file,
      `${JSON.stringify(conversationEntry("next", "reply", "user", "next"))}\n`,
    );
    const second = harness({
      state: () => first.session.getState(),
      ready: (report) => {
        report.sessionProof.entryCount = 3;
        report.sessionProof.leafId = "next";
      },
    });
    await second.session.ensureStarted();
    expect(second.session.getState()).toMatchObject({
      expectedLeafAnchorId: "next",
      minEntryCount: 3,
    });
  });

  it("does not turn a corrupt complete JSONL tail into durable input proof", async () => {
    const h = harness({ options: { anchorTimeoutMs: 30, anchorPollIntervalMs: 2 } });
    await h.session.send("first");
    writeSession(
      path.join(h.dir, "session.jsonl"),
      h.session.sessionId!,
      h.dir,
      [conversationEntry("input", null, "user", "first")],
      "{broken}\n",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(h.session.getState()).toMatchObject({
      hasUnanchoredInput: true,
      hasConfirmedTurns: false,
    });
    expect(h.session.getState().persistedSessionAnchor).toBeUndefined();
  });

  it.each([
    [
      "an invalid content block",
      [
        {
          type: "message",
          id: "input",
          parentId: null,
          message: { role: "user", content: [null, { type: "text", text: "first" }] },
        },
      ],
    ],
    [
      "a message without a payload after the valid input",
      [
        conversationEntry("input", null, "user", "first"),
        { type: "message", id: "broken", parentId: "input" },
      ],
    ],
    [
      "an image without its required data",
      [
        {
          type: "message",
          id: "input",
          parentId: null,
          message: {
            role: "user",
            content: [{ type: "text", text: "first" }, { type: "image" }],
          },
        },
      ],
    ],
    [
      "a malformed assistant tool call after the valid input",
      [
        conversationEntry("input", null, "user", "first"),
        {
          type: "message",
          id: "broken",
          parentId: "input",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call", name: "read" }],
          },
        },
      ],
    ],
  ])("rejects %s instead of counting it as durable proof", async (_, entries) => {
    const h = harness({ options: { anchorTimeoutMs: 30, anchorPollIntervalMs: 2 } });
    await h.session.send("first");
    writeSession(path.join(h.dir, "session.jsonl"), h.session.sessionId!, h.dir, entries);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(h.session.getState().persistedSessionAnchor).toBeUndefined();
    expect(h.session.getState().hasUnanchoredInput).toBe(true);
  });

  it("keeps a settled but unproved first input ambiguous on restore", async () => {
    const h = harness({ options: { anchorTimeoutMs: 30, anchorPollIntervalMs: 2 } });
    await h.session.send("first");
    writeSession(path.join(h.dir, "session.jsonl"), h.session.sessionId!, h.dir, []);
    h.clients[0].event({ type: "agent_settled" });
    const state = h.session.getState();
    expect(state).toMatchObject({ hasConfirmedTurns: true, hasUnanchoredInput: true });
    expect(state.expectedLeafAnchorId).toBeNull();
    expect(state.minEntryCount).toBe(0);

    const restored = harness({ state: () => state });
    await expect(restored.session.ensureStarted()).rejects.toThrow(/recovery is ambiguous/);
    expect(restored.factory).not.toHaveBeenCalled();
  });

  it.each(["missing", "header", "branch", "corrupt", "symlink", "fifo"])(
    "refuses a once-proved session with %s history before spawning Pi",
    async (damage) => {
      const h = harness({ state: anchored });
      const file = h.state!.sessionFile!;
      if (damage === "missing") fs.rmSync(file);
      if (damage === "header")
        writeSession(file, "wrong", h.dir, [conversationEntry("input", null, "user", "first")]);
      if (damage === "branch")
        fs.appendFileSync(
          file,
          `${JSON.stringify(conversationEntry("other", null, "assistant", "other"))}\n`,
        );
      if (damage === "corrupt") fs.appendFileSync(file, "{broken}\n");
      if (damage === "symlink") {
        const copy = `${file}.copy`;
        fs.copyFileSync(file, copy);
        fs.rmSync(file);
        fs.symlinkSync(copy, file);
      }
      if (damage === "fifo") {
        fs.rmSync(file);
        execFileSync("mkfifo", [file]);
      }

      await expect(h.session.ensureStarted()).rejects.toThrow(
        /Pi persisted session recovery failed/,
      );
      expect(h.factory).not.toHaveBeenCalled();
      expect(h.clients).toHaveLength(0);
      expect(h.session.getState().persistedSessionAnchor).toEqual(h.state!.persistedSessionAnchor);
    },
    2_000,
  );

  it("keeps report probing idempotent on a first-input-only anchored restore", async () => {
    const h = harness({ state: anchored });
    vi.spyOn(h.panel, "probeDispatchedReport").mockResolvedValue({
      found: true,
      anchorMissing: false,
      matchedEntryId: "input",
    });
    await expect(h.session.probeDispatchedReport(null, "report-1")).resolves.toMatchObject({
      found: true,
      anchorMissing: false,
    });
    expect(h.factory.mock.calls[0][0].args).toContain("--session");
    expect(h.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
    expect(h.session.getState().hasConfirmedTurns).toBe(true);
  });

  it("preserves the canonical anchor when a settlement checkpoint uses a symlinked path", async () => {
    const h = harness({ options: { anchorTimeoutMs: 500, anchorPollIntervalMs: 5 } });
    await h.session.send("first");
    const file = path.join(h.dir, "session.jsonl");
    const sessionId = h.session.sessionId!;
    writeSession(file, sessionId, h.dir, [conversationEntry("input", null, "user", "first")]);
    await vi.waitFor(() => expect(h.session.getState().persistedSessionAnchor).toBeDefined());
    fs.appendFileSync(
      file,
      `${JSON.stringify(conversationEntry("reply", "input", "assistant", "done"))}\n`,
    );
    const alias = path.join(h.dir, "session-dir-alias");
    fs.symlinkSync(h.dir, alias);
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    vi.spyOn(h.panel, "requestSessionCheckpoint").mockResolvedValue({
      sessionId,
      sessionFile: path.join(alias, "session.jsonl"),
      leafId: "reply",
      entryCount: 2,
    });
    h.clients[0].event({ type: "agent_settled" });
    await vi.waitFor(() =>
      expect(h.session.getState()).toMatchObject({
        expectedLeafAnchorId: "reply",
        minEntryCount: 2,
      }),
    );
    expect(h.session.getState().sessionFile).toBe(fs.realpathSync.native(file));

    const restored = harness({ state: () => h.session.getState() });
    await restored.session.ensureStarted();
    expect(restored.factory.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(["--session", fs.realpathSync.native(file)]),
    );
    expect(restored.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
  });

  it("resumes a confirmed second-turn cut from the exact file without replaying either input", async () => {
    const h = harness({ options: { anchorTimeoutMs: 500, anchorPollIntervalMs: 5 } });
    await h.session.send("first");
    const file = path.join(h.dir, "session.jsonl");
    const sessionId = h.session.sessionId!;
    writeSession(file, sessionId, h.dir, [conversationEntry("input", null, "user", "first")]);
    await vi.waitFor(() => expect(h.session.getState().persistedSessionAnchor).toBeDefined());
    fs.appendFileSync(
      file,
      `${JSON.stringify(conversationEntry("reply", "input", "assistant", "done"))}\n`,
    );
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    vi.spyOn(h.panel, "requestSessionCheckpoint").mockResolvedValue({
      sessionId,
      sessionFile: file,
      leafId: "reply",
      entryCount: 2,
    });
    h.clients[0].event({ type: "agent_settled" });
    await vi.waitFor(() =>
      expect(h.session.getState()).toMatchObject({
        hasConfirmedTurns: true,
        expectedLeafAnchorId: "reply",
        minEntryCount: 2,
      }),
    );

    await h.session.send("second");
    fs.appendFileSync(
      file,
      `${JSON.stringify(conversationEntry("second", "reply", "user", "second"))}\n`,
    );
    const cut = h.session.getState();
    expect(cut.hasConfirmedTurns).toBe(true);
    expect(cut.persistedSessionAnchor).toMatchObject({ leafId: "input", entryCount: 1 });

    const restored = harness({
      state: () => cut,
      ready: (report) => {
        report.sessionProof.entryCount = 3;
        report.sessionProof.leafId = "second";
      },
    });
    await restored.session.ensureStarted();
    expect(restored.factory.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(["--session", fs.realpathSync.native(file)]),
    );
    expect(restored.clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
    expect(restored.session.getState()).toMatchObject({
      hasConfirmedTurns: true,
      expectedLeafAnchorId: "second",
      minEntryCount: 3,
    });
    expect(
      h.clients[0].wire.filter((frame) => frame.type === "prompt").map((frame) => frame.message),
    ).toEqual(["first", "second"]);
  });
});

describe("PiSession bounded recovery", () => {
  it.each([
    [
      "off-branch anchor",
      (report: PanelReadyReport) => {
        report.sessionProof.anchorOnActiveBranch = false;
      },
    ],
    [
      "wrong session ID",
      (report: PanelReadyReport) => {
        report.sessionProof.sessionId = "different";
      },
    ],
    [
      "short entry count",
      (report: PanelReadyReport) => {
        report.sessionProof.entryCount = 3;
      },
    ],
  ])("closes and refuses %s without replacing saved state", async (_, ready) => {
    const { session, clients, register, factory } = harness({ ready, state: confirmed });
    const before = session.getState();
    expect(factory).not.toHaveBeenCalled();
    const hook = vi.fn();
    await expect(session.send("never", { onBeforeWrite: hook })).rejects.toThrow(/restore proof/);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ restoreExpectation: { expectedAnchorId: "anchor" } }),
    );
    expect(factory.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(["--session", before.sessionFile]),
    );
    expect(clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
    expect(clients[0].rpc.stdin.writableEnded).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    expect(session.getState()).toEqual(before);
  });

  it("checks the exact file header before spawning", async () => {
    const h = harness({ state: confirmed });
    fs.writeFileSync(h.state!.sessionFile!, '{"type":"session","id":"wrong"}\n');
    await expect(h.session.ensureStarted()).rejects.toThrow(/header/);
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("accepts valid legacy Bash, image, thinking, tool-call and tool-result records", async () => {
    const h = harness({
      state: confirmed,
      ready: (report) => {
        report.sessionProof.entryCount = 8;
        report.sessionProof.leafId = "bash";
      },
    });
    const file = h.state!.sessionFile!;
    const entries = [
      {
        type: "message",
        id: "image",
        parentId: "anchor",
        message: {
          role: "user",
          content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        },
      },
      {
        type: "message",
        id: "call",
        parentId: "image",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          ],
        },
      },
      {
        type: "message",
        id: "result",
        parentId: "call",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [
            { type: "text", text: "result" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          isError: false,
        },
      },
      {
        type: "message",
        id: "bash",
        parentId: "result",
        message: {
          role: "bashExecution",
          command: "pwd",
          output: "/tmp\n",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        },
      },
    ];
    for (const entry of entries) fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    await h.session.ensureStarted();
    expect(h.factory.mock.calls[0][0].args).toContain("--session");
    expect(h.session.getState()).toMatchObject({ expectedLeafAnchorId: "bash", minEntryCount: 8 });
  });

  it("rejects a malformed complete line in a confirmed-only session before spawning", async () => {
    const h = harness({ state: confirmed });
    fs.appendFileSync(h.state!.sessionFile!, "{broken}\n");
    await expect(h.session.ensureStarted()).rejects.toThrow(
      /Pi restore session validation failed: Pi session JSONL is corrupt/,
    );
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("updates restore anchors asynchronously without holding the next prompt", async () => {
    const h = harness({ state: confirmed });
    let resolveCheckpoint!: (value: {
      sessionId: string;
      sessionFile: string;
      leafId: string;
      entryCount: number;
    }) => void;
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    vi.spyOn(h.panel, "requestSessionCheckpoint").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheckpoint = resolve;
        }),
    );
    const before = vi.fn();
    await h.session.send("first", { onBeforeWrite: before });
    expect(before).toHaveBeenCalledWith(
      expect.objectContaining({ beforeLeafId: "anchor", beforeEntryCount: 4 }),
    );
    h.clients[0].event({ type: "agent_settled" });
    await expect(h.session.send("next")).resolves.toEqual({ disposition: "started" });
    resolveCheckpoint({
      sessionId: "saved",
      sessionFile: h.state!.sessionFile!,
      leafId: "new",
      entryCount: 7,
    });
    await vi.waitFor(() =>
      expect(h.session.getState()).toMatchObject({ expectedLeafAnchorId: "new", minEntryCount: 7 }),
    );
  });

  it("promotes an unconfirmed session only after a positive report probe", async () => {
    const h = harness({
      state: saved,
      ready: (report) => {
        report.sessionProof.entryCount = 2;
        report.sessionProof.leafId = "found";
      },
    });
    const probe = vi
      .spyOn(h.panel, "probeDispatchedReport")
      .mockResolvedValueOnce({ found: false, anchorMissing: false })
      .mockResolvedValueOnce({ found: true, anchorMissing: false, matchedEntryId: "found" });
    await expect(h.session.probeDispatchedReport(null, "r")).resolves.toMatchObject({
      found: false,
    });
    expect(h.session.getState().hasConfirmedTurns).toBe(false);
    await expect(h.session.probeDispatchedReport(null, "r", 50)).resolves.toMatchObject({
      found: true,
      sessionProof: { entryCount: 2 },
    });
    expect(probe).toHaveBeenLastCalledWith(expect.any(String), null, "r", 50);
    expect(h.session.getState()).toMatchObject({
      hasConfirmedTurns: true,
      expectedLeafAnchorId: "found",
      minEntryCount: 2,
    });
  });
});

describe("PiSession interrupt recovery", () => {
  it("retires an unconfirmed interrupt generation and drops its late settled, exit and stats", async () => {
    const h = harness({ options: { interruptTimeoutMs: 25, statsTimeoutMs: 500 } });
    await h.session.send("previous");
    const old = h.clients[0];
    let lateStats!: (stats: Record<string, unknown>) => void;
    const stats = vi.spyOn(old.rpc, "getSessionStats").mockImplementation(
      () =>
        new Promise((resolve) => {
          lateStats = resolve;
        }),
    );
    writeSession(path.join(h.dir, "session.jsonl"), h.session.sessionId!, h.dir, [
      conversationEntry("previous", null, "user", "previous"),
    ]);
    await vi.waitFor(() => expect(h.session.getState().persistedSessionAnchor).toBeDefined());
    old.event({ type: "agent_settled" });
    expect(stats).toHaveBeenCalledOnce();
    await h.session.send("timeout");
    await expect(h.session.interrupt()).resolves.toBe(false);
    await vi.waitFor(() => expect(old.end).toHaveBeenCalledOnce());
    expect(old.wire.filter((frame) => frame.type === "abort")).toHaveLength(1);
    expect(old.wire.some((frame) => frame.type === "clear_queue")).toBe(false);
    expect(h.session).toMatchObject({ tainted: true, processGeneration: 1 });
    // Inject late callbacks directly as queued emitter work even after stdin closes.
    old.rpc.emit("event", { type: "agent_settled" });
    old.rpc.emit("exit", 1, null);
    const before = vi.fn();
    await expect(h.session.send("replacement", { onBeforeWrite: before })).resolves.toEqual({
      disposition: "started",
    });
    expect(before).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));
    expect(h.clients).toHaveLength(2);
    old.rpc.emit("event", { type: "agent_settled" });
    old.rpc.emit("exit", 1, null);
    lateStats({ tokens: { input: 500 }, contextUsage: { tokens: 42, window: 100 } });
    expect(await h.session.getContextUsage()).toBeNull();
    expect(h.session.isRunning).toBe(true);
    expect(h.session.usage.input_tokens).toBe(0);
    h.clients[1].event({ type: "agent_settled" });
    expect(h.session.runState).toBe("idle");
    expect(h.done).toHaveBeenCalledTimes(3);
  });

  it("routes a disconnected child stop to the exact on-disk index and nonempty ID and refuses workflow or paused stops", async () => {
    const pkg = temp();
    const bundle = path.join(pkg, "bundle");
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(pkg, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(bundle, "control-channel.js"),
      `
      import fs from 'node:fs';
      import path from 'node:path';
      export function requestAsyncStop(dir, payload) {
        const name = path.join(dir, 'control', 'stop-request.json');
        fs.mkdirSync(path.dirname(name), {recursive: true});
        fs.writeFileSync(name, JSON.stringify(payload));
        return name;
      }
    `,
    );
    const asyncDir = temp();
    const file = path.join(asyncDir, "status.json");
    const stopFile = path.join(asyncDir, "control", "stop-request.json");
    const h = harness({ config: { piSubagentsRoot: pkg }, options: { reconcileIntervalMs: 20 } });
    await h.session.send("background");
    const status = {
      runId: "run",
      sessionId: h.session.sessionId,
      mode: "parallel",
      state: "running",
      steps: [
        { childId: "", workflowKey: "actual-A", status: "running" },
        { childId: "actual-B", workflowKey: "ignore-B", status: "running" },
      ],
    };
    const write = () => fs.writeFileSync(file, JSON.stringify(status));
    write();
    const { event } = h.clients[0];
    event({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "batch",
      args: { async: true, tasks: [{ agent: "A" }, { agent: "B" }] },
    });
    event({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "batch",
      result: { details: { runId: "run", asyncDir, mode: "parallel" } },
    });
    event({ type: "agent_settled" });
    expect(h.session.runState).toBe("waiting");
    expect(h.session.backgroundTaskList.map((task) => task.id)).toEqual(["batch:0", "batch:1"]);
    for (const [mode, state] of [
      ["workflow", "running"],
      ["parallel", "paused"],
    ]) {
      status.mode = mode;
      status.state = state;
      write();
      await expect(h.session.stopTask("batch:0")).rejects.toThrow(
        "child_stop_unavailable_bridge_disconnected",
      );
      expect(fs.existsSync(stopFile)).toBe(false);
    }
    status.mode = "parallel";
    status.state = "running";
    write();
    const finishB = path.join(asyncDir, "finish-B");
    const pairedRunner = path.join(asyncDir, "fixture.cjs");
    fs.writeFileSync(
      pairedRunner,
      `
      const fs = require('node:fs');
      const [file, stopFile, finishB] = process.argv.slice(2);
      const status = JSON.parse(fs.readFileSync(file, 'utf8'));
      const write = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(status)); fs.renameSync(file + '.tmp', file); };
      const timer = setInterval(() => {
        if (status.steps[0].status === 'running' && fs.existsSync(stopFile)) {
          const stop = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
          if (stop.targetIndex !== 0 || stop.childId !== 'actual-A') process.exit(2);
          status.steps[0].status = 'stopped';
          write();
        }
        if (fs.existsSync(finishB)) {
          status.steps[1].status = 'completed';
          status.state = 'completed';
          write();
          clearInterval(timer);
        }
      }, 10);
    `,
    );
    const runner = spawn(process.execPath, [pairedRunner, file, stopFile, finishB], {
      stdio: "ignore",
    });
    const exited = once(runner, "exit");
    cleanup.push(async () => {
      runner.kill();
      await exited;
    });
    await h.session.stopTask("batch:0");
    expect(JSON.parse(fs.readFileSync(stopFile, "utf8")) as unknown).toEqual({
      targetIndex: 0,
      childId: "actual-A",
      source: "panel-host-fallback",
    });
    await vi.waitFor(() =>
      expect(h.session.backgroundTaskList.map((task) => task.id)).toEqual(["batch:1"]),
    );
    expect(
      h.events
        .filter((event) => event.kind === "subagent_done")
        .map((event) => event.subagent?.status),
    ).toEqual(["stopped"]);
    fs.writeFileSync(finishB, "");
    await expect(exited).resolves.toEqual([0, null]);
    await vi.waitFor(() => expect(h.session.runState).toBe("idle"));
    expect(
      h.events
        .filter((event) => event.kind === "subagent_done")
        .map((event) => event.subagent?.status),
    ).toEqual(["stopped", "completed"]);
  });
});

describe("PiSession detached runner cleanup", () => {
  it("reaps a registered cross-PGID runner after its Pi parent has already exited and frees its port", async () => {
    const dir = temp();
    const cfg = config(dir);
    const asyncDir = path.join(dir, "run");
    fs.mkdirSync(asyncDir);
    const runnerFile = path.join(asyncDir, "async-runner.cjs");
    const launcherFile = path.join(dir, "fake-pi.cjs");
    const pidFile = path.join(asyncDir, "status.json");
    fs.writeFileSync(
      runnerFile,
      `
      const fs = require('node:fs');
      const net = require('node:net');
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], JSON.stringify({
        runId: 'detached', sessionId: 'saved', mode: 'single', state: 'running', pid: process.pid, port: server.address().port
      })));
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `,
    );
    fs.writeFileSync(
      launcherFile,
      `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' });
      child.unref();
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const command = JSON.parse(line);
        const data = { get_state: { sessionId: 'saved' }, get_available_models: { models: [] }, get_commands: { commands: [] }, get_available_thinking_levels: { levels: [] }}[command.type];
        process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data })+'\\n');
      });
      const timer = setInterval(() => { if (fs.existsSync(process.argv[4])) { clearInterval(timer); process.exit(0); } }, 10);
    `,
    );
    let rpc: PiRpcClient | undefined;
    let runner: { pid: number; port: number } | undefined;
    cleanup.push(() => {
      if (runner) {
        try {
          process.kill(runner.pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }
    });
    const panel = new PanelHttpServer();
    cleanup.push(() => panel.close());
    vi.spyOn(panel, "waitForReady").mockResolvedValue({
      sessionProof: {
        sessionId: "saved",
        sessionFile: null,
        cwd: dir,
        headerCwd: dir,
        entryCount: 0,
        leafId: null,
        anchorOnActiveBranch: true,
        anchorExistsInFile: false,
      },
      ownerToolNames: [],
      requiredExtensionsRegistered: false,
      subagentsRpcReady: false,
      subagentsSessionId: null,
    });
    const exitFile = path.join(dir, "exit");
    const state = saved(cfg, [
      {
        runId: "detached",
        asyncDir,
        mode: "single",
        startedAt: Date.now(),
        ownerMessageId: "input",
        toolCallId: "tool",
        children: [{ taskId: "tool:0", stepIndex: 0, canonicalChildId: "child" }],
      },
    ]);
    const session = PiSession.fromState(state, {
      panelHttp: panel,
      rpcFactory: (opts) =>
        (rpc = PiRpcClient.spawn({
          ...opts,
          binary: process.execPath,
          args: [launcherFile, runnerFile, pidFile, exitFile],
        })),
    });
    cleanup.push(() => session.dispose());
    await session.ensureStarted();
    await vi.waitFor(() => {
      runner = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid: number; port: number };
    });
    expect(runner?.pid).not.toBe(rpc!.pid);
    const pgid = (pid: number) =>
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    expect(pgid(runner!.pid)).toBe(String(runner!.pid));
    expect(pgid(runner!.pid)).not.toBe(pgid(rpc!.pid!));
    const exited = once(rpc!, "exit");
    fs.writeFileSync(exitFile, "");
    await exited;
    const startedAt = Date.now();
    await session.dispose(10_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const server = net.createServer().listen(runner!.port, "127.0.0.1");
    await once(server, "listening");
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(() => process.kill(runner!.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    runner = undefined;
  }, 12_000);
});
