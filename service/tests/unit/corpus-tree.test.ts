import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LfJsonLineDecoder, PiRpcFrameError } from "../../src/session/pi-rpc";
import {
  decodeChildTranscriptArtifact,
  decodePiSessionV3Tree,
  decodeSubagentNotifyWire,
} from "../../src/session/pi-subagents";
import { HistoryDb } from "../../src/workspace/history-db";
import { HistoryIndex } from "../../src/workspace/history-index";
import { summarizeMessages } from "../../src/workspace/summary";
import type { StreamEvent } from "../../src/session/types";
import type { Message } from "../../src/workspace/workspace";
import { assertSyntheticCorpusClean } from "../corpus/synthetic/assert-clean";

const CORPUS = path.resolve(__dirname, "../corpus/synthetic");
const SESSION_FILES = [
  "branching-compacted.jsonl",
  "framing-edge-lines.jsonl",
  "subagent-siblings-tree.jsonl",
] as const;
const CORPUS_FILES = [...SESSION_FILES, "child-transcript-truncated.jsonl"] as const;
const SEARCH_MARKERS: Readonly<Record<(typeof CORPUS_FILES)[number], string>> = {
  "branching-compacted.jsonl": "active-inner-output",
  "framing-edge-lines.jsonl": "合成推理",
  "subagent-siblings-tree.jsonl": "sibling-alpha-thinking",
  "child-transcript-truncated.jsonl": "sibling-beta-thinking",
};

const temporaryDirectories: string[] = [];
afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function corpusFile(name: (typeof CORPUS_FILES)[number]): string {
  return path.join(CORPUS, name);
}

function expectedRecords(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

type ChunkStrategy = "one-byte" | "seven-byte" | "deterministic-random";

function chunkSizes(strategy: ChunkStrategy): () => number {
  if (strategy === "one-byte") return () => 1;
  if (strategy === "seven-byte") return () => 7;
  let state = 0x5a17c9e3;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return 1 + (state % 29);
  };
}

function decodeChunked(filePath: string, strategy: ChunkStrategy): unknown[] {
  const bytes = fs.readFileSync(filePath);
  const decoder = new LfJsonLineDecoder();
  const nextSize = chunkSizes(strategy);
  const records: unknown[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const end = Math.min(bytes.length, offset + nextSize());
    records.push(...decoder.push(bytes.subarray(offset, end)));
    offset = end;
  }
  // Native Session v3 accepts a final unterminated JSON record. The LF wire
  // framer deliberately does not, so supply only its required delimiter when
  // checking that every original JSON value survives arbitrary byte splits.
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) {
    records.push(...decoder.push(Buffer.from("\n")));
  }
  records.push(...decoder.end());
  return records;
}

function message(id: string, events: StreamEvent[], timestamp = 1): Message {
  return {
    id,
    kind: "agent",
    agentId: "synthetic-agent",
    content: "",
    timestamp,
    status: "done",
    events,
  };
}

function decodeArtifact(filePath: string): StreamEvent[] {
  if (path.basename(filePath).startsWith("child-transcript")) {
    return decodeChildTranscriptArtifact(filePath).events;
  }
  const decoded = decodePiSessionV3Tree(filePath);
  expect(decoded.ok).toBe(true);
  return decoded.ok ? decoded.events : [];
}

function withHistory(messages: Message[], check: (index: HistoryIndex) => void): void {
  const directory = temporaryDirectory("synthetic-corpus-history-");
  const history = new HistoryDb(path.join(directory, "history.db"));
  let index: HistoryIndex | undefined;
  try {
    history.save("synthetic-session", messages, "all");
    index = new HistoryIndex(path.join(directory, "history-index.db"), history.file);
    expect(index.sync(5_000)).toBe(true);
    check(index);
  } finally {
    index?.close();
    history.close();
  }
}

function assertSummaryShape(original: Message[], summarized: Message[]): void {
  expect(summarized).toHaveLength(original.length);
  for (const [index, summary] of summarized.entries()) {
    expect(summary.detail).toBe("summary");
    expect(summary.events).toHaveLength(original[index].events?.length ?? 0);
    for (const [eventIndex, event] of (summary.events ?? []).entries()) {
      const source = original[index].events![eventIndex];
      expect(event.kind).toBe(source.kind);
      if (["text", "thinking", "tool_result"].includes(event.kind)) {
        expect(event.content).toBe("");
        expect(event.contentLength).toBe(source.content.length);
      }
      if (event.kind === "tool_use") {
        expect(event.bodyLength).toBe(source.content.length);
        expect(event.content.length).toBeLessThanOrEqual(201);
      }
    }
  }
}

describe("Synthetic Pi corpus privacy", () => {
  it("accepts only the checked-in public-constant corpus", () => {
    expect(
      fs
        .readdirSync(CORPUS)
        .filter((name) => name.endsWith(".jsonl"))
        .sort(),
    ).toEqual([...CORPUS_FILES].sort());
    for (const name of CORPUS_FILES) assertSyntheticCorpusClean(corpusFile(name));
  });

  it.each([
    [
      "unknown top-level field",
      [{ type: "session", version: 3, id: "clean", extra: true }],
      "unknown field",
    ],
    [
      "unknown nested field",
      [
        { type: "session", version: 3, id: "clean" },
        {
          type: "message",
          id: "leaf",
          parentId: null,
          message: { role: "assistant", content: [{ type: "text", text: "clean", extra: true }] },
        },
      ],
      "unknown field",
    ],
    [
      "image field",
      [{ type: "session", version: 3, id: "clean", image: "not-allowed" }],
      "image or attachment",
    ],
    [
      "Base64 payload",
      [
        {
          type: "session",
          version: 3,
          id: "clean",
          timestamp: 0,
          data: "data:text/plain;base64,QUJD",
        },
      ],
      "Base64",
    ],
    ["host path", [{ type: "session", version: 3, id: "/Users/example/private" }], "host path"],
    [
      "access token",
      [{ type: "session", version: 3, id: "ghp_syntheticinvalid" }],
      "token pattern",
    ],
    ["public domain", [{ type: "session", version: 3, id: "example.com" }], "public domain"],
    ["public IP", [{ type: "session", version: 3, id: "203.0.113.9" }], "IP address"],
    ["email address", [{ type: "session", version: 3, id: "person@example.com" }], "email address"],
  ])("privacy/schema sentinel rejects %s", (_name, records, reason) => {
    const directory = temporaryDirectory("synthetic-corpus-sentinel-");
    const filePath = path.join(directory, "violation.jsonl");
    fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    expect(() => assertSyntheticCorpusClean(filePath)).toThrow(reason);
  });

  it.each(CORPUS_FILES)("LF-framing restores %s across 1/7/random byte splits", (name) => {
    for (const strategy of ["one-byte", "seven-byte", "deterministic-random"] as const) {
      expect(decodeChunked(corpusFile(name), strategy)).toEqual(expectedRecords(corpusFile(name)));
    }
  });

  it("keeps U+2028/U+2029 inside JSON, handles CRLF, and preserves the strict EOF boundary", () => {
    const bytes = fs.readFileSync(corpusFile("framing-edge-lines.jsonl"));
    expect(bytes[bytes.length - 1]).not.toBe(0x0a);
    expect(bytes.includes(Buffer.from("\r\n"))).toBe(true);
    expect(bytes.includes(Buffer.from("\u2028"))).toBe(true);
    expect(bytes.includes(Buffer.from("\u2029"))).toBe(true);

    const decoder = new LfJsonLineDecoder();
    decoder.push(bytes);
    expect(() => decoder.end()).toThrowError(
      expect.objectContaining<Partial<PiRpcFrameError>>({ code: "incomplete_tail_frame" }),
    );
  });

  it.each(CORPUS_FILES)("runs the complete offline history pipeline for %s", (name) => {
    expect(decodeChunked(corpusFile(name), "deterministic-random")).toEqual(
      expectedRecords(corpusFile(name)),
    );
    const events = decodeArtifact(corpusFile(name));
    expect(events.length).toBeGreaterThan(0);
    const original = [message(`message-${name}`, events)];
    withHistory(original, (index) => {
      const result = index.search({ terms: [SEARCH_MARKERS[name]], limit: 20 });
      expect(result.pending).toBe(0);
      expect(result.hits.length).toBeGreaterThan(0);
      const version = new DatabaseSync(index.file, { readOnly: true });
      try {
        expect(version.prepare("pragma user_version").get()).toEqual({ user_version: 5 });
      } finally {
        version.close();
      }
      assertSummaryShape(original, summarizeMessages(original));
    });
  });

  it("projects only the active branch through compaction and summarizes long error output", () => {
    const decoded = decodePiSessionV3Tree(corpusFile("branching-compacted.jsonl"));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.events.map((event) => event.kind)).toEqual([
      "thinking",
      "text",
      "tool_use",
      "thinking",
      "text",
      "tool_use",
    ]);
    expect(decoded.events.map((event) => event.content)).toContain("active-branch-start");
    expect(decoded.events.map((event) => event.content)).toContain("active-after-compaction");
    expect(JSON.stringify(decoded.events)).not.toContain("inactive-branch");
    expect(JSON.stringify(decoded.events)).not.toContain("must-not-leak");

    const call = decoded.events[2];
    expect(call).toMatchObject({ toolUseId: "call-active", toolResultIsError: true });
    expect(call.toolResult).toContain("active-inner-output");
    expect(call.toolResult!.length).toBeGreaterThan(1_000);
    expect(decoded.events[5]).toMatchObject({
      toolUseId: "call-after",
      toolResult: "active-command-output",
    });
    const summarized = summarizeMessages([message("branching", decoded.events)]);
    expect(summarized[0].events![2]).toMatchObject({
      kind: "tool_use",
      toolResultIsError: true,
      resultLength: call.toolResult!.length,
    });
    expect(summarized[0].events![2]).not.toHaveProperty("toolResult");
  });

  it("decodes notify, Session v3, and truncated child protocols with exact sibling ownership", () => {
    const records = expectedRecords(corpusFile("subagent-siblings-tree.jsonl")) as Array<
      Record<string, unknown>
    >;
    // Native tree entries stay in decodePiSessionV3Tree and are never passed
    // to the RPC wire reducer. Only this explicitly adapted notification is wire input.
    const custom = records.find((record) => record.type === "custom")!;
    const runs = decodeSubagentNotifyWire({
      role: "custom",
      customType: custom.customType,
      details: custom.data,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].children.map((child) => child.canonicalChildId)).toEqual([
      "sibling-alpha",
      "sibling-beta",
    ]);

    const alpha = decodePiSessionV3Tree(corpusFile("subagent-siblings-tree.jsonl"));
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) return;
    const betaMeta = runs[0].children[1];
    const { events: beta } = decodeChildTranscriptArtifact(
      corpusFile("child-transcript-truncated.jsonl"),
      undefined,
      betaMeta,
    );
    expect(beta.filter((event) => event.kind === "tool_use")).toEqual([
      expect.objectContaining({
        isError: true,
        toolResult: "sibling-beta-output-v8n2\ninner beta output",
        toolResultIsError: true,
      }),
    ]);
    expect(beta.some((event) => event.kind === "tool_result")).toBe(false);
    const notices = beta.filter((event) => event.kind === "notice");
    expect(notices.length).toBeGreaterThanOrEqual(3);
    expect(notices.map((event) => event.content).join("\n")).toContain(
      "synthetic child gap notice",
    );
    expect(notices.every((event) => event.level === "warning")).toBe(true);

    const original = [
      message("siblings", [
        {
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "call-siblings:0",
            description: "synthetic sibling alpha",
            events: alpha.events,
          },
        },
        {
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "call-siblings:1",
            description: "synthetic sibling beta",
            events: beta,
          },
        },
      ]),
    ];
    withHistory(original, (index) => {
      for (const [marker, kind, taskId] of [
        ["sibling-alpha-parameter-q7v9", "tool_call", "call-siblings:0"],
        ["sibling-alpha-output-z4k8", "tool_output", "call-siblings:0"],
        ["sibling-beta-parameter-p3m6", "tool_call", "call-siblings:1"],
        ["sibling-beta-output-v8n2", "tool_output", "call-siblings:1"],
      ] as const) {
        const hits = index.search({ terms: [marker], depth: "subagents", limit: 20 }).hits;
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ kind, depth: 1, subagentTaskId: taskId });
        if (kind === "tool_call") {
          expect(hits[0].lines.map((line) => line.n)).toEqual([1]);
          expect(hits[0].lines[0].text).toContain(`in corpus/${marker}`);
        }
      }
      expect(
        index.search({
          terms: ["inner beta output"],
          subagentTaskId: "call-siblings:1",
          limit: 20,
        }).hits,
      ).toHaveLength(1);
      assertSummaryShape(original, summarizeMessages(original));
    });
  });
});

interface TrackAFailure {
  file: number;
  line: number;
  bytes: number;
  type: string;
}

interface TrackAResult {
  filesSeen: number;
  failures: TrackAFailure[];
}

function listTrackAFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(item);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(item);
    }
  };
  walk(root);
  return files;
}

function trackAFrames(bytes: Buffer, onLine: (completed: number) => void): number {
  const decoder = new LfJsonLineDecoder();
  let offset = 0;
  let completed = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline + 1;
    decoder.push(bytes.subarray(offset, end));
    if (newline !== -1) {
      completed += 1;
      onLine(completed);
    }
    offset = end;
  }
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) {
    decoder.push(Buffer.from("\n"));
    completed += 1;
    onLine(completed);
  }
  decoder.end();
  return completed;
}

function formatTrackAFailures(failures: readonly TrackAFailure[]): string {
  return failures
    .map(
      (failure) =>
        `file #${failure.file}, line ${failure.line}, bytes ${failure.bytes}, error ${failure.type}`,
    )
    .join("\n");
}

function runTrackA(root: string, limit?: number): TrackAResult {
  let files: string[];
  try {
    files = listTrackAFiles(root);
  } catch {
    return { filesSeen: 0, failures: [{ file: 0, line: 0, bytes: 0, type: "scan_error" }] };
  }
  if (limit !== undefined) files = files.slice(0, limit);
  const failures: TrackAFailure[] = [];
  if (!files.length) return { filesSeen: 0, failures };

  const directory = temporaryDirectory("local-corpus-history-");
  const history = new HistoryDb(path.join(directory, "history.db"));
  const index = new HistoryIndex(path.join(directory, "history-index.db"), history.file);
  try {
    for (const [fileIndex, filePath] of files.entries()) {
      const anonymousFile = fileIndex + 1;
      let bytes = Buffer.alloc(0);
      let completedLines = 0;
      try {
        bytes = fs.readFileSync(filePath);
        try {
          trackAFrames(bytes, (completed) => {
            completedLines = completed;
          });
        } catch (error) {
          failures.push({
            file: anonymousFile,
            line: Math.max(1, completedLines + 1),
            bytes: bytes.length,
            type: error instanceof PiRpcFrameError ? error.code : "frame_error",
          });
          continue;
        }
        const decoded = decodePiSessionV3Tree(filePath);
        if (!decoded.ok) {
          failures.push({
            file: anonymousFile,
            line: 1,
            bytes: bytes.length,
            type: decoded.reason,
          });
          continue;
        }
        const session = `track-a-${anonymousFile}`;
        const original = [message("message", decoded.events)];
        history.save(session, original, "all");
        if (!index.sync(5_000)) throw new Error("index budget exhausted");
        index.search({ terms: [], sessions: [session], limit: 1 });
        const summarized = summarizeMessages(original);
        if (summarized.length !== 1 || summarized[0].detail !== "summary") {
          throw new Error("invalid summary");
        }
      } catch {
        failures.push({
          file: anonymousFile,
          line: Math.max(1, completedLines),
          bytes: bytes.length,
          type: "offline_pipeline_error",
        });
      }
    }
  } finally {
    index.close();
    history.close();
  }
  return { filesSeen: files.length, failures };
}

describe("Local Pi corpus scanner self-test", () => {
  it("honors recursive scanning and limits without exposing paths or bodies in errors", () => {
    const directory = temporaryDirectory("local-corpus-scanner-");
    fs.mkdirSync(path.join(directory, "nested"));
    fs.copyFileSync(
      corpusFile("branching-compacted.jsonl"),
      path.join(directory, "nested", "01-valid.jsonl"),
    );
    const privateBody = "track-a-private-body-marker";
    const invalid = `{"type":"session","version":3,"id":"${privateBody}"}\n{not-json}\n`;
    fs.writeFileSync(path.join(directory, "zz-invalid.jsonl"), invalid);
    fs.writeFileSync(path.join(directory, "ignored.txt"), privateBody);

    const limited = runTrackA(directory, 1);
    expect(limited).toEqual({ filesSeen: 1, failures: [] });
    const result = runTrackA(directory);
    expect(result.filesSeen).toBe(2);
    expect(result.failures).toEqual([
      { file: 2, line: 2, bytes: Buffer.byteLength(invalid), type: "invalid_json" },
    ]);
    const report = formatTrackAFailures(result.failures);
    expect(report).toBe(`file #2, line 2, bytes ${Buffer.byteLength(invalid)}, error invalid_json`);
    expect(report).not.toContain(directory);
    expect(report).not.toContain("zz-invalid.jsonl");
    expect(report).not.toContain(privateBody);
    expect(JSON.stringify(result.failures)).not.toContain(privateBody);
  });
});

describe.skipIf(!process.env.PI_CORPUS_DIR)("Local Pi corpus (opt-in via PI_CORPUS_DIR)", () => {
  it("runs local Session v3 files with anonymous-only failure reporting", () => {
    const parsedLimit = Number(process.env.PI_CORPUS_LIMIT);
    const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
    const result = runTrackA(process.env.PI_CORPUS_DIR!, limit);
    if (result.failures.length) console.error(formatTrackAFailures(result.failures));
    expect(result.failures).toEqual([]);
    expect(result.filesSeen).toBeGreaterThan(0);
  });
});
