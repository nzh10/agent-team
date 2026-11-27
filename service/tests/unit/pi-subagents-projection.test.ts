import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Server } from "../../src/server/server";
import type { ActiveAsyncRunRecord, StreamEvent } from "../../src/session/types";
import { HistoryIndex } from "../../src/workspace/history-index";
import {
  closeHistory,
  historyFile,
  historyIndexFile,
  loadAll,
  loadWorkspaceMessages,
  saveIndex,
  saveWorkspace,
} from "../../src/workspace/state";
import type { Message, Workspace, WorkspaceState } from "../../src/workspace/workspace";
import {
  sessionMessage,
  textBlocks,
  transcriptMessage,
  writeJsonl,
  writeStatusJson,
} from "./helpers/subagent-artifacts";

const childA = "call:0";
const childB = "call:1";
const argsMarker = "priority-gate-a-extra-argument";
const outputMarker = "priority-gate-a-inner-output";

function scenario(base: string, nested = false) {
  fs.writeFileSync(path.join(base, "config.toml"), "");
  const workspaceId = "ws-siblings";
  const agentId = "agent-siblings";
  const sessionId = "parent-session";
  const nativeA = path.join(base, "native-a.jsonl");
  const transcriptB = path.join(base, "transcript-b.jsonl");
  writeJsonl(nativeA, [
    { type: "session", version: 3, id: "child-a-session" },
    { type: "thinking_level_change", id: "effort", parentId: null, thinkingLevel: "high" },
    sessionMessage("call", "effort", {
      role: "assistant",
      provider: "test",
      model: "native-a",
      content: [
        {
          type: "toolCall",
          id: "inner",
          name: "read",
          arguments: { path: "README.md", filter: argsMarker },
        },
      ],
    }),
    sessionMessage("result", "call", {
      role: "toolResult",
      toolCallId: "inner",
      toolName: "read",
      content: textBlocks(outputMarker),
    }),
  ]);
  writeJsonl(transcriptB, [
    transcriptMessage("assistant", { content: textBlocks("unrelated-sibling-b") }),
  ]);
  const activeRun: ActiveAsyncRunRecord = {
    runId: "async-run",
    mode: "parallel",
    asyncDir: base,
    startedAt: Date.now(),
    ownerMessageId: "owner",
    toolCallId: "call",
    children: [
      { taskId: childA, canonicalChildId: "a", stepIndex: 0 },
      { taskId: childB, canonicalChildId: "b", stepIndex: 1 },
    ],
  };
  const parent: Message = {
    id: "owner",
    kind: "agent",
    agentId,
    content: "Runner output",
    status: "done",
    timestamp: Date.now(),
    events: [childA, childB].map((id) => ({
      kind: "subagent_start",
      content: "",
      subagent: { taskId: id, description: id, status: "running", events: [] },
    })),
  };
  if (nested) {
    activeRun.children[0].tree = { ownerTaskId: childA, nodes: { leaf: { status: "running" } } };
    parent.events![0].subagent!.events = [
      {
        kind: "subagent_start",
        content: "",
        subagent: { taskId: "leaf", description: "nested", status: "running" },
      },
    ];
  }
  const state: WorkspaceState = {
    id: workspaceId,
    name: "parallel",
    project: "demo",
    hostId: "local",
    cwd: base,
    createdAt: parent.timestamp,
    archivedAt: Date.now(),
    // Preserve the historic orphan rather than constructing a lead for a directory unrelated to this gate.
    projectLink: { projectId: "old-project", role: "worker" },
    agents: [
      {
        id: agentId,
        name: "Pi",
        model: "test/model",
        avatar: "",
        color: "",
        isDefault: true,
        session: {
          sessionId,
          config: { cwd: base, backend: "pi" },
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            turns: 0,
            duration_ms: 0,
          },
          activeAsyncRuns: [activeRun],
        },
      },
    ],
    messages: [parent],
  };
  saveWorkspace(base, state);
  saveIndex(base, [workspaceId]);
  closeHistory(base);
  const finishWithoutNotify = () =>
    writeStatusJson(base, {
      sessionId,
      runId: activeRun.runId,
      state: "completed",
      steps: [
        { childId: "", workflowKey: "a", status: "completed", sessionFile: nativeA },
        {
          childId: "b",
          status: "completed",
          transcriptPath: transcriptB,
          model: "test/status-b",
          thinking: "off",
          scheduleOrigin: "private",
          currentTool: "private-tool",
        },
      ],
    });
  return { workspaceId, agentId, finishWithoutNotify };
}

describe("Pi subagent projection", () => {
  it("keeps checkpointed nested work running when loading archived history", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-tree-restore-"));
    const { workspaceId } = scenario(base, true);
    const server = new Server(0, base, base);
    try {
      await server.listening;
      const live = (server as unknown as { workspaces: Map<string, Workspace> }).workspaces.get(
        workspaceId,
      )!;
      live.setMessages(loadWorkspaceMessages(base, workspaceId));
      expect(
        live.messages.find((m) => m.id === "owner")?.events?.[0].subagent?.events?.[0].subagent
          ?.status,
      ).toBe("running");
    } finally {
      await server.close();
      closeHistory(base);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("loads an archived owner's history on terminal reconciliation and indexes sibling attribution offline", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-sibling-projection-"));
    const { workspaceId, agentId, finishWithoutNotify } = scenario(base);
    let server: Server | undefined;
    let index: HistoryIndex | undefined;
    try {
      server = new Server(0, base, base);
      await server.listening;
      const live = (server as unknown as { workspaces: Map<string, Workspace> }).workspaces.get(
        workspaceId,
      )!;
      const runtime = live.agents.get(agentId)!;
      expect(live.messagesLoaded).toBe(false);
      expect(runtime.session.runState).toBe("waiting");
      const UI: StreamEvent[] = [];
      const wire = server as unknown as {
        broadcastUI(frame: { type: string; event?: StreamEvent }): void;
      };
      const broadcast = wire.broadcastUI.bind(server);
      wire.broadcastUI = (frame) => {
        if (frame.event) UI.push(frame.event);
        broadcast(frame);
      };
      finishWithoutNotify();
      await runtime.session.reconcileAsyncRuns!();
      expect(live.messagesLoaded).toBe(true);
      expect(runtime.session.runState).toBe("idle");
      expect(
        UI.filter((event) => event.kind === "subagent_done").map((event) => event.subagent),
      ).toEqual([
        expect.objectContaining({
          taskId: childA,
          eventCount: 1,
          model: "test/native-a",
          effort: "high",
        }),
        expect.objectContaining({
          taskId: childB,
          eventCount: 1,
          model: "test/status-b",
          effort: "off",
        }),
      ]);
      expect(UI.every((event) => event.subagent?.events === undefined)).toBe(true);
      const stored = loadWorkspaceMessages(base, workspaceId).find((msg) => msg.id === "owner")!;
      const startA = stored.events!.find(
        (ev) => ev.kind === "subagent_start" && ev.subagent?.taskId === childA,
      )!;
      expect(startA.subagent?.events?.[0].content.split("\n")[0]).not.toContain(argsMarker);
      expect(startA.subagent?.events?.[0].toolInput).not.toHaveProperty("filter");
      expect(startA.subagent).toMatchObject({
        status: "completed",
        eventCount: 1,
        events: [expect.objectContaining({ kind: "tool_use", toolResult: outputMarker })],
        model: "test/native-a",
        effort: "high",
      });
      expect(
        stored.events!.find((ev) => ev.kind === "subagent_start" && ev.subagent?.taskId === childB)
          ?.subagent,
      ).toMatchObject({ model: "test/status-b", effort: "off" });
      for (const ev of [...UI, ...stored.events!]) {
        for (const key of [
          "thinking",
          "scheduleOrigin",
          "currentTool",
          "transcriptPath",
          "sessionFile",
        ]) {
          if (ev.subagent) expect(ev.subagent).not.toHaveProperty(key);
        }
      }
      expect(loadAll(base)[0].agents[0].session.activeAsyncRuns).toEqual([]);
      await server.close();
      server = undefined;
      index = new HistoryIndex(historyIndexFile(base), historyFile(base));
      while (!index.sync(5_000)) {
        /* offline index catch-up */
      }
      const db = new DatabaseSync(historyIndexFile(base), { readOnly: true });
      try {
        expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 5 });
      } finally {
        db.close();
      }
      for (const [marker, kind, taskId] of [
        [argsMarker, "tool_call", childA],
        [outputMarker, "tool_output", childA],
        ["unrelated-sibling-b", "said", childB],
      ] as const) {
        const { hits } = index.search({
          terms: [marker],
          depth: "subagents",
          kinds: [kind],
          limit: 10,
        });
        expect(hits).toHaveLength(1);
        expect(hits[0].depth).toBeGreaterThanOrEqual(1);
        expect(hits[0].subagentTaskId).toBe(taskId);
      }
    } finally {
      index?.close();
      await server?.close();
      closeHistory(base);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
