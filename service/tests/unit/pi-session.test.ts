import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACP_PREPARE_STEP } from "../../src/session/acp-readiness";
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
import {
  createPiWireTransport,
  piIdleState,
  piPanelConnection,
  piReadyReport,
  piRpcResponse,
} from "./helpers/pi-wire-harness";

type Frame = { id: string; type: string; [key: string]: unknown };
type SessionHarness = ReturnType<typeof harness>;
type SessionClient = SessionHarness["clients"][number];
type EmitFrame = SessionClient["event"];
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

type HarnessOverrides = {
  config?: Partial<SessionConfig>;
  options?: Partial<PiSessionOptions>;
  ready?: (ready: PanelReadyReport) => void;
  state?: (config: SessionConfig) => SessionState;
  disposition?: string;
  delayedQuota?: boolean;
  retire?: { trailing?: object };
  holdPromptReply?: boolean;
  promptError?: string;
  contextUsage?: { tokens: number | null; contextWindow: number };
  enabledModels?: string[];
  startupModel?: { provider: string; id: string };
  models?: Array<{
    provider: string;
    id: string;
    contextWindow?: number;
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<string, string | null>>;
  }>;
};

function harness(override: HarnessOverrides = {}) {
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
    const ready = piReadyReport({
      sessionId: sessionId ?? null,
      sessionFile: sessionFile ?? null,
      cwd: fs.realpathSync.native(proofState.normalizedCwd ?? proofState.config.cwd),
      headerCwd: sessionHeader?.cwd ?? dir,
      entryCount: proofState.minEntryCount ?? 0,
      leafId: proofState.expectedLeafAnchorId ?? null,
    });
    override.ready?.(ready);
    const { headers, endpoint } = piPanelConnection(opts);
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
    const wire: Frame[] = [];
    const respond = (frame: Frame, data?: unknown, success = true) =>
      event(
        piRpcResponse(
          frame,
          data,
          success ? undefined : (override.promptError ?? "preflight denied"),
        ),
      );
    const {
      stdin,
      stdout,
      emit: event,
    } = createPiWireTransport({
      write(chunk: Buffer, _, callback) {
        const frame = JSON.parse(chunk.toString()) as Frame;
        wire.push(frame);
        switch (frame.type) {
          case "get_state":
            respond(frame, piIdleState(sessionId, sessionFile, override.startupModel));
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
            respond(frame, {
              commands: [
                { name: "skill:test", source: "skill" },
                { name: "quota", source: "extension" },
                { name: "antigravity-acp", source: "extension" },
                { name: "gemini-acp", source: "extension" },
              ],
            });
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
              contextUsage: override.contextUsage ?? { tokens: null, contextWindow: 100 },
            });
            break;
          default:
            respond(frame);
            break;
        }
        callback();
      },
    });
    const child = override.retire
      ? Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null })
      : undefined;
    const end = vi.fn(() => {
      if (child) {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        if (override.retire?.trailing) event(override.retire.trailing);
        stdout.once("end", () => child.emit("close", 0, null));
      }
      stdout.end();
    });
    stdin.on("finish", end);
    const rpc = new PiRpcClient(
      { stdin, stdout, child: child as ChildProcess | undefined },
      { requestTimeoutMs: 800 },
    );
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

function requests(wire: Frame[], type: string) {
  return wire.filter((frame) => frame.type === type);
}

function promptTexts(wire: Frame[]) {
  return requests(wire, "prompt").map((frame) => frame.message);
}

function waitForLastRequest(
  client: () => SessionClient | undefined,
  type: "prompt" | "compact",
  afterCount?: number,
) {
  return vi.waitFor(() => {
    const c = client();
    if (afterCount !== undefined) expect(c?.wire.length).toBeGreaterThan(afterCount);
    const frame = c?.wire.at(-1);
    expect(frame?.type).toBe(type);
  });
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

function assistantEnd(
  content: Array<Record<string, unknown>>,
  stopReason = "stop",
  fields?: { errorMessage?: string; provider?: string; model?: string; yaatLimitReset?: number },
) {
  const frame = piFrame("message_end", { role: "assistant" });
  return { ...frame, message: { ...frame.message, content, stopReason, ...fields } };
}

const silentWorkspaceCallbacks = {
  onNewMessage: () => {},
  onStreamEvent: () => {},
  onMessageDone: () => {},
} satisfies WorkspaceCallbacks;

function workspaceFor(h: SessionHarness, callbacks: Partial<WorkspaceCallbacks> = {}) {
  const registry = new HostRegistry();
  const host = new LocalHost("local", "Local");
  vi.spyOn(host, "createSession").mockReturnValue(h.session);
  registry.register(host);
  const ws = new Workspace("ws", "test", "project", "local", h.dir, registry, {
    ...silentWorkspaceCallbacks,
    ...callbacks,
  });
  return { ws, registry };
}

function workspaceWithPi(h: SessionHarness, callbacks?: Partial<WorkspaceCallbacks>) {
  const { ws, registry } = workspaceFor(h, callbacks);
  const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
  return { ws, registry, agent };
}

function reloadWorkspace(ws: Workspace, registry: HostRegistry) {
  const restored = Workspace.fromState(ws.getState(), registry, silentWorkspaceCallbacks);
  restored.setMessages(structuredClone(ws.getMessages()));
  return restored;
}

const largeContextWindow = 1_048_576;

function contextHarness(tokens?: number) {
  return harness({
    models: [{ provider: "mock", id: "test", contextWindow: largeContextWindow }],
    ...(tokens !== undefined && { contextUsage: { tokens, contextWindow: largeContextWindow } }),
  });
}

function estimatedContext(tokens: number, window = largeContextWindow) {
  return { tokens, window, estimated: true };
}

type PiUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function emitAssistantUsage(event: EmitFrame, text: string, usage: PiUsage) {
  event({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], usage },
  });
}

function settleTurn(event: EmitFrame) {
  event({ type: "agent_end", messages: [] });
  event({ type: "agent_settled", aborted: false });
}

type CompactionResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
};

function compacted(tokensBefore: number, estimatedTokensAfter?: number): CompactionResult {
  return {
    summary: "Compacted",
    firstKeptEntryId: "kept",
    tokensBefore,
    ...(estimatedTokensAfter !== undefined && { estimatedTokensAfter }),
  };
}

function emitCompaction(
  event: EmitFrame,
  reason: "manual" | "threshold" | "overflow",
  end: {
    result?: CompactionResult;
    errorMessage?: string;
  },
) {
  event({ type: "compaction_start", reason });
  const { result, errorMessage } = end;
  event({ type: "compaction_end", reason, result, aborted: false, willRetry: false, errorMessage });
}

function answerManualCompaction(c: SessionClient, frame: Frame, result: CompactionResult) {
  emitCompaction(c.event, "manual", { result });
  c.respond(frame, result);
}

async function waitForWorkspacePrompt(h: SessionHarness) {
  await waitForLastRequest(() => h.clients[0], "prompt");
  const client = h.clients[0];
  client.respond(client.wire.at(-1)!);
  client.event({ type: "agent_start" });
  return client;
}

async function seedWorkspaceContext(
  h: SessionHarness,
  { ws, agent }: { ws: Workspace; agent: { id: string } },
  prompt: string,
  usage: PiUsage,
  expectedTokens: number,
) {
  const sending = ws.sendMessage(prompt, agent.id);
  const c = await waitForWorkspacePrompt(h);
  emitAssistantUsage(c.event, "done", usage);
  settleTurn(c.event);
  await sending;
  await vi.waitFor(() =>
    expect(ws.getInfo().agents[0].context).toEqual(estimatedContext(expectedTokens)),
  );
  return c;
}

function readPiFixture(name: "pi-compact-empty" | "pi-compact-overflow" | "pi-1.6-extension-ui") {
  return fs
    .readFileSync(path.join(__dirname, "fixtures", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Frame);
}

function startSubagent(event: EmitFrame, args: object, toolCallId = "call") {
  event({ type: "tool_execution_start", toolName: "subagent", toolCallId, args });
}

function finishSubagent(event: EmitFrame, details: object, toolCallId = "call") {
  event({ type: "tool_execution_end", toolName: "subagent", toolCallId, result: { details } });
}

function notifySubagent(
  event: EmitFrame,
  details: { runId: string; status: string; children?: object[] },
) {
  event({
    type: "message_end",
    message: { role: "custom", customType: "subagent-notify", details },
  });
}

function subagentCards(
  events: StreamEvent[],
  kind: "subagent_start" | "subagent_done" | "subagent_progress",
) {
  return events.filter((event) => event.kind === kind).map((event) => event.subagent);
}

function backgroundTaskIds(session: PiSession) {
  return session.backgroundTaskList.map((task) => task.id);
}

function asyncWidget(event: EmitFrame, snapshot?: object) {
  event({
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "subagent-async",
    ...(snapshot && { widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`] }),
  });
}

function asyncSnapshot<
  T extends { kind: "workflow" | "subagent"; id: string; label: string; state: string },
>(run: T) {
  return { kind: "pi-subagents.async-status-snapshot", version: 1, runs: [run] };
}

function messageEntry(
  id: string,
  parentId: string | null,
  message: { role: string; [key: string]: unknown },
) {
  return { type: "message", id, parentId, message };
}

function conversationEntry(
  id: string,
  parentId: string | null,
  role: "assistant" | "user",
  text: string,
) {
  return messageEntry(id, parentId, {
    role,
    content: role === "assistant" ? [{ type: "text", text }] : text,
  });
}

function appendConversationEntry(file: string, ...entry: Parameters<typeof conversationEntry>) {
  fs.appendFileSync(file, `${JSON.stringify(conversationEntry(...entry))}\n`);
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

function proofAt(leafId: string, entryCount: number) {
  return (report: PanelReadyReport) => {
    report.sessionProof.entryCount = entryCount;
    report.sessionProof.leafId = leafId;
  };
}

function anchored(cfg: SessionConfig): SessionState {
  const file = path.join(fs.realpathSync.native(cfg.cwd), "anchored.jsonl");
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

describe("Pi deployment retirement", () => {
  it("holds a busy turn and can start a replacement after clean idle retirement", async () => {
    const active = harness({ retire: {} });
    await active.session.send("busy");
    const signal = new AbortController().signal;
    await expect(active.session.retireIdleProcess(signal)).rejects.toThrow("busy");
    expect(active.clients[0].end).not.toHaveBeenCalled();
    const idle = harness({ retire: {} });
    await idle.session.ensureStarted();
    await idle.session.retireIdleProcess(signal);
    await idle.session.send("after unseal");
    expect(idle.clients).toHaveLength(2);
  });

  it("observes an unsolicited start between process exit and stdout close", async () => {
    const { session } = harness({ retire: { trailing: { type: "agent_start" } } });
    await session.ensureStarted();
    const lease = new AbortController();
    session.on("runState", (state: string) => {
      if (state === "working") lease.abort(new Error("seal revoked"));
    });
    await expect(session.retireIdleProcess(lease.signal)).rejects.toThrow("seal revoked");
  });
});

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
    expect(requests(h.client.wire, "steer")).toHaveLength(0);
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
      expect(requests(h.client.wire, "clear_queue")).toHaveLength(0);
    },
  );
});

describe("PiSession ACP readiness", () => {
  const acp = { provider: "antigravity-acp", id: "sample" };
  const rejected = {
    disposition: "rejected",
    error: `Antigravity ACP runtime is not ready. ${ACP_PREPARE_STEP}`,
  };

  function stubRuntime() {
    const runtime = path.join(temp(), "agy");
    fs.writeFileSync(runtime, "not run", { mode: 0o700 });
    return runtime;
  }

  function runtimeModel(
    provider: string,
    overrides?: Pick<HarnessOverrides, "disposition" | "promptError">,
  ) {
    const model = { provider, id: "test" };
    return harness({
      startupModel: model,
      models: [model],
      options: { env: { AGY_ACP_BIN: stubRuntime() } },
      ...overrides,
    });
  }

  it.each([undefined, "antigravity-acp/sample", "sample"])(
    "rejects an ACP turn on model %s before writing and retries in the same Pi after setup",
    async (model) => {
      const home = temp();
      const h = harness({
        config: { model },
        options: { env: { HOME: home, USERPROFILE: home, PATH: "", AGY_ACP_BIN: "" } },
        startupModel: model ? undefined : acp,
        models: [acp],
      });
      await h.session.ensureStarted();
      expect(h.session.getAvailableModels().map((m) => m.id)).toEqual(["antigravity-acp/sample"]);
      const onBeforeWrite = vi.fn();
      expect(await h.session.send("hello", { onBeforeWrite })).toEqual(rejected);
      expect(await h.session.send("/compact", { onBeforeWrite })).toEqual(rejected);
      expect(onBeforeWrite).not.toHaveBeenCalled();
      expect(h.clients[0].wire.some(({ type }) => type === "prompt" || type === "compact")).toBe(
        false,
      );

      const dir = path.join(home, ".local", "opt", "agy-acp", "current");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agy_acp_server.par"), "not run", { mode: 0o700 });
      expect(await h.session.send("hello", { onBeforeWrite })).toEqual({ disposition: "started" });
      expect(onBeforeWrite).toHaveBeenCalledOnce();
      expect(h.factory).toHaveBeenCalledOnce();
    },
  );

  it("keeps other models and /quota usable but blocks upstream ACP runtime commands on a bad override", async () => {
    const home = temp();
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "agy_acp_server.par"), "not run", { mode: 0o700 });
    const h = harness({
      config: {
        piAntigravityEntryPath: "/stub/acp-extension",
        piOffline: false,
      },
      options: { env: { HOME: home, AGY_ACP_BIN: path.join(home, "bad-binary") } },
      disposition: "handled",
    });
    await h.session.ensureStarted();
    expect(h.session.getAvailableModels().map((m) => m.id)).toEqual(["mock/test"]);
    expect(h.factory.mock.calls[0][0].env?.PI_OFFLINE).toBe("1");
    for (const command of ["/antigravity-acp  quota", "/gemini-acp quota"]) {
      expect(await h.session.send(command)).toEqual(rejected);
    }
    expect(await h.session.send("/quota")).toEqual({ disposition: "handled" });
    expect(await h.session.send("hello")).toEqual({ disposition: "handled" });
    expect(promptTexts(h.clients[0].wire)).toEqual(["/quota", "hello"]);
  });

  it.each([
    ["RPC error -32000: Authentication required", "antigravity-acp", true],
    [
      "No saved Google login for this Pi profile. Run /login antigravity-acp.",
      "antigravity-acp",
      true,
    ],
    ["Antigravity authentication required: Authentication required", "antigravity-acp", true],
    ["RPC error -32000: Rate limit exceeded", "antigravity-acp", false],
    ["RPC error -32000: Authentication required", "mock", false],
  ])("makes %s actionable only for ACP (model %s)", async (errorMessage, provider, acp) => {
    const h = runtimeModel(provider);
    await h.session.ensureStarted();
    const terminal = new Promise<StreamEvent>((resolve) => h.session.once("done", resolve));
    await h.session.send("hello");
    const client = h.clients[0];
    client.event(piFrame("agent_start"));
    client.event(piFrame("message_end", { role: "user" }));
    client.event(assistantEnd([], "error", { errorMessage }));
    client.event(piFrame("agent_settled"));
    const event = await terminal;
    expect(event.kind).toBe("error");
    expect(event.content).toBe(
      acp
        ? "Antigravity ACP authentication failed. Run /login antigravity-acp in standalone host Pi as the YAAT service user, then start a new YAAT Pi session."
        : errorMessage,
    );
  });

  it("returns host login guidance for an ACP prompt rejected by Pi RPC", async () => {
    const h = runtimeModel("antigravity-acp", {
      disposition: "rejected",
      promptError: "No saved Google login for this Pi profile.",
    });
    const receipt = await h.session.send("hello");
    expect(receipt.disposition).toBe("rejected");
    expect(receipt.error).toContain("/login antigravity-acp in standalone host Pi");
    expect(requests(h.clients[0].wire, "prompt").length).toBeGreaterThan(0);
  });

  it("keeps other models usable and rejects ACP prompts when runtime stores conflict", async () => {
    const home = temp();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const dataDir = temp();
    const provider = path.join(dataDir, "pi-antigravity-acp-provider");
    const store = "antigravity-acp-provider/gemini/antigravity-acp";
    const host = path.join(home, ".pi/agent", store);
    const managed = path.join(dataDir, "pi-agent-home", store);
    for (const [folder, token] of [
      [host, "fake-host"],
      [managed, "fake-managed"],
    ]) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, "acp_token.json"),
        JSON.stringify({ refresh_token: token }),
      );
    }
    fs.mkdirSync(path.join(provider, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(provider, "extensions/index.ts"), "export {};");
    const h = harness({
      config: { piAgentDir: undefined, dataDir, piPackages: [provider] },
      disposition: "handled",
    });
    await h.session.ensureStarted();
    expect(h.factory.mock.calls[0][0].env?.YAAT_PI_ANTIGRAVITY_ENTRY).toBeUndefined();
    expect(await h.session.send("other model")).toEqual({ disposition: "handled" });
    h.session.setModel("antigravity-acp/sample");
    const receipt = await h.session.send("ACP model");
    expect(receipt.disposition).toBe("rejected");
    expect(receipt.error).toContain("move the managed gemini directory");
    expect(promptTexts(h.clients[0].wire)).toEqual(["other model"]);
    expect(fs.readFileSync(path.join(managed, "acp_token.json"), "utf8")).toContain("fake-managed");
    expect(fs.readFileSync(path.join(host, "acp_token.json"), "utf8")).toContain("fake-host");
  });

  it("keeps an online non-catalog Pi online unless its loaded ACP runtime is missing", async () => {
    const home = temp();
    const runtime = path.join(home, "agy");
    const withoutAcp = harness({
      config: { piOffline: false },
      options: { env: { AGY_ACP_BIN: runtime } },
    });
    await withoutAcp.session.ensureStarted();
    expect(withoutAcp.factory.mock.calls[0][0].env?.PI_OFFLINE).toBeUndefined();

    const withAcp = {
      piOffline: false,
      piAntigravityEntryPath: "/stub/acp-extension",
    };
    const options = { env: { AGY_ACP_BIN: runtime } };
    const missing = harness({ config: withAcp, options });
    await missing.session.ensureStarted();
    expect(missing.factory.mock.calls[0][0].env?.PI_OFFLINE).toBe("1");

    fs.writeFileSync(runtime, "not run", { mode: 0o700 });
    const ready = harness({ config: withAcp, options });
    await ready.session.ensureStarted();
    expect(ready.factory.mock.calls[0][0].env?.PI_OFFLINE).toBeUndefined();
    const catalog = harness({ config: withAcp, options: { ...options, catalogOnly: true } });
    await catalog.session.ensureStarted();
    expect(catalog.factory.mock.calls[0][0].env?.PI_OFFLINE).toBe("1");
  });

  it("uses a caller-supplied Pi home without rewriting its ACP permissions", async () => {
    const dir = temp();
    const { piAgentDir } = config(dir);
    const profileDir = path.join(piAgentDir!, "antigravity-acp-provider");
    const profile = path.join(profileDir, "config.json");
    fs.mkdirSync(profileDir);
    fs.writeFileSync(profile, '{"permissions":"default","runtimeUpdates":"notify"}');
    const entry = path.join(
      piAgentDir!,
      "npm/node_modules/pi-antigravity-acp-provider/extensions/index.ts",
    );
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "export {};");
    fs.writeFileSync(
      path.join(piAgentDir!, "settings.json"),
      '{"packages":["npm:pi-antigravity-acp-provider"]}',
    );
    const h = harness({
      config: {
        piAgentDir,
        piAcp: { permissions: "yolo" },
        piOffline: false,
      },
      options: { env: { AGY_ACP_BIN: path.join(dir, "missing") } },
    });
    await h.session.ensureStarted();
    expect(h.factory.mock.calls[0][0].env?.PI_OFFLINE).toBe("1");
    expect(h.factory.mock.calls[0][0].env?.YAAT_PI_ANTIGRAVITY_ENTRY).toBe(fs.realpathSync(entry));
    expect(fs.readFileSync(profile, "utf8")).toBe(
      '{"permissions":"default","runtimeUpdates":"notify"}',
    );
  });

  it("leaves a broken managed profile intact and still dispatches a non-ACP model online", async () => {
    const dataDir = temp();
    const provider = path.join(dataDir, "pi-antigravity-acp-provider");
    const profile = path.join(dataDir, "pi-agent-home/antigravity-acp-provider/config.json");
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(profile, "{");
    fs.mkdirSync(path.join(provider, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(provider, "extensions/index.ts"), "export {};");
    const h = harness({
      config: { piAgentDir: undefined, dataDir, piPackages: [provider], piOffline: false },
      disposition: "handled",
    });
    await h.session.ensureStarted();
    expect(h.factory.mock.calls[0][0].env?.YAAT_PI_ANTIGRAVITY_ENTRY).toBeUndefined();
    expect(h.factory.mock.calls[0][0].env?.PI_OFFLINE).toBeUndefined();
    expect(await h.session.send("hello")).toEqual({ disposition: "handled" });
    h.session.setModel("antigravity-acp/sample");
    expect((await h.session.send("try ACP")).error).toContain(profile);
    expect(fs.readFileSync(profile, "utf8")).toBe("{");
  });

  it("applies updated Pi package exclusions and offline mode from setPiConfig on start", async () => {
    const dataDir = temp();
    const keepPkg = path.join(dataDir, "pkg-keep");
    const dropPkg = path.join(dataDir, "pkg-drop");
    fs.mkdirSync(keepPkg, { recursive: true });
    fs.mkdirSync(dropPkg, { recursive: true });
    const h = harness({
      config: {
        piAgentDir: undefined,
        dataDir,
        piPackages: [keepPkg, dropPkg],
        piExcludePackages: [],
        piOffline: false,
      },
    });
    h.session.setPiConfig({
      piPackages: [keepPkg, dropPkg],
      piExcludePackages: ["pkg-drop"],
      piOffline: true,
    });
    await h.session.ensureStarted();
    const settings = JSON.parse(
      fs.readFileSync(path.join(dataDir, "pi-agent-home/settings.json"), "utf8"),
    ) as { packages: string[] };
    expect(settings.packages).toEqual([fs.realpathSync.native(keepPkg)]);
    expect(h.factory.mock.calls[0][0].env?.PI_OFFLINE).toBe("1");
    expect(h.session.getState().config.piExcludePackages).toEqual(["pkg-drop"]);
  });

  it("redirects setup and policy changes for both ACP aliases even with a ready runtime", async () => {
    const h = harness({
      options: { env: { AGY_ACP_BIN: stubRuntime() } },
      disposition: "handled",
    });
    const onBeforeWrite = vi.fn();
    for (const alias of ["antigravity-acp", "gemini-acp"]) {
      for (const cmd of ["setup", "qualify", "update", "update-runtime"]) {
        const result = await h.session.send(`/${alias} ${cmd}`, { onBeforeWrite });
        expect(result.disposition).toBe("rejected");
        expect(result.error).toContain(ACP_PREPARE_STEP);
      }
      for (const cmd of [
        "permissions",
        "permissions  yolo",
        "updates automatic",
        "tool-activity",
        "tool-activity off",
      ]) {
        const result = await h.session.send(`/${alias}  ${cmd}`, { onBeforeWrite });
        expect(result.disposition).toBe("rejected");
        expect(result.error).toContain("managed by YAAT");
      }
    }
    expect(onBeforeWrite).not.toHaveBeenCalled();
    expect(requests(h.clients[0].wire, "prompt")).toHaveLength(0);
    expect(await h.session.send("/antigravity-acp updates")).toEqual({ disposition: "handled" });
    expect(await h.session.send("/gemini-acp status")).toEqual({ disposition: "handled" });
    expect(await h.session.send("/antigravity-acp quota")).toEqual({ disposition: "handled" });
  });

  it("still runs the all-provider quota command with an unavailable ACP default", async () => {
    const home = temp();
    const h = harness({
      options: { env: { AGY_ACP_BIN: path.join(home, "missing") } },
      startupModel: acp,
      models: [acp],
      disposition: "handled",
    });
    expect(await h.session.send("/quota")).toEqual({ disposition: "handled" });
  });

  it.each([
    { catalogOnly: false, expected: "/pinned/pi" },
    { catalogOnly: true, expected: "/pinned/pi" },
    { catalogOnly: true, configBinary: "/configured/pi", expected: "/configured/pi" },
    {
      catalogOnly: true,
      configBinary: "/configured/pi",
      optionBinary: "/requested/pi",
      expected: "/requested/pi",
    },
  ])(
    "uses the installer Pi pin as fallback with catalogOnly=$catalogOnly",
    async ({ catalogOnly, configBinary, optionBinary, expected }) => {
      vi.stubEnv("YAAT_PI_BIN", "/pinned/pi");
      const h = harness({
        config: { piBinary: configBinary, piOffline: false },
        options: { catalogOnly, piBinary: optionBinary },
      });
      await h.session.ensureStarted();
      expect(h.factory.mock.calls[0][0].binary).toBe(expected);
      expect(h.factory.mock.calls[0][0].env?.PI_OFFLINE).toBe(catalogOnly ? "1" : undefined);
    },
  );
});

describe("PiSession Git environment", () => {
  it.each([
    { catalogOnly: false, expected: "0" },
    { catalogOnly: true, expected: "0" },
    { inherited: "1", expected: "1" },
    { inherited: "", expected: "" },
    { inherited: "0", provider: "1", expected: "1" },
    { inherited: "1", provider: "", expected: "" },
  ])("passes the Git prompt setting to the RPC child: %j", async (test) => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", test.inherited);
    const h = harness({
      options: {
        catalogOnly: test.catalogOnly,
        env: test.provider === undefined ? undefined : { GIT_TERMINAL_PROMPT: test.provider },
      },
    });
    await h.session.ensureStarted();
    expect(h.factory.mock.calls[0][0].env?.GIT_TERMINAL_PROMPT).toBe(test.expected);
    expect(process.env.GIT_TERMINAL_PROMPT).toBe(test.inherited);
  });
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
      await waitForLastRequest(() => c, "compact");
      const frame = c.wire.at(-1)!;
      expect(frame.customInstructions).toBe(command === "/compact" ? undefined : "Keep\ndecisions");
      await expect(h.session.send("next")).rejects.toThrow(/busy/);
      const result = { summary: "Summary", firstKeptEntryId: "kept", tokensBefore: 1234 };
      emitCompaction(c.event, "manual", { result });
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

  it("updates live and restored workspace context occupancy after manual /compact with estimatedTokensAfter", async () => {
    const h = contextHarness(312_900);
    const updated: Array<{ context: { tokens: number; window: number } | null | undefined }> = [];
    const workspace = workspaceWithPi(h, {
      onAgentUpdated: (_wsId, agent) => updated.push({ context: agent.context }),
    });
    const { ws, registry, agent } = workspace;

    // Seed a high pre-compaction context from a normal turn.
    const c = await seedWorkspaceContext(
      h,
      workspace,
      "hello",
      {
        input: 312_248,
        output: 1_641,
        cacheRead: 512,
        cacheWrite: 0,
      },
      312_900,
    );

    // Manual /compact reports estimatedTokensAfter; both live and restored state must drop to it.
    updated.length = 0;
    const compacting = ws.sendMessage("/compact", agent.id);
    await waitForLastRequest(() => c, "compact");
    const compactFrame = c.wire.at(-1)!;
    answerManualCompaction(c, compactFrame, compacted(314_401, 33_812));
    await compacting;

    expect(ws.getInfo().agents[0].context).toEqual(estimatedContext(33_812));
    expect(updated.at(-1)?.context).toEqual(estimatedContext(33_812));
    expect(ws.getMessages().at(-1)?.context).toEqual(estimatedContext(33_812));

    const restored = reloadWorkspace(ws, registry);
    expect(restored.getInfo().agents[0].context).toEqual(estimatedContext(33_812));
  });

  it("clears stale pre-compaction context when /compact has no token estimate and stops pre-compaction fallback on reload", async () => {
    const h = contextHarness(312_900);
    const updated: Array<{ context: { tokens: number; window: number } | null | undefined }> = [];
    const workspace = workspaceWithPi(h, {
      onAgentUpdated: (_wsId, agent) => updated.push({ context: agent.context }),
    });
    const { ws, registry, agent } = workspace;

    const c = await seedWorkspaceContext(
      h,
      workspace,
      "hello",
      {
        input: 312_000,
        output: 100,
        cacheRead: 760,
        cacheWrite: 0,
      },
      312_900,
    );

    // A failed compact keeps the existing context intact.
    const failed = ws.sendMessage("/compact", agent.id);
    await waitForLastRequest(() => c, "compact");
    const failFrame = c.wire.at(-1)!;
    emitCompaction(c.event, "manual", {
      errorMessage: "Compaction failed: Nothing to compact (session too small)",
    });
    c.respond(failFrame, undefined, false);
    await failed;
    expect(ws.getInfo().agents[0].context).toEqual(estimatedContext(312_900));

    // A successful compact without estimatedTokensAfter clears stale context both live and after reload.
    updated.length = 0;
    const wireCountBefore = c.wire.length;
    const compacting = ws.sendMessage("/compact", agent.id);
    await waitForLastRequest(() => c, "compact", wireCountBefore);
    const compactFrame = c.wire.at(-1)!;
    answerManualCompaction(c, compactFrame, compacted(314_401));
    await compacting;

    expect(ws.getInfo().agents[0].context).toBeNull();
    expect(updated.at(-1)?.context).toBeNull();

    const restored = reloadWorkspace(ws, registry);
    expect(restored.getInfo().agents[0].context).toBeNull();
  });

  it("keeps missing terminal context unknown when earlier Pi stats arrive late", async () => {
    const h = harness();
    const { ws, registry, agent } = workspaceWithPi(h);
    await ws.sendMessage("first", agent.id);
    const c = h.clients[0];
    let resolveFirst!: (stats: Record<string, unknown>) => void;
    vi.spyOn(c.rpc, "getSessionStats")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ tokens: { input: 123, output: 45, total: 168 } });
    c.event(piFrame("message_end", { role: "assistant" }));
    c.event(piFrame("agent_settled"));
    const firstReply = ws.getMessages().at(-1)!;
    expect(firstReply.context).toBeNull();

    await ws.sendMessage("second", agent.id);
    c.event(piFrame("message_end", { role: "assistant" }));
    c.event(piFrame("agent_settled"));
    const secondReply = ws.getMessages().at(-1)!;
    resolveFirst({ contextUsage: { tokens: 17, contextWindow: 100 } });
    await vi.waitFor(() => expect(firstReply.context).toEqual(estimatedContext(17, 100)));
    expect(secondReply.context).toBeNull();
    expect(ws.getInfo().agents[0].context).toBeNull();
    expect(await h.session.getContextUsage()).toBeNull();
    await ws.sendMessage("/context", agent.id);
    expect(ws.getMessages().at(-1)?.content).toContain("**Occupancy:** Unknown");
    expect(
      Workspace.fromState(structuredClone(ws.getState()), registry).getInfo().agents[0].context,
    ).toBeNull();
  });

  it("does not restore pre-compaction context at turn settlement after threshold auto-compaction", async () => {
    for (const estimatedTokensAfter of [28_400, undefined]) {
      const h = contextHarness();
      const { ws, registry, agent } = workspaceWithPi(h);

      const turn = ws.sendMessage("big turn", agent.id);
      const c = await waitForWorkspacePrompt(h);
      emitAssistantUsage(c.event, "answer", {
        input: 310_000,
        output: 1_000,
        cacheRead: 2_000,
        cacheWrite: 0,
      });
      emitCompaction(c.event, "threshold", {
        result: compacted(313_000, estimatedTokensAfter),
      });
      expect(ws.getInfo().agents[0].context).toEqual(
        estimatedTokensAfter === undefined ? null : estimatedContext(estimatedTokensAfter),
      );
      settleTurn(c.event);
      await turn;

      expect(ws.getInfo().agents[0].context).toBeNull();
      expect(ws.getMessages().at(-1)?.context).toBeNull();

      const restored = reloadWorkspace(ws, registry);
      expect(restored.getInfo().agents[0].context).toBeNull();
    }
  });

  it("preserves out-of-turn compaction estimates and clears across workspace reload", async () => {
    for (const estimatedTokensAfter of [22_500, undefined]) {
      const h = contextHarness(201_500);
      const workspace = workspaceWithPi(h);
      const { ws, registry } = workspace;

      const c = await seedWorkspaceContext(
        h,
        workspace,
        "seed",
        {
          input: 200_000,
          output: 500,
          cacheRead: 1_000,
          cacheWrite: 0,
        },
        201_500,
      );

      // Idle out-of-turn compaction (no active turn).
      emitCompaction(c.event, "threshold", {
        result: compacted(201_500, estimatedTokensAfter),
      });

      const expected =
        estimatedTokensAfter !== undefined ? estimatedContext(estimatedTokensAfter) : null;
      expect(ws.getInfo().agents[0].context).toEqual(expected);
      expect(ws.lastTurns()[0]?.replies.every((m) => m.kind === "agent")).toBe(true);

      const restored = reloadWorkspace(ws, registry);
      expect(restored.getInfo().agents[0].context).toEqual(expected);
    }
  });

  it("clears running reply context immediately when an unestimated compaction follows an estimated one and errors", async () => {
    const h = contextHarness();
    const { ws, registry, agent } = workspaceWithPi(h);

    const turn = ws.sendMessage("work", agent.id);
    const c = await waitForWorkspacePrompt(h);
    emitCompaction(c.event, "threshold", {
      result: {
        summary: "First",
        firstKeptEntryId: "k1",
        tokensBefore: 300_000,
        estimatedTokensAfter: 40_000,
      },
    });
    expect(ws.getInfo().agents[0].context).toEqual(estimatedContext(40_000));

    // Second compaction lacks an estimate: must clear live context immediately.
    emitCompaction(c.event, "overflow", {
      result: { summary: "Second", firstKeptEntryId: "k2", tokensBefore: 42_000 },
    });
    expect(ws.getInfo().agents[0].context).toBeNull();
    expect(ws.getMessages().at(-1)?.context).toBeNull();

    // Error settlement and reload must keep context cleared.
    c.event({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
    });
    settleTurn(c.event);
    await turn;

    expect(ws.getInfo().agents[0].context).toBeNull();
    expect(ws.getMessages().at(-1)?.context).toBeNull();

    const restored = reloadWorkspace(ws, registry);
    expect(restored.getInfo().agents[0].context).toBeNull();
  });

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
    const { ws, agent } = workspaceWithPi(h);
    const pending = ws.sendMessage("/compact", agent.id);
    await waitForLastRequest(() => h.clients[0], "compact");
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
    await waitForLastRequest(() => c, "compact");
    for (const frame of readPiFixture("pi-compact-empty"))
      c.event(frame.id ? { ...frame, id: c.wire.at(-1)!.id } : frame);
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
    for (const frame of readPiFixture("pi-compact-overflow")) c.event(frame);
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
    expect(requests(h.clients[0].wire, "set_thinking_level")).toEqual([]);
    expect(h.events.filter((e) => e.level === "warning")).toEqual([]);
  });

  it("canonicalizes bare model IDs so thinking levels and optionsPending stay accurate", async () => {
    const h = harness({
      config: { model: "mock/large" },
      startupModel: { provider: "mock", id: "large" },
      models: [
        { provider: "mock", id: "large", contextWindow: 500_000 },
        { provider: "mock", id: "small", contextWindow: 272_000 },
      ],
    });
    await h.session.ensureStarted();
    // Matching startup model by bare ID should not trigger a redundant set_model RPC.
    h.session.setModel("large");
    expect(h.session.optionsPending).toBe(false);
    expect(requests(h.clients[0].wire, "set_model")).toEqual([]);

    // Switching to another model by bare ID resolves and stores its canonical provider/id.
    h.session.setModel("small");
    await vi.waitFor(() =>
      expect(requests(h.clients[0].wire, "set_model")).toEqual([
        expect.objectContaining({ provider: "mock", modelId: "small" }),
      ]),
    );
    await vi.waitFor(() => expect(h.session.optionsPending).toBe(false));
    expect(h.session.getAvailableThinkingLevels("small")).toEqual(["low", "high"]);
    expect(h.session.getAvailableThinkingLevels("mock/small")).toEqual(["low", "high"]);
    expect(h.session.getAvailableThinkingLevels("mock/large")).toBeUndefined();

    // A subsequent turn does not redundantly re-send set_model.
    await h.session.send("check context");
    expect(requests(h.clients[0].wire, "set_model")).toHaveLength(1);
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
      expect(requests(h.clients[0].wire, "set_thinking_level")).toEqual([]);
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
      { kind: "error", content: "503 final failure", context: null },
    ]);
    expect(h.done).toHaveBeenCalledTimes(1);
  });

  it("binds ACP transport evidence to the admitted request's turn and final provider failure", async () => {
    const model = { provider: "antigravity-acp", id: "test" };
    let observe!: import("../../src/acp-proxy/limit-evidence").ObserveRequest;
    const url = "http://127.0.0.1:12345";
    const h = harness({
      startupModel: model,
      models: [model],
      options: {
        env: { AGY_ACP_CCPA_BASE_URL: undefined, AGY_ACP_BIN: process.execPath },
        ccpaProxy: {
          url,
          registerSession: (callback) => {
            observe = callback;
            return { url, dispose: () => {} };
          },
        },
      },
    });
    const resetsAt = Math.floor(Date.now() / 1000) + 900;
    const limits: unknown[] = [];
    h.session.on("event", (_e, _context, limit) => {
      if (limit) limits.push(limit);
    });
    const begin = async () => {
      await h.session.send("work");
      h.clients[0].event(piFrame("agent_start"));
      h.clients[0].event(piFrame("message_end", { role: "user" }));
      h.clients[0].event(assistantStart());
    };
    const end = (error = "Antigravity quota exceeded for test.") => {
      const refusal = "Usage Limit Reached\n\nYou have reached your current quota for this period.";
      h.clients[0].event(
        assistantEnd([{ type: "text", text: refusal }], error ? "error" : "stop", {
          provider: model.provider,
          model: model.id,
          errorMessage: error,
        }),
      );
      h.clients[0].event(piFrame("agent_settled"));
    };
    const response = { kind: "response" as const, model: "test", limited: true };
    await begin();
    observe("fetchAvailableModels")!({ kind: "quota", exhausted: new Map([["test", resetsAt]]) });
    const previous = observe("streamGenerateContent")!;
    end(); // quota alone
    await begin();
    previous(response);
    end(); // delayed previous turn
    await begin();
    observe("streamGenerateContent")!(response);
    end("403 permission denied");
    await begin();
    observe("streamGenerateContent")!(response);
    end("");
    await begin();
    observe("streamGenerateContent")!({ ...response, model: "other" });
    end();
    await begin();
    observe("streamGenerateContent")!(response);
    observe("streamGenerateContent")!({ ...response, limited: false });
    end();
    expect(limits).toEqual([]);
    await begin();
    observe("streamGenerateContent")!(response);
    end();
    expect(limits).toEqual([
      {
        resetsAt,
        refusalText: "Usage Limit Reached\n\nYou have reached your current quota for this period.",
      },
    ]);
  });

  it.each(["final", "retry-success", "unknown-delivery", "bare"])(
    "only promotes turn-final native evidence (%s)",
    async (scenario) => {
      const h = harness();
      const resetsAt = Math.floor(Date.now() / 1000) + 90;
      const limits: unknown[] = [];
      h.session.on("event", (_e, _context, limit) => {
        if (limit) limits.push(limit);
      });
      await h.session.send("work");
      const { event } = h.clients[0];
      event(piFrame("agent_start"));
      if (scenario !== "unknown-delivery") event(piFrame("message_end", { role: "user" }));
      event(assistantStart());
      event(
        assistantEnd([{ type: "text", text: "429 refusal" }], "error", {
          errorMessage: "429 refusal",
          ...(scenario !== "bare" && { yaatLimitReset: resetsAt }),
        }),
      );
      if (scenario === "retry-success") {
        event(piFrame("auto_retry_start"));
        event(assistantStart());
        event(assistantEnd([{ type: "text", text: "success" }]));
      }
      event(piFrame("agent_settled"));
      expect(limits).toEqual(
        scenario === "final" ? [{ resetsAt, refusalText: "429 refusal" }] : [],
      );
    },
  );

  it("marks confirmed transport on the terminal Pi error, not the retry banner", async () => {
    const h = harness();
    await h.session.send("work");
    const { event } = h.clients[0];
    const errorMessage = "OAuth token refresh failed: getaddrinfo ENOTFOUND auth.example.test";
    for (const frame of piFrames("messages/retry-failed")) {
      if (frame.type === "response") continue;
      if (frame.type === "auto_retry_start") event({ ...frame, errorMessage });
      else if (frame.type === "auto_retry_end") event({ ...frame, finalError: errorMessage });
      else event(frame);
    }
    expect(h.events.filter((e) => e.networkFailure)).toEqual([
      { kind: "error", content: errorMessage, context: null, networkFailure: true },
    ]);
  });

  it.each([undefined, "https://override.test", ""])(
    "sets the CCPA proxy only for the Pi child when the endpoint override is %s",
    async (override) => {
      const endpoint = "http://127.0.0.1:12345";
      const windows = process.platform === "win32";
      const upper = "upper.test,localhost";
      const lower = "lower.test, 127.0.0.1";
      vi.stubEnv("AGY_ACP_CCPA_BASE_URL", override);
      vi.stubEnv("NO_PROXY", upper);
      // On Windows the two names refer to a single native environment entry.
      if (!windows) vi.stubEnv("no_proxy", lower);
      const registerSession = vi.fn(() => ({
        url: `${endpoint}/_yaat/session`,
        dispose: () => {},
      }));
      const { session, factory } = harness({
        options: { ccpaProxy: { url: endpoint, registerSession } },
      });
      await session.ensureStarted();
      expect(factory.mock.calls[0][0].env).toMatchObject({
        AGY_ACP_CCPA_BASE_URL: override ?? `${endpoint}/_yaat/session`,
        NO_PROXY: "upper.test,localhost,127.0.0.1",
        no_proxy: windows ? "upper.test,localhost,127.0.0.1" : "lower.test,127.0.0.1,localhost",
      });
      expect(process.env.AGY_ACP_CCPA_BASE_URL).toBe(override);
      expect(process.env.NO_PROXY).toBe(upper);
      expect(process.env.no_proxy).toBe(windows ? upper : lower);
    },
  );

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
    const { headers, endpoint } = piPanelConnection(spawn);
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
      startSubagent(event, args);
      finishSubagent(event, { mode, results: [] });
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
    startSubagent(event, {
      tasks: [{ agent: "A", model: "requested", thinking: "low" }, { agent: "B" }],
    });
    for (const start of events.filter((entry) => entry.kind === "subagent_start")) {
      expect(start.subagent).not.toHaveProperty("model");
      expect(start.subagent).not.toHaveProperty("effort");
    }
    finishSubagent(event, {
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
    });
    const done = subagentCards(events, "subagent_done");
    expect(done).toMatchObject([
      { taskId: "call:0", model: "provider/a", effort: "high" },
      { taskId: "call:1", model: "provider/b", effort: "off" },
    ]);
    expect(done[0]?.durationMs).toBe(321);
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
    startSubagent(event, { agent: "Scout", async: true });
    finishSubagent(event, { asyncDir: dir, runId: "observed" });
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
    await session.reconcileAsyncRuns();
    expect(session.isRunning).toBe(false);
    expect(session.getState().activeAsyncRuns).toEqual([]);
    expect(session.deployBusy).toBe(true);
    notifySubagent(event, { runId: "observed", status: "completed" });
    await vi.waitFor(() => expect(session.deployBusy).toBe(false));
  });

  it("keeps sparse workflow identities separate from later roster indices and sparse RPC responses", async () => {
    const h = harness({ options: { livePollIntervalMs: 10 } });
    await h.session.send("workflow");
    const event = h.clients[0].event;
    const node = (state: string) =>
      asyncSnapshot({
        kind: "workflow",
        id: "wf",
        label: "workflow",
        state: "running",
        children: [{ kind: "step", id: "review", label: "review", state }],
      });
    startSubagent(event, { workflow: "workflow", async: true });
    asyncWidget(event, node("running"));
    asyncWidget(event);
    finishSubagent(event, { mode: "workflow", runId: "wf", asyncDir: h.dir });
    fs.writeFileSync(
      path.join(h.dir, "status.json"),
      JSON.stringify({
        state: "running",
        sessionId: h.session.sessionId,
        runId: "wf",
        steps: ["build", "review"].map((workflowKey) => ({ workflowKey, status: "running" })),
      }),
    );
    await vi.waitFor(() =>
      expect(backgroundTaskIds(h.session)).toEqual(["call:0", "call:key:build"]),
    );
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    const status = vi
      .spyOn(h.panel, "sendSubagentsRpc")
      .mockResolvedValue({ asyncSnapshot: node("failed") });
    await h.session.reconcileAsyncRuns();
    expect(status).toHaveBeenCalled();
    expect(backgroundTaskIds(h.session)).toEqual(["call:key:build"]);
    expect(subagentCards(h.events, "subagent_done").map((card) => card?.taskId)).toEqual([
      "call:0",
    ]);
    notifySubagent(event, { runId: "wf", status: "completed" });
    event({ type: "agent_settled" });
  });

  it("binds recorded workflow widget lanes without local files while the parent is busy", async () => {
    const { session, clients, events, dir } = harness();
    await session.send("launch");
    const { event } = clients[0];
    const frames = piFrames("messages/subagents-widgets");
    const asyncWidgets = frames.filter((f) => f.widgetKey === "subagent-async");
    event(asyncWidgets[0]);
    startSubagent(event, { workflow: "example", async: true }, "workflow");
    finishSubagent(event, { mode: "workflow", runId: "fixture-run", asyncDir: dir }, "workflow");
    for (const frame of asyncWidgets.slice(1)) event(frame);
    expect(subagentCards(events, "subagent_done")).toMatchObject([
      { taskId: "workflow:0", status: "completed", durationMs: 269, model: "pi-e2e/scenario" },
      {
        taskId: "workflow:key:child-2",
        status: "completed",
        durationMs: 246,
        model: "pi-e2e/scenario",
      },
    ]);
    expect(session.backgroundTaskList).toEqual([]);
    expect(session.runState).toBe("working");
    event({ type: "agent_settled" });
  });

  it.each(["complete", "partial", "failed", "rejected", "paused", "stopped"])(
    "settles pushed %s during the parent turn, then enriches the original card",
    async (terminal) => {
      const { session, clients, events, dir } = harness();
      await session.send("background");
      const { event } = clients[0];
      const widget = (state: string) =>
        asyncWidget(
          event,
          asyncSnapshot({
            id: "owned",
            kind: "subagent",
            label: "Agent",
            state,
            startedAt: 101,
            ...(state === terminal ? { endedAt: 122 } : {}),
          }),
        );
      const ui = vi.fn();
      session.on("extension_ui", ui);
      widget("queued");
      startSubagent(event, { agent: "Agent", async: true });
      finishSubagent(event, { asyncDir: dir, runId: "owned" });
      expect(backgroundTaskIds(session)).toEqual(["call:0"]);
      expect(events.at(-1)?.subagent?.status).toBe("queued");
      widget("running");
      asyncWidget(event);
      expect(session.backgroundTaskList).toHaveLength(1);
      widget(terminal);
      widget(terminal);
      widget("running");
      expect(session.runState).toBe("working");
      expect(session.backgroundTaskList).toEqual([]);
      expect(ui).not.toHaveBeenCalled();
      expect(subagentCards(events, "subagent_done")).toMatchObject([
        {
          taskId: "call:0",
          status: terminal === "complete" ? "completed" : terminal,
          durationMs: 21,
        },
      ]);
      notifySubagent(event, {
        runId: "owned",
        status: terminal,
        children: [{ summary: "late output" }],
      });
      expect(events.filter((e) => e.kind === "subagent_done")).toHaveLength(1);
      expect(events.find((e) => e.kind === "subagent_enrichment")?.subagent).toMatchObject({
        taskId: "call:0",
        summary: "late output",
      });
      event({ type: "agent_settled" });
      expect(session.runState).toBe("idle");
    },
  );

  it("uses observed wire execution without status files and ignores queued siblings' candidates", async () => {
    const { session, clients, events, dir } = harness();
    await session.send("work");
    const { event } = clients[0];
    startSubagent(event, { tasks: [{ agent: "A" }, { agent: "B" }], async: true });
    finishSubagent(event, { asyncDir: dir, runId: "wire" });
    notifySubagent(event, {
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
    });
    const done = subagentCards(events, "subagent_done");
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
    const { ws, agent } = workspaceWithPi(h);
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
      context: null,
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
    const frames = readPiFixture("pi-1.6-extension-ui");
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
    expect(requests(clients[0].wire, "extension_ui_response")).toHaveLength(0);
  });

  it.each(["reset", "exit", "dispose"])(
    "bounds live state and releases the retired generation on %s",
    async (end) => {
      const h = harness();
      const unhandled = vi.fn();
      const { ws, agent } = workspaceWithPi(h, { onUnhandled: unhandled });
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
      expect(requests(c.wire, "extension_ui_response")).toHaveLength(0);
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
    expect(requests(wire, "extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: "confirm", confirmed: false },
      { type: "extension_ui_response", id: "expires", cancelled: true },
    ]);
    expect(resolved).toHaveBeenCalledTimes(2);
    event({ type: "extension_ui_request", id: "abort", method: "editor", timeout: 1000 });
    const interrupted = session.interrupt();
    event({ type: "agent_settled", aborted: true });
    await expect(interrupted).resolves.toBe(true);
    expect(wire).toContainEqual({ type: "extension_ui_response", id: "abort", cancelled: true });
    expect(requests(wire, "clear_queue")).toHaveLength(0);
  });
});

describe("PiSession persisted first-input anchor", () => {
  const anchorProbe = { anchorTimeoutMs: 500, anchorPollIntervalMs: 5 };
  const inputAnchor = { leafId: "input", entryCount: 1 };

  function persistedWorkspace(h: SessionHarness, beforeSave?: () => void) {
    const { ws } = workspaceFor(h, {
      onSaveNow: () => {
        beforeSave?.();
        saveWorkspace(h.dir, ws.getState());
      },
    });
    cleanup.push(() => closeHistory(h.dir));
    const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
    saveIndex(h.dir, [ws.id]);
    saveWorkspace(h.dir, ws.getState());
    return { ws, agent, persisted: () => loadAll(h.dir)[0].agents[0].session };
  }

  function persistFirstInput(h: SessionHarness, text: string, tail = "") {
    const file = path.join(h.dir, "session.jsonl");
    writeSession(
      file,
      h.session.sessionId!,
      h.dir,
      [conversationEntry("input", null, "user", text)],
      tail,
    );
    return file;
  }

  async function persistFirstReply(h: SessionHarness) {
    await h.session.send("first");
    const sessionId = h.session.sessionId!;
    const file = persistFirstInput(h, "first");
    await vi.waitFor(() => expect(h.session.getState().persistedSessionAnchor).toBeDefined());
    appendConversationEntry(file, "reply", "input", "assistant", "done");
    return { file, sessionId };
  }

  function settleWithCheckpoint(
    h: SessionHarness,
    sessionFile: string,
    leafId: string,
    entryCount: number,
    sessionId = h.session.sessionId,
  ) {
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    vi.spyOn(h.panel, "requestSessionCheckpoint").mockResolvedValue({
      sessionId,
      sessionFile,
      leafId,
      entryCount,
    });
    h.clients[0].event({ type: "agent_settled" });
  }

  function expectResumeWithoutPrompts(h: SessionHarness, file?: string) {
    const args = h.factory.mock.calls[0][0].args;
    if (file)
      expect(args).toEqual(expect.arrayContaining(["--session", fs.realpathSync.native(file)]));
    else expect(args).toContain("--session");
    expect(requests(h.clients[0].wire, "prompt")).toHaveLength(0);
  }

  function answerHeldPrompt(h: SessionHarness) {
    const prompt = h.clients[0].wire.find((frame) => frame.type === "prompt")!;
    h.clients[0].respond(prompt, { disposition: "started" });
  }

  function waitForHeldPrompt(h: SessionHarness) {
    return vi.waitFor(() =>
      expect(requests(h.clients[0].wire, "prompt").length).toBeGreaterThan(0),
    );
  }

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
    expect(requests(h.clients[0].wire, "prompt")).toHaveLength(0);
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
    const h = harness({ options: anchorProbe });
    const { ws, agent, persisted } = persistedWorkspace(h);
    await ws.sendMessage("first input", agent.id);
    const file = persistFirstInput(h, "first input");

    let snapshot: SessionState | undefined;
    await vi.waitFor(() => {
      snapshot = persisted();
      expect(snapshot.persistedSessionAnchor).toEqual({
        sessionFile: fs.realpathSync.native(file),
        sessionId: h.session.sessionId,
        leafId: "input",
        entryCount: 1,
      });
    });
    expect(snapshot!.hasUnanchoredInput).toBe(false);
    expect(snapshot!.hasConfirmedTurns).toBe(false);
    expect(h.session.isRunning).toBe(true);
    expect(h.done).not.toHaveBeenCalled();
    expect(ws.getMessages().find((msg) => msg.content === "first input")?.status).toBe(
      "dispatching",
    );
    expect(promptTexts(h.clients[0].wire)).toEqual(["first input"]);

    const restored = harness({ state: () => snapshot! });
    await restored.session.ensureStarted();
    expectResumeWithoutPrompts(restored, file);
  });

  it("proves and saves the anchor at the write boundary before the prompt reply", async () => {
    const h = harness({
      holdPromptReply: true,
      options: anchorProbe,
    });
    const { ws, agent, persisted } = persistedWorkspace(h);
    const pending = ws.sendMessage("before reply", agent.id);
    await waitForHeldPrompt(h);
    persistFirstInput(h, "before reply");
    await vi.waitFor(() => expect(persisted().persistedSessionAnchor).toMatchObject(inputAnchor));
    expect(h.done).not.toHaveBeenCalled();
    expect(ws.getMessages().find((msg) => msg.content === "before reply")?.status).toBe(
      "dispatching",
    );
    answerHeldPrompt(h);
    await pending;
    expect(requests(h.clients[0].wire, "prompt")).toHaveLength(1);
  });

  it("retries the atomic snapshot commit after an anchor-save failure", async () => {
    const h = harness({
      holdPromptReply: true,
      options: anchorProbe,
    });
    let failNextAnchorSave = true;
    const { ws, agent, persisted } = persistedWorkspace(h, () => {
      if (failNextAnchorSave && h.session.getState().persistedSessionAnchor) {
        failNextAnchorSave = false;
        throw new Error("snapshot write failed");
      }
    });
    const pending = ws.sendMessage("retry save", agent.id);
    await waitForHeldPrompt(h);
    persistFirstInput(h, "retry save");
    await vi.waitFor(() => {
      expect(failNextAnchorSave).toBe(false);
      expect(persisted().persistedSessionAnchor).toMatchObject(inputAnchor);
    });
    expect(h.done).not.toHaveBeenCalled();
    answerHeldPrompt(h);
    await pending;
  });

  it("matches the finalized skill-expanded user message instead of the raw RPC text", async () => {
    const h = harness({ options: anchorProbe });
    await h.session.send("/skill:example");
    const expanded =
      '<skill name="example" location="/tmp/example.md">\nExpanded instructions\n</skill>';
    persistFirstInput(h, expanded);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(h.session.getState().persistedSessionAnchor).toBeUndefined();
    h.clients[0].event({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: expanded }] },
    });
    await vi.waitFor(() =>
      expect(h.session.getState().persistedSessionAnchor).toMatchObject(inputAnchor),
    );

    const restored = harness({ state: () => h.session.getState() });
    await restored.session.ensureStarted();
    expectResumeWithoutPrompts(restored);
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
    persistFirstInput(h, finalized);
    await vi.waitFor(() =>
      expect(h.session.getState().persistedSessionAnchor).toMatchObject(inputAnchor),
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
    const file = persistFirstInput(h, "late write");
    settleWithCheckpoint(h, file, "input", 1);
    await vi.waitFor(() =>
      expect(h.session.getState()).toMatchObject({
        hasConfirmedTurns: true,
        hasUnanchoredInput: false,
        persistedSessionAnchor: inputAnchor,
      }),
    );

    const restored = harness({ state: () => h.session.getState() });
    await restored.session.ensureStarted();
    expectResumeWithoutPrompts(restored);
  });

  it("anchors a delayed complete prefix but refuses a malformed unterminated tail on restore", async () => {
    const h = harness({ options: anchorProbe });
    await h.session.send("delayed");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(h.session.getState().persistedSessionAnchor).toBeUndefined();
    const assistant = `${JSON.stringify(conversationEntry("reply", "input", "assistant", "later"))}\n`;
    persistFirstInput(h, "delayed", assistant.slice(0, 24));
    await vi.waitFor(() =>
      expect(h.session.getState().persistedSessionAnchor).toMatchObject(inputAnchor),
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
      ready: proofAt("reply", 2),
    });
    await first.session.ensureStarted();
    expect(first.factory.mock.calls[0][0].args).toContain("--session");

    // This is Pi 1.6.0's actual repair: add LF, retain all records, then append.
    fs.appendFileSync(file, "\n");
    appendConversationEntry(file, "next", "reply", "user", "next");
    const second = harness({
      state: () => first.session.getState(),
      ready: proofAt("next", 3),
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
    persistFirstInput(h, "first", "{broken}\n");
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
        messageEntry("input", null, {
          role: "user",
          content: [null, { type: "text", text: "first" }],
        }),
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
        messageEntry("input", null, {
          role: "user",
          content: [{ type: "text", text: "first" }, { type: "image" }],
        }),
      ],
    ],
    [
      "a malformed assistant tool call after the valid input",
      [
        conversationEntry("input", null, "user", "first"),
        messageEntry("broken", "input", {
          role: "assistant",
          content: [{ type: "toolCall", id: "call", name: "read" }],
        }),
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

  it.each([
    "missing",
    "header",
    "branch",
    "corrupt",
    "symlink",
    ...(process.platform === "win32" ? [] : ["fifo"]),
  ])(
    "refuses a once-proved session with %s history before spawning Pi",
    async (damage) => {
      const h = harness({ state: anchored });
      const file = h.state!.sessionFile!;
      if (damage === "missing") fs.rmSync(file);
      if (damage === "header")
        writeSession(file, "wrong", h.dir, [conversationEntry("input", null, "user", "first")]);
      if (damage === "branch") appendConversationEntry(file, "other", null, "assistant", "other");
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
    expectResumeWithoutPrompts(h);
    expect(h.session.getState().hasConfirmedTurns).toBe(true);
  });

  it("preserves the canonical anchor when a settlement checkpoint uses a symlinked path", async () => {
    const h = harness({ options: anchorProbe });
    const { file, sessionId } = await persistFirstReply(h);
    const alias = path.join(h.dir, "session-dir-alias");
    fs.symlinkSync(h.dir, alias);
    settleWithCheckpoint(h, path.join(alias, "session.jsonl"), "reply", 2, sessionId);
    await vi.waitFor(() =>
      expect(h.session.getState()).toMatchObject({
        expectedLeafAnchorId: "reply",
        minEntryCount: 2,
      }),
    );
    expect(h.session.getState().sessionFile).toBe(fs.realpathSync.native(file));

    const restored = harness({ state: () => h.session.getState() });
    await restored.session.ensureStarted();
    expectResumeWithoutPrompts(restored, file);
  });

  it("resumes a confirmed second-turn cut from the exact file without replaying either input", async () => {
    const h = harness({ options: anchorProbe });
    const { file, sessionId } = await persistFirstReply(h);
    settleWithCheckpoint(h, file, "reply", 2, sessionId);
    await vi.waitFor(() =>
      expect(h.session.getState()).toMatchObject({
        hasConfirmedTurns: true,
        expectedLeafAnchorId: "reply",
        minEntryCount: 2,
      }),
    );

    await h.session.send("second");
    appendConversationEntry(file, "second", "reply", "user", "second");
    const cut = h.session.getState();
    expect(cut.hasConfirmedTurns).toBe(true);
    expect(cut.persistedSessionAnchor).toMatchObject(inputAnchor);

    const restored = harness({
      state: () => cut,
      ready: proofAt("second", 3),
    });
    await restored.session.ensureStarted();
    expectResumeWithoutPrompts(restored, file);
    expect(restored.session.getState()).toMatchObject({
      hasConfirmedTurns: true,
      expectedLeafAnchorId: "second",
      minEntryCount: 3,
    });
    expect(promptTexts(h.clients[0].wire)).toEqual(["first", "second"]);
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
    expect(requests(clients[0].wire, "prompt")).toHaveLength(0);
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
      ready: proofAt("bash", 8),
    });
    const file = h.state!.sessionFile!;
    const entries = [
      messageEntry("image", "anchor", {
        role: "user",
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      }),
      messageEntry("call", "image", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ],
      }),
      messageEntry("result", "call", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [
          { type: "text", text: "result" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        isError: false,
      }),
      messageEntry("bash", "result", {
        role: "bashExecution",
        command: "pwd",
        output: "/tmp\n",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      }),
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
      ready: proofAt("found", 2),
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
    expect(requests(old.wire, "abort")).toHaveLength(1);
    expect(requests(old.wire, "clear_queue")).toHaveLength(0);
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
    const h = harness({
      config: { piSubagentsRoot: pkg },
      options: { reconcileIntervalMs: 60_000 },
    });
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
    startSubagent(event, { async: true, tasks: [{ agent: "A" }, { agent: "B" }] }, "batch");
    finishSubagent(event, { runId: "run", asyncDir, mode: "parallel" }, "batch");
    event({ type: "agent_settled" });
    expect(h.session.runState).toBe("waiting");
    expect(backgroundTaskIds(h.session)).toEqual(["batch:0", "batch:1"]);
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
    await vi.waitFor(() => expect(backgroundTaskIds(h.session)).toEqual(["batch:1"]));
    expect(subagentCards(h.events, "subagent_done").map((card) => card?.status)).toEqual([
      "stopped",
    ]);
    fs.writeFileSync(finishB, "");
    await expect(exited).resolves.toEqual([0, null]);
    await h.session.reconcileAsyncRuns();
    await vi.waitFor(() => expect(h.session.runState).toBe("idle"));
    expect(subagentCards(h.events, "subagent_done").map((card) => card?.status)).toEqual([
      "stopped",
      "completed",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("PiSession detached runner cleanup", () => {
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
