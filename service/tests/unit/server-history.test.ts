// The real Server in-process saving histories into history.db. Sessions are
// in-memory stand-ins, so no CLI is spawned.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import { savedAgent, serverDirectories, watchClient } from "./helpers/seeded-server";
import * as path from "path";
import { createHash } from "crypto";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import type { Message, WorkspaceState } from "../../src/workspace/workspace";

import { Server } from "../../src/server/server";
import { LocalHost } from "../../src/session/host";
import { HistoryDb } from "../../src/workspace/history-db";
import { historyFile } from "../../src/workspace/state";
import { FakeSession } from "./fakes";

const ENV_KEYS = ["HOME", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
let savedEnv: Record<string, string | undefined>;
const bases: string[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  vi.spyOn(LocalHost.prototype, "createSession").mockImplementation(
    (_id, config) => new FakeSession(config),
  );
  vi.spyOn(LocalHost.prototype, "restoreSession").mockImplementation(
    (_id, state) => new FakeSession(state.config),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true, maxRetries: 5 });
});

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 1500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

// Recent, or the sweep at start archives them.
const T0 = Date.now() - 60_000;
const msg = (
  id: string,
  content: string,
  timestamp: number,
  over: Partial<Message> = {},
): Message => ({
  id,
  kind: "agent",
  agentId: "a-1",
  content,
  timestamp: T0 + timestamp,
  status: "done",
  ...over,
});

// Workspaces as the server saves them: <id>.json, and the history in
// history.db.
function seed(workspaces: Array<{ state: WorkspaceState; messages: Message[] }>) {
  const { base, root, web } = serverDirectories("agent-team-server-history-", (dir) =>
    bases.push(dir),
  );
  const dir = path.join(base, ".agent-team", "cache", "workspaces");
  fs.mkdirSync(dir, { recursive: true });
  const db = new HistoryDb(historyFile(base));
  for (const { state: s, messages } of workspaces) {
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify({ ...s, cwd: root }));
    db.save(s.id, messages, "all");
  }
  db.close();
  fs.writeFileSync(
    path.join(base, ".agent-team", "cache", "index.json"),
    JSON.stringify({ workspaceIds: workspaces.map((w) => w.state.id) }),
  );
  return { base, web, dir };
}

const ws = (id: string, messages: Message[], archivedAt: number | null = null) => ({
  state: {
    id,
    name: id,
    project: "repo",
    hostId: "local",
    cwd: "",
    agents: [savedAgent("a-1", "A", "")],
    createdAt: T0,
    archivedAt,
  } as WorkspaceState,
  messages,
});

async function start(base: string, web: string) {
  const server = new Server(0, base, web);
  const port = await server.listening;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const { frames, send } = await watchClient(ws, until);
  const search = async (query: string) => {
    const seen = frames.length;
    send({ type: "search", query });
    await until(
      () => frames.slice(seen).some((f) => f.type === "search_results" && f.query === query),
      `search ${query}`,
    );
    const r = frames.slice(seen).find((f) => f.type === "search_results" && f.query === query)!;
    return (r.hits as Array<{ workspaceId: string; messageId: string }>).map(
      (h) => `${h.workspaceId}/${h.messageId}`,
    );
  };
  const live = (id: string) =>
    (server as unknown as { workspaces: Map<string, { messages: Message[] }> }).workspaces.get(id)!;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    ws.close();
    return server.close();
  };
  return { server, port, frames, send, search, live, stop };
}

// history.db as it is on disk, through a connection of its own.
function rows(base: string, session: string): Array<Pick<Message, "id" | "status" | "content">> {
  const db = new DatabaseSync(historyFile(base), { readOnly: true });
  try {
    return (
      db.prepare("select body from messages where session = ? order by seq").all(session) as Array<{
        body: string;
      }>
    ).map((r) => {
      const m = JSON.parse(r.body) as Message;
      return { id: m.id, status: m.status, content: m.content };
    });
  } finally {
    db.close();
  }
}

describe("a real server saving histories", () => {
  it("saves a finished message an event changes later (a background task's end)", async () => {
    const { base, web } = seed([ws("ws-a", [msg("a1", "started a task", 1000)])]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { live, stop } = await start(base, web);
    try {
      const w = live("ws-a") as unknown as {
        messages: Message[];
        streamed: (m: Message, e: { kind: string; content: string }) => void;
      };
      const done = w.messages[0];
      done.content = "started a task; it finished";
      w.streamed(done, { kind: "notice", content: "task done" });
      await until(
        () => rows(base, "ws-a")[0].content === "started a task; it finished",
        "the late change saved",
      );
    } finally {
      await stop();
    }
  });

  it("broadcasts and persists a cleared failure when a failed session resumes", async () => {
    const seeded = ws("ws-a", [msg("u1", "previous turn", 1000)]);
    seeded.state.attention = { unread: 1, lastResult: "failed", awaitsUser: false };
    const { base, web, dir } = seed([seeded]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const restore = vi.spyOn(LocalHost.prototype, "restoreSession");
    const { frames, stop } = await start(base, web);
    try {
      const session = restore.mock.results.at(-1)!.value as FakeSession;
      session.isRunning = true;
      session.emit("event", { kind: "text_delta", content: "resuming externally" });
      await until(
        () => frames.some((f) => f.type === "workspace_attention" && f.workspaceId === "ws-a"),
        "cleared attention broadcast",
      );
      const update = frames.find(
        (f) => f.type === "workspace_attention" && f.workspaceId === "ws-a",
      )!;
      expect(update).toMatchObject({ workspaceId: "ws-a", unread: 1 });
      expect(update).not.toHaveProperty("lastResult");

      const stateFile = path.join(dir, "ws-a.json");
      await until(() => {
        const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as WorkspaceState;
        return saved.attention?.unread === 1 && saved.attention.lastResult === undefined;
      }, "cleared attention persisted");
    } finally {
      await stop();
    }

    const fresh = await start(base, web);
    try {
      const init = fresh.frames.find((f) => f.type === "init") as {
        workspaces: Array<Record<string, unknown>>;
      };
      const restored = init.workspaces.find((w) => w.id === "ws-a")!;
      expect(restored).toMatchObject({ unread: 1 });
      expect(restored).not.toHaveProperty("lastResult");
    } finally {
      await fresh.stop();
    }
  });

  it("broadcasts enrichment of an unloaded tool owner and persists the authoritative child transcript", async () => {
    const workspaceId = "ws-a";
    const taskId = "child";
    const messageId = "owner";
    const toolUseId = "tool";
    const { base, web } = seed([
      ws(workspaceId, [
        msg(messageId, "before after", 1000, {
          events: [{ kind: "tool_use", content: "call", toolUseId, contentOffset: 6 }],
        }),
      ]),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const restore = vi.spyOn(LocalHost.prototype, "restoreSession");
    const { live, frames, stop } = await start(base, web);
    const session = restore.mock.results.at(-1)!.value as FakeSession;
    const subagent = { taskId, description: "review" };
    const events = [{ kind: "text", content: "authoritative child output" }];
    try {
      session.emit("event", { kind: "text_delta", content: "Unrelated current turn" });
      session.emit("event", {
        kind: "subagent_start",
        content: "",
        toolUseId,
        subagent: { ...subagent, status: "queued" },
      });
      session.emit("event", {
        kind: "subagent_progress",
        content: "",
        subagent: { ...subagent, status: "running" },
      });
      expect(live(workspaceId).messages[0].events?.[1].subagent?.status).toBe("running");
      session.emit("event", {
        kind: "subagent_done",
        content: "",
        subagent: { ...subagent, status: "partial", events: [{ kind: "text", content: "stale" }] },
      });
      session.emit("event", { kind: "result", content: "" });
      session.emit("event", {
        kind: "subagent_enrichment",
        content: "",
        subagent: { taskId, description: "", durationMs: 300 },
      });
      (live(workspaceId) as unknown as { unloadMessages(): void }).unloadMessages();
      session.emit("event", {
        kind: "subagent_enrichment",
        content: "",
        subagent: {
          taskId,
          description: "",
          model: "provider/model",
          effort: "high",
          durationMs: 500,
          summary: "final summary",
          events,
        },
      });
      await until(
        () =>
          frames.some(
            (f) =>
              f.type === "stream_event" &&
              (f.event as { subagent?: { transcriptRevision?: number } }).subagent
                ?.transcriptRevision === 3,
          ),
        "enrichment frame",
      );
      expect(
        frames.filter(
          (f) =>
            f.type === "stream_event" && (f.event as { kind: string }).kind.startsWith("subagent_"),
        ),
      ).toMatchObject([
        { messageId, event: { kind: "subagent_start", contentOffset: 6 } },
        { messageId, event: { kind: "subagent_progress" } },
        { messageId, event: { kind: "subagent_done" } },
        {
          messageId,
          event: {
            kind: "subagent_enrichment",
            subagent: { transcriptRevision: 2, durationMs: 300 },
          },
        },
        {
          messageId,
          event: {
            kind: "subagent_enrichment",
            subagent: { taskId, eventCount: 1, summary: "final summary", transcriptRevision: 3 },
          },
        },
      ]);
      const last = frames
        .filter((f) => (f.event as { kind: string } | undefined)?.kind === "subagent_enrichment")
        .at(-1)!;
      expect((last.event as { subagent: unknown }).subagent).not.toHaveProperty("events");
    } finally {
      await stop();
    }
    const fresh = await start(base, web);
    try {
      fresh.send({ type: "open_workspace", workspaceId });
      fresh.send({ type: "load_message_details", workspaceId, messageId });
      fresh.send({
        type: "load_subagent_trace",
        requestId: 17,
        limit: 1,
        workspaceId,
        messageId,
        taskId,
      });
      await until(
        () => fresh.frames.some((f) => f.type === "subagent_trace_page"),
        "fresh child details",
      );
      const reply = (
        fresh.frames.find((f) => f.type === "workspace_messages")!.messages as Message[]
      ).find((m) => m.id === messageId)!;
      expect(reply.events!.map((e) => e.kind)).toEqual([
        "tool_use",
        "subagent_start",
        "subagent_done",
      ]);
      for (const e of reply.events!.slice(1)) {
        expect(e.subagent).toMatchObject({
          ...subagent,
          status: "partial",
          model: "provider/model",
          effort: "high",
          durationMs: 500,
          summary: "final summary",
          eventCount: 1,
          transcriptRevision: 3,
        });
      }
      const detail = fresh.frames.find((f) => f.type === "message_details")!.events as NonNullable<
        Message["events"]
      >;
      for (const e of detail.slice(1)) {
        expect(e.subagent).toMatchObject({ summary: "final summary", transcriptRevision: 3 });
      }
      expect(fresh.frames.find((f) => f.type === "subagent_trace_page")).toMatchObject({
        events,
        requestId: 17,
        totalEvents: 1,
        revision: 3,
      });
    } finally {
      await fresh.stop();
    }
  });

  it("the sidebar finds what was said in live and archived histories", async () => {
    const { base, web } = seed([
      ws("ws-a", [msg("u1", "the zeppelin bug again", 1000, { kind: "user", agentId: null })]),
      ws("ws-b", [msg("b1", "a narwhal in the archive", 900)], 5),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { search, stop } = await start(base, web);
    try {
      expect(await search("NARWHAL")).toEqual(["ws-b/b1"]);
      expect(await search("zeppelin")).toEqual(["ws-a/u1"]);
    } finally {
      await stop();
    }
  });

  // What history.db holds when the server died mid-turn: the turn as last
  // saved, still streaming.
  function crashMidTurn(base: string, session: string, m: Message): void {
    const db = new DatabaseSync(historyFile(base));
    const body = JSON.stringify(m);
    const hash = createHash("sha1").update(body).digest("base64");
    const { seq } = db
      .prepare("select max(seq) + 1 as seq from messages where session = ?")
      .get(session) as { seq: number };
    db.prepare("insert into messages values (?, ?, ?, ?, ?, ?, ?, ?)").run(
      session,
      m.id,
      seq,
      m.timestamp,
      m.kind,
      m.status,
      hash,
      body,
    );
    db.close();
  }

  async function restartedMidTurn() {
    const { base, web } = seed([
      ws("ws-a", [msg("u1", "hello", 1000, { kind: "user", agentId: null })]),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await (await start(base, web)).stop();
    crashMidTurn(
      base,
      "ws-a",
      msg("a1", "half an answer about quokkas", 1001, { status: "streaming" }),
    );
    return { base, web };
  }

  it("writes and indexes a turn a restart cut short at once, naming only it", async () => {
    const { base, web } = await restartedMidTurn();
    const save = vi.spyOn(HistoryDb.prototype, "save");
    const { search, stop } = await start(base, web);
    try {
      const saved = rows(base, "ws-a").find((m) => m.id === "a1")!;
      expect(saved).toMatchObject({
        status: "done",
        content: "half an answer about quokkas\n\n*\\[interrupted\\]*",
      });
      const calls = save.mock.calls.filter(([s]) => s === "ws-a");
      expect(calls).toHaveLength(1);
      expect(calls[0][2]).toBeInstanceOf(Set);
      expect([...(calls[0][2] as Set<string>)]).toEqual(["a1"]);
      expect(await search("quokkas")).toEqual(["ws-a/a1"]);
    } finally {
      await stop();
    }
  });

  it("writes only what was marked as it goes, and compares every message before archiving and on shutdown", async () => {
    const { base, web } = seed([
      ws("ws-a", [
        msg("u1", "first", 1000, { kind: "user", agentId: null }),
        msg("a1", "reply", 1001),
      ]),
      ws("ws-c", [msg("c1", "other", 1000)]),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const save = vi.spyOn(HistoryDb.prototype, "save");
    const { send, frames, live, stop } = await start(base, web);
    try {
      // Changed in memory by a path that did not mark it.
      live("ws-a").messages[0].content = "first, edited";
      live("ws-c").messages[0].content = "other, edited";
      send({ type: "clear_context", workspaceId: "ws-a", agentId: "a-1" });
      await until(
        () => rows(base, "ws-a").some((m) => m.content.includes("context cleared")),
        "the system message saved",
      );
      expect(rows(base, "ws-a")[0].content).toBe("first");

      save.mockClear();
      send({ type: "archive_workspace", workspaceId: "ws-a" });
      await until(
        () => frames.some((f) => f.type === "workspace_archived" && f.workspaceId === "ws-a"),
        "archived",
      );
      expect(save.mock.calls.filter(([s]) => s === "ws-a").map((c) => c[2])).toEqual(["all"]);
      expect(rows(base, "ws-a")[0].content).toBe("first, edited");
      expect(rows(base, "ws-c")[0].content).toBe("other");
    } finally {
      await stop();
    }
    expect(rows(base, "ws-c")[0].content).toBe("other, edited");
  });

  it("an interrupted turn at shutdown is saved as such", async () => {
    const { base, web } = seed([ws("ws-a", [])]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { send, frames, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-a", content: "tell me about axolotls" });
      await until(
        () =>
          frames.some(
            (f) =>
              f.type === "new_message" &&
              (f.message as Message).kind === "agent" &&
              (f.message as Message).status === "streaming",
          ),
        "the turn started",
      );
    } finally {
      await stop();
    }
    const saved = rows(base, "ws-a").filter((m) => m.content !== "tell me about axolotls");
    expect(saved.map((m) => m.status)).toEqual(["done"]);
    expect(saved[0].content).toContain("interrupted");
  });

  it("never saves an empty history over one it could not read", async () => {
    const { base, web } = seed([ws("ws-a", [msg("a1", "kept", 1000)])]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new DatabaseSync(historyFile(base));
    db.prepare("insert into messages values (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ws-a",
      "a2",
      99,
      2000,
      "agent",
      "done",
      "x",
      '{"id":"a2","cont',
    );
    db.close();
    const { stop } = await start(base, web);
    await stop();
    const saved = new DatabaseSync(historyFile(base), { readOnly: true });
    try {
      expect(
        saved.prepare("select id from messages where session = 'ws-a' order by seq").all(),
      ).toEqual([{ id: "a1" }, { id: "a2" }]);
    } finally {
      saved.close();
    }
  });

  for (const state of ["idle", "waiting"] as const) {
    it(`omits context on clear_context (${state}) so live and fresh clients match`, async () => {
      const { base, web } = seed([
        ws("ws-a", [
          msg("u1", "first", 1000, { kind: "user", agentId: null }),
          msg("a1", "reply", 1001, { context: { tokens: 96_000, window: 1_000_000 } }),
        ]),
      ]);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { port, frames, send, live, stop } = await start(base, web);
      let freshWs: WebSocket | undefined;
      try {
        if (state === "waiting") {
          const w = live("ws-a") as unknown as {
            agents: Map<string, { session: FakeSession }>;
          };
          w.agents.get("a-1")!.session.emit("runState", "waiting");
          await until(
            () =>
              frames.some(
                (f) =>
                  f.type === "agent_updated" &&
                  f.workspaceId === "ws-a" &&
                  (f.agent as { state?: string }).state === "waiting",
              ),
            "waiting state update",
          );
        } else {
          const init1 = frames.find((f) => f.type === "init") as {
            workspaces: Array<{ id: string; agents: Array<{ id: string; context?: unknown }> }>;
          };
          expect(init1.workspaces.find((w) => w.id === "ws-a")!.agents[0].context).toEqual({
            tokens: 96_000,
            window: 1_000_000,
          });
        }

        const beforeClear = frames.length;
        send({ type: "clear_context", workspaceId: "ws-a", agentId: "a-1" });
        await until(
          () =>
            frames
              .slice(beforeClear)
              .some((f) => f.type === "agent_updated" && f.workspaceId === "ws-a") &&
            frames
              .slice(beforeClear)
              .some(
                (f) =>
                  f.type === "new_message" &&
                  f.workspaceId === "ws-a" &&
                  (f.message as Message).content.includes("context cleared"),
              ),
          "live clear_context frames",
        );

        const liveUpdate = frames
          .slice(beforeClear)
          .find((f) => f.type === "agent_updated" && f.workspaceId === "ws-a")!;
        expect(liveUpdate.agent).toMatchObject({ state, busy: false });
        expect(liveUpdate.agent).not.toHaveProperty("context");
        const clearMessage = frames
          .slice(beforeClear)
          .find(
            (f) =>
              f.type === "new_message" &&
              (f.message as Message).content.includes("context cleared"),
          )!;
        expect(clearMessage.message).not.toHaveProperty("context");

        freshWs = new WebSocket(`ws://127.0.0.1:${port}/`);
        const { frames: freshFrames } = await watchClient(freshWs, until);
        const init2 = freshFrames.find((f) => f.type === "init") as {
          workspaces: Array<{ id: string; agents: Array<Record<string, unknown>> }>;
        };
        expect(init2.workspaces.find((w) => w.id === "ws-a")!.agents[0]).toEqual(liveUpdate.agent);
      } finally {
        freshWs?.close();
        await stop();
      }
    });
  }

  it("omits context for fresh and archived workspaces, including loaded archived history", async () => {
    const { base, web } = seed([
      ws("ws-fresh", []),
      ws("ws-archived", [msg("a1", "reply", 1001, { context: null })], 5),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { port, frames, send, stop } = await start(base, web);
    let freshWs: WebSocket | undefined;
    try {
      const init = frames.find((f) => f.type === "init") as {
        workspaces: Array<{ id: string; agents: Array<Record<string, unknown>> }>;
      };
      for (const id of ["ws-fresh", "ws-archived"]) {
        const agent = init.workspaces.find((w) => w.id === id)!.agents[0];
        expect(agent.context).toBeUndefined();
        expect(agent).not.toHaveProperty("context");
      }

      send({ type: "open_workspace", workspaceId: "ws-archived" });
      await until(
        () =>
          frames.some((f) => f.type === "workspace_messages" && f.workspaceId === "ws-archived"),
        "archived history loaded",
      );
      freshWs = new WebSocket(`ws://127.0.0.1:${port}/`);
      const { frames: freshFrames } = await watchClient(freshWs, until);
      const freshInit = freshFrames.find((f) => f.type === "init") as {
        workspaces: Array<{ id: string; agents: Array<Record<string, unknown>> }>;
      };
      const archived = freshInit.workspaces.find((w) => w.id === "ws-archived")!.agents[0];
      expect(archived.context).toBeUndefined();
      expect(archived).not.toHaveProperty("context");
    } finally {
      freshWs?.close();
      await stop();
    }
  });

  it("re-sends context occupancy after an archived workspace is reloaded", async () => {
    const { base, web } = seed([
      ws("ws-a", [msg("a1", "reply", 1001, { context: { tokens: 96_000, window: 1_000_000 } })]),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "archive_workspace", workspaceId: "ws-a" });
      await until(
        () => frames.some((f) => f.type === "workspace_archived" && f.workspaceId === "ws-a"),
        "archived",
      );
      const beforeRestore = frames.length;
      send({ type: "unarchive_workspace", workspaceId: "ws-a" });
      await until(
        () =>
          frames
            .slice(beforeRestore)
            .some((f) => f.type === "agent_updated" && f.workspaceId === "ws-a"),
        "restored agent snapshot",
      );
      const restored = frames
        .slice(beforeRestore)
        .find((f) => f.type === "agent_updated" && f.workspaceId === "ws-a")!;
      expect(restored.agent).toMatchObject({
        context: { tokens: 96_000, window: 1_000_000 },
      });
    } finally {
      await stop();
    }
  });
});
