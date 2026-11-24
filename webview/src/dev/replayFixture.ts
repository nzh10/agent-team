// Synthetic replay for reviewing every event-rendering path by eye.
// Triggered by the 🎬 button in the sidebar; plays a scripted conversation
// through the exact same dispatch pipeline as live server frames.

export const DEMO_WS_ID = "replay-demo";
export const LAYOUT_TURN_ID = "demo-layout-turn";

const AGENT = {
  id: "demo-agent",
  name: "Demo",
  model: "claude-fable-5",
  avatar: "🎬",
  color: "#a78bfa",
  isDefault: true,
};

type Frame = Record<string, unknown> & { delayAfterMs?: number };

const LONG_OUTPUT = Array.from(
  { length: 60 },
  (_, i) =>
    `${String(i + 1).padStart(3)}  drwxr-xr-x  src/module-${i}/index.ts  ${1000 + i * 37} bytes`,
).join("\n");

const MD_TORTURE = `## Markdown torture test

Paragraph with **bold**, *italic*, \`inline code\`, ~~strikethrough~~ and a [link](https://example.com).

### Lists
1. Ordered item
2. Nested:
   - bullet one
   - bullet two with \`code\`
     - deeper still

- [x] Task done
- [ ] Task pending

### Table

| Component | Status | Coverage |
|-----------|--------|---------:|
| session.ts | ✅ tested | 87% |
| task.ts | ✅ tested | 82% |
| App.tsx | 🚧 partial | 41% |

### Code

\`\`\`typescript
export function splitEvents(events: StreamEvent[]) {
  const regular = events.filter((e) => !isSubagentEvent(e));
  return { regular, subagents: merge(events) };
}
\`\`\`

> Blockquote: subagents render as standalone blocks now.

---

Horizontal rule above. 中文渲染测试：多智能体编排面板。`;

function textDeltas(messageId: string, text: string, chunk = 24): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < text.length; i += chunk) {
    frames.push({
      type: "stream_event",
      workspaceId: DEMO_WS_ID,
      messageId,
      event: { kind: "text_delta", content: text.slice(i, i + chunk) },
    });
  }
  return frames;
}

function ev(messageId: string, event: Record<string, unknown>): Frame {
  return { type: "stream_event", workspaceId: DEMO_WS_ID, messageId, event };
}

function subagentInner(
  messageId: string,
  parentTaskId: string,
  innerEvent: Record<string, unknown>,
): Frame {
  return ev(messageId, {
    kind: "subagent_progress",
    content: "",
    subagent: { taskId: parentTaskId, description: "", _innerEvent: innerEvent },
  });
}

export function buildFrames(): Frame[] {
  const frames: Frame[] = [];
  const now = Date.now();

  frames.push({ type: "workspace_deleted", workspaceId: DEMO_WS_ID });
  frames.push({
    type: "workspace_created",
    workspace: {
      id: DEMO_WS_ID,
      name: "🎬 Replay Demo",
      project: "replay-demo",
      hostId: "local",
      cwd: "/demo",
      git: { branch: "demo/render-review", dirty: 0, ahead: 0, behind: 0 },
      pr: null,
      agents: [AGENT],
      messages: [],
      createdAt: now,
      messagesLoaded: true,
    },
  });

  // An archived sibling so the sidebar's Archived section shows up too.
  frames.push({ type: "workspace_deleted", workspaceId: `${DEMO_WS_ID}-archived` });
  frames.push({
    type: "workspace_created",
    workspace: {
      id: `${DEMO_WS_ID}-archived`,
      name: "old-experiment",
      project: "replay-demo",
      hostId: "local",
      cwd: "/demo",
      git: null,
      pr: null,
      agents: [],
      messages: [],
      createdAt: now - 40 * 86_400_000,
      lastMessageAt: now - 30 * 86_400_000,
      archivedAt: now - 16 * 86_400_000,
      messagesLoaded: true,
    },
  });

  // ---- System + user messages -------------------------------------------
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: "demo-sys-1",
      kind: "system",
      agentId: null,
      content: `🎬 **${AGENT.name}** joined the team`,
      timestamp: now,
      status: "done",
    },
  });
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: "demo-user-1",
      kind: "user",
      agentId: null,
      content: "@Demo 帮我全面检查一下这个仓库，需要的话开几个 subagent 并行搜索。",
      timestamp: now,
      status: "done",
    },
  });

  // ---- Message 1: interleaved text/tools/subagents ----------------------
  const M1 = "demo-msg-1";
  const m1p1 = "I'll inspect the repo first, then fan out subagents for the heavy searching.\n\n";
  const m1p2 =
    "\n\nThe `Edit` above fixed a typo. Now let me delegate the broad searches — watch the five subagent states below (running / completed / failed / stopped / nested).\n\n";
  const m1p3 =
    "\n\nAll subagents have reported back. Summary:\n\n- `session.ts` translates SDK messages\n- `task.ts` aggregates them per message\n- rendering is verified by this very replay\n";

  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: M1,
      kind: "agent",
      agentId: AGENT.id,
      content: "",
      timestamp: now,
      status: "streaming",
      events: [],
      effort: "xhigh",
    },
  });

  frames.push(
    ev(M1, {
      kind: "thinking",
      content:
        "The user wants a full review. Plan: read entry points, fix the typo I spotted, then spawn parallel subagents for search coverage.",
      contentOffset: 0,
    }),
  );
  frames.push(...textDeltas(M1, m1p1));

  const off1 = m1p1.length;
  frames.push(
    ev(M1, {
      kind: "tool_use",
      content: "**Read** `service/src/index.ts`",
      toolUseId: "t-read",
      contentOffset: off1,
    }),
    ev(M1, {
      kind: "tool_result",
      content: "export class Server {\n  private workspaces = new Map()\n  ...\n}",
      toolUseId: "t-read",
    }),
    ev(M1, {
      kind: "tool_use",
      content: "**Edit** `service/src/task.ts`",
      toolUseId: "t-edit",
      toolInput: {
        tool: "Edit",
        file_path: "service/src/task.ts",
        old_string: "recieve",
        new_string: "receive",
      },
      contentOffset: off1,
    }),
    ev(M1, {
      kind: "tool_result",
      content: "The file has been updated successfully.",
      toolUseId: "t-edit",
    }),
    ev(M1, {
      kind: "tool_use",
      content: "**Bash** `find src -type f | xargs ls -la` (long output)",
      toolUseId: "t-bash",
      contentOffset: off1,
    }),
    ev(M1, { kind: "tool_result", content: LONG_OUTPUT, toolUseId: "t-bash" }),
  );

  frames.push(...textDeltas(M1, m1p2));
  const off2 = off1 + m1p2.length;

  // Subagent #1: completes normally, with inner tool pairing + markdown summary.
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Search the syntax module",
      toolUseId: "t-sa1",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-ok",
        description: "Search the syntax module",
        agentType: "Explore",
        prompt:
          "Read **src/syntax/** and report:\n1. module inventory\n2. mutation entry points\n\nCite `file:line`.",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-ok", {
      kind: "thinking",
      content: "Starting with the dependency graph.",
    }),
    subagentInner(M1, "demo-sa-ok", {
      kind: "tool_use",
      content: "**Grep** `addEdge` in src/syntax/",
      toolUseId: "sa1-t1",
    }),
    subagentInner(M1, "demo-sa-ok", {
      kind: "tool_result",
      content: "dependency_graph.cpp:88\nscanner.cpp:142",
      toolUseId: "sa1-t1",
    }),
    subagentInner(M1, "demo-sa-ok", {
      kind: "text",
      content: "Found 2 mutation sites, verifying callers now.",
    }),
    ev(M1, {
      kind: "subagent_progress",
      content: "reading dependency_graph.cpp",
      subagent: {
        taskId: "demo-sa-ok",
        description: "Search the syntax module",
        status: "running",
        lastTool: "Read",
        usage: { totalTokens: 8200, toolUses: 4, durationMs: 12000 },
      },
    }),
    ev(M1, {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-ok",
        description: "",
        status: "completed",
        summary:
          "### Syntax module report\n\n- `dependency_graph.cpp:88` — forward edges built here\n- reverse edges are **batch-rebuilt**, not incremental\n\n| entry point | caller |\n|---|---|\n| addEdge | scanner.cpp:142 |",
        usage: { totalTokens: 15400, toolUses: 7, durationMs: 21000 },
      },
    }),
  );

  // Subagent #2: parent with a NESTED subagent inside.
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Deep audit with a helper agent",
      toolUseId: "t-sa2",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-parent",
        description: "Deep audit with a helper agent",
        agentType: "general-purpose",
        prompt: "Audit the index module. Spawn an Explore helper if the surface is too large.",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "tool_use",
      content: "**Read** `src/index/merged_index.cpp`",
      toolUseId: "sa2-t1",
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "tool_result",
      content: "bool need_update() { return impl != nullptr; }",
      toolUseId: "sa2-t1",
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "subagent_start",
      content: "",
      subagent: {
        taskId: "demo-sa-nested",
        description: "helper: map include_graph",
        agentType: "Explore",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "demo-sa-nested",
        description: "helper: map include_graph",
        status: "running",
        lastTool: "Grep",
      },
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-nested",
        description: "",
        status: "completed",
        summary: "include_graph maps fid → path_id; PCH files are absent from files().",
        usage: { totalTokens: 4100, toolUses: 3, durationMs: 8000 },
      },
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "text",
      content: "Helper confirmed the include_graph gap; folding into my report.",
    }),
    ev(M1, {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-parent",
        description: "",
        status: "completed",
        summary: "Audit done. One nested helper used — its block should render *inside* this one.",
        usage: { totalTokens: 22000, toolUses: 9, durationMs: 30000 },
      },
    }),
  );

  // Subagent #3: fails.
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Run the flaky benchmark",
      toolUseId: "t-sa3",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-fail",
        description: "Run the flaky benchmark",
        agentType: "claude",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-fail", {
      kind: "tool_use",
      content: "**Bash** `./bench --strict`",
      toolUseId: "sa3-t1",
    }),
    subagentInner(M1, "demo-sa-fail", {
      kind: "tool_result",
      content: "Segmentation fault (core dumped)",
      toolUseId: "sa3-t1",
    }),
    ev(M1, {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-fail",
        description: "",
        status: "failed",
        summary: "Benchmark crashed with SIGSEGV — needs a debug build to diagnose.",
        usage: { totalTokens: 3000, toolUses: 1, durationMs: 5000 },
      },
    }),
  );

  // Subagent #4: stopped by the user (what the Cancel button produces).
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Exhaustive license scan",
      toolUseId: "t-sa4",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-stop",
        description: "Exhaustive license scan",
        agentType: "Explore",
        status: "running",
        events: [],
      },
    }),
    ev(M1, {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-stop",
        description: "",
        status: "stopped",
        summary: "Stopped by user before completion.",
        usage: { totalTokens: 900, toolUses: 1, durationMs: 2000 },
      },
    }),
  );

  // Subagent #5: still running at the end (shows spinner + Cancel button).
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Watch CI for regressions",
      toolUseId: "t-sa5",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-run",
        description: "Watch CI for regressions",
        agentType: "general-purpose",
        prompt: "Poll CI until the pipeline settles.",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-run", {
      kind: "tool_use",
      content: "**Bash** `gh run watch`",
      toolUseId: "sa5-t1",
    }),
    ev(M1, {
      kind: "subagent_progress",
      content: "watching CI",
      subagent: {
        taskId: "demo-sa-run",
        description: "Watch CI for regressions",
        status: "running",
        lastTool: "Bash",
        usage: { totalTokens: 1200, toolUses: 1, durationMs: 9000 },
      },
    }),
  );

  // Markdown-rendered Task tool_result + error + compact events.
  frames.push(
    ev(M1, {
      kind: "tool_use",
      content: "**Agent** consolidated report",
      toolUseId: "t-agent",
      contentOffset: off2,
    }),
    ev(M1, {
      kind: "tool_result",
      content:
        "## Consolidated findings\n\n1. reverse edges rebuilt in bulk\n2. `need_update()` conflates dirty & loaded\n\n**Verdict:** ship it.",
      toolUseId: "t-agent",
      isMarkdown: true,
    }),
    ev(M1, {
      kind: "error",
      content:
        "[Claude error] transient 529 — retried automatically (rendering check for error events)",
    }),
    ev(M1, { kind: "compact", content: "Context compacted (auto): 145000 → 60000 tokens, 8.2s" }),
    ev(M1, {
      kind: "notice",
      level: "warning",
      content: "Permission denied for Bash (rule): `rm -rf` is blocked by settings",
    }),
    ev(M1, {
      kind: "tool_use",
      toolName: "ScheduleWakeup",
      toolUseId: "t-wake",
      content: "**ScheduleWakeup** in 8m — watching CI\n\n> check the CI run and fix anything red",
    }),
    ev(M1, { kind: "notice", level: "wakeup", content: "check the CI run and fix anything red" }),
    ev(M1, {
      kind: "retry",
      level: "warning",
      content: "API retry 1/10 in 2s — HTTP 529 (overloaded)",
    }),
    ev(M1, {
      kind: "retry",
      level: "warning",
      content: "API retry 2/10 in 5s — HTTP 529 (overloaded)",
    }),
    ev(M1, {
      kind: "notice",
      level: "info",
      content: "**Plan**\n- [x] read entry points\n- [ ] fan out subagents\n- [ ] summarize",
    }),
  );
  frames.push({
    type: "agent_activity",
    workspaceId: DEMO_WS_ID,
    agentId: AGENT.id,
    activity: "Bash · 42s",
  });

  frames.push(...textDeltas(M1, m1p3));
  frames.push({
    type: "agent_activity",
    workspaceId: DEMO_WS_ID,
    agentId: AGENT.id,
    activity: null,
  });
  frames.push({
    type: "message_done",
    workspaceId: DEMO_WS_ID,
    messageId: M1,
    status: "done",
    content: m1p1 + m1p2 + m1p3,
    context: { tokens: 152_000, window: 200_000 },
  });

  // ---- Message 2: quoted user message + markdown torture reply ----------
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: "demo-user-2",
      kind: "user",
      agentId: null,
      content: "整理成一份格式丰富的报告让我检查 markdown 渲染。",
      timestamp: now + 60_000,
      status: "done",
      forwardRef: {
        messageId: M1,
        fromAgent: "Demo",
        fromAvatar: "🎬",
        preview: "All subagents have reported back. Summary: session.ts translates SDK messages...",
      },
    },
  });

  const M2 = "demo-msg-2";
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: M2,
      kind: "agent",
      agentId: AGENT.id,
      content: "",
      timestamp: now + 61_000,
      status: "streaming",
      events: [],
    },
  });
  frames.push(...textDeltas(M2, MD_TORTURE, 48));
  frames.push({
    type: "message_done",
    workspaceId: DEMO_WS_ID,
    messageId: M2,
    status: "done",
    content: MD_TORTURE,
  });

  // ---- Message 3: error-status message -----------------------------------
  const M3 = "demo-msg-3";
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: M3,
      kind: "agent",
      agentId: AGENT.id,
      content: "",
      timestamp: now + 120_000,
      status: "streaming",
      events: [],
    },
  });
  frames.push(...textDeltas(M3, "Attempting one more call..."));
  frames.push(
    ev(M3, {
      kind: "error",
      content: "[Claude error] session expired — message ends in the error state",
    }),
  );
  frames.push({
    type: "message_done",
    workspaceId: DEMO_WS_ID,
    messageId: M3,
    status: "error",
    content:
      "Attempting one more call...\n\n[Claude error] session expired — message ends in the error state",
  });

  appendLayoutTurn(frames, now);
  return frames;
}

function appendLayoutTurn(frames: Frame[], now: number) {
  const messageId = LAYOUT_TURN_ID;
  const firstText = "I'll cross-check the layout tests and their fixtures.";
  const lastText = "\n\nThe fixtures cover the waiting, thinking, and tool phases.";
  let at = frames.reduce((time, frame) => time + frameDelay(frame), now);
  const push = (frame: Frame, delayAfterMs?: number) => {
    frames.push(delayAfterMs == null ? frame : { ...frame, delayAfterMs });
    at += delayAfterMs ?? frameDelay(frame);
  };
  const event = (event: Record<string, unknown>, delayAfterMs?: number) =>
    push(ev(messageId, event), delayAfterMs);

  push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: `${messageId}-prompt`,
      kind: "user",
      agentId: null,
      content: "Cross-check the layout tests against the replay fixtures.",
      timestamp: now + 180_000,
      status: "done",
    },
  });
  push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: messageId,
      kind: "agent",
      agentId: AGENT.id,
      content: "",
      timestamp: now + 181_000,
      status: "streaming",
      waitingSince: at,
      events: [],
    },
  });
  event({ kind: "text_delta", content: firstText, waitingSince: at });

  const tools = [
    ["Read", "Read the layout test"],
    ["Grep", "Find the geometry assertions"],
    ["Bash", "List the replay fixtures"],
    ["mcp__project_index__find_test_coverage_for_changed_components", "Look up test coverage"],
  ];
  for (const [i, [toolName, content]] of tools.entries()) {
    const toolUseId = `layout-tool-${i}`;
    const startedAt = at;
    event({
      kind: "tool_use",
      toolName,
      toolUseId,
      content,
      startedAt,
      contentOffset: firstText.length,
      waitingSince: null,
    });
    event(
      {
        kind: "tool_result",
        toolUseId,
        content: "Found.",
        durationMs: at - startedAt,
        waitingSince: at,
      },
      i === tools.length - 1 ? 6_500 : undefined,
    );
  }

  // Wire form of Pi's thinking_start and thinking_end, including the silent interval.
  const startedAt = at;
  const reasoning = "The geometry should stay the same until new visible content arrives.";
  event({ kind: "thinking_delta", startedAt, content: "", waitingSince: null }, 6_000);
  event({ kind: "thinking_delta", startedAt, content: reasoning, waitingSince: null }, 800);
  const durationMs = at - startedAt;
  event(
    { kind: "thinking_delta", content: "", durationMs, waitingSince: at, thinkingFollows: true },
    0,
  );
  event({
    kind: "thinking",
    content: reasoning,
    durationMs,
    contentOffset: firstText.length,
    waitingSince: at,
  });

  const verifyStartedAt = at;
  event(
    {
      kind: "tool_use",
      toolName: "RunTests",
      toolUseId: "layout-verify",
      content: "Check the layout tests",
      startedAt: verifyStartedAt,
      contentOffset: firstText.length,
      waitingSince: null,
    },
    3_500,
  );
  push(
    {
      type: "agent_activity",
      workspaceId: DEMO_WS_ID,
      agentId: AGENT.id,
      activity: "Checking layout · 3s",
    },
    1_500,
  );
  event({
    kind: "tool_result",
    toolUseId: "layout-verify",
    content: "Passed.",
    durationMs: at - verifyStartedAt,
    waitingSince: at,
  });
  push({ type: "agent_activity", workspaceId: DEMO_WS_ID, agentId: AGENT.id, activity: null });
  event({ kind: "text_delta", content: lastText, waitingSince: at });
  push({
    type: "message_done",
    workspaceId: DEMO_WS_ID,
    messageId,
    status: "done",
    content: firstText + lastText,
  });
}

export interface DemoReplayStats {
  runId: number;
  done: boolean;
  totalFrames: number;
  dispatchedFrames: number;
  durationMs: number;
  framesPerSec: number;
  p50CommitMs: number;
  p95CommitMs: number;
  maxCommitMs: number;
  commitSamplesMs: number[];
}

declare global {
  interface Window {
    __yaatDemoReplay?: DemoReplayStats;
  }
}

let activeReplayRun = 0;

function replayPacing(): { mode: "raf" } | { mode: "delay"; speed: number } {
  const search = typeof window !== "undefined" ? window.location?.search : "";
  if (!search) return { mode: "delay", speed: 1 };
  const params = new URLSearchParams(search);
  if (params.get("demoPace") === "raf") return { mode: "raf" };
  const rawSpeed = params.get("demoSpeed");
  if (rawSpeed != null && rawSpeed.trim() !== "") {
    const parsed = Number(rawSpeed);
    if (Number.isFinite(parsed) && parsed >= 0) return { mode: "delay", speed: parsed };
  }
  return { mode: "delay", speed: 1 };
}

function nextFrameCommit(): Promise<void> {
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// Frame pacing: fast for deltas, slower for structural frames so the eye can
// follow tool pairing and subagent state transitions.
export function frameDelay(frame: Frame): number {
  if (frame.delayAfterMs != null) return frame.delayAfterMs;
  if (frame.type !== "stream_event") return 250;
  const kind = (frame.event as Record<string, unknown>).kind as string;
  if (kind === "text_delta" || kind === "thinking_delta") return 18;
  if (kind === "subagent_start" || kind === "subagent_done") return 550;
  return 220;
}

export async function startDemoReplay(
  dispatch: (msg: Record<string, unknown>) => void,
): Promise<void> {
  const runId = ++activeReplayRun;
  const frames = buildFrames();
  const pacing = replayPacing();
  const commitSamplesMs: number[] = [];
  const startedAt = performance.now();
  performance.mark?.("yaat:demo-replay:start");

  const publish = (done: boolean) => {
    const durationMs = Math.max(0.01, performance.now() - startedAt);
    const sorted = [...commitSamplesMs].sort((a, b) => a - b);
    const stats: DemoReplayStats = {
      runId,
      done,
      totalFrames: frames.length,
      dispatchedFrames: commitSamplesMs.length,
      durationMs,
      framesPerSec: (commitSamplesMs.length / durationMs) * 1000,
      p50CommitMs: percentile(sorted, 50),
      p95CommitMs: percentile(sorted, 95),
      maxCommitMs: sorted[sorted.length - 1] ?? 0,
      commitSamplesMs,
    };
    if (typeof window !== "undefined") window.__yaatDemoReplay = stats;
  };

  publish(false);
  for (const frame of frames) {
    if (runId !== activeReplayRun) return;
    const { delayAfterMs: _delay, ...wire } = frame;
    const frameStart = performance.now();
    dispatch(wire);
    if (pacing.mode === "raf") {
      await nextFrameCommit();
      commitSamplesMs.push(performance.now() - frameStart);
    } else {
      const baseDelay = frameDelay(frame);
      const delay = pacing.speed === 0 ? 0 : Math.round(baseDelay / pacing.speed);
      if (delay > 0) {
        commitSamplesMs.push(performance.now() - frameStart);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        await nextFrameCommit();
        commitSamplesMs.push(performance.now() - frameStart);
      }
    }
    if (runId !== activeReplayRun) return;
    publish(false);
  }
  performance.mark?.("yaat:demo-replay:end");
  try {
    performance.measure?.("yaat:demo-replay", "yaat:demo-replay:start", "yaat:demo-replay:end");
  } catch {
    // Marks may have been cleared externally.
  }
  publish(true);
  console.log("[replay-demo] finished");
}

// The demo has no real server task behind it, so Cancel is emulated locally:
// emit the same subagent_done(stopped) frame a real stopTask would produce.
export function cancelDemoSubagent(
  dispatch: (msg: Record<string, unknown>) => void,
  taskId: string,
): void {
  dispatch(
    ev("demo-msg-1", {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId,
        description: "",
        status: "stopped",
        summary: "Stopped by user (demo — a real run would call `Query.stopTask`).",
      },
    }),
  );
}
