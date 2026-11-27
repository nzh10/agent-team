// Version 5 attributes every nested history entry to its child task, so
// deep-search hits from concurrent siblings cannot be confused.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { HistoryDb } from "../../src/workspace/history-db";
import { entriesOf, HistoryIndex } from "../../src/workspace/history-index";
import { HistoryService } from "../../src/workspace/history-service";
import { formatPiToolUse } from "../../src/session/pi-tool-format";
import type { StreamEvent } from "../../src/session/types";
import { historyMessage as msg } from "./helpers/history";
import type { Message, MessageStatus } from "../../src/workspace/workspace";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-history-v5-"));
  const db = new HistoryDb(path.join(base, "history.db"));
  const history = new HistoryService(path.join(base, "history-index.db"), db.file);
  cleanups.push(
    () => history.close(),
    () => db.close(),
    () => fs.rmSync(base, { recursive: true, force: true }),
  );
  const save = (session: string, messages: Message[]) => {
    db.save(session, messages, "all");
    history.changed();
  };
  return { base, db, history, save };
}

describe("history index version 5", () => {
  it("rebuilds an existing v4 index and restores its entries from history", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-history-v4-"));
    const source = new HistoryDb(path.join(base, "history.db"));
    source.save("s", [msg("m", "version-five-source-marker")], "all");
    const indexFile = path.join(base, "history-index.db");
    const v4 = new DatabaseSync(indexFile);
    v4.exec(`
      pragma journal_mode = wal;
      create table docs (
        session text not null,
        message text not null,
        hash text not null,
        primary key (session, message)
      );
      create table entries (
        id integer primary key autoincrement,
        session text not null,
        message text not null,
        ts integer not null,
        kind text not null,
        role text,
        tool text,
        depth integer not null,
        lines integer not null,
        call integer,
        duration_ms integer,
        text text not null
      );
      create index entries_message on entries (session, message);
      create index entries_ts on entries (ts);
      create virtual table entries_fts using fts5 (
        text, content = '', contentless_delete = 1, tokenize = 'trigram'
      );
      insert into docs values ('stale', 'stale', 'stale');
      insert into entries (session, message, ts, kind, depth, lines, text)
        values ('stale', 'stale', 1, 'said', 0, 1, 'stale-v4-only-marker');
      insert into entries_fts (rowid, text) values (1, 'stale-v4-only-marker');
      pragma user_version = 4;
    `);
    v4.close();

    const index = new HistoryIndex(indexFile, source.file);
    cleanups.push(
      () => index.close(),
      () => source.close(),
      () => fs.rmSync(base, { recursive: true, force: true }),
    );
    expect(index.sync(1000)).toBe(true);
    expect(index.search({ terms: ["version-five-source-marker"], limit: 5 }).hits).toHaveLength(1);
    expect(index.search({ terms: ["stale-v4-only-marker"], limit: 5 }).hits).toHaveLength(0);

    const check = new DatabaseSync(indexFile, { readOnly: true });
    expect(check.prepare("pragma user_version").get()).toEqual({ user_version: 5 });
    expect(
      (check.prepare("pragma table_info(entries)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toContain("subagent_task_id");
    check.close();
  });

  it("attributes text, thought, calls, outputs, errors, and nested subagents to their child", () => {
    const formatted = formatPiToolUse("read", {
      path: "/tmp/child.ts",
      note: "child-argument-marker",
    });
    const events: StreamEvent[] = [
      { kind: "thinking", content: "top thought" },
      {
        kind: "tool_use",
        content: "**Bash** `pwd`",
        toolName: "bash",
        toolResult: "/tmp",
      },
      {
        kind: "subagent_start",
        content: "",
        subagent: {
          taskId: "call-outer:0",
          description: "outer child",
          events: [
            { kind: "text", content: "child text" },
            { kind: "thinking", content: "child thought" },
            {
              kind: "tool_use",
              content: formatted.content,
              toolName: formatted.toolName,
              toolUseId: "inline",
              toolResult: "child inline output",
            },
            {
              kind: "tool_use",
              content: "**Bash** `sleep 1`",
              toolName: "bash",
              toolUseId: "late",
            },
            { kind: "tool_result", content: "child late output", toolUseId: "late" },
            { kind: "error", content: "child error" },
            {
              kind: "subagent_start",
              content: "",
              subagent: {
                taskId: "call-inner:0",
                description: "inner child",
                events: [{ kind: "text", content: "inner text" }],
              },
            },
          ],
        },
      },
      { kind: "error", content: "top error" },
    ];

    const entries = entriesOf(msg("m", "top text", 1, { events }));
    expect(entries.map((entry) => [entry.kind, entry.depth, entry.subagentTaskId])).toEqual([
      ["said", 0, null],
      ["thinking", 0, null],
      ["tool_call", 0, null],
      ["tool_output", 0, null],
      ["subagent", 0, "call-outer:0"],
      ["said", 1, "call-outer:0"],
      ["thinking", 1, "call-outer:0"],
      ["tool_call", 1, "call-outer:0"],
      ["tool_output", 1, "call-outer:0"],
      ["tool_call", 1, "call-outer:0"],
      ["tool_output", 1, "call-outer:0"],
      ["error", 1, "call-outer:0"],
      ["subagent", 1, "call-inner:0"],
      ["said", 2, "call-inner:0"],
      ["error", 0, null],
    ]);
  });

  it("distinguishes sibling A from B for deep parameter and output markers", async () => {
    const { history, save } = setup();
    const paramToken = "history-param-marker-q7v9";
    const outputToken = "history-output-marker-z4k8";
    const aCall = formatPiToolUse("read", {
      path: "/tmp/shared.ts",
      note: paramToken,
    });
    const bCall = formatPiToolUse("read", {
      path: "/tmp/other.ts",
      note: "history-param-marker-q7x0",
    });
    save("s", [
      msg("dual", "parent entry", 1, {
        events: [
          {
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "call-1:0",
              description: "sibling A",
              events: [
                { kind: "text", content: "shared-child-search-marker from A" },
                {
                  kind: "tool_use",
                  content: aCall.content,
                  toolName: aCall.toolName,
                  toolUseId: "a-tool",
                  toolResult: outputToken,
                },
              ],
            },
          },
          {
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "call-1:1",
              description: "sibling B",
              events: [
                { kind: "text", content: "shared-child-search-marker from B" },
                {
                  kind: "tool_use",
                  content: bCall.content,
                  toolName: bCall.toolName,
                  toolUseId: "b-tool",
                  toolResult: "history-output-marker-z4x0",
                },
              ],
            },
          },
        ],
      }),
    ]);

    for (const [token, kind] of [
      [paramToken, "tool_call"],
      [outputToken, "tool_output"],
    ] as const) {
      const result = await history.search({ terms: [token], depth: "subagents", limit: 20 });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]).toMatchObject({
        kind,
        depth: 1,
        subagentTaskId: "call-1:0",
      });
      expect(result.hits[0].lines.some((line) => line.text.includes(token))).toBe(true);
      const readEntry = await history.read(result.hits[0].entry, 1, 100);
      expect(readEntry).toMatchObject({
        kind,
        depth: 1,
        subagentTaskId: "call-1:0",
      });
    }

    const paramHit = (await history.search({ terms: [paramToken], depth: "subagents", limit: 20 }))
      .hits[0];
    expect(paramHit.lines.some((line) => line.n > 1 && line.text.includes(paramToken))).toBe(true);
    const filtered = await history.search({
      terms: ["shared-child-search-marker"],
      depth: "subagents",
      subagentTaskId: "call-1:0",
      limit: 20,
    });
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0].lines[0].text).toContain("from A");
  });

  it("indexes terminal failures but still skips messages awaiting an outcome", async () => {
    const { history, save } = setup();
    const statuses: MessageStatus[] = [
      "streaming",
      "queued",
      "dispatching",
      "outcome_unknown",
      "error",
    ];
    save(
      "s",
      statuses.map((status, i) =>
        msg(status, `terminal-status-marker ${status}`, i + 1, { status }),
      ),
    );

    const result = await history.search({ terms: ["terminal-status-marker"], limit: 20 });
    expect(result.hits.map((hit) => hit.message)).toEqual(["error", "outcome_unknown"]);
  });
});
