import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { replayWithUsage } from "./usage-replay";
import { CodexSession } from "../../src/session/codex";
type RecordedNotification = { method: string; params: Record<string, unknown> };
import { readLifecycle } from "../../src/usage/lifecycle";
import { readRecording, recordingPath, type Backend } from "./harness";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

async function fixture(
  backend: Backend,
  name: string,
  modify?: (recording: ReturnType<typeof readRecording>) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "yaat-lifecycle-"));
  try {
    expect(readLifecycle(dir, "ws")).toEqual([]);
    const replayed = await replayWithUsage(backend, name, modify, dir);
    const rows = readLifecycle(dir, "ws");
    expect(readLifecycle(dir, "unrelated-workspace")).toEqual([]);
    expect(rows.map(({ at }) => at)).toEqual(rows.map(({ at }) => at).sort((a, b) => a - b));
    return { rows, ...replayed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("correlates Pi tools-bash-edit across the user read, each response, and each tool execution", async () => {
  const { rows, usage, result, rec } = await fixture("pi", "tools-bash-edit");
  const model = rows.filter((row) => row.kind === "model");
  expect(model.map(({ marker }) => marker)).toEqual(
    Array.from({ length: 5 }, () => ["stepStart", "firstDelta", "stepEnd"]).flat(),
  );
  expect(new Set(rows.map(({ turnId }) => turnId)).size).toBe(1);
  expect(
    rows.every(
      ({ source, sessionId }) => source === "pi" && sessionId === result.sessions[0].sessionId,
    ),
  ).toBe(true);
  expect(rows.filter(({ kind }) => kind === "user")).toEqual([
    expect.objectContaining({ marker: "stepEnd", trigger: "user" }),
  ]);
  for (let index = 0; index < usage.length; index++) {
    const [start, first, end] = model.slice(index * 3, index * 3 + 3);
    expect(start.trigger).toBe(index === 0 ? "user" : "continuation");
    expect(first.stepId).toBe(start.stepId);
    expect(end).toMatchObject({
      stepId: start.stepId,
      inferenceId: usage[index].id,
      promptTokens: usage[index].input + usage[index].cacheRead + usage[index].cacheWrite,
    });
    const call = usage[index].toolCalls?.[0];
    if (call) {
      expect(
        rows.filter(({ toolCallId }) => toolCallId === call.id).map(({ marker }) => marker),
      ).toEqual(["toolStart", "toolResult"]);
    }
  }
  expect(JSON.stringify(rows)).not.toContain("fixture.ts");
  expect(rows[0].at).toBe(Date.parse(rec.header.recordedAt) - rec.entries.at(-1)!.t + 289);
});

it("measures ACP's streamed Pi projection without assigning it synthetic inference identity or prompt counts", async () => {
  const { rows } = await fixture("pi", "antigravity-acp-turn");
  expect(rows.filter(({ kind }) => kind === "model").map(({ marker }) => marker)).toEqual([
    "stepStart",
    "firstDelta",
    "stepEnd",
    "stepStart",
    "firstDelta",
    "stepEnd",
  ]);
  expect(
    rows
      .filter(({ kind, marker }) => kind === "model" && marker === "stepEnd")
      .map(({ model }) => model),
  ).toEqual(["gemini-4-neon", "gemini-4-neon"]);
  expect(
    rows.some(
      ({ inferenceId, promptTokens, kind }) =>
        inferenceId || promptTokens !== undefined || kind === "compaction",
    ),
  ).toBe(false);
});

it("keeps Pi's compaction and evidenced retry in the original input turn", async () => {
  const { rows } = await fixture("pi", "compaction-and-retry");
  expect(new Set(rows.map(({ turnId }) => turnId)).size).toBe(1);
  expect(rows.filter(({ kind }) => kind === "compaction")).toEqual([
    expect.objectContaining({ marker: "compaction" }),
  ]);
  expect(
    rows
      .filter(({ kind, marker }) => kind === "model" && marker === "stepStart")
      .map(({ trigger }) => trigger),
  ).toEqual(["user", "retry"]);
});

it("records Codex usage and joins native journey items by source, thread, turn and step ID", async () => {
  const { rows, journey, usage } = await fixture("codex", "resume");
  const inferred = rows.filter(({ inferenceId }) => inferenceId);
  expect(inferred.map(({ inferenceId }) => inferenceId)).toEqual(usage.map(({ id }) => id));
  expect(inferred.map(({ promptTokens }) => promptTokens)).toEqual(
    usage.map(({ input, cacheRead, cacheWrite }) => input + cacheRead + cacheWrite),
  );
  const projectedItems = rows.filter(
    ({ marker }) => marker === "toolStart" || marker === "compaction",
  );
  expect(projectedItems.some(({ marker }) => marker === "compaction")).toBe(true);
  expect(
    projectedItems.map(({ source, sessionId, turnId, stepId }) =>
      JSON.stringify([source, sessionId, turnId, stepId]),
    ),
  ).toEqual(journey.map(({ id }) => id));
});

it("does not record a read on steer acknowledgement; late Codex results keep their original turn", async () => {
  const { rows } = await fixture("codex", "steer-interrupt");
  const input = rows.filter(({ kind }) => kind === "user");
  expect(input.map(({ trigger }) => trigger)).toEqual(["user", "user"]);
  expect(input[0].turnId).not.toBe(input[1].turnId);
  const lateCommand = rows.filter(({ toolCallId }) => toolCallId?.endsWith("yKqd6L"));
  expect(lateCommand.map(({ marker }) => marker)).toEqual(["toolStart", "toolResult"]);
  expect(lateCommand[1].at).toBeGreaterThan(input[1].at);
  expect(lateCommand[1].turnId).toBe(input[0].turnId);
});

it("records a tagged Codex steer in the original turn, then one first delta for the response", async () => {
  const { rows, rec } = await fixture("codex", "steer");
  const input = rows.filter(({ kind }) => kind === "user");
  expect(input.map(({ trigger }) => trigger)).toEqual(["user", "user"]);
  expect(input[0].turnId).toBe(input[1].turnId);
  const start = Date.parse(rec.header.recordedAt) - rec.entries.at(-1)!.t;
  expect(input[1].at).toBe(start + 18036);
  const firstDeltas = rows.filter(({ marker }) => marker === "firstDelta");
  expect(firstDeltas).toEqual([expect.objectContaining({ at: start + 23464 })]);
  expect(
    rows.filter(({ stepId }) => stepId === firstDeltas[0].stepId).map(({ marker }) => marker),
  ).toEqual(["stepStart", "firstDelta", "stepEnd"]);
});

it("short-circuits Codex's repeated text deltas before lifecycle checks and clock reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "yaat-lifecycle-delta-"));
  const frames = readRecording(recordingPath("codex", "steer")).entries.flatMap((entry) =>
    "frame" in entry ? [entry.frame as RecordedNotification] : [],
  );
  const turn = frames.find(({ method }) => method === "turn/started")!;
  const deltas = frames.filter(({ method }) => method === "item/agentMessage/delta");
  const first = deltas[0];
  const itemId = first.params.itemId as string;
  const item = frames.find(
    ({ method, params }) =>
      method === "item/started" && (params?.item as { id?: string })?.id === itemId,
  )!;
  const session = new CodexSession({ cwd: dir, dataDir: dir, workspaceId: "ws" });
  session.sessionId = turn.params.threadId as string;
  const recorder = session as unknown as {
    onNotification(method: string, params: Record<string, unknown>): void;
    noteLifecycleDelta(): void;
  };
  const receive = (frame: RecordedNotification) =>
    recorder.onNotification(frame.method, frame.params);
  const check = vi.spyOn(recorder, "noteLifecycleDelta");
  const clock = vi.spyOn(Date, "now");
  try {
    receive(turn);
    receive(item);
    clock.mockClear();
    receive(first);
    expect(check).toHaveBeenCalledTimes(1);
    expect(clock).toHaveBeenCalledTimes(1);
    clock.mockClear();
    for (const delta of deltas.slice(1)) receive(delta);
    expect(check).toHaveBeenCalledTimes(1);
    expect(clock).not.toHaveBeenCalled();
    expect(readLifecycle(dir, "ws").map(({ marker }) => marker)).toEqual([
      "stepStart",
      "firstDelta",
    ]);
  } finally {
    check.mockRestore();
    clock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("correlates Codex tools child usage only to that child's two native turns", async () => {
  const { rows, usage, result } = await fixture("codex", "tools");
  const rootId = result.sessions[0].sessionId;
  const samples = usage.filter(({ sessionId }) => sessionId !== rootId);
  expect(samples).toHaveLength(6);
  const childId = samples[0].sessionId;
  expect(childId).toBe("01a19c28-846b-7ad0-a7f4-e25b752f34b5");
  const children = rows.filter(({ sessionId }) => sessionId === childId);
  const root = rows.filter(({ sessionId }) => sessionId === rootId);
  const turnIds = [...new Set(samples.map(({ turnId }) => turnId))];
  expect(turnIds).toHaveLength(2);
  expect(new Set(children.map(({ turnId }) => turnId))).toEqual(new Set(turnIds));
  expect(root.every(({ turnId }) => !turnIds.includes(turnId))).toBe(true);
  expect(
    children.filter(({ inferenceId }) => inferenceId).map(({ inferenceId }) => inferenceId),
  ).toEqual(samples.map(({ id }) => id));
  for (const turnId of turnIds) {
    const turn = children.filter((row) => row.turnId === turnId);
    const observations = samples.filter((sample) => sample.turnId === turnId);
    expect(turn[0]).toMatchObject({
      marker: "stepEnd",
      trigger: "subagent",
      inferenceId: observations[0].id,
    });
    for (const sample of observations) {
      expect(turn.find(({ inferenceId }) => inferenceId === sample.id)).toMatchObject({
        source: "codex",
        sessionId: childId,
        turnId,
        promptTokens: sample.input + sample.cacheRead + sample.cacheWrite,
      });
    }
    const output = turn.find(({ marker }) => marker === "stepStart")!;
    const markers = turn.filter(({ stepId }) => stepId === output.stepId);
    expect(markers.map(({ marker }) => marker)).toEqual(["stepStart", "firstDelta", "stepEnd"]);
    expect(markers[2].inferenceId).toBe(observations.at(-1)?.id);
    expect(root.some(({ stepId }) => stepId === output.stepId)).toBe(false);
  }
});

it("does not close the current Codex child step with a late usage sample from its previous turn", async () => {
  const childId = "01a19c28-846b-7ad0-a7f4-e25b752f34b5";
  const { rows, usage } = await fixture("codex", "tools", (rec) => {
    const indices = rec.entries.flatMap((entry, index) => {
      const frame = "frame" in entry ? (entry.frame as RecordedNotification) : undefined;
      return frame?.method === "thread/tokenUsage/updated" && frame.params?.threadId === childId
        ? [index]
        : [];
    });
    expect(indices).toHaveLength(6);
    // Redeliver the old turn's first sample for the first time, when the newer turn already
    // has a started output step. The recorded wire frame (including its turn ID) is unchanged.
    const destination = indices.at(-1)!;
    const old = rec.entries[indices[0]];
    rec.entries.splice(destination, 0, { ...old, t: rec.entries[destination].t });
    rec.entries.splice(indices[0], 1);
  });
  const samples = usage.filter(({ sessionId }) => sessionId === childId);
  const [late, current] = samples.slice(-2);
  expect(late.turnId).not.toBe(current.turnId);
  const childRows = rows.filter(({ sessionId }) => sessionId === childId);
  expect(childRows.find(({ inferenceId }) => inferenceId === late.id)).toMatchObject({
    turnId: late.turnId,
    stepId: late.id,
    marker: "stepEnd",
  });
  const currentStep = childRows.find(
    ({ turnId, marker }) => turnId === current.turnId && marker === "stepStart",
  )!;
  expect(
    childRows.find(({ stepId, marker }) => stepId === currentStep.stepId && marker === "stepEnd")
      ?.inferenceId,
  ).toBe(current.id);
});
