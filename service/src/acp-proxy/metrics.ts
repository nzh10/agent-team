import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";

export interface MetricRow {
  ts: string;
  reqId: string;
  path: string;
  model: string;
  isStream: boolean;
  httpProto: string | null;
  connReused: boolean;
  tlsHandshakeMs: number | null;
  ttfbMs: number | null;
  totalMs: number;
  statusCode: number;
  bytesIn: number;
  bytesOut: number;
  attempts: number;
  proxyRetryRecovered: boolean;
  circuitBreakerTripped: boolean;
  errorClass: string | null;
  errorElapsedMs: number | null;
  pingRttMs: number | null;
}

export interface ProxyHealth {
  totalRequests: number;
  activeH2Sessions: number;
  lastPingRttMs: number | null;
  connectionReuseRate: number;
  retryRecoveries: number;
  circuitBreakerTrips: number;
  perModel: Record<string, number>;
  errors: Record<string, number>;
}

const healthWindow = 1024;
const maxPendingRows = 256;
const maxRowBytes = 16 * 1024;
const maxLogBytes = 8 * 1024 * 1024;
const appendFlags =
  constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;

function healthLabel(label: string): string {
  return label.length <= maxRowBytes ? label : "(oversized)";
}

type HealthRow = Pick<
  MetricRow,
  "model" | "errorClass" | "connReused" | "proxyRetryRecovered" | "circuitBreakerTripped"
>;

export class ProxyMetrics {
  private readonly logDir: string;
  private readonly logPath: string;
  private readonly recent: HealthRow[] = [];
  private nextRecent = 0;
  private readonly pending: { line: string; bytes: number }[] = [];
  private writer?: Promise<void>;
  private closed = false;

  constructor(baseDir: string) {
    this.logDir = join(baseDir, ".agent-team");
    this.logPath = join(this.logDir, "ccpa-proxy-metrics.jsonl");
  }

  record(row: MetricRow): void {
    if (this.closed) return;

    this.recent[this.nextRecent] = {
      model: healthLabel(row.model),
      errorClass: row.errorClass === null ? null : healthLabel(row.errorClass),
      connReused: row.connReused,
      proxyRetryRecovered: row.proxyRetryRecovered,
      circuitBreakerTripped: row.circuitBreakerTripped,
    };
    this.nextRecent = (this.nextRecent + 1) % healthWindow;

    if (this.pending.length >= maxPendingRows) return;
    const line = JSON.stringify(row) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > maxRowBytes) return;
    this.pending.push({ line, bytes });
    this.writer ??= this.drain();
  }

  health(activeH2Sessions: number, lastPingRttMs: number | null): ProxyHealth {
    const perModel = new Map<string, number>();
    const errors = new Map<string, number>();
    let reused = 0;
    let retryRecoveries = 0;
    let circuitBreakerTrips = 0;
    for (const row of this.recent) {
      perModel.set(row.model, (perModel.get(row.model) ?? 0) + 1);
      if (row.errorClass !== null)
        errors.set(row.errorClass, (errors.get(row.errorClass) ?? 0) + 1);
      if (row.connReused) reused++;
      if (row.proxyRetryRecovered) retryRecoveries++;
      if (row.circuitBreakerTripped) circuitBreakerTrips++;
    }
    return {
      totalRequests: this.recent.length,
      activeH2Sessions,
      lastPingRttMs,
      connectionReuseRate: this.recent.length ? reused / this.recent.length : 0,
      retryRecoveries,
      circuitBreakerTrips,
      perModel: Object.fromEntries(perModel),
      errors: Object.fromEntries(errors),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writer;
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      try {
        await this.appendBatch(batch);
      } catch {
        // Disk errors only drop the log batch; the proxy and health summary stay available.
      }
    }
    this.writer = undefined;
  }

  private async appendBatch(batch: { line: string; bytes: number }[]): Promise<void> {
    await mkdir(this.logDir, { recursive: true, mode: 0o700 });
    let offset = 0;
    while (offset < batch.length) {
      // Use a nonblocking open so an unexpected FIFO cannot hang shutdown.
      const file = await open(this.logPath, appendFlags | constants.O_NONBLOCK, 0o600);
      let rotate = false;
      try {
        const info = await file.stat();
        if (!info.isFile()) return;
        // Windows uses directory ACLs, not POSIX mode bits.
        if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
          await file.chmod(0o600);
        }
        let size = info.size;
        let chunk = "";
        while (offset < batch.length && size + batch[offset].bytes <= maxLogBytes) {
          chunk += batch[offset].line;
          size += batch[offset].bytes;
          offset++;
        }
        if (chunk) await file.appendFile(chunk);
        if (offset < batch.length) rotate = true;
      } finally {
        await file.close();
      }
      if (!rotate) return;
      await rename(this.logPath, `${this.logPath}.1`);
      const next = await open(this.logPath, appendFlags | constants.O_EXCL, 0o600);
      try {
        if (process.platform !== "win32") await next.chmod(0o600);
        let size = 0;
        let chunk = "";
        while (offset < batch.length && size + batch[offset].bytes <= maxLogBytes) {
          chunk += batch[offset].line;
          size += batch[offset].bytes;
          offset++;
        }
        if (chunk) await next.appendFile(chunk);
      } finally {
        await next.close();
      }
    }
  }
}
