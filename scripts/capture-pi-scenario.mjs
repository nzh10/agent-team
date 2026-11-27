// Run via npm run capture -- pi scenario. No provider login or network call.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseJsonl, readJsonl, writeJsonl } from "./capture-io.ts";
import { steerReceipt } from "../service/tests/snap/pi-capture-contract.ts";
import { moreExcerpts } from "./pi-scenario-excerpts.mjs";
import { sanitizer } from "./capture-pi.ts";
import { extractScenarioWidgets } from "./pi-scenario-widgets.mjs";
import { discoverLocalPiPackages } from "../service/src/session/pi-agent-home.ts";

function extract(sessions, files, snap) {
  moreExcerpts(sessions, snap);
  const lead = sessions.find((rows) =>
    rows.some((r) => r.sent?.message === "pi-e2e-launch:reconcile"),
  );
  if (!lead) throw new Error("No deterministic E2E RPC trace");
  const startup = lead
    .slice(
      0,
      lead.findIndex((r) => r.sent?.type === "prompt"),
    )
    .filter((r) => r.frame?.type === "response");
  const cleanBoot = sanitizer();
  writeJsonl(path.join(snap, "pi/messages/startup.jsonl"), [
    {
      header: {
        source: "pi-deterministic E2E / startup RPC",
        model: "pi-e2e/scenario",
        recordedAt: new Date(startup[0].at).toISOString(),
      },
    },
    ...startup.map((r) => ({ frame: cleanBoot(r.frame) })),
  ]);
  const steer = lead.find(
    (r) => r.frame?.command === "steer" && r.frame.data?.disposition === "queued",
  );
  if (!steer || steer.frame.success !== true) throw new Error("Missing real steer receipt");
  writeJsonl(path.join(snap, "pi/messages/steer.jsonl"), [
    {
      header: {
        source: "pi-deterministic E2E / Pi RPC",
        model: "pi-e2e/scenario",
        recordedAt: new Date(steer.at).toISOString(),
      },
    },
    { frame: steerReceipt(steer.frame) },
  ]);
  for (const [kind, prompt, description] of [
    [
      "foreground",
      "pi-e2e-launch:foreground",
      "Foreground child results reconstruct separate detail cards.",
    ],
    [
      "async",
      "pi-e2e-launch:reconcile",
      "A native async notify backfills both original child cards on wake-up.",
    ],
  ]) {
    const start = lead.findIndex((r) => r.sent?.message === prompt);
    const end = lead.findIndex((r, i) => i > start && r.sent?.type === "prompt");
    if (start < 0 || end < 0) throw new Error("Incomplete scenario");
    const clip = lead.slice(start, end),
      entries = [],
      slots = new Map(),
      clean = sanitizer(slots);
    function children(steps) {
      const artifacts = {};
      for (const s of steps) {
        const file = s.sessionFile;
        const slot = `$child-${Object.keys(artifacts).length + 1}`;
        const records = parseJsonl(files.get(file));
        const leaf = records.findLast((r) => r.message?.role === "assistant");
        if (records[0].version !== 3 || !leaf) throw new Error("Invalid child artifact");
        slots.set(file, slot);
        // Use the actual finalized child message; no invented child transcript.
        artifacts[slot] = [
          { type: "session", version: 3, id: "child" },
          { type: "message", id: "leaf", parentId: null, message: clean(leaf.message) },
        ];
      }
      return artifacts;
    }
    for (const { at, frame: f, sent } of clip) {
      const t = at - clip[0].at,
        add = (e) => entries.push({ t, ...e });
      if (sent) {
        if (sent.type === "prompt") {
          add({ step: { op: "send", text: prompt, i: 0 } });
          add({ sent: { type: "prompt", message: prompt } });
        } else if (sent.type === "get_session_stats") add({ sent: { type: sent.type } });
        continue;
      }
      // Select native frames, not a reconstruction of intermediate deltas.
      if (f.type === "response" && !["prompt", "get_session_stats"].includes(f.command)) continue;
      if (
        f.type.startsWith("tool_execution_") &&
        (f.toolName !== "subagent" || f.type === "tool_execution_update")
      )
        continue;
      if (
        f.type.startsWith("message_") &&
        (f.message?.role === "toolResult" ||
          (f.message?.role === "custom" && f.message.customType !== "subagent-notify"))
      )
        continue;
      if (
        ![
          "response",
          "agent_start",
          "agent_settled",
          "message_start",
          "message_end",
          "tool_execution_start",
          "tool_execution_end",
        ].includes(f.type)
      )
        continue;
      if (f.type === "tool_execution_end") {
        const d = f.result.details;
        if (d.asyncDir) slots.set(d.asyncDir, "$async-dir");
        else add({ artifacts: children(d.results) });
      }
      if (f.type === "message_start" && f.message?.customType === "subagent-notify") {
        const run = f.message.details.runs[0];
        const status = JSON.parse(files.get(path.join(run.asyncDir, "status.json")));
        slots.set(status.sessionId, "$owner-session");
        add({
          artifacts: {
            ...children(status.steps),
            "$async-status": [
              clean({ runId: status.runId, sessionId: status.sessionId, steps: status.steps }),
            ],
          },
        });
      }
      const raw = { ...f };
      if (f.type === "response") delete raw.id; // player binds the in-flight request ID
      const frame = clean(raw);
      add({ frame });
      if (
        kind === "async" &&
        f.command === "get_session_stats" &&
        !entries.some((e) => e.step?.i === 1)
      )
        add({ step: { op: "check", name: "waiting", i: 1 } });
      if (f.type === "message_start" && f.message?.customType === "subagent-notify")
        add({ step: { op: "check", name: "notified", i: 2 } });
    }
    const model = clip.find((r) => r.frame?.message?.role === "assistant").frame.message;
    if (model.provider !== "pi-e2e" || model.model !== "scenario")
      throw new Error("Not the offline E2E provider");
    const fixture = "pi-subagents-" + kind;
    const header = {
      backend: "pi",
      fixture,
      description,
      source: "pi-deterministic E2E / Pi RPC excerpt",
      model: "pi-e2e/scenario",
      recordedAt: new Date(clip.at(-1).at).toISOString(),
    };
    writeJsonl(path.join(snap, "pi", `${fixture}.jsonl`), [{ header }, ...entries]);
  }
}
export function captureScenario(snap, widgets = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scenario-"));
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const tap = new URL("./pi-scenario-tap.mjs", import.meta.url);
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.e2e.config.mjs",
        "tests/e2e/pi-deterministic.test.ts",
      ],
      {
        cwd: path.join(root, "service"),
        env: { ...process.env, PI_CAPTURE_SCENARIO: dir, NODE_OPTIONS: `--import=${tap.href}` },
        timeout: 210000,
        stdio: "inherit",
      },
    );
    const sessions = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readJsonl(path.join(dir, name)));
    if (widgets) {
      const { piSubagentsRoot } = discoverLocalPiPackages();
      const cli = execFileSync(process.env.PI_BINARY ?? "pi", ["--version"], {
        encoding: "utf8",
      }).trim();
      const { version: piSubagents } = JSON.parse(
        fs.readFileSync(path.join(piSubagentsRoot, "package.json"), "utf8"),
      );
      extractScenarioWidgets(sessions, snap, { cli, piSubagents });
    } else {
      const files = new Map(
        readJsonl(path.join(dir, "files.ndjson")).map(({ file, data }) => [file, data]),
      );
      extract(sessions, files, snap);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
