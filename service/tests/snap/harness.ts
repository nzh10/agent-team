// Snap fixtures: scripted Codex and Pi tapes replayed
// through the real session, workspace and client aggregation.
import { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PassThrough, Writable } from "node:stream";
import { piReply } from "./pi-wire";
import { seededPng } from "./pixel";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import type { SessionConfig, StreamEvent } from "../../src/session/types";
import { PiSession } from "../../src/session/pi";
import { PiRpcClient, type PiRpcSpawnOptions } from "../../src/session/pi-rpc";
import { PanelHttpServer, type PanelReadyReport } from "../../src/session/panel-http";
import { ProjectManager, type ProjectHost } from "../../src/project/manager";
import { ObjectiveStore } from "../../src/project/objectives";
import { ProjectStore } from "../../src/project/store";
import { ReportJournalStore } from "../../src/project/report-journal";
import { HistoryService } from "../../src/workspace/history-service";
import { CodexSession } from "../../src/session/codex";
import type { RpcMessage, Transport } from "../../src/session/codex-rpc";
import { LocalHost, HostRegistry, type HostSessionHandle } from "../../src/session/host";
import type { PanelToolset } from "../../src/project/tools";
import { Workspace, type Message, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { applyEventsToMessage } from "../../../webview/src/state/stream";

import {
  type Backend,
  type Entry,
  type Fixture,
  type Header,
  type Recording,
  type PiFrame,
  type PiCheckpoint,
  type Replay as BaseReplay,
  DEFAULT_MODEL,
  RECORD_CWD,
  panelTools,
} from "./fixture.ts";

export * from "./fixture.ts";

export const SNAP_DIR = path.dirname(fileURLToPath(import.meta.url));

export function recordingPath(backend: Backend, name: string): string {
  return path.join(SNAP_DIR, backend, `${name}.jsonl`);
}

export function readRecording(file: string): Recording {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const header = (JSON.parse(lines[0]) as { header: Header }).header;
  const entries = lines.slice(1).map((l) => JSON.parse(l) as Entry);
  return { header, entries };
}

export function writeRecording(file: string, header: Header, entries: Entry[]): void {
  const out = [JSON.stringify({ header }), ...entries.map((e) => JSON.stringify(e))];
  fs.writeFileSync(file, out.join("\n") + "\n");
}

export function listFixtures(backend: Backend): string[] {
  const dir = path.join(SNAP_DIR, backend);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export async function loadFixture(backend: Backend, name: string): Promise<Fixture> {
  const mod = (await import(path.join(SNAP_DIR, backend, `${name}.ts`))) as { default: Fixture };
  return mod.default;
}

export interface Replay extends BaseReplay {
  sessions: HostSessionHandle[];
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

// One connection per app-server process. Each recorded write must be the
// session's next write; recorded responses are mapped to its request ids.
class AppServerPlayer {
  private conn: {
    listeners: Array<(m: RpcMessage) => void>;
    closers: Array<(r: string) => void>;
  } | null = null;
  private written: RpcMessage[] = [];
  private ids = new Map<number | string, number | string>();
  private tags = new Map<unknown, unknown>();
  sent: RpcMessage[] = [];

  connect(): Transport {
    const conn = {
      listeners: [] as Array<(m: RpcMessage) => void>,
      closers: [] as Array<(r: string) => void>,
    };
    this.conn = conn;
    return {
      write: (m) => {
        if (this.conn !== conn) return;
        this.written.push(m);
        this.sent.push(m);
      },
      onMessage: (cb) => conn.listeners.push(cb),
      onClose: (cb) => conn.closers.push(cb),
      close: () => {},
    };
  }

  async expect(rec: RpcMessage, where: string): Promise<void> {
    for (let i = 0; i < 40 && this.written.length === 0; i++) {
      await flush();
      if (i >= 10) await new Promise((r) => setTimeout(r, 2));
    }
    const m = this.written.shift();
    const what = (x: RpcMessage | undefined) =>
      !x ? "nothing" : (x.method ?? `the answer to request ${String(x.id)}`);
    const same = m && (rec.method ? m.method === rec.method : !m.method && m.id === rec.id);
    if (!same) {
      throw new Error(
        `replay: the session wrote ${what(m)} where the recorder wrote ${what(rec)} (${where}); re-record if the session's requests changed`,
      );
    }
    const ids = (x: RpcMessage) => {
      const p = (x.params ?? {}) as Record<string, unknown>;
      return [p.threadId, p.turnId, p.expectedTurnId];
    };
    expect(ids(m), `ids of ${what(m)} (${where})`).toEqual(ids(rec));
    if (rec.method && rec.id != null && m.id != null) this.ids.set(rec.id, m.id);
    const tag = (x: RpcMessage) =>
      (x.params as { clientUserMessageId?: unknown })?.clientUserMessageId;
    if (tag(rec) !== undefined) this.tags.set(tag(rec), tag(m));
  }

  finish(): void {
    expect(
      this.written.map((m) => m.method ?? `answer ${String(m.id)}`),
      "unrecorded writes",
    ).toEqual([]);
  }

  play(frame: RpcMessage): void {
    let m =
      !frame.method && frame.id != null
        ? { ...frame, id: this.ids.get(frame.id) ?? frame.id }
        : frame;
    const params = m.params as { item?: { clientId?: unknown } } | undefined;
    const clientId = params?.item?.clientId;
    if (clientId != null && this.tags.has(clientId)) {
      m = {
        ...m,
        params: { ...params, item: { ...params!.item, clientId: this.tags.get(clientId) } },
      };
    }
    for (const cb of this.conn?.listeners ?? []) cb(m);
  }

  close(): void {
    const conn = this.conn;
    this.conn = null;
    for (const cb of conn?.closers ?? []) cb("the backend exited (recording)");
  }
}

class SnapHost extends LocalHost {
  created: HostSessionHandle[] = [];
  createSession(agentId: string, config: Parameters<LocalHost["createSession"]>[1]) {
    const s = super.createSession(agentId, config);
    this.created.push(s);
    return s;
  }
}

function makeWorkspace(
  model: string,
  effort: string | undefined,
  cb: WorkspaceCallbacks = {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
  },
) {
  const host = new SnapHost("local", "Local");
  const registry = new HostRegistry();
  registry.register(host);
  const ws = new Workspace("ws", "t", "p", "local", RECORD_CWD, registry, cb);
  ws.addAgent("A", model, "🤖", "#888", { backend: "codex", effort });
  return { ws, host };
}

function restart(ws: Workspace, host: SnapHost, tools: PanelToolset | null): void {
  const attach = (
    ws as unknown as {
      attachSession(id: string, s: HostSessionHandle): (e: StreamEvent) => void;
    }
  ).attachSession.bind(ws);
  for (const [id, entry] of ws.agents) {
    const session = host.restoreSession(id, entry.session.getState());
    session.setPanelTools?.(tools);
    host.created.push(session);
    entry.handler = attach(id, session);
    entry.session = session;
  }
}

export async function replay(
  backend: Backend,
  rec: Recording,
  fixture: Fixture,
  cb?: WorkspaceCallbacks,
): Promise<Replay> {
  if (backend === "pi") return replayPi(rec, fixture, cb);
  const model = rec.header.model || DEFAULT_MODEL[backend];
  const { ws, host } = makeWorkspace(model, fixture.effort, cb);
  const tools = fixture.tools ? panelTools(fixture.tools, fixture.instructions) : null;
  for (const entry of ws.agents.values()) entry.session.setPanelTools?.(tools);
  const events: StreamEvent[] = [];
  const states: string[] = [];
  const limits: Replay["limits"] = [];
  const seen = new Set<HostSessionHandle>();
  const attach = () => {
    for (const s of host.created) {
      if (seen.has(s)) continue;
      seen.add(s);
      s.on("event", (e: StreamEvent) => events.push(JSON.parse(JSON.stringify(e)) as StreamEvent));
      s.on("runState", (st: string) => states.push(st));
      s.on("rateLimit", (info: Replay["limits"][number]) => limits.push(info));
      s.on("steered", () => events.push({ kind: "steered" as StreamEvent["kind"], content: "" }));
    }
  };

  const player = new AppServerPlayer();
  const end = rec.entries.at(-1)?.t ?? 0;
  const base = (Date.parse(rec.header.recordedAt) || Date.now()) - end;
  const at = (t: number) => {
    if (vi.isFakeTimers()) vi.setSystemTime(base + t);
  };

  CodexSession.hooks = {
    transport: (session) => {
      if (!host.created.includes(session)) throw new Error("a session from another replay");
      return player.connect();
    },
  };

  const running: Promise<unknown>[] = [];
  try {
    for (const [i, e] of rec.entries.entries()) {
      at(e.t);
      if ("step" in e) {
        const op = e.step.op;
        if (op === "send" && !e.step.requeued) running.push(ws.sendMessage(e.step.text));
        else if (op === "compact") running.push(ws.sendMessage("/compact"));
        else if (op === "interrupt" || op === "abort") running.push(ws.interruptAll());
        else if (op === "end") restart(ws, host, tools);
        await flush();
        attach();
      } else if ("sent" in e) {
        await player.expect(e.sent as RpcMessage, `entry ${i + 1}`);
      } else if ("frame" in e) {
        player.play(e.frame as RpcMessage);
        await flush();
      } else if ("close" in e) {
        player.close();
        await flush();
      }
    }
    await Promise.all(running);
    await flush();
    player.finish();
  } finally {
    CodexSession.hooks = null;
  }

  return {
    messages: ws.messages,
    events,
    states,
    limits,
    sessions: host.created,
    sent: player.sent,
  };
}

// A real PiRpcClient reads LF-delimited stdout and writes to a controlled stdin.
// Only startup replies are supplied by the player; turn traffic is tape-ordered.
// This does not launch Pi or verify extension registration in a real process.
class PiRpcPlayer {
  readonly sent: PiFrame[] = [];
  readonly connections: Array<{ restored: boolean }> = [];
  private readonly written: PiFrame[] = [];
  private readonly awaiting = new Map<string, string>();
  private readonly anchors = new Map<string, PiFrame>();
  private readonly streams: PassThrough[] = [];
  private readonly ready: Promise<unknown>[] = [];
  private route?: { url: string; token: string };
  private stdout?: PassThrough;
  private exit?: (code: number) => void;
  private readonly entries: Array<Record<string, unknown>> = [];
  image?: Buffer;

  constructor(
    private readonly dir: string,
    private readonly model: string,
    private readonly contextWindow: number,
  ) {}

  connect = (opts: PiRpcSpawnOptions): PiRpcClient => {
    const arg = (name: string) => {
      const i = opts.args!.indexOf(name);
      return i < 0 ? undefined : opts.args![i + 1];
    };
    const saved = arg("--session");
    const sessionFile = path.join(this.dir, "session.jsonl");
    if (saved)
      expect(saved === sessionFile, "restore reopens the synthetic session file").toBe(true);
    const sessionId = saved
      ? (JSON.parse(fs.readFileSync(saved, "utf8").split("\n")[0]) as { id: string }).id
      : arg("--session-id")!;
    if (!saved)
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: opts.cwd }) + "\n",
      );
    this.connections.push({ restored: Boolean(saved) });
    this.route = {
      url: `${opts.env!.YAAT_PANEL_URL}/v1/sessions/${encodeURIComponent(opts.env!.YAAT_PANEL_KEY!)}`,
      token: opts.env!.YAAT_PANEL_TOKEN!,
    };
    const ready: PanelReadyReport = {
      sessionProof: {
        sessionId,
        sessionFile,
        cwd: opts.cwd!,
        headerCwd: opts.cwd!,
        entryCount: this.entries.length,
        leafId: (this.entries.at(-1)?.id as string | undefined) ?? null,
        anchorOnActiveBranch: true,
        anchorExistsInFile: true,
      },
      ownerToolNames: [],
      requiredExtensionsRegistered: true,
      subagentsRpcReady: true,
      subagentsSessionId: sessionId,
    };
    const bridge = this.post("ready", ready);
    void bridge.catch(() => undefined);
    this.ready.push(bridge);
    const stdout = new PassThrough();
    this.stdout = stdout;
    this.streams.push(stdout);
    const [provider, id] = this.model.split("/");
    const model = { provider, id, contextWindow: this.contextWindow };
    const startup = [
      ["get_state", { model, sessionId, sessionFile, thinkingLevel: "low" }],
      ["get_available_models", { models: [model] }],
      ["get_commands", { commands: [] }],
      ["get_available_thinking_levels", { levels: ["low"] }],
    ] as const;
    let next = 0;
    const stdin = new Writable({
      write: (chunk: Buffer, _, done) => {
        const command = JSON.parse(chunk.toString()) as PiFrame;
        const boot = startup[next];
        if (boot && boot[0] === command.type) {
          next++;
          const reply = piReply(command.type);
          this.play({ ...reply, id: command.id, data: { ...(reply.data as object), ...boot[1] } });
        } else {
          this.sent.push(command);
          this.written.push(command);
          if (command.type === "prompt") this.persistPrompt(command);
        }
        done();
      },
    });
    // Deliver the actual child exit notification without launching a process.
    const child = new ChildProcess();
    const exit = (code: number) => {
      if (child.exitCode !== null) return;
      Object.assign(child, { exitCode: code });
      child.emit("exit", code, null);
      stdout.end();
    };
    this.exit = exit;
    stdin.on("finish", () => exit(0));
    return new PiRpcClient({ stdin, stdout, child }, { requestTimeoutMs: 1500 });
  };

  private persistPrompt(command: PiFrame): void {
    const id = `entry-${this.entries.length + 1}`;
    const entry = {
      type: "message",
      id,
      parentId: (this.entries.at(-1)?.id as string | undefined) ?? null,
      message: { role: "user", content: String(command.message) },
    };
    this.entries.push(entry);
    fs.appendFileSync(path.join(this.dir, "session.jsonl"), JSON.stringify(entry) + "\n");
  }

  private async post(endpoint: string, body: unknown): Promise<unknown> {
    const { url, token } = this.route!;
    const response = await fetch(`${url}/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    expect(response.status, `Panel HTTP ${endpoint}`).toBe(200);
    return response.json();
  }

  async expect(expected: PiFrame): Promise<void> {
    await expect
      .poll(() => this.written.length, {
        timeout: 1000,
        interval: 5,
        message: `waiting for Pi ${expected.type} ${typeof expected.message === "string" ? expected.message : ""}`,
      })
      .toBeGreaterThan(0);
    const { id, ...frame } = this.written.shift()!;
    if (frame.type === "extension_ui_response") frame.id = id;
    else {
      expect(typeof id).toBe("string");
      expect(this.awaiting.has(frame.type)).toBe(false);
      this.awaiting.set(frame.type, id as string);
    }
    if (frame.images && this.image) {
      const images = frame.images as Array<{ type?: string; mimeType?: string; data?: string }>;
      expect(images).toHaveLength(1);
      expect(images.map(({ type, mimeType }) => ({ type, mimeType }))).toEqual([
        { type: "image", mimeType: "image/png" },
      ]);
      expect(
        images[0].data === this.image.toString("base64"),
        "Pi sends the exact seeded image bytes",
      ).toBe(true);
      frame.images = [{ type: "image", mimeType: "image/png", data: "generated-png" }];
    }
    expect(frame).toEqual(expected);
  }

  play(frame: PiFrame): void {
    if (frame.type === "response" && frame.id === undefined) {
      const command = String(frame.command);
      const id = this.awaiting.get(command);
      expect(id, `request before response to ${command}`).toBeDefined();
      this.awaiting.delete(command);
      frame = { success: true, ...frame, id };
    }
    if (frame.type === "tool_execution_start") this.anchors.set(String(frame.toolCallId), frame);
    if (frame.type === "tool_execution_end") this.anchors.delete(String(frame.toolCallId));
    this.stdout!.write(JSON.stringify(frame) + "\n");
  }

  async panelCall(callId: string): Promise<void> {
    const call = this.anchors.get(callId);
    expect(call, "open Pi tool call before Panel HTTP dispatch").toBeDefined();
    const { text, isError } = (await this.post("call", {
      name: call!.toolName,
      params: call!.args,
      callId,
    })) as { text: string; isError: boolean };
    expect(isError, `Panel tool ${JSON.stringify(call!.toolName)} failed`).toBe(false);
    this.play({
      type: "tool_execution_end",
      toolName: call!.toolName,
      toolCallId: callId,
      result: { content: [{ type: "text", text }] },
      isError,
    });
  }

  crash(): void {
    this.finishWrites();
    this.awaiting.clear(); // a process can die with a request outstanding
    this.anchors.clear();
    this.exit!(1);
  }

  private finishWrites(): void {
    expect(
      this.written.map((m) => m.type),
      "unrecorded Pi writes",
    ).toEqual([]);
  }

  async finish(): Promise<void> {
    await Promise.all(this.ready);
    this.finishWrites();
    expect([...this.awaiting.keys()], "unanswered Pi requests").toEqual([]);
  }

  close(): void {
    for (const stream of this.streams) stream.destroy();
  }
}

// Resolve only explicit artifact slots. No host paths appear in the tape.
function piArtifacts(value: unknown, dir: string): unknown {
  if (typeof value === "string" && /^\$child-\d+$/.test(value))
    return path.join(dir, value.slice(1) + ".jsonl");
  if (value === "$owner-session") return path.join(dir, "session.jsonl");
  if (value === "$async-dir") return path.join(dir, "async");
  if (Array.isArray(value)) return value.map((v) => piArtifacts(v, dir));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, piArtifacts(v, dir)]));
  return value;
}

async function replayPi(
  rec: Recording,
  fixture: Fixture,
  cb?: WorkspaceCallbacks,
): Promise<Replay> {
  const base = Date.parse(rec.header.recordedAt) - (rec.entries.at(-1)?.t ?? 0);
  if (vi.isFakeTimers()) vi.setSystemTime(base);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yaat-pi-snap-")));
  const panel = new PanelHttpServer();
  const stats = rec.entries
    .flatMap((entry) =>
      "frame" in entry
        ? [
            entry.frame as {
              command?: string;
              data?: { contextUsage?: { contextWindow?: number } };
            },
          ]
        : [],
    )
    .find((frame) => frame.command === "get_session_stats");
  const player = new PiRpcPlayer(
    dir,
    rec.header.model || DEFAULT_MODEL.pi,
    stats?.data?.contextUsage?.contextWindow ?? 1000,
  );
  const sessions: PiSession[] = [];
  const events: StreamEvent[] = [];
  const states: string[] = [];
  const pi: NonNullable<Replay["pi"]> = {
    checkpoints: {},
    dialogs: [],
    sent: player.sent,
    connections: player.connections,
  };
  const uploadsDir = path.join(dir, "uploads");
  fs.mkdirSync(uploadsDir);
  const registry = new HostRegistry();
  registry.register(
    new (class extends LocalHost {
      override createSession(agentId: string, config: SessionConfig) {
        const session = new PiSession(
          { ...config, agentId, piAgentDir: dir, uploadsDir },
          { panelHttp: panel, rpcFactory: player.connect, readyTimeoutMs: 1500 },
        );
        sessions.push(session);
        session.on("event", (event: StreamEvent) => events.push(structuredClone(event)));
        session.on("runState", (state: string) => states.push(state));
        return session;
      }
    })("local", "Local"),
  );
  const callbacks: WorkspaceCallbacks = {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
    ...cb,
    onUiDialogRequest: (dialog) => {
      pi.dialogs.push({ kind: "request", id: dialog.requestId });
      cb?.onUiDialogRequest?.(dialog);
    },
    onUiDialogResolved: (dialog) => {
      pi.dialogs.push({ kind: "resolved", id: dialog.requestId });
      cb?.onUiDialogResolved?.(dialog);
    },
  };
  const ws = new Workspace("ws", "t", "p", "local", dir, registry, callbacks);
  const agent = ws.addAgent("A", rec.header.model || DEFAULT_MODEL.pi, "🤖", "#888", {
    backend: "pi",
    workspaceId: ws.id,
  });
  const session = sessions[0];
  const running: Promise<unknown>[] = [];
  let project: ReturnType<typeof makePiProject> | undefined;
  try {
    if (fixture.piProject) project = makePiProject(dir, registry, ws, session);
    const steps = rec.entries.flatMap((e) => ("step" in e ? [e.step] : []));
    expect(steps).toEqual(fixture.steps.map((step, i) => ({ ...step, i })));
    for (const entry of rec.entries) {
      if (vi.isFakeTimers()) vi.setSystemTime(base + entry.t);
      if ("step" in entry) {
        const step = entry.step;
        switch (step.op) {
          case "send":
            running.push(ws.sendMessage(step.text));
            break;
          case "image": {
            const name = "pixel.png";
            const file = path.join(uploadsDir, name);
            player.image = seededPng(step.seed);
            fs.writeFileSync(file, player.image);
            running.push(
              ws.sendMessage(step.text, undefined, [{ name, url: `/uploads/${name}`, path: file }]),
            );
            break;
          }
          case "interrupt":
            running.push(ws.interruptAll());
            break;
          case "uiDialogResponse": {
            const dialog = ws.getPendingDialogs()[0];
            expect(dialog?.requestId).toBe(step.requestId);
            ws.respondToUiDialog(agent.id, dialog.processGeneration, step.requestId, step);
            break;
          }
          case "panelCall":
            expect(project, "real project toolset").toBeDefined();
            await player.panelCall(step.callId);
            break;
          case "check": {
            const checkpoint: PiCheckpoint = {
              canSteer: session.canSteer,
              runState: session.runState,
              userStatuses: ws.messages.filter((m) => m.kind === "user").map((m) => m.status),
              prompts: player.sent.filter((m) => m.type === "prompt").map((m) => String(m.message)),
              terminalCount: events.filter((e) => e.kind === "result" || e.kind === "error").length,
              retryBanner:
                [...ws.messages]
                  .reverse()
                  .find((m) => m.kind === "agent")
                  ?.events?.find((e) => e.kind === "retry")?.content ?? null,
              thinkingClosed: events.some(
                (e) =>
                  e.kind === "thinking_delta" && e.content === "" && e.durationMs !== undefined,
              ),
              pendingDialogIds: ws.getPendingDialogs().map((d) => d.requestId),
              contextUsage: await session.getContextUsage(),
              backgroundTasks: session.backgroundTaskList,
              lastEnvelope: ws.agents.get(agent.id)?.lastEnvelope,
              generation: ws.messages.filter((m) => m.kind === "user").at(-1)?.dispatchAttempt
                ?.generation,
            };
            pi.checkpoints[step.name] = structuredClone(checkpoint);
            break;
          }
          default:
            throw new Error(`Unsupported Pi step ${step.op}`);
        }
      } else if ("sent" in entry) await player.expect(entry.sent as PiFrame);
      else if ("frame" in entry) player.play(piArtifacts(entry.frame, dir) as PiFrame);
      else if ("artifacts" in entry) {
        for (const [slot, records] of Object.entries(entry.artifacts)) {
          if (!/^\$child-\d+$/.test(slot) && slot !== "$async-status")
            throw new Error("Unknown artifact slot");
          const file =
            slot === "$async-status"
              ? path.join(dir, "async", "status.json")
              : (piArtifacts(slot, dir) as string);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(
            file,
            records.map((rec) => JSON.stringify(piArtifacts(rec, dir))).join("\n") + "\n",
          );
        }
      } else if ("close" in entry) player.crash();
      else throw new Error("Unsupported Pi tape entry");
      await flush();
    }
    await player.finish();
    await Promise.all(running);
    project?.verify();
    return { messages: ws.messages, events, states, sessions, limits: [], sent: [], pi };
  } finally {
    try {
      await Promise.all(sessions.map((s) => s.dispose(1000)));
      await project?.close();
    } finally {
      player.close();
      await panel.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function makePiProject(dir: string, registry: HostRegistry, worker: Workspace, session: PiSession) {
  const workspaces = new Map([[worker.id, worker]]);

  const history = new HistoryService(path.join(dir, "history.db"), path.join(dir, "history.jsonl"));
  const host: ProjectHost = {
    workspaces: () => workspaces.values(),
    workspace: (id) => workspaces.get(id),
    createWorkspace(name, cwd, link) {
      const lead = new Workspace("lead", name, "p", "local", cwd, registry, {
        canDequeue: () => false,
        onNewMessage: () => {},
        onStreamEvent: () => {},
        onMessageDone: () => {},
      });
      lead.projectLink = link;
      workspaces.set(lead.id, lead);
      return lead;
    },
    addAgent: (ws, name, model, avatar, color) => {
      ws.addAgent(name, model, avatar, color, { backend: "pi" });
    },
    removeWorkspace: (id) => {
      workspaces.delete(id);
    },
    archiveWorkspace: () => false,
    restoreWorkspace: () => false,
    loadWorkspace: () => true,
    history,
    isLeadOnline: () => true,
    modelOptions: () => [{ id: DEFAULT_MODEL.pi, label: DEFAULT_MODEL.pi, backend: "pi" }],
    persistWorkspace: () => {},
    saveWorkspaceNow: () => {},
    workspaceChanged: () => {},
    broadcast: () => {},
  };
  const manager = new ProjectManager(dir, host);
  const project = manager.create("Synthetic project", null, DEFAULT_MODEL.pi);
  worker.projectLink = { projectId: project.id, role: "worker" };
  const projectStore = new ProjectStore(dir);
  const board = new ObjectiveStore(projectStore.objectivesDir(project.id));
  board.write({
    id: "pi-e2e/suite",
    area: "pi-e2e",
    title: "Seed objective",
    goal: "Exercise a project update.",
    status: "active",
    priority: "normal",
    dependsOn: [],
    decisions: [],
    sessions: [worker.id],
    tasks: [{ id: "t1", text: "Replay a sample.", state: "doing", session: worker.id }],
    updatedAt: Date.now(),
  });
  session.setPanelTools(manager.toolsFor(worker));
  return {
    verify() {
      const store = new ProjectStore(dir);
      expect(store.get(project.id)).toMatchObject({ name: "Synthetic project", status: "active" });
      expect(fs.readFileSync(path.join(store.notesDir(project.id), "design.md"), "utf8")).toContain(
        "pi-e2e note body",
      );
      expect(manager.list().find((p) => p.id === project.id)?.objectives).toEqual([
        expect.objectContaining({
          id: "pi-e2e/suite",
          title: "Pi E2E",
          context: "reviewed by scenario",
          tasks: [{ id: "t1", text: "Replay a sample.", state: "review", session: worker.id }],
        }),
      ]);
      const report = new ReportJournalStore()
        .load(store.projectDir(project.id))
        .find((entry) => entry.callId === "report");
      expect(report).toMatchObject({
        kind: "final",
        boardState: "applied",
        leadDelivery: { state: "enqueued" },
        payload: { text: "pi-e2e-worker-report", context: "reviewed by scenario" },
        frozenPlan: {
          taskTransitions: [
            { objectiveId: "pi-e2e/suite", taskId: "t1", expectedSession: worker.id },
          ],
        },
      });
      expect(
        fs.readFileSync(path.join(store.objectivesDir(project.id), "pi-e2e", "suite.toml"), "utf8"),
      ).toContain("reviewed by scenario");
    },
    async close() {
      manager.close();
      await history.close();
    },
  };
}

// --- transcript -------------------------------------------------------------

const q = (s: string | undefined, max = 100): string => {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > max ? one.slice(0, max) + "…" : one);
};

function renderEvents(
  events: StreamEvent[],
  indent: string,
  out: string[],
  backend: Backend,
): void {
  for (const e of events) {
    switch (e.kind) {
      case "subagent_progress":
      case "subagent_done":
        // Folded into their start by the aggregation.
        continue;
      case "subagent_start": {
        const sa = e.subagent!;
        const label = [sa.agentType, sa.taskType].filter(Boolean).join("/");
        const ran = sa.durationMs != null ? ` ${sa.durationMs}ms` : "";
        out.push(
          `${indent}card ${label} ${sa.status ?? "?"}${ran} ${q(sa.prompt ?? sa.description)}`,
        );
        renderEvents(sa.events ?? [], indent + "  ", out, backend);
        if (sa.summary) out.push(`${indent}  summary ${q(sa.summary)}`);
        continue;
      }
      case "tool_use": {
        // A real Notes response includes the filesystem mtime, outside the replay clock.
        const text =
          backend === "pi" && e.toolName === "mcp__panel__write_note"
            ? e.toolResult?.replace(/"updatedAt":\d+(?:\.\d+)?/, '"updatedAt":"<mtime>"')
            : e.toolResult;
        const result =
          text == null ? " → (pending)" : ` → ${e.toolResultIsError ? "error " : ""}${q(text, 80)}`;
        const took = e.durationMs != null ? ` ${e.durationMs}ms` : "";
        out.push(`${indent}tool ${e.toolName ?? "?"} ${q(e.content)}${result}${took}`);
        continue;
      }
      case "tool_result":
        out.push(`${indent}orphan tool_result ${e.isError ? "error " : ""}${q(e.content, 80)}`);
        continue;
      case "notice":
        out.push(`${indent}notice:${e.level ?? "info"} ${q(e.content)}`);
        continue;
      case "text":
        if (backend === "pi" && indent.length > 2) out.push(`${indent}text ${q(e.content, 80)}`);
        continue;
      case "text_delta":
      case "thinking_delta":
        continue;
      default:
        out.push(`${indent}${e.kind} ${q(e.content, 80)}`);
    }
  }
}

export function transcript(messages: Message[], backend: Backend = "codex"): string {
  const out: string[] = [];
  messages.forEach((m, i) => {
    const meta = [
      m.kind,
      m.status,
      m.context && `ctx ${m.context.tokens}/${m.context.window}`,
      m.thinking && `thought ${m.thinking.tokens} tokens`,
    ]
      .filter(Boolean)
      .join(" ");
    out.push(`## ${i + 1} ${meta}`);
    let content = m.content;
    if (backend === "pi" && m.kind === "system") {
      for (const [index, input] of messages.entries()) {
        if (input.status === "outcome_unknown")
          content = content.replace(input.id, `#${index + 1}`);
      }
    }
    if (content) out.push(`  text ${q(content, 200)}`);
    renderEvents(m.events ?? [], "  ", out, backend);
  });
  return out.join("\n") + "\n";
}

// --- client convergence -----------------------------------------------------

type ClientMessage = Parameters<typeof applyEventsToMessage>[0];

// The client rebuilds the transcript from broadcast events; it must match
// what the workspace built server-side.
export function clientView(events: StreamEvent[], backend: Backend = "codex"): Message[] {
  const msgs: ClientMessage[] = [];
  let cur: ClientMessage | null = null;
  // The reply an error finished; the turn's result has nothing left to end.
  let failed = false;
  for (const raw of events) {
    const e = backend === "pi" && raw.kind === "subagent_done" ? stripChildTranscript(raw) : raw;
    if (e.kind === "text") continue;
    if (e.kind === "result" && !cur && failed) {
      failed = false;
      continue;
    }
    failed = false;
    // The workspace settled the reply and opened one under the steered
    // message; the client learns that from the messages themselves.
    if ((e.kind as string) === "steered") {
      if (cur) cur.status = "done";
      cur = null;
      continue;
    }
    // A card update goes to the newest message holding the card, as the
    // workspace routes it; a resumed agent has a card in an older one too.
    const taskId = e.subagent?.taskId;
    const holds = (m: ClientMessage) =>
      m.events!.some((x) => x.kind === "subagent_start" && x.subagent?.taskId === taskId);
    const owner =
      taskId && (e.kind === "subagent_progress" || e.kind === "subagent_done")
        ? [...msgs].reverse().find(holds)
        : undefined;
    if (owner && owner !== cur) {
      msgs[msgs.indexOf(owner)] = applyEventsToMessage(owner, [e]);
      continue;
    }
    // A result for a call an earlier reply made, as the workspace routes it.
    const caller =
      e.kind === "tool_result" &&
      !cur?.events!.some((x) => x.kind === "tool_use" && x.toolUseId === e.toolUseId)
        ? [...msgs]
            .reverse()
            .find((m) =>
              m.events!.some((x) => x.kind === "tool_use" && x.toolUseId === e.toolUseId),
            )
        : undefined;
    if (caller) {
      msgs[msgs.indexOf(caller)] = applyEventsToMessage(caller, [e]);
      continue;
    }
    if (!cur) {
      cur = {
        id: `m${msgs.length}`,
        kind: "agent",
        agentId: "a",
        content: "",
        timestamp: 0,
        status: "streaming",
        events: [],
      };
      msgs.push(cur);
    }
    if (e.kind === "result") {
      // message_done follows with the server's final events, which no
      // longer carry a retry banner once the retried call succeeded.
      cur.events = cur.events!.filter((x) => x.kind !== "retry");
      cur.status = "done";
      if (backend === "pi") {
        cur.context = e.context;
        cur.effort = e.effort;
        cur.thinking = e.thinking;
        if (e.interrupted)
          cur.content = [cur.content, "*\\[interrupted\\]*"].filter(Boolean).join("\n\n");
      }
      cur = null;
      continue;
    }
    const next = applyEventsToMessage(cur, [e]);
    msgs[msgs.indexOf(cur)] = next;
    // An error ends the reply, as the workspace finishes it.
    failed = e.kind === "error";
    if (failed && backend === "pi") next.status = "error";
    cur = failed ? null : next;
  }
  return msgs as unknown as Message[];
}

export const strip = (m: Message): unknown =>
  JSON.parse(
    JSON.stringify(m.events, (k: string, v: unknown) =>
      k === "_innerEvent" || k === "contentOffset" || k === "step" || k === "toolInput"
        ? undefined
        : v,
    ),
  ) as unknown;

export function stripChildTranscript(event: StreamEvent): StreamEvent {
  const child = event.subagent;
  if (!child?.events) return event;
  const { events, ...summary } = child;
  const count = Math.max(summary.eventCount ?? 0, events.length);
  return {
    ...event,
    subagent: { ...summary, eventCount: count || (event.kind === "subagent_done" ? 0 : undefined) },
  };
}
