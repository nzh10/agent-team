import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { trackCaptureChild } from "./capture-child.ts";
import { parseJsonl, readJsonl, writeJsonl } from "./capture-io.ts";
import { REPO_ROOT } from "./script-paths.mjs";
import { summarizeCapture } from "./summarize-capture.ts";

void test("JSONL preserves rows and wire delimiters without exposing malformed input", () => {
  const dir = mkdtempSync(join(tmpdir(), "yaat-capture-tooling-"));
  try {
    const file = join(dir, "capture.jsonl");
    const records = [{ header: { backend: "pi" } }, { frame: { text: "a\nb" } }];
    writeJsonl(file, records, { flag: "wx", mode: 0o600 });
    assert.equal(
      readFileSync(file, "utf8"),
      records.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    assert.deepEqual(readJsonl(file), records);
    assert.deepEqual(parseJsonl('\r\n {"text":"a\\nb"}\r\n'), [{ text: "a\nb" }]);
    assert.throws(() => parseJsonl('{"private-token":'), {
      message: "Invalid JSON in capture input",
    });
    assert.throws(() => writeJsonl(file, [], { flag: "wx" }), { code: "EEXIST" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("summarizes recorded Pi RPC and preserves Codex delta grouping", () => {
  const fixture = (name: string) => join(REPO_ROOT, "service/tests/snap", `${name}.jsonl`);
  const pi = summarizeCapture(fixture("pi/basic-turn")).join("\n");
  assert.match(pi, />>  prompt  "Compute/);
  assert.match(pi, /response  command=prompt  success=true/);
  assert.match(pi, /message_end  assistant  stop=stop/);
  const excerpt = summarizeCapture(fixture("pi/messages/steer")).join("\n");
  assert.match(excerpt, /response  command=steer  success=true/);
  const codex = summarizeCapture(fixture("codex/commands")).join("\n");
  assert.match(codex, /item\/commandExecution\/outputDelta ×2.*line 2\\nline 3/);
  assert.match(codex, /-- stream closed/);
});

void test("summarize CLI resolves its own checkout from a different working directory", () => {
  const output = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, "scripts/summarize-capture.ts"),
      join(REPO_ROOT, "service/tests/snap/pi/basic-turn.jsonl"),
    ],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.match(output, /message_end  assistant  stop=stop/);
});

void test("widget excerpt omits unrelated turns before a separate native wake", async () => {
  type Row = { frame?: { type?: string; message?: { customType?: string } } };
  const { widgetClip } = (await import(
    new URL("./pi-scenario-widgets.mjs", import.meta.url).href
  )) as {
    widgetClip: (rows: Row[], runId: string) => Row[];
  };
  const snap = join(REPO_ROOT, "service/tests/snap/pi");
  const [, ...tape] = readJsonl<Row>(join(snap, "messages/subagents-widgets.jsonl"));
  const [, ...unrelatedTurn] = readJsonl<Row>(join(snap, "basic-turn.jsonl"));
  const notice = tape.findIndex((row) => row.frame?.message?.customType === "subagent-notify");
  const wake = tape
    .slice(0, notice)
    .map((row) => row.frame?.type)
    .lastIndexOf("agent_start");
  assert(wake > 0, "Recording has a native wake");
  assert.deepEqual(
    widgetClip([...tape.slice(0, wake), ...unrelatedTurn, ...tape.slice(wake)], "fixture-run"),
    tape.slice(0, -2), // No stats RPC is required after native settlement.
  );
  assert.deepEqual(widgetClip(tape.slice(0, -2), "fixture-run"), tape.slice(0, -2));
  assert.throws(() => widgetClip(tape.slice(0, wake), "fixture-run"), /Missing native wake/);
});

void test("capture cleanup sends EOF, awaits close and reports spawn failure", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = once(child, "close");
  await trackCaptureChild(child, 10_000)();
  assert.deepEqual(await closed, [0, null]);

  const missing = spawn(join(dirname(process.execPath), "yaat-no-such-capture-test-binary"), [], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  await assert.rejects(trackCaptureChild(missing, 1000)(), { code: "ENOENT" });
});
