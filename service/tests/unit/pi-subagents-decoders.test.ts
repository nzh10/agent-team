import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piFrames } from "../snap/pi-wire";
import {
  decodeChildTranscriptArtifact,
  decodePiSessionV3Tree,
  decodeSubagentNotifyWire,
  executeFallbackAsyncStop,
  isTrackableSubagentMode,
  makeSyntheticSubagentTaskId,
  reconstructSubagentChild,
  resolveCanonicalChildId,
  resolveStopTarget,
  SUBAGENT_MODES,
} from "../../src/session/pi-subagents";
import { extractPiToolResultText, formatPiToolUse } from "../../src/session/pi-tool-format";
import type { ActiveAsyncRunRecord, StreamEvent } from "../../src/session/types";
import {
  assistantText,
  sessionMessage,
  textBlocks,
  transcriptMessage,
  writeJsonl,
  writeStatusJson,
} from "./helpers/subagent-artifacts";

function restoredMessage(name: string) {
  const file = path.join(__dirname, "../snap/pi/messages", `${name}.jsonl`);
  const [, response] = fs.readFileSync(file, "utf8").trim().split("\n");
  const entry = JSON.parse(response) as { frame: { data: { messages: unknown[] } } };
  return entry.frame.data.messages[0];
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-decoders-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("subagent modes and canonical identities", () => {
  it("tracks all four execution modes and filters management", () => {
    expect(SUBAGENT_MODES).toEqual(["single", "parallel", "chain", "workflow"]);
    for (const mode of [...SUBAGENT_MODES, "management"]) {
      expect(isTrackableSubagentMode(mode)).toBe(mode !== "management");
    }
    expect(isTrackableSubagentMode(undefined)).toBe(false);
  });

  it("uses stable synthetic task ids and the first non-empty canonical identity", () => {
    expect(makeSyntheticSubagentTaskId("call-1", 3)).toBe("call-1:3");
    expect(
      resolveCanonicalChildId({ childId: "child", workflowKey: "workflow", runId: "run" }, 0),
    ).toBe("child");
    expect(resolveCanonicalChildId({ childId: "", workflowKey: "workflow", runId: "run" }, 1)).toBe(
      "workflow",
    );
    expect(resolveCanonicalChildId({ childId: 19, workflowKey: "", runId: "run" }, 2)).toBe("run");
    expect(resolveCanonicalChildId({ childId: "", workflowKey: "", runId: "" }, 3)).toBe("step:3");
  });
});

describe("Pi tool Markdown normalization", () => {
  it("treats null as omitted only for known optional builtin arguments", () => {
    const cases = [
      ["read", { path: "a.ts" }, ["offset", "limit"], ["path"]],
      ["write", { path: "a.ts", content: "text" }, [], ["path", "content"]],
      [
        "edit",
        { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
        ["oldText", "old_string", "newText", "new_string"],
        ["path"],
      ],
      ["bash", { command: "pwd" }, ["timeout"], ["command"]],
      [
        "grep",
        { pattern: "a" },
        ["path", "file_path", "glob", "ignoreCase", "literal", "context", "limit"],
        ["pattern"],
      ],
      ["find", { pattern: "*.ts" }, ["path", "file_path", "limit"], ["pattern"]],
      ["ls", {}, ["path", "file_path", "limit"], []],
    ] as const;
    const nulls = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, null]));
    for (const [tool, args, optional, required] of cases) {
      expect(formatPiToolUse(tool, { ...args, ...nulls(optional) }), tool).toEqual(
        formatPiToolUse(tool, args),
      );
      const invalid = nulls([...required, "extra"]);
      expect(
        formatPiToolUse(tool, { ...args, ...nulls(optional), ...invalid }).content,
        tool,
      ).toContain(`\n\`\`\`json\n${JSON.stringify(invalid, null, 2)}\n\`\`\``);
    }
  });

  it.each([
    ["openai-read", ""], // Explicit nulls, not omitted keys.
    ["gemini-read", " · offset 1 · limit 120"],
    ["kimi-read", " · offset 500 · limit 165"],
  ])("formats the actual %s call in one line", (name, suffix) => {
    const {
      content: [call],
    } = restoredMessage(name) as {
      content: { name: string; arguments: Record<string, unknown> }[];
    };
    expect(formatPiToolUse(call.name, call.arguments)).toEqual({
      toolName: "read",
      toolSource: "builtin",
      content: `**Read** \`fixture.ts\`${suffix}`,
      toolInput: { tool: "Read", file_path: "fixture.ts" },
    });
  });

  it("keeps one-sided and zero Read bounds", () => {
    const {
      content: [{ arguments: args }],
    } = restoredMessage("openai-read") as { content: { arguments: Record<string, unknown> }[] };
    for (const [bounds, suffix] of [
      [{ offset: 4 }, " · offset 4"],
      [{ limit: 0 }, " · limit 0"],
    ] as const)
      expect(formatPiToolUse("read", { ...args, ...bounds }).content).toBe(
        `**Read** \`fixture.ts\`${suffix}`,
      );
  });

  it("formats Write content and extra arguments without losing either", () => {
    const result = formatPiToolUse("write", {
      file_path: "notes.md",
      content: "# Hello",
      expectedVersion: 2,
    });
    expect(result.content.split("\n")[0]).toBe("**Write** `notes.md`");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain('"expectedVersion": 2');
    expect(result.toolInput).toEqual({ tool: "Write", file_path: "notes.md" });
  });

  it("formats the current Edit schema and keeps only unknown arguments in JSON", () => {
    const result = formatPiToolUse("edit", {
      path: "a.ts",
      edits: [{ oldText: "first\nsecond", newText: "replaced" }],
      extra: true,
    });
    expect(result.content).toBe(
      '**Edit** `a.ts`\n```diff\n- first\n- second\n+ replaced\n```\n```json\n{\n  "extra": true\n}\n```',
    );
    expect(result.toolInput).toEqual({
      tool: "Edit",
      file_path: "a.ts",
      old_string: "first\nsecond",
      new_string: "replaced",
    });
  });

  it("shows multiple Edit replacements in order without inventing file line numbers", () => {
    const result = formatPiToolUse("edit", {
      path: "a.ts",
      edits: [{ oldText: "remove", newText: "" }, null, { oldText: "", newText: "insert" }],
    });
    expect(result.content).toBe(
      "**Edit** `a.ts` · 1 invalid replacement\n```diff\n- remove\n\n+ insert\n```",
    );
    expect(result.toolInput).toEqual({ tool: "Edit", file_path: "a.ts" });
  });

  it("distinguishes absent and malformed Edit replacements without dumping them", () => {
    const { path } = piFrames("tools-bash-edit").find(
      (f) => f.type === "tool_execution_start" && f.toolName === "edit",
    )!.args as { path: string };
    for (const [options, count] of [
      [{}, 0],
      [{ edits: [] }, 0],
      [{ edits: [null, { oldText: "a" }, { newText: 1 }] }, 3],
      [{ edits: "?" }, 1],
      [{ old_string: "before" }, 1],
      [{ old_string: null, new_string: null }, 1],
    ] as const) {
      expect(formatPiToolUse("edit", { path, ...options })).toMatchObject({
        content: `**Edit** \`${path}\`${count ? ` · ${count} invalid replacement${count === 1 ? "" : "s"}` : ""}`,
        toolInput: { tool: "Edit", file_path: path },
      });
    }
  });

  it.each([
    { oldText: "a", newText: "b" },
    '[{"oldText":"a","newText":"b"}]',
    '{"oldText":"a","newText":"b"}',
  ])("recognizes an Edit argument that Pi normalizes before execution: %j", (edits) => {
    const result = formatPiToolUse("edit", { path: "a.ts", edits, oldText: "c", newText: "d" });
    expect(result.content).toBe("**Edit** `a.ts`\n```diff\n- a\n+ b\n\n- c\n+ d\n```");
  });

  it("preserves a legacy alias pair alongside current Edit replacements", () => {
    const result = formatPiToolUse("edit", {
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }],
      old_string: "c",
      new_string: "d",
    });
    expect(result.content).toBe("**Edit** `a.ts`\n```diff\n- a\n+ b\n\n- c\n+ d\n```");
  });

  it("normalizes older Edit key aliases independently while preserving unknown options", () => {
    const {
      path,
      edits: [pair],
    } = piFrames("tools-bash-edit").find(
      (f) => f.type === "tool_execution_start" && f.toolName === "edit",
    )!.args as { path: string; edits: { oldText: string; newText: string }[] };
    for (const [p, o, n] of [
      ["path", "oldText", "newText"],
      ["file_path", "old_string", "new_string"],
      ["file_path", "oldText", "new_string"],
    ]) {
      const result = formatPiToolUse("edit", {
        [p]: path,
        [o]: pair.oldText,
        [n]: pair.newText,
        replaceAll: true,
      });
      expect(result.toolInput).toEqual({
        tool: "Edit",
        file_path: path,
        old_string: pair.oldText,
        new_string: pair.newText,
      });
      expect(result.content).toContain(
        `**Edit** \`${path}\`\n\`\`\`diff\n- ${pair.oldText}\n+ ${pair.newText}\n\`\`\``,
      );
      expect(result.content).toContain('"replaceAll": true');
    }
  });

  it.each([
    [{}, ""],
    [{ timeout: 30 }, " timeout 30s"],
  ])("formats Bash arguments %j without a JSON block", (options, suffix) => {
    expect(formatPiToolUse("bash", { command: "npm test", ...options }).content).toBe(
      `**Bash**${suffix}\n\`\`\`bash\nnpm test\n\`\`\``,
    );
  });

  it("shows malformed ls paths and bash timeouts without claiming defaults", () => {
    expect(formatPiToolUse("ls", { path: 123, limit: null }).content).toBe(
      '**Ls**\n```json\n{\n  "path": 123\n}\n```',
    );
    expect(formatPiToolUse("bash", { command: "pwd", timeout: "4" }).content).toBe(
      '**Bash**\n```bash\npwd\n```\n```json\n{\n  "timeout": "4"\n}\n```',
    );
  });

  it("formats Grep with all filters and its path on one line", () => {
    const result = formatPiToolUse("grep", {
      pattern: "needle",
      path: "src",
      glob: "**/*.ts",
      context: 2,
      ignoreCase: true,
      literal: true,
      limit: 10,
    });
    expect(result.content).toBe(
      "**Grep** `needle` in `src` · glob `**/*.ts` · ignore case · literal · context 2 · limit 10",
    );
  });

  it("formats Find with pattern, path and limit on one line", () => {
    const result = formatPiToolUse("find", { pattern: "*.ts", path: "src", limit: 50 });
    expect(result.content).toBe("**Find** `*.ts` in `src` · limit 50");
  });

  it("formats Ls with optional path and limit on one line", () => {
    expect(formatPiToolUse("ls", { path: "src", limit: 50 }).content).toBe(
      "**Ls** `src` · limit 50",
    );
    expect(formatPiToolUse("ls", { limit: 50 }).content).toBe("**Ls** `.` · limit 50");
    expect(formatPiToolUse("ls", { path: "src", hidden: true }).content).toContain(
      '"hidden": true',
    );
  });

  it("normalizes bridge-owned tools and appends arguments absent from the panel first line", () => {
    const result = formatPiToolUse(
      "start_session",
      { title: "Research", cwd: "/tmp/project", task: "Find decoders", priority: 2 },
      new Set(["start_session"]),
    );
    expect(result.toolName).toBe("mcp__panel__start_session");
    expect(result.toolSource).toBe("panel");
    expect(result.content.split("\n")[0]).toBe("**start_session** Research in `/tmp/project`");
    expect(result.content).toContain('"task": "Find decoders"');
    expect(result.content).toContain('"priority": 2');
  });

  it("formats extension and MCP arguments as complete JSON and extracts result blocks", () => {
    for (const [name, source] of [
      ["custom_tool", "extension"],
      ["mcp__docs__search", "mcp"],
    ] as const) {
      const result = formatPiToolUse(name, { query: "pi", limit: 2 });
      expect(result.toolSource).toBe(source);
      expect(result.content.split("\n")[0]).toBe(`**${name}**`);
      expect(result.content).toContain('"query": "pi"');
      expect(result.content).toContain('"limit": 2');
    }
    expect(
      extractPiToolResultText([
        { type: "text", text: "first" },
        { type: "image", data: "not-inline" },
        { type: "text", text: "last" },
      ]),
    ).toBe("first\n[image]\nlast");
  });
});

const notifyWire = (details: object) => ({
  role: "custom",
  customType: "subagent-notify",
  details,
});

describe("subagent-notify wire decoder", () => {
  it("decodes one run with complete child artifact metadata", () => {
    const runs = decodeSubagentNotifyWire(
      notifyWire({
        runId: "run-1",
        mode: "workflow",
        status: "completed",
        asyncDir: "/tmp/run-1",
        children: [
          {
            childId: "",
            workflowKey: "review",
            runId: "child-run",
            index: 2,
            transcriptPath: "/tmp/transcript.jsonl",
            sessionFile: "/tmp/session.jsonl",
            outputTruncated: true,
            transcriptError: "write failed",
            summary: "done",
            usage: { input: 3, output: 4 },
          },
        ],
      }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "run-1", mode: "workflow", status: "completed" });
    expect(runs[0].children[0]).toMatchObject({
      canonicalChildId: "review",
      stepIndex: 2,
      transcriptPath: "/tmp/transcript.jsonl",
      sessionFile: "/tmp/session.jsonl",
      outputTruncated: true,
      transcriptError: "write failed",
      summary: "done",
      usage: { input: 3, output: 4 },
    });
  });

  it("joins separated output previews by run identity rather than output position", () => {
    const [run] = decodeSubagentNotifyWire(
      notifyWire({
        runId: "root",
        childRuns: [{ runId: "a" }, { runId: "b" }],
        childOutputs: [
          { runId: "b", preview: "second" },
          { runId: "a", preview: "first" },
        ],
      }),
    );
    expect(run.children.map((c) => c.summary)).toEqual(["first", "second"]);
  });

  it("attributes siblings in the restored workflow notice by workflow key", () => {
    const [run] = decodeSubagentNotifyWire(restoredMessage("subagent-notify"));
    expect(run.children.map((c) => [c.canonicalChildId, c.stepIndex, c.status])).toEqual([
      ["id-3", 0, "completed"],
      ["id-5", 1, "completed"],
    ]);
  });

  it("decodes batches independently and rejects every other wire message", () => {
    const runs = decodeSubagentNotifyWire(
      notifyWire({
        runs: [
          { runId: "single", mode: "single", status: "completed", results: [{}] },
          { runId: "parallel", mode: "parallel", status: "stopped", childRuns: [{ runId: "b" }] },
        ],
      }),
    );
    expect(runs.map((run) => run.runId)).toEqual(["single", "parallel"]);
    expect(runs[0].children[0].canonicalChildId).toBe("step:0");
    expect(runs[1].children[0].canonicalChildId).toBe("b");
    expect(decodeSubagentNotifyWire({ role: "assistant", customType: "subagent-notify" })).toEqual(
      [],
    );
    expect(decodeSubagentNotifyWire({ role: "custom", customType: "other" })).toEqual([]);
  });
});

describe("native Pi Session v3 decoder", () => {
  it("projects the active branch in order, folding only results with earlier calls", () => {
    const directory = temporaryDirectory();
    const sessionFile = path.join(directory, "session.jsonl");
    writeJsonl(sessionFile, [
      { type: "session", version: 3, id: "session" },
      sessionMessage("root", null, assistantText("root")),
      {
        type: "thinking_level_change",
        id: "inactive",
        parentId: "root",
        thinkingLevel: "low",
      },
      {
        type: "model_change",
        id: "model",
        parentId: "root",
        provider: "requested-provider",
        modelId: "requested-id",
      },
      {
        type: "thinking_level_change",
        id: "effort",
        parentId: "model",
        thinkingLevel: "high",
      },
      sessionMessage("early-result", "effort", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: "before the call",
      }),
      sessionMessage("active", "early-result", {
        role: "assistant",
        provider: "resolved-provider",
        model: "resolved-id",
        content: [
          { type: "thinking", thinking: "consider" },
          { type: "text", text: "active branch" },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "a.ts", offset: 2 },
          },
          { type: "toolCall", name: "read", arguments: { path: "b.ts" } },
        ],
      }),
      sessionMessage("result", "active", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: textBlocks("file body"),
      }),
      sessionMessage("orphan-result", "result", {
        role: "tool_result",
        toolName: "read",
        content: "no call id",
      }),
      {
        type: "model_change",
        id: "unused-model",
        parentId: "orphan-result",
        provider: "p",
        modelId: "unused",
      },
      {
        type: "thinking_level_change",
        id: "unused-effort",
        parentId: "unused-model",
        thinkingLevel: "off",
      },
    ]);
    const decoded = decodePiSessionV3Tree(sessionFile);
    expect(decoded).toMatchObject({
      ok: true,
      model: "resolved-provider/resolved-id",
      effort: "high",
    });
    expect(decoded.events.map((event) => event.kind)).toEqual([
      "text",
      "tool_result",
      "thinking",
      "text",
      "tool_use",
      "tool_use",
      "tool_result",
    ]);
    expect(decoded.events[1]).toMatchObject({ toolUseId: "call-1", content: "before the call" });
    expect(decoded.events[4]).toMatchObject({
      toolUseId: "call-1",
      content: "**Read** `a.ts` · offset 2",
      toolInput: { tool: "Read", file_path: "a.ts" },
      toolResult: "file body",
    });
    expect(decoded.events[5]).not.toHaveProperty("toolResult");
    expect(decoded.events[6]).toEqual({
      kind: "tool_result",
      toolName: "read",
      content: "no call id",
    });
    expect(decoded.events.every((event) => event.durationMs === undefined)).toBe(true);
  });

  it("rejects non-v3 JSONL instead of trying the transcript protocol", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "artifact.jsonl");
    writeJsonl(file, [{ recordType: "message", role: "assistant", message: { content: "wrong" } }]);
    expect(decodePiSessionV3Tree(file)).toEqual({
      ok: false,
      reason: "not_session_v3",
      events: [],
    });
  });
});

describe("child transcript artifact decoder and reconstruction", () => {
  it("folds matched result records, preserves orphans, and appends truncation notices", () => {
    const directory = temporaryDirectory();
    const transcript = path.join(directory, "child.jsonl");
    writeJsonl(transcript, [
      transcriptMessage("assistant", {
        role: "assistant",
        provider: "artifact-provider",
        model: "artifact-model",
        thinkingLevel: "medium",
        content: [
          { type: "thinking", thinking: "artifact thought" },
          { type: "text", text: "artifact text" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "ignored.ts" } },
        ],
      }),
      {
        recordType: "tool_start",
        toolCallId: "call-1",
        toolName: "read",
        argsPayload: JSON.stringify({ path: "real.ts", limit: 5 }),
      },
      { recordType: "tool_end", toolCallId: "call-1", toolName: "read", isError: true },
      {
        recordType: "message",
        role: "toolResult",
        text: "result body",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: textBlocks("fallback result body"),
          isMarkdown: true,
          durationMs: 17,
        },
      },
      transcriptMessage("toolResult", {
        toolCallId: "unknown",
        toolName: "read",
        content: "unmatched call id",
      }),
      transcriptMessage("tool_result", { toolName: "read", content: "no call id" }),
      { recordType: "truncated", message: "byte limit reached" },
    ]);
    const { events, model, effort } = decodeChildTranscriptArtifact(transcript);
    expect({ model, effort }).toEqual({
      model: "artifact-provider/artifact-model",
      effort: "medium",
    });
    expect(events.map((event) => event.kind)).toEqual([
      "thinking",
      "text",
      "tool_use",
      "tool_result",
      "tool_result",
      "notice",
    ]);
    expect(events[2]).toMatchObject({
      toolUseId: "call-1",
      content: "**Read** `real.ts` · limit 5",
      toolResult: "result body",
      toolResultIsError: true,
      toolResultIsMarkdown: true,
      durationMs: 17,
    });
    expect(events[3]).toMatchObject({ toolUseId: "unknown", content: "unmatched call id" });
    expect(events[4]).toEqual({ kind: "tool_result", toolName: "read", content: "no call id" });
    expect(events[5]).toMatchObject({ level: "warning", content: "byte limit reached" });
    expect(events.filter((event) => event.durationMs != null)).toEqual([events[2]]);
  });

  it("emits warnings for missing files and metadata-reported gaps", () => {
    const directory = temporaryDirectory();
    const { events: missing } = decodeChildTranscriptArtifact(
      path.join(directory, "missing.jsonl"),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ kind: "notice", level: "warning" });
    expect(missing[0].content).toContain("missing.jsonl");

    const empty = path.join(directory, "empty.jsonl");
    fs.writeFileSync(empty, "");
    const { events: gaps } = decodeChildTranscriptArtifact(empty, undefined, {
      outputTruncated: true,
      transcriptError: "disk full",
    });
    expect(gaps).toHaveLength(2);
    expect(gaps.every((event) => event.kind === "notice" && event.level === "warning")).toBe(true);
    expect(gaps[1].content).toContain("disk full");
  });

  it("prefers a valid Session v3, falls back to transcript, then to a missing-artifact notice", () => {
    const directory = temporaryDirectory();
    const sessionFile = path.join(directory, "session.jsonl");
    const transcript = path.join(directory, "transcript.jsonl");
    writeJsonl(sessionFile, [
      { type: "session", version: 3 },
      sessionMessage("leaf", null, assistantText("from session")),
    ]);
    writeJsonl(transcript, [
      transcriptMessage("assistant", {
        role: "assistant",
        provider: "p",
        model: "artifact",
        thinkingLevel: "low",
        content: textBlocks("from transcript"),
      }),
    ]);
    expect(reconstructSubagentChild({ sessionFile, transcriptPath: transcript })).toEqual({
      events: [{ kind: "text", content: "from session" }],
      model: "p/artifact",
      effort: "low",
    });
    expect(
      reconstructSubagentChild({
        sessionFile: path.join(directory, "gone.jsonl"),
        transcriptPath: transcript,
      }).events[0].content,
    ).toBe("from transcript");
    expect(reconstructSubagentChild({}).events[0]).toMatchObject({
      kind: "notice",
      level: "warning",
    });
  });
});

function activeRun(
  asyncDir: string,
  mode: ActiveAsyncRunRecord["mode"] = "parallel",
): ActiveAsyncRunRecord {
  return {
    runId: "run-1",
    mode,
    asyncDir,
    startedAt: 1,
    ownerMessageId: "message-1",
    toolCallId: "call-1",
    children: [
      { taskId: "call-1:0", stepIndex: 0, canonicalChildId: "child-a" },
      { taskId: "call-1:1", stepIndex: 1, canonicalChildId: "child-b" },
    ],
  };
}

function writeStatus(asyncDir: string, overrides: Record<string, unknown> = {}): void {
  writeStatusJson(asyncDir, {
    runId: "run-1",
    sessionId: "owner-1",
    mode: "parallel",
    state: "running",
    steps: [
      { childId: "child-a", status: "running" },
      { childId: "child-b", status: "running" },
    ],
    ...overrides,
  });
}

function stopFixture(overrides?: Parameters<typeof writeStatus>[1]) {
  const asyncDir = temporaryDirectory();
  writeStatus(asyncDir, overrides);
  return activeRun(asyncDir);
}

async function stopWithMock(
  target: NonNullable<ReturnType<typeof resolveStopTarget>>,
  requestPath: string,
  ownsSession: Parameters<typeof executeFallbackAsyncStop>[1]["ownsSession"] = () => true,
) {
  const request = vi.fn(() => Promise.resolve(requestPath));
  const result = await executeFallbackAsyncStop(target, {
    piSubagentsRoot: "/unused",
    ownsSession,
    requestAsyncStopImpl: request,
  });
  return { result, request };
}

describe("exact-scope disconnected stop fallback", () => {
  it("stops a whole run without child targeting fields", async () => {
    const run = stopFixture();
    const target = resolveStopTarget([run], "run-1");
    expect(target).toEqual({ scope: "run", run });
    const { result, request } = await stopWithMock(
      target!,
      "/tmp/stop-request.json",
      (sessionId) => sessionId === "owner-1",
    );
    expect(result).toEqual({ ok: true, requestPath: "/tmp/stop-request.json" });
    expect(request).toHaveBeenCalledWith(run.asyncDir, { source: "panel-host-fallback" });
  });

  it("stops only the requested child with targetIndex and canonical childId", async () => {
    const run = stopFixture();
    const target = resolveStopTarget([run], "call-1:0");
    expect(target).toMatchObject({ scope: "child", child: { canonicalChildId: "child-a" } });
    const { result, request } = await stopWithMock(target!, "/tmp/child-stop.json");
    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(run.asyncDir, {
      targetIndex: 0,
      childId: "child-a",
      source: "panel-host-fallback",
    });
  });

  it("treats a single-child task id as run scope", () => {
    const run = activeRun("/tmp/unused", "single");
    expect(resolveStopTarget([run], "child-a")).toEqual({ scope: "run", run });
  });

  it.each([
    ["workflow", { mode: "workflow" }],
    ["paused", { state: "paused" }],
    ["not pending or running", { steps: [{ childId: "child-a", status: "completed" }] }],
    [
      "a non-unique targetIndex",
      {
        steps: [
          { childId: "child-a", status: "running" },
          { workflowKey: "child-a", status: "running" },
        ],
      },
    ],
  ])("rejects %s without writing any stop request", async (_label, overrides) => {
    const run = stopFixture(overrides);
    const target = resolveStopTarget([run], "call-1:0")!;
    const { result, request } = await stopWithMock(target, "/tmp/should-not-exist.json");
    expect(result).toEqual({ ok: false, error: "child_stop_unavailable_bridge_disconnected" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a closed stop inbox", async () => {
    const asyncDir = temporaryDirectory();
    writeStatus(asyncDir);
    fs.mkdirSync(path.join(asyncDir, "control"), { recursive: true });
    fs.writeFileSync(path.join(asyncDir, "control", "stop-inbox-closed.json"), "{}");
    const run = activeRun(asyncDir);
    const { result, request } = await stopWithMock(
      { scope: "run", run },
      "/tmp/should-not-exist.json",
    );
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

// Keep this import-level type check close to the decoder tests: notices must be
// valid stream events, not a parallel artifact-only event shape.
const noticeTypeCheck: StreamEvent = { kind: "notice", level: "warning", content: "gap" };
void noticeTypeCheck;
