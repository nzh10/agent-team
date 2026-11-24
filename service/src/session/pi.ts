import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { PanelToolset } from "../project/tools";
import { ACP_PREPARE_STEP, inspectAcpRuntime } from "./acp-readiness";
import type { BoundarySteer, HostSessionHandle } from "./host";
import { PanelHttpServer, type PanelHttpAddress } from "./panel-http";
import { discoverLocalPiPackages, prepareControlledPiAgentHome } from "./pi-agent-home";
import {
  PiRpcClient,
  PiRpcResponseError,
  killVerifiedPid,
  runBudgetedShutdown,
  type PiRpcImage,
  type PiRpcSpawnOptions,
  type VerifiedPid,
} from "./pi-rpc";
import {
  decodeSubagentNotifyWire,
  executeFallbackAsyncStop,
  isTrackableSubagentMode,
  makeSyntheticSubagentTaskId,
  assistantExecution,
  observedStatusExecution,
  projectSubagentExecution,
  reconstructSubagentChild,
  resolveCanonicalChildId,
  resolveStopTarget,
  type SubagentNotifyRun,
} from "./pi-subagents";
import { decodeExtensionUi } from "./pi-extension-ui";
import { extractPiToolResultText, formatPiToolUse } from "./pi-tool-format";
import { ACP } from "./quota-schema";
import { retireOnEof } from "./retire";
import type {
  ActiveAsyncRunRecord,
  BackgroundTask,
  BoundedSessionProof,
  CommandInfo,
  DispatchedReportProbeResult,
  PiAvailableModel,
  PromptEnvelope,
  RunState,
  SendHooks,
  SendReceipt,
  SessionConfig,
  SessionState,
  StreamEvent,
  SubAgentInfo,
  UiChange,
  ExtensionUiEvent,
  UiDialogMethod,
  UiDialogRequest,
  UiDialogResponse,
  UsageStats,
} from "./types";

export interface PiSessionOptions {
  panelHttp?: PanelHttpServer;
  rpcFactory?: (options: PiRpcSpawnOptions) => PiRpcClient;
  piBinary?: string;
  piArgs?: string[];
  interruptTimeoutMs?: number;
  reconcileIntervalMs?: number;
  statsTimeoutMs?: number;
  readyTimeoutMs?: number;
  catalogOnly?: boolean;
  dialogFallbackTimeoutMs?: number;
}

export class PiModelsFilteredError extends Error {
  constructor() {
    super("No Pi models matched enabledModels");
  }
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object) : []);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const realpath = fs.realpathSync.native;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
const listens = new WeakMap<PanelHttpServer, Promise<PanelHttpAddress>>();
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const IMAGE_BUDGET = 12 * 1024 * 1024;
const EMPTY_PANEL_TOOLSET: PanelToolset = { instructions: "", tools: [] };

function matchesImage(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    case "image/jpeg":
      return bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
    case "image/gif":
      return /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6));
    case "image/webp":
      return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    default:
      return false;
  }
}

function readPiAttachments(
  uploadsDir: string | undefined,
  ids: string[] = [],
  encode = true,
): PiRpcImage[] | undefined {
  if (!ids.length) return;
  if (!uploadsDir) throw new Error("Pi uploads directory is not configured");
  const root = realpath(uploadsDir);
  let remaining = IMAGE_BUDGET;
  return ids.map((id) => {
    const name = id.startsWith("uploads/") ? id.slice("uploads/".length) : id;
    const mimeType = MIME[path.extname(name).toLowerCase()];
    if (name !== path.basename(name) || !mimeType)
      throw new Error(`Unsupported attachment MIME: ${id}`);
    const file = realpath(path.join(root, name));
    if (path.dirname(file) !== root) throw new Error(`Invalid attachment path: ${id}`);
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error(`Invalid attachment: ${id}`);
      if (stat.size > remaining)
        throw new Error("Pi prompt images exceed the 12 MiB raw-byte budget");
      const bytes = Buffer.alloc(stat.size);
      if (fs.readSync(fd, bytes) !== stat.size || !matchesImage(bytes, mimeType))
        throw new Error(`Invalid attachment image MIME: ${id}`);
      remaining -= bytes.length;
      return { type: "image", data: encode ? bytes.toString("base64") : "", mimeType };
    } finally {
      fs.closeSync(fd);
    }
  });
}

export function validatePiAttachments(uploadsDir: string | undefined, ids: string[]): void {
  readPiAttachments(uploadsDir, ids, false);
}

function firstSessionRecord(file: string): Json {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, buffer);
    const lf = buffer.indexOf(10);
    return object(JSON.parse(buffer.toString("utf8", 0, lf >= 0 && lf < length ? lf : length)));
  } finally {
    fs.closeSync(fd);
  }
}

interface Turn {
  steer?: { input: BoundarySteer; wireText: string; claimed: boolean; observed: boolean };
  id: string;
  inputId?: string;
  reportId?: string;
  generation: number;
  settled: boolean;
  written: boolean;
  started: boolean;
  accepted: boolean;
  startedAt: number;
  blocks: Map<number, { content: string; startedAt: number; ended?: boolean }>;
  tools: Map<string, { name: string; args: Json; startedAt: number; emitted: boolean }>;
  subagents: Map<
    string,
    { mode: ActiveAsyncRunRecord["mode"]; children: ActiveAsyncRunRecord["children"] }
  >;
  replyUsage?: Json;
  finalText: string;
  error?: string;
  contextualInput?: number;
  compact?: boolean;
}

function piEffortLevels(model: Json): string[] | undefined {
  if (typeof model.reasoning !== "boolean") return undefined;
  if (!model.reasoning) return ["off"];
  const map = object(model.thinkingLevelMap);
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter(
    (level) =>
      map[level] !== null && ((level !== "xhigh" && level !== "max") || map[level] !== undefined),
  );
}

type Setting = { desired?: string; applied?: string; lastError?: string };

function newTurn(generation: number, envelope?: PromptEnvelope): Turn {
  return {
    id: randomUUID(),
    inputId: envelope?.inputId,
    reportId: envelope?.reportId,
    generation,
    settled: false,
    written: false,
    started: false,
    accepted: false,
    startedAt: Date.now(),
    blocks: new Map(),
    tools: new Map(),
    subagents: new Map(),
    finalText: "",
  };
}

function terminalStatus(value: unknown): SubAgentInfo["status"] | undefined {
  if (["completed", "complete", "success", "succeeded", "done"].includes(String(value)))
    return "completed";
  if (["failed", "error", "crashed"].includes(String(value))) return "failed";
  if (["stopped", "cancelled", "canceled", "aborted", "skipped"].includes(String(value)))
    return "stopped";
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class PiSession extends EventEmitter implements HostSessionHandle {
  readonly canSteer = false;
  sessionId: string | null = null;
  usage: UsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 0,
    duration_ms: 0,
  };
  private readonly config: SessionConfig;
  private readonly normalizedCwd: string;
  private readonly panelHttp: PanelHttpServer;
  private readonly sessionKey = randomUUID();
  private readonly ownsPanel: boolean;
  private readonly statsTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly model: Setting;
  private readonly effort: Setting;
  private panelTools: PanelToolset | null = null;
  private appliedPanelTools: PanelToolset | null = null;
  private panelToolsError?: string;
  private rpc?: PiRpcClient;
  private rpcEnv?: NodeJS.ProcessEnv;
  private compactingRpc?: PiRpcClient;
  private compactionBoundary?: { pending?: Promise<void> };
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private interrupting?: Promise<boolean>;
  private disposed = false;
  private tainted = false;
  private processGeneration = 0;
  private activeTurn: Turn | null = null;
  private boundarySource?: () => BoundarySteer | undefined;
  private sessionFile: string | null = null;
  private expectedLeafAnchorId: string | null = null;
  private minEntryCount = 0;
  private hasConfirmedTurns = false;
  private sessionProof?: BoundedSessionProof;
  private subagentsSessionId?: string;
  private piSubagentsRoot?: string;
  private home?: ReturnType<typeof prepareControlledPiAgentHome>;
  private registered = false;
  private bridgeOwnedToolNames = new Set<string>();
  private activeAsyncRuns: ActiveAsyncRunRecord[] = [];
  // A terminal status file can precede the live extension's notification.
  private readonly pendingDeployNotices = new Set<string>();
  private reconciliation?: Promise<void>;
  private reconcileTimer?: NodeJS.Timeout;
  private readonly detachedPids = new Map<number, VerifiedPid & { identity: string }>();
  private lastHelperCaptureAt = 0;
  private readonly dialogs = new Map<string, { request: UiDialogRequest; timer: NodeJS.Timeout }>();
  private models: PiAvailableModel[] = [];
  private levels?: string[];
  private commands: CommandInfo[] = [];
  private stats: Json | null = null;
  private pendingOptions?: Promise<void>;

  constructor(
    config: SessionConfig,
    private readonly options: PiSessionOptions = {},
  ) {
    super();
    this.normalizedCwd =
      config.normalizedCwd ??
      (fs.existsSync(config.cwd) ? realpath(config.cwd) : path.resolve(config.cwd));
    this.config = { ...config, cwd: this.normalizedCwd };
    this.model = { desired: config.model };
    this.effort = { desired: config.effort };
    this.ownsPanel = !options.panelHttp;
    this.panelHttp = options.panelHttp ?? new PanelHttpServer();
    this.statsTimeoutMs = options.statsTimeoutMs ?? 3_000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.piSubagentsRoot = config.piSubagentsRoot;
  }

  static fromState(state: SessionState, options?: PiSessionOptions): PiSession {
    const session = new PiSession(
      { ...state.config, cwd: state.normalizedCwd ?? state.config.cwd },
      options,
    );
    session.sessionId = state.sessionId;
    session.sessionFile = state.sessionFile ?? null;
    session.expectedLeafAnchorId = state.expectedLeafAnchorId ?? null;
    session.minEntryCount = state.minEntryCount ?? 0;
    session.hasConfirmedTurns = state.hasConfirmedTurns ?? false;
    session.model.desired = state.desiredModel ?? state.config.model;
    session.effort.desired = state.desiredEffort ?? state.config.effort;
    session.usage = { ...state.usage };
    session.activeAsyncRuns = structuredClone(state.activeAsyncRuns ?? []);
    session.scheduleReconciliation();
    if (session.activeAsyncRuns.length) queueMicrotask(() => void session.reconcileAsyncRuns());
    return session;
  }

  getState(): SessionState {
    return {
      config: { ...this.config, model: this.model.desired, effort: this.effort.desired },
      usage: { ...this.usage },
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      normalizedCwd: this.normalizedCwd,
      expectedLeafAnchorId: this.expectedLeafAnchorId,
      minEntryCount: this.minEntryCount,
      hasConfirmedTurns: this.hasConfirmedTurns,
      desiredModel: this.model.desired,
      desiredEffort: this.effort.desired,
      activeAsyncRuns: structuredClone(this.activeAsyncRuns),
    };
  }

  get isRunning(): boolean {
    return Boolean(this.activeTurn && !this.activeTurn.settled);
  }
  get runState(): RunState {
    return this.isRunning ? "working" : this.activeAsyncRuns.length ? "waiting" : "idle";
  }
  get effectiveEffort(): string | null {
    return this.effort.applied ?? null;
  }
  get nextTurnOptions() {
    return { model: this.model.desired, effort: this.effort.desired };
  }
  get optionsPending(): boolean {
    return (
      [this.model, this.effort].some(
        ({ desired, applied }) => desired !== undefined && desired !== applied,
      ) || this.panelTools !== this.appliedPanelTools
    );
  }
  get interruptPending(): boolean {
    return Boolean(this.interrupting);
  }
  get pendingUiDialogs(): UiDialogRequest[] {
    return [...this.dialogs.values()].map(({ request }) => request);
  }
  get backgroundTaskList(): BackgroundTask[] {
    return this.activeAsyncRuns.flatMap((run) =>
      run.children
        .filter((child) => !terminalStatus(child.status))
        .map((child) => ({
          id: child.taskId,
          type: "local_agent",
          description: child.canonicalChildId,
          since: run.startedAt,
          cancellable: true,
        })),
    );
  }
  getAvailableModels(): PiAvailableModel[] {
    return this.models.slice();
  }
  getAvailableThinkingLevels(model = this.model.applied): string[] | undefined {
    return this.rpc && model === this.model.applied ? this.levels?.slice() : undefined;
  }
  getCommands(): CommandInfo[] {
    return [
      {
        name: "compact",
        source: "pi",
        description: "Compact conversation context",
        argumentHint: "[instructions]",
      },
      ...this.commands.filter((command) => command.name !== "compact"),
    ];
  }
  getContextUsage(): Promise<Json | null> {
    const context = object(this.stats?.contextUsage);
    const totalTokens = num(context.tokens);
    const maxTokens = num(context.contextWindow ?? context.window);
    if (totalTokens === undefined || !maxTokens) return Promise.resolve(null);
    return Promise.resolve({
      totalTokens,
      maxTokens,
      percentage: (totalTokens / maxTokens) * 100,
      model: this.model.applied,
      apiUsage: {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        cache_read_input_tokens: this.usage.cache_read_tokens,
      },
    });
  }
  getUsageInfo(): Promise<Json | null> {
    return Promise.resolve(
      this.stats && {
        ...this.stats,
        session: { total_cost_usd: this.usage.cost_usd, total_duration_ms: this.usage.duration_ms },
      },
    );
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error("Pi session is disposed");
    if (this.retiring) await this.retiring;
    if (this.disposed) throw new Error("Pi startup cancelled");
    if (!this.starting && this.rpc && !this.tainted) return;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private prepareAgentHome() {
    // Explicit piAgentDir is caller-owned. A managed runtime home is refreshed on respawn.
    if (!this.config.piAgentDir && (!this.home || this.config.dataDir))
      this.home = prepareControlledPiAgentHome({
        mode: this.config.dataDir ? "runtime" : "test-synthetic",
        dataDir: this.config.dataDir,
        packages: this.config.piPackages,
        excludePackages: this.config.piExcludePackages,
        offline: this.config.piOffline,
        piAcp: this.config.piAcp,
      });
    const agentDir = this.config.piAgentDir ?? this.home!.piAgentDir;
    const settingsFile = path.join(agentDir, "settings.json");
    const settings = fs.existsSync(settingsFile)
      ? object(JSON.parse(fs.readFileSync(settingsFile, "utf8")))
      : {};
    const packages =
      this.home?.resolvedPackages ??
      (Array.isArray(settings.packages) && settings.packages.length
        ? discoverLocalPiPackages(this.config.piAgentDir)
        : {});
    this.piSubagentsRoot ??= packages.piSubagentsRoot;
    return {
      agentDir,
      settings,
      providerEntry: this.home?.piAcpProfileError
        ? undefined
        : (this.config.piAntigravityEntryPath ?? packages.piAntigravityEntryPath),
    };
  }

  private async start(): Promise<void> {
    if (!fs.statSync(this.normalizedCwd, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`Pi cwd is not a directory: ${this.normalizedCwd}`);
    let sessionArgs: string[];
    if (this.hasConfirmedTurns) {
      if (
        !this.sessionFile ||
        !this.sessionId ||
        !fs.statSync(this.sessionFile, { throwIfNoEntry: false })?.size
      )
        throw new Error("Pi restore requires the saved nonempty session file");
      const header = firstSessionRecord(this.sessionFile);
      if (header.type !== "session" || header.id !== this.sessionId)
        throw new Error("Pi restore session header does not match the saved session ID");
      sessionArgs = ["--session", this.sessionFile];
    } else {
      this.sessionId ??= randomUUID();
      const dir =
        this.config.piSessionDir ??
        path.join(
          this.config.dataDir ?? this.normalizedCwd,
          "pi-sessions",
          this.config.workspaceId ?? "local",
        );
      fs.mkdirSync(dir, { recursive: true });
      sessionArgs = ["--session-dir", dir, "--session-id", this.sessionId];
    }
    const bundledBridge = [
      path.join(__dirname, "pi-panel-bridge.ts"),
      path.resolve(__dirname, "../service/src/session/pi-panel-bridge.ts"),
      path.resolve(__dirname, "../../service/src/session/pi-panel-bridge.ts"),
    ].find((file) => fs.existsSync(file));
    if (!bundledBridge) throw new Error("Pi panel extensions not found");
    const bridge = this.config.piBridgeExtensionPath ?? bundledBridge;
    const { agentDir, settings, providerEntry } = this.prepareAgentHome();
    let listening = listens.get(this.panelHttp);
    if (!listening) {
      listening = this.panelHttp.listen().catch((error: unknown) => {
        listens.delete(this.panelHttp);
        throw error;
      });
      listens.set(this.panelHttp, listening);
    }
    const { baseUrl } = await listening;
    if (this.disposed) throw new Error("Pi startup cancelled");
    const generation = this.processGeneration;
    const token = this.panelHttp.registerSession({
      sessionKey: this.sessionKey,
      onSteerBoundary: async (open) => {
        if (generation === this.processGeneration) await this.steerAtBoundary(open);
      },
      onQuota: this.options.catalogOnly
        ? undefined
        : (snapshot) => {
            if (generation === this.processGeneration) this.emit("piQuota", snapshot);
          },
      // The bridge must be able to fetch an empty toolset before ready, even on revocation.
      getToolset: () => this.panelTools ?? EMPTY_PANEL_TOOLSET,
      restoreExpectation: { expectedAnchorId: this.expectedLeafAnchorId },
      onAnswer: (tool) => {
        if (generation !== this.processGeneration) return;
        this.bridgeOwnedToolNames.add(tool);
        const turn = this.activeTurn;
        if (turn && this.live(turn)) {
          for (const [id, call] of turn.tools) if (call.name === tool) this.emitToolUse(id, call);
        }
      },
    });
    this.registered = true;
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...this.config.providerEnv,
        ...this.home?.env,
      };
      // A Hub session is a top-level Pi, even when Hub itself was started from a child shell.
      for (const name of [
        "PI_SUBAGENT_CHILD",
        "PI_SUBAGENT_PARENT_SESSION",
        "PI_SUBAGENT_RUNNER_PID",
        "PI_SESSION_ID",
        "PI_SESSION_FILE",
      ])
        delete env[name];
      // Pi's online RPC startup refresh can bootstrap ACP, even with another provider selected.
      // PI_OFFLINE suppresses background model refresh for all providers in this child only.
      if (
        this.options.catalogOnly ||
        this.config.piOffline !== false ||
        (providerEntry && !inspectAcpRuntime(env, this.normalizedCwd).ready)
      )
        env.PI_OFFLINE = "1";
      else delete env.PI_OFFLINE;
      const rpc = (this.options.rpcFactory ?? PiRpcClient.spawn)({
        binary: this.options.piBinary ?? this.config.piBinary ?? process.env.YAAT_PI_BIN,
        args: [
          "--mode",
          "rpc",
          ...sessionArgs,
          "-e",
          bridge,
          "-e",
          path.join(path.dirname(bundledBridge), "pi-quota.ts"),
          ...(this.options.piArgs ?? this.config.piArgs ?? []),
        ],
        cwd: this.normalizedCwd,
        env: {
          ...env,
          PI_CODING_AGENT_DIR: agentDir,
          YAAT_PANEL_URL: baseUrl,
          YAAT_PANEL_KEY: this.sessionKey,
          YAAT_PANEL_TOKEN: token,
          YAAT_PANEL_EXPECTED_ANCHOR: this.expectedLeafAnchorId ?? "",
          YAAT_PI_SUBAGENTS_ROOT: this.piSubagentsRoot,
          YAAT_PI_ANTIGRAVITY_ENTRY: providerEntry,
        },
      });
      this.levels = undefined;
      this.rpcEnv = env;
      this.rpc = rpc;
      this.tainted = false;
      rpc.on("event", (event: unknown) => {
        if (this.current(generation, rpc)) this.handleEvent(object(event));
      });
      rpc.on("exit", (code: number | null, signal: string | null) =>
        this.onExit(generation, rpc, `Pi process exited (${code ?? signal ?? "unknown"})`),
      );
      rpc.on("frame_error", (error: Error) => this.onExit(generation, rpc, error.message, true));
      const timeout = { timeoutMs: this.readyTimeoutMs };
      const [rpcState, ready] = await Promise.all([
        rpc.getState(timeout),
        this.panelHttp.waitForReady(this.sessionKey, this.readyTimeoutMs),
      ]);
      const proof = ready.sessionProof;
      if (!this.current(generation, rpc)) throw new Error("Pi startup cancelled");
      if (
        proof.sessionId !== this.sessionId ||
        rpcState.sessionId !== proof.sessionId ||
        realpath(proof.cwd) !== this.normalizedCwd ||
        (this.hasConfirmedTurns &&
          (!proof.sessionFile ||
            !this.sessionFile ||
            realpath(proof.sessionFile) !== realpath(this.sessionFile) ||
            rpcState.sessionFile === null ||
            (typeof rpcState.sessionFile === "string" &&
              realpath(rpcState.sessionFile) !== realpath(this.sessionFile)) ||
            !proof.headerCwd ||
            realpath(proof.headerCwd) !== this.normalizedCwd ||
            proof.entryCount < this.minEntryCount ||
            !proof.anchorOnActiveBranch))
      )
        throw new Error("Pi restore proof does not match the saved session");
      if (
        (this.piSubagentsRoot && (!ready.subagentsRpcReady || !ready.subagentsSessionId)) ||
        (this.piSubagentsRoot && providerEntry && !ready.requiredExtensionsRegistered)
      )
        throw new Error("Pi panel bridge is missing required extension capabilities");
      const [{ models }, { commands }, { levels }] = await Promise.all([
        rpc.getAvailableModels(timeout),
        rpc.getCommands(timeout),
        rpc.getAvailableThinkingLevels(timeout),
      ]);
      if (!this.current(generation, rpc)) throw new Error("Pi startup cancelled");
      const available = models.flatMap((row) => {
        const model = object(row);
        const provider = text(model.provider),
          modelId = text(model.id ?? model.modelId);
        return provider && modelId
          ? [
              {
                id: `${provider}/${modelId}`,
                provider,
                modelId,
                name: text(model.name),
                reasoning: model.reasoning === true,
                effortLevels: piEffortLevels(model),
                contextWindow: num(model.contextWindow),
              },
            ]
          : [];
      });
      if (this.options.catalogOnly && available.length !== models.length)
        throw new Error("Malformed Pi model catalog");
      const enabledModels = Array.isArray(settings.enabledModels)
        ? settings.enabledModels.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          )
        : [];
      this.models = enabledModels.length
        ? available.filter((model) =>
            enabledModels.some(
              (pattern) =>
                pattern === "*" ||
                path.matchesGlob(model.id, pattern) ||
                path.matchesGlob(model.modelId, pattern),
            ),
          )
        : available;
      if (this.options.catalogOnly && available.length > 0 && this.models.length === 0)
        throw new PiModelsFilteredError();
      this.commands = commands.flatMap((command) =>
        typeof command.name === "string"
          ? [
              {
                name: command.name,
                description: text(command.description) ?? "",
                argumentHint: text(command.argumentHint) ?? "",
                source:
                  command.source === "skill" ||
                  command.source === "prompt" ||
                  command.source === "extension"
                    ? command.source
                    : "pi",
              },
            ]
          : [],
      );
      this.levels = levels;
      this.effort.applied = rpcState.thinkingLevel;
      this.model.applied =
        [text(object(rpcState.model).provider), text(object(rpcState.model).id)]
          .filter(Boolean)
          .join("/") || undefined;
      await this.applyOptions(rpc, generation);
      if (!this.current(generation, rpc)) throw new Error("Pi startup cancelled");
      this.emit("thinking_levels");
      this.sessionProof = proof;
      if (this.hasConfirmedTurns)
        this.updateCheckpoint(proof.leafId, proof.entryCount, proof.sessionFile);
      else this.sessionFile = proof.sessionFile;
      this.subagentsSessionId = ready.subagentsSessionId ?? undefined;
      this.bridgeOwnedToolNames = new Set(ready.ownerToolNames);
      this.appliedPanelTools = this.panelTools;
      this.panelToolsError = undefined;
      this.scheduleCaptureDetached(rpc.pid);
      this.emit("commands", this.getCommands());
    } catch (error) {
      if (generation === this.processGeneration && !this.disposed) await this.retireProcess();
      throw error;
    }
  }

  private current(generation: number, rpc: PiRpcClient): boolean {
    return !this.disposed && this.processGeneration === generation && this.rpc === rpc;
  }
  private live(turn: Turn): boolean {
    return (
      this.activeTurn === turn &&
      !turn.settled &&
      this.processGeneration === turn.generation &&
      !this.disposed
    );
  }

  private resolveModel(desired: string): PiAvailableModel | undefined {
    const exact = this.models.find((model) => model.id === desired);
    if (exact) return exact;
    const matches = this.models.filter((model) => model.modelId === desired);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private acpPromptError(input: string, compact: boolean): string | undefined {
    const runtimeError = () =>
      this.home?.piAcpProfileError ??
      (inspectAcpRuntime(this.rpcEnv, this.normalizedCwd).ready
        ? undefined
        : `Antigravity ACP runtime is not ready. ${ACP_PREPARE_STEP}`);
    if (!compact && input.startsWith("/")) {
      // Match Pi's extension command parser and the provider's exact argument handling.
      const space = input.indexOf(" ");
      const name = input.slice(1, space === -1 ? undefined : space);
      if (name === ACP || name === "gemini-acp") {
        const args = space === -1 ? "" : input.slice(space + 1).trim();
        if (["setup", "qualify", "update", "update-runtime"].includes(args))
          return `Manage the Antigravity ACP runtime outside YAAT. ${ACP_PREPARE_STEP}`;
        if (
          args === "permissions" ||
          args.startsWith("permissions ") ||
          args.startsWith("updates ") ||
          args === "tool-activity" ||
          args.startsWith("tool-activity ")
        )
          return "Antigravity ACP permissions and runtime update policy are managed by YAAT. Configure [pi.acp] and restart YAAT; edit tool activity in the managed Pi profile.";
        if (args === "quota") return runtimeError();
      }
      if (
        (name === "quota" || name === ACP || name === "gemini-acp") &&
        this.commands.some((command) => command.name === name && command.source === "extension")
      )
        return;
    }
    if (
      [this.model.desired, this.model.applied].some(
        (model) =>
          model && (model.startsWith(`${ACP}/`) || this.resolveModel(model)?.provider === ACP),
      )
    )
      return runtimeError();
  }

  async send(input: string | PromptEnvelope, hooks?: SendHooks): Promise<SendReceipt> {
    if (this.disposed || this.isRunning) throw new Error("Pi session is busy or disposed");
    const envelope = typeof input === "string" ? { inputId: randomUUID(), text: input } : input;
    const turn = newTurn(this.processGeneration, envelope);
    const compact = /^\/compact(?:\s+([\s\S]+))?$/.exec(envelope.text.trim());
    if (compact && envelope.attachmentIds?.length)
      throw new Error("/compact does not accept attachments");
    turn.compact = Boolean(compact);
    this.activeTurn = turn;
    try {
      this.emit("runState", "working");
      const images = readPiAttachments(this.config.uploadsDir, envelope.attachmentIds);
      await this.ensureStarted();
      if (this.interrupting) await this.interrupting;
      if (!this.live(turn)) throw new Error("Pi prompt dispatch cancelled");
      const rpc = this.rpc!;
      await this.applyOptions(rpc, turn.generation);
      if (!this.live(turn) || this.interrupting) throw new Error("Pi prompt dispatch cancelled");
      if (this.compactionBoundary) await this.syncCompactionCheckpoint(rpc);
      const onBeforeWrite = () => {
        if (this.compactionBoundary)
          throw new PiRpcResponseError("compact", "Waiting for Pi compaction checkpoint");
        if (this.compactingRpc === rpc || (compact && turn.started))
          throw new PiRpcResponseError(
            compact ? "compact" : "prompt",
            "Pi is already processing a turn",
          );
        if (!this.live(turn) || this.interrupting) throw new Error("Pi prompt dispatch cancelled");
        const acpError = this.acpPromptError(envelope.text, Boolean(compact));
        if (acpError) throw new PiRpcResponseError(compact ? "compact" : "prompt", acpError);
        hooks?.onBeforeWrite?.({
          inputId: envelope.inputId,
          reportId: envelope.reportId,
          generation: turn.generation,
          beforeLeafId: this.expectedLeafAnchorId,
          beforeEntryCount: this.minEntryCount,
          startedAt: Date.now(),
        });
        turn.written = true;
      };
      if (compact) {
        await rpc.compact(compact[1], onBeforeWrite);
        this.finish(turn, { kind: "result", content: "" });
        return { disposition: "handled" };
      }
      const reply = await rpc.prompt(envelope.text, {
        images,
        onBeforeWrite,
        ...(/^\/quota(?:\s|$)/.test(envelope.text.trimStart()) && { timeoutMs: 50_000 }),
      });
      if (reply?.disposition === "handled") {
        if (!turn.started) this.finish(turn);
        else if (this.live(turn)) {
          turn.inputId = undefined;
          turn.reportId = undefined;
          this.emitWakeup();
        }
        return { disposition: "handled" };
      }
      if (reply?.disposition !== "started")
        throw new Error("Pi returned an unknown prompt disposition");
      this.scheduleCaptureDetached(rpc.pid);
      return { disposition: "started" };
    } catch (error) {
      if (turn.compact && turn.accepted && error instanceof PiRpcResponseError) {
        this.finish(turn, { kind: "error", content: error.message });
        return { disposition: "handled" };
      }
      if (
        error instanceof PiRpcResponseError &&
        (error.command === "prompt" || error.command === "compact")
      ) {
        const retryable = /already processing|waiting for Pi compaction checkpoint/i.test(
          error.message,
        );
        if (retryable && turn.started) {
          // An unsolicited Pi turn (e.g. subagent-notify wakeup) started before
          // Pi rejected this prompt as busy. Keep the running turn alive as a
          // wakeup turn so its agent_settled transitions back to idle and dequeues.
          turn.inputId = undefined;
          turn.reportId = undefined;
          turn.written = false;
          this.emitWakeup();
        } else {
          this.finish(turn);
        }
        return {
          disposition: "rejected",
          error: error.message,
          ...(retryable && { retryable: true }),
        };
      }
      if (turn.written && this.live(turn)) {
        const retiring = this.retireProcess();
        this.finish(turn, { kind: "error", content: message(error) });
        await retiring;
      } else this.finish(turn);
      throw error;
    }
  }

  setBoundarySteerSource(source: () => BoundarySteer | undefined): void {
    this.boundarySource = source;
  }

  private async steerAtBoundary(open: () => boolean): Promise<void> {
    const turn = this.activeTurn;
    const rpc = this.rpc;
    if (!turn || !rpc || turn.steer || !turn.started || (turn.inputId && !turn.accepted)) return;
    const live = () =>
      this.live(turn) &&
      open() &&
      this.rpc === rpc &&
      !this.interrupting &&
      !this.tainted &&
      !this.compactingRpc &&
      !this.starting;
    if (!live() || this.model.applied?.startsWith("antigravity-acp/")) return;
    const input = this.boundarySource?.();
    if (!input) return;
    // Pi doesn't echo RPC IDs on user messages. Identical texts (including an old, uncertain
    // steer delivered on a later run) must never acknowledge each other.
    const wireText = `[Panel input ${input.envelope.inputId}]\n${input.envelope.text}`;
    const pending = { input, wireText, claimed: false, observed: false };
    turn.steer = pending;
    try {
      const reply = await rpc.steer(wireText, {
        images: readPiAttachments(this.config.uploadsDir, input.envelope.attachmentIds),
        timeoutMs: 1500,
        onBeforeWrite: () => {
          if (!live() || turn.steer !== pending || !input.claim())
            throw new Error("Pi steer cancelled");
          pending.claimed = true;
          if (!live()) throw new PiRpcResponseError("steer", "Boundary expired before write");
        },
      });
      if (turn.steer !== pending) return;
      if (reply?.disposition === "handled") this.finishSteer(turn, "handled");
      else if (reply?.disposition !== "queued") this.finishSteer(turn, "outcome_unknown");
    } catch (error) {
      if (turn.steer === pending)
        this.finishSteer(
          turn,
          error instanceof PiRpcResponseError ? "rejected" : "outcome_unknown",
        );
    }
  }

  private finishSteer(turn: Turn, outcome: Parameters<BoundarySteer["finish"]>[0]): void {
    const steer = turn.steer;
    delete turn.steer;
    if (steer?.claimed) steer.input.finish(outcome);
  }

  setModel(model: string, effort?: string): void {
    this.model.desired = model;
    this.effort.desired = effort;
    if (this.rpc && !this.starting && !this.isRunning)
      void this.applyOptions(this.rpc, this.processGeneration);
  }
  setEffort(level: string): void {
    this.effort.desired = level;
    if (this.rpc && !this.starting && !this.isRunning)
      void this.applyOptions(this.rpc, this.processGeneration);
  }
  setPanelTools(tools: PanelToolset | null): void {
    this.panelTools = tools;
    if (!this.registered) return;
    try {
      this.panelHttp.notifyToolsetChanged(this.sessionKey);
      this.appliedPanelTools = tools;
      this.panelToolsError = undefined;
    } catch (error) {
      this.panelToolsError = message(error);
    }
  }
  private async applyOptions(rpc: PiRpcClient, generation: number): Promise<void> {
    if (this.pendingOptions) await this.pendingOptions;
    if (!this.current(generation, rpc)) return;
    const work = async () => {
      const timeout = { timeoutMs: this.readyTimeoutMs };
      const apply = async (setting: Setting, setter: (desired: string) => Promise<void>) => {
        const desired = setting.desired;
        if (!desired || desired === setting.applied || !this.current(generation, rpc)) return;
        try {
          await setter(desired);
          if (!this.current(generation, rpc)) return;
          setting.applied = desired;
          setting.lastError = undefined;
        } catch (error) {
          if (this.current(generation, rpc)) setting.lastError = message(error);
        }
      };
      const previousModel = this.model.applied;
      await apply(this.model, async (desired) => {
        const model = this.resolveModel(desired);
        const slash = desired.indexOf("/");
        if (!model && slash <= 0) throw new Error(`Ambiguous or unavailable Pi model: ${desired}`);
        await rpc.setModel(
          model?.provider ?? desired.slice(0, slash),
          model?.modelId ?? desired.slice(slash + 1),
          timeout,
        );
        const [{ levels }, state] = await Promise.all([
          rpc.getAvailableThinkingLevels(timeout),
          rpc.getState(timeout),
        ]);
        if (this.current(generation, rpc)) {
          this.levels = levels;
          this.effort.applied = state.thinkingLevel;
        }
      });
      if (!this.current(generation, rpc)) return;
      const desired = this.effort.desired;
      const levels = this.getAvailableThinkingLevels(this.model.desired);
      if (desired && levels && !levels.includes(desired)) {
        this.effort.desired = undefined;
        this.emit("effort_preset_cleared");
        this.event({
          kind: "notice",
          level: "warning",
          content: `${this.model.applied} has no effort ${desired}; using ${this.effort.applied ?? "the model default"}.`,
        });
      } else if (levels) {
        await apply(this.effort, (value) => rpc.setThinkingLevel(value, timeout));
      }
      if (!this.starting && previousModel !== this.model.applied) this.emit("thinking_levels");
    };
    const pending = work();
    this.pendingOptions = pending;
    try {
      await pending;
    } finally {
      if (this.pendingOptions === pending) this.pendingOptions = undefined;
    }
  }

  private event(event: StreamEvent): void {
    this.emit("event", event);
  }
  private finish(turn: Turn, terminal?: StreamEvent): void {
    if (this.activeTurn !== turn || turn.settled) return;
    turn.settled = true;
    this.finishSteer(turn, "outcome_unknown");
    if (turn.written && !turn.accepted && turn.inputId && terminal?.kind === "error") {
      this.emit("prompt_outcome_unknown", { inputId: turn.inputId, reason: terminal.content });
    }
    this.emit("runState", this.runState);
    if (terminal) {
      this.event(terminal);
      if (terminal.kind === "error" && this.listenerCount("error"))
        this.emit("error", new Error(terminal.content));
      this.emit("done", terminal);
    }
  }

  private emitWakeup(): void {
    this.event({ kind: "notice", level: "wakeup", content: "Pi carried on" });
    this.emit("wakeup");
  }

  private handleEvent(event: Json): void {
    if (event.type === "extension_ui_request") {
      const change = decodeExtensionUi(event, () => this.unhandledUi(event));
      const { method } = event;
      if (change) this.extensionUi(change);
      else if (
        method === "select" ||
        method === "confirm" ||
        method === "input" ||
        method === "editor"
      ) {
        this.openDialog(event, method);
      } else this.unhandledUi(event);

      return;
    }
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      const reason = text(event.reason) ?? "unknown";
      const turn = this.activeTurn;
      const manual = reason === "manual" && turn?.compact && turn.written && this.live(turn);
      if (event.type === "compaction_start") {
        this.compactingRpc = this.rpc;
        if (manual && turn.inputId) {
          turn.accepted = true;
          this.emit("user_message_accepted", {
            inputId: turn.inputId,
            reportId: turn.reportId,
            generation: turn.generation,
          });
        }
        this.event({ kind: "compact", content: `Compacting context (${reason})` });
      } else {
        this.compactingRpc = undefined;
        const result = object(event.result);
        const before = num(result.tokensBefore),
          after = num(result.estimatedTokensAfter);
        const counts =
          before === undefined
            ? ""
            : `: ${before}${after === undefined ? "" : ` → ~${after}`} tokens`;
        const error = text(event.errorMessage);
        const content =
          error ??
          (event.aborted
            ? `Compaction aborted (${reason})`
            : `Context compacted (${reason})${counts}`);
        if (event.result) {
          this.stats = null;
          this.compactionBoundary = {};
          void this.syncCompactionCheckpoint(this.rpc!);
        }
        if (manual && error) this.finish(turn, { kind: "error", content });
        else {
          this.event({ kind: "compact", content });
          if (manual)
            this.finish(turn, { kind: "result", content: "", interrupted: event.aborted === true });
        }
      }
      return;
    }
    const msg = object(event.message);
    if (event.type === "message_start" || event.type === "message_end") {
      for (const run of decodeSubagentNotifyWire(msg)) {
        this.pendingDeployNotices.delete(run.runId);
        this.emit("deploy_activity");
        this.completeAsyncRun(run);
      }
    }
    if (event.type === "agent_start") {
      if (!this.isRunning) {
        this.activeTurn = newTurn(this.processGeneration);
        this.emit("runState", "working");
        this.emitWakeup();
      }
      this.activeTurn!.started = true;
      return;
    }
    const turn = this.activeTurn;
    if (!turn || !this.live(turn) || (!turn.written && !turn.started)) return;
    switch (event.type) {
      case "message_start":
        if (msg.role === "assistant") {
          turn.blocks.clear();
          turn.finalText = "";
          turn.error = undefined;
        }
        break;
      case "message_update": {
        const update = object(event.assistantMessageEvent);
        if (
          turn.steer?.observed &&
          !this.interrupting &&
          ((["text_delta", "thinking_delta"].includes(String(update.type)) &&
            !!text(update.delta)) ||
            (["text_end", "thinking_end"].includes(String(update.type)) &&
              !!text(update.content)) ||
            update.type === "toolcall_start" ||
            update.type === "toolcall_end")
        )
          this.finishSteer(turn, "read");
        this.updateMessage(turn, update);
        break;
      }
      case "message_end": {
        if (msg.role === "user" && turn.written && turn.inputId && !turn.accepted) {
          turn.accepted = true;
          this.emit("user_message_accepted", {
            inputId: turn.inputId,
            reportId: turn.reportId,
            generation: turn.generation,
          });
        } else if (msg.role === "user" && turn.steer?.claimed) {
          // Pi persists this before the provider call, which can still be aborted without a response.
          const content = text(msg.content) ?? text(list(msg.content)[0]?.text);
          const expected = turn.steer.wireText;
          turn.steer.observed ||=
            content === expected || !!content?.startsWith(`${expected}\n\n[Image`);
        } else if (msg.role === "assistant") {
          if (
            turn.steer?.observed &&
            !this.interrupting &&
            ["stop", "toolUse", "length"].includes(String(msg.stopReason))
          )
            this.finishSteer(turn, "read");
          const blocks = list(msg.content);
          turn.finalText = blocks
            .filter((block) => block.type === "text")
            .map((block) => text(block.text) ?? "")
            .join("");
          const replyUsage = object(msg.usage);
          if (msg.usage) {
            turn.replyUsage = replyUsage;
            turn.contextualInput =
              (num(replyUsage.input) ?? 0) +
              (num(replyUsage.cacheRead) ?? 0) +
              (num(replyUsage.cacheWrite) ?? 0);
          }
          turn.error =
            msg.stopReason === "error"
              ? (text(msg.errorMessage) ?? "Pi assistant failed")
              : undefined;
          // Some providers omit a block-end event; the completed message is authoritative.
          blocks.forEach((block, index) => {
            if (turn.blocks.get(index)?.ended) return;
            if (block.type === "text")
              this.updateMessage(turn, {
                type: "text_end",
                contentIndex: index,
                content: block.text,
              });
            if (block.type === "thinking")
              this.updateMessage(turn, {
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
              });
          });
        }
        break;
      }
      case "tool_execution_start":
        this.startTool(turn, event);
        break;
      case "tool_execution_end":
        this.endTool(turn, event);
        break;
      case "agent_settled":
        this.settle(turn);
        break;
      case "auto_retry_start": {
        const attempt = num(event.attempt);
        const maxAttempts = num(event.maxAttempts);
        const delayMs = num(event.delayMs);
        const count =
          attempt === undefined
            ? undefined
            : `${attempt}${maxAttempts === undefined ? "" : `/${maxAttempts}`}`;
        const delayText =
          delayMs === undefined
            ? undefined
            : delayMs >= 60_000
              ? `${Math.round(delayMs / 60_000)}m`
              : `${Number((delayMs / 1000).toFixed(1))}s`;
        const progress = [count, delayText && `in ${delayText}`].filter(Boolean).join(" ");
        const label = progress ? `Retrying (${progress})` : "Pi is retrying";
        const error = text(event.errorMessage);
        this.event({ kind: "retry", content: error ? `${label}: ${error}` : label });
        break;
      }
      case "auto_retry_end":
        if (event.success === false) turn.error = text(event.finalError) ?? turn.error;
        this.event({ kind: "retry", content: "" });
        break;
    }
  }

  private updateMessage(turn: Turn, update: Json): void {
    const index = num(update.contentIndex);
    if (index === undefined) return;
    const block = turn.blocks.get(index) ?? { content: "", startedAt: Date.now() };
    turn.blocks.set(index, block);
    switch (update.type) {
      case "thinking_start":
        this.event({ kind: "thinking_delta", content: "", startedAt: block.startedAt });
        break;
      case "text_delta":
      case "thinking_delta": {
        const delta = text(update.delta) ?? "";
        block.content += delta;
        this.event({
          kind: update.type,
          content: delta,
          ...(update.type === "thinking_delta" && { startedAt: block.startedAt }),
        });
        break;
      }
      case "text_end":
      case "thinking_end": {
        if (block.ended) return;
        block.ended = true;
        const streamed = block.content;
        block.content = text(update.content) ?? streamed;
        if (update.type === "text_end") {
          if (block.content.startsWith(streamed) && streamed.length < block.content.length)
            this.event({ kind: "text_delta", content: block.content.slice(streamed.length) });
          this.event({ kind: "text", content: block.content });
        } else {
          const durationMs = Date.now() - block.startedAt;
          this.event({ kind: "thinking_delta", content: "", durationMs, thinkingFollows: true });
          this.event({ kind: "thinking", content: block.content, durationMs });
        }
        break;
      }
      case "toolcall_end": {
        const call = object(update.toolCall);
        block.content = text(call.name) ?? "";
        block.ended = true;
        break;
      }
    }
  }

  private settle(turn: Turn): void {
    this.hasConfirmedTurns = true;
    this.emit("agent_settled", { inputId: turn.inputId });
    this.cancelDialogs();
    this.closeTurnTools(turn, "Tool stopped before completion");
    const reply = turn.replyUsage ?? {};
    this.stats = null;
    this.usage = {
      ...this.usage,
      turns: this.usage.turns + 1,
      duration_ms: this.usage.duration_ms + Date.now() - turn.startedAt,
      input_tokens: this.usage.input_tokens + (num(reply.input) ?? 0),
      output_tokens: this.usage.output_tokens + (num(reply.output) ?? 0),
      cache_read_tokens: this.usage.cache_read_tokens + (num(reply.cacheRead) ?? 0),
      cache_creation_tokens: this.usage.cache_creation_tokens + (num(reply.cacheWrite) ?? 0),
      cost_usd: (this.usage.cost_usd ?? 0) + (num(object(reply.cost).total) ?? 0),
    };
    const rpc = this.rpc!;
    if (rpc.pid) void this.captureDetached(rpc.pid);
    // Start bounded bookkeeping before notifying the queue; neither promise is awaited by it.
    void this.refreshCheckpoint(rpc, turn.generation);
    void rpc
      .getSessionStats({ timeoutMs: this.statsTimeoutMs })
      .then((stats) => {
        if (!this.current(turn.generation, rpc) || this.activeTurn?.id !== turn.id) return;
        this.stats = stats;
        const tokens = object(stats.tokens);
        this.usage = {
          ...this.usage,
          input_tokens: num(tokens.input) ?? this.usage.input_tokens,
          output_tokens: num(tokens.output) ?? this.usage.output_tokens,
          cache_read_tokens: num(tokens.cacheRead) ?? this.usage.cache_read_tokens,
          cache_creation_tokens: num(tokens.cacheWrite) ?? this.usage.cache_creation_tokens,
          cost_usd: num(stats.cost) ?? this.usage.cost_usd,
        };
        this.emit("usage", this.usage);
      })
      .catch(() => undefined);
    const window = this.models.find((model) => model.id === this.model.applied)?.contextWindow;
    this.finish(
      turn,
      turn.error && !this.interrupting
        ? { kind: "error", content: turn.error }
        : {
            kind: "result",
            content: turn.finalText,
            effort: this.effort.applied,
            interrupted: Boolean(this.interrupting),
            context:
              window !== undefined && turn.contextualInput !== undefined
                ? { window, tokens: turn.contextualInput }
                : undefined,
          },
    );
  }

  private syncCompactionCheckpoint(rpc: PiRpcClient): Promise<void> | undefined {
    const boundary = this.compactionBoundary;
    if (boundary)
      return (boundary.pending ??= this.refreshCheckpoint(rpc, this.processGeneration).finally(
        () => {
          boundary.pending = undefined;
        },
      ));
  }

  private async refreshCheckpoint(rpc: PiRpcClient, generation: number): Promise<void> {
    const boundary = this.compactionBoundary;
    if (!this.panelHttp.isControlConnected(this.sessionKey)) return;
    await this.panelHttp
      .requestSessionCheckpoint(this.sessionKey, this.statsTimeoutMs)
      .then((proof) => {
        if (
          this.current(generation, rpc) &&
          proof.sessionId === this.sessionId &&
          proof.entryCount >= this.minEntryCount
        ) {
          if (this.compactionBoundary === boundary) this.compactionBoundary = undefined;
          this.updateCheckpoint(proof.leafId, proof.entryCount, proof.sessionFile);
        }
      })
      .catch(() => undefined);
  }

  private updateCheckpoint(leafId: string | null, count: number, file: string | null): void {
    if (count < this.minEntryCount) return;
    this.expectedLeafAnchorId = leafId;
    this.minEntryCount = count;
    this.sessionFile = file ?? this.sessionFile;
    if (this.sessionProof)
      this.sessionProof = {
        ...this.sessionProof,
        leafId,
        entryCount: count,
        sessionFile: this.sessionFile,
      };
    this.emit("session_checkpoint");
  }

  async probeDispatchedReport(
    beforeLeafId: string | null,
    reportId: string,
    timeoutMs?: number,
  ): Promise<DispatchedReportProbeResult> {
    await this.ensureStarted();
    const rpc = this.rpc!,
      generation = this.processGeneration;
    const result = await this.panelHttp.probeDispatchedReport(
      this.sessionKey,
      beforeLeafId,
      reportId,
      timeoutMs,
    );
    if (!this.current(generation, rpc)) throw new Error("Pi report probe process changed");
    if (
      result.found &&
      !this.hasConfirmedTurns &&
      this.sessionProof &&
      this.sessionProof.entryCount > 0
    ) {
      this.hasConfirmedTurns = true;
      this.updateCheckpoint(
        this.sessionProof.leafId,
        this.sessionProof.entryCount,
        this.sessionProof.sessionFile,
      );
    }
    return { ...result, sessionProof: this.sessionProof };
  }

  private extensionUi(change: UiChange): void {
    this.emit("extension_ui", {
      workspaceId: this.config.workspaceId ?? "",
      agentId: this.config.agentId ?? "",
      processGeneration: this.processGeneration,
      change,
    } satisfies ExtensionUiEvent);
  }
  private advanceGeneration(): void {
    this.pendingDeployNotices.clear();
    this.processGeneration++;
    this.extensionUi({ kind: "reset" });
  }
  private unhandledUi(event: Json): void {
    // Keep terminal titles and editor/draft contents out of persistent diagnostics.
    this.emit("unhandled", {
      type: event.type,
      method: text(event.method)?.slice(0, 128),
      id: text(event.id)?.slice(0, 128),
    });
  }
  private openDialog(event: Json, method: UiDialogMethod): void {
    const id = text(event.id);
    if (!id || this.dialogs.has(id)) {
      this.unhandledUi(event);
      return;
    }
    // Preserve the tolerant dialog UI, but make malformed frames observable.
    if (
      typeof event.title !== "string" ||
      (method === "select" &&
        (!Array.isArray(event.options) || !event.options.every((v) => typeof v === "string"))) ||
      (method === "confirm" && typeof event.message !== "string") ||
      (event.timeout !== undefined && num(event.timeout) === undefined) ||
      (event.placeholder !== undefined && typeof event.placeholder !== "string") ||
      (event.prefill !== undefined && typeof event.prefill !== "string")
    )
      this.unhandledUi(event);
    const timeoutMs = Math.max(
      0,
      num(event.timeout) ?? this.options.dialogFallbackTimeoutMs ?? 110_000,
    );
    const createdAt = Date.now();
    const request: UiDialogRequest = {
      requestId: id,
      method,
      workspaceId: this.config.workspaceId ?? "",
      agentId: this.config.agentId ?? "",
      processGeneration: this.processGeneration,
      title: text(event.title) ?? "",
      message: text(event.message),
      options: Array.isArray(event.options)
        ? event.options.filter((item): item is string => typeof item === "string")
        : undefined,
      placeholder: text(event.placeholder),
      prefill: text(event.prefill),
      timeoutMs,
      createdAt,
      expiresAt: createdAt + timeoutMs,
    };
    const timer = setTimeout(
      () => this.respondToUiDialog(id, { requestId: id, cancelled: true }),
      timeoutMs,
    );
    timer.unref();
    this.dialogs.set(id, { request, timer });
    this.emit("ui_dialog_request", request);
  }

  respondToUiDialog(requestId: string, response: UiDialogResponse): void {
    const pending = this.dialogs.get(requestId);
    if (
      !pending ||
      response.requestId !== requestId ||
      pending.request.processGeneration !== this.processGeneration
    )
      return;
    const request = pending.request;
    const expired = Date.now() >= request.expiresAt;
    if (!expired && !response.cancelled) {
      if (
        request.method === "confirm"
          ? typeof response.confirmed !== "boolean"
          : typeof response.value !== "string"
      )
        return;
      if (request.method === "select" && !request.options?.includes(response.value!)) return;
    }
    clearTimeout(pending.timer);
    this.dialogs.delete(requestId);
    const cancelled = expired || response.cancelled;
    void this.rpc
      ?.sendExtensionUIResponse({
        type: "extension_ui_response",
        id: requestId,
        ...(cancelled
          ? { cancelled: true }
          : { value: response.value, confirmed: response.confirmed }),
      })
      .catch(() => undefined);
    this.emit("ui_dialog_resolved", { ...request, cancelled: Boolean(cancelled) });
  }
  private cancelDialogs(): void {
    for (const id of this.dialogs.keys())
      this.respondToUiDialog(id, { requestId: id, cancelled: true });
  }

  private startTool(turn: Turn, event: Json): void {
    const id = text(event.toolCallId),
      name = text(event.toolName);
    if (!id || !name || turn.tools.has(id)) return;
    const args = object(event.args);
    const startedAt = Date.now();
    const call = { name, args, startedAt, emitted: false };
    turn.tools.set(id, call);
    this.scheduleCaptureDetached(this.rpc?.pid);
    // A newly enabled Panel name can collide with a native extension tool.
    // Classify it from the bridge's authenticated answer, not the toolset name alone.
    if (
      this.bridgeOwnedToolNames.has(name) ||
      !this.panelTools?.tools.some((tool) => tool.name === name)
    )
      this.emitToolUse(id, call);
    if (name !== "subagent" || args.action) return;
    const mode = Array.isArray(args.chain)
      ? "chain"
      : Array.isArray(args.tasks)
        ? "parallel"
        : args.workflow
          ? "workflow"
          : "single";
    if (mode === "single" && !args.agent) return;
    const steps =
      mode === "chain"
        ? list(args.chain).flatMap((step) =>
            Array.isArray(step.parallel) ? list(step.parallel) : [step],
          )
        : mode === "parallel"
          ? list(args.tasks)
          : [args];
    // Model/effort in the tool arguments are requests, not what the child ran.
    const asyncLaunch = args.async === true;
    const children: ActiveAsyncRunRecord["children"] = steps.map((step, index) => {
      const taskId = makeSyntheticSubagentTaskId(id, index);
      this.event({
        kind: "subagent_start",
        content: "",
        subagent: {
          taskId,
          description: text(step.agent ?? step.workflow) ?? "Subagent",
          prompt: text(step.task),
          status: "running",
          cancellable: asyncLaunch,
        },
      });
      return {
        taskId,
        stepIndex: index,
        canonicalChildId: resolveCanonicalChildId(step, index),
        status: "running",
      };
    });
    turn.subagents.set(id, { mode, children });
  }

  private emitToolUse(
    id: string,
    tool: { name: string; args: Json; startedAt: number; emitted: boolean },
  ): void {
    if (tool.emitted) return;
    tool.emitted = true;
    const formatted = formatPiToolUse(tool.name, tool.args, this.bridgeOwnedToolNames);
    this.event({
      kind: "tool_use",
      ...formatted,
      toolInput:
        formatted.toolInput ??
        (formatted.toolSource === "panel" ? { tool: formatted.toolName } : undefined),
      toolUseId: id,
      startedAt: tool.startedAt,
    });
  }

  private endTool(turn: Turn, event: Json): void {
    const id = text(event.toolCallId);
    if (!id) return;
    const tool = turn.tools.get(id),
      name = tool?.name ?? text(event.toolName);
    if (!name) return;
    turn.tools.delete(id);
    if (tool) this.emitToolUse(id, tool);
    const result = object(event.result),
      detail = object(result.details);
    const formatted = formatPiToolUse(name, tool?.args, this.bridgeOwnedToolNames);
    this.event({
      kind: "tool_result",
      content: extractPiToolResultText(result.content),
      toolUseId: id,
      toolName: formatted.toolName,
      toolInput:
        formatted.toolInput ??
        (formatted.toolSource === "panel" ? { tool: formatted.toolName } : undefined),
      toolSource: formatted.toolSource,
      durationMs: tool ? Date.now() - tool.startedAt : undefined,
      isError: event.isError === true,
    });
    const call = turn.subagents.get(id);
    if (!call) return;
    turn.subagents.delete(id);
    const asyncDir = text(detail.asyncDir),
      runId = text(detail.asyncId ?? detail.runId);
    const mode = isTrackableSubagentMode(detail.mode) ? detail.mode : call.mode;
    if (asyncDir && runId && event.isError !== true) {
      const run: ActiveAsyncRunRecord = {
        runId,
        asyncDir,
        mode,
        startedAt: tool?.startedAt ?? Date.now(),
        ownerMessageId: turn.inputId ?? turn.id,
        toolCallId: id,
        children: call.children,
      };
      const steps = list(this.runStatus(run)?.steps);
      if (steps.length)
        run.children = steps.map((step, index) => ({
          taskId: makeSyntheticSubagentTaskId(id, index),
          stepIndex: index,
          canonicalChildId: resolveCanonicalChildId(step, index),
          status: step.status === "pending" ? "pending" : "running",
        }));
      for (const child of run.children) {
        const step = steps[child.stepIndex];
        const existing = child.stepIndex < call.children.length;
        const execution = observedStatusExecution(step);
        if (execution.model) child.execution = execution;
        if (existing && tool?.args.async === true && !execution.model && !execution.effort)
          continue;
        this.event({
          kind: existing ? "subagent_progress" : "subagent_start",
          content: "",
          subagent: {
            taskId: child.taskId,
            description: existing ? "" : (text(step?.agent) ?? "Subagent"),
            status: "running",
            cancellable: true,
            ...execution,
          },
        });
      }
      this.activeAsyncRuns.push(run);
      this.backgroundChanged();
      void this.captureDetached(this.rpc?.pid);
      return;
    }
    const results = list(detail.results);
    // Older Pi recordings can repeat index 0 for every child.
    const indices = results.map((result) => result.index);
    const indexed =
      indices.every((index) => typeof index === "number") &&
      new Set(indices).size === indices.length;
    for (const child of call.children) {
      const result = indexed
        ? results.find((item) => item.index === child.stepIndex)
        : results[child.stepIndex];
      this.childDone(
        child.taskId,
        terminalStatus(result?.status) ?? (event.isError === true ? "failed" : "completed"),
        result,
      );
    }
  }

  private childDone(
    taskId: string,
    status: SubAgentInfo["status"],
    result?: Json,
    startedAt?: number,
    execution = projectSubagentExecution(result),
  ): void {
    const summary = text(result?.summary ?? result?.output ?? result?.preview);
    const child = result
      ? reconstructSubagentChild(
          {
            sessionFile: text(result.sessionFile ?? result.sessionPath),
            transcriptPath: text(result.transcriptPath),
            outputTruncated: result.outputTruncated === true,
            transcriptError: text(result.transcriptError),
          },
          this.bridgeOwnedToolNames,
        )
      : undefined;
    const events = child?.events ?? [];
    let observed: ReturnType<typeof assistantExecution> = {};
    for (const message of list(result?.messages)) {
      if (message.role === "assistant") observed = { ...observed, ...assistantExecution(message) };
    }
    const model = child?.model ?? observed.model ?? execution.model;
    const effort = child?.effort ?? observed.effort ?? execution.effort;
    const durationMs =
      num(result?.durationMs ?? object(result?.progressSummary).durationMs) ??
      (startedAt === undefined ? undefined : Date.now() - startedAt);
    this.event({
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId,
        description: "",
        status,
        summary,
        events,
        eventCount: events.length,
        durationMs,
        ...(model && { model }),
        ...(effort && { effort }),
      },
    });
  }
  private closeTurnTools(turn: Turn, reason: string): void {
    for (const [id, tool] of turn.tools) {
      this.emitToolUse(id, tool);
      const { toolName, toolSource } = formatPiToolUse(
        tool.name,
        tool.args,
        this.bridgeOwnedToolNames,
      );
      this.event({
        kind: "tool_result",
        content: reason,
        toolName,
        toolSource,
        toolUseId: id,
        isError: true,
      });
    }
    for (const call of turn.subagents.values())
      for (const child of call.children) this.childDone(child.taskId, "stopped");
    turn.tools.clear();
    turn.subagents.clear();
  }
  private completeAsyncRun(update: SubagentNotifyRun, fromDisk = false): void {
    const run = this.activeAsyncRuns.find((item) => item.runId === update.runId);
    if (!run) return;
    const diskStatus = this.runStatus(run);
    const diskSteps = this.syncRunChildrenFromDisk(run, diskStatus);
    const terminal = terminalStatus(update.status);
    let changed = false;
    for (const child of run.children) {
      if (terminalStatus(child.status)) continue;
      const wireResult =
        update.children.find((item) => item.canonicalChildId === child.canonicalChildId) ??
        update.children.find((item) => item.stepIndex === child.stepIndex);
      const diskStep =
        diskSteps.find(
          (step, index) => resolveCanonicalChildId(step, index) === child.canonicalChildId,
        ) ?? diskSteps[child.stepIndex];
      const childRunId = text(diskStep?.runId ?? wireResult?.runId);
      const childStep = list(this.childRunStatus(run, childRunId)?.steps)[0];
      const status =
        terminalStatus(wireResult?.status) ??
        terminalStatus(diskStep?.status) ??
        terminalStatus(childStep?.status) ??
        terminal;
      const wireStep = object(wireResult);
      const observed = {
        ...child.execution,
        ...observedStatusExecution(diskStep),
        ...observedStatusExecution(wireStep),
        ...observedStatusExecution(childStep),
      };
      if (!status) {
        const previous = child.execution;
        if (
          observed.model &&
          (previous?.model !== observed.model || previous?.effort !== observed.effort)
        ) {
          child.execution = observed;
          changed = true;
          this.event({
            kind: "subagent_progress",
            content: "",
            subagent: {
              taskId: child.taskId,
              description: "",
              status: "running",
              cancellable: true,
              ...observed,
            },
          });
        }
        continue;
      }
      const sessionFile = text(
        wireResult?.sessionFile ??
          diskStep?.sessionFile ??
          diskStep?.sessionPath ??
          childStep?.sessionFile ??
          childStep?.sessionPath,
      );
      const transcriptPath = text(
        wireResult?.transcriptPath ?? diskStep?.transcriptPath ?? childStep?.transcriptPath,
      );
      const summary = text(
        wireResult?.summary ??
          diskStep?.summary ??
          diskStep?.output ??
          diskStep?.preview ??
          childStep?.summary ??
          childStep?.output ??
          childStep?.preview,
      );
      const transcriptError = text(
        wireResult?.transcriptError ?? diskStep?.transcriptError ?? childStep?.transcriptError,
      );
      const outputTruncated =
        wireResult?.outputTruncated === true ||
        diskStep?.outputTruncated === true ||
        childStep?.outputTruncated === true;
      const merged: Json | undefined =
        wireResult || diskStep || childStep
          ? {
              ...(sessionFile ? { sessionFile } : {}),
              ...(transcriptPath ? { transcriptPath } : {}),
              ...(summary ? { summary } : {}),
              ...(transcriptError ? { transcriptError } : {}),
              ...(outputTruncated ? { outputTruncated: true } : {}),
            }
          : undefined;
      // A parent can terminate before a queued child starts. Its roster then
      // still contains only launch candidates, not execution metadata.
      const completedSteps = [childStep, wireStep, diskStep].filter((step) => {
        const state = step?.status ?? step?.state;
        return (
          terminalStatus(state) === "completed" ||
          (state == null && status === "completed" && child.status !== "pending")
        );
      });
      child.status = status;
      changed = true;
      this.childDone(child.taskId, status, merged, run.startedAt, {
        ...projectSubagentExecution(...completedSteps),
        ...observed,
      });
    }
    if (terminal || run.children.every((child) => terminalStatus(child.status))) {
      if (fromDisk && this.rpc) this.pendingDeployNotices.add(run.runId);
      this.activeAsyncRuns = this.activeAsyncRuns.filter((item) => item !== run);
      changed = true;
    }
    if (changed) this.backgroundChanged();
  }
  private backgroundChanged(): void {
    this.scheduleReconciliation();
    this.emit("background_tasks", this.backgroundTaskList);
    this.emit("backgroundTasks"); // Existing Workspace listeners use camelCase.
    if (!this.isRunning) this.emit("runState", this.runState);
  }
  private scheduleReconciliation(): void {
    if (!this.activeAsyncRuns.length || this.disposed) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    } else if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(
        () => void this.reconcileAsyncRuns(),
        this.options.reconcileIntervalMs ?? 15_000,
      );
      this.reconcileTimer.unref();
    }
  }
  private ownsSession = (id: string | undefined): boolean => {
    if (!id) return false;
    if (id === this.sessionId || id === this.subagentsSessionId) return true;
    if (!this.sessionFile) return false;
    return id === this.sessionFile || realpath(id) === realpath(this.sessionFile);
  };
  private runStatus(run: ActiveAsyncRunRecord): Json | undefined {
    try {
      const status = object(
        JSON.parse(fs.readFileSync(path.join(run.asyncDir, "status.json"), "utf8")),
      );
      if (status.runId === run.runId && this.ownsSession(text(status.sessionId))) return status;
    } catch {
      /* Status is written independently of the RPC stream. */
    }
  }
  private childRunStatus(
    run: ActiveAsyncRunRecord,
    childRunId: string | undefined,
  ): Json | undefined {
    if (!childRunId || childRunId === "." || childRunId === ".." || /[/\\]/.test(childRunId))
      return;
    try {
      const status = object(
        JSON.parse(
          fs.readFileSync(path.join(path.dirname(run.asyncDir), childRunId, "status.json"), "utf8"),
        ),
      );
      if (status.runId === childRunId && this.ownsSession(text(status.sessionId))) return status;
    } catch {
      /* Child runner status is written independently of the parent run. */
    }
  }
  private syncRunChildrenFromDisk(run: ActiveAsyncRunRecord, diskStatus?: Json): Json[] {
    const diskSteps = list(diskStatus?.steps);
    for (const child of run.children) {
      const step = diskSteps[child.stepIndex];
      if (!step) continue;
      const resolved = resolveCanonicalChildId(step, child.stepIndex);
      if (resolved !== `step:${child.stepIndex}`) child.canonicalChildId = resolved;
    }
    return diskSteps;
  }
  async reconcileAsyncRuns(): Promise<void> {
    if (this.disposed || !this.activeAsyncRuns.length) return;
    this.reconciliation ??= this.reconcile().finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }
  private async reconcile(): Promise<void> {
    const generation = this.processGeneration;
    for (const run of [...this.activeAsyncRuns]) {
      if (this.disposed || generation !== this.processGeneration) return;
      const status = this.runStatus(run);
      const diskSteps = this.syncRunChildrenFromDisk(run, status);
      const pid = num(status?.pid ?? status?.runnerPid);
      const remote = this.panelHttp.isControlConnected(this.sessionKey)
        ? object(
            await this.panelHttp
              .sendSubagentsRpc(this.sessionKey, "status", { id: run.runId }, this.statsTimeoutMs)
              .catch(() => undefined),
          )
        : {};
      if (this.disposed || generation !== this.processGeneration) return;
      const snapshot = object(remote.asyncSnapshot);
      const remoteRun = [
        ...list(snapshot.runs ?? snapshot.jobs),
        object(remote.run),
        object(object(remote.details).run),
      ].find((item) => (item.runId ?? item.id ?? item.asyncId) === run.runId);
      const state =
        terminalStatus(status?.state) ??
        terminalStatus(remoteRun?.state ?? remoteRun?.status) ??
        (status?.state === "running" && pid !== undefined && !alive(pid) ? "failed" : undefined);
      const remoteSteps = list(remoteRun?.steps ?? remoteRun?.children);
      // completeAsyncRun reads the local steps itself; do not hide a newer
      // remote observation behind a stale local roster.
      const steps = remoteSteps.length ? remoteSteps : diskSteps;
      const [update] = decodeSubagentNotifyWire({
        role: "custom",
        customType: "subagent-notify",
        details: { runId: run.runId, ...(state ? { status: state } : {}), children: steps },
      });
      if (update) this.completeAsyncRun(update, true);
    }
  }
  async stopTask(id: string): Promise<void> {
    if (this.disposed) throw new Error("Pi session is disposed");
    await this.stop(id);
  }
  private async stop(id: string, timeoutMs?: number): Promise<void> {
    const target = resolveStopTarget(this.activeAsyncRuns, id);
    if (!target) throw new Error(`Unknown Pi subagent task: ${id}`);
    const connected = this.panelHttp.isControlConnected(this.sessionKey);
    if (target.scope === "child") {
      const deadline = Date.now() + Math.min(3_000, timeoutMs ?? 3_000);
      while (true) {
        const status = this.runStatus(target.run);
        const diskSteps = this.syncRunChildrenFromDisk(target.run, status);
        const step = diskSteps[target.child.stepIndex];
        const active = status?.state === "running" || status?.state === "queued";
        const needsWorkflowChildDir =
          !connected &&
          status?.mode === "workflow" &&
          step &&
          step.async !== false &&
          (step.async === true ||
            typeof step.runId === "string" ||
            step.parentWorkflowRunId === status.runId) &&
          !this.childRunStatus(target.run, text(step.runId));
        if (!active || (step && !needsWorkflowChildDir) || Date.now() >= deadline) break;
        await delay(25);
      }
    }
    if (connected) {
      const result = object(
        await this.panelHttp.sendSubagentsRpc(
          this.sessionKey,
          "stop",
          {
            id: target.run.runId,
            ...(target.scope === "child" ? { childId: target.child.canonicalChildId } : {}),
          },
          timeoutMs,
        ),
      );
      if (result.ok === false || result.success === false || result.error)
        throw new Error(
          text(result.error) ?? text(object(result.error).code) ?? "Pi subagent stop failed",
        );
      return;
    }
    if (!this.piSubagentsRoot) {
      try {
        this.prepareAgentHome();
      } catch {
        /* Preserve the scoped disconnected error below. */
      }
    }
    if (!this.piSubagentsRoot)
      throw new Error(`${target.scope}_stop_unavailable_bridge_disconnected`);
    const result = await executeFallbackAsyncStop(target, {
      piSubagentsRoot: this.piSubagentsRoot,
      ownsSession: this.ownsSession,
    });
    if (!result.ok) throw new Error(result.error);
  }

  private retiring?: Promise<void>;
  private onExit(
    generation: number,
    rpc: PiRpcClient,
    reason: string,
    transportBroken = false,
  ): void {
    if (!this.current(generation, rpc)) return;
    const turn = this.activeTurn;
    if (transportBroken) void this.retireProcess();
    else {
      this.cancelDialogs();
      this.rpc = undefined;
      this.compactionBoundary = undefined;
      this.compactingRpc = undefined;
      this.advanceGeneration();
      this.unregisterRoute();
      // Independent runners can still finish after an unexpected Pi exit.
      void this.reconcileAsyncRuns();
    }
    if (turn && !turn.settled) {
      this.closeTurnTools(turn, reason);
      this.finish(
        turn,
        turn.written || turn.started ? { kind: "error", content: reason } : undefined,
      );
    }
  }
  abort(): void {
    void this.interrupt();
  }
  resetContext(): void {
    this.cancelDialogs();
    if (this.rpc) void this.retireProcess();
    this.sessionId = null;
    this.sessionFile = null;
    this.subagentsSessionId = undefined;
    this.hasConfirmedTurns = false;
    this.expectedLeafAnchorId = null;
    this.minEntryCount = 0;
    this.sessionProof = undefined;
    this.bridgeOwnedToolNames.clear();
    this.tainted = false;
  }
  interrupt(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.interrupting ??= this.interruptTurn().finally(() => {
      this.interrupting = undefined;
    });
    return this.interrupting;
  }
  private async interruptTurn(): Promise<boolean> {
    this.cancelDialogs();
    const turn = this.activeTurn,
      rpc = this.rpc;
    if (!turn || turn.settled) return false;
    if (!rpc || (!turn.written && !turn.started)) {
      this.finish(turn);
      return true;
    }
    const timeoutMs = this.options.interruptTimeoutMs ?? 5_000;
    let timer: NodeJS.Timeout | undefined;
    let onDone: (() => void) | undefined;
    try {
      const settled = await new Promise<boolean>((resolve) => {
        onDone = () => resolve(turn.settled && turn.generation === this.processGeneration);
        this.on("done", onDone);
        timer = setTimeout(() => resolve(false), timeoutMs);
        void rpc.abort({ timeoutMs }).catch(() => undefined);
      });
      if (settled) return true;
      if (!this.disposed && turn.generation === this.processGeneration) {
        await this.retireProcess();
        this.closeTurnTools(turn, "Pi interrupt timed out");
        this.finish(turn, { kind: "error", content: "Pi interrupt timed out; process retired" });
      }
      return false;
    } finally {
      clearTimeout(timer);
      if (onDone) this.off("done", onDone);
    }
  }

  get deployBusy(): boolean {
    return Boolean(
      this.isRunning ||
      this.starting ||
      this.closing ||
      this.retiring ||
      this.interrupting ||
      this.pendingOptions ||
      this.compactingRpc ||
      this.reconciliation ||
      this.dialogs.size ||
      this.activeAsyncRuns.length ||
      this.pendingDeployNotices.size ||
      this.rpc?.hasPendingRequests,
    );
  }

  async retireIdleProcess(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.deployBusy) throw new Error("Pi is busy");
    const rpc = this.rpc;
    if (!rpc) return;
    if (!rpc.child || rpc.stdin.writableEnded) throw new Error("Pi retirement unavailable");
    await this.captureDetached(rpc.pid, 500);
    signal.throwIfAborted();
    if (this.deployBusy || this.rpc !== rpc) throw new Error("Pi is not idle");
    const state = await rpc.getState({ timeoutMs: 2000 });
    signal.throwIfAborted();
    if (
      this.deployBusy ||
      this.rpc !== rpc ||
      state.isStreaming ||
      state.isCompacting ||
      state.pendingMessageCount !== 0
    )
      throw new Error("Pi is not idle");
    // Keep the live generation attached until its final frames are drained.
    // onExit clears the route/transport and the next turn can resume normally.
    await retireOnEof(rpc.child, rpc.stdin);
    signal.throwIfAborted();
    await this.reapDetached(1500);
  }

  private retireProcess(): Promise<void> {
    this.cancelDialogs();
    const rpc = this.rpc;
    this.rpc = undefined;
    this.compactingRpc = undefined;
    this.compactionBoundary = undefined;
    this.tainted = true;
    this.advanceGeneration();
    this.retiring = this.shutdown(rpc, 10_000).finally(() => {
      this.retiring = undefined;
      void this.reconcileAsyncRuns();
    });
    return this.retiring;
  }

  // A registered PID alone cannot authorize a signal: fingerprint the runner
  // and its run marker, or record a known helper while it is still a descendant.
  private async processIdentity(pid: number, timeoutMs: number): Promise<string | undefined> {
    if (timeoutMs <= 0) return;
    const identity = await exec("ps", ["-ww", "-p", String(pid), "-o", "lstart=,comm="], {
      timeout: timeoutMs,
    }).catch(() => undefined);
    const fingerprint = identity?.stdout.trim();
    if (!fingerprint) return;
    // On Linux comm is only the executable basename, unlike macOS ps.
    if (process.platform !== "linux") return fingerprint;
    const executable = await fs.promises.readlink(`/proc/${pid}/exe`).catch(() => undefined);
    return executable ? `${fingerprint} ${executable}` : undefined;
  }

  private scheduleCaptureDetached(piPid?: number): void {
    if (this.disposed || (!piPid && !this.activeAsyncRuns.length)) return;
    const now = Date.now();
    if (now - this.lastHelperCaptureAt < 500) return;
    this.lastHelperCaptureAt = now;
    void this.captureDetached(piPid, 500);
  }

  private async captureDetached(piPid?: number, timeoutMs = 500): Promise<void> {
    if ((!this.activeAsyncRuns.length && !piPid) || timeoutMs <= 0) return;
    const deadline = Date.now() + timeoutMs;
    const rows = await exec("ps", ["-ww", "-axo", "pid=,ppid=,command="], {
      timeout: Math.max(1, timeoutMs),
      maxBuffer: 8 * 1024 * 1024,
    }).catch(() => undefined);
    const processes = new Map<number, { parent: number; command: string }>();
    for (const line of rows?.stdout.split("\n") ?? []) {
      const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (row) processes.set(Number(row[1]), { parent: Number(row[2]), command: row[3].trim() });
    }
    const fingerprints: Promise<void>[] = [];
    const remember = (pid: number, command: string) => {
      fingerprints.push(
        this.processIdentity(pid, deadline - Date.now()).then((identity) => {
          if (!identity) return;
          this.detachedPids.set(pid, {
            pid,
            identity,
            matchers: [new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)],
          });
        }),
      );
    };
    const belongsTo = (pid: number, parent: number): boolean => {
      for (let current = processes.get(pid)?.parent ?? 0; current > 1;) {
        if (current === parent) return true;
        const next = processes.get(current)?.parent ?? 0;
        if (next === current) break;
        current = next;
      }
      return false;
    };
    const owners = new Set<number>();
    if (piPid) owners.add(piPid);
    const rememberRunner = (runId: string, asyncDir: string, status: Json | undefined) => {
      const pid = num(status?.pid ?? status?.runnerPid);
      const command = pid ? processes.get(pid)?.command : undefined;
      if (!pid || !command || pid === process.pid) return;
      const marker =
        command.includes(`async-cfg-${runId}.json`) || command.includes(asyncDir + path.sep);
      const runner =
        /(?:^|[/\s])(?:async-runner|background-runner|subagent-runner|runner|binary-bootstrap)[\w.-]*\.(?:[cm]?js|ts)(?:\s|$)/.test(
          command,
        );
      if (runner && (marker || (piPid && belongsTo(pid, piPid)))) {
        remember(pid, command);
        owners.add(pid);
      }
    };
    for (const run of this.activeAsyncRuns) {
      const status = this.runStatus(run);
      rememberRunner(run.runId, run.asyncDir, status);
      for (const step of list(status?.steps)) {
        const childRunId = text(step.runId);
        if (!childRunId) continue;
        const childStatus = this.childRunStatus(run, childRunId);
        if (childStatus) {
          rememberRunner(
            childRunId,
            path.join(path.dirname(run.asyncDir), childRunId),
            childStatus,
          );
        }
      }
    }
    for (const [pid, { command }] of processes) {
      if (
        /(?:^|[/\s])(?:agy_acp_server(?:\.par|\.exe)?|supervisor\.mjs)(?:\s|$)/.test(command) &&
        [...owners].some((owner) => belongsTo(pid, owner))
      )
        remember(pid, command);
    }
    await Promise.all(fingerprints);
  }
  private async shutdown(rpc: PiRpcClient | undefined, totalTimeoutMs: number): Promise<void> {
    const deadline = Date.now() + totalTimeoutMs;
    const remainingTotal = () => Math.max(0, deadline - Date.now());
    try {
      if (rpc && !rpc.child) rpc.stdin.end();
      await runBudgetedShutdown({
        child: rpc?.child,
        stdin: rpc?.stdin,
        pid: rpc?.pid,
        totalTimeoutMs: remainingTotal(),
        stopDetachedChildren: async (budget) => {
          const startedAt = Date.now();
          if (this.activeAsyncRuns.length || rpc?.pid)
            await this.captureDetached(rpc?.pid, Math.min(budget, 500));
          const remaining = () => Math.max(0, budget - (Date.now() - startedAt));
          let timer: NodeJS.Timeout | undefined;
          try {
            const stops = Promise.allSettled(
              this.activeAsyncRuns.map((run) =>
                this.stop(run.runId, Math.max(1, remaining() - 100)),
              ),
            );
            const stopped = await Promise.race([
              stops,
              new Promise<[]>((resolve) => {
                timer = setTimeout(() => resolve([]), Math.max(0, remaining() - 100));
              }),
            ]);
            // Return the collected identities even if a stop request never resolves.
            while (
              stopped.some((result) => result.status === "fulfilled") &&
              remaining() > 75 &&
              [...this.detachedPids.keys()].some(alive)
            )
              await delay(Math.min(50, remaining() - 75));
          } finally {
            clearTimeout(timer);
          }
          // This session revalidates executable and process start identity in stage four.
          return [];
        },
      });
      await this.reapDetached(Math.min(1500, remainingTotal()));
    } finally {
      this.unregisterRoute();
    }
  }
  private async reapDetached(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    await Promise.all(
      [...this.detachedPids.values()].map(async ({ pid, identity, matchers }) => {
        if (identity !== (await this.processIdentity(pid, remaining()))) return;
        await killVerifiedPid(pid, matchers, remaining());
      }),
    );
    for (const pid of this.detachedPids.keys()) if (!alive(pid)) this.detachedPids.delete(pid);
  }

  private unregisterRoute(): void {
    if (this.registered) this.panelHttp.unregisterSession(this.sessionKey);
    this.registered = false;
  }

  dispose(totalTimeoutMs = 10_000): Promise<void> {
    if (this.closing) return this.closing;
    this.cancelDialogs();
    this.disposed = true;
    this.advanceGeneration();
    clearInterval(this.reconcileTimer);
    if (this.activeTurn) {
      this.activeTurn.settled = true;
      this.finishSteer(this.activeTurn, "outcome_unknown");
    }
    const rpc = this.rpc;
    this.rpc = undefined;
    this.closing = (this.retiring ?? this.shutdown(rpc, totalTimeoutMs)).finally(async () => {
      await listens.get(this.panelHttp)?.catch(() => undefined);
      if (this.ownsPanel) await this.panelHttp.close();
      if (this.home && !this.config.dataDir) {
        for (const dir of [
          this.home.piAgentDir,
          this.home.geminiHome,
          this.home.env.PI_SUBAGENTS_TEMP_ROOT,
        ])
          if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    return this.closing;
  }
}
