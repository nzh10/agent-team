// Inject one provider exception, not Pi RPC frames. The recovery provider
// plays the already-redacted text blocks of a successful recorded response.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { localPiBinary, localPiSdkAnchor } from "../service/tests/local-pi.ts";
import { trackCaptureChild } from "./capture-child.ts";
import { jsonLine, parseJsonLine, readJsonl, writeJsonl } from "./capture-io.ts";
import { sanitizer } from "./capture-pi.ts";

export async function captureRetry(snap, fail = false) {
  const frames = readJsonl(path.join(snap, "pi/tools-bash-edit.jsonl"))
    .map((r) => r.frame)
    .filter(Boolean);
  const start = frames.findLastIndex(
    (f) => f.type === "message_start" && f.message.role === "assistant",
  );
  const recovery = frames.slice(start).find((f) => f.type === "message_end").message;
  const deltas = frames.slice(start).flatMap((f) => f.assistantMessageEvent ?? []);
  const compact = readJsonl(path.join(snap, "../unit/fixtures/pi-compact-overflow.jsonl")).filter(
    (f) => f.type.startsWith("compaction_"),
  );
  const model = "capture-retry/scenario",
    reason = "503 fixture service unavailable";
  if (!localPiBinary || !localPiSdkAnchor)
    throw new Error("Offline capture requires Pi on PATH or via PI_BINARY");
  const pkg = createRequire(localPiSdkAnchor)
    .resolve.paths("@earendil-works/pi-ai")
    ?.map((dir) => path.join(dir, "@earendil-works/pi-ai/package.json"))
    .find((f) => fs.existsSync(f));
  if (!pkg) throw new Error("The Pi installation does not contain @earendil-works/pi-ai");
  const sdk = pathToFileURL(
    path.resolve(path.dirname(pkg), JSON.parse(fs.readFileSync(pkg, "utf8")).exports["."].import),
  ).href;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-pi-retry-"));
  try {
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: fail ? 1000 : 10 } }),
    );
    const ext = path.join(dir, "fault.ts");
    fs.writeFileSync(
      ext,
      `import {createAssistantMessageEventStream} from ${JSON.stringify(sdk)};
      export default function(pi){let calls=0;pi.registerProvider("capture-retry",{baseUrl:"http://127.0.0.1",apiKey:"fixture",api:"local-replay",models:[{id:"scenario",name:"scenario",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:272000,maxTokens:4096}],streamSimple(model){
        if(++calls===1 || ${fail})throw Error(calls===3 ? "503 final failure" : ${JSON.stringify(reason)});
        const s=createAssistantMessageEventStream(), m={...${JSON.stringify(recovery)},model:model.id,provider:model.provider,api:model.api,timestamp:Date.now()};
        s.push({type:"start",partial:m});for(const e of ${JSON.stringify(deltas)})s.push({...e,partial:m});s.push({type:"done",reason:"stop",message:m});s.end();return s;
      }});}`,
    );
    const child = spawn(
      localPiBinary,
      [
        "--mode",
        "rpc",
        "--offline",
        "--no-session",
        "--no-tools",
        "--no-context-files",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "-e",
        ext,
        "--model",
        model,
      ],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const closeChild = trackCaptureChild(child, 12_000);
    const clean = sanitizer();
    const rows = readline.createInterface({ input: child.stdout });
    const entries = [],
      base = Date.now();
    let index = 0,
      retried = false,
      progress = false;
    const add = (e) => entries.push({ t: Date.now() - base, ...e });
    const step = (s) => add({ step: { i: index++, ...s } });
    const send = (sent) => {
      add({ sent });
      child.stdin.write(jsonLine(sent));
    };
    try {
      step({ op: "send", text: "Retry a sample." });
      send({ type: "prompt", message: "Retry a sample." });
      for await (const line of rows) {
        const f = parseJsonLine(line);
        const frame = clean(f);
        if (f.type === "auto_retry_start") {
          if ((retried && !fail) || !f.errorMessage.includes(reason))
            throw Error("Unexpected retry cause");
          Object.assign(frame, {
            type: f.type,
            attempt: f.attempt,
            maxAttempts: f.maxAttempts,
            delayMs: f.delayMs,
            errorMessage: reason,
          });
          add({ frame });
          retried = true;
          step({ op: "check", name: "retry" });
          if (!fail)
            for (const frame of compact) {
              add({ frame });
              step({
                op: "check",
                name: frame.type === "compaction_start" ? "compacting" : "compacted",
              });
            }
        } else {
          if (f.type === "auto_retry_end") {
            Object.assign(frame, { type: f.type, attempt: f.attempt, success: f.success });
            if (!f.success && f.finalError?.includes("503 final failure"))
              frame.finalError = "503 final failure";
          }
          if (f.type === "response" && f.command === "get_session_stats")
            frame.data.contextUsage.tokens = null; // missing telemetry fault
          add({ frame });
        }
        if (retried && !progress && f.assistantMessageEvent?.type === "text_delta") {
          step({ op: "check", name: "progress" });
          progress = true;
        }
        if (f.type === "agent_settled") send({ type: "get_session_stats" });
        if (f.command === "get_session_stats") {
          if (fail) {
            if (!entries.some((e) => e.frame?.finalError === "503 final failure"))
              throw Error("Fault did not exhaust retry budget");
            const header = {
              source: "pi --mode rpc; injected provider failure",
              model,
              recordedAt: new Date().toISOString(),
            };
            writeJsonl(path.join(snap, "pi/messages/retry-failed.jsonl"), [
              { header },
              ...entries.filter((e) => e.frame),
            ]);
            return;
          }
          if (
            !progress ||
            !entries.some((e) => e.frame?.type === "auto_retry_end" && e.frame.success)
          )
            throw Error("Incomplete fault recovery");
          step({ op: "check", name: "settled" });
          const header = {
            backend: "pi",
            fixture: "compaction-and-retry",
            description:
              "Compaction and retry do not settle Pi early; unknown context tokens stay unknown.",
            model,
            source:
              "pi --mode rpc; injected 503, recorded overflow events during retry, missing context telemetry",
            recordedAt: new Date().toISOString(),
          };
          writeJsonl(path.join(snap, "pi/compaction-and-retry.jsonl"), [{ header }, ...entries]);
          return;
        }
      }
      throw Error("Pi exited before recovery");
    } finally {
      rows.close();
      await closeChild();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
