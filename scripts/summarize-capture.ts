// Compact view of a snap recording: one line per entry with the fields that
// drive the session mapping. Usage: npm run summarize -- <file.jsonl>
import { readJsonl } from "./capture-io.ts";
import { isScriptMain } from "./script-paths.mjs";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string =>
  typeof v === "string" ? v : (JSON.stringify(v) ?? "undefined");
const tail = (v: unknown, n = 6): string => str(v).slice(-n);

// A JSON-RPC message of `codex app-server`, either way. A subagent's
// frames name their own thread, not the first thread seen in this recording.
function codexFrame(m: Obj, parts: string[], tape: { mainThread?: unknown }): void {
  const p = obj(m.params);
  tape.mainThread ??= p.threadId;
  if (m.method) parts.push(str(m.method) + (m.id != null ? ` [req ${str(m.id)}]` : ""));
  else parts.push(`[res ${str(m.id)}]`);
  if (p.threadId && p.threadId !== tape.mainThread) parts.push(`@sub:${tail(p.threadId)}`);
  const item = obj(p.item);
  if (item.type) parts.push(`${str(item.type)}#${tail(item.id)}`);
  if (item.status) parts.push(`status=${str(item.status)}`);
  if (item.command) parts.push(`cmd=${JSON.stringify(str(item.command).slice(0, 50))}`);
  if (item.exitCode != null) parts.push(`exit=${str(item.exitCode)}`);
  if (item.tool) parts.push(`tool=${str(item.namespace ?? "")}.${str(item.tool)}`);
  if (item.text) parts.push(`text=${JSON.stringify(str(item.text).slice(0, 60))}`);
  if (Array.isArray(item.summary) && item.summary.length)
    parts.push(`summary=${JSON.stringify(str(item.summary).slice(0, 60))}`);
  if (Array.isArray(item.content) && item.content.length)
    parts.push(`content=${JSON.stringify(str(item.content).slice(0, 60))}`);
  if (p.itemId) parts.push(`#${tail(p.itemId)}`);
  if (p.delta != null) parts.push(JSON.stringify(str(p.delta).slice(0, 60)));
  const turn = obj(p.turn);
  if (turn.id) parts.push(`turn=${tail(turn.id)} ${str(turn.status)}`);
  if (turn.error) parts.push(`error=${JSON.stringify(turn.error)}`);
  if (p.error) parts.push(`error=${JSON.stringify(p.error)}`);
  if (p.willRetry != null) parts.push(`willRetry=${str(p.willRetry)}`);
  const usage = obj(p.tokenUsage);
  if (usage.last)
    parts.push(`last=${str(obj(usage.last).totalTokens)} window=${str(usage.modelContextWindow)}`);
  if (p.rateLimits) parts.push(`rateLimits=${JSON.stringify(p.rateLimits).slice(0, 160)}`);
  if (p.status) parts.push(`status=${JSON.stringify(p.status)}`);
  if (m.method === "item/tool/call")
    parts.push(
      `${str(p.namespace)}.${str(p.tool)} ${JSON.stringify(p.arguments)} thread=${tail(p.threadId)}`,
    );
  if (m.method === "turn/start" || m.method === "turn/steer") {
    const text = (Array.isArray(p.input) ? p.input : []).map((i) => str(obj(i).text)).join(" ");
    parts.push(JSON.stringify(text.slice(0, 60)));
  }
  if (m.result !== undefined) parts.push(JSON.stringify(m.result).slice(0, 200));
  if (m.error) parts.push(`error=${JSON.stringify(m.error)}`);
}

function piFrame(m: Obj, parts: string[]): void {
  parts.push(str(m.type));
  for (const key of ["command", "method", "toolName", "success"])
    if (m[key] !== undefined) parts.push(`${key}=${str(m[key])}`);
  const message = obj(m.message);
  if (message.role) parts.push(str(message.role));
  if (message.customType) parts.push(str(message.customType));
  if (message.stopReason) parts.push(`stop=${str(message.stopReason)}`);
  const event = obj(m.assistantMessageEvent);
  if (event.type) parts.push(str(event.type));
  const text = event.delta ?? (typeof m.message === "string" ? m.message : undefined);
  if (typeof text === "string") parts.push(JSON.stringify(text.slice(0, 70)));
}

const DELTA = /\/(delta|outputDelta|summaryTextDelta|textDelta)$/;

export function summarizeCapture(file: string): string[] {
  const tape = {};
  const [first, ...entries] = readJsonl(file);
  const header = obj(obj(first).header);
  const format =
    header.backend === "codex"
      ? (frame: Obj, parts: string[]) => codexFrame(frame, parts, tape)
      : header.backend === "pi" || (header.backend == null && /\bpi\b/i.test(str(header.source)))
        ? piFrame
        : (frame: Obj, parts: string[]) => parts.push(JSON.stringify(frame).slice(0, 200));
  const output = [
    `== ${file}  ${str(header.backend)} ${str(header.model)} cli=${str(header.cli)}`,
    `   ${str(header.description)}`,
  ];
  // Consecutive deltas of one item fold into a line.
  type Run = { key: string; t: unknown; method: string; n: number; text: string };
  let run = null as Run | null;
  const flush = () => {
    if (!run) return;
    const head = String(run.t).padStart(6) + "ms";
    output.push(
      `${head}  ${run.method} ×${run.n}  ${run.key.split(" ")[1]}  ${JSON.stringify(run.text.slice(0, 80))}`,
    );
    run = null;
  };
  for (const entry of entries) {
    const e = obj(entry);
    const frame = obj(e.frame);
    const p = obj(frame.params);
    if (
      header.backend === "codex" &&
      typeof frame.method === "string" &&
      DELTA.test(frame.method)
    ) {
      const key = `${frame.method} #${tail(p.itemId)}`;
      if (run?.key !== key) {
        flush();
        run = { key, t: e.t, method: frame.method, n: 0, text: "" };
      }
      run.n++;
      run.text += str(p.delta);
      continue;
    }
    flush();
    const parts = [e.t === undefined ? "        " : str(e.t).padStart(6) + "ms"];
    if (e.step) {
      const s = obj(e.step);
      parts.push(
        `>> step ${str(s.i)} ${str(s.op)}` +
          (s.text ? ` ${JSON.stringify(str(s.text).slice(0, 70))}` : "") +
          (s.for != null ? ` ${str(s.for)}` : ""),
      );
    } else if (e.frame) {
      format(frame, parts);
    } else if (e.sent) {
      parts.push(">>");
      format(obj(e.sent), parts);
    } else if (e.error) parts.push(`!! error ${str(e.error)}`);
    else if (e.close) parts.push("-- stream closed");
    else if (e.control) parts.push(`<< control ${JSON.stringify(e.control)}`);
    output.push(parts.join("  "));
  }
  flush();
  return output;
}

if (isScriptMain("summarize-capture.ts"))
  for (const file of process.argv.slice(2))
    for (const line of summarizeCapture(file)) console.log(line);
