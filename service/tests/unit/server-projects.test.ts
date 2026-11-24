// The real Server in-process over a seeded data dir, with in-memory sessions.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import { createConnection } from "node:net";
import * as path from "path";
import WebSocket from "ws";
import type { Message, WorkspaceState, AgentState } from "../../src/workspace/workspace";
import type { Project } from "../../src/project/store";
import type { Objective } from "../../src/project/objectives";

import { Server } from "../../src/server/server";
import { ProjectManager } from "../../src/project/manager";
import { closeHistory, historyOf, saveIndex, saveWorkspace } from "../../src/workspace/state";
import type { PiAvailableModel, PromptEnvelope, SessionConfig } from "../../src/session/types";
import * as codex from "../../src/session/codex";
import * as acpReadiness from "../../src/session/acp-readiness";
import { LocalHost } from "../../src/session/host";
import {
  ACP,
  NATIVE_CODEX,
  QUOTA_AUTO_REFRESH_INTERVAL,
  type QuotaState,
} from "../../src/session/quota-schema";
import { FakeSession } from "./fakes";

interface FakeTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}
interface Launch {
  cwd: string | undefined;
  model?: string;
  effort?: string;
  panel?: { instructions: string; tools: FakeTool[] };
  env?: Record<string, string | undefined>;
  prompts: string[];
  emit: (frame: unknown) => void;
}

let launches: Launch[] = [];
let sessionsByAgent = new Map<string, TestSession>();
const ENV_KEYS = ["HOME", "AGY_ACP_BIN", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
let savedEnv: Record<string, string | undefined>;

class TestSession extends FakeSession {
  private launch: Launch | null = null;
  availableModels: PiAvailableModel[] = [];
  constructor(private readonly sessionConfig: SessionConfig) {
    super(sessionConfig);
  }

  getAvailableModels(): PiAvailableModel[] {
    return this.availableModels;
  }

  send(input: string | PromptEnvelope): Promise<void> {
    const text = typeof input === "string" ? input : input.text;
    if (!this.launch) {
      this.launch = {
        cwd: this.sessionConfig.cwd,
        model: this.sessionConfig.model,
        effort: this.sessionConfig.effort,
        env: this.providerEnv,
        prompts: [],
        emit: (frame) => this.emitFrame(frame),
      };
      const tools = this.panelTools;
      if (tools) {
        this.launch.panel = {
          instructions: tools.instructions,
          tools: tools.tools.map((tool) => ({
            name: tool.name,
            handler: async (args) => ({ content: [{ text: await tool.handler(args) }] }),
          })),
        };
      }
      launches.push(this.launch);
    }
    this.launch.prompts.push(text);
    return super.send(input);
  }

  override abort(): void {
    this.isRunning = false;
  }

  private emitFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object") return;
    const f = frame as {
      type?: string;
      kind?: string;
      result?: string;
      is_error?: boolean;
      rate_limit_info?: { rateLimitType?: string; resetsAt?: number };
    };
    if (f.type === "rate_limit_event") {
      this.emit("rateLimit", f.rate_limit_info ?? {});
      return;
    }
    if (f.type === "result") {
      this.isRunning = false;
      this.emit("event", {
        kind: f.is_error ? "error" : "result",
        content: f.result ?? "",
      });
      return;
    }
    if (f.kind) {
      if (f.kind === "result" || f.kind === "error") this.isRunning = false;
      this.emit("event", frame);
    }
  }
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"]) delete process.env[k];
  launches = [];
  sessionsByAgent = new Map();
  vi.spyOn(codex, "probeCodexAuth").mockResolvedValue({
    cliAvailable: true,
    authenticated: true,
    status: "authenticated",
    accountType: "apiKey",
    checkedAt: Date.now(),
  });
  vi.spyOn(LocalHost.prototype, "createSession").mockImplementation((id, config) => {
    const s = new TestSession(config);
    sessionsByAgent.set(id, s);
    return s;
  });
  vi.spyOn(LocalHost.prototype, "restoreSession").mockImplementation((id, state) => {
    const s = new TestSession(state.config);
    sessionsByAgent.set(id, s);
    return s;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;

const until = async (cond: () => boolean, what: string) => {
  const deadline = realNow() + 5000;
  while (!cond() && realNow() < deadline) {
    await new Promise<void>((r) => realSetTimeout(r, 2));
  }
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

function agent(id: string, name: string, cwd: string): AgentState {
  return {
    id,
    name,
    model: "gpt-6-astra",
    avatar: "A",
    color: "#fff",
    isDefault: true,
    session: {
      sessionId: null,
      config: { cwd, backend: "codex", model: "gpt-6-astra" },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
    },
  };
}

const HISTORY: Message[] = [
  { id: "h1", kind: "user", agentId: null, content: "old prompt", timestamp: 1000, status: "done" },
  {
    id: "h2",
    kind: "agent",
    agentId: "a-w",
    content: "old reply",
    timestamp: 1001,
    status: "done",
  },
];

// A project "demo" with its lead, one archived worker with history, one live
// worker, and a workspace still linked to a project that no longer exists.
// livePaused, orphanPaused: ms from now (past or future) to the reset the
// live worker's and the orphan's pending rate-limit retries wait for (the
// orphan's is the live one's unless given); liveQueued: a message still queued
// for the live worker.
function seed(
  opts: {
    leadArchived?: boolean;
    livePaused?: number;
    orphanPaused?: number;
    liveQueued?: boolean;
    liveCodex?: boolean;
  } = {},
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-server-projects-"));
  const root = path.join(base, "repo");
  const web = path.join(base, "web");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(path.join(base, "home"));
  fs.writeFileSync(path.join(web, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(base, "config.toml"), "");
  process.env.HOME = path.join(base, "home");

  const pdir = path.join(base, ".agent-team", "projects", "proj-1");
  fs.mkdirSync(path.join(pdir, "notes"), { recursive: true });
  const project: Omit<Project, "schemaVersion" | "status" | "lead"> = {
    id: "proj-1",
    name: "demo",
    root,
    leadWorkspaceId: "ws-lead",
    createdAt: 1,
  };
  fs.writeFileSync(path.join(pdir, "project.json"), JSON.stringify(project));
  fs.mkdirSync(path.join(pdir, "objectives", "core"), { recursive: true });
  fs.writeFileSync(
    path.join(pdir, "objectives", "core", "o.toml"),
    'title = "o"\ngoal = "g"\nsessions = ["ws-w", "ws-live"]\n',
  );

  const now = Date.now();
  const paused = (ms?: number) =>
    ms !== undefined && { pausedUntil: now + ms, lastPrompt: "carry on" };
  const cache = path.join(base, ".agent-team", "cache");
  fs.mkdirSync(path.join(cache, "workspaces"), { recursive: true });
  const states: WorkspaceState[] = [
    {
      id: "ws-lead",
      name: "demo · lead",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [agent("a-lead", "Lead", root)],
      createdAt: 1,
      archivedAt: opts.leadArchived ? 5 : null,
      messages: [],
      projectLink: { projectId: "proj-1", role: "lead" },
    },
    {
      id: "ws-w",
      name: "worker",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [agent("a-w", "Worker", root)],
      createdAt: 1,
      archivedAt: 5,
      messages: HISTORY,
      projectLink: { projectId: "proj-1", role: "worker" },
    },
    {
      id: "ws-live",
      name: "live",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [
        {
          ...agent("a-live", "Live", root),
          ...paused(opts.livePaused),
          ...(opts.liveCodex && {
            model: "gpt-6-astra",
            session: {
              sessionId: null,
              config: { cwd: root, backend: "codex" as const, model: "gpt-6-astra" },
              usage: agent("a-live", "Live", root).session.usage,
            },
          }),
        },
      ],
      createdAt: now,
      messages: opts.liveQueued
        ? [
            {
              id: "q1",
              kind: "user",
              agentId: null,
              content: "go on",
              timestamp: now,
              status: "queued",
              queuedFor: "a-live",
              queuedEnvelope: { inputId: "q1", text: "go on" },
            },
          ]
        : [],
      projectLink: { projectId: "proj-1", role: "worker" },
    },
    {
      id: "ws-orphan",
      name: "orphan",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [{ ...agent("a-o", "O", root), ...paused(opts.orphanPaused ?? opts.livePaused) }],
      createdAt: now,
      messages: [],
      projectLink: { projectId: "proj-gone", role: "worker" },
    },
  ];
  for (const s of states) saveWorkspace(base, s);
  saveIndex(
    base,
    states.map((s) => s.id),
  );
  closeHistory(base);
  return { base, root, web };
}

async function start(base: string, web: string, deploy = false, bootFence?: string) {
  const server = new Server(
    0,
    base,
    web,
    deploy
      ? { baseDir: base, port: 0, label: "test", releaseId: "gen-test", installedRepoDir: base }
      : undefined,
    bootFence,
  );
  const port = await server.listening;
  await server.controlReady;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as never));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await until(() => frames.some((f) => f.type === "init"), "init");
  const send = (msg: Record<string, unknown>) => ws.send(JSON.stringify(msg));
  const stop = () => {
    ws.close();
    void server.close();
  };
  return { server, port, frames, send, stop };
}

// A workspace as saved: what it is, and its history.
const readState = (base: string, id: string): WorkspaceState => {
  const dir = path.join(base, ".agent-team", "cache", "workspaces");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf-8")) as WorkspaceState;
  const messages = historyOf(base).load(id);
  closeHistory(base);
  return { ...meta, messages };
};

describe("server restart with projects", () => {
  it("persists a local model change before sending its receipt and correlates malformed-image errors", async () => {
    const { base, web } = seed();
    const { server, frames, send, stop } = await start(base, web);
    try {
      send({
        type: "send_message",
        workspaceId: "ws-lead",
        content: "/model gpt-5.6-sol",
        requestId: "model",
      });
      await until(
        () => frames.some((f) => f.type === "send_receipt" && f.requestId === "model"),
        "model receipt",
      );
      expect(readState(base, "ws-lead").agents[0].model).toBe("gpt-5.6-sol");
      send({
        type: "send_message",
        workspaceId: "ws-lead",
        content: "look",
        images: [{ url: null }],
        requestId: "bad-image",
      });
      await until(
        () => frames.some((f) => f.type === "error" && f.requestId === "bad-image"),
        "correlated image error",
      );
      expect(frames.some((f) => f.type === "send_receipt" && f.requestId === "bad-image")).toBe(
        false,
      );
    } finally {
      stop();
      await server.close();
    }
  });
  it("treats the lead's own turn as busy, then gates sends and resumes after unseal", async () => {
    const { base, web } = seed();
    const { server, frames, send, stop } = await start(base, web, true);
    const rpc = (message: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = createConnection(path.join(base, "deploy-control/control.sock"), () =>
          socket.write(JSON.stringify(message) + "\n"),
        );
        let reply = "";
        socket.on("data", (chunk: Buffer) => (reply += chunk.toString()));
        socket.on("error", reject);
        socket.on("end", () => resolve(JSON.parse(reply) as Record<string, unknown>));
      });
    const input = { type: "send_message", workspaceId: "ws-lead", content: "schedule deploy" };
    try {
      send({ ...input, requestId: "one" });
      await until(
        () => frames.some((f) => f.type === "send_receipt" && f.requestId === "one"),
        "admitted lead send",
      );
      expect(launches).toHaveLength(1);
      const status = await rpc({ cmd: "status" });
      expect(status.blockers).toMatchObject({ workspaces: 1 });
      const seal = { ...status, cmd: "seal", deployId: "job" };
      expect(await rpc(seal)).toMatchObject({ sealed: false });
      launches[0].emit({ kind: "result", content: "" });
      expect(await rpc(seal)).toMatchObject({ sealed: true, commitReady: true });
      send({ ...input, requestId: "two", content: "keep this draft" });
      await until(
        () =>
          frames.some((f) => f.type === "error" && f.requestId === "two" && f.retryable === true),
        "retryable seal rejection",
      );
      expect(launches[0].prompts).toEqual(["schedule deploy"]);
      await rpc({ ...seal, cmd: "unseal" });
      send({ ...input, requestId: "three", content: "keep this draft" });
      await until(
        () => frames.some((f) => f.type === "send_receipt" && f.requestId === "three"),
        "admitted retry",
      );
      expect(launches[0].prompts).toEqual(["schedule deploy", "keep this draft"]);
    } finally {
      stop();
      await server.close();
    }
  });

  it("sends send_receipt on acceptance without waiting for cold-start session.send()", async () => {
    const { base, web } = seed();
    const { server, frames, send, stop } = await start(base, web, true);
    const rpc = (message: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = createConnection(path.join(base, "deploy-control/control.sock"), () =>
          socket.write(JSON.stringify(message) + "\n"),
        );
        let reply = "";
        socket.on("data", (chunk: Buffer) => (reply += chunk.toString()));
        socket.on("error", reject);
        socket.on("end", () => resolve(JSON.parse(reply) as Record<string, unknown>));
      });
    const leadSession = sessionsByAgent.get("a-lead")!;
    const origSend = leadSession.send.bind(leadSession);
    let releaseColdStart!: () => void;
    let firstSend = true;
    vi.spyOn(leadSession, "send").mockImplementation((input) => {
      if (!firstSend) return origSend(input);
      firstSend = false;
      return new Promise<void>((resolve) => {
        releaseColdStart = () => {
          void origSend(input).then(resolve);
        };
      });
    });

    try {
      send({
        type: "send_message",
        workspaceId: "ws-lead",
        content: "cold start msg",
        requestId: "cold-1",
      });
      await until(
        () =>
          frames.some((f) => f.type === "send_receipt" && f.requestId === "cold-1") &&
          frames.some(
            (f) =>
              f.type === "new_message" &&
              (f.message as Message | undefined)?.content === "cold start msg",
          ),
        "immediate receipt and user message during cold start",
      );
      expect(launches).toHaveLength(0);
      const status = await rpc({ cmd: "status" });
      expect(status.blockers).toMatchObject({ workspaces: 1 });
      expect((status.blockers as { requests: number }).requests).toBeGreaterThanOrEqual(1);

      send({
        type: "send_message",
        workspaceId: "ws-lead",
        content: "queued while cold",
        requestId: "cold-2",
      });
      await until(
        () =>
          frames.some((f) => f.type === "send_receipt" && f.requestId === "cold-2") &&
          frames.some(
            (f) =>
              f.type === "new_message" &&
              (f.message as Message | undefined)?.content === "queued while cold" &&
              (f.message as Message | undefined)?.status === "queued",
          ),
        "immediate receipt for follow-up queued during cold start",
      );

      releaseColdStart();
      await until(() => launches.length === 1, "cold start completed");
      expect(launches[0].prompts).toEqual(["cold start msg"]);
      launches[0].emit({ kind: "result", content: "" });
      await until(
        () => launches[0].prompts.includes("queued while cold"),
        "queued follow-up dispatched after cold start turn",
      );
      launches[0].emit({ kind: "result", content: "" });
    } finally {
      stop();
      await server.close();
    }
  });

  it("preserves sendOrder admission receipts across a slow image download while dispatch stays pending", async () => {
    const { base, web } = seed();
    const { server, frames, send, stop } = await start(base, web, true);
    const rpc = (message: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = createConnection(path.join(base, "deploy-control/control.sock"), () =>
          socket.write(JSON.stringify(message) + "\n"),
        );
        let reply = "";
        socket.on("data", (chunk: Buffer) => (reply += chunk.toString()));
        socket.on("error", reject);
        socket.on("end", () => resolve(JSON.parse(reply) as Record<string, unknown>));
      });
    let releaseDownload!: () => void;
    let downloadStarted = false;
    vi.spyOn(
      server as unknown as {
        fetchRemoteImages: (
          images: Array<{ name: string; url: string; path: string }>,
        ) => Promise<void>;
      },
      "fetchRemoteImages",
    ).mockImplementation((images) => {
      downloadStarted = true;
      return new Promise<void>((resolve) => {
        releaseDownload = () => {
          for (const img of images) fs.writeFileSync(img.path, "img");
          resolve();
        };
      });
    });

    const leadSession = sessionsByAgent.get("a-lead")!;
    const origSend = leadSession.send.bind(leadSession);
    let releaseColdStart!: () => void;
    let firstSend = true;
    vi.spyOn(leadSession, "send").mockImplementation((input) => {
      if (!firstSend) return origSend(input);
      firstSend = false;
      return new Promise<void>((resolve) => {
        releaseColdStart = () => {
          void origSend(input).then(resolve);
        };
      });
    });

    try {
      send({
        type: "send_message",
        workspaceId: "ws-lead",
        content: "with slow image",
        images: [{ name: "delayed.png", url: "/uploads/delayed.png" }],
        requestId: "img-1",
      });
      send({
        type: "send_message",
        workspaceId: "ws-lead",
        content: "after slow image",
        requestId: "img-2",
      });
      await until(() => downloadStarted, "slow image download started");
      expect(frames.filter((f) => f.type === "send_receipt")).toEqual([]);

      releaseDownload();
      await until(
        () => frames.filter((f) => f.type === "send_receipt").length === 2,
        "both receipts emitted in order before cold-start send resolves",
      );
      expect(frames.filter((f) => f.type === "send_receipt").map((f) => f.requestId)).toEqual([
        "img-1",
        "img-2",
      ]);
      expect(launches).toHaveLength(0);

      const busyStatus = await rpc({ cmd: "status" });
      expect(busyStatus.blockers).toMatchObject({ workspaces: 1 });
      expect((busyStatus.blockers as { requests: number }).requests).toBeGreaterThanOrEqual(1);

      releaseColdStart();
      await until(() => launches.length === 1, "first image send dispatched");
      launches[0].emit({ kind: "result", content: "" });
      await until(
        () => launches[0].prompts.includes("after slow image"),
        "second send dispatched after first completes",
      );
      launches[0].emit({ kind: "result", content: "" });
      let idleStatus = await rpc({ cmd: "status" });
      for (
        let i = 0;
        i < 50 &&
        ((idleStatus.blockers as { workspaces: number; requests: number }).workspaces !== 0 ||
          (idleStatus.blockers as { workspaces: number; requests: number }).requests !== 0);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10));
        idleStatus = await rpc({ cmd: "status" });
      }
      expect(idleStatus.blockers).toMatchObject({ workspaces: 0, requests: 0 });
    } finally {
      stop();
      await server.close();
    }
  });
  it("keeps the candidate fenced, journals a worker report, and dispatches only after verification", async () => {
    const { base, web } = seed();
    const transaction = path.join(base, "transaction.json");
    fs.writeFileSync(transaction, "{}");
    const { server, frames, send, stop } = await start(base, web, true, transaction);
    const input = {
      type: "send_message",
      workspaceId: "ws-lead",
      content: "not admitted",
      requestId: "fenced",
    };
    try {
      const report = sessionsByAgent
        .get("a-live")!
        .panelTools!.tools.find((tool) => tool.name === "report_progress")!;
      await report.handler({ text: "durable report behind the fence" }, undefined, "test-call");
      const inbox = path.join(base, ".agent-team/projects/proj-1/inbox.json");
      expect(fs.readFileSync(inbox, "utf8")).toContain("durable report behind the fence");
      send(input);
      await until(
        () =>
          frames.some(
            (f) => f.type === "error" && f.requestId === "fenced" && f.retryable === true,
          ),
        "fenced send",
      );
      expect(launches).toHaveLength(0);
      fs.unlinkSync(transaction);
      await vi.waitFor(
        () => expect(launches[0]?.prompts[0]).toContain("durable report behind the fence"),
        { timeout: 2000 },
      );
      expect(launches[0].prompts).toHaveLength(1);
    } finally {
      stop();
      await server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("dispatches on the new backend with worker tools and persists the switch", async () => {
    const { base, root, web } = seed();
    fs.writeFileSync(path.join(base, "config.toml"), "[pi]\n");
    vi.spyOn(LocalHost.prototype, "discoverPiModels").mockResolvedValue([
      { id: "demo/model", provider: "demo", modelId: "model", effortLevels: ["low"] },
    ]);
    const state = readState(base, "ws-live");
    state.agents[0].session.config.effort = "low";
    saveWorkspace(base, state);
    closeHistory(base);
    const { server, frames, send, stop } = await start(base, web);
    try {
      await until(
        () =>
          frames.some((f) => JSON.stringify(f.models ?? f.config ?? null).includes("demo/model")),
        "Pi catalog",
      );
      send({ type: "send_message", workspaceId: "ws-live", content: "/model demo/model" });
      await until(
        () =>
          frames.some(
            (f) =>
              f.type === "agent_updated" &&
              f.workspaceId === "ws-live" &&
              (f.agent as AgentState).model === "demo/model",
          ),
        "replacement",
      );
      send({ type: "send_message", workspaceId: "ws-live", content: "first prompt" });
      await until(() => launches.length === 1, "first dispatch");
      expect(launches[0]).toMatchObject({
        cwd: root,
        model: "demo/model",
        effort: "low",
        prompts: ["first prompt"],
      });
      expect(launches[0].panel?.tools.map((tool) => tool.name)).toContain("finish_task");
      launches[0].emit({ kind: "text_delta", content: "done" });
      launches[0].emit({ kind: "result", content: "" });
      await server.close();
      const saved = readState(base, "ws-live");
      expect(saved.projectLink).toMatchObject({ projectId: "proj-1", role: "worker" });
      expect(saved.agents[0]).toMatchObject({
        id: "a-live",
        model: "demo/model",
        session: { config: { backend: "pi", effort: "low", cwd: root } },
      });
      const restarted = await start(base, web);
      try {
        const init = restarted.frames.find((f) => f.type === "init")!;
        const workspace = (init.workspaces as WorkspaceState[]).find((w) => w.id === "ws-live");
        expect(workspace?.agents[0]).toMatchObject({
          id: "a-live",
          model: "demo/model",
          effort: "low",
          canSwitchBackend: false,
        });
      } finally {
        restarted.stop();
        await restarted.server.close();
      }
    } finally {
      stop();
      await server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("gates ACP quota until live runtime readiness and refreshes only ACP on install", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { base, web } = seed();
    const runtime = path.join(base, "agy_acp_server.par");
    process.env.AGY_ACP_BIN = runtime;
    const configured = [ACP, "kimi-coding"];
    vi.mocked(codex.probeCodexAuth).mockResolvedValue({
      cliAvailable: true,
      authenticated: true,
      status: "authenticated",
      accountType: "chatgpt",
      checkedAt: Date.now(),
    });
    const read = vi.fn((provider: string) =>
      Promise.resolve({
        provider,
        observedAt: Date.now(),
        availability: "available" as const,
        groups: [{ name: "Plan", windows: [{ label: "weekly", usedPct: 42 }] }],
      }),
    );
    vi.spyOn(LocalHost.prototype, "quotaReader").mockReturnValue({ configured, read });
    const native = vi.spyOn(codex, "readCodexRateLimits").mockResolvedValue({
      limitId: "codex",
      planType: null,
      primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: null },
      secondary: null,
    });
    const { server, frames, send, stop } = await start(base, web);
    const latestQuota = () =>
      frames.filter((f) => f.type === "quota_snapshot").at(-1)?.quota as QuotaState | undefined;
    const acpRow = (quota?: QuotaState) => quota?.rows.find((r) => r.provider === ACP);
    try {
      const initQuota = frames.find((f) => f.type === "init")?.quota as QuotaState;
      expect(initQuota.acpPrepareStep).toBe(acpReadiness.ACP_PREPARE_STEP);
      expect(acpRow(initQuota)?.reason).toBe("waiting for ACP setup");
      send({ type: "refresh_quota", force: true });
      await until(() => latestQuota()?.refreshing === false, "manual quota refresh");
      expect(acpRow(latestQuota())?.reason).toBe("waiting for ACP setup");
      await vi.advanceTimersByTimeAsync(3000);
      expect(read.mock.calls.map(([provider]) => [provider])).toEqual([["kimi-coding"]]);

      // The other providers are now past TTL, but a runtime transition must only read ACP.
      vi.setSystemTime(Date.now() + QUOTA_AUTO_REFRESH_INTERVAL);
      fs.writeFileSync(runtime, "", { mode: 0o755 });
      await vi.advanceTimersByTimeAsync(3000);
      await until(() => acpRow(latestQuota())?.availability === "available", "ACP install refresh");
      const sample = acpRow(latestQuota());
      await vi.advanceTimersByTimeAsync(3000);
      expect(read.mock.calls.map(([provider]) => [provider])).toEqual([["kimi-coding"], [ACP]]);
      expect(native).toHaveBeenCalledTimes(1);
      expect(launches).toEqual([]);

      fs.unlinkSync(runtime);
      await vi.advanceTimersByTimeAsync(3000);
      await until(() => acpRow(latestQuota())?.reason === "waiting for ACP setup", "ACP removal");
      expect(acpRow(latestQuota())).toEqual({
        ...sample,
        availability: "unavailable",
        reason: "waiting for ACP setup",
      });
      expect(read).toHaveBeenCalledTimes(2);

      configured.splice(configured.indexOf(ACP), 1);
      send({ type: "refresh_quota", force: true });
      await until(() => acpRow(latestQuota())?.reason === "not configured", "ACP not configured");
      expect(read.mock.calls.filter(([provider]) => provider === ACP)).toHaveLength(1);
    } finally {
      stop();
      await server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("distinguishes forced manual and non-forced provider-scoped WS refreshes", async () => {
    const { base, web } = seed();
    const { server, send, stop } = await start(base, web);
    const refresh = vi.spyOn(server["quota"], "refresh").mockResolvedValue();
    try {
      send({ type: "refresh_quota", force: true });
      send({ type: "refresh_quota", force: false, providers: ["kimi-coding"] });
      await until(() => refresh.mock.calls.length === 2, "both WS refresh requests");
      expect(refresh.mock.calls.map(([, options]) => options)).toEqual([
        { force: true, providers: undefined },
        { force: false, providers: ["kimi-coding"] },
      ]);
    } finally {
      stop();
      await server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("refreshes only the completed turn's provider while a UI client is connected", async () => {
    const { base, web } = seed();
    const { server, send, stop } = await start(base, web);
    const refresh = vi.spyOn(server["quota"], "refresh").mockResolvedValue();
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "use quota" });
      await until(() => launches[0]?.prompts.length === 1, "turn start");
      launches[0].emit({ kind: "result", content: "" });
      await until(() => refresh.mock.calls.length === 1, "turn-end quota refresh");
      expect(refresh).toHaveBeenCalledWith(expect.any(Function), {
        force: false,
        providers: [NATIVE_CODEX],
      });
    } finally {
      stop();
      await server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    { order: "ready before control", overlap: false },
    { order: "control before ready", overlap: false },
    { order: "control before ready", overlap: true },
    { order: "provider added after ready", overlap: false },
    { order: "control reconnect after a failed read", overlap: false },
    { order: "shutdown with a queued provider expansion", overlap: false },
  ])(
    "recovers quota with $order (cold refresh in flight: $overlap)",
    async ({ order, overlap }) => {
      const { base, root, web } = seed();
      vi.spyOn(acpReadiness, "inspectAcpRuntime").mockReturnValue({
        ready: true,
        value: "/mock/agy",
        source: "test",
      });
      vi.mocked(codex.probeCodexAuth).mockResolvedValue({
        cliAvailable: true,
        authenticated: true,
        status: "authenticated",
        accountType: "chatgpt",
        checkedAt: Date.now(),
      });
      vi.spyOn(LocalHost.prototype, "createSession").mockRestore();
      vi.stubEnv("OPENAI_API_KEY", "test-key");
      vi.stubEnv("CODEX_API_KEY", undefined);
      const limits = {
        limitId: "codex",
        planType: null,
        primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      };
      let resolveNative!: (value: typeof limits) => void;
      const native = new Promise<typeof limits>((resolve) => {
        resolveNative = resolve;
      });
      const readLimits = vi.spyOn(codex, "readCodexRateLimits").mockReturnValue(native);
      const controlAbort = new AbortController();
      const { server, port, frames, send } = await start(base, web);
      const snapshots = () => frames.filter((f) => f.type === "quota_snapshot");
      const latestQuota = () => snapshots().at(-1)?.quota as QuotaState | undefined;
      const provider = "antigravity-acp";
      const piRow = (state: QuotaState | undefined) =>
        state?.rows.find((r) => r.provider === provider);
      let reconnect: WebSocket | undefined;
      let closing: Promise<void> | undefined;
      try {
        send({ type: "refresh_quota", force: true });
        await until(() => !!readLimits.mock.calls.length && snapshots().length > 1, "cold refresh");
        expect(readLimits.mock.calls[0]?.[0]?.CODEX_API_KEY).toBe("test-key");
        if (!overlap) {
          resolveNative(limits);
          await until(() => latestQuota()?.refreshing === false, "cold refresh completion");
        }
        const cold = latestQuota();
        expect(cold?.refreshing).toBe(overlap);
        expect(piRow(cold)).toMatchObject({ availability: "unavailable", windows: [] });

        const host = server["hostRegistry"].get("local") as LocalHost;
        host.createSession("quota-pi", { cwd: root, backend: "pi" });
        const panel = host["panelHttp"]!;
        const { baseUrl } = await panel.listen();
        const token = panel.registerSession({
          sessionKey: "quota-pi",
          getToolset: () => null,
          onQuota: () => {},
        });
        const request = (endpoint: string, body?: unknown) =>
          fetch(`${baseUrl}/v1/sessions/quota-pi/${endpoint}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controlAbort.signal,
          });
        const ready = async (quotaProviders: string[]) => {
          const response = await request("ready", {
            quotaProviders,
            sessionProof: {
              sessionId: null,
              sessionFile: null,
              cwd: root,
              headerCwd: null,
              entryCount: 0,
              leafId: null,
              anchorOnActiveBranch: false,
              anchorExistsInFile: false,
            },
            ownerToolNames: [],
            requiredExtensionsRegistered: true,
            subagentsRpcReady: false,
            subagentsSessionId: null,
          });
          expect(await response.json()).toEqual({ ok: true });
        };
        if (order === "ready before control") await ready([provider]);
        expect(panel.quotaReader()).toBeUndefined();
        let control = await request("control");
        expect(control.status).toBe(200);
        if (order !== "ready before control") {
          expect(panel.quotaReader()).toBeUndefined();
          if (order === "provider added after ready") {
            await ready([]);
            await until(
              () => piRow(latestQuota())?.reason === "not configured",
              "empty provider set",
            );
            await until(
              () => latestQuota()?.refreshing === false,
              "empty reader refresh completion",
            );
          }
          await ready([provider]);
        }
        if (overlap) {
          expect(latestQuota()?.refreshing).toBe(true);
          resolveNative(limits);
        }
        if (order === "control reconnect after a failed read") {
          await until(() => latestQuota()?.refreshing === true, "Pi read in flight");
          await control.body!.cancel();
          await until(() => latestQuota()?.refreshing === false, "failed Pi read completion");
          expect(piRow(latestQuota())?.reason).toBe("usage unavailable");
          control = await request("control");
          expect(control.status).toBe(200);
        }
        if (order === "shutdown with a queued provider expansion") {
          await until(() => latestQuota()?.refreshing === true, "Pi read in flight");
          await ready([provider, "kimi-coding"]);
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + QUOTA_AUTO_REFRESH_INTERVAL);
          closing = server.close();
          await closing;
          await until(() => !server["quota"].state().refreshing, "quota refresh to drain");
          expect(readLimits).toHaveBeenCalledTimes(1);
          return;
        }

        const decoder = new TextDecoder();
        const reader = (control.body as ReadableStream<Uint8Array>).getReader();
        const messages: Array<{
          type: string;
          provider: string;
          controlId: string;
          force: boolean;
        }> = [];
        const reply = (async () => {
          let buffer = "";
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop()!;
            for (const event of events) {
              if (!event.startsWith("data: ")) continue;
              const message = JSON.parse(event.slice(6)) as (typeof messages)[number];
              messages.push(message);
              const response = await request("control-reply", {
                controlId: message.controlId,
                result: {
                  provider: message.provider,
                  observedAt: Date.now(),
                  availability: "available",
                  groups: [{ name: "Pi plan", windows: [{ label: "weekly", usedPct: 42 }] }],
                },
              });
              expect(await response.json()).toEqual({ ok: true });
            }
          }
        })();
        try {
          await Promise.race([
            until(
              () =>
                latestQuota()?.refreshing === false &&
                piRow(latestQuota())?.availability === "available",
              "automatic Pi quota recovery",
            ),
            reply,
          ]);
        } finally {
          controlAbort.abort();
          await reply.catch((error: unknown) => {
            if (!(error instanceof Error) || error.name !== "AbortError") throw error;
          });
        }
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ type: "refresh_quota", provider, force: overlap });
        expect(piRow(cold)?.reason).toBe("waiting for Pi session");
        const recovered = latestQuota();
        expect(recovered?.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              provider: "native-codex",
              windows: [{ label: "5h", usedPct: 27 }],
            }),
            expect.objectContaining({
              provider,
              availability: "available",
              windows: [{ label: "weekly", usedPct: 42 }],
            }),
            expect.objectContaining({
              provider: "kimi-coding",
              availability: "unavailable",
              reason: "not configured",
            }),
          ]),
        );
        reconnect = new WebSocket(`ws://127.0.0.1:${port}/`);
        const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
          reconnect!.once("message", (raw: Buffer) =>
            resolve(JSON.parse(raw.toString()) as Record<string, unknown>),
          );
          reconnect!.once("error", reject);
        });
        expect(frame).toMatchObject({ type: "init", quota: recovered });
      } finally {
        controlAbort.abort();
        reconnect?.close();
        resolveNative(limits);
        vi.unstubAllEnvs();
        await (closing ?? server.close());
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("sends identities on init and refreshes preset names and hints in lead tools on config reload", async () => {
    const setPanelTools = vi.spyOn(TestSession.prototype, "setPanelTools");
    const startSessionDescription = () =>
      setPanelTools.mock.calls
        .map(([set]) => set?.tools.find((tool) => tool.name === "start_session")?.description)
        .filter((description) => description !== undefined)
        .at(-1);
    const { base, web } = seed();
    const config = path.join(base, "config.toml");
    const source =
      '[user]\nname="Ada"\n[[agent_presets]]\nname="One"\ncolor="blue"\navatar="1"\nwhen_to_use="First dispatch hint"';
    fs.writeFileSync(config, source);
    const { frames, stop } = await start(base, web);
    try {
      expect(frames.find((f) => f.type === "init")?.config).toMatchObject({
        user: { name: "Ada" },
        presets: [{ name: "One" }],
      });
      expect(startSessionDescription()).toContain('Presets: "One".');
      expect(startSessionDescription()).toContain('Dispatch hints: "One": First dispatch hint.');
      fs.writeFileSync(
        config,
        source
          .replace("Ada", "Other")
          .replace("One", "Two")
          .replace("First dispatch hint", "Second dispatch hint"),
      );
      await vi.waitFor(
        () =>
          expect(frames.find((f) => f.type === "identities_update")).toMatchObject({
            user: { name: "Other" },
            presets: [{ name: "Two" }],
          }),
        { timeout: 3500 },
      );
      expect(startSessionDescription()).toContain('Presets: "Two".');
      expect(startSessionDescription()).toContain('Dispatch hints: "Two": Second dispatch hint.');
      expect(startSessionDescription()).not.toContain('"One"');
      expect(startSessionDescription()).not.toContain("First dispatch hint");
    } finally {
      stop();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("refreshes existing lead tools when only a preset dispatch hint changes or is removed", async () => {
    const setPanelTools = vi.spyOn(TestSession.prototype, "setPanelTools");
    const startSessionDescription = () =>
      setPanelTools.mock.calls
        .map(([set]) => set?.tools.find((tool) => tool.name === "start_session")?.description)
        .filter((description) => description !== undefined)
        .at(-1);
    const { base, web } = seed();
    const config = path.join(base, "config.toml");
    const preset = '[[agent_presets]]\nname="One"\ncolor="blue"\navatar="1"';
    fs.writeFileSync(config, `${preset}\nwhen_to_use="First dispatch hint"`);
    const { stop } = await start(base, web);
    try {
      expect(startSessionDescription()).toContain('Dispatch hints: "One": First dispatch hint.');

      fs.writeFileSync(config, `${preset}\nwhen_to_use="Second dispatch hint"`);
      await vi.waitFor(
        () =>
          expect(startSessionDescription()).toContain(
            'Dispatch hints: "One": Second dispatch hint.',
          ),
        { timeout: 3500 },
      );
      expect(startSessionDescription()).not.toContain("First dispatch hint");

      fs.writeFileSync(config, preset);
      await vi.waitFor(
        () => {
          expect(startSessionDescription()).toContain('Presets: "One".');
          expect(startSessionDescription()).not.toContain("Dispatch hints");
        },
        { timeout: 3500 },
      );
    } finally {
      stop();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("refreshes start_session models on unstarted/idle leads and defers running leads until idle", async () => {
    vi.spyOn(LocalHost.prototype, "discoverPiModels").mockResolvedValue([
      {
        id: "antigravity-acp/claude-opus-4-6-thinking",
        provider: "antigravity-acp",
        modelId: "claude-opus-4-6-thinking",
      },
    ]);
    const setPanelTools = vi.spyOn(TestSession.prototype, "setPanelTools");
    const { base, web } = seed();
    fs.writeFileSync(path.join(base, "config.toml"), "[pi]\n");
    const { frames, send, stop } = await start(base, web);
    try {
      const leadSession = sessionsByAgent.get("a-lead")!;
      const liveSession = sessionsByAgent.get("a-live")!;
      const startDescription = (session: TestSession) =>
        session.panelTools?.tools.find((t) => t.name === "start_session")?.description ?? "";

      // Boot-discovered Pi models reach the restored unstarted lead.
      expect(startDescription(leadSession)).toContain("antigravity-acp/claude-opus-4-6-thinking");

      // Create a second project whose lead stays unstarted/idle.
      const beforeIds = new Set(sessionsByAgent.keys());
      send({ type: "create_project", root: null, cwd: base, name: "idle-proj" });
      await until(
        () =>
          frames.some(
            (f) =>
              f.type === "project_updated" && (f.project as { name?: string }).name === "idle-proj",
          ),
        "second project created",
      );
      const idleLeadId = [...sessionsByAgent.keys()].find((id) => !beforeIds.has(id))!;
      const idleLeadSession = sessionsByAgent.get(idleLeadId)!;
      expect(startDescription(idleLeadSession)).toContain(
        "antigravity-acp/claude-opus-4-6-thinking",
      );

      // Start a turn on ws-lead so it is actively running.
      send({ type: "send_message", workspaceId: "ws-lead", content: "hello" });
      await until(() => launches.length === 1, "lead turn running");
      setPanelTools.mockClear();

      // Discover a new Pi model while ws-lead is running.
      liveSession.availableModels = [
        {
          id: "kimi-coding/k2p5",
          provider: "kimi-coding",
          modelId: "k2p5",
        },
      ];
      liveSession.emit("commands", []);
      await until(
        () =>
          frames.some(
            (f) =>
              f.type === "models_update" &&
              (f.models as Array<{ id: string }>).some((m) => m.id === "kimi-coding/k2p5"),
          ),
        "models_update broadcast",
      );

      // The unstarted/idle lead updates immediately; the running lead is untouched mid-turn.
      expect(startDescription(idleLeadSession)).toContain("kimi-coding/k2p5");
      expect(setPanelTools.mock.instances.filter((inst) => inst === leadSession)).toHaveLength(0);
      expect(startDescription(leadSession)).not.toContain("kimi-coding/k2p5");

      // Once the running lead finishes its turn and becomes idle, its tools refresh.
      launches[0].emit({ type: "result", result: "done" });
      await until(
        () => startDescription(leadSession).includes("kimi-coding/k2p5"),
        "lead tools refreshed on idle",
      );
      expect(startDescription(leadSession)).toContain("kimi-coding/k2p5");
    } finally {
      stop();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("re-attaches the panel tools and delivers to an archived worker without losing its history", async () => {
    const { base, root, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      const init = frames.find((f) => f.type === "init")!;
      const infos = init.workspaces as Array<{
        id: string;
        projectLink?: unknown;
        archivedAt: number | null;
      }>;
      // Idle far past archive_after_days, but a lead is never auto-archived.
      expect(infos.find((w) => w.id === "ws-lead")).toMatchObject({
        projectLink: { projectId: "proj-1", role: "lead" },
        archivedAt: null,
      });
      // Its project is unreadable or gone: the link stays (a repaired
      // project.json brings it back), it just gets no tools.
      expect(infos.find((w) => w.id === "ws-orphan")!.projectLink).toBeDefined();
      expect((init.projects as Project[]).map((p) => p.id)).toEqual(["proj-1"]);

      send({ type: "send_message", workspaceId: "ws-lead", content: "hello" });
      await until(() => launches.length === 1, "lead query");
      const lead = launches[0].panel;
      expect(lead, "lead launched without the panel MCP server after restart").toBeDefined();
      expect(lead!.instructions).toContain('project "demo"');
      // Past the 2048 characters the CLI would cut them at.
      expect(lead!.instructions.length).toBeGreaterThan(2048);
      const tools = Object.fromEntries(lead!.tools.map((t) => [t.name, t]));
      expect(Object.keys(tools)).toEqual(expect.arrayContaining(["message_session"]));

      const reply = await tools.message_session.handler({
        session_id: "ws-w",
        message: "please rebase",
      });
      expect(reply.content[0].text).toBe('Sent to "worker".');
      await until(() => launches.length === 2, "worker query");
      expect(launches[1].cwd).toBe(root);
      expect(launches[1].panel?.tools.map((t) => t.name)).toEqual([
        "report_progress",
        "finish_task",
        "current_task",
        "list_objectives",
        "write_objective",
        "add_items",
        "update_item",
        "list_issues",
        "read_issue",
        "write_issues",
        "write_issue_group",
        "close_issues",
        "list_notes",
        "read_note",
        "write_note",
        "project_status",
        "read_session",
        "search_history",
        "read_entry",
        "query_history",
      ]);
      await until(
        () => frames.some((f) => f.type === "new_message" && f.workspaceId === "ws-w"),
        "delivered frame",
      );
      expect(frames).toContainEqual({ type: "workspace_unarchived", workspaceId: "ws-w" });
      const delivered = frames.find((f) => f.type === "new_message" && f.workspaceId === "ws-w")!
        .message as Message;
      expect(delivered).toMatchObject({
        content: "please rebase",
        status: "starting",
        from: { workspaceId: "ws-lead", role: "lead" },
      });
    } finally {
      stop();
      log.mockRestore();
    }
    const saved = readState(base, "ws-w");
    expect(saved.archivedAt).toBeNull();
    expect(saved.messages!.map((m) => m.id).slice(0, 2)).toEqual(["h1", "h2"]);
    expect(saved.messages!.some((m) => m.from?.role === "lead")).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("shows a worker waiting for the user to a client that connects, and once restored", async () => {
    const { base, web } = seed();
    const waiting = (agentId: string): Message[] => [
      {
        id: `${agentId}-t`,
        kind: "user",
        agentId: null,
        content: "do it",
        timestamp: 1000,
        status: "done",
        from: { workspaceId: "ws-lead", name: "lead", role: "lead" },
      },
      {
        id: `${agentId}-r`,
        kind: "agent",
        agentId,
        content: "Which branch?",
        timestamp: 1001,
        status: "done",
      },
    ];
    historyOf(base).save("ws-live", waiting("a-live"), "all");
    historyOf(base).save("ws-w", waiting("a-w"), "all");
    closeHistory(base);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop, port } = await start(base, web);
    try {
      const infos = frames.find((f) => f.type === "init")!.workspaces as Array<{
        id: string;
        awaitsUser?: boolean;
      }>;
      expect(infos.find((w) => w.id === "ws-live")!.awaitsUser).toBe(true);
      expect(infos.find((w) => w.id === "ws-w")!.awaitsUser).toBeUndefined();
      expect(infos.find((w) => w.id === "ws-lead")!.awaitsUser).toBeUndefined();

      // The user writes to it: what a client that connects now gets, the
      // first is told too.
      send({ type: "send_message", workspaceId: "ws-live", content: "main" });
      await until(() => launches.length === 1, "the turn");
      const other = new WebSocket(`ws://127.0.0.1:${port}/`);
      const got: Array<Record<string, unknown>> = [];
      other.on("message", (raw: Buffer) => got.push(JSON.parse(raw.toString()) as never));
      await until(() => got.some((f) => f.type === "init"), "the second client's list");
      other.close();
      const live = (got.find((f) => f.type === "init")!.workspaces as typeof infos).find(
        (w) => w.id === "ws-live",
      )!;
      expect(live.awaitsUser).toBeUndefined();
      const told = () => {
        const updates = frames
          .filter((f) => f.type === "workspace_updated")
          .map((f) => f.workspace as { id: string; awaitsUser?: boolean })
          .filter((w) => w.id === "ws-live");
        return updates.length > 0 && updates[updates.length - 1].awaitsUser === undefined;
      };
      await until(told, "the first client told it no longer waits");

      send({ type: "unarchive_workspace", workspaceId: "ws-w" });
      const updated = () =>
        frames
          .filter((f) => f.type === "workspace_updated")
          .map((f) => f.workspace as { id: string; awaitsUser?: boolean })
          .filter((w) => w.id === "ws-w");
      await until(() => updated().length > 0, "the restored worker's update");
      expect(updated()[0].awaitsUser).toBe(true);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("has the projects check a worker whose turn ended or who went idle", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const idle = vi.spyOn(ProjectManager.prototype, "workerIdle");
    const { send, stop } = await start(base, web);
    try {
      send({ type: "abort", workspaceId: "ws-live" });
      await until(() => idle.mock.calls.length > 0, "the check");
      expect(idle.mock.calls[0][0].id).toBe("ws-live");
    } finally {
      stop();
      idle.mockRestore();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("saves a worker's turn a shutdown cut off as cut by the restart, and what drove it", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { send, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-lead", content: "hello" });
      await until(() => launches.length === 1, "lead query");
      const tools = Object.fromEntries(launches[0].panel!.tools.map((t) => [t.name, t]));
      await tools.message_session.handler({ session_id: "ws-live", message: "build it" });
      await until(() => launches.length === 2, "worker query");
    } finally {
      stop();
      log.mockRestore();
    }
    const saved = readState(base, "ws-live");
    const asked = saved.messages!.find((m) => m.content === "build it")!;
    expect(saved.agents[0].delivered).toMatchObject({ id: asked.id, stopped: "restart" });
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("retries the turns a rate limit paused before the restart, one at a time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Both wait for the same reset, still to come.
    const { base, web, root } = seed({ livePaused: 7000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stop } = await start(base, web);
    try {
      await vi.advanceTimersByTimeAsync(7000);
      expect(launches).toHaveLength(1);
      expect(launches[0].cwd).toBe(root);
      // The other one waits for its own slot (15s spacing).
      await vi.advanceTimersByTimeAsync(2500);
      expect(launches).toHaveLength(1);
    } finally {
      stop();
      log.mockRestore();
    }
    expect(readState(base, "ws-live").agents[0].pausedUntil).toBeUndefined();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("retries a turn whose limit has reset without waiting behind another's retry hours away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed({ livePaused: 3600_000, orphanPaused: -1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stop } = await start(base, web);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(launches).toHaveLength(1);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("starts a queued message and a due retry one slot apart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed({ liveQueued: true, orphanPaused: -1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stop } = await start(base, web);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(launches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2500);
      expect(launches).toHaveLength(1);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("runs no retry for a worker archived while it waited for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed({ livePaused: -1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "archive_workspace", workspaceId: "ws-live" });
      send({ type: "archive_workspace", workspaceId: "ws-orphan" });
      await until(
        () => frames.filter((f) => f.type === "workspace_archived").length === 2,
        "workers archived",
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(launches).toEqual([]);
    } finally {
      stop();
      log.mockRestore();
    }
    expect(readState(base, "ws-live").agents[0].pausedUntil).toBeUndefined();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("archives a lead only with its project, which a session opened again brings back", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    const archived = () =>
      frames.filter((f) => f.type === "workspace_archived").map((f) => f.workspaceId);
    const project = () =>
      frames.filter((f) => f.type === "project_updated").at(-1)?.project as { archivedAt?: number };
    try {
      send({ type: "archive_workspace", workspaceId: "ws-lead" });
      await until(() => frames.some((f) => f.type === "error"), "the refusal");
      expect(frames.find((f) => f.type === "error")!.message).toBe(
        "A lead goes with its project: archive the project",
      );
      expect(archived()).toEqual([]);

      send({ type: "archive_project", projectId: "proj-1", archived: true });
      await until(() => archived().length === 2, "the project's sessions archived");
      expect(archived().sort()).toEqual(["ws-lead", "ws-live"]);
      expect(project().archivedAt).toBeGreaterThan(0);

      send({ type: "unarchive_workspace", workspaceId: "ws-w" });
      await until(() => project().archivedAt === null, "the project back");
      const unarchived = frames
        .filter((f) => f.type === "workspace_unarchived")
        .map((f) => f.workspaceId);
      expect(unarchived.sort()).toEqual(["ws-lead", "ws-w"]);
    } finally {
      stop();
      log.mockRestore();
    }
    expect(readState(base, "ws-lead").archivedAt).toBeNull();
    expect(readState(base, "ws-live").archivedAt).toBeGreaterThan(0);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("archives at startup the sessions an archived project still had live", async () => {
    const { base, web } = seed();
    const file = path.join(base, ".agent-team", "projects", "proj-1", "project.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...saved, archivedAt: 5 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stop } = await start(base, web);
    stop();
    log.mockRestore();
    for (const id of ["ws-lead", "ws-live"]) {
      expect(readState(base, id).archivedAt).toBeGreaterThan(0);
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("runs a new lead and its workers on the default Codex model unless asked otherwise", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      const root = path.join(base, "other");
      fs.mkdirSync(root);
      send({ type: "create_project", name: "other", path: root });
      const created = () =>
        frames.find(
          (f) => f.type === "workspace_created" && (f.workspace as { cwd: string }).cwd === root,
        );
      await until(() => created() !== undefined, "the new lead");
      const leadId = (created()!.workspace as { id: string }).id;
      send({ type: "send_message", workspaceId: leadId, content: "hello" });
      await until(() => launches.length === 1, "lead query");
      expect(launches[0]).toMatchObject({ model: "gpt-6-astra", effort: undefined });

      const start_session = launches[0].panel!.tools.find((t) => t.name === "start_session")!;
      await start_session.handler({ title: "w", cwd: ".", task: "t" });
      await until(() => launches.length === 2, "worker query");
      expect(launches[1]).toMatchObject({ model: "gpt-6-astra", effort: undefined });
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("purges archived workers but never an archived lead, and the board forgets them", async () => {
    const { base, web } = seed({ leadArchived: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "purge_archived" });
      await until(
        () =>
          frames.some((f) => f.type === "workspace_deleted" && f.workspaceId === "ws-w") &&
          frames.some((f) => f.type === "project_updated"),
        "worker purge",
      );
      expect(frames.filter((f) => f.type === "workspace_deleted")).toEqual([
        { type: "workspace_deleted", workspaceId: "ws-w" },
      ]);
      expect(frames.some((f) => f.type === "project_deleted")).toBe(false);
      const updated = frames.filter((f) => f.type === "project_updated").pop()!;
      expect((updated.project as { objectives: Objective[] }).objectives[0].sessions).toEqual([
        "ws-live",
      ]);

      // Deleting the project unlinks its live worker; that survives a restart.
      send({ type: "delete_project", projectId: "proj-1" });
      await until(() => frames.some((f) => f.type === "project_deleted"), "project delete");
      expect(frames).toContainEqual({ type: "workspace_deleted", workspaceId: "ws-lead" });
    } finally {
      stop();
    }
    const again = await start(base, web);
    try {
      const init = again.frames.find((f) => f.type === "init")!;
      const infos = init.workspaces as Array<{
        id: string;
        cwd: string;
        projectLink?: { projectId: string; role: string };
      }>;
      expect(fs.existsSync(path.join(base, ".agent-team", "projects", "proj-1"))).toBe(false);
      // Every workspace belongs to its folder's project: the deleted project's
      // live worker joins a new one, with a fresh lead and no memory.
      const live = infos.find((w) => w.id === "ws-live")!;
      const projects = init.projects as Array<Project & { objectives: unknown[] }>;
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ root: live.cwd, objectives: [] });
      expect(projects[0].archivedAt ?? null).toBeNull();
      expect(live.projectLink).toEqual({
        projectId: projects[0].id,
        role: "worker",
        unreported: true,
      });
      expect(infos.map((w) => w.id)).toContain(projects[0].leadWorkspaceId);
    } finally {
      again.stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe("rate limits on the server", () => {
  const limit = (rateLimitType: string) => ({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType },
    session_id: "s",
  });
  const result = (text: string) => ({
    type: "result",
    subtype: "success",
    result: text,
    session_id: "s",
  });
  // The API-error message the CLI ends each refused turn with (snap
  // fixture claude/usage-limit).
  const refused = {
    type: "assistant",
    message: { content: [{ type: "text", text: "You've hit your session limit · resets 1:50am" }] },
    parent_tool_use_id: null,
    error: "rate_limit",
    session_id: "s",
  };
  const paused = (frames: Array<Record<string, unknown>>) =>
    frames
      .filter((f) => f.type === "new_message")
      .map((f) => (f.message as Message).content)
      .filter((c) => c.includes("hit the 5-hour limit") || c.includes("hit the weekly limit"));

  it("lets the retry the user's message started run after a weekly limit without account failover", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed();
    fs.writeFileSync(path.join(base, "config.toml"), '[accounts.other]\noauth_token = "t"\n');
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "P" });
      await until(() => launches[0]?.prompts.length === 1, "the turn");
      launches[0].emit(limit("seven_day"));
      launches[0].emit(refused);
      launches[0].emit({ ...result("limit"), is_error: true });
      await until(() => paused(frames).length > 0, "the pause");
      send({ type: "send_message", workspaceId: "ws-live", content: "U" });
      await until(() => launches[0].prompts.length === 2, "the retry");
      await vi.advanceTimersByTimeAsync(1500);
      expect(launches.map((l) => l.prompts)).toEqual([["P", "P"]]);
      launches[0].emit(result("done"));
      await vi.advanceTimersByTimeAsync(0);
      await until(() => launches[0].prompts.length === 3, "the user's message");
      expect(launches[0].prompts).toEqual(["P", "P", "U"]);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("waits a Codex weekly limit out to its reset without account failover", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed({ liveCodex: true });
    fs.writeFileSync(path.join(base, "config.toml"), '[accounts.other]\noauth_token = "t"\n');
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 86400;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "P" });
      await until(() => launches[0]?.prompts.length === 1, "the turn");
      launches[0].emit({
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "seven_day", resetsAt },
      });
      launches[0].emit({ ...result("limit"), is_error: true });
      await until(() => paused(frames).length > 0, "the pause");
      await vi.advanceTimersByTimeAsync(500);
      expect(readState(base, "ws-live").agents[0].pausedUntil).toBeGreaterThanOrEqual(
        resetsAt * 1000 + 60_000,
      );
      expect(launches).toHaveLength(1);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("tells the agent to carry on after a limit on a turn the CLI started itself", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "P" });
      await until(() => launches[0]?.prompts.length === 1, "the turn");
      const q = launches[0];
      q.emit(result("done"));
      q.emit(limit("five_hour"));
      q.emit(refused);
      q.emit({ ...result("limit"), is_error: true });
      await until(() => paused(frames).length > 0, "the pause");
      expect(paused(frames)[0]).toContain("it will be told to carry on at");
    } finally {
      stop();
      log.mockRestore();
    }
    const saved = readState(base, "ws-live").agents[0];
    expect(saved.pausedUntil).toBeDefined();
    expect(saved.lastEnvelope).toBeUndefined();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("reports a wake-up the limit refuses while the retry waits, and keeps that retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "P" });
      await until(() => launches[0]?.prompts.length === 1, "the turn");
      const q = launches[0];
      q.emit({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt },
        session_id: "s",
      });
      q.emit(refused);
      q.emit({ ...result("limit"), is_error: true });
      await until(() => paused(frames).length > 0, "the pause");
      // A wake-up: the CLI sends no rate_limit_event again, only the refusal.
      // The retry it waits for stands, start slot and all.
      const slots = vi.spyOn(ProjectManager.prototype, "takeStartSlot");
      q.emit(refused);
      q.emit({ ...result("Usage limit reached (five-hour)"), is_error: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(paused(frames)).toHaveLength(1);
      expect(slots).not.toHaveBeenCalled();
      slots.mockRestore();
    } finally {
      stop();
      log.mockRestore();
    }
    const saved = readState(base, "ws-live");
    const replies = saved.messages!.filter((m) => m.kind === "agent");
    expect(replies.map((m) => m.status)).toEqual(["error", "error"]);
    expect(replies[1].events?.find((e) => e.kind === "error")?.content).toContain(
      "Usage limit reached (five-hour)",
    );
    expect(saved.agents[0]).toMatchObject({
      pausedUntil: resetsAt * 1000 + 60_000,
      lastEnvelope: { text: "P" },
    });
    expect(saved.agents[0].lastEnvelope?.inputId).toBe(
      saved.messages!.find((m) => m.content === "P")?.id,
    );
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("pauses for no 429 while no usage limit stands", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "P" });
      await until(() => launches[0]?.prompts.length === 1, "the turn");
      const busy = "API Error: Server is temporarily limiting requests (not your usage limit)";
      launches[0].emit({ ...refused, message: { content: [{ type: "text", text: busy }] } });
      launches[0].emit({ ...result(busy), is_error: true });
      await until(() => frames.some((f) => f.type === "message_done"), "turn done");
      expect(paused(frames)).toEqual([]);
    } finally {
      stop();
      log.mockRestore();
    }
    const saved = readState(base, "ws-live");
    expect(saved.agents[0].pausedUntil).toBeUndefined();
    const reply = saved.messages!.find((m) => m.kind === "agent");
    expect(reply?.events?.find((e) => e.kind === "error")?.content).toContain(
      "not your usage limit",
    );
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("waits half an hour, not a minute, when a refusal names a reset already past", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    const before = Date.now();
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "P" });
      await until(() => launches[0]?.prompts.length === 1, "the turn");
      launches[0].emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.floor(before / 1000) - 600,
        },
        session_id: "s",
      });
      launches[0].emit(refused);
      launches[0].emit({ ...result("limit"), is_error: true });
      await until(() => paused(frames).length > 0, "the pause");
    } finally {
      stop();
      log.mockRestore();
    }
    const retryAt = readState(base, "ws-live").agents[0].pausedUntil!;
    expect(retryAt - before).toBeGreaterThanOrEqual(30 * 60_000);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("saves the workspace once its retry has gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed({ livePaused: -1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stop } = await start(base, web);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(launches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(readState(base, "ws-live").agents[0].pausedUntil).toBeUndefined();
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("keeps API-key Codex models enabled but excludes the account from quota reads and retries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { base, web } = seed();
    const readLimits = vi.spyOn(codex, "readCodexRateLimits").mockResolvedValue(null);
    const { server, frames, send, stop } = await start(base, web);
    const isNeutral = (quota: QuotaState) =>
      quota.rows.some((r) => r.provider === "native-codex" && r.reason === "not configured");
    try {
      const init = frames.find((f) => f.type === "init")!;
      expect(init.codexAuth).toMatchObject({ authenticated: true, accountType: "apiKey" });
      expect(init.models).toContainEqual(expect.objectContaining({ backend: "codex" }));
      expect(isNeutral(init.quota as QuotaState)).toBe(true);
      send({ type: "refresh_quota", force: true });
      await until(
        () =>
          frames.some((f) => f.type === "quota_snapshot" && !(f.quota as QuotaState).refreshing),
        "API-key quota refresh",
      );
      send({ type: "recheck_codex_auth" });
      await until(() => frames.some((f) => f.type === "codex_auth_update"), "API-key recheck");
      await vi.advanceTimersByTimeAsync(4 * QUOTA_AUTO_REFRESH_INTERVAL);
      expect(readLimits).not.toHaveBeenCalled();
      expect(isNeutral(server["quota"].state())).toBe(true);
    } finally {
      stop();
      await server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("gates unauthenticated Codex models and quota on startup, keeps Pi openai-codex/*, and unlocks live via recheck_codex_auth", async () => {
    const { base, web } = seed();
    fs.writeFileSync(path.join(base, "config.toml"), "[pi]\n");
    const piCatalog = vi.spyOn(LocalHost.prototype, "discoverPiModels").mockResolvedValue([
      {
        id: "openai-codex/gpt-5.4",
        provider: "openai-codex",
        modelId: "gpt-5.4",
        name: "GPT-5.4 (Pi)",
        effortLevels: ["low", "high"],
      },
    ]);
    let authenticated = false;
    const probeSpy = vi.spyOn(codex, "probeCodexAuth").mockImplementation(() =>
      Promise.resolve({
        cliAvailable: true,
        authenticated,
        status: authenticated ? "authenticated" : "unauthenticated",
        accountType: authenticated ? "chatgpt" : null,
        checkedAt: Date.now(),
      }),
    );
    const readLimitsSpy = vi.spyOn(codex, "readCodexRateLimits").mockResolvedValue({
      limitId: "codex",
      planType: "plus",
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
      secondary: null,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      const init = frames.find((f) => f.type === "init")!;
      expect(init.codexAuth).toMatchObject({ cliAvailable: true, authenticated: false });
      const initModels = init.models as Array<{ id: string; backend: string }>;
      expect(initModels.some((m) => m.backend === "codex")).toBe(false);
      expect(initModels).toContainEqual(
        expect.objectContaining({ id: "openai-codex/gpt-5.4", backend: "pi" }),
      );
      expect((init.quota as QuotaState).rows).toContainEqual(
        expect.objectContaining({
          provider: "native-codex",
          availability: "unavailable",
          reason: "not configured",
        }),
      );

      // Refreshing quota while unauthenticated does not invoke readCodexRateLimits.
      send({ type: "refresh_quota", force: true });
      await until(
        () =>
          frames.some(
            (f) => f.type === "quota_snapshot" && (f.quota as QuotaState).refreshing === false,
          ),
        "unauthenticated quota refresh",
      );
      expect(readLimitsSpy).not.toHaveBeenCalled();

      // Sign in and request an on-demand re-check without restarting the server.
      authenticated = true;
      send({ type: "recheck_codex_auth" });
      await until(
        () =>
          frames.some(
            (f) =>
              f.type === "codex_auth_update" &&
              (f.codexAuth as { authenticated?: boolean }).authenticated === true,
          ) &&
          frames.some(
            (f) =>
              f.type === "models_update" &&
              (f.models as Array<{ backend: string }>).some((m) => m.backend === "codex"),
          ) &&
          frames.some(
            (f) =>
              f.type === "quota_snapshot" &&
              (f.quota as QuotaState).rows.some(
                (r) => r.provider === "native-codex" && r.availability === "available",
              ),
          ),
        "live codex unlock after re-check",
      );

      expect(probeSpy).toHaveBeenCalledTimes(2);
      expect(readLimitsSpy).toHaveBeenCalledTimes(1);
      const latestModels = frames.filter((f) => f.type === "models_update").at(-1)
        ?.models as Array<{ id: string; backend: string }>;
      expect(latestModels).toContainEqual(
        expect.objectContaining({ id: "gpt-6-astra", backend: "codex" }),
      );
      expect(latestModels).toContainEqual(
        expect.objectContaining({ id: "openai-codex/gpt-5.4", backend: "pi" }),
      );

      // Signing back out re-gates native Codex models & quota without touching Pi openai-codex/*.
      authenticated = false;
      const beforeSignoutCount = frames.length;
      send({ type: "recheck_codex_auth" });
      await until(
        () =>
          frames
            .slice(beforeSignoutCount)
            .some(
              (f) =>
                f.type === "codex_auth_update" &&
                (f.codexAuth as { authenticated?: boolean }).authenticated === false,
            ) &&
          frames
            .slice(beforeSignoutCount)
            .some(
              (f) =>
                f.type === "models_update" &&
                !(f.models as Array<{ backend: string }>).some((m) => m.backend === "codex"),
            ) &&
          frames
            .slice(beforeSignoutCount)
            .some(
              (f) =>
                f.type === "quota_snapshot" &&
                (f.quota as QuotaState).rows.some(
                  (r) =>
                    r.provider === "native-codex" &&
                    r.availability === "unavailable" &&
                    r.reason === "not configured" &&
                    r.observedAt > 0,
                ),
            ),
        "live codex lock after sign-out re-check",
      );
      const afterSignoutModels = frames.filter((f) => f.type === "models_update").at(-1)
        ?.models as Array<{ id: string; backend: string }>;
      expect(afterSignoutModels).toContainEqual(
        expect.objectContaining({ id: "openai-codex/gpt-5.4", backend: "pi" }),
      );
    } finally {
      piCatalog.mockRestore();
      stop();
      log.mockRestore();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
