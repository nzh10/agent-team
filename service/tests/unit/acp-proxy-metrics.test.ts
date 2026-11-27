import { chmod, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ProxyMetrics, type MetricRow } from "../../src/acp-proxy/metrics";

const row: MetricRow = {
  ts: "2026-01-01T00:00:00.000Z",
  reqId: "test",
  path: "/v1/messages",
  model: "test-model",
  isStream: false,
  httpProto: "h2",
  connReused: false,
  tlsHandshakeMs: null,
  ttfbMs: 5,
  totalMs: 10,
  statusCode: 200,
  bytesIn: 100,
  bytesOut: 20,
  attempts: 1,
  proxyRetryRecovered: false,
  circuitBreakerTripped: false,
  errorClass: null,
  errorElapsedMs: null,
  pingRttMs: null,
};

let baseDir: string;
let logPath: string;
beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "ccpa-proxy-metrics-"));
  logPath = join(baseDir, ".agent-team", "ccpa-proxy-metrics.jsonl");
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

it("flushes JSONL in record order with owner-only permissions", async () => {
  const metrics = new ProxyMetrics(baseDir);
  const second = { ...row, reqId: "second" };
  metrics.record(row);
  metrics.record(second);
  await metrics.close();
  metrics.record({ ...row, reqId: "ignored-after-close" });

  expect(await readFile(logPath, "utf8")).toBe(
    `${JSON.stringify(row)}\n${JSON.stringify(second)}\n`,
  );
  // Windows uses directory ACLs, not POSIX group/other mode bits.
  if (process.platform !== "win32") expect((await stat(logPath)).mode & 0o777).toBe(0o600);
});

it("rotates before exceeding the size cap and keeps exactly one backup", async () => {
  const first = new ProxyMetrics(baseDir);
  first.record(row);
  await first.close();
  const limit = 8 * 1024 * 1024;
  await truncate(logPath, limit);
  if (process.platform !== "win32") await chmod(logPath, 0o644);
  await writeFile(`${logPath}.1`, "old backup");

  const metrics = new ProxyMetrics(baseDir);
  metrics.record(row);
  await metrics.close();
  expect(await readFile(logPath, "utf8")).toBe(`${JSON.stringify(row)}\n`);
  expect((await readdir(join(baseDir, ".agent-team"))).sort()).toEqual([
    "ccpa-proxy-metrics.jsonl",
    "ccpa-proxy-metrics.jsonl.1",
  ]);
  const backup = await stat(`${logPath}.1`);
  expect(backup.size).toBe(limit);
  if (process.platform !== "win32") {
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect(backup.mode & 0o777).toBe(0o600);
  }
});

it("splits a queued batch cleanly across the rotation boundary", async () => {
  const first = new ProxyMetrics(baseDir);
  first.record(row);
  await first.close();
  const second = { ...row, reqId: "before-rotate" };
  const third = { ...row, reqId: "after-rotate" };
  const secondBytes = Buffer.byteLength(`${JSON.stringify(second)}\n`);
  const limit = 8 * 1024 * 1024;
  await truncate(logPath, limit - secondBytes);

  const metrics = new ProxyMetrics(baseDir);
  metrics.record(second);
  metrics.record(third);
  await metrics.close();

  expect(await readFile(logPath, "utf8")).toBe(`${JSON.stringify(third)}\n`);
  expect((await stat(`${logPath}.1`)).size).toBe(limit);
});

it("bounds the disk backlog separately from the rolling health window", async () => {
  const metrics = new ProxyMetrics(baseDir);
  metrics.record({ ...row, model: "aged-out", circuitBreakerTripped: true });
  for (let i = 0; i < 1023; i++) metrics.record({ ...row, reqId: String(i) });
  metrics.record({
    ...row,
    model: "__proto__",
    errorClass: "constructor",
    connReused: true,
    proxyRetryRecovered: true,
    circuitBreakerTripped: true,
  });
  expect(metrics.health(2, 7)).toEqual({
    totalRequests: 1024,
    activeH2Sessions: 2,
    lastPingRttMs: 7,
    connectionReuseRate: 1 / 1024,
    retryRecoveries: 1,
    circuitBreakerTrips: 1,
    perModel: { "test-model": 1023, ["__proto__"]: 1 },
    errors: { constructor: 1 },
  });
  await metrics.close();
  const lineCount = (await readFile(logPath, "utf8")).trimEnd().split("\n").length;
  expect(lineCount).toBeLessThanOrEqual(257);
});

it("drops oversized log rows without dropping their health counts", async () => {
  const metrics = new ProxyMetrics(baseDir);
  metrics.record({ ...row, path: `/${"x".repeat(16 * 1024)}` });
  metrics.record(row);
  await metrics.close();
  expect(await readFile(logPath, "utf8")).toBe(`${JSON.stringify(row)}\n`);
  expect(metrics.health(0, null).totalRequests).toBe(2);
});

it("keeps health available when the log directory cannot be created", async () => {
  await writeFile(join(baseDir, ".agent-team"), "not a directory");
  const metrics = new ProxyMetrics(baseDir);
  expect(metrics.health(0, null).connectionReuseRate).toBe(0);
  metrics.record(row);
  await metrics.close();
  expect(metrics.health(0, null).perModel).toEqual({ "test-model": 1 });
});
