import { ChildProcess, execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export type PiRpcFrameErrorCode = "frame_too_large" | "invalid_json" | "incomplete_tail_frame";

export class PiRpcFrameError extends Error {
  constructor(
    readonly code: PiRpcFrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PiRpcFrameError";
  }
}

/** Incremental JSON-lines decoding framed strictly by the LF byte. */
export class LfJsonLineDecoder {
  private buffered = Buffer.alloc(0);
  private failure: PiRpcFrameError | null = null;

  constructor(readonly maxFrameBytes: number = MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 0) {
      throw new RangeError("maxFrameBytes must be a non-negative safe integer");
    }
  }

  push(chunk: Buffer | Uint8Array | string): unknown[] {
    if (this.failure) throw this.failure;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const messages: unknown[] = [];
    let offset = 0;

    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const partLength = end - offset;
      if (this.buffered.length + partLength > this.maxFrameBytes) {
        this.fail("frame_too_large", `Pi RPC frame exceeds the ${this.maxFrameBytes}-byte limit`);
      }

      if (newline === -1) {
        this.append(bytes.subarray(offset, end));
        break;
      }

      let frame: Buffer;
      if (this.buffered.length === 0) {
        frame = bytes.subarray(offset, end);
      } else {
        this.append(bytes.subarray(offset, end));
        frame = this.buffered;
      }
      if (frame.length > 0 && frame[frame.length - 1] === 0x0d) {
        frame = frame.subarray(0, frame.length - 1);
      }
      this.buffered = Buffer.alloc(0);
      this.decodeFrame(frame, messages);
      offset = end + 1;
    }
    return messages;
  }

  write(chunk: Buffer | Uint8Array | string): unknown[] {
    return this.push(chunk);
  }

  end(): unknown[] {
    if (this.failure) throw this.failure;
    const tail = this.buffered;
    this.buffered = Buffer.alloc(0);
    if (tail.length === 0) return [];
    const text = new StringDecoder("utf8").end(tail);
    if (text.trim().length > 0) {
      this.fail("incomplete_tail_frame", "Pi RPC ended with an incomplete tail frame");
    }
    return [];
  }

  private append(part: Buffer): void {
    this.buffered =
      this.buffered.length === 0 ? Buffer.from(part) : Buffer.concat([this.buffered, part]);
  }

  private decodeFrame(frame: Buffer, messages: unknown[]): void {
    const text = new StringDecoder("utf8").end(frame);
    if (text.trim().length === 0) return;
    try {
      messages.push(JSON.parse(text));
    } catch (error) {
      this.fail(
        "invalid_json",
        `Invalid Pi RPC JSON frame: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private fail(code: PiRpcFrameErrorCode, message: string): never {
    const error = new PiRpcFrameError(code, message);
    this.failure = error;
    this.buffered = Buffer.alloc(0);
    throw error;
  }
}

export interface PiRpcImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiRpcSessionState {
  model?: unknown;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string;
  followUpMode: string;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
  [key: string]: unknown;
}

export interface PiRpcExtensionUiResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}

export interface PiRpcRequestOptions {
  timeoutMs?: number;
}

export interface PiRpcPromptOptions extends PiRpcRequestOptions {
  images?: PiRpcImage[];
  onBeforeWrite?: () => void;
  /** Runs in stdout frame order, before a following agent_start in the same read. */
  onStarted?: () => void;
}

export interface PiRpcStreams {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  child?: ChildProcess;
}

export interface PiRpcClientOptions {
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
}

export interface PiRpcSpawnOptions extends PiRpcClientOptions {
  binary?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
}

export class PiRpcResponseError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = "PiRpcResponseError";
  }
}

type PendingRequest = {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type DrainWaiter = {
  reject: (error: Error) => void;
  cleanup: () => void;
};

interface PiCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  usage?: Record<string, unknown>;
  details?: unknown;
}

type AllowedCommand =
  | { id: string; type: "compact"; customInstructions?: string }
  | { id: string; type: "prompt" | "steer"; message: string; images?: PiRpcImage[] }
  | { id: string; type: "abort" }
  | { id: string; type: "get_state" }
  | { id: string; type: "get_session_stats" }
  | { id: string; type: "get_available_models" }
  | { id: string; type: "get_commands" }
  | { id: string; type: "get_available_thinking_levels" }
  | { id: string; type: "set_model"; provider: string; modelId: string }
  | { id: string; type: "set_thinking_level"; level: string };

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class PiRpcClient extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  readonly child?: ChildProcess;
  private readonly decoder: LfJsonLineDecoder;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly drainWaiters = new Set<DrainWaiter>();
  private nextRequestId = 0;
  private terminalError: Error | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private exitEmitted = false;

  constructor(streams: PiRpcStreams, options: PiRpcClientOptions = {}) {
    super();
    this.stdin = streams.stdin;
    this.stdout = streams.stdout;
    this.stderr = streams.stderr;
    this.child = streams.child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.decoder = new LfJsonLineDecoder(options.maxFrameBytes);

    this.stdout.on("data", (chunk: Buffer | string) => {
      // Deliberately synchronous: resolving one response must never wait for
      // another response that can only arrive on this same stdout stream.
      let messages: unknown[];
      try {
        messages = this.decoder.push(chunk);
      } catch (error) {
        this.handleFrameError(error);
        return;
      }
      for (const message of messages) this.dispatch(message);
    });
    this.stdout.on("end", () => {
      try {
        const messages = this.decoder.end();
        for (const message of messages) this.dispatch(message);
      } catch (error) {
        this.handleFrameError(error);
      }
      this.failTransport(new Error("Pi RPC stdout ended"));
    });
    this.stdout.on("close", () => this.failTransport(new Error("Pi RPC stdout closed")));
    this.stdout.on("error", (error) => this.failTransport(asError(error)));
    this.stderr?.on("data", (chunk: Buffer | string) => this.emit("stderr", chunk.toString()));
    this.stderr?.on("error", (error) => this.emit("stderr", asError(error).message));
    this.stdin.on("error", (error) => this.failTransport(asError(error)));
    this.stdin.on("close", () => this.failTransport(new Error("Pi RPC stdin closed")));

    const child = this.child;
    child?.on("error", (error) => this.failTransport(asError(error)));
    // `exit` can precede buffered stdout, including unsolicited turns.
    child?.on("close", (code, signal) => {
      this.failTransport(new Error(`Pi process exited (${code ?? signal ?? "unknown"})`));
      this.emitExit(code, signal);
    });
  }

  static spawn(options: PiRpcSpawnOptions = {}): PiRpcClient {
    const child = spawn(options.binary ?? "pi", options.args ?? ["--mode", "rpc"], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: options.detached ?? true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new PiRpcClient(
      { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, child },
      options,
    );
  }

  get hasPendingRequests(): boolean {
    return this.pending.size > 0;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  prompt(message: string, options: PiRpcPromptOptions = {}): Promise<{ disposition: string }> {
    return this.request(
      "prompt",
      (id) => ({ id, type: "prompt", message, ...(options.images && { images: options.images }) }),
      options,
      options.onBeforeWrite,
      (data) => {
        if ((data as { disposition?: string } | undefined)?.disposition === "started")
          options.onStarted?.();
      },
    ) as Promise<{ disposition: string }>;
  }

  steer(
    message: string,
    options: PiRpcPromptOptions,
  ): Promise<{ disposition: "handled" | "queued" }> {
    return this.request(
      "steer",
      (id) => ({ id, type: "steer", message, ...(options.images && { images: options.images }) }),
      options,
      options.onBeforeWrite,
    ) as Promise<{ disposition: "handled" | "queued" }>;
  }

  compact(customInstructions?: string, onBeforeWrite?: () => void): Promise<PiCompactionResult> {
    return this.request(
      "compact",
      (id) => ({ id, type: "compact", ...(customInstructions && { customInstructions }) }),
      { timeoutMs: 15 * 60_000 },
      onBeforeWrite,
    ) as Promise<PiCompactionResult>;
  }

  abort(options: PiRpcRequestOptions = {}): Promise<void> {
    return this.request("abort", (id) => ({ id, type: "abort" }), options) as Promise<void>;
  }

  getState(options: PiRpcRequestOptions = {}): Promise<PiRpcSessionState> {
    return this.request(
      "get_state",
      (id) => ({ id, type: "get_state" }),
      options,
    ) as Promise<PiRpcSessionState>;
  }

  getSessionStats(options: PiRpcRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.request(
      "get_session_stats",
      (id) => ({ id, type: "get_session_stats" }),
      options,
    ) as Promise<Record<string, unknown>>;
  }

  getAvailableModels(
    options: PiRpcRequestOptions = {},
  ): Promise<{ models: Array<Record<string, unknown>> }> {
    return this.request(
      "get_available_models",
      (id) => ({ id, type: "get_available_models" }),
      options,
    ) as Promise<{ models: Array<Record<string, unknown>> }>;
  }

  getCommands(
    options: PiRpcRequestOptions = {},
  ): Promise<{ commands: Array<Record<string, unknown>> }> {
    return this.request(
      "get_commands",
      (id) => ({ id, type: "get_commands" }),
      options,
    ) as Promise<{
      commands: Array<Record<string, unknown>>;
    }>;
  }

  getAvailableThinkingLevels(options: PiRpcRequestOptions = {}): Promise<{ levels: string[] }> {
    return this.request(
      "get_available_thinking_levels",
      (id) => ({ id, type: "get_available_thinking_levels" }),
      options,
    ) as Promise<{ levels: string[] }>;
  }

  setModel(
    provider: string,
    modelId: string,
    options: PiRpcRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "set_model",
      (id) => ({ id, type: "set_model", provider, modelId }),
      options,
    ) as Promise<Record<string, unknown>>;
  }

  setThinkingLevel(level: string, options: PiRpcRequestOptions = {}): Promise<void> {
    return this.request(
      "set_thinking_level",
      (id) => ({ id, type: "set_thinking_level", level }),
      options,
    ) as Promise<void>;
  }

  sendExtensionUIResponse(response: PiRpcExtensionUiResponse): Promise<void> {
    return this.enqueueWrite(response);
  }

  private request(
    command: AllowedCommand["type"],
    makeCommand: (id: string) => AllowedCommand,
    options: PiRpcRequestOptions,
    onBeforeWrite?: () => void,
    onResponse?: (data: unknown) => void,
  ): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = `req-${++this.nextRequestId}`;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        command,
        reject,
        timer,
        resolve: (data) => {
          onResponse?.(data);
          resolve(data);
        },
      });
    });
    void this.enqueueWrite(makeCommand(id), onBeforeWrite).catch((error: unknown) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      clearTimeout(request.timer);
      request.reject(asError(error));
    });
    return result;
  }

  private enqueueWrite(message: unknown, onBeforeWrite?: () => void): Promise<void> {
    const write = this.writeChain.then(() => this.writeNow(message, onBeforeWrite));
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private async writeNow(message: unknown, onBeforeWrite?: () => void): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    onBeforeWrite?.();
    let drained: boolean;
    try {
      drained = this.stdin.write(bytes);
    } catch (error) {
      throw asError(error);
    }
    if (!drained) await this.waitForDrain();
  }

  private waitForDrain(): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise<void>((resolve, reject) => {
      const waiter: DrainWaiter = {
        reject,
        cleanup: () => {
          this.stdin.off("drain", onDrain);
          this.drainWaiters.delete(waiter);
        },
      };
      const onDrain = () => {
        waiter.cleanup();
        resolve();
      };
      this.drainWaiters.add(waiter);
      this.stdin.once("drain", onDrain);
    });
  }

  private dispatch(value: unknown): void {
    if (typeof value !== "object" || value === null) {
      this.emit("event", value);
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.type !== "response") {
      this.emit("event", value);
      return;
    }
    const id = typeof message.id === "string" ? message.id : "";
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    // Only an explicit rejection of this steer makes a second write safe.
    if (
      request.command === "steer" &&
      (message.command !== "steer" ||
        (message.success !== true &&
          !(message.success === false && typeof message.error === "string")))
    ) {
      request.reject(new Error("Malformed Pi steer response"));
    } else if (message.success === true) {
      request.resolve(message.data);
    } else {
      request.reject(
        new PiRpcResponseError(
          typeof message.command === "string" ? message.command : request.command,
          typeof message.error === "string" ? message.error : "Pi RPC request failed",
        ),
      );
    }
  }

  private handleFrameError(value: unknown): void {
    const error = asError(value);
    this.emit("frame_error", error);
    this.failTransport(error);
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.emit("exit", code, signal);
  }

  private failTransport(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const waiter of [...this.drainWaiters]) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }
}

export type PidMatcher = string | RegExp;
export interface VerifiedPid {
  pid: number;
  matchers: readonly PidMatcher[];
}

export interface BudgetedShutdownOptions {
  totalTimeoutMs?: number;
  stdin?: Writable | null;
  child?: ChildProcess | null;
  pid?: number;
  stopDetachedChildren?: (budgetMs: number) => Promise<readonly VerifiedPid[]>;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function matchesCommand(command: string, matchers: readonly PidMatcher[]): boolean {
  return matchers.every((matcher) => {
    if (typeof matcher === "string") return command.includes(matcher);
    matcher.lastIndex = 0;
    return matcher.test(command);
  });
}

function readPidCommand(pid: number, timeoutMs = 1_000): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "command=", "-p", String(pid)],
      { timeout: Math.max(1, timeoutMs), maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const command = stdout.trim();
        resolve(command.length > 0 ? command : null);
      },
    );
  });
}

export async function verifyPidCommand(
  pid: number,
  matchers: readonly PidMatcher[],
): Promise<boolean> {
  const command = await readPidCommand(pid);
  return command !== null && matchesCommand(command, matchers);
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function killVerifiedPid(
  pid: number,
  matchers: readonly PidMatcher[],
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  const command = await readPidCommand(pid, deadline - Date.now());
  if (command === null) return true;
  if (!matchesCommand(command, matchers)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return true;
  }

  while (pidExists(pid) && Date.now() < deadline) {
    await delay(Math.min(50, deadline - Date.now()));
  }
  if (!pidExists(pid)) return true;
  const remainingCommand = await readPidCommand(pid, Math.max(1, deadline - Date.now()));
  if (remainingCommand === null) return true;
  if (!matchesCommand(remainingCommand, matchers)) return false;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return true;
}

function childIsAlive(child: ChildProcess | null | undefined, pid?: number): boolean {
  if (child) return child.exitCode === null && child.signalCode === null;
  return pid !== undefined && pidExists(pid);
}

async function waitForProcessExit(
  child: ChildProcess | null | undefined,
  pid: number | undefined,
  budgetMs: number,
): Promise<boolean> {
  if (!childIsAlive(child, pid)) return true;
  if (budgetMs <= 0) return false;
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const interval = setInterval(
      () => {
        if (!childIsAlive(child, pid)) finish(true);
      },
      Math.min(50, budgetMs),
    );
    const timeout = setTimeout(() => finish(!childIsAlive(child, pid)), budgetMs);
    const finish = (exited: boolean) => {
      clearInterval(interval);
      clearTimeout(timeout);
      child?.off("exit", onExit);
      resolve(exited);
    };
    child?.once("exit", onExit);
  });
}

function signalPi(pid: number, signal: NodeJS.Signals, both = false): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
  if (both) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited or the process-group signal was sufficient.
    }
  }
}

/** Four shutdown stages sharing one deadline, including detached PID reaping. */
export async function runBudgetedShutdown(options: BudgetedShutdownOptions): Promise<void> {
  const totalTimeoutMs = options.totalTimeoutMs ?? 10_000;
  const deadline = Date.now() + totalTimeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const pid = options.pid ?? options.child?.pid ?? undefined;
  let detached: readonly VerifiedPid[] = [];

  if (options.stopDetachedChildren && remaining() > 0) {
    const budget = Math.min(2_500, remaining());
    let timeout: NodeJS.Timeout | undefined;
    try {
      const expired = new Promise<readonly VerifiedPid[]>((resolve) => {
        timeout = setTimeout(() => resolve([]), budget);
      });
      detached = await Promise.race([options.stopDetachedChildren(budget), expired]);
    } catch {
      detached = [];
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  if (remaining() > 0 && childIsAlive(options.child, pid)) {
    const budget = Math.min(4_500, remaining());
    try {
      options.stdin?.end();
    } catch {
      // Escalation below handles a process whose stdin is already broken.
    }
    await waitForProcessExit(options.child, pid, budget);
  }

  if (pid !== undefined && remaining() > 0 && childIsAlive(options.child, pid)) {
    const budget = Math.min(1_500, remaining());
    const stageDeadline = Date.now() + budget;
    signalPi(pid, "SIGTERM");
    await delay(Math.min(100, Math.max(0, stageDeadline - Date.now())));
    if (childIsAlive(options.child, pid) && Date.now() < stageDeadline) signalPi(pid, "SIGTERM");
    await waitForProcessExit(options.child, pid, Math.max(0, stageDeadline - Date.now()));
    if (childIsAlive(options.child, pid)) signalPi(pid, "SIGKILL", true);
  }

  if (detached.length > 0 && remaining() > 0) {
    const budget = Math.min(1_500, remaining());
    await Promise.all(
      detached.map(({ pid: detachedPid, matchers }) =>
        killVerifiedPid(detachedPid, matchers, budget),
      ),
    );
  }
}
