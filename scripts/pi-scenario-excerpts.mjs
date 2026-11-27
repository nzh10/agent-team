// Compose only observed scenario frames. Replay markers are not wire data.
import { writeJsonl } from "./capture-io.ts";
import path from "node:path";
import { sanitizer } from "./capture-pi.ts";

export function moreExcerpts(sessions, snap) {
  function turn(prompt) {
    const s = sessions.find((rows) => rows.some((r) => r.sent?.message === prompt));
    const start = s.findIndex((r) => r.sent?.message === prompt);
    const end = s.findIndex((r, i) => i > start && r.frame?.command === "get_session_stats");
    if (end < 0) throw new Error("Unsettled E2E excerpt");
    return s.slice(start, end + 1);
  }
  function tape(fixture, description, source) {
    const entries = [],
      clean = sanitizer();
    let i = 0,
      last,
      t;
    return {
      tick(at) {
        t = entries.length ? entries.at(-1).t + Math.max(0, at - last) : 0;
        last = at;
      },
      step(step) {
        entries.push({ t, step: { i: i++, ...step } });
      },
      sent(sent) {
        entries.push({ t, sent });
      },
      frame(f, overrides = {}) {
        const raw = { ...f };
        if (f.type === "response") delete raw.id;
        entries.push({ t, frame: { ...clean(raw), ...overrides } });
      },
      crash() {
        entries.push({ t, close: true });
      },
      save() {
        const header = {
          backend: "pi",
          fixture,
          description,
          source,
          model: "pi-e2e/scenario",
          recordedAt: new Date(last).toISOString(),
        };
        writeJsonl(path.join(snap, "pi", `${fixture}.jsonl`), [{ header }, ...entries]);
      },
    };
  }
  const ready = "pi-e2e-git-ready",
    launch = "pi-e2e-launch:foreground",
    recover = "check retained notices";
  const crash = tape(
    "crash-and-restore",
    "A Pi crash closes open work and does not re-send an unaccepted prompt; the saved session resumes.",
    "pi-deterministic E2E excerpts; injected loss of acceptance, EOF and restart",
  );
  for (const prompt of [ready, launch, recover]) {
    for (const { at, frame: f, sent } of turn(prompt)) {
      crash.tick(at);
      if (sent?.type === "prompt") {
        crash.step({ op: "send", text: prompt });
        crash.sent({ type: "prompt", message: prompt });
        continue;
      }
      if (prompt === launch) {
        // Lose the prompt receipt + user echo while tools remain in flight.
        if (f?.type === "agent_start" || f?.type === "tool_execution_start") crash.frame(f);
        if (f?.type === "tool_execution_start" && f.toolName === "subagent_launch") {
          crash.step({ op: "check", name: "beforeCrash" });
          crash.crash();
          crash.step({ op: "check", name: "afterCrash" });
          break;
        }
      } else if (sent?.type === "get_session_stats") crash.sent({ type: sent.type });
      else if (
        f &&
        (f.type !== "response" || ["prompt", "get_session_stats"].includes(f.command))
      ) {
        crash.frame(f);
        if (prompt === recover && f.type === "message_end" && f.message.role === "user")
          crash.step({ op: "check", name: "restored" });
      }
    }
  }
  crash.save();
  // Select one real call from each turn. The replay runs its actual handler
  // against a fresh Project; no captured filesystem or journal is installed.
  const panel = tape(
    "panel-tools-roundtrip",
    "Recorded Panel calls persist Notes, Board and Journal effects through HTTP.",
    "three pi-deterministic E2E turn excerpts; real Panel HTTP handlers at tool anchors",
  );
  for (const [prompt, tool, callId, expected] of [
    [
      "pi-e2e-lead-plan",
      "write_objective",
      "objective",
      { id: "pi-e2e/suite", title: "Pi E2E", goal: "run scenario" },
    ],
    [
      "[From the project lead]\n\npi-e2e-worker-notes",
      "write_note",
      "note",
      { slug: "design", content: "pi-e2e note body", expected_version: null },
    ],
    [
      "pi-e2e-finish",
      "finish_task",
      "report",
      { summary: "pi-e2e-worker-report", context: "reviewed by scenario" },
    ],
  ]) {
    let called = false;
    for (const { at, frame: f, sent } of turn(prompt)) {
      panel.tick(at);
      if (sent?.type === "prompt") {
        panel.step({ op: "send", text: prompt });
        panel.sent({ type: "prompt", message: prompt });
      } else if (sent?.type === "get_session_stats") panel.sent({ type: sent.type });
      else if (f?.type === "tool_execution_start" && f.toolName === tool && !called) {
        if (JSON.stringify(expected) !== JSON.stringify(f.args))
          throw new Error("Unreviewed panel arguments");
        panel.frame(f, { toolName: tool, toolCallId: callId, args: f.args });
        panel.step({ op: "panelCall", callId });
        called = true;
      } else if (
        f &&
        (f.type === "response" ||
          ["agent_start", "agent_settled"].includes(f.type) ||
          (f.type === "message_end" &&
            (f.message.role === "user" || f.message.stopReason === "stop")))
      )
        panel.frame(f);
    }
    if (!called) throw new Error("No matching Panel call");
  }
  panel.save();
}
