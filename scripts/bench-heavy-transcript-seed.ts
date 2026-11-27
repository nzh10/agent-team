import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ObjectiveStore } from "../service/src/project/objectives";
import { ProjectStore } from "../service/src/project/store";
import type { StreamEvent } from "../service/src/session/types";
import { closeHistory, saveIndex, saveWorkspace } from "../service/src/workspace/state";
import { summarizeMessages } from "../service/src/workspace/summary";
import type { AgentState, Message } from "../service/src/workspace/workspace";

// Permute the archive size bands so the journey does not visit only small
// or only large siblings. These are aggregate quantiles, not actual rows.
function archiveCount(i: number) {
  const rank = ((i - 8) * 37) % 85;
  return rank === 0
    ? 2
    : rank < 9
      ? 1
      : rank < 24
        ? 3
        : rank < 53
          ? 4
          : rank < 61
            ? 5
            : rank < 69
              ? 7
              : rank < 77
                ? 9
                : rank < 83
                  ? 10
                  : rank === 83
                    ? 19
                    : 30;
}

export const fixtures = Array.from({ length: 93 }, (_, i) => ({
  id: `bench-ws-${i}`,
  name: i < 3 ? `Benchmark Project ${i + 1}` : `Synthetic session ${i}`,
  project: i < 3 ? i : 0,
  archived: i >= 8,
  count: [1053, 334, 17, 13, 11, 10, 9, 7][i] ?? archiveCount(i),
}));
export type Fixture = (typeof fixtures)[number];
export const messageId = (ws: Fixture, seq: number) => `${ws.id}-message-${seq}`;

const epoch = Date.UTC(2023, 0, 1);
const words =
  "agate arc azure beacon birch brass breeze circle cloud copper curve delta ember fern field flint frost gleam grove harbor iris jade lantern leaf linen meadow mica mirror moss nickel ochre orbit pebble pine prism quartz ridge river ripple shell slate spruce stone tide trace wave willow".split(
    " ",
  );
function prose(bytes: number, key: number): string {
  let n = key | 1;
  let text = "";
  while (text.length < bytes) {
    n = (Math.imul(n, 1664525) + 1013904223) | 0;
    text += `${words[(n >>> 16) % words.length]}${(n >>> 24) % 25 === 0 ? ". " : " "}`;
  }
  return text.slice(0, bytes);
}

function eventsFor(key: number, offset: number, heavy: boolean, diagram: boolean): StreamEvent[] {
  const rank = key % 100;
  const [tools, thoughts, bodyBytes] = heavy
    ? rank < 40
      ? [0, 1, 460]
      : rank < 72
        ? [2, 1, 1_350]
        : rank < 90
          ? [6, 4, 3_450]
          : rank < 97
            ? [9, 7, 4_450]
            : [18, 12, 6_400]
    : rank < 35
      ? [0, 0, 0]
      : rank < 75
        ? [16, 8, 6_000]
        : rank < 93
          ? [63, 30, 9_800]
          : [129, 68, 10_500];
  const events: StreamEvent[] = [];
  // A one-line preview and realistic-sized bodies exercise both the wire
  // summary and the on-demand detail path. These are persisted UI events,
  // not invented provider protocol frames.
  for (let i = 0; i < Math.max(tools, thoughts); i++) {
    if (i < thoughts)
      events.push({
        kind: "thinking",
        content: prose(Math.min(bodyBytes, 900), key * 149 + i),
        step: 1 + Math.floor(i / 5),
        contentOffset: offset,
      });
    if (i < tools)
      events.push({
        kind: "tool_use",
        toolName: "Read",
        content: `**Read** synthetic sample ${i}\n`,
        toolUseId: `bench-tool-${key}-${i}`,
        toolResult: prose(bodyBytes, key * 193 + i),
        step: 1 + Math.floor(i / 5),
        contentOffset: offset,
      });
  }
  if (diagram || (!heavy && rank % 3 === 0)) {
    const subagent = {
      taskId: `bench-child-${key}`,
      description: "Compare two synthetic samples",
      status: "completed" as const,
      summary: "Both synthetic samples passed.",
    };
    const toolUseId = `bench-subtool-${key}`;
    events.push(
      { kind: "subagent_start", content: "", subagent, toolUseId, contentOffset: offset },
      { kind: "subagent_done", content: "", subagent, toolUseId, contentOffset: offset },
    );
  }
  return events;
}

function messagesFor(ws: Fixture, ordinal: number): Message[] {
  const heavy = ordinal < 2;
  return Array.from({ length: ws.count }, (_, seq) => {
    const key = 157 * seq + 211 * ordinal;
    const id = messageId(ws, seq);
    const timestamp =
      epoch + (ordinal < 8 ? 10000 - ordinal * 500 : 1000 - ordinal) * 1e7 + seq * 1000;
    const base = { id, timestamp, status: "done" as const };
    if ((ws.count - 1 - seq) % 2 !== 0) {
      return {
        ...base,
        kind: "user",
        agentId: null,
        content: `Sample request ${seq}. ${prose(550, key)}`,
      };
    }
    const rank = key % 100;
    const lines = [
      `Synthetic reply ${ordinal}.${seq}`,
      "",
      prose(heavy ? (rank < 56 ? 1740 : rank < 89 ? 3980 : 5300) : rank < 65 ? 760 : 4700, key),
      "",
    ];
    const fromTail = ws.count - 1 - seq;
    const diagram = heavy && (fromTail === 4 || fromTail === 10);
    if (heavy ? rank < 7 : rank < 10) {
      lines.push(
        "| Sample | Weight | State |",
        "| --- | ---: | --- |",
        ...Array.from({ length: 8 }, (_, j) => `| **${words[j]}** | ${key + j} | stable |`),
        "",
      );
    }
    if (heavy ? rank % 17 === 3 : rank % 43 === 3) {
      lines.push(
        "```typescript",
        ...Array.from(
          { length: 12 },
          (_, j) =>
            `export const sample${j} = { id: ${key + j}, name: "${words[j]}", active: true };`,
        ),
        "```",
        "",
      );
    }
    if (heavy && (rank % 43 === 7 || fromTail === 8)) {
      lines.push(
        "$$",
        String.raw`\sum_{i=0}^{n} \frac{x_i^2 + \sqrt{y_i}}{1+z_i} = \sigma^2`,
        "$$",
        "",
      );
    }
    if (diagram) {
      lines.push(
        ...(fromTail === 4
          ? [
              "```mermaid",
              "flowchart LR",
              "  A[Quartz] --> B[Slate]",
              "  A --> C[Willow]",
              "  B --> C",
              "```",
            ]
          : [
              "```dot",
              "digraph sample { Quartz -> Slate; Quartz -> Willow; Slate -> Willow; }",
              "```",
            ]),
        "",
      );
    }
    const content = lines.join("\n");
    return {
      ...base,
      kind: "agent",
      agentId: `${ws.id}-agent`,
      content,
      events: eventsFor(key, content.length, heavy, diagram),
      ...(seq > 0 && { replyTo: messageId(ws, seq - 1) }),
      context: { tokens: 10_000 + key, window: 1_000_000 },
    };
  });
}

export function seedHeavyTranscript(base: string) {
  writeFileSync(
    join(base, "config.toml"),
    [
      "[user]",
      'name = "Benchmark"',
      'avatar = "B"',
      "[workspace]",
      "archive_after_days = 0",
      "[pi]",
      "offline = true",
      "[pi.acp.proxy]",
      "enabled = false",
      "",
    ].join("\n"),
  );
  const projects = new ProjectStore(base);
  const repos = fixtures.slice(0, 3).map((ws, i) => {
    const root = join(base, `synthetic-repo-${i + 1}`);
    mkdirSync(root);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "--quiet", "-b", "main");
    writeFileSync(join(root, "sample.txt"), "Synthetic source\n");
    git("add", "sample.txt");
    git(
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Seed synthetic file",
    );
    writeFileSync(join(root, "sample.txt"), "Synthetic source\nSynthetic change\n");
    const id = `bench-project-${i}`;
    projects.save({
      id,
      schemaVersion: 2,
      status: "active",
      root,
      name: ws.name,
      leadWorkspaceId: ws.id,
      lead: { hostId: "local", workspaceId: ws.id },
      createdAt: epoch + i,
    });
    const board = new ObjectiveStore(projects.objectivesDir(id));
    for (const j of [1, 2])
      board.write({
        id: `sample/phase-${j}`,
        area: "sample",
        title: `Synthetic objective ${j}`,
        goal: "Compare the two seeded samples.",
        status: "active",
        priority: "normal",
        dependsOn: j === 2 ? ["sample/phase-1"] : [],
        tasks: [],
        decisions: [],
        sessions: [],
        updatedAt: epoch,
      });
    return root;
  });
  const stats = {
    workspaces: fixtures.length,
    active: 8,
    messages: 0,
    storedBytes: 0,
    summaryBytes: 0,
  };
  try {
    for (const [i, ws] of fixtures.entries()) {
      const cwd = repos[ws.project];
      const messages = messagesFor(ws, i);
      const model = "gpt-6-luna";
      const agent: AgentState = {
        id: `${ws.id}-agent`,
        name: "Synthetic agent",
        model,
        avatar: "B",
        color: "#8AB4F8",
        isDefault: true,
        session: {
          sessionId: null,
          config: { cwd, backend: "codex", model },
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
      const lastActivityAt = messages.at(-1)!.timestamp;
      saveWorkspace(base, {
        id: ws.id,
        name: ws.name,
        project: `Synthetic ${ws.project + 1}`,
        hostId: "local",
        cwd,
        agents: [agent],
        messages,
        createdAt: messages[0].timestamp,
        lastActivityAt,
        archivedAt: ws.archived ? lastActivityAt + 1000 : null,
        projectLink: { projectId: `bench-project-${ws.project}`, role: i < 3 ? "lead" : "worker" },
      });
      stats.messages += messages.length;
      stats.storedBytes += Buffer.byteLength(JSON.stringify(messages));
      stats.summaryBytes += Buffer.byteLength(JSON.stringify(summarizeMessages(messages)));
    }
    saveIndex(
      base,
      fixtures.map(({ id }) => id),
    );
  } finally {
    closeHistory(base);
  }
  return stats;
}
