// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyEventsToMessage,
  applyStreamBatch,
  mergeLatestPage,
  downgradedMessageIds,
  toolNameOf,
  toolSummary,
} from "../src/state/stream";
import { Message, StreamEvent } from "../src/state/useServer";
import {
  INACTIVE_TRANSCRIPT_BUDGET,
  inactiveTranscriptBytes,
  retainInactiveTranscripts,
} from "../src/state/transcriptRetention";
import { splitEvents } from "../src/chat/events";
import { message, workspace } from "./helpers/fixtures";

const ev = (kind: string, over: Partial<StreamEvent> = {}): StreamEvent => ({
  kind,
  content: "",
  ...over,
});

const msg = (over: Partial<Message> = {}) =>
  message("m1", { timestamp: 0, status: "streaming", events: [], ...over });

const traceSummary = (taskId: string, eventCount: number, transcriptRevision: number) =>
  ev("subagent_enrichment", {
    subagent: { taskId, description: "", eventCount, transcriptRevision, lastTool: "Read" },
  });

describe("applyEventsToMessage", () => {
  it("keeps lifecycle metadata equivalent in live and timeline cards", () => {
    const lifecycle = [
      ev("subagent_start", {
        subagent: { taskId: "child", description: "Audit", status: "running", eventCount: 5 },
      }),
      ev("subagent_progress", {
        subagent: {
          taskId: "child",
          description: "",
          model: "anthropic/claude-opus-4-6",
          eventCount: 9,
        },
      }),
      ev("subagent_progress", {
        subagent: { taskId: "child", description: "", effort: "high", eventCount: 7 },
      }),
      ev("subagent_done", {
        subagent: {
          taskId: "child",
          description: "",
          status: "completed",
          eventCount: 0,
          summary: "Done",
        },
      }),
    ];
    const expected = {
      taskId: "child",
      description: "Audit",
      model: "anthropic/claude-opus-4-6",
      effort: "high",
      eventCount: 0,
      status: "completed",
      summary: "Done",
    };
    const run = (frames: StreamEvent[], initial = msg()) =>
      frames.reduce((m, frame) => applyEventsToMessage(m, [frame]), initial);
    const root = run(lifecycle).events!;
    expect(root[0].subagent).toMatchObject(expected);
    expect(splitEvents(root).subagents[0].subagent).toMatchObject(expected);
    expect(splitEvents(lifecycle).subagents[0].subagent).toMatchObject(expected);
  });

  it.each([false, true])(
    "keeps sparse progress metadata on completion (another update: %s)",
    (anotherUpdate) => {
      const start = ev("subagent_start", {
        subagent: { taskId: "child", description: "Audit", status: "running" },
      });
      const progress = ev("subagent_progress", {
        subagent: {
          taskId: "child",
          description: "",
          model: "opus",
          effort: "high",
          lastTool: "Read",
          eventCount: 9,
        },
      });
      const done = ev("subagent_done", {
        subagent: { taskId: "child", description: "", status: "completed", eventCount: 0 },
      });
      const loaded = [start, progress];
      const updates = anotherUpdate
        ? [ev("subagent_progress", { subagent: { taskId: "child", description: "" } }), done]
        : [done];
      const root = applyEventsToMessage(msg({ events: loaded }), updates).events!;
      const expected = {
        taskId: "child",
        description: "Audit",
        model: "opus",
        effort: "high",
        lastTool: "Read",
        eventCount: 0,
        status: "completed",
      };
      expect(root[0].subagent).toMatchObject(expected);
      expect(splitEvents(root).subagents[0].subagent).toMatchObject(expected);
      expect(loaded).toEqual([start, progress]);
      expect(start.subagent).not.toHaveProperty("model");
    },
  );

  it.each([
    [12, 4],
    [3, 19],
  ])(
    "uses the authoritative terminal trace count (%i at start, %i at completion)",
    (start, end) => {
      const info = { taskId: "task", description: "work" };
      const message = msg({
        events: [ev("subagent_start", { subagent: { ...info, eventCount: start } })],
      });
      const out = applyEventsToMessage(message, [
        ev("subagent_done", {
          subagent: { ...info, status: "completed", eventCount: end },
        }),
      ]);
      expect(out.events![0].subagent!.eventCount).toBe(end);
    },
  );

  it("appends text deltas and ignores thinking deltas", () => {
    const out = applyEventsToMessage(msg({ content: "He" }), [
      ev("text_delta", { content: "llo" }),
      ev("thinking_delta", { content: "zzz" }),
    ]);
    expect(out.content).toBe("Hello");
    expect(out.events).toEqual([]);
  });

  it("attaches a tool_result to its tool_use instead of appending it", () => {
    const out = applyEventsToMessage(msg({ events: [ev("tool_use", { toolUseId: "t1" })] }), [
      ev("tool_result", { toolUseId: "t1", content: "42", isMarkdown: true }),
      ev("tool_result", { toolUseId: "missing", content: "orphan" }),
    ]);
    expect(out.events).toHaveLength(2);
    expect(out.events![0]).toMatchObject({ toolResult: "42", toolResultIsMarkdown: true });
    expect(out.events![1]).toMatchObject({ kind: "tool_result", content: "orphan" });
  });

  it("marks a tool_use whose result was a failure, as the server does", () => {
    const out = applyEventsToMessage(
      msg({ events: [ev("tool_use", { toolUseId: "t1" }), ev("tool_use", { toolUseId: "t2" })] }),
      [
        ev("tool_result", { toolUseId: "t1", content: "No such session", isError: true }),
        ev("tool_result", { toolUseId: "t2", content: "ok" }),
      ],
    );
    expect(out.events!.map((e) => e.toolResultIsError)).toEqual([true, undefined]);
  });

  it("keeps one retry event per message, preserving its position", () => {
    const first = applyEventsToMessage(msg(), [
      ev("retry", { content: "retry 1/10", contentOffset: 3 }),
      ev("notice", { content: "fyi" }),
    ]);
    const second = applyEventsToMessage(first, [ev("retry", { content: "retry 2/10" })]);
    expect(second.events!.map((e) => [e.kind, e.content, e.contentOffset])).toEqual([
      ["retry", "retry 2/10", 3],
      ["notice", "fyi", undefined],
    ]);
  });

  it("clears retries on explicit recovery, real progress, and failure", () => {
    const retry = ev("retry", { content: "Retrying" });
    const progress = [
      ev("text_delta", { content: "recovered" }),
      ev("thinking_delta", { content: "thinking" }),
      ev("thinking", { content: "thought" }),
      ev("tool_use", { content: "Read", toolUseId: "read" }),
      ev("subagent_start", {
        subagent: { taskId: "task", description: "work", status: "running" },
      }),
    ];
    for (const event of progress) {
      const out = applyEventsToMessage(msg({ events: [retry] }), [event]);
      expect(
        out.events?.some((e) => e.kind === "retry"),
        event.kind,
      ).toBe(false);
    }
    expect(applyEventsToMessage(msg({ events: [retry] }), [ev("retry")]).events).toEqual([]);
    expect(
      applyEventsToMessage(msg({ events: [retry] }), [ev("error", { content: "failed" })]).events,
    ).toEqual([expect.objectContaining({ kind: "error", content: "failed" })]);
  });

  it("uses wire order when progress and retry updates share a batch", () => {
    const recovered = applyEventsToMessage(msg(), [
      ev("retry", { content: "Retrying" }),
      ev("text_delta", { content: "recovered" }),
    ]);
    expect(recovered.events).toEqual([]);
    const retrying = applyEventsToMessage(msg(), [
      ev("text_delta", { content: "working" }),
      ev("retry", { content: "Retrying" }),
    ]);
    expect(retrying.events?.map((e) => e.kind)).toEqual(["retry"]);
    const restarted = applyEventsToMessage(msg(), [
      ev("retry", { content: "Retry 1", contentOffset: 0 }),
      ev("text_delta", { content: "ok" }),
      ev("retry", { content: "Retry 2", contentOffset: 2 }),
    ]);
    expect(restarted.events).toEqual([
      expect.objectContaining({ kind: "retry", content: "Retry 2", contentOffset: 2 }),
    ]);
  });

  it("applies absolute progress and revision without attaching a trace or mutating the original card", () => {
    const start = ev("subagent_start", {
      subagent: { taskId: "task", description: "Audit", status: "running", eventCount: 1 },
    });
    const input = msg({ events: [start] });
    const out = applyEventsToMessage(input, [
      traceSummary("task", 50, 7),
      traceSummary("task", 2, 6),
    ]);
    expect(start.subagent!.eventCount).toBe(1);
    expect(out.events).toHaveLength(1);
    expect(out.events![0].subagent).toMatchObject({
      eventCount: 50,
      transcriptRevision: 7,
      lastTool: "Read",
    });
    expect(out.events![0].subagent).not.toHaveProperty("events");
  });

  it("returns the same message object when nothing applies", () => {
    const m = msg();
    expect(applyEventsToMessage(m, [])).toBe(m);
    // A batch of deltas that change nothing must not defeat memo either.
    expect(applyEventsToMessage(m, [ev("text_delta", { content: "" })])).toBe(m);
  });

  it("is pure under repeated batches and preserves unrelated summary identities", () => {
    const quiet = ev("subagent_start", { subagent: { taskId: "idle", description: "Idle" } });
    const busy = ev("subagent_start", { subagent: { taskId: "busy", description: "Busy" } });
    const batch = [quiet, busy, traceSummary("busy", 12, 34)];
    const first = applyEventsToMessage(msg(), batch);
    const second = applyEventsToMessage(msg(), batch);
    expect(first).toEqual(second);
    expect(second.events![0]).toBe(quiet);
    expect(second.events![1].subagent!.eventCount).toBe(12);
    expect(busy.subagent!.eventCount).toBeUndefined();
  });
});

describe("applyStreamBatch", () => {
  it("applies each message's events in order when a batch spans messages", () => {
    const ws = { id: "A", messages: [msg({ id: "m1" }), msg({ id: "m2" })] };
    const [out] = applyStreamBatch(
      [ws],
      [
        { wsId: "A", messageId: "m1", event: ev("text_delta", { content: "a" }) },
        { wsId: "A", messageId: "m2", event: ev("text_delta", { content: "x" }) },
        { wsId: "A", messageId: "m1", event: ev("text_delta", { content: "b" }) },
      ],
    );
    expect(out.messages.map((m) => m.content)).toEqual(["ab", "x"]);
  });

  it("only touches workspaces and messages named in the batch", () => {
    const wsA = { id: "A", messages: [msg({ id: "m1" }), msg({ id: "m2" })] };
    const wsB = { id: "B", messages: [msg({ id: "m1" })] };
    const out = applyStreamBatch(
      [wsA, wsB],
      [{ wsId: "A", messageId: "m2", event: ev("text_delta", { content: "x" }) }],
    );
    expect(out[1]).toBe(wsB);
    expect(out[0].messages[0]).toBe(wsA.messages[0]);
    expect(out[0].messages[1].content).toBe("x");
  });
});

describe("tool name helpers", () => {
  it("prefers the explicit toolName and falls back to the bold prefix", () => {
    expect(
      toolNameOf(ev("tool_use", { toolName: "Bash", content: "**Bash**\n```bash\nls\n```" })),
    ).toBe("Bash");
    expect(toolNameOf(ev("tool_use", { content: "**Read** `a.ts`" }))).toBe("Read");
    expect(toolNameOf(ev("tool_use", { content: "no name" }))).toBeNull();
  });

  it("summarises single-line tool calls without the name or backticks", () => {
    expect(toolSummary(ev("tool_use", { content: "**Read** `src/a.ts`" }))).toBe("src/a.ts");
    expect(toolSummary(ev("tool_use", { content: "**Bash**\n```bash\nls\n```" }))).toBe("");
  });
});

describe("mergeLatestPage", () => {
  it("takes the server's status for a message that finished while disconnected", () => {
    const live = msg({ id: "m2", timestamp: 2, status: "streaming", content: "par" });
    const done = msg({
      id: "m2",
      timestamp: 2,
      status: "done",
      content: "partial then done",
      events: [ev("tool_use", { toolName: "Read" })],
      detail: "summary",
    });
    const out = mergeLatestPage([msg({ id: "m1", timestamp: 1, status: "done" }), live], [done]);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(out[1].status).toBe("done");
    expect(out[1].content).toBe("partial then done");
    expect(out[1].detail).toBe("summary");
  });

  it("takes a result that came or failed while disconnected, on a settled message", () => {
    const call = ev("tool_use", {
      toolName: "mcp__panel__message_session",
      toolUseId: "t1",
      content: "**message_session** `ws-9`",
    });
    const mine = msg({ id: "m1", timestamp: 1, status: "done", events: [call] });
    const theirs = msg({
      id: "m1",
      timestamp: 1,
      status: "done",
      detail: "summary",
      events: [
        { ...call, toolResult: "No session ws-9", resultLength: 15, toolResultIsError: true },
      ],
    });
    const [out] = mergeLatestPage([mine], [theirs]);
    expect(out.events![0]).toMatchObject({
      toolResult: "No session ws-9",
      toolResultIsError: true,
    });
    // Nothing moved: the client keeps its own copy.
    const settled = msg({
      id: "m1",
      timestamp: 1,
      status: "done",
      events: [{ ...call, toolResult: "ok" }],
    });
    const same = msg({
      ...settled,
      detail: "summary",
      events: [{ ...call, resultLength: 2 }],
    });
    expect(mergeLatestPage([settled], [same])[0].events![0].toolResult).toBe("ok");
  });

  it("appends messages that arrived while disconnected, in order", () => {
    const out = mergeLatestPage(
      [msg({ id: "m1", timestamp: 1, status: "done" })],
      [
        msg({ id: "m1", timestamp: 1, status: "done" }),
        msg({ id: "m2", timestamp: 2, status: "done" }),
        msg({ id: "m3", timestamp: 3, status: "streaming" }),
      ],
    );
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps older pages the client scrolled back to and drops removed messages", () => {
    const out = mergeLatestPage(
      [
        msg({ id: "old", timestamp: 0, status: "done" }),
        msg({ id: "m1", timestamp: 1, status: "done" }),
        msg({ id: "gone", timestamp: 2, status: "queued" }),
      ],
      [msg({ id: "m1", timestamp: 1, status: "done" }), msg({ id: "m3", timestamp: 3 })],
    );
    expect(out.map((m) => m.id)).toEqual(["old", "m1", "m3"]);
  });

  it("keeps full bodies the user already expanded when nothing changed", () => {
    const full = [ev("thinking", { content: "long body" })];
    const cur = msg({ id: "m1", timestamp: 1, status: "done", events: full });
    const summary = msg({
      id: "m1",
      timestamp: 1,
      status: "done",
      events: [ev("thinking", { contentLength: 9 })],
      detail: "summary",
    });
    const out = mergeLatestPage([cur], [summary]);
    expect(out[0].events).toBe(full);
    expect(out[0].detail).toBeUndefined();
  });

  it("an empty newest page means the workspace has no messages", () => {
    expect(mergeLatestPage([msg({ id: "m1" })], [])).toEqual([]);
  });

  it("keeps a live thinking block across a resync while both sides still stream", () => {
    const cur = msg({ id: "m1", liveThinking: "so far", liveThinkingSince: 1_000 });
    const next = msg({ id: "m1", detail: "summary", liveThinkingSince: 1_000 });
    expect(mergeLatestPage([cur], [next])[0]).toMatchObject({
      liveThinking: "so far",
      liveThinkingSince: 1_000,
    });
    const afterPause = { ...next, liveThinkingSince: undefined, waitingSince: 2_000 };
    expect(mergeLatestPage([cur], [afterPause])[0]).toEqual(afterPause);
    const newBlock = { ...next, liveThinkingSince: 3_000 };
    expect(mergeLatestPage([cur], [newBlock])[0]).toEqual(newBlock);
    expect(
      applyEventsToMessage(newBlock, [ev("thinking_delta", { content: "tail", startedAt: 3_000 })]),
    ).toMatchObject({ liveThinking: "tail", liveThinkingSince: 3_000 });
    const done = msg({ id: "m1", status: "done" });
    expect(mergeLatestPage([cur], [done])[0].liveThinking).toBeUndefined();
  });

  it("replaces the list when the page does not reach what the client holds", () => {
    // More arrived while away than fits on a page (m4, m5 are on neither):
    // keeping m1..m3 would leave a gap that paging back never fills.
    const out = mergeLatestPage(
      [1, 2, 3].map((i) => msg({ id: `m${i}`, timestamp: i, status: "done" })),
      [6, 7].map((i) => msg({ id: `m${i}`, timestamp: i, status: "done" })),
    );
    expect(out.map((m) => m.id)).toEqual(["m6", "m7"]);
  });

  it("takes the server's copy of a settled message whose background card finished", () => {
    // agent-bg: the card lives on a turn that is already done; it finished
    // while the socket was down.
    const existing = [
      msg({
        id: "m1",
        timestamp: 1,
        status: "done",
        events: [
          ev("tool_use", { toolUseId: "tu1" }),
          ev("subagent_start", {
            toolUseId: "tu1",
            subagent: {
              taskId: "t1",
              description: "bg",
              status: "running",
              eventCount: 1,
            },
          }),
        ],
      }),
    ];
    const incoming = [
      msg({
        id: "m1",
        timestamp: 1,
        status: "done",
        detail: "summary",
        events: [
          ev("tool_use", { toolUseId: "tu1" }),
          ev("subagent_start", {
            toolUseId: "tu1",
            subagent: { taskId: "t1", description: "bg", status: "completed", eventCount: 2 },
          }),
          ev("subagent_done", {
            subagent: { taskId: "t1", description: "", status: "completed", eventCount: 0 },
          }),
        ],
      }),
    ];
    const merged = mergeLatestPage(existing, incoming);
    expect(merged[0].events!.find((e) => e.kind === "subagent_start")!.subagent!.status).toBe(
      "completed",
    );
    expect(downgradedMessageIds(existing, merged)).toEqual(["m1"]);
  });

  it("takes the server's copy when a card was stopped by a server restart", () => {
    const card = (status: "running" | "stopped", extra: Partial<StreamEvent["subagent"]> = {}) =>
      ev("subagent_start", { subagent: { taskId: "t", description: "d", status, ...extra } });
    const existing = [msg({ id: "m1", status: "done", events: [card("running")] })];
    const incoming = [
      msg({ id: "m1", status: "done", detail: "summary", events: [card("stopped")] }),
    ];
    expect(mergeLatestPage(existing, incoming)[0].events![0].subagent!.status).toBe("stopped");
  });

  it("replaces a trace summary on reconnect even when only the revision changed", () => {
    const at = (revision: number) =>
      msg({
        status: "done",
        events: [
          ev("subagent_start", {
            subagent: {
              taskId: "T",
              description: "Audit",
              eventCount: 25,
              transcriptRevision: revision,
            },
          }),
        ],
      });
    const newer = { ...at(2), detail: "summary" as const };
    expect(mergeLatestPage([at(1)], [newer])[0]).toEqual(newer);
  });
});

it(
  "charges UTF-8 inactive prefixes by read order without splitting the protected suffix",
  { tags: ["history-stress"] },
  () => {
    expect(INACTIVE_TRANSCRIPT_BUDGET).toBe(1_048_576);
    const half = "界".repeat(180_000);
    const row = (id: string, timestamp: number, patch: Partial<Message> = {}) =>
      msg({ id, timestamp, status: "done", ...patch });
    const floor = [
      row("tie", 1),
      row("prompt", 1, { kind: "user" }),
      row("queued", 2, { kind: "user", status: "queued", queuedFor: "a", steering: true }),
      row("live", 3, { status: "streaming", replyTo: "prompt" }),
      row("last", 4, { content: half.repeat(2) }),
    ];
    const ws = (id: string, messages: Message[]) =>
      workspace(id, {
        project: "p",
        hostId: "h",
        cwd: "/",
        createdAt: 0,
        messages,
        messagesLoaded: true,
      });
    const prefix = [row("older-note", -1), row("prefix", 0, { content: half })];
    const older = {
      ...ws("older", [...prefix, ...floor]),
      loadingOlder: true,
      queued: true,
    };
    const recent = ws("recent", [
      row("nested", 0, { events: [ev("thinking", { content: half })] }),
    ]);
    const active = ws("active", [row("large", 0, { content: half.repeat(2) })]);
    const order = [active.id, older.id, recent.id];
    const stored = [recent, active, older]; // Deliberately not in read order.
    const bytes = (rows: Message[]) => Buffer.byteLength(JSON.stringify(rows), "utf8");
    expect(inactiveTranscriptBytes(stored, active.id)).toBe(bytes(recent.messages) + bytes(prefix));
    expect(retainInactiveTranscripts([recent, active], active.id, order)).toEqual([recent, active]);
    expect(retainInactiveTranscripts(stored, active.id, order)).toEqual([
      recent,
      active,
      { ...older, messages: floor, hasMore: true, loadingOlder: false },
    ]);
  },
);

describe("downgradedMessageIds", () => {
  it("names messages that had bodies and came back as summaries", () => {
    const existing = [
      msg({ id: "live", status: "streaming", events: [ev("thinking", { content: "body" })] }),
      msg({ id: "page", status: "done", events: [ev("thinking")], detail: "summary" }),
      msg({ id: "empty", status: "done" }),
    ];
    const merged = [
      msg({ id: "live", status: "done", events: [ev("thinking")], detail: "summary" }),
      msg({ id: "page", status: "done", events: [ev("thinking")], detail: "summary" }),
      msg({ id: "empty", status: "done" }),
      msg({ id: "new", status: "done", events: [ev("thinking")], detail: "summary" }),
    ];
    expect(downgradedMessageIds(existing, merged)).toEqual(["live"]);
  });
});

describe("robustness", () => {
  it("keeps execution fields across progress replacement and terminal folding", () => {
    const out = applyEventsToMessage(msg(), [
      ev("subagent_start", { subagent: { taskId: "a", description: "review" } }),
      ev("subagent_progress", {
        subagent: { taskId: "a", description: "", model: "provider/model", effort: "low" },
      }),
      ev("subagent_progress", { subagent: { taskId: "a", description: "", effort: "high" } }),
      ev("subagent_done", { subagent: { taskId: "a", description: "", status: "completed" } }),
    ]);
    expect(out.events![0].subagent).toMatchObject({
      model: "provider/model",
      effort: "high",
      status: "completed",
    });
  });
  it("tolerates events without content and keeps the start's description on done", () => {
    expect(toolNameOf({ kind: "tool_use" } as StreamEvent)).toBeNull();
    expect(toolSummary({ kind: "tool_use" } as StreamEvent)).toBe("");
    const start = msg({
      events: [
        ev("subagent_start", {
          subagent: { taskId: "a", description: "review", agentType: "Explore" },
        }),
      ],
    });
    const out = applyEventsToMessage(start, [
      ev("subagent_done", { subagent: { taskId: "a", description: "", status: "completed" } }),
    ]);
    expect(out.events![0].subagent).toMatchObject({
      status: "completed",
      description: "review",
      agentType: "Explore",
    });
  });

  it("keeps a same-millisecond neighbour that is not on the incoming page", () => {
    const out = mergeLatestPage(
      [msg({ id: "old", timestamp: 5, status: "done" }), msg({ id: "m1", timestamp: 5 })],
      [msg({ id: "m1", timestamp: 5, status: "done" })],
    );
    expect(out.map((m) => m.id)).toEqual(["old", "m1"]);
  });
});

describe("thinking tokens", () => {
  it("land on the latest thinking block, and are not listed", () => {
    const m: Message = {
      id: "m1",
      kind: "agent",
      agentId: "a",
      content: "",
      timestamp: 1,
      status: "streaming",
      events: [
        { kind: "thinking", content: "Hm", durationMs: 900 },
        { kind: "tool_use", content: "Read /a", toolUseId: "t1" },
      ],
    };
    const next = applyEventsToMessage(m, [{ kind: "thinking_tokens", content: "", tokens: 42 }]);
    expect(next.events!.map((e) => [e.kind, e.tokens])).toEqual([
      ["thinking", 42],
      ["tool_use", undefined],
    ]);
  });
});

describe("live thinking", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const think = (content: string) => ev("thinking_delta", { content });

  it("streams a thinking block into client-only state, never into events", () => {
    vi.setSystemTime(1_000);
    let m = applyEventsToMessage(msg(), [think("")]);
    expect(m).toMatchObject({ liveThinking: "", liveThinkingSince: 1_000 });
    vi.setSystemTime(4_000);
    m = applyEventsToMessage(m, [think("Let me "), think("check.")]);
    expect(m).toMatchObject({ liveThinking: "Let me check.", liveThinkingSince: 1_000 });
    expect(m.events).toEqual([]);
  });

  it("opens a block on a first fragment whose start it missed", () => {
    const m = applyEventsToMessage(msg(), [think("mid-block")]);
    expect(m.liveThinking).toBe("mid-block");
    expect(m.liveThinkingSince).toEqual(expect.any(Number));
  });

  it("restarts on the next block's empty delta", () => {
    vi.setSystemTime(1_000);
    let m = applyEventsToMessage(msg(), [think(""), think("first")]);
    vi.setSystemTime(9_000);
    m = applyEventsToMessage(m, [think("")]);
    expect(m).toMatchObject({ liveThinking: "", liveThinkingSince: 9_000 });
  });

  it("ends when the finished block arrives, keeping only that", () => {
    const m = applyEventsToMessage(msg(), [
      think(""),
      think("plan"),
      ev("thinking", { content: "plan", durationMs: 1200 }),
    ]);
    expect(m.liveThinking).toBeUndefined();
    expect(m.liveThinkingSince).toBeUndefined();
    expect(m.events).toEqual([ev("thinking", { content: "plan", durationMs: 1200 })]);
  });

  it("ends on a delta carrying the block's duration (its text was not returned)", () => {
    const open = applyEventsToMessage(msg(), [think("")]);
    const ended = applyEventsToMessage(open, [
      ev("thinking_delta", { content: "", durationMs: 900 }),
    ]);
    expect(ended).not.toHaveProperty("liveThinking");
    expect(ended.events).toEqual([]);
  });

  it("keeps the block and its timer while a background task reports on the message", () => {
    const bg = ev("subagent_start", {
      subagent: { taskId: "bg", description: "bg", status: "running" },
    });
    vi.setSystemTime(1_000);
    let m = applyEventsToMessage(msg({ events: [bg] }), [think(""), think("First half. ")]);
    vi.setSystemTime(5_000);
    m = applyEventsToMessage(m, [
      traceSummary("bg", 1, 1),
      ev("subagent_progress", { subagent: { taskId: "bg", description: "", lastTool: "Read" } }),
      think("Second half."),
    ]);
    expect(m.liveThinking).toBe("First half. Second half.");
    expect(m.liveThinkingSince).toBe(1_000);
  });

  it("ends on text or a tool call", () => {
    const open = applyEventsToMessage(msg(), [think(""), think("hm")]);
    expect(
      applyEventsToMessage(open, [ev("text_delta", { content: "Answer" })]),
    ).not.toHaveProperty("liveThinking");
    expect(applyEventsToMessage(open, [ev("tool_use", { toolUseId: "t" })])).not.toHaveProperty(
      "liveThinking",
    );
  });

  it("follows the order of the batch", () => {
    const ended = applyEventsToMessage(msg(), [
      think(""),
      think("a"),
      ev("text_delta", { content: "b" }),
    ]);
    expect(ended.liveThinking).toBeUndefined();
    expect(ended.content).toBe("b");
    const reopened = applyEventsToMessage(msg(), [
      ev("text_delta", { content: "b" }),
      ev("tool_use", { toolUseId: "t" }),
      think(""),
      think("next"),
    ]);
    expect(reopened.liveThinking).toBe("next");
  });

  it("keeps the message identical when a batch changes nothing", () => {
    const open = applyEventsToMessage(msg(), [think("x")]);
    expect(applyEventsToMessage(open, [])).toBe(open);
  });

  it("updates and clears live message context on compaction events to match snapshots", () => {
    const estimated = applyEventsToMessage(msg({ status: "streaming" }), [
      ev("compact", {
        content: "Context compacted (threshold): 300000 → ~40000 tokens",
        context: { window: 1_048_576, tokens: 40_000, estimated: true },
      }),
    ]);
    expect(estimated.context).toEqual({ window: 1_048_576, tokens: 40_000, estimated: true });

    // Aborted compaction leaves existing context intact.
    const aborted = applyEventsToMessage(estimated, [
      ev("compact", { content: "Compaction aborted (manual)" }),
    ]);
    expect(aborted.context).toEqual({ window: 1_048_576, tokens: 40_000, estimated: true });

    // Successful compaction without an estimate clears stale context immediately.
    const cleared = applyEventsToMessage(aborted, [
      ev("compact", { content: "Context compacted (overflow): 42000 tokens", context: null }),
    ]);
    expect(cleared.context).toBeNull();
  });
});
