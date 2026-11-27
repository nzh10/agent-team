import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { TelemetryEvent } from "../../../shared/telemetry";
import { Server } from "../../src/server/server";
import { TelemetryStore } from "../../src/storage/telemetry";

const DAY = 86_400_000;
const run = "a".repeat(32);
const event = (ts: number, outcome: TelemetryEvent["outcome"] = "open"): TelemetryEvent => ({
  ts,
  layout: "wide",
  action: "confirm.clear_context",
  outcome,
});

let dir: string;
let file: string;
let server: Server | undefined;
let store: TelemetryStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaat-telemetry-"));
  file = join(dir, "telemetry.db");
});
afterEach(async () => {
  try {
    await server?.close();
    store?.close();
  } finally {
    server = store = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});

function setEnabled(enabled: boolean) {
  writeFileSync(join(dir, "config.toml"), `[telemetry]\nenabled = ${enabled}\n`);
}

async function start(enabled: boolean) {
  setEnabled(enabled);
  server = new Server(0, dir, dir);
  const origin = `http://127.0.0.1:${await server.listening}`;
  return {
    origin,
    post: (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${origin}/api/telemetry`, {
        method: "POST",
        headers: { origin, "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    summary: (query = "") => fetch(`${origin}/api/telemetry/summary${query}`),
  };
}

const files = () => readdirSync(dir).filter((name) => name.startsWith("telemetry.db"));

describe("server telemetry", () => {
  it("ignores requests without creating database files when disabled", async () => {
    const api = await start(false);
    expect((await api.post({ tab_run_id: run, events: [event(Date.now())] })).status).toBe(204);
    expect(await (await api.summary()).json()).toEqual({
      enabled: false,
      days: 30,
      counts: [],
      transitions: [],
      recentChains: [],
    });
    expect(files()).toEqual([]);
  });

  it("rejects unsafe request shapes without even opening the DB", async () => {
    const api = await start(true);
    const step = event(Date.now());
    const body = { tab_run_id: run, events: [step] };
    expect((await api.summary("?days=366")).status).toBe(400);
    expect(await (await api.summary()).json()).toMatchObject({ enabled: true, counts: [] });
    expect((await api.post(body, { origin: "https://other.example" })).status).toBe(403);
    expect((await api.post(body, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await api.post(body, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await api.post(" ".repeat(8193))).status).toBe(413);
    expect((await api.post("{")).status).toBe(400);
    for (const data of [
      { ...body, tab_run_id: "session-name" },
      { ...body, user: "name" },
      { ...body, events: Array(51).fill(step) },
      ...[
        { path: "/file" },
        { action: "chat.quote_jump", messageId: "private-message" },
        { ts: "123" },
        { action: "unknown" },
        { layout: "mobile" },
        { outcome: "close" },
      ].map((bad) => ({ ...body, events: [{ ...step, ...bad }] })),
    ])
      expect((await api.post(data)).status).toBe(400);
    expect(files()).toEqual([]);
  });

  it("accepts enumerated chat, trace, and workspace actions without changing older names", async () => {
    const api = await start(true);
    const actions = [
      "chat.file_link",
      "chat.send",
      "chat.stop",
      "chat.jump_latest",
      "chat.quote_jump",
      "chat.history_page",
      "chat.diagram_preview",
      "chat.cancel_queued",
      "chat.cancel_wakeup",
      "trace.step_toggle",
      "trace.subagent_toggle",
      "trace.subagent_page",
      "trace.tool_toggle",
      "trace.load_details",
      "workspace.archive",
      "workspace.restore",
    ] as const satisfies readonly TelemetryEvent["action"][];
    const events = actions.map((action) => ({ ...event(Date.now(), "trigger"), action }));
    expect((await api.post({ tab_run_id: run, events })).status).toBe(204);
    const invalid = { ...events[0], action: "chat.unknown" };
    expect((await api.post({ tab_run_id: run, events: [invalid] })).status).toBe(400);
    expect(await (await api.summary()).json()).toMatchObject({ recentChains: [events] });
  });

  it("announces config reloads and stops writes when switched off", async () => {
    const api = await start(true);
    const body = { tab_run_id: run, events: [event(Date.now())] };
    const client = new WebSocket(api.origin.replace(/^http:/, "ws:"));
    const messages: unknown[] = [];
    client.on("message", (data) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      messages.push(JSON.parse(bytes.toString()));
    });
    try {
      await expect
        .poll(() => messages)
        .toContainEqual(
          expect.objectContaining({
            type: "init",
            config: expect.objectContaining({ telemetryEnabled: true }) as unknown,
          }),
        );
      expect((await api.post(body)).status).toBe(204);
      setEnabled(false);
      await expect
        .poll(() => messages, { timeout: 4500 })
        .toContainEqual({
          type: "telemetry_config",
          telemetryEnabled: false,
        });
      expect((await api.post(body)).status).toBe(204);
      expect(files()).toEqual(["telemetry.db"]);
      using db = new DatabaseSync(file, { readOnly: true });
      expect(db.prepare("SELECT count(*) AS n FROM ui_events").get()).toEqual({ n: 1 });
    } finally {
      client.close();
    }
  }, 7000);

  it("persists WAL-backed writes and releases the database at shutdown", async () => {
    const api = await start(true);
    const step = event(Date.now());
    expect((await api.post({ tab_run_id: run, events: [step] })).status).toBe(204);
    expect(existsSync(`${file}-wal`)).toBe(true);
    await server!.close();
    expect(files()).toEqual(["telemetry.db"]);
    store = new TelemetryStore(dir, { enabled: true, retention_days: 30 });
    expect(store.summary(30).recentChains).toEqual([[step]]);
  });
});

it("preserves skewed timestamps and sorts events even if a final beacon arrives first", () => {
  const now = Date.now();
  const steps = [event(now + 10_000), event(now + 14_000, "cancel")];
  store = new TelemetryStore(dir, { enabled: true, retention_days: 30 });
  store.append({ tab_run_id: run, events: [steps[1], event(now + DAY)] }, now);
  store.append({ tab_run_id: run, events: [steps[0]] }, now);
  expect(store.summary(30, now).recentChains).toEqual([steps]);
  expect(store.summary(30, now).transitions).toMatchObject([
    { from_outcome: "open", to_outcome: "cancel", gap_bucket: "2-10s", count: 1 },
  ]);
});

it("keeps exactly-60-second ties together and retains only the latest ten action segments", () => {
  const now = Date.now();
  const steps = Array.from({ length: 11 }, (_, i) => event(now - (10 - i) * 121_000));
  const pair = [event(steps[10].ts - 60_000), event(steps[10].ts, "confirm")];
  store = new TelemetryStore(dir, { enabled: true, retention_days: 30 });
  store.append({ tab_run_id: run, events: [...steps, ...pair] }, now);
  expect(store.summary(30, now).recentChains).toEqual([
    [pair[0], steps[10], pair[1]],
    ...steps
      .slice(1, 10)
      .reverse()
      .map((step) => [step]),
  ]);
  expect(store.summary(30, now).transitions).toEqual([
    expect.objectContaining({ from_outcome: "open", to_outcome: "confirm", gap_bucket: "<2s" }),
    expect.objectContaining({ from_outcome: "open", to_outcome: "open", gap_bucket: "10-60s" }),
  ]);
});

it("prunes stored rows and summarizes consecutive events within each tab run", () => {
  const now = Date.now();
  const steps = [
    event(now - 76_000),
    event(now - 75_000, "cancel"),
    event(now - 71_000),
    event(now - 61_000, "confirm"),
    event(now, "open"),
  ];
  store = new TelemetryStore(dir, { enabled: true, retention_days: 30 });
  store.append({ tab_run_id: run, events: [event(now - 2 * DAY), steps[0]] }, now);
  store.append({ tab_run_id: "b".repeat(32), events: [event(now - 65000)] }, now);
  store.append({ tab_run_id: run, events: steps.slice(1) }, now);
  store.close();

  store = new TelemetryStore(dir, { enabled: true, retention_days: 1 });
  using db = new DatabaseSync(file, { readOnly: true });
  expect(db.prepare("SELECT count(*) AS n FROM ui_events").get()).toEqual({ n: 6 });
  const summary = store.summary(30, now);
  expect(summary.recentChains).toEqual([[steps[4]], steps.slice(0, 4), [event(now - 65000)]]);
  expect(summary.counts).toEqual(
    ["cancel", "confirm", "open"].map((outcome, i) => ({
      layout: "wide",
      action: "confirm.clear_context",
      outcome,
      count: i === 2 ? 4 : 1,
    })),
  );
  expect(
    summary.transitions.map((row) => [row.from_outcome, row.to_outcome, row.gap_bucket, row.count]),
  ).toEqual([
    ["cancel", "open", "2-10s", 1],
    ["open", "cancel", "<2s", 1],
    ["open", "confirm", "10-60s", 1],
  ]);
});
