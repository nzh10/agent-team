import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { replayWithUsage as fixture } from "./usage-replay";
import type { RpcMessage } from "../../src/session/codex-rpc";
import { queryUsage } from "../usage-fixtures";
import { recordUsage } from "../../src/usage/ledger";
import type { readRecording } from "./harness";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function tokenFrameIndices(rec: ReturnType<typeof readRecording>) {
  return rec.entries.flatMap((entry, index) =>
    "frame" in entry && (entry.frame as RpcMessage).method === "thread/tokenUsage/updated"
      ? [index]
      : [],
  );
}

it("records only Pi terminal assistant responses, with catalog price and tool identities", async () => {
  const { usage, journey, result } = await fixture("pi", "tools-bash-edit");
  const sessionId = result.sessions[0].sessionId;
  expect(sessionId).toBeTruthy();
  expect(usage).toHaveLength(5);
  expect(new Set(usage.map((row) => row.id)).size).toBe(5);
  expect(usage.map((row) => row.toolCalls?.[0]?.name)).toEqual([
    "bash",
    "read",
    "edit",
    "grep",
    undefined,
  ]);
  expect(usage[2]).toMatchObject({
    id: JSON.stringify(["pi", sessionId, "openai-codex", "id-6"]),
    source: "pi",
    workspaceId: "ws",
    sessionId,
    unit: "inference",
    model: "gpt-6.2-astra",
    channel: "openai-codex",
    timestamp: 1795479443861,
    input: 147,
    cacheRead: 1280,
    cacheWrite: 0,
    output: 37,
    price: { kind: "api-equivalent", usd: 0.0031680000000000007 },
    toolCalls: [{ id: "id-5", name: "edit" }],
  });
  expect(usage.every((row) => row.turnId === undefined)).toBe(true);
  expect(journey).toEqual([]);
});

it("defaults Pi's absent cost source marker to the model catalog", async () => {
  const { usage } = await fixture("pi", "basic-turn");
  expect(usage).toHaveLength(1);
  expect(usage[0].price).toEqual({ kind: "api-equivalent", usd: 0.004776 });
});

it("skips Pi's ACP projection and compaction/retry events without native identity", async () => {
  const acp = await fixture("pi", "antigravity-acp-turn");
  expect(acp.usage).toEqual([]);
  expect(acp.journey).toEqual([]);
  const retry = await fixture("pi", "compaction-and-retry");
  expect(retry.usage).toHaveLength(1);
  expect(retry.journey).toEqual([]);
  const piE2e = await fixture("pi", "crash-and-restore");
  expect(piE2e.usage).toEqual([]);
});

it("records each native Codex thread's last sample once, only after native ownership proof", async () => {
  const { usage, journey, result } = await fixture("codex", "tools", (rec) => {
    const indices = tokenFrameIndices(rec);
    // Repeat a recorded root update and deliver a recorded child update before its ownership proof.
    rec.entries.splice(indices[0] + 1, 0, rec.entries[indices[0]], rec.entries[indices[4]]);
  });
  const root = result.sessions[0].sessionId;
  const parent = usage.filter((row) => row.sessionId === root);
  const child = usage.filter((row) => row.sessionId !== root);
  expect(parent).toHaveLength(9);
  expect(child).toHaveLength(6);
  expect(new Set(usage.map((row) => row.workspaceId))).toEqual(new Set(["ws"]));
  expect(new Set(journey.map((row) => row.workspaceId))).toEqual(new Set(["ws"]));
  const timestamps = usage.map((row) => row.timestamp);
  expect(timestamps).toEqual([...timestamps].sort((a, b) => (a ?? 0) - (b ?? 0)));
  expect(parent[1]).toMatchObject({
    source: "codex",
    unit: "inference",
    model: "gpt-6-astra",
    channel: "openai_https",
    timestamp: 1793621250946,
    input: 210,
    cacheRead: 14848,
    cacheWrite: 0,
    output: 24,
    price: { kind: "unpriced", usd: null },
  });
  expect(child[0]).toMatchObject({
    sessionId: "01a19c28-846b-7ad0-a7f4-e25b752f34b5",
    model: null,
    input: 6989,
    output: 30,
  });
  expect(journey.filter((row) => row.name === "panel.lookup_code")).toEqual([
    expect.objectContaining({
      kind: "tool",
      sessionId: root,
      turnId: parent[0].turnId,
      timestamp: 1793621246855,
    }),
  ]);
});

it("keeps stable Codex usage identity across restore and records compaction only as a journey event", async () => {
  const { usage, journey, result } = await fixture("codex", "resume", (rec) => {
    const indices = tokenFrameIndices(rec);
    // Redeliver the first inference after replay's workspace has rebuilt the session.
    rec.entries.splice(indices[1], 0, rec.entries[indices[0]]);
  });
  expect(result.sessions).toHaveLength(2);
  expect(usage).toHaveLength(4);
  expect(usage[0]).toEqual(usage[1]);
  const baseDir = mkdtempSync(join(tmpdir(), "yaat-codex-usage-"));
  try {
    for (const row of usage) recordUsage(baseDir, row);
    expect(queryUsage(baseDir)).toEqual([usage[0], usage[2], usage[3]]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
  expect(usage[2]).toMatchObject({ input: 2079, cacheRead: 51200, output: 18 });
  expect(journey.filter((row) => row.kind === "compaction")).toEqual([
    {
      id: JSON.stringify([
        "codex",
        usage[0].sessionId,
        "01a19c3c-2f4f-72f3-8c12-14c490e1c13e",
        "01a19c3c-3390-7753-a608-85417eb8a7b6",
      ]),
      source: "codex",
      workspaceId: "ws",
      sessionId: usage[0].sessionId,
      turnId: "01a19c3c-2f4f-72f3-8c12-14c490e1c13e",
      timestamp: 1793622558406,
      kind: "compaction",
      name: "contextCompaction",
    },
  ]);
});
