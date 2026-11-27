import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, vi, beforeEach, afterEach } from "vitest";
import { ACP_PREPARE_STEP } from "../../src/session/acp-readiness";
import piQuota from "../../src/session/pi-quota";
import {
  ACP,
  NATIVE_CODEX,
  QUOTA_AUTO_REFRESH_INTERVAL,
  QUOTA_MANUAL_REFRESH_THROTTLE,
  SNAPSHOT_EVENT,
  REFRESH_EVENT,
  unavailable,
  type QuotaSnapshot,
  type QuotaState,
} from "../../src/session/quota-schema";
import { QuotaMonitor as Monitor } from "../../src/server/quota";
import { codexQuota, CodexQuotaSource } from "../../src/server/native-codex-quota";
import * as codex from "../../src/session/codex";
import * as codexRpc from "../../src/session/codex-rpc";
import { QuotaAdapterRegistry } from "../../src/session/quota/registry";
import type { PiQuotaContext } from "../../src/session/quota/pi-context";
type Reader = () => Promise<QuotaSnapshot>;
const unavailableCodexReader: Reader = () => Promise.resolve(unavailable(NATIVE_CODEX));
class TestQuotaMonitor extends Monitor<(Reader | undefined)[]> {
  constructor(changed: (state: QuotaState) => void = () => {}) {
    super(
      changed,
      new QuotaAdapterRegistry(
        [NATIVE_CODEX, ACP].map((id, i) => ({
          id,
          isConfigured: (ctx) => !!ctx[i],
          fetchQuota: (ctx) => ctx[i]!(),
        })),
      ),
    );
  }
}
function monitor() {
  const q = new TestQuotaMonitor();
  return {
    accept: (s: QuotaSnapshot) => q.accept(s),
    state: () => q.state(),
    refresh: (...readers: Reader[]) => q.refresh(() => readers),
  };
}

type AcpQuotaRequest = { reply: (raw: unknown) => void };
type PanelQuotaRefresh = {
  provider: string;
  reply: (snapshot: QuotaSnapshot) => void;
  force?: boolean;
};

function piQuotaFixture() {
  const modelRegistry: PiQuotaContext["modelRegistry"] = {
    getProvider: () => true,
    getAll: () => [],
    isUsingOAuth: () => false,
    getProviderAuthStatus: () => ({ configured: false }),
    getProviderAuth: () => Promise.resolve(undefined),
  };
  const events = new EventEmitter();
  let command!: Parameters<Parameters<typeof piQuota>[0]["registerCommand"]>[1];
  const notify = vi.fn();
  piQuota({
    events,
    on(_e, handler) {
      handler({}, { modelRegistry, ui: { notify } });
    },
    registerCommand(name, cmd) {
      expect(name).toBe("quota");
      command = cmd;
    },
  });
  const snapshots: QuotaSnapshot[] = [];
  events.on(SNAPSHOT_EVENT, (s) => snapshots.push(s as QuotaSnapshot));
  const requestEvent = "antigravity-acp:quota:request";
  return {
    onAcpRequest: (handler: (request: AcpQuotaRequest) => void) => events.on(requestEvent, handler),
    replyToNextAcpRequest: (raw: unknown) =>
      events.once(requestEvent, ({ reply }: AcpQuotaRequest) => reply(raw)),
    emitPanelRefresh: (request: PanelQuotaRefresh) => events.emit(REFRESH_EVENT, request),
    refreshFromPanel: (request: PanelQuotaRefresh): unknown =>
      events.listeners(REFRESH_EVENT)[0](request),
    notify,
    snapshots,
    run: (provider = ACP as string) =>
      command.handler("", { modelRegistry, model: { provider }, ui: { notify } }),
  };
}
function availableAcpReply() {
  return {
    ok: true,
    quota: {
      at: Date.now(),
      groups: [{ displayName: "A", buckets: [{ window: "5h", remainingFraction: 0.2 }] }],
    },
  };
}

let runtimeDir: string;
beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-quota-test-"));
  const runtime = path.join(runtimeDir, "agy");
  fs.writeFileSync(runtime, "not run", { mode: 0o700 });
  vi.stubEnv("AGY_ACP_BIN", runtime);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

it("skips unavailable ACP quota on both routes and retries on the same Pi once the runtime appears", async () => {
  const runtime = path.join(runtimeDir, "later");
  vi.stubEnv("AGY_ACP_BIN", runtime);
  const { onAcpRequest, refreshFromPanel, notify, run } = piQuotaFixture();
  const request = vi.fn(({ reply }: AcpQuotaRequest) => reply(availableAcpReply()));
  onAcpRequest(request);
  const reply = vi.fn();
  await run();
  await refreshFromPanel({ provider: ACP, reply });
  expect(request).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining(ACP_PREPARE_STEP), "warning");
  expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ availability: "unavailable" }));

  fs.writeFileSync(runtime, "not run", { mode: 0o700 });
  await refreshFromPanel({ provider: ACP, reply });
  expect(request).toHaveBeenCalledOnce();
  expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ availability: "available" }));
});

it("shares the provider read between command, panel control and cached requests, publishing only quota fields", async () => {
  const { emitPanelRefresh, onAcpRequest, run, notify, snapshots } = piQuotaFixture();
  const requests: AcpQuotaRequest[] = [];
  onAcpRequest((req) => requests.push(req));
  const cmd = run();
  const ack = vi.fn();
  emitPanelRefresh({ provider: ACP, reply: ack });
  await Promise.resolve();
  const at = Date.now();
  const reset = "2027-01-01T10:00:00Z";
  requests[0].reply({
    ok: true,
    headers: "secret",
    quota: {
      at,
      groups: [
        { displayName: "Available only", buckets: [] },
        {
          displayName: "Gemini",
          buckets: [{ window: "5h", remainingFraction: 0.79, resetTime: reset }],
        },
      ],
    },
  });
  await cmd;
  expect(requests).toHaveLength(1);
  const expected = {
    provider: ACP,
    observedAt: at,
    availability: "available",
    groups: [
      { name: "Gemini", windows: [{ label: "5h", usedPct: 21, resetsAt: Date.parse(reset) }] },
    ],
  };
  expect(ack).toHaveBeenCalledWith(expected);
  expect(snapshots).toContainEqual(expected);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Gemini · 5h: 21% used"), "info");
});
it("does not bypass provider cache invalidation after logout", async () => {
  const f = piQuotaFixture();
  let loggedIn = true;
  f.onAcpRequest(({ reply }) =>
    reply(loggedIn ? availableAcpReply() : { ok: false, error: "signed out" }),
  );
  await f.run();
  loggedIn = false;
  await f.run();
  expect(f.snapshots.filter((s) => s.provider === ACP).map((s) => s.availability)).toEqual([
    "available",
    "unavailable",
  ]);
});
it("reports unsupported providers without probing; errors, missing listeners and malformed fractions are unavailable", async () => {
  vi.useFakeTimers();
  const f = piQuotaFixture();
  f.replyToNextAcpRequest({ ok: false });
  await f.run("unknown-provider");
  expect(f.snapshots.find((s) => s.provider === "unknown-provider")).toMatchObject({
    provider: "unknown-provider",
    availability: "unsupported",
    groups: [],
  });
  const cmd = f.run();
  await vi.advanceTimersByTimeAsync(45_000);
  await cmd;
  for (const raw of [
    { ok: false, error: "SECRET" },
    {
      ok: true,
      quota: {
        at: Date.now(),
        groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: -1 }] }],
      },
    },
  ]) {
    await vi.advanceTimersByTimeAsync(QUOTA_AUTO_REFRESH_INTERVAL);
    f.replyToNextAcpRequest(raw);
    await f.run();
  }
  expect(
    f.snapshots
      .filter((s) => s.provider === ACP)
      .slice(1)
      .map((s) => s.availability),
  ).toEqual(Array(3).fill("unavailable"));
  expect(JSON.stringify(f.snapshots)).not.toContain("SECRET");
});
function group(at: number, name: string, pct: number): QuotaSnapshot {
  return {
    provider: ACP,
    observedAt: at,
    availability: "available",
    groups: [{ name, windows: [{ label: "5h", usedPct: pct }] }],
  };
}
it("merges per group, rejects older reports and keeps independent last-known values when readers disappear", async () => {
  const q = monitor();
  const now = Date.now();
  q.accept(group(now, "A", 31));
  q.accept(group(now - 10, "B", 54));
  q.accept(group(now - 5, "A", 99));
  const native = codexQuota(
    {
      primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 123 },
      secondary: null,
      limitId: "account",
      planType: null,
    },
    now,
  );
  await q.refresh(() => Promise.resolve(native));
  expect(q.state().rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: NATIVE_CODEX,
        windows: [{ label: "5h", usedPct: 41, resetsAt: 123000 }],
      }),
      expect.objectContaining({
        name: "A",
        observedAt: now,
        availability: "unavailable",
        reason: "not configured",
        windows: [{ label: "5h", usedPct: 31 }],
      }),
      expect.objectContaining({ name: "B", observedAt: now - 10 }),
    ]),
  );
});
it("does not revive an unavailable row with a delayed duplicate", async () => {
  const q = monitor();
  const sample = group(Date.now() - 10, "A", 3);
  q.accept(sample);
  await q.refresh(unavailableCodexReader);
  q.accept(sample);
  expect(q.state().rows.find((r) => r.name === "A")?.availability).toBe("unavailable");
});
it.each([0, 10])(
  "a reconnected reader can confirm a cached observation (%d ms older) without changing its age or values",
  async (lag) => {
    const q = monitor();
    const now = Date.now();
    const sample = group(now - 10, "A", 3);
    q.accept(sample);
    await q.refresh(unavailableCodexReader);
    await q.refresh(unavailableCodexReader, () =>
      Promise.resolve(lag ? group(sample.observedAt - lag, "A", 81) : sample),
    );
    expect(q.state().rows.find((r) => r.name === "A")).toMatchObject({
      availability: "available",
      windows: [{ label: "5h", usedPct: 3 }],
      observedAt: now - 10,
    });
  },
);
it("makes room for current groups and providers at capacity", () => {
  const q = monitor();
  const now = Date.now();
  for (let i = 0; i < 32; i++) q.accept(group(now - 1, `g${i}`, 1));
  q.accept(group(now, "new", 1));
  expect(q.state().rows.map((r) => r.name)).toContain("new");
  for (let i = 0; i < 32; i++) q.accept(unavailable(`p${i}`, now));
  expect(q.state().rows.map((r) => r.provider)).toContain("p31");
});
it("merges sparse native windows received from independent sessions", () => {
  const q = monitor();
  const at = Date.now();
  const full = {
    primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: null },
    secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: null },
    limitId: "codex",
    planType: null,
  };
  const source = new CodexQuotaSource();
  q.accept(source.snapshot(full, at - 1));
  q.accept(source.snapshot({ ...full, primary: null }, at, true));
  expect(q.state().rows.find((r) => r.provider === NATIVE_CODEX)?.windows).toHaveLength(2);
});
it("refreshes a stale group even with a fresh sibling", async () => {
  const q = monitor(),
    now = Date.now();
  q.accept(group(now - 2 * QUOTA_AUTO_REFRESH_INTERVAL, "old", 5));
  q.accept(group(now, "new", 90));
  const acp = vi.fn(() => Promise.resolve(group(Date.now(), "old", 55)));
  await q.refresh(unavailableCodexReader, acp);
  expect(acp).toHaveBeenCalledTimes(1);
});
it("returns the async refresh chain to the event bus for reload error handling", async () => {
  const f = piQuotaFixture();
  f.onAcpRequest(({ reply }) => reply({ ok: false }));
  const result = f.refreshFromPanel({ provider: ACP, reply: () => {} });
  expect(result).toBeInstanceOf(Promise);
  await result;
});
it("propagates a forced panel refresh to the Pi adapter registry", async () => {
  const f = piQuotaFixture();
  const read = vi.spyOn(QuotaAdapterRegistry.prototype, "read");
  f.replyToNextAcpRequest({ ok: false });
  await f.refreshFromPanel({ provider: ACP, force: true, reply: () => {} });
  expect(read).toHaveBeenCalledWith(ACP, expect.anything(), undefined, { force: true });
});

it("limits refresh to one in flight and one read per auto-refresh interval independently of passive native events", async () => {
  vi.useFakeTimers();
  const q = monitor();
  const codex = vi.fn(unavailableCodexReader);
  const acp = vi.fn(() => Promise.resolve(group(Date.now(), "A", 41)));
  await Promise.all([q.refresh(codex, acp), q.refresh(codex, acp)]);
  await q.refresh(codex, acp);
  expect(acp).toHaveBeenCalledTimes(1);
  expect(codex).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(QUOTA_AUTO_REFRESH_INTERVAL);
  await q.refresh(codex, acp);
  expect(acp).toHaveBeenCalledTimes(2);
  expect(q.state().rows.find((r) => r.provider === ACP)?.availability).toBe("available");
});

it("separates the automatic interval from the manual force throttle without no-op broadcasts", async () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const q = new TestQuotaMonitor(changed);
  const acp = vi.fn(() => Promise.resolve(group(Date.now(), "A", 41)));
  const readers = () => [undefined, acp];
  await q.refresh(readers);
  expect(acp).toHaveBeenCalledTimes(1);

  changed.mockClear();
  await q.refresh(readers);
  await q.refresh(readers, { force: true, providers: [ACP] });
  expect(acp).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalledWith(expect.objectContaining({ refreshing: true }));

  await vi.advanceTimersByTimeAsync(QUOTA_MANUAL_REFRESH_THROTTLE);
  await q.refresh(readers, { force: true, providers: [ACP] });
  expect(acp).toHaveBeenCalledTimes(2);

  changed.mockClear();
  await q.refresh(readers, { providers: [ACP] });
  expect(acp).toHaveBeenCalledTimes(2);
  expect(changed).not.toHaveBeenCalledWith(expect.objectContaining({ refreshing: true }));

  await vi.advanceTimersByTimeAsync(QUOTA_AUTO_REFRESH_INTERVAL);
  await q.refresh(readers, { providers: [ACP] });
  expect(acp).toHaveBeenCalledTimes(3);
});

it("keeps a forced provider refresh queued behind an in-flight read", async () => {
  vi.useFakeTimers();
  const q = new TestQuotaMonitor();
  let finish!: (sample: QuotaSnapshot) => void;
  const acp = vi
    .fn<Reader>()
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    .mockResolvedValueOnce(group(Date.now(), "A", 22));
  const readers = () => [undefined, acp];
  const active = q.refresh(readers, { providers: [ACP] });
  await q.refresh(readers, { force: true, providers: [ACP] });
  await vi.advanceTimersByTimeAsync(QUOTA_MANUAL_REFRESH_THROTTLE);
  finish(group(Date.now(), "A", 11));
  await active;
  expect(acp).toHaveBeenCalledTimes(2);
});

it("does not upgrade unrelated queued providers to a forced refresh", async () => {
  vi.useFakeTimers();
  const q = new TestQuotaMonitor();
  let finishAcp!: (sample: QuotaSnapshot) => void;
  const acp = vi
    .fn<Reader>()
    .mockImplementationOnce(() => new Promise((resolve) => (finishAcp = resolve)))
    .mockResolvedValue(group(Date.now(), "A", 22));
  const native = vi.fn(() =>
    Promise.resolve({ ...group(Date.now(), "Native", 7), provider: NATIVE_CODEX }),
  );
  const readers = () => [native, acp];
  await q.refresh(readers, { providers: [NATIVE_CODEX] });
  await vi.advanceTimersByTimeAsync(10_000);

  const active = q.refresh(readers, { providers: [ACP] });
  await q.refresh(readers, { force: true, providers: [ACP] });
  await q.refresh(readers);
  await vi.advanceTimersByTimeAsync(QUOTA_MANUAL_REFRESH_THROTTLE);
  finishAcp(group(Date.now(), "A", 11));
  await active;

  expect(acp).toHaveBeenCalledTimes(2);
  expect(native).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "preserves a full refresh during an ACP-only read (another ACP-only refresh queued last: %s)",
  async (targetedLast) => {
    const q = new TestQuotaMonitor();
    let finishAcp!: (sample: QuotaSnapshot) => void;
    const pending = new Promise<QuotaSnapshot>((resolve) => (finishAcp = resolve));
    const acp = vi.fn(() => pending);
    const codex = vi.fn(() =>
      Promise.resolve({ ...group(Date.now(), "Codex plan", 7), provider: NATIVE_CODEX }),
    );
    const readers = () => [codex, acp];
    const active = q.refresh(readers, { providers: [ACP] });
    await q.refresh(readers);
    if (targetedLast) await q.refresh(readers, { providers: [ACP] });
    expect(codex).not.toHaveBeenCalled();
    finishAcp(group(Date.now(), "ACP plan", 23));
    await active;
    expect(acp).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledTimes(1);
    expect(q.state().rows.every((row) => row.availability === "available")).toBe(true);
  },
);

it("retries only the transient provider after TTL with bounded backoff, preserving its last sample", async () => {
  vi.useFakeTimers();
  const q = new TestQuotaMonitor();
  const old = Date.now() - QUOTA_AUTO_REFRESH_INTERVAL;
  q.accept(group(old, "ACP plan", 42));
  const codex = vi.fn(() =>
    Promise.resolve({ ...group(Date.now(), "Codex plan", 7), provider: NATIVE_CODEX }),
  );
  const acp = vi.fn().mockRejectedValue(new Error("temporary failure"));
  const readers = () => [codex, acp];
  await q.refresh(readers);
  expect(q.state().rows.find((r) => r.provider === ACP)).toMatchObject({
    observedAt: old,
    reason: "usage unavailable",
    windows: [{ label: "5h", usedPct: 42 }],
  });
  await vi.advanceTimersByTimeAsync(QUOTA_AUTO_REFRESH_INTERVAL - 1);
  await q.refresh(readers);
  expect(acp).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(acp).toHaveBeenCalledTimes(2);
  acp.mockImplementation(() => Promise.resolve(group(Date.now(), "ACP plan", 26)));
  await vi.advanceTimersByTimeAsync(2 * QUOTA_AUTO_REFRESH_INTERVAL - 1);
  expect(acp).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(acp).toHaveBeenCalledTimes(3);
  expect(q.state().rows.find((r) => r.provider === ACP)).toMatchObject({
    availability: "available",
    windows: [{ label: "5h", usedPct: 26 }],
  });
  await vi.advanceTimersByTimeAsync(10 * QUOTA_AUTO_REFRESH_INTERVAL);
  expect(acp).toHaveBeenCalledTimes(3);
  expect(codex).toHaveBeenCalledTimes(1);
});

it("exhausts transient retries and does not retry an unconfigured provider", async () => {
  vi.useFakeTimers();
  const q = new TestQuotaMonitor();
  const codex = vi.fn(() =>
    Promise.resolve({ ...unavailable(NATIVE_CODEX), reason: "not configured" as const }),
  );
  const acp = vi.fn().mockRejectedValue(new Error("retryable"));
  await q.refresh(() => [codex, acp]);
  await vi.advanceTimersByTimeAsync(10 * QUOTA_AUTO_REFRESH_INTERVAL);
  expect(codex).toHaveBeenCalledTimes(1);
  expect(acp).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops retrying a provider once a passive sample restores it", async () => {
  vi.useFakeTimers();
  const q = new TestQuotaMonitor();
  const acp = vi.fn().mockRejectedValue(new Error("retryable"));
  await q.refresh(() => [undefined, acp]);
  await vi.advanceTimersByTimeAsync(1);
  q.accept(group(Date.now(), "ACP plan", 23));
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(QUOTA_AUTO_REFRESH_INTERVAL);
  expect(acp).toHaveBeenCalledTimes(1);
});

it("stops scheduled retries, queued refreshes and active registry waits on shutdown", async () => {
  vi.useFakeTimers();
  const codex = vi.fn().mockRejectedValue(new Error("retryable"));
  let signal: AbortSignal | undefined;
  const acp = vi.fn((_ctx: boolean, abort: AbortSignal) => {
    signal = abort;
    return new Promise<QuotaSnapshot>(() => {});
  });
  const source = new QuotaAdapterRegistry<boolean>([
    { id: NATIVE_CODEX, isConfigured: () => true, fetchQuota: codex },
    { id: ACP, isConfigured: (ready) => ready, fetchQuota: acp },
  ]);
  const q = new Monitor(() => {}, source);
  await q.refresh(() => false);
  const active = q.refresh(() => true, { newlyReadable: [ACP] });
  await Promise.resolve();
  await q.refresh(() => true, { newlyReadable: [NATIVE_CODEX] });
  q.stop();
  await active;
  expect(signal?.aborted).toBe(true);
  expect(q.state().refreshing).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10 * QUOTA_AUTO_REFRESH_INTERVAL);
  expect(codex).toHaveBeenCalledTimes(1);
  expect(acp).toHaveBeenCalledTimes(1);
});

it("closes the Codex quota app-server on shutdown without waiting for RPC or timeout", async () => {
  vi.useFakeTimers();
  let reply: ((msg: codexRpc.RpcMessage) => void) | undefined;
  let disconnect: ((reason: string) => void) | undefined;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => (markReadStarted = resolve));
  const write = vi.fn((msg: codexRpc.RpcMessage) => {
    if (msg.method === "initialize") reply?.({ id: msg.id, result: {} });
    if (msg.method === "account/rateLimits/read") markReadStarted();
  });
  const close = vi.fn(() => disconnect?.("closed"));
  vi.spyOn(codexRpc, "spawnAppServer").mockReturnValue({
    write,
    close,
    onMessage: (cb) => (reply = cb),
    onClose: (cb) => (disconnect = cb),
  });
  const source = new CodexQuotaSource();
  const q = new Monitor(() => {}, new QuotaAdapterRegistry([source]));
  const ongoing = q.refresh(() => undefined);
  await readStarted;
  expect(close).not.toHaveBeenCalled();
  q.stop();
  await ongoing;
  expect(close).toHaveBeenCalledTimes(1);
  expect(write.mock.calls.map(([msg]) => msg.method)).toEqual([
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not spawn a Codex quota app-server for an already cancelled read", async () => {
  const spawn = vi.spyOn(codexRpc, "spawnAppServer").mockImplementation(() => {
    throw new Error("Unexpected quota app-server spawn");
  });
  await expect(codex.readCodexRateLimits({}, AbortSignal.abort())).resolves.toBeNull();
  expect(spawn).not.toHaveBeenCalled();
});

it("classifies an authenticated Codex read with no rate limit sample as transient", async () => {
  vi.spyOn(codex, "readCodexRateLimits").mockResolvedValue(null);
  expect(
    await new CodexQuotaSource().fetchQuota(undefined, new AbortController().signal),
  ).toMatchObject({
    provider: NATIVE_CODEX,
    availability: "unavailable",
    reason: "usage unavailable",
  });
});

it("gates CodexQuotaSource.isConfigured() on Codex auth state and recovers immediately once enabled", async () => {
  let authed = false;
  const source = new CodexQuotaSource(() => authed);
  const fetchSpy = vi.spyOn(source, "fetchQuota").mockResolvedValue(
    codexQuota(
      {
        primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        limitId: "codex",
        planType: null,
      },
      Date.now(),
    ),
  );
  const registry = new QuotaAdapterRegistry<undefined>([source]);
  const mon = new Monitor(() => {}, registry);

  expect(source.isConfigured()).toBe(false);
  await mon.refresh(() => undefined);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mon.state().rows).toEqual([
    expect.objectContaining({
      provider: NATIVE_CODEX,
      availability: "unavailable",
      reason: "not configured",
    }),
  ]);

  authed = true;
  expect(source.isConfigured()).toBe(true);
  await mon.refresh(() => undefined, { newlyReadable: [NATIVE_CODEX] });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(mon.state().rows).toEqual([
    expect.objectContaining({
      provider: NATIVE_CODEX,
      availability: "available",
      windows: [{ label: "5h", usedPct: 18 }],
    }),
  ]);
});
