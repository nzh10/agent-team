import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelHttpServer } from "../../src/session/panel-http";
import { PiSession, type PiSessionOptions } from "../../src/session/pi";
import { PiRpcClient, type PiRpcSpawnOptions } from "../../src/session/pi-rpc";
import {
  consumedJsonlOffset,
  createIncrementalJsonlCursor,
  createSubagentProjectionState,
  isSafeChildRunId,
  projectAsyncEventRecord,
  projectSessionV3Record,
  projectTranscriptArtifactRecord,
  readIncrementalJsonlRecords,
  resolveWorkflowStepIndex,
} from "../../src/session/pi-subagents";
import { HostRegistry } from "../../src/session/host";
import type { SessionConfig, StreamEvent } from "../../src/session/types";
import { Workspace, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import {
  createPiWireTransport,
  piIdleState,
  piPanelConnection,
  piReadyReport,
  piRpcResponse,
} from "./helpers/pi-wire-harness";
import {
  appendJsonl,
  assistantText,
  textBlocks,
  transcriptMessage,
  writeJsonl,
  writeStatusJson,
} from "./helpers/subagent-artifacts";

type DetachedRun = { mode: "parallel" | "workflow"; asyncDir: string; asyncId: string };
type Frame = { id: string; type: string; [key: string]: unknown };
const dirs: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];

function tempDir(prefix = "pi-subagents-live-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createSessionHarness(
  dir: string,
  opts?: { piSubagentsTempRoot?: string; options?: Partial<PiSessionOptions> },
) {
  const agentDir = path.join(dir, "home");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const sessionDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const env = opts?.piSubagentsTempRoot
    ? { ...process.env, PI_SUBAGENTS_TEMP_ROOT: opts.piSubagentsTempRoot }
    : undefined;
  const cfg: SessionConfig = {
    cwd: dir,
    backend: "pi",
    uploadsDir: dir,
    piAgentDir: agentDir,
    piSessionDir: sessionDir,
    workspaceId: "ws-live",
    agentId: "agent-live",
  };
  const panel = new PanelHttpServer();
  cleanup.push(() => panel.close());
  let emitter!: (frame: object) => void;

  const factory = (spawnOpts: PiRpcSpawnOptions) => {
    const sessionFile = spawnOpts.args?.includes("--session")
      ? spawnOpts.args[spawnOpts.args.indexOf("--session") + 1]
      : path.join(sessionDir, "session.jsonl");
    const sessionId = spawnOpts.args?.includes("--session-id")
      ? spawnOpts.args[spawnOpts.args.indexOf("--session-id") + 1]
      : "sess-live-1";
    const ready = piReadyReport({
      sessionId: sessionId ?? null,
      sessionFile: sessionFile ?? null,
      cwd: fs.realpathSync.native(dir),
      headerCwd: dir,
      entryCount: 0,
      leafId: null,
    });
    const { headers, endpoint } = piPanelConnection(spawnOpts);
    void fetch(`${endpoint}/toolset`, { headers })
      .then((res) => res.text())
      .then(() =>
        fetch(`${endpoint}/ready`, { method: "POST", headers, body: JSON.stringify(ready) }),
      );

    const respond = (frame: Frame, data?: unknown) => emit(piRpcResponse(frame, data));
    const { stdin, stdout, emit } = createPiWireTransport({
      write(chunk: Buffer, _, cb) {
        const frame = JSON.parse(chunk.toString()) as Frame;
        switch (frame.type) {
          case "get_state":
            respond(frame, piIdleState(sessionId, sessionFile));
            break;
          case "get_available_models":
            respond(frame, { models: [{ provider: "mock", id: "test", contextWindow: 100_000 }] });
            break;
          case "get_available_thinking_levels":
            respond(frame, { levels: ["low", "high"] });
            break;
          case "get_commands":
            respond(frame, { commands: [] });
            break;
          case "prompt":
            respond(frame, { disposition: "started" });
            break;
          case "get_session_stats":
            respond(frame, {
              tokens: { input: 10, output: 5 },
              cost: 0,
              contextUsage: { tokens: 15, contextWindow: 100_000 },
            });
            break;
          default:
            respond(frame);
            break;
        }
        cb();
      },
    });
    emitter = emit;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
    });
    stdin.on("finish", () => stdout.end());
    return new PiRpcClient({ stdin, stdout, child: child as never }, { requestTimeoutMs: 5_000 });
  };

  const session = new PiSession(cfg, {
    panelHttp: panel,
    rpcFactory: factory,
    env,
    livePollIntervalMs: 20,
    ...opts?.options,
  });
  cleanup.push(() => session.dispose(500));
  async function emitTurnStart() {
    await vi.waitFor(() => expect(emitter).toBeDefined());
    emitter({ type: "agent_start" });
    emitter({ type: "turn_start" });
  }
  function startSubagent(toolCallId: string, args: Record<string, unknown>) {
    emitter({ type: "tool_execution_start", toolCallId, toolName: "subagent", args });
  }
  function completeSubagent(toolCallId: string, text: string, details: Record<string, unknown>) {
    emitter({
      type: "tool_execution_end",
      toolCallId,
      toolName: "subagent",
      result: { content: [{ type: "text", text }], details },
      isError: false,
    });
  }
  return {
    session,
    emitTurnStart,
    emit: (frame: object) => emitter(frame),
    async beginTurn(text: string) {
      const events = collectEvents(session);
      const sent = session.send(text);
      await emitTurnStart();
      // Leave the send in flight so the test controls when to emit agent_end.
      return { sent, events };
    },
    async endTurn(sent: ReturnType<PiSession["send"]>) {
      emitter({ type: "agent_end" });
      await sent;
    },
    startSubagent,
    updateSubagent(toolCallId: string, details: Record<string, unknown>) {
      emitter({
        type: "tool_execution_update",
        toolCallId,
        toolName: "subagent",
        partialResult: { content: [], details },
      });
    },
    completeSubagent,
    launchDetached(
      toolCallId: string,
      args: Record<string, unknown>,
      run: DetachedRun,
      text = "launched",
    ) {
      startSubagent(toolCallId, args);
      completeSubagent(toolCallId, text, run);
    },
    restore(state: Parameters<typeof PiSession.fromState>[0]) {
      const restored = PiSession.fromState(state, { panelHttp: panel, livePollIntervalMs: 20 });
      cleanup.push(() => restored.dispose(500));
      return restored;
    },
  };
}

describe("incremental JSONL cursor reader", () => {
  it("handles ENOENT, partial lines, multi-byte UTF-8, malformed lines, and truncation", () => {
    const dir = tempDir();
    const file = path.join(dir, "events.jsonl");
    const cursor = createIncrementalJsonlCursor(file);

    expect(readIncrementalJsonlRecords(cursor)).toEqual([]);
    expect(consumedJsonlOffset(cursor)).toBe(0);

    // Partial line including multi-byte UTF-8 character split before newline
    const line1 = JSON.stringify({ type: "text", content: "你好世界" }) + "\n";
    const line2 = JSON.stringify({ type: "tool_execution_start", toolName: "bash" });
    const partialBytes = Buffer.from(line1 + line2, "utf8");
    const splitPoint = Buffer.from('{"type":"text","content":"你', "utf8").length;

    fs.writeFileSync(file, partialBytes.subarray(0, splitPoint));
    expect(readIncrementalJsonlRecords(cursor)).toEqual([]);
    expect(consumedJsonlOffset(cursor)).toBe(0);

    fs.appendFileSync(file, partialBytes.subarray(splitPoint));
    expect(readIncrementalJsonlRecords(cursor)).toEqual([{ type: "text", content: "你好世界" }]);
    expect(consumedJsonlOffset(cursor)).toBe(Buffer.byteLength(line1, "utf8"));

    // Complete line2 + blank line + malformed complete line + line3
    const tail =
      "\nnot-valid-json\n" +
      JSON.stringify({ type: "tool_execution_end", toolCallId: "t1" }) +
      "\n";
    fs.appendFileSync(file, tail);
    expect(readIncrementalJsonlRecords(cursor)).toEqual([
      { type: "tool_execution_start", toolName: "bash" },
      { type: "tool_execution_end", toolCallId: "t1" },
    ]);

    // File truncation / replacement shrinks file size -> cursor resets cleanly
    const replacement = JSON.stringify({ type: "reset_line" }) + "\n";
    fs.writeFileSync(file, replacement);
    expect(readIncrementalJsonlRecords(cursor)).toEqual([{ type: "reset_line" }]);
    expect(consumedJsonlOffset(cursor)).toBe(Buffer.byteLength(replacement, "utf8"));
  });
});

describe("incremental subagent record projection & dedup", () => {
  it("deduplicates async events across tool_execution_* and message_end and ignores noisy frames", () => {
    const state = createSubagentProjectionState();
    const bridge = new Set<string>(["read_note"]);
    const project = (record: Record<string, unknown>) =>
      projectAsyncEventRecord(record, state, bridge);
    for (const noise of [
      { type: "message_start" },
      { type: "turn_end" },
      { type: "agent_end" },
      { type: "subagent.child-status", childId: "task-1" },
    ]) {
      expect(project(noise).events, noise.type).toEqual([]);
    }

    const startBatch = project({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    expect(startBatch.events).toHaveLength(1);
    expect(startBatch.events[0]).toMatchObject({ kind: "tool_use", toolUseId: "tc-1" });

    // Assistant message_end carrying the same toolCall plus thinking & text must NOT duplicate tc-1
    const msgEndBatch = project({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4",
        content: [
          { type: "thinking", thinking: "checking" },
          { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "README.md" } },
          { type: "toolCall", id: "tc-2", name: "read_note", arguments: { slug: "plan" } },
          { type: "text", text: "summary" },
        ],
      },
    });
    expect(msgEndBatch.executionChanged).toBe(true);
    expect(state.execution.model).toBe("anthropic/claude-sonnet-4");
    expect(msgEndBatch.events.map((e) => [e.kind, e.toolUseId])).toEqual([
      ["thinking", undefined],
      ["tool_use", "tc-2"],
      ["text", undefined],
    ]);

    // Subsequent tool_execution_start for tc-2 is ignored because message_end already emitted it
    expect(
      project({ type: "tool_execution_start", toolCallId: "tc-2", toolName: "read_note", args: {} })
        .events,
    ).toEqual([]);

    // tool_execution_end emits tool_result once; subsequent message_end(toolResult) for same tc-1 is deduped
    const endBatch = project({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "read",
      result: { content: textBlocks("ok") },
      durationMs: 12,
    });
    expect(endBatch.events).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        toolUseId: "tc-1",
        content: "ok",
        durationMs: 12,
      }),
    ]);
    expect(
      project({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          content: textBlocks("ok"),
        },
      }).events,
    ).toEqual([]);
  });

  it("projects transcript artifacts and session v3 entries without duplicating tool calls", () => {
    const tState = createSubagentProjectionState();
    expect(
      projectTranscriptArtifactRecord(transcriptToolStart("t1", "bash", { command: "ls" }), tState)
        .events,
    ).toEqual([expect.objectContaining({ kind: "tool_use", toolUseId: "t1", toolName: "bash" })]);

    const tMsg = projectTranscriptArtifactRecord(
      transcriptMessage("assistant", {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        content: [
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "done" },
        ],
      }),
      tState,
    );
    expect(tMsg.executionChanged).toBe(true);
    expect(tMsg.events).toEqual([{ kind: "text", content: "done" }]);

    const sState = createSubagentProjectionState();
    for (const record of [
      { type: "model_change", provider: "anthropic", modelId: "claude-opus-4" },
      { type: "thinking_level_change", thinkingLevel: "high" },
    ]) {
      expect(projectSessionV3Record(record, sState).executionChanged).toBe(true);
    }
    expect(sState.execution).toEqual({ model: "anthropic/claude-opus-4", effort: "high" });
  });

  it("parses workflow keys and validates childRunId segments", () => {
    expect(resolveWorkflowStepIndex({ stepIndex: 1 }, 3)).toBe(1);
    expect(resolveWorkflowStepIndex({ childId: "task-2" }, 3)).toBe(1);
    expect(resolveWorkflowStepIndex({ workflowKey: "step-1" }, 3)).toBe(0);
    expect(resolveWorkflowStepIndex({ childId: "task-9" }, 2)).toBeUndefined();
    expect(isSafeChildRunId("run-123")).toBe(true);
    expect(isSafeChildRunId("../escape")).toBe(false);
    expect(isSafeChildRunId("a/b")).toBe(false);
  });
});

const transcriptToolStart = (toolCallId: string, toolName: string, args: object) => ({
  recordType: "tool_start",
  toolCallId,
  toolName,
  args,
});
const transcriptToolResult = (toolCallId: string, text: string) =>
  transcriptMessage("toolResult", { role: "toolResult", toolCallId, content: textBlocks(text) });

function createRunDir(root: string, runId: string) {
  const dir = path.join(root, "async-subagent-runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const writeAsyncEvents = (dir: string, ...records: object[]) =>
  writeJsonl(path.join(dir, "events.jsonl"), records);
const appendAsyncEvents = (dir: string, ...records: object[]) =>
  appendJsonl(path.join(dir, "events.jsonl"), records);

function collectEvents(session: PiSession) {
  const events: StreamEvent[] = [];
  session.on("event", (event: StreamEvent) => events.push(event));
  return events;
}

function assistantMessageEnd(text: string, subagentStepIndex?: number) {
  return {
    type: "message_end",
    ...(subagentStepIndex === undefined ? {} : { subagentStepIndex }),
    message: assistantText(text),
  };
}

function bySubagent(taskId: string, kind?: StreamEvent["kind"], innerText?: string) {
  return (event: StreamEvent) =>
    event.subagent?.taskId === taskId &&
    (kind === undefined || event.kind === kind) &&
    (innerText === undefined || event.subagent._innerEvent?.content === innerText);
}

function expectProgress(
  events: StreamEvent[],
  taskId: string | undefined,
  inner: Partial<StreamEvent>,
) {
  const progress = events.filter(
    (e) =>
      e.kind === "subagent_progress" && (taskId === undefined || e.subagent?.taskId === taskId),
  );
  expect(progress.map((e) => e.subagent?._innerEvent)).toContainEqual(
    expect.objectContaining(inner),
  );
}

const waitForProgress = (
  events: StreamEvent[],
  taskId: string | undefined,
  inner: Partial<StreamEvent>,
) => vi.waitFor(() => expectProgress(events, taskId, inner));

describe("PiSession live subagent streaming", () => {
  it("streams foreground single subagent transcriptPath events before tool_execution_end", async () => {
    const dir = tempDir();
    const h = createSessionHarness(dir);
    const { sent, events } = await h.beginTurn("run foreground");

    const transcriptPath = path.join(dir, "child_transcript.jsonl");
    h.startSubagent("fg-call-1", { agent: "scout", task: "inspect code", async: false });

    h.updateSubagent("fg-call-1", {
      mode: "single",
      progress: [{ index: 0, currentTool: "Bash", model: "openai/gpt-5.4" }],
      results: [{ index: 0, transcriptPath }],
    });

    writeJsonl(transcriptPath, [transcriptToolStart("child-bash-1", "bash", { command: "pwd" })]);

    await waitForProgress(events, "fg-call-1:0", { kind: "tool_use", toolUseId: "child-bash-1" });

    appendJsonl(transcriptPath, [
      transcriptToolResult("child-bash-1", "/repo"),
      transcriptMessage("assistant", assistantText("live-fg-marker")),
    ]);

    await waitForProgress(events, undefined, { kind: "text", content: "live-fg-marker" });
    // Must not have emitted subagent_done yet
    expect(events.some((e) => e.kind === "subagent_done")).toBe(false);

    h.completeSubagent("fg-call-1", "done", {
      mode: "single",
      results: [{ index: 0, status: "completed", transcriptPath, summary: "done" }],
    });
    await h.endTurn(sent);

    const done = events.find((e) => e.kind === "subagent_done");
    expect(done?.subagent?.status).toBe("completed");
    expect(done?.subagent?.events?.some((e) => e.content === "live-fg-marker")).toBe(true);

    // Writes after completion/close must not trigger new progress events
    const countAfterDone = events.length;
    appendJsonl(transcriptPath, [transcriptMessage("assistant", assistantText("after-done"))]);
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toHaveLength(countAfterDone);
  });

  it("streams foreground workflowChildren via async events.jsonl and supports dynamic child expansion", async () => {
    const dir = tempDir();
    const tempRoot = path.join(dir, "sub-temp");
    fs.mkdirSync(path.join(tempRoot, "async-subagent-runs"), { recursive: true });
    const h = createSessionHarness(dir, { piSubagentsTempRoot: tempRoot });
    const { sent, events } = await h.beginTurn("run tasks");
    h.startSubagent("wf-call-1", { workflow: "review-and-fix", async: false });

    const child1Dir = createRunDir(tempRoot, "child-run-1");
    const child2Dir = createRunDir(tempRoot, "child-run-2");

    h.updateSubagent("wf-call-1", {
      mode: "workflow",
      workflowChildren: {
        children: [
          {
            childId: "task-1",
            state: "running",
            runId: "child-run-1",
            agent: "worker-a",
            activity: { currentTool: "Read" },
          },
          {
            childId: "task-2",
            state: "running",
            runId: "child-run-2",
            agent: "worker-b",
          },
        ],
      },
    });

    writeAsyncEvents(child1Dir, {
      type: "tool_execution_start",
      toolCallId: "c1-read",
      toolName: "read",
      args: { path: "a.ts" },
    });
    writeAsyncEvents(child2Dir, assistantMessageEnd("child-2-step"));

    await vi.waitFor(() => {
      expectProgress(events, "wf-call-1:0", { kind: "tool_use" });
      expectProgress(events, "wf-call-1:1", { content: "child-2-step" });
    });

    h.completeSubagent("wf-call-1", "wf ok", {
      mode: "workflow",
      results: [
        { index: 0, status: "completed", summary: "ok-1" },
        { index: 1, status: "completed", summary: "ok-2" },
      ],
    });
    await h.endTurn(sent);
    expect(events.filter((e) => e.kind === "subagent_done")).toHaveLength(2);
  });

  it("streams detached async parallel and workflow events and resumes from tailCursors without duplicates", async () => {
    const dir = tempDir();
    const parallelDir = createRunDir(dir, "run-parallel");
    const wfDir = createRunDir(dir, "run-wf");
    const wfChildDir = createRunDir(dir, "wf-child-1");

    const h = createSessionHarness(dir);
    const { sent, events } = await h.beginTurn("launch async");

    // Launch parallel async run
    h.launchDetached(
      "async-par",
      {
        async: true,
        tasks: [
          { agent: "a", task: "one" },
          { agent: "b", task: "two" },
        ],
      },
      { mode: "parallel", asyncDir: parallelDir, asyncId: "run-parallel" },
    );

    // Launch workflow async run
    h.launchDetached(
      "async-wf",
      { async: true, workflow: "pipeline" },
      {
        mode: "workflow",
        asyncDir: wfDir,
        asyncId: "run-wf",
      },
      "wf launched",
    );
    await h.endTurn(sent);

    // Emit pre-restart records into both parallel parent events.jsonl and workflow child events.jsonl
    writeAsyncEvents(
      parallelDir,
      {
        type: "tool_execution_start",
        subagentStepIndex: 0,
        toolCallId: "par0-t1",
        toolName: "bash",
        args: { command: "echo 0" },
      },
      {
        type: "tool_execution_start",
        subagentStepIndex: 1,
        toolCallId: "par1-t1",
        toolName: "read",
        args: { path: "x.ts" },
      },
    );

    writeAsyncEvents(wfDir, {
      type: "subagent.child-status",
      childId: "task-1",
      stepIndex: 0,
      childRunId: "wf-child-1",
    });
    writeAsyncEvents(wfChildDir, assistantMessageEnd("wf-before-restart", 0));

    await vi.waitFor(() => {
      expectProgress(events, "async-par:0", { toolUseId: "par0-t1" });
      expectProgress(events, "async-par:1", { toolUseId: "par1-t1" });
      expectProgress(events, "async-wf:0", { content: "wf-before-restart" });
    });

    const savedState = h.session.getState();
    expect(
      savedState.activeAsyncRuns?.find((r) => r.runId === "run-parallel")?.tailCursors?.parent,
    ).toBeGreaterThan(0);
    expect(
      savedState.activeAsyncRuns?.find((r) => r.runId === "run-wf")?.tailCursors?.[
        "child:wf-child-1"
      ],
    ).toBeGreaterThan(0);

    await h.session.dispose(500);

    // Restore session and append new lines: pre-restart lines must NOT replay
    const restored = h.restore(savedState);
    const resumedEvents = collectEvents(restored);

    appendAsyncEvents(parallelDir, assistantMessageEnd("par-after-restart", 0));
    appendAsyncEvents(wfChildDir, assistantMessageEnd("wf-after-restart", 0));

    await vi.waitFor(() => {
      for (const [taskId, content] of [
        ["async-par:0", "par-after-restart"],
        ["async-wf:0", "wf-after-restart"],
      ]) {
        expect(resumedEvents.some(bySubagent(taskId, undefined, content))).toBe(true);
      }
    });

    // Ensure pre-restart events were not replayed
    expect(resumedEvents.some((e) => e.subagent?._innerEvent?.toolUseId === "par0-t1")).toBe(false);
    expect(
      resumedEvents.some((e) => e.subagent?._innerEvent?.content === "wf-before-restart"),
    ).toBe(false);

    // Dispose stops watches; subsequent appends do not emit
    await restored.dispose(500);
    const countAfterDispose = resumedEvents.length;
    appendAsyncEvents(parallelDir, assistantMessageEnd("after-dispose", 0));
    await new Promise((r) => setTimeout(r, 60));
    expect(resumedEvents).toHaveLength(countAfterDispose);
  });

  it("does not misbind partial out-of-order parallel progress or results across children", async () => {
    const dir = tempDir();
    const h = createSessionHarness(dir);
    const { sent, events } = await h.beginTurn("run parallel");

    const pathA = path.join(dir, "child-a.jsonl");
    const pathB = path.join(dir, "child-b.jsonl");
    writeJsonl(pathB, [transcriptMessage("assistant", assistantText("marker-b"))]);

    h.startSubagent("par-call", {
      async: false,
      tasks: [
        { agent: "a", task: "one" },
        { agent: "b", task: "two" },
      ],
    });

    // Partial update containing only index 1 at array position 0
    h.updateSubagent("par-call", {
      mode: "parallel",
      progress: [{ index: 1, currentTool: "Read", model: "openai/gpt-5.4" }],
      results: [{ index: 1, transcriptPath: pathB }],
    });

    await waitForProgress(events, "par-call:1", { content: "marker-b" });
    expect(events.some(bySubagent("par-call:0", "subagent_progress"))).toBe(false);

    writeJsonl(pathA, [transcriptMessage("assistant", assistantText("marker-a"))]);
    h.updateSubagent("par-call", {
      mode: "parallel",
      progress: [
        { index: 0, currentTool: "Bash", model: "anthropic/claude-sonnet-4" },
        { index: 1, currentTool: "Read", model: "openai/gpt-5.4" },
      ],
      results: [
        { index: 0, transcriptPath: pathA },
        { index: 1, transcriptPath: pathB },
      ],
    });

    await waitForProgress(events, "par-call:0", { content: "marker-a" });

    h.completeSubagent("par-call", "ok", {
      mode: "parallel",
      results: [
        { index: 0, status: "completed", transcriptPath: pathA },
        { index: 1, status: "completed", transcriptPath: pathB },
      ],
    });
    await h.endTurn(sent);
  });

  it("emits start and done for dynamic workflow children discovered already terminal", async () => {
    const dir = tempDir();
    const wfDir = createRunDir(dir, "run-dyn-term");

    const h = createSessionHarness(dir);
    const { sent, events } = await h.beginTurn("launch wf");
    h.launchDetached(
      "wf-term",
      { async: true, workflow: "pipeline" },
      {
        mode: "workflow",
        asyncDir: wfDir,
        asyncId: "run-dyn-term",
      },
      "wf launched",
    );
    await h.endTurn(sent);

    writeStatusJson(wfDir, {
      runId: "run-dyn-term",
      sessionId: h.session.getState().sessionId,
      mode: "workflow",
      state: "running",
      steps: [
        { childId: "task-1", agent: "planner", status: "running" },
        {
          childId: "task-2",
          agent: "finisher",
          status: "completed",
          summary: "already done",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(events.some(bySubagent("wf-term:1", "subagent_start"))).toBe(true),
    );

    await h.session.reconcileAsyncRuns();
    const done = events.find(bySubagent("wf-term:1", "subagent_done"));
    expect(done?.subagent).toMatchObject({
      taskId: "wf-term:1",
      status: "completed",
      summary: "already done",
    });
  });

  it("handles out-of-order subagent.child-status without hijacking step:0", async () => {
    const dir = tempDir();
    const wfDir = createRunDir(dir, "run-oof");
    const c1Dir = createRunDir(dir, "oof-c1");
    const c2Dir = createRunDir(dir, "oof-c2");

    const h = createSessionHarness(dir);
    const { sent, events } = await h.beginTurn("launch oof");
    h.launchDetached(
      "wf-oof",
      { async: true, workflow: "pipeline" },
      {
        mode: "workflow",
        asyncDir: wfDir,
        asyncId: "run-oof",
      },
    );
    await h.endTurn(sent);

    for (const [childDir, text, stepIndex, childId, childRunId, writeParent] of [
      [c2Dir, "from-step-2", 1, "task-2", "oof-c2", writeAsyncEvents],
      [c1Dir, "from-step-1", 0, "task-1", "oof-c1", appendAsyncEvents],
    ] as const) {
      writeAsyncEvents(childDir, assistantMessageEnd(text));
      writeParent(wfDir, { type: "subagent.child-status", childId, stepIndex, childRunId });
      await waitForProgress(events, `wf-oof:${stepIndex}`, { content: text });
    }
  });

  it("emits async execution metadata once across poll, reconcile, and restore", async () => {
    const dir = tempDir();
    const parDir = createRunDir(dir, "run-meta-once");

    const h = createSessionHarness(dir);
    const { sent, events } = await h.beginTurn("launch meta");
    h.launchDetached(
      "meta-1",
      { async: true, tasks: [{ agent: "a", task: "one" }] },
      {
        mode: "parallel",
        asyncDir: parDir,
        asyncId: "run-meta-once",
      },
    );
    await h.endTurn(sent);

    writeStatusJson(parDir, {
      runId: "run-meta-once",
      sessionId: h.session.getState().sessionId,
      mode: "parallel",
      state: "running",
      steps: [
        {
          childId: "task-1",
          status: "running",
          resolvedModel: { provider: "openai", model: "gpt-5.4" },
          thinking: "high",
        },
      ],
    });

    const modelProgress = (e: StreamEvent) =>
      e.kind === "subagent_progress" &&
      e.subagent?.taskId === "meta-1:0" &&
      e.subagent.model === "openai/gpt-5.4";
    await vi.waitFor(() => expect(events.some(modelProgress)).toBe(true));
    await h.session.reconcileAsyncRuns();
    expect(events.filter(modelProgress)).toHaveLength(1);

    const saved = h.session.getState();
    expect(saved.activeAsyncRuns?.[0]?.children[0]?.execution).toEqual({
      model: "openai/gpt-5.4",
      effort: "high",
    });

    await h.session.dispose(500);
    const restored = h.restore(saved);
    const resumedEvents = collectEvents(restored);
    await restored.reconcileAsyncRuns();
    expect(resumedEvents.filter((e) => e.kind === "subagent_progress")).toHaveLength(0);
  });
});

const workspaceCallbacks: WorkspaceCallbacks = {
  onNewMessage: () => undefined,
  onStreamEvent: () => undefined,
  onMessageDone: () => undefined,
};

function makeLiveWorkspace(
  dir: string,
  identity: { id: string; name: string },
  session: Pick<Parameters<HostRegistry["register"]>[0], "createSession" | "restoreSession">,
  callbacks: Partial<WorkspaceCallbacks> = {},
) {
  const registry = new HostRegistry();
  registry.register({
    id: "local",
    label: "Local",
    type: "local",
    connected: true,
    getInfo: () => ({ id: "local", label: "Local", type: "local", connected: true }),
    destroySession: () => Promise.resolve(),
    ...session,
  });
  const ws = new Workspace(identity.id, identity.name, "test", "local", dir, registry, {
    ...workspaceCallbacks,
    ...callbacks,
  });
  ws.addAgent("Pi", "mock/test", "", "#000", { backend: "pi", cwd: dir });
  return { registry, ws };
}

describe("Workspace persistence of Pi subagent live inner events", () => {
  it("persists Pi _innerEvent, skips duplicate tool_use WS broadcasts, and preserves live events on abort", async () => {
    const dir = tempDir();
    const h = createSessionHarness(dir);
    const streamedEvents: StreamEvent[] = [];
    const { ws } = makeLiveWorkspace(
      dir,
      { id: "ws-pi-live", name: "Pi Live" },
      {
        createSession: () => h.session,
        restoreSession: () => h.session,
      },
      { onStreamEvent: (_wsId, _msgId, ev) => streamedEvents.push(ev) },
    );

    await ws.sendMessage("start subagent");
    await h.emitTurnStart();

    const transcriptPath = path.join(dir, "live-abort.jsonl");
    h.startSubagent("sa-call", { agent: "scout", task: "inspect", async: false });
    h.updateSubagent("sa-call", { mode: "single", results: [{ index: 0, transcriptPath }] });

    writeJsonl(transcriptPath, [
      transcriptToolStart("tu-1", "bash", { command: "pwd" }),
      transcriptToolResult("tu-1", "/repo"),
    ]);

    await waitForProgress(streamedEvents, "sa-call:0", { kind: "tool_result" });

    // Emit duplicate tool_use with same toolUseId directly from session: Workspace must drop it and NOT broadcast it
    const beforeDupBroadcasts = streamedEvents.length;
    h.session.emit("event", {
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "sa-call:0",
        description: "",
        status: "running",
        _innerEvent: { kind: "tool_use", content: "`pwd`", toolName: "bash", toolUseId: "tu-1" },
      },
    });
    expect(streamedEvents).toHaveLength(beforeDupBroadcasts);

    // End turn before tool_execution_end (simulating abort/interruption): closes running subagent without sessionFile/transcriptPath and must keep live events
    h.emit({ type: "agent_settled", aborted: true });
    await vi.waitFor(() =>
      expect(streamedEvents.some(bySubagent("sa-call:0", "subagent_done"))).toBe(true),
    );

    const msg = ws.getMessages().at(-1)!;
    const startEv = msg.events?.find(bySubagent("sa-call:0", "subagent_start"));
    expect(startEv?.subagent?.status).toBe("stopped");
    expect(startEv?.subagent?.events).toHaveLength(1);
    expect(startEv?.subagent?.events?.[0]).toMatchObject({
      kind: "tool_use",
      toolUseId: "tu-1",
      toolResult: "/repo",
    });
  });

  it("preserves pre-restart async live events in Workspace when reconciled dead without paths", async () => {
    const dir = tempDir();
    const asyncDir = createRunDir(dir, "run-restore-live");

    const h = createSessionHarness(dir);
    let activeSession = h.session;
    const { ws, registry } = makeLiveWorkspace(
      dir,
      { id: "ws-pi-restore-live", name: "Pi Restore" },
      {
        createSession: () => activeSession,
        restoreSession: (_id, state) => {
          activeSession = h.restore(state);
          return activeSession;
        },
      },
    );

    await ws.sendMessage("launch async");
    await h.emitTurnStart();
    h.launchDetached(
      "async-keep",
      { async: true, tasks: [{ agent: "scout", task: "watch" }] },
      { mode: "parallel", asyncDir, asyncId: "run-restore-live" },
    );
    h.emit({ type: "agent_settled", aborted: false });

    writeAsyncEvents(asyncDir, assistantMessageEnd("live-before-restart", 0));

    await vi.waitFor(() => {
      const m = ws.getMessages().at(-1);
      const start = m?.events?.find(bySubagent("async-keep:0", "subagent_start"));
      expect(start?.subagent?.events?.some((e) => e.content === "live-before-restart")).toBe(true);
    });

    const savedWs = ws.getState();
    await h.session.dispose(500);

    // Dead PID + no sessionFile/transcriptPath
    const exited = spawnSync(process.execPath, ["-e", ""]);
    writeStatusJson(asyncDir, {
      runId: "run-restore-live",
      sessionId: activeSession.getState().sessionId,
      mode: "parallel",
      state: "running",
      pid: exited.pid,
      steps: [{ childId: "task-1", status: "running" }],
    });

    const restoredWs = Workspace.fromState(savedWs, registry, workspaceCallbacks);
    const restoredEvents = collectEvents(activeSession);

    await activeSession.reconcileAsyncRuns();
    const done = restoredEvents.find(bySubagent("async-keep:0", "subagent_done"));
    expect(done?.subagent?.status).toBe("failed");
    expect(done?.subagent?.events).toBeUndefined();
    expect(done?.subagent?.eventCount).toBeUndefined();

    const msgAfter = restoredWs.getMessages().at(-1)!;
    const startAfter = msgAfter.events?.find(bySubagent("async-keep:0", "subagent_start"));
    expect(startAfter?.subagent?.status).toBe("failed");
    expect(startAfter?.subagent?.events?.some((e) => e.content === "live-before-restart")).toBe(
      true,
    );
  });
});
