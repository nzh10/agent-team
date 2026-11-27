// npm run capture -- pi basic-turn   (one account-backed turn, no tools)
// npm run capture -- pi extract FILE LINE   (one v3 message, anonymized, stdout)
import fs from "node:fs";
import { trackCaptureChild } from "./capture-child.ts";
import { jsonLine, parseJsonLine, writeJsonl } from "./capture-io.ts";
import { validateTurn } from "../service/tests/snap/pi-capture-contract.ts";
import type { PiFrame } from "../service/tests/snap/fixture.ts";
import { captures } from "../service/tests/snap/pi-captures.ts";
import { seededPng } from "../service/tests/snap/pixel.ts";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";

interface Line {
  type: string;
  id?: string;
  method?: string;
  assistantMessageEvent?: { type?: string };
  version?: number;
  timestamp: string;
  customType?: string;
  message?: Record<string, unknown>;
  toolName?: string;
  args?: Record<string, unknown>;
  command?: string;
  success?: boolean;
  data?: { messages?: unknown[] };
}

const keys = new Set(
  `commands models levels description source isStreaming isCompacting steeringMode followUpMode autoCompactionEnabled messageCount pendingMessageCount finalError errorMessage attempt delayMs maxAttempts willRetry asyncId tasks async mode task exitCode results index finalOutput sessionName transcriptPath summary output sessionPath version steps startTime startedAt workflowChildren workflow requestedModel childId key pattern glob ignoreCase literal context sections toolsAdded toolsRemoved title method confirmed args toolCall partialResult customType display runs childRuns childOutputs agent status workflowReceiptPath asyncDir runId workflowRunId workflowKey sessionLabel sessionValue reasoning totalFromProvider mimeType aborted label reason toolResults modelId cacheRetention serverToolUse serviceTier isEstimated environment cwd shell platform osVersion currentDate type id parentId timestamp role content api provider model providerThinkingLevel usage stopReason responseId rawStopReason durationMs thinkingLevel input output cacheRead cacheWrite totalTokens cost total name arguments path offset limit command timeout edits oldText newText text thinking thinkingSignature textSignature message messages assistantMessageEvent partial contentIndex delta success data disposition tokens contextUsage contextWindow percent sessionFile sessionId userMessages assistantMessages toolCalls toolResults totalMessages result toolCallId toolName details isError`.split(
    " ",
  ),
);
const enums: Record<string, string[]> = {
  type: `message response agent_start agent_end agent_settled turn_start turn_end message_start message_end message_update start done thinking_start thinking_delta thinking_end text_start text_delta text_end thinking image text toolCall tool_execution_start tool_execution_update tool_execution_end toolcall_start toolcall_delta toolcall_end auto_retry_start auto_retry_end extension_ui_request extension_ui_response`.split(
    " ",
  ),
  customType: ["subagent-notify"],
  method: ["confirm"],
  sessionLabel: ["Session file"],
  status: ["completed", "failed", "stopped"],
  role: ["system", "custom", "assistant", "user", "toolResult", "environment", "developer"],
  api: ["openai-codex-responses", "openai-completions", "antigravity-acp", "anthropic-messages"],
  mode: ["workflow", "single", "parallel", "chain"],
  provider: ["pi-e2e", "antigravity-acp", "openai-codex", "kimi-coding"],
  model: [
    "scenario",
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-4-hydrogen",
    "gpt-6.2-astra",
    "gpt-6.2-sol",
    "k3.1-pro-highspeed",
  ],
  name: ["read", "bash", "edit", "grep", "subagent"],
  toolName: ["read", "bash", "edit", "grep", "subagent", "subagent_launch"],
  disposition: ["started"],
  command: [
    "get_state",
    "get_available_models",
    "get_commands",
    "get_available_thinking_levels",
    "prompt",
    "abort",
    "get_session_stats",
    "pwd",
  ],
  oldText: ["sample"],
  newText: ["example"],
  pattern: ["example"],
  stopReason: ["stop", "toolUse", "aborted", "error"],
  rawStopReason: ["completed", "tool_calls", "stop"],
  mimeType: ["image/png"],
  thinkingLevel: ["low", "medium", "high", "max"],
  providerThinkingLevel: ["low", "medium", "high", "max"],
};
// Exact numeric schema paths, not field names: tool inputs may contain bytes,
// account IDs, or objects deliberately named `usage` or `tokens`.
const publicNumber =
  /^(?:(?:(?:message|messages\[\])\.)?(?:timestamp|durationMs)|assistantMessageEvent\.contentIndex|(?:(?:message|messages\[\])\.)?usage\.(?:input|output|cacheRead|cacheWrite|reasoning|totalTokens|cost\.(?:input|output|cacheRead|cacheWrite|total))|data\.(?:tokens\.(?:input|output|cacheRead|cacheWrite|total)|contextUsage\.(?:tokens|contextWindow|percent)|userMessages|assistantMessages|toolCalls|toolResults|totalMessages|cost)|details\.runs\[\]\.durationMs)$/;
export function sanitizer(slots = new Map<string, string>()) {
  const ids = new Map<string, string>();
  function clean(v: unknown, key = "", at = "", readArgs = false): unknown {
    if (Array.isArray(v)) return v.map((x) => clean(x, "", `${at}[]`));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x], i) => [
          keys.has(k) ? k : `field${i}`,
          clean(
            x,
            keys.has(k) ? k : "",
            at ? `${at}.${k}` : k,
            (k === "arguments" &&
              /^(?:(?:(?:message|messages\[\])\.)?content\[\]|assistantMessageEvent\.toolCall)$/.test(
                at,
              ) &&
              "name" in v &&
              v.name === "read" &&
              "type" in v &&
              v.type === "toolCall") ||
              (k === "args" && at === "" && "toolName" in v && v.toolName === "read") ||
              (readArgs && ["offset", "limit"].includes(k) && typeof x === "number"),
          ),
        ]),
      );
    if (typeof v === "number")
      return (v === 4 &&
        /^(?:args|(?:message|messages\[\])\.content\[\]\.arguments|assistantMessageEvent\.toolCall\.arguments)\.timeout$/.test(
          at,
        )) ||
        publicNumber.test(at) ||
        (readArgs &&
          ["offset", "limit"].includes(key) &&
          Number.isSafeInteger(v) &&
          v >= 0 &&
          v <= 1_000_000)
        ? v
        : 0;
    if (typeof v !== "string" || v === "") return v;
    if (slots.has(v)) return slots.get(v);
    if (enums[key]?.includes(v)) return v;
    if (
      [
        "id",
        "parentId",
        "toolCallId",
        "responseId",
        "runId",
        "asyncId",
        "childId",
        "workflowKey",
        "workflowRunId",
      ].includes(key)
    ) {
      if (!ids.has(v)) ids.set(v, `id-${ids.size + 1}`);
      return ids.get(v);
    }
    if (key === "path") return "fixture.ts";
    // Preserve the concatenation of streamed deltas and finalized content.
    if (["delta", "content", "text", "thinking"].includes(key)) return "x".repeat(v.length);
    if (key === "oldText" || key === "newText") {
      if (!ids.has(v)) ids.set(v, `edit-${ids.size + 1}`);
      return ids.get(v);
    }
    return "sample";
  }
  return clean;
}
function modelName(msg: Record<string, unknown>) {
  if (!enums.provider.includes(String(msg.provider)) || !enums.model.includes(String(msg.model)))
    throw new Error("Unreviewed provider/model");
  return `${String(msg.provider)}/${String(msg.model)}`;
}
export async function capturePi(args: string[], snap: string) {
  if (
    args.length === 1 &&
    ["scenario", "scenario-widgets", "compaction-and-retry", "retry-failed"].includes(args[0])
  ) {
    const scenario = args[0] === "scenario" || args[0] === "scenario-widgets";
    const url = new URL(
      scenario ? "./capture-pi-scenario.mjs" : "./capture-pi-retry.mjs",
      import.meta.url,
    );
    const mod = (await import(url.href)) as Record<
      string,
      (snap: string, failed?: boolean) => Promise<void> | void
    >;
    await mod[scenario ? "captureScenario" : "captureRetry"](
      snap,
      args[0] === "retry-failed" || args[0] === "scenario-widgets",
    );
    return;
  }
  const clean = sanitizer();
  if (args[0] === "extract" && args.length === 3) {
    const [, file, line] = args;
    const input = fs.createReadStream(file);
    const rows = readline.createInterface({ input, crlfDelay: Infinity });
    let i = 0;
    try {
      for await (const row of rows) {
        const rec = parseJsonLine<Line>(row);
        if (++i === 1 && (rec.type !== "session" || rec.version !== 3))
          throw new Error(
            "Not a Pi v3 session (workspace stream logs are projections, not Pi frames)",
          );
        if (i !== Number(line)) continue;
        const model = rec.message?.role === "assistant" ? modelName(rec.message) : undefined;
        if (!model && rec.customType !== "subagent-notify")
          throw new Error("Select a Pi v3 assistant or subagent notice");
        const recordedAt = new Date(rec.timestamp).toISOString();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extract-"));
        try {
          // Ask Pi itself for the RPC representation. No raw transcript or host
          // path is copied; the selected entry becomes the only active leaf.
          const selected = {
            ...(clean(rec) as object),
            type: rec.type === "message" ? "message" : "custom_message",
            id: "abcd1234",
            parentId: null,
            timestamp: recordedAt,
          };
          const session = path.join(dir, "excerpt.jsonl");
          writeJsonl(
            session,
            [
              {
                type: "session",
                version: 3,
                id: "00000000-0000-4000-8000-000000000001",
                timestamp: recordedAt,
                cwd: dir,
              },
              selected,
            ],
            { mode: 0o600 },
          );
          const output = execFileSync(
            "pi",
            [
              "--offline",
              "--mode",
              "rpc",
              "--no-extensions",
              "--no-skills",
              "--no-mcp",
              "--no-tools",
              "--no-context-files",
              "--session",
              session,
            ],
            {
              cwd: dir,
              env: {
                PATH: process.env.PATH,
                HOME: dir,
                PI_CODING_AGENT_DIR: path.join(dir, "agent"),
                PI_TELEMETRY: "0",
              },
              input: '{"type":"get_messages"}\n',
              encoding: "utf8",
              timeout: 15000,
              stdio: ["pipe", "pipe", "ignore"],
            },
          );
          const frame = parseJsonLine<Line>(output);
          if (
            !frame.success ||
            frame.command !== "get_messages" ||
            frame.data?.messages?.length !== 1
          )
            throw new Error("Pi did not restore the excerpt");
          console.log(
            JSON.stringify({
              header: { source: "pi-session-v3 / get_messages", model, recordedAt },
            }),
          );
          console.log(JSON.stringify({ frame }));
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        return;
      }
      throw new Error("No such line");
    } finally {
      rows.close();
      input.destroy();
    }
  }
  if (args.length !== 1 || !Object.hasOwn(captures, args[0]))
    throw new Error(
      "Select ONE Pi fixture: " + Object.keys(captures).join(", ") + "; or pi extract FILE LINE",
    );
  const name = args[0] as keyof typeof captures;
  const { description, steps } = captures[name];
  const first = steps[0];
  if (first.op !== "send" && first.op !== "image") throw new Error("Expected prompt");
  // Only reviewed fixed inputs are sent, never operator-provided prompt text.
  for (const step of steps)
    if (
      (step.op === "send" || step.op === "image") &&
      (!/^[A-Za-z0-9 ,.]+$/.test(step.text) ||
        /(?:[a-z]+\.[a-z]+(?![a-z])|\S{30,})/i.test(step.text.replaceAll("fixture.ts", "fixture")))
    )
      throw new Error("Unreviewed capture prompt");
  const cli = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  if (!/^\d+\.\d+\.\d+$/.test(cli)) throw new Error("Unrecognized Pi CLI version");
  const acp = name === "antigravity-acp-turn";
  const builtins = name === "tools-bash-edit";
  const dialog = name === "extension-ui-dialog";
  const queued = name === "single-queue-order";
  const extension = process.env.PI_ACP_EXTENSION;
  if (acp && !extension)
    throw new Error("Set PI_ACP_EXTENSION to the installed provider entry point");
  const model = acp ? "antigravity-acp/gemini-4-neon" : "openai-codex/gpt-6.2-astra";
  // Atomic per-user reservation. Never retry stale locks automatically: a slow
  // provider may still be billing. A successful or failed run cools down alike.
  const gate = path.join(os.tmpdir(), `pi-capture-${process.getuid?.() ?? "local"}.lock`);
  const gateFd = fs.openSync(gate, "wx", 0o600);
  fs.closeSync(gateFd);
  try {
    await recordTurn();
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    fs.rmSync(gate, { force: true });
  }
  async function recordTurn() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-pi-"));
    if (acp || builtins) {
      fs.writeFileSync(path.join(dir, "fixture.ts"), 'export const value = "sample";\n');
      fs.writeFileSync(
        path.join(dir, "guard.ts"),
        `export default function(pi) { let count = 0; pi.on("tool_call", ({toolName:t,input:a}) => {
        const only = keys => Object.keys(a).every(k => keys.includes(k));
        const ok = t === "read" && a.path === "fixture.ts" && only(["path","offset","limit"]) || ${builtins} && (
          t === "bash" && a.command === "pwd" && a.timeout === 4 && only(["command","timeout"]) ||
          t === "edit" && a.path === "fixture.ts" && only(["edits","path"]) ||
          t === "grep" && a.path === "fixture.ts" && a.pattern === "example" && only(["pattern","path","literal","limit","ignoreCase","glob","context"]));
        if (!ok || ++count > 4) return {block:true, reason:"Capture tool boundary"};
      }); }`,
      );
    }
    if (dialog)
      fs.writeFileSync(
        path.join(dir, "dialog.ts"),
        `export default function(pi) { pi.on("before_agent_start", (_event,ctx) => { void ctx.ui.confirm("Confirm sample", "Continue?"); }); }`,
      );
    const child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        ...(acp && extension
          ? ["-e", extension, "-e", path.join(dir, "guard.ts"), "--tools", "read"]
          : builtins
            ? ["-e", path.join(dir, "guard.ts"), "--tools", "bash,read,edit,grep"]
            : ["--no-tools"]),
        ...(dialog ? ["-e", path.join(dir, "dialog.ts")] : []),
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--thinking",
        "high",
        "--model",
        model,
      ],
      { cwd: dir, stdio: ["pipe", "pipe", "ignore"] },
    );
    const closeChild = trackCaptureChild(
      child,
      queued ? 183_000 : 93_000,
      queued ? 180_000 : 90_000,
    );
    const rows = readline.createInterface({ input: child.stdout });
    const started = Date.now();
    const entries: unknown[] = [];
    const add = (e: object) => entries.push({ t: Date.now() - started, ...e });
    const step = (i: number) => add({ step: { ...steps[i], i } });
    const send = (sent: object, wire = sent) => {
      add({ sent });
      child.stdin.write(jsonLine(wire));
    };
    try {
      step(0);
      const prompt = { type: "prompt", message: first.text };
      if (first.op === "image") {
        const image = (data: string) => ({
          ...prompt,
          images: [{ type: "image", mimeType: "image/png", data }],
        });
        send(image("generated-png"), image(seededPng(first.seed).toString("base64")));
      } else send(prompt);
      let observed = false;
      let uiId: string | undefined;
      let answered = false;
      let bytes = 0;
      let turn = 0;
      for await (const row of rows) {
        bytes += Buffer.byteLength(row);
        if (bytes > 8 * 1024 * 1024) throw new Error("Pi tape exceeded size cap");
        const frame = parseJsonLine<Line>(row);
        if (
          acp &&
          frame.type === "tool_execution_start" &&
          (frame.toolName !== "read" || frame.args?.path !== "fixture.ts")
        )
          throw new Error("Unexpected ACP tool call");
        if (frame.type === "message_end" && frame.message?.role === "assistant") {
          if (
            (frame.message.stopReason !== "stop" &&
              !((acp || builtins) && frame.message.stopReason === "toolUse") &&
              !(name === "interrupt-abort" && frame.message.stopReason === "aborted")) ||
            modelName(frame.message) !== model
          )
            throw new Error("Turn failed or used another model");
          observed = true;
        }
        if (frame.success === false || frame.type === "auto_retry_start")
          throw new Error("Capture failed; not retrying");
        if (dialog && frame.type === "extension_ui_request" && frame.method === "confirm") {
          uiId = frame.id;
          add({ frame: { ...(clean(frame) as object), id: "confirmation" } });
        } else add({ frame: clean(frame) });
        if (
          uiId &&
          !answered &&
          ["thinking_end", "text_end"].includes(frame.assistantMessageEvent?.type ?? "")
        ) {
          step(1);
          step(2);
          const reply = { type: "extension_ui_response", id: "confirmation", confirmed: true };
          send(reply, { ...reply, id: uiId });
          answered = true;
        }
        if (frame.type === "message_end" && frame.message?.role === "user") {
          if (queued && turn === 0) {
            step(1);
            step(2);
            step(3);
          }
          if (queued && turn === 1) step(4);
          if (name === "image-prompt") step(1);
          if (name === "interrupt-abort") {
            step(1);
            send({ type: "abort" });
            step(2);
          }
        }
        if (frame.type === "agent_settled") send({ type: "get_session_stats" });
        if (
          frame.type === "response" &&
          frame.command === "get_session_stats" &&
          (observed || name === "interrupt-abort")
        ) {
          if (queued && turn < 2) {
            // The Workspace holds these sends until Pi settles. A short pause
            // avoids issuing successive account requests in a burst.
            await new Promise((resolve) => setTimeout(resolve, 30_000));
            const next = steps[++turn];
            if (next.op !== "send") throw new Error("Expected queued prompt");
            send({ type: "prompt", message: next.text });
            observed = false;
            continue;
          }
          if (dialog && !answered) throw new Error("No overlapping confirm dialog observed");
          if (!builtins && !dialog && name !== "interrupt-abort") step(steps.length - 1);
          const header = {
            backend: "pi",
            fixture: name,
            source: "pi --mode rpc",
            cli,
            model,
            description,
            recordedAt: new Date().toISOString(),
          };
          validateTurn(
            name,
            entries.flatMap((e) => (e as { frame?: PiFrame }).frame ?? []),
          );
          writeJsonl(path.join(snap, `pi/${name}.jsonl`), [{ header }, ...entries]);
          return;
        }
      }
      throw new Error("Incomplete capture");
    } finally {
      rows.close();
      try {
        await closeChild();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}
