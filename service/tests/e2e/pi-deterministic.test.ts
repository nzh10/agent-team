import { execFileSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { trackAcceptanceProcesses } from "../../../scripts/e2e-pi-acp";
import { lsofBinary } from "../lsof";
import type { ProjectManager } from "../../src/project/manager";
import { ReportJournalStore } from "../../src/project/report-journal";
import type { Project } from "../../src/project/store";
import { Server } from "../../src/server/server";
import { LocalHost } from "../../src/session/host";
import { PanelHttpServer } from "../../src/session/panel-http";
import { PiRpcClient } from "../../src/session/pi-rpc";
import { PiSession } from "../../src/session/pi";
import {
  discoverLocalPiPackages,
  prepareControlledPiAgentHome,
} from "../../src/session/pi-agent-home";
import type { StreamEvent, UiDialogRequest } from "../../src/session/types";
import { HistoryService } from "../../src/workspace/history-service";
import { historyFile, historyIndexFile } from "../../src/workspace/state";
import type { Workspace, WorkspaceInfo } from "../../src/workspace/workspace";
import { localPiBinary } from "../local-pi";

const model = "pi-e2e/scenario";
const markerA = "e2ealphaneedle";
const markerB = "e2ebetaneedle";
const foregroundA = "e2eforegroundalpha";
const foregroundB = "e2eforegroundbeta";
const note = { slug: "design", content: "pi-e2e note body", expected_version: null };

function writeScenario(file: string, gates: string, subagents: string) {
  const sdk = createRequire(localPiBinary!)
    .resolve.paths("@earendil-works/pi-ai")
    ?.map((dir) => path.join(dir, "@earendil-works/pi-ai", "package.json"))
    .find((file) => fs.existsSync(file));
  if (!sdk) throw new Error("The Pi installation does not contain @earendil-works/pi-ai");
  const pkg = JSON.parse(fs.readFileSync(sdk, "utf8")) as { exports: { ".": { import: string } } };
  const piAi = pathToFileURL(path.resolve(path.dirname(sdk), pkg.exports["."].import)).href;
  fs.writeFileSync(
    file,
    `import fs from "node:fs";
import path from "node:path";
import { createAssistantMessageEventStream } from ${JSON.stringify(piAi)};

const gates = ${JSON.stringify(gates)};
const modelId = ${JSON.stringify(model)};
const note = ${JSON.stringify(note)};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (name, args) => ({ name, args });
export default function (pi) {
  let selected;
  if (!process.env.PI_SUBAGENT_CHILD) {
    let registration;
    pi.on("session_start", async (_event, ctx) => {
      const { registerRequiredChildExtensions } = await import(${JSON.stringify(pathToFileURL(path.join(subagents, "bundle/required-child-extensions.js")).href)});
      registration = registerRequiredChildExtensions({ sessionId: ctx.sessionManager.getSessionId(), extensions: [{ id:"pi-e2e", path:${JSON.stringify(file)} }] });
    });
    pi.on("session_shutdown", () => registration?.dispose());
  }
  pi.on("before_agent_start", async (event, ctx) => {
    const dialog = /pi-e2e-dialog-(click|timeout)/.exec(event.prompt)?.[1];
    if (dialog) selected = await ctx.ui.select(dialog, ["red", "blue"], { timeout: dialog === "click" ? 5000 : 400 });
  });
  pi.registerProvider("pi-e2e", {
    baseUrl: "http://127.0.0.1", apiKey: "fixture", api: "pi-e2e-api",
    models: [{ id: "scenario", name: "Pi E2E", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void Promise.resolve().then(async () => {
        const messages = context.messages;
        const text = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("\\n");
        // Pi can append user-role subagent notices after a real prompt in the same model call.
        // Do not hide that prompt, or replay it on a later notice-only wakeup.
        const completed = messages.findLastIndex((m) => m.role === "assistant" && m.stopReason === "stop");
        const last = messages.findLastIndex((m, i) => i > completed && m.role === "user" && !text(m).startsWith("<pi_subagents_notice "));
        const prompt = last < 0 ? "" : text(messages[last]);
        const count = messages.slice(last + 1).filter((m) => m.role === "toolResult").length;
        const child = /pi-e2e-child:(\\w+):(\\w+)/.exec(prompt);
        let step;
        let reply = "pi-e2e-ready";
        if (child) {
          const [, gate, marker] = child;
          fs.appendFileSync(path.join(gates, "seen-" + gate), marker + "\\n");
          if (gate === "Bunknown") pi.sendMessage({customType:"steer-test-notice",content:"background-notice-survived",display:true}, { triggerTurn:true });
          const deadline = Date.now() + 45000;
          while (!options?.signal?.aborted && !fs.existsSync(path.join(gates, gate)) && Date.now() < deadline) await pause(30);
          reply = fs.existsSync(path.join(gates, gate)) ? marker : "gate-not-released";
        } else if (messages.some((m) => text(m).includes("background-notice-survived")) && !fs.existsSync(path.join(gates,"notice-received"))) {
          fs.writeFileSync(path.join(gates,"notice-received"), "");
        } else if (prompt.includes("pi-e2e-lead-plan")) {
          const steps = [call("write_objective", {id:"pi-e2e/suite", title:"Pi E2E", goal:"run scenario"}),
            call("add_items", {objective_id:"pi-e2e/suite", tasks:["exercise Pi Worker"]}),
            call("start_session", {title:"Pi Worker", cwd:".", task:"pi-e2e-worker-notes", model:modelId, objective_id:"pi-e2e/suite", task_id:"t1"})];
          step = steps[count]; reply = "pi-e2e-lead-planned";
        } else if (prompt.includes("pi-e2e-worker-notes")) {
          const steps = [call("write_note", note), call("read_note", {slug:note.slug}), call("list_notes", {}),
            call("write_note", {...note, content:"stale write"})];
          step = steps[count]; reply = "pi-e2e-worker-noted";
        } else if (prompt.includes("pi-e2e-finish")) {
          if (!count) step = call("finish_task", {summary:"pi-e2e-worker-report", context:"reviewed by scenario"});
          reply = "pi-e2e-worker-finished";
        } else if (prompt.includes("pi-e2e-worker-report")) {
          reply = "pi-e2e-lead-acknowledged";
        } else if (prompt.includes("pi-e2e-dialog-")) {
          reply = "pi-e2e-selected:" + (selected ?? "cancelled");
        } else if (prompt.includes("pi-e2e-launch:")) {
          const mode = /pi-e2e-launch:(\\w+)/.exec(prompt)[1];
          const task = (suffix, marker) => ({ agent: "pi-e2e-child", task: "pi-e2e-child:" + mode + suffix + ":" + marker, model:modelId });
          if (!count) {
            const pair = mode === "foreground"
              ? [${JSON.stringify(foregroundA)}, ${JSON.stringify(foregroundB)}]
              : mode === "reconcile"
                ? [${JSON.stringify(markerA)}, ${JSON.stringify(markerB)}]
                : ["e2e" + mode + "alpha", "e2e" + mode + "beta"];
            const args = mode === "foreground" ? { async:false, tasks:[task("a", pair[0]), task("b", pair[1])] } :
              { async:true, tasks:[task("a", pair[0]), task("b", pair[1])] };
            step = call("subagent", args);
          }
          reply = "pi-e2e-launch-returned:" + mode;
        }
        const content = step ? [{type:"toolCall", id:crypto.randomUUID(), name:step.name, arguments:step.args}] : [{type:"text", text:reply}];
        const message = {role:"assistant", content, api:model.api, provider:model.provider, model:model.id,
          usage:{ input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
          stopReason:step ? "toolUse" : "stop", timestamp:Date.now()};
        stream.push({type:"start", partial:message});
        stream.push({type:"done", reason:message.stopReason, message});
        stream.end();
      });
      return stream;
    },
  });
}
`,
  );
}

interface Frame {
  type: string;
  workspaceId?: string;
  workspace?: WorkspaceInfo;
  project?: Project & { objectives: Array<{ tasks: Array<{ state: string }> }> };
  dialog?: UiDialogRequest;
  requestId?: string;
  messageId?: string;
  taskId?: string;
  events?: StreamEvent[];
  event?: StreamEvent;
  state?: string;
  status?: string;
  content?: string;
  message?: { id: string; content?: string; status?: string };
  messages?: unknown[];
  models?: Array<{ id: string }>;
}

function listeningPorts() {
  try {
    return execFileSync(
      lsofBinary(),
      ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      { encoding: "utf8", timeout: 1000 },
    )
      .split("\n")
      .flatMap((line) => (/^n.*:(\d+)$/.test(line) ? [Number(line.split(":").at(-1))] : []));
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

async function verifyPortClosed(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(new Error(`Port ${port} probe timed out`));
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} still accepts connections`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNREFUSED" ? resolve() : reject(error),
    );
  });
}

const subagents = localPiBinary && discoverLocalPiPackages().piSubagentsRoot;

it.skipIf(!subagents)(
  "runs a deterministic scenario against real WebSocket, Pi RPC and pi-subagents",
  runDeterministicPiScenario,
  180_000,
);

async function runDeterministicPiScenario() {
  const basePorts = listeningPorts();
  if (!subagents) throw new Error("Pi E2E requires a local pi-subagents installation");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yaat-pi-e2e-")));
  const home = prepareControlledPiAgentHome({
    mode: "test-synthetic",
    sourceAgentDir: root,
    packages: [subagents],
  });
  const dirs = [root, home.piAgentDir, home.geminiHome!, home.env.PI_SUBAGENTS_TEMP_ROOT];
  const tracker = trackAcceptanceProcesses(dirs);
  const ports = new Set<number>();
  let server: Server | undefined;
  let ws: WebSocket | undefined;
  let offline: HistoryService | undefined;
  const searches: Array<{ session: string; marker: string; taskId: string }> = [];
  const failures: unknown[] = [];
  let dropped = 0;
  try {
    const data = path.join(root, "data");
    const plain = path.join(root, "plain");
    const repo = path.join(root, "repo");
    const gates = path.join(root, "gates");
    for (const dir of [data, plain, repo, gates]) fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q", repo], {
      env: {
        ...process.env,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    const extension = path.join(home.piAgentDir, "extensions", "scenario.ts");
    fs.mkdirSync(path.dirname(extension));
    writeScenario(extension, gates, subagents);
    const subagentConfig = path.join(home.piAgentDir, "extensions", "subagent");
    fs.mkdirSync(subagentConfig);
    fs.writeFileSync(
      path.join(subagentConfig, "config.json"),
      JSON.stringify({ disabledFeatures: ["workflow-scripts"], toolActivation: "eager" }),
    );
    fs.writeFileSync(
      home.settingsPath,
      JSON.stringify({
        packages: [subagents],
        defaultProvider: "pi-e2e",
        defaultModel: "scenario",
        defaultProjectTrust: "always",
        enabledModels: [model],
      }),
    );
    const agentDir = path.join(home.piAgentDir, "agents");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
      path.join(agentDir, "pi-e2e-child.md"),
      `---\nname: pi-e2e-child\ndescription: Deterministic Pi test child\nextensions: []\ntools: read\n---\nFollow the acceptance scenario.\n`,
    );
    fs.writeFileSync(
      path.join(data, "config.toml"),
      `[pi]\noffline = true\npackages = [${JSON.stringify(subagents)}]\ndefault_model = "${model}"\n`,
    );
    vi.stubEnv("AGENT_TEAM_HOST", "127.0.0.1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const spawn = PiRpcClient.spawn.bind(PiRpcClient);
    vi.spyOn(PiRpcClient, "spawn").mockImplementation((options) => {
      const rpc = spawn({
        ...options,
        env: {
          ...options?.env,
          ...home.env,
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_DATA_HOME: path.join(root, "share"),
          XDG_STATE_HOME: path.join(root, "state"),
          TMPDIR: root,
        },
      });
      rpc.on("stderr", (text: string) => {
        if (!text.startsWith("Warning: No project session found with id")) console.error(text);
      });
      rpc.on("event", (event: { type?: string }) => {
        if (event.type === "extension_error") console.error(event);
      });
      return rpc;
    });
    const isolate = {
      piBinary: localPiBinary,
      piArgs: ["-e", extension],
      piAgentDir: home.piAgentDir,
    };
    // The production LocalHost constructs every PiSession; inject only the test home.
    // Preserve the actual receiver when calling the original methods below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const discover = LocalHost.prototype.discoverPiModels;
    vi.spyOn(LocalHost.prototype, "discoverPiModels").mockImplementation(function (
      this: LocalHost,
      config,
    ) {
      return discover.call(this, { ...config, ...isolate });
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const create = LocalHost.prototype.createSession;
    vi.spyOn(LocalHost.prototype, "createSession").mockImplementation(function (
      this: LocalHost,
      id,
      config,
    ) {
      expect(config.backend).toBe("pi");
      const session = create.call(this, id, { ...config, ...isolate });
      // Drop only actual notify frames, leaving real tool, model and control traffic intact.
      const receiver = session as unknown as {
        handleEvent(event: { message?: { customType?: string } }): void;
      };
      const handle = receiver.handleEvent.bind(receiver);
      vi.spyOn(receiver, "handleEvent").mockImplementation((event) => {
        if (event.message?.customType === "subagent-notify") {
          dropped++;
          return;
        }
        handle(event);
      });
      return session;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const listen = PanelHttpServer.prototype.listen;
    vi.spyOn(PanelHttpServer.prototype, "listen").mockImplementation(async function (
      this: PanelHttpServer,
    ) {
      const address = await listen.call(this);
      ports.add(address.port);
      return address;
    });
    const sendRpc = vi.spyOn(PanelHttpServer.prototype, "sendSubagentsRpc");
    server = new Server(0, data, data);
    const port = await server.listening;
    ports.add(port);
    const frames: Frame[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as Frame));
    await once(ws, "open");
    const wire = (payload: object) => ws!.send(JSON.stringify(payload));
    const seen = (type: string, predicate: (f: Frame) => boolean = () => true, since = 0) =>
      vi.waitFor(
        () => {
          const frame = frames.slice(since).find((f) => f.type === type && predicate(f));
          if (!frame)
            throw new Error(
              `Missing ${type}; recent frames: ${JSON.stringify(frames.slice(-8)).slice(-3000)}`,
            );
          return frame;
        },
        { timeout: 20000, interval: 25 },
      );
    expect(
      (await seen("init")).models?.some((entry) => entry.id === model),
      "synthetic model was not discovered",
    ).toBe(true);
    wire({ type: "create_project", name: "Plain Pi E2E", root: null, cwd: plain, model });
    wire({ type: "create_project", name: "Git Pi E2E", root: repo, model });
    const plainProject = (await seen("project_updated", (f) => f.project?.name === "Plain Pi E2E"))
      .project!;
    const gitProject = (await seen("project_updated", (f) => f.project?.name === "Git Pi E2E"))
      .project!;
    expect(plainProject.root).toBeNull();
    expect(gitProject.root).toBe(repo);
    expect(plainProject.id).not.toBe(gitProject.id);
    expect(plainProject.leadWorkspaceId).not.toBe(gitProject.leadWorkspaceId);
    const lead = plainProject.leadWorkspaceId!;
    const internal = server as unknown as {
      workspaces: Map<string, Workspace>;
      projects: ProjectManager;
    };
    const workspace = (id: string) => internal.workspaces.get(id)!;
    const session = (id: string) => workspace(id).resolveAgent()!.session as PiSession;
    const prompt = (id: string, content: string) =>
      wire({ type: "send_message", workspaceId: id, content });
    const done = (id: string, content: string) =>
      seen("message_done", (f) => f.workspaceId === id && f.content?.includes(content) === true);
    prompt(gitProject.leadWorkspaceId!, "pi-e2e-git-ready");
    await done(gitProject.leadWorkspaceId!, "pi-e2e-ready");
    prompt(lead, "pi-e2e-lead-plan");
    await done(lead, "pi-e2e-lead-planned");
    const worker = [...internal.workspaces.values()].find(
      (w) => w.projectLink?.projectId === plainProject.id && w.projectLink.role === "worker",
    )!.id;
    await done(worker, "pi-e2e-worker-noted");
    const results = frames
      .filter((f) => f.workspaceId === worker && f.event?.kind === "tool_result")
      .map((f) => f.event!);
    const writes = results.filter((r) => r.toolName?.includes("write_note"));
    expect(writes.map(({ isError }) => isError)).toEqual([false, true]);
    expect(writes[0].content).toMatch(/[a-f0-9]{16}/);
    expect(writes[1].content).toMatch(/version conflict/i);
    expect(results.find((r) => r.toolName?.includes("read_note"))?.content).toContain(note.content);
    expect(results.find((r) => r.toolName?.includes("list_notes"))?.content).toContain(note.slug);
    await seen(
      "workspace_updated",
      (f) => f.workspace?.id === worker && f.workspace.awaitsUser === true,
    );
    console.log("Pi E2E: separate Git/no-Git projects, real Worker, versioned notes passed");
    for (const kind of ["click", "timeout"]) {
      const offset = frames.length;
      const piResolution = once(session(lead), "ui_dialog_resolved");
      prompt(lead, `pi-e2e-dialog-${kind}`);
      const dialog = (await seen("ui_dialog_request", (f) => f.dialog?.title === kind, offset))
        .dialog!;
      expect(dialog.options).toEqual(["red", "blue"]);
      await seen(
        "workspace_updated",
        (f) => f.workspace?.id === lead && f.workspace.awaitsUser === true,
        offset,
      );
      if (kind === "click") wire({ type: "ui_dialog_response", ...dialog, value: "blue" });
      await seen("ui_dialog_resolved", (f) => f.requestId === dialog.requestId, offset);
      expect(await piResolution).toEqual([
        expect.objectContaining({ requestId: dialog.requestId, cancelled: kind === "timeout" }),
      ]);
      await done(lead, `pi-e2e-selected:${kind === "click" ? "blue" : "cancelled"}`);
      expect(session(lead).pendingUiDialogs).toEqual([]);
    }
    console.log("Pi E2E: blocking select click and timeout passed");
    const openGate = (name: string) => fs.writeFileSync(path.join(gates, name), "");
    const gateEntered = (gate: string) =>
      vi.waitFor(() => expect(fs.existsSync(path.join(gates, `seen-${gate}`))).toBe(true), {
        timeout: 8000,
      });
    for (const outcome of ["delivered", "preclaim", "unknown"]) {
      const since = frames.length;
      const before = session(lead).usage.turns;
      prompt(lead, `pi-e2e-child:A${outcome}:initial`);
      await gateEntered(`A${outcome}`);
      const follow = `pi-e2e-child:B${outcome}:reply${outcome}`;
      prompt(lead, follow);
      const queued = (
        await seen(
          "new_message",
          (f) => f.message?.content === follow && f.message.status === "queued",
          since,
        )
      ).message!;
      if (outcome === "delivered") {
        prompt(lead, "pi-e2e-child:Cdelivered:thirdreply");
        await seen(
          "new_message",
          (f) =>
            f.message?.content === "pi-e2e-child:Cdelivered:thirdreply" &&
            f.message.status === "queued",
          since,
        );
      }
      if (outcome === "preclaim") wire({ type: "interrupt", workspaceId: lead });
      else openGate(`A${outcome}`);
      await gateEntered(`B${outcome}`);
      if (outcome === "unknown") {
        wire({ type: "interrupt", workspaceId: lead });
        await seen(
          "message_done",
          (f) => f.messageId === queued.id && f.status === "outcome_unknown",
          since,
        );
        ws.close();
        await once(ws, "close");
        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as Frame));
        await once(ws, "open");
        const reopened = frames.length;
        wire({ type: "open_workspace", workspaceId: lead });
        const page = await seen("workspace_messages", (f) => f.workspaceId === lead, reopened);
        expect(page.messages).toContainEqual(
          expect.objectContaining({ id: queued.id, status: "outcome_unknown" }),
        );
        prompt(lead, "check retained notices");
        await vi.waitFor(
          () => expect(fs.existsSync(path.join(gates, "notice-received"))).toBe(true),
          { timeout: 8000 },
        );
        await vi.waitFor(() => expect(session(lead).isRunning).toBe(false));
      } else {
        openGate(`B${outcome}`);
        if (outcome === "delivered") {
          await gateEntered("Cdelivered");
          openGate("Cdelivered");
        }
        await seen(
          "message_done",
          (f) => f.workspaceId === lead && f.content === `reply${outcome}`,
          since,
        );
        if (outcome === "delivered") {
          await seen(
            "message_done",
            (f) => f.workspaceId === lead && f.content === "thirdreply",
            since,
          );
        }
        expect(session(lead).usage.turns - before).toBe(outcome === "preclaim" ? 2 : 1);
      }
      expect(fs.readFileSync(path.join(gates, `seen-B${outcome}`), "utf8").trim()).toBe(
        `reply${outcome}`,
      );
    }
    const child = async (kind: string, since: number, taskId?: string) =>
      (
        await seen(
          "stream_event",
          (f) =>
            f.workspaceId === lead &&
            f.event?.kind === kind &&
            (!taskId || f.event.subagent?.taskId === taskId),
          since,
        )
      ).event!.subagent!;
    const childEvents = async (taskId: string, since: number) => {
      const owner = frames
        .slice(since)
        .find((f) => f.event?.kind === "subagent_start" && f.event.subagent?.taskId === taskId);
      const requestedAt = frames.length;
      wire({
        type: "load_subagent_events",
        workspaceId: lead,
        messageId: owner?.messageId,
        taskId,
      });
      const reply = await seen("subagent_events", (f) => f.taskId === taskId, requestedAt);
      return reply.events?.map((event) => event.content).join("\n");
    };
    let offset = frames.length;
    prompt(lead, "pi-e2e-launch:foreground");
    try {
      const a = await child("subagent_start", offset);
      const b = await child("subagent_start", offset, a.taskId.replace(/0$/, "1"));
      openGate("foregrounda");
      openGate("foregroundb");
      await done(lead, "pi-e2e-launch-returned:foreground");
      for (const [taskId, marker] of [
        [a.taskId, foregroundA],
        [b.taskId, foregroundB],
      ]) {
        expect((await child("subagent_done", offset, taskId)).status).toBe("completed");
        expect(await childEvents(taskId, offset)).toContain(marker);
        searches.push({ session: lead, marker, taskId });
      }
      console.log("Pi E2E: foreground siblings completed with separate transcripts");
    } catch (error) {
      failures.push(new Error("Foreground sibling execution", { cause: error }));
    }

    const leadSession = session(lead);
    const control = leadSession as unknown as { sessionKey: string; panelHttp: PanelHttpServer };
    const { sessionKey, panelHttp } = control;
    const routes = (panelHttp as unknown as { sessions: Map<string, { control?: ServerResponse }> })
      .sessions;
    for (const mode of ["reconcile", "rpcstop", "fallback"]) {
      offset = frames.length;
      const notifyBaseline = dropped;
      prompt(lead, `pi-e2e-launch:${mode}`);
      try {
        const a = await child("subagent_start", offset);
        const b = await child("subagent_start", offset, a.taskId.replace(/0$/, "1"));
        expect(a.taskId).not.toBe(b.taskId);
        await done(lead, `pi-e2e-launch-returned:${mode}`);
        await seen("agent_state", (f) => f.workspaceId === lead && f.state === "waiting", offset);
        expect(leadSession.backgroundTaskList).toHaveLength(2);
        const runs = leadSession.getState().activeAsyncRuns ?? [];
        expect(runs).toHaveLength(1);
        const statusFile = path.join(runs[0].asyncDir, "status.json");
        await vi.waitFor(() => expect(fs.existsSync(statusFile)).toBe(true));
        if (mode === "reconcile") {
          openGate(`${mode}a`);
          openGate(`${mode}b`);
          await vi.waitFor(() => expect(dropped).toBeGreaterThan(notifyBaseline), {
            timeout: 15000,
          });
          expect(leadSession.backgroundTaskList.length).toBeGreaterThan(0);
          const {
            sessionId,
            mode: runMode,
            steps,
          } = JSON.parse(fs.readFileSync(statusFile, "utf8")) as {
            sessionId: string;
            mode: string;
            steps: Array<{ status: string; workflowKey?: string; sessionFile?: string }>;
          };
          console.log("Pi E2E async status.json", {
            sessionId,
            mode: runMode,
            steps: steps.map(({ status, workflowKey, sessionFile }) => ({
              status,
              workflowKey,
              sessionFile,
            })),
          });
          await leadSession.reconcileAsyncRuns();
          searches.push(
            { session: lead, marker: markerA, taskId: a.taskId },
            { session: lead, marker: markerB, taskId: b.taskId },
          );
        } else {
          expect(panelHttp.isControlConnected(sessionKey)).toBe(true);
          if (mode === "fallback") {
            routes.get(sessionKey)!.control!.destroy();
            await vi.waitFor(() => expect(panelHttp.isControlConnected(sessionKey)).toBe(false), {
              interval: 10,
            });
          }
          const calls = sendRpc.mock.calls.length;
          try {
            await leadSession.stopTask(a.taskId);
          } finally {
            const stops = sendRpc.mock.calls.slice(calls).filter(([, method]) => method === "stop");
            if (mode === "rpcstop") {
              expect(stops).toHaveLength(1);
              expect(stops[0][0]).toBe(sessionKey);
              expect(typeof (stops[0][2] as { childId?: unknown })?.childId).toBe("string");
            } else expect(stops).toHaveLength(0);
          }
          await vi.waitFor(
            async () => {
              await leadSession.reconcileAsyncRuns();
              expect(
                frames
                  .slice(offset)
                  .some(
                    (f) =>
                      f.event?.kind === "subagent_done" &&
                      f.event.subagent?.taskId === a.taskId &&
                      f.event.subagent.status === "stopped",
                  ),
              ).toBe(true);
            },
            { timeout: 8000, interval: 150 },
          );
          expect(leadSession.backgroundTaskList).toEqual([
            expect.objectContaining({ id: b.taskId }),
          ]);
          openGate(`${mode}b`);
        }
        await vi.waitFor(
          async () => {
            await leadSession.reconcileAsyncRuns();
            expect(
              frames
                .slice(offset)
                .some(
                  (f) =>
                    f.event?.kind === "subagent_done" &&
                    f.event.subagent?.taskId === b.taskId &&
                    f.event.subagent.status === "completed",
                ),
            ).toBe(true);
            expect(leadSession.backgroundTaskList).toEqual([]);
          },
          { timeout: 12000, interval: 150 },
        );
        await seen("agent_state", (f) => f.workspaceId === lead && f.state === "idle", offset);
        console.log(`Pi E2E: ${mode} waiting-to-idle passed`);
        const expectedB = mode === "reconcile" ? markerB : `e2e${mode}beta`;
        expect(await childEvents(b.taskId, offset), `${mode} sibling B transcript`).toContain(
          expectedB,
        );
        if (mode === "reconcile")
          expect(await childEvents(a.taskId, offset), "reconcile sibling A transcript").toContain(
            markerA,
          );
      } catch (error) {
        failures.push(new Error(`Async subagent ${mode}`, { cause: error }));
      } finally {
        openGate(`${mode}a`);
        openGate(`${mode}b`);
        try {
          await vi.waitFor(
            async () => {
              await leadSession.reconcileAsyncRuns();
              expect(leadSession.backgroundTaskList).toEqual([]);
            },
            { timeout: 12000, interval: 200 },
          );
        } catch (error) {
          failures.push(new Error(`Draining async children after ${mode}`, { cause: error }));
        }
      }
    }

    // Finish and seal the plain project after the real worker's report reached Pi.
    prompt(worker, "pi-e2e-finish");
    await done(worker, "pi-e2e-worker-finished");
    await done(lead, "pi-e2e-lead-acknowledged");
    await seen(
      "project_updated",
      (f) =>
        f.project?.id === plainProject.id && f.project.objectives[0]?.tasks[0]?.state === "review",
    );
    const directory = path.join(data, ".agent-team", "projects", plainProject.id);
    const inbox = path.join(directory, "inbox.json");
    await vi.waitFor(() => {
      const journal = new ReportJournalStore().load(directory);
      expect(journal).toHaveLength(1);
      expect(journal[0].boardState).toBe("applied");
      expect(journal[0].leadDelivery.state).toBe("settled");
    });
    expect(fs.readFileSync(inbox, "utf8")).toContain("pi-e2e-worker-report");
    expect(internal.projects.awaitsUser(workspace(lead))).toBe(false);
    expect(internal.projects.awaitsUser(workspace(worker))).toBe(false);
    console.log("Pi E2E: finish_task journal settled, review board updated and awaitsUser reset");
    const tool = (id: string, name: string) =>
      internal.projects.toolsFor(workspace(id))!.tools.find((t) => t.name === name)!.handler;
    const staleWrite = tool(lead, "write_note");
    const staleObjective = tool(lead, "write_objective");
    const staleFinish = tool(worker, "finish_task");
    const readNote = tool(lead, "read_note");
    const search = tool(lead, "search_history");
    try {
      await vi.waitFor(
        async () =>
          expect(await search({ query: foregroundA, depth: "subagents", session: lead })).toContain(
            foregroundA,
          ),
        { timeout: 5000 },
      );
    } catch (error) {
      failures.push(new Error("Panel search_history foreground marker", { cause: error }));
    }
    wire({ type: "seal_project", projectId: plainProject.id, reason: "Pi E2E complete" });
    const sealed = (
      await seen(
        "project_updated",
        (f) => f.project?.id === plainProject.id && f.project.status === "sealed",
      )
    ).project!;
    expect(sealed.objectives[0].tasks[0].state).toBe("review");
    const inboxFrozen = fs.readFileSync(inbox, "utf8");
    await expect(staleWrite(note)).rejects.toThrow(/sealed/i);
    await expect(staleObjective({ id: "pi-e2e/suite", title: "reject" })).rejects.toThrow(
      /sealed/i,
    );
    await expect(staleFinish({ summary: "reject" }, undefined, "after-seal")).rejects.toThrow(
      /sealed/i,
    );
    expect(fs.readFileSync(inbox, "utf8")).toBe(inboxFrozen);
    expect(await readNote({ slug: note.slug })).toContain(note.content);
    wire({ type: "open_workspace", workspaceId: lead });
    expect(
      (await seen("workspace_messages", (f) => f.workspaceId === lead)).messages?.length,
    ).toBeGreaterThan(0);
    console.log("Pi E2E: seal fences writes and keeps historical reads available");
    const gitLead = gitProject.leadWorkspaceId!;
    offset = frames.length;
    prompt(gitLead, "pi-e2e-launch:shutdown");
    await done(gitLead, "pi-e2e-launch-returned:shutdown");
    await seen("agent_state", (f) => f.workspaceId === gitLead && f.state === "waiting", offset);
    expect(session(gitLead).backgroundTaskList).toHaveLength(2);
  } catch (error) {
    failures.push(error);
  } finally {
    const started = Date.now();
    try {
      tracker.capture();
    } catch (error) {
      failures.push(error);
    }
    ws?.terminate();
    try {
      await server?.close();
    } catch (error) {
      failures.push(error);
    }
    const closedIn = Date.now() - started;
    try {
      expect(await tracker.release(started + 10_000)).toEqual([]);
      expect(closedIn).toBeLessThanOrEqual(5000);
      expect(tracker.observed().length).toBeGreaterThan(0);
      expect(ports.size).toBe(2);
      await Promise.all([...ports].map(verifyPortClosed));
      expect(listeningPorts().sort()).toEqual(basePorts.sort());
      expect(Date.now() - started).toBeLessThanOrEqual(10000);
      console.log(
        `Pi E2E shutdown: ${closedIn}ms; ${tracker.observed().length} observed PIDs gone; both ports released`,
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      const data = path.join(root, "data");
      offline = new HistoryService(historyIndexFile(data), historyFile(data));
      for (const { session, marker, taskId } of searches) {
        try {
          const hits = (
            await offline.search({
              terms: [marker],
              kinds: ["said"],
              sessions: [session],
              depth: "subagents",
              limit: 30,
            })
          ).hits;
          expect(hits.length, `offline child marker ${marker}`).toBeGreaterThan(0);
          expect(
            hits.every((hit) => hit.subagentTaskId === taskId),
            `offline sibling attribution for ${marker}`,
          ).toBe(true);
          console.log(`Pi E2E: offline child marker ${marker} attributed to ${taskId}`);
        } catch (error) {
          failures.push(error);
        }
      }
      if (searches.length) {
        const db = new DatabaseSync(historyIndexFile(data), { readOnly: true });
        try {
          expect(db.prepare("pragma user_version").get()).toMatchObject({ user_version: 5 });
        } finally {
          db.close();
        }
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await offline?.close();
    } catch (error) {
      failures.push(error);
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        expect(fs.existsSync(dir)).toBe(false);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Pi E2E scenario or cleanup failed");
  }
}
