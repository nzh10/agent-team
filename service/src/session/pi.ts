import type { CcpaProxy } from "../acp-proxy/proxy";
import type { ObserveRequest } from "../acp-proxy/limit-evidence";
import { futureReset, refusalText, type PiTurnLimit } from "./pi-rate-limit";
import { lifecycleWriter } from "../usage/lifecycle";
import { estimatedContext, type ContextUsage } from "../../../shared/context-usage";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { UsageObservation } from "../../../shared/usage";
import type { PanelToolset } from "../project/tools";
import { isTransientTransportFailure } from "../project/network-failure";
import { ACP_PREPARE_STEP, inspectAcpRuntime } from "./acp-readiness";
import { applyNonInteractiveGitEnv } from "./git-env";
import type { BoundarySteer, HostSessionHandle } from "./host";
import { PanelHttpServer, type PanelHttpAddress, type SessionCheckpoint } from "./panel-http";
import { discoverLocalPiPackages, prepareControlledPiAgentHome } from "./pi-agent-home";
import { piAcpAuthGuidance } from "./pi-acp-auth";
import { signPiRecoveryPrompt } from "./pi-recovery-context";
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
  consumedJsonlOffset,
  createIncrementalJsonlCursor,
  createSubagentProjectionState,
  decodeSubagentNotifyWire,
  executeFallbackAsyncStop,
  isSafeChildRunId,
  isTrackableSubagentMode,
  makeSyntheticSubagentTaskId,
  assistantExecution,
  observedStatusExecution,
  projectAsyncEventRecord,
  projectSessionV3Record,
  projectSubagentExecution,
  projectTranscriptArtifactRecord,
  readIncrementalJsonlRecords,
  reconstructSubagentChild,
  resolveCanonicalChildId,
  resolveStopTarget,
  resolveWorkflowStepIndex,
  type IncrementalJsonlCursor,
  type SubagentNotifyRun,
  type SubagentProjectionState,
} from "./pi-subagents";
import { projectPiSubagentTree } from "./pi-subagent-tree";
import { readPiSubagentFinalOutput } from "./pi-subagent-output";
import {
  bindPiSubagentWidgetChildren,
  decodePiSubagentWidget,
  decodePiSubagentSnapshot,
  type PiSubagentWidgetNode,
} from "./pi-subagent-widget";
import { encodePiPairedPrompt, PI_PANEL_CONTEXT_TYPE } from "./pi-panel-bridge";
import { decodeExtensionUi } from "./pi-extension-ui";
import { extractPiToolResultText, formatPiToolUse } from "./pi-tool-format";
import { ACP } from "./quota-schema";
import { retireOnEof } from "./retire";
import { piAssistantUsage, piUsage } from "./usage-observation";
import { formatReportMarker } from "./types";
import type {
  ActiveAsyncChildRecord,
  ActiveAsyncRunRecord,
  DispatchAttempt,
  BackgroundTask,
  BoundedSessionProof,
  CommandInfo,
  DispatchedReportProbeResult,
  PersistedSessionAnchor,
  PiAvailableModel,
  PromptEnvelope,
  InputTrigger,
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
  recordUsage?: (observation: UsageObservation) => void;
  panelHttp?: PanelHttpServer;
  rpcFactory?: (options: PiRpcSpawnOptions) => PiRpcClient;
  env?: NodeJS.ProcessEnv;
  ccpaProxy?: Pick<CcpaProxy, "url" | "registerSession">;
  piBinary?: string;
  piArgs?: string[];
  interruptTimeoutMs?: number;
  reconcileIntervalMs?: number;
  livePollIntervalMs?: number;
  statsTimeoutMs?: number;
  readyTimeoutMs?: number;
  anchorTimeoutMs?: number;
  anchorPollIntervalMs?: number;
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
function piTerminalError(content: string): StreamEvent {
  const transient = isTransientTransportFailure(content);
  return { kind: "error", content, ...(transient && { networkFailure: true }) };
}

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

interface ParsedSessionFile {
  header: Json;
  entries: Json[];
  branch: Json[];
  leafId: string | null;
  corruptLine?: number;
  tornTail?: boolean;
}

function validTextImageContent(content: unknown, allowString: boolean, allowImage = true): boolean {
  if (allowString && typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const block = value as Json;
    if (block.type === "text") return typeof block.text === "string";
    return (
      allowImage &&
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    );
  });
}

function validSessionMessage(entry: Json): boolean {
  const value = entry.message;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const msg = value as Json;
  switch (msg.role) {
    case "bashExecution":
      return (
        typeof msg.command === "string" &&
        typeof msg.output === "string" &&
        typeof msg.cancelled === "boolean" &&
        typeof msg.truncated === "boolean"
      );
    case "system":
      return validTextImageContent(msg.content, true, false);
    case "user":
      return validTextImageContent(msg.content, true);
    case "custom":
      return typeof msg.customType === "string" && validTextImageContent(msg.content, true);
    case "toolResult":
      return (
        typeof msg.toolCallId === "string" &&
        typeof msg.toolName === "string" &&
        validTextImageContent(msg.content, false)
      );
    case "assistant":
      return (
        Array.isArray(msg.content) &&
        msg.content.every((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const block = value as Json;
          if (block.type === "text") return typeof block.text === "string";
          if (block.type === "thinking") return typeof block.thinking === "string";
          return (
            block.type === "toolCall" &&
            typeof block.id === "string" &&
            typeof block.name === "string" &&
            Boolean(block.arguments) &&
            typeof block.arguments === "object" &&
            !Array.isArray(block.arguments)
          );
        })
      );
    default:
      return false;
  }
}

function readRegularFile(file: string): string {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
  );
  try {
    if (!fs.fstatSync(fd).isFile())
      throw new Error(`Pi session path is not a regular file: ${file}`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Unlike Pi's tolerant loader, a malformed complete record is not valid proof.
// An unterminated malformed tail may still be in flight, so only its valid prefix
// participates in a checkpoint; a later poll can prove the completed record.
function readSessionFile(file: string): ParsedSessionFile {
  const lines = readRegularFile(file).split("\n");
  const tail = lines.pop() ?? "";
  const records = [
    ...lines.map((line) => ({ line, terminated: true })),
    ...(tail ? [{ line: tail, terminated: false }] : []),
  ];
  let header: Json | undefined;
  let corruptLine: number | undefined;
  let tornTail = false;
  const entries: Json[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const line = record.line.endsWith("\r") ? record.line.slice(0, -1) : record.line;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (!record.terminated) {
        tornTail = true;
        break;
      }
      corruptLine = index + 1;
      break;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      corruptLine = index + 1;
      break;
    }
    const entry = value as Json;
    if (!header) {
      if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id) {
        corruptLine = index + 1;
        break;
      }
      header = entry;
      continue;
    }
    if (
      entry.type === "session" ||
      typeof entry.type !== "string" ||
      typeof entry.id !== "string" ||
      !entry.id ||
      (entry.parentId !== null && typeof entry.parentId !== "string") ||
      (entry.type === "message" && !validSessionMessage(entry))
    ) {
      corruptLine = index + 1;
      break;
    }
    entries.push(entry);
  }
  if (!header)
    throw new Error(
      corruptLine
        ? `Pi session header is not parseable at line ${corruptLine}`
        : "Pi session file has no session header",
    );
  const byId = new Map<string, Json>();
  for (const entry of entries) {
    const id = entry.id as string;
    const parentId = entry.parentId as string | null;
    if (byId.has(id) || (parentId !== null && !byId.has(parentId)))
      throw new Error(`Pi session entry tree is broken at ${id}`);
    byId.set(id, entry);
  }
  const leafId = entries.at(-1)?.id as string | undefined;
  const branch: Json[] = [];
  let current = leafId ? byId.get(leafId) : undefined;
  while (current) {
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId as string) : undefined;
  }
  branch.reverse();
  return { header, entries, branch, leafId: leafId ?? null, corruptLine, tornTail };
}

function sessionMessageText(entry: Json): string | undefined {
  const content = object(entry.message).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map(object)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

// A removed agent cannot be resumed to run the bridge's live probe. A
// durable input entry proves receipt; absence never proves non-delivery
// (Pi can buffer an initial user entry until the first assistant entry).
export function hasPersistedPiReport(attempt: DispatchAttempt, cwd: string): boolean {
  if (!attempt.piSession || !attempt.reportId) return false;
  try {
    const parsed = readSessionFile(attempt.piSession.file);
    validateSessionHeader(parsed, attempt.piSession.id, cwd);
    const marker = formatReportMarker(attempt.reportId);
    return parsed.entries.some(
      (entry, index) =>
        index >= attempt.beforeEntryCount &&
        ((entry.type === "custom_message" &&
          entry.customType === PI_PANEL_CONTEXT_TYPE &&
          object(entry.details).reportId === attempt.reportId) ||
          (entry.type === "message" &&
            object(entry.message).role === "user" &&
            sessionMessageText(entry)?.startsWith(marker))),
    );
  } catch {
    return false;
  }
}

function validateSessionHeader(parsed: ParsedSessionFile, sessionId: string, cwd: string): void {
  if (parsed.header.id !== sessionId) throw new Error("Pi session header ID does not match");
  const headerCwd = text(parsed.header.cwd);
  if (!headerCwd || realpath(headerCwd) !== cwd)
    throw new Error("Pi session header cwd does not match");
}

function verifyPersistedSessionAnchor(anchor: PersistedSessionAnchor, cwd: string): void {
  const parsed = readSessionFile(anchor.sessionFile);
  if (parsed.corruptLine)
    throw new Error(`Pi session JSONL is corrupt at line ${parsed.corruptLine}`);
  if (parsed.tornTail)
    throw new Error("Pi session JSONL ends with a torn record; repair it before restore");
  validateSessionHeader(parsed, anchor.sessionId, cwd);
  if (anchor.entryCount < 1 || parsed.entries.length < anchor.entryCount)
    throw new Error("Pi session file is shorter than the persisted anchor");
  if (parsed.entries[anchor.entryCount - 1]?.id !== anchor.leafId)
    throw new Error("Pi session entry count does not match the persisted anchor");
  if (!parsed.branch.some((entry) => entry.id === anchor.leafId))
    throw new Error("Pi persisted anchor is not on the active branch");
}

interface BlockState {
  content: string;
  startedAt: number;
  ended?: boolean;
  kind?: "text" | "thinking" | "toolcall";
  emittedTextLength: number;
  thinkingEndedAt?: number;
}

interface FirstInputClaim {
  text: string;
  sessionFile: string | null;
  sessionId: string | null;
  beforeLeafId: string | null;
  beforeEntryCount: number;
}

interface AnchorProbe {
  generation: number;
  deadline: number;
  pending?: Promise<void>;
}

interface Turn {
  trigger: InputTrigger;
  modelTrigger: InputTrigger | "continuation";
  modelStep?: { id: string; firstDelta: boolean };
  steer?: { input: BoundarySteer; wireText: string; claimed: boolean; observed: boolean };
  anchorInput?: FirstInputClaim;
  paired: boolean;
  recovery: boolean;
  recoveryNotEmpty?: boolean;
  id: string;
  inputId?: string;
  reportId?: string;
  generation: number;
  settled: boolean;
  written: boolean;
  started: boolean;
  accepted: boolean;
  startedAt: number;
  blocks: Map<number, BlockState>;
  replyTextLength: number;
  messageBaseOffset: number;
  tools: Map<string, { name: string; args: Json; startedAt: number; emitted: boolean }>;
  subagents: Map<
    string,
    {
      mode: ActiveAsyncRunRecord["mode"];
      asyncLaunch: boolean;
      children: ActiveAsyncRunRecord["children"];
    }
  >;
  replyUsage?: Json;
  finalText: string;
  error?: string;
  compact?: boolean;
  acpAttempt?: { model?: string; reset?: number };
  limit?: PiTurnLimit;
}

type ChildSourceFormat = "async_events" | "transcript" | "session_v3";

interface LiveTailWatch {
  cursor: IncrementalJsonlCursor;
  format: ChildSourceFormat;
  run?: ActiveAsyncRunRecord;
  cursorKey?: string;
  targetTaskId?: string;
  fileWatcher?: fs.FSWatcher;
  dirWatcher?: fs.FSWatcher;
  watchedDir?: string;
  active: boolean;
  scheduled: boolean;
  onRecords: (records: Json[]) => void;
}

interface ForegroundSubagentTracker {
  toolCallId: string;
  rowBindings: Map<string, ActiveAsyncChildRecord>;
  childWatches: Map<string, LiveTailWatch>;
}

interface AsyncRunTracker {
  run: ActiveAsyncRunRecord;
  parentWatch: LiveTailWatch;
  childWatches: Map<string, LiveTailWatch>;
  childTaskIds: Map<string, string>;
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
  const trigger = envelope ? (envelope.trigger ?? "user") : "auto";
  return {
    id: randomUUID(),
    trigger,
    modelTrigger: trigger,
    inputId: envelope?.inputId,
    reportId: envelope?.reportId,
    paired: envelope?.panelContext !== undefined,
    recovery: !!envelope?.recovery,
    generation,
    settled: false,
    written: false,
    started: false,
    accepted: false,
    startedAt: Date.now(),
    blocks: new Map(),
    replyTextLength: 0,
    messageBaseOffset: 0,
    tools: new Map(),
    subagents: new Map(),
    finalText: "",
  };
}

function terminalStatus(value: unknown): SubAgentInfo["status"] | undefined {
  if (["completed", "complete", "success", "succeeded", "done"].includes(String(value)))
    return "completed";
  if (value === "paused" || value === "partial" || value === "rejected") return value;
  if (value === "interrupted") return "stopped";
  if (["failed", "error", "crashed"].includes(String(value))) return "failed";
  if (["stopped", "cancelled", "canceled", "aborted", "skipped"].includes(String(value)))
    return "stopped";
}

function workflowTaskId(run: ActiveAsyncRunRecord, index: number, key: string): string {
  const candidate = makeSyntheticSubagentTaskId(run.toolCallId, index);
  return run.children.some((child) => child.taskId === candidate)
    ? `${run.toolCallId}:key:${key}`
    : candidate;
}

function executionDuration(...records: (Json | undefined)[]): number | undefined {
  for (const r of records) {
    const duration = num(r?.durationMs ?? object(r?.progressSummary).durationMs);
    if (duration !== undefined && Number.isSafeInteger(duration) && duration >= 0) return duration;
  }
  for (const r of records) {
    const start = num(r?.startedAt),
      end = num(r?.endedAt);
    if (
      start !== undefined &&
      end !== undefined &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end >= start
    )
      return end - start;
  }
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
  private panelToken?: string;
  private readonly panelHttp: PanelHttpServer;
  private readonly sessionKey = randomUUID();
  private readonly ownsPanel: boolean;
  private acpRoute?: ReturnType<CcpaProxy["registerSession"]>;
  private acpVariants = new Map<string, Json>();
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
  private context: ContextUsage | null = null;
  private contextRevision = 0;
  private compactionBoundary?: {
    pending?: Promise<void>;
    reconcile?: (proof: SessionCheckpoint) => void;
  };
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private interrupting?: Promise<boolean>;
  private disposed = false;
  private tainted = false;
  private processGeneration = 0;
  private activeTurn: Turn | null = null;
  // A send awaiting Pi's command-specific preflight is not the owner of a native wake.
  private openingTurn?: Turn;
  private boundarySource?: () => BoundarySteer | undefined;
  private sessionFile: string | null = null;
  private expectedLeafAnchorId: string | null = null;
  private minEntryCount = 0;
  private hasUnanchoredInput = false;
  private persistedSessionAnchor?: PersistedSessionAnchor;
  private anchorProbe?: AnchorProbe;
  private hasConfirmedTurns = false;
  private sessionProof?: BoundedSessionProof;
  private subagentsSessionId?: string;
  private piSubagentsRoot?: string;
  private home?: ReturnType<typeof prepareControlledPiAgentHome>;
  private registered = false;
  private bridgeOwnedToolNames = new Set<string>();
  private activeAsyncRuns: ActiveAsyncRunRecord[] = [];
  // Recent settled bindings let delayed completion notices enrich an existing message after restore.
  private settledAsyncRuns: ActiveAsyncRunRecord[] = [];
  // Only receipts/checkpoints may claim a root; short history bridges widget-before-receipt.
  private readonly earlyWidgetRoots: PiSubagentWidgetNode[] = [];
  private latestWidgetIds = new Set<string>();
  private readonly pushCoverage = new Map<string, Set<string>>();
  // A terminal status file can precede the live extension's notification.
  private readonly pendingDeployNotices = new Set<string>();
  private reconciliation?: Promise<void>;
  private reconcileTimer?: NodeJS.Timeout;
  private readonly subagentProjectionStates = new Map<
    string,
    {
      state: SubagentProjectionState;
      emittedExecution?: { model?: string; effort?: string };
      lastTool?: string;
      hasLiveEvents?: boolean;
    }
  >();
  private readonly foregroundTrackers = new Map<string, ForegroundSubagentTracker>();
  private readonly asyncTrackers = new Map<string, AsyncRunTracker>();
  private foregroundPollTimer?: NodeJS.Timeout;
  private asyncPollTimer?: NodeJS.Timeout;
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
    this.lifecycle = lifecycleWriter(this.config, "pi", () => this.sessionId);
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
    session.persistedSessionAnchor = state.persistedSessionAnchor
      ? { ...state.persistedSessionAnchor }
      : undefined;
    session.sessionId = state.sessionId ?? session.persistedSessionAnchor?.sessionId ?? null;
    session.sessionFile = state.sessionFile ?? session.persistedSessionAnchor?.sessionFile ?? null;
    session.expectedLeafAnchorId =
      state.expectedLeafAnchorId ?? session.persistedSessionAnchor?.leafId ?? null;
    session.minEntryCount = state.minEntryCount ?? session.persistedSessionAnchor?.entryCount ?? 0;
    session.hasUnanchoredInput = state.hasUnanchoredInput ?? false;
    session.hasConfirmedTurns = state.hasConfirmedTurns ?? false;
    session.model.desired = state.desiredModel ?? state.config.model;
    session.effort.desired = state.desiredEffort ?? state.config.effort;
    session.usage = { ...state.usage };
    session.activeAsyncRuns = structuredClone(state.activeAsyncRuns ?? []);
    session.settledAsyncRuns = structuredClone(state.settledAsyncRuns ?? []);
    for (const run of session.activeAsyncRuns) {
      for (const child of run.children) {
        if (child.execution?.model || child.execution?.effort || child.hasLiveEvents) {
          const entry = session.getOrCreateProjectionState(child.taskId);
          if (child.execution?.model || child.execution?.effort) {
            entry.emittedExecution = { ...child.execution };
            entry.state.execution = { ...child.execution };
          }
          if (child.hasLiveEvents) entry.hasLiveEvents = true;
        }
      }
    }
    session.scheduleReconciliation();
    if (session.activeAsyncRuns.length) {
      queueMicrotask(() => {
        if (session.disposed) return;
        for (const run of session.activeAsyncRuns) session.startAsyncRunTracker(run);
        void session.reconcileAsyncRuns();
      });
    }
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
      hasUnanchoredInput: this.hasUnanchoredInput,
      ...(this.persistedSessionAnchor && {
        persistedSessionAnchor: { ...this.persistedSessionAnchor },
      }),
      hasConfirmedTurns: this.hasConfirmedTurns,
      desiredModel: this.model.desired,
      desiredEffort: this.effort.desired,
      activeAsyncRuns: structuredClone(this.activeAsyncRuns),
      ...(this.settledAsyncRuns.length && {
        settledAsyncRuns: structuredClone(this.settledAsyncRuns),
      }),
    };
  }

  get isRunning(): boolean {
    return Boolean(
      (this.activeTurn && !this.activeTurn.settled) ||
      (this.openingTurn && !this.openingTurn.settled),
    );
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
      (this.model.desired !== undefined &&
        this.canonicalModel(this.model.desired) !== this.model.applied) ||
      (this.effort.desired !== undefined && this.effort.desired !== this.effort.applied) ||
      this.panelTools !== this.appliedPanelTools
    );
  }
  get interruptPending(): boolean {
    return Boolean(this.interrupting);
  }
  get pendingUiDialogs(): UiDialogRequest[] {
    return [...this.dialogs.values()].map(({ request }) => request);
  }
  get backgroundTaskList(): BackgroundTask[] {
    return this.activeAsyncRuns.flatMap((run) => {
      const lanes = run.children
        .filter((child) => !terminalStatus(child.status))
        .map((child) => ({
          id: child.taskId,
          type: "local_agent",
          description: child.canonicalChildId,
          since: child.startedAt ?? run.startedAt,
          status:
            child.status === "queued" || child.status === "pending"
              ? ("queued" as const)
              : ("running" as const),
          cancellable: true,
        }));
      return lanes.length
        ? lanes
        : [
            {
              id: run.runId,
              type: "local_agent",
              description: run.mode,
              since: run.startedAt,
              status: "running" as const,
              cancellable: true,
            },
          ];
    });
  }
  getAvailableModels(): PiAvailableModel[] {
    return this.models.slice();
  }
  getAvailableThinkingLevels(model = this.model.applied): string[] | undefined {
    return this.rpc && this.canonicalModel(model) === this.model.applied
      ? this.levels?.slice()
      : undefined;
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
    const context = this.context;
    return Promise.resolve(
      context && {
        totalTokens: context.tokens,
        maxTokens: context.window,
        percentage: (context.tokens / context.window) * 100,
        model: this.model.applied,
        estimated: context.estimated,
      },
    );
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
    this.piSubagentsRoot = this.config.piSubagentsRoot ?? packages.piSubagentsRoot;
    return {
      agentDir,
      settings,
      providerEntry:
        this.home?.piAcpProfileError || this.home?.piAcpAuthError
          ? undefined
          : (this.config.piAntigravityEntryPath ?? packages.piAntigravityEntryPath),
    };
  }

  private async start(): Promise<void> {
    if (!fs.statSync(this.normalizedCwd, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`Pi cwd is not a directory: ${this.normalizedCwd}`);
    let sessionArgs: string[];
    const strictResume = this.hasConfirmedTurns || Boolean(this.persistedSessionAnchor);
    if (this.persistedSessionAnchor) {
      const anchor = this.persistedSessionAnchor;
      try {
        if (
          this.sessionFile !== anchor.sessionFile ||
          this.sessionId !== anchor.sessionId ||
          realpath(anchor.sessionFile) !== anchor.sessionFile
        )
          throw new Error("saved session identity does not match the canonical persisted anchor");
        verifyPersistedSessionAnchor(anchor, this.normalizedCwd);
        if (
          this.hasConfirmedTurns &&
          (this.expectedLeafAnchorId !== anchor.leafId || this.minEntryCount !== anchor.entryCount)
        ) {
          if (!this.expectedLeafAnchorId || this.minEntryCount < 1 || !this.sessionId)
            throw new Error("confirmed session has no persisted checkpoint");
          verifyPersistedSessionAnchor(
            {
              sessionFile: anchor.sessionFile,
              sessionId: this.sessionId,
              leafId: this.expectedLeafAnchorId,
              entryCount: this.minEntryCount,
            },
            this.normalizedCwd,
          );
        }
      } catch (error) {
        throw new Error(`Pi persisted session recovery failed: ${message(error)}`);
      }
      sessionArgs = ["--session", anchor.sessionFile];
    } else if (this.hasUnanchoredInput) {
      throw new Error(
        "Pi recovery is ambiguous: an input may have been written before its durable session anchor was saved; refusing to resume or replay it",
      );
    } else if (this.hasConfirmedTurns) {
      if (!this.sessionFile || !this.sessionId || !this.expectedLeafAnchorId)
        throw new Error("Pi restore requires a saved nonempty session checkpoint");
      try {
        verifyPersistedSessionAnchor(
          {
            sessionFile: this.sessionFile,
            sessionId: this.sessionId,
            leafId: this.expectedLeafAnchorId,
            entryCount: this.minEntryCount,
          },
          this.normalizedCwd,
        );
      } catch (error) {
        throw new Error(`Pi restore session validation failed: ${message(error)}`);
      }
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
    this.panelToken = token;
    try {
      const env = applyNonInteractiveGitEnv({
        ...process.env,
        ...this.options.env,
        ...this.home?.env,
      });
      if (this.options.ccpaProxy) {
        if (env.AGY_ACP_CCPA_BASE_URL === undefined && !this.options.catalogOnly)
          this.acpRoute = this.options.ccpaProxy.registerSession(this.acpObserver(generation));
        env.AGY_ACP_CCPA_BASE_URL ??= this.acpRoute?.url ?? this.options.ccpaProxy.url;
        const bypass = (value: string | undefined) =>
          [
            ...new Set([
              ...(value ?? "")
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
              "localhost",
              "127.0.0.1",
            ]),
          ].join(",");
        const { NO_PROXY, no_proxy } = env;
        env.NO_PROXY = bypass(NO_PROXY ?? no_proxy);
        env.no_proxy = bypass(no_proxy ?? NO_PROXY);
      }
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
        (strictResume &&
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
      this.acpVariants.clear();
      const available = models.flatMap((row) => {
        const model = object(row);
        const provider = text(model.provider),
          modelId = text(model.id ?? model.modelId);
        if (provider === ACP && modelId)
          this.acpVariants.set(modelId, object(model.thinkingLevelMap));
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
      if (strictResume) this.updateCheckpoint(proof.leafId, proof.entryCount, proof.sessionFile);
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

  private acpObserver(generation: number): ObserveRequest {
    const snapshots = new Map<string, Map<string, number>>();
    const latest = new Map<string, symbol>();
    return (op) => {
      if (generation !== this.processGeneration || this.disposed) return;
      if (op !== "streamGenerateContent") {
        const request = Symbol();
        latest.set(op, request);
        return (observation) => {
          if (observation.kind === "quota" && latest.get(op) === request)
            snapshots.set(op, observation.exhausted);
        };
      }
      const turn = this.activeTurn;
      if (
        !turn ||
        !this.live(turn) ||
        !(turn.started || turn.written) ||
        // ACP descendants inherit the environment. Never attribute a shared
        // route's traffic while a child could be making its own model calls.
        this.activeAsyncRuns.length ||
        this.foregroundTrackers.size ||
        [...turn.tools.values()].some((tool) => tool.name === "subagent") ||
        !this.model.applied?.startsWith(`${ACP}/`)
      )
        return;
      const model = this.model.applied.slice(ACP.length + 1);
      const variants = this.acpVariants.get(model);
      const attempt: NonNullable<Turn["acpAttempt"]> = {};
      turn.acpAttempt = attempt; // even a transport failure supersedes the previous 429
      return (response) => {
        if (
          !this.live(turn) ||
          turn.acpAttempt !== attempt ||
          response.kind !== "response" ||
          !response.limited ||
          (model !== response.model && !Object.values(variants ?? {}).includes(response.model))
        )
          return;
        attempt.model = response.model;
        attempt.reset =
          futureReset(response.resetsAt) ??
          futureReset(Math.max(...[...snapshots.values()].map((s) => s.get(response.model) ?? 0)));
      };
    };
  }

  private resolveModel(desired: string): PiAvailableModel | undefined {
    const exact = this.models.find((model) => model.id === desired);
    if (exact) return exact;
    const matches = this.models.filter((model) => model.modelId === desired);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private canonicalModel(model?: string): string | undefined {
    return model ? (this.resolveModel(model)?.id ?? model) : undefined;
  }

  private usesAcpModel(): boolean {
    return [this.model.desired, this.model.applied].some(
      (model) =>
        !!model && (model.startsWith(`${ACP}/`) || this.resolveModel(model)?.provider === ACP),
    );
  }

  private acpPromptError(input: string, compact: boolean): string | undefined {
    const runtimeError = () =>
      this.home?.piAcpProfileError ??
      this.home?.piAcpAuthError ??
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
    if (this.usesAcpModel()) return runtimeError();
  }

  async send(input: string | PromptEnvelope, hooks?: SendHooks): Promise<SendReceipt> {
    if (this.disposed || this.isRunning) throw new Error("Pi session is busy or disposed");
    const envelope = typeof input === "string" ? { inputId: randomUUID(), text: input } : input;
    const turn = newTurn(this.processGeneration, envelope);
    const compact = !turn.paired && /^\/compact(?:\s+([\s\S]+))?$/.exec(envelope.text.trim());
    if (compact && envelope.attachmentIds?.length)
      throw new Error("/compact does not accept attachments");
    turn.compact = Boolean(compact);
    this.activeTurn = this.openingTurn = turn;
    const checkBeforeWrite = () => {
      if (
        this.openingTurn === turn &&
        this.activeTurn !== turn &&
        !this.interrupting &&
        !this.disposed &&
        this.processGeneration === turn.generation
      )
        throw new PiRpcResponseError(
          compact ? "compact" : "prompt",
          "Pi is already processing a turn",
        );
      if (!this.live(turn) || this.interrupting) throw new Error("Pi prompt dispatch cancelled");
    };
    try {
      this.emit("runState", "working");
      const images = readPiAttachments(this.config.uploadsDir, envelope.attachmentIds);
      await this.ensureStarted();
      if (this.interrupting) await this.interrupting;
      checkBeforeWrite();
      const rpc = this.rpc!;
      await this.applyOptions(rpc, turn.generation);
      checkBeforeWrite();
      if (this.compactionBoundary) await this.syncCompactionCheckpoint(rpc);
      const onBeforeWrite = () => {
        if (this.compactionBoundary)
          throw new PiRpcResponseError("compact", "Waiting for Pi compaction checkpoint");
        if (this.compactingRpc === rpc)
          throw new PiRpcResponseError(
            compact ? "compact" : "prompt",
            "Pi is already processing a turn",
          );
        checkBeforeWrite();
        const acpError = this.acpPromptError(envelope.text, Boolean(compact));
        if (acpError) throw new PiRpcResponseError(compact ? "compact" : "prompt", acpError);
        const hadUnanchoredInput = this.hasUnanchoredInput;
        if (!compact && !this.hasConfirmedTurns && !this.persistedSessionAnchor) {
          turn.anchorInput = {
            text: envelope.text,
            sessionFile: this.sessionFile,
            sessionId: this.sessionId,
            beforeLeafId: this.sessionProof?.leafId ?? this.expectedLeafAnchorId,
            beforeEntryCount: this.sessionProof?.entryCount ?? this.minEntryCount,
          };
          // The workspace hook saves this claim before stdin can accept the input.
          this.hasUnanchoredInput = true;
        }
        try {
          hooks?.onBeforeWrite?.({
            inputId: envelope.inputId,
            reportId: envelope.reportId,
            generation: turn.generation,
            beforeLeafId: this.expectedLeafAnchorId,
            beforeEntryCount: this.minEntryCount,
            startedAt: Date.now(),
            ...(envelope.reportId &&
              this.sessionFile &&
              this.sessionId && {
                piSession: { file: this.sessionFile, id: this.sessionId },
              }),
          });
        } catch (error) {
          // PiRpcClient has not invoked stdin.write yet: this was never a write claim.
          turn.anchorInput = undefined;
          this.hasUnanchoredInput = hadUnanchoredInput;
          throw error;
        }
        turn.written = true;
        if (turn.anchorInput) queueMicrotask(() => this.schedulePersistedAnchor(turn, rpc));
      };
      if (compact) {
        await rpc.compact(compact[1], onBeforeWrite);
        this.finish(turn, { kind: "result", content: "" });
        return { disposition: "handled" };
      }
      if (envelope.recovery && !this.panelToken)
        throw new Error("Pi recovery requires a panel route");
      let wireText = this.panelToken
        ? signPiRecoveryPrompt(envelope, this.panelToken)
        : envelope.text;
      if (envelope.panelContext !== undefined) {
        if (!this.panelToken || !envelope.reportId)
          throw new Error("Pi paired prompt requires a panel route and report ID");
        wireText = encodePiPairedPrompt(
          {
            userText: wireText,
            panelContext: envelope.panelContext,
            reportId: envelope.reportId,
          },
          this.panelToken,
        );
      }
      const reply = await rpc.prompt(wireText, {
        images,
        onBeforeWrite,
        onStarted: () => {
          if (this.openingTurn !== turn || turn.settled || !this.current(turn.generation, rpc))
            return;
          this.openingTurn = undefined;
          this.activeTurn = turn;
        },
        ...(/^\/quota(?:\s|$)/.test(envelope.text.trimStart()) && { timeoutMs: 50_000 }),
      });
      if (reply?.disposition === "handled") {
        this.clearUnacceptedInputClaim(turn);
        this.finish(turn);
        return turn.paired
          ? { disposition: "rejected", error: "Pi did not run the paired prompt" }
          : { disposition: "handled" };
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
        this.clearUnacceptedInputClaim(turn);
        this.finish(turn);
        return {
          disposition: "rejected",
          error: piAcpAuthGuidance(error.message, this.usesAcpModel()) ?? error.message,
          ...(retryable && { retryable: true }),
        };
      }
      if (
        turn.written &&
        !turn.settled &&
        !this.disposed &&
        this.processGeneration === turn.generation
      ) {
        const retiring = this.retireProcess();
        // A missing receipt leaves this process ambiguous, even if a native wake raced it.
        this.failProcessTurns(message(error));
        await retiring;
      } else this.finish(turn);
      throw error;
    } finally {
      if (this.openingTurn === turn) {
        this.openingTurn = undefined;
        if (this.activeTurn !== turn && !this.isRunning) this.emit("runState", this.runState);
      }
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
    if (outcome === "read") {
      if (steer?.claimed) {
        const { inputId, trigger = "user" } = steer.input.envelope;
        this.lifecycle?.({
          turnId: turn.id,
          stepId: inputId,
          kind: "user",
          marker: "stepEnd",
          at: Date.now(),
          trigger,
        });
      }
      turn.replyTextLength = 0;
      turn.messageBaseOffset = 0;
      for (const block of turn.blocks.values()) block.emittedTextLength = 0;
    }
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
  setPiConfig(
    config: Pick<SessionConfig, "piPackages" | "piExcludePackages" | "piOffline" | "piAcp">,
  ): void {
    this.config.piPackages = config.piPackages ? [...config.piPackages] : undefined;
    this.config.piExcludePackages = config.piExcludePackages
      ? [...config.piExcludePackages]
      : undefined;
    this.config.piOffline = config.piOffline;
    this.config.piAcp = config.piAcp ? { ...config.piAcp } : undefined;
  }
  private async applyOptions(rpc: PiRpcClient, generation: number): Promise<void> {
    if (this.pendingOptions) await this.pendingOptions;
    if (!this.current(generation, rpc)) return;
    const work = async () => {
      const timeout = { timeoutMs: this.readyTimeoutMs };
      const apply = async (
        setting: Setting,
        setter: (desired: string) => Promise<void>,
        target = setting.desired,
      ) => {
        const desired = setting.desired;
        if (!desired || !target || target === setting.applied || !this.current(generation, rpc))
          return;
        try {
          await setter(desired);
          if (!this.current(generation, rpc)) return;
          setting.applied = target;
          setting.lastError = undefined;
        } catch (error) {
          if (this.current(generation, rpc)) setting.lastError = message(error);
        }
      };
      const previousModel = this.model.applied;
      await apply(
        this.model,
        async (desired) => {
          const model = this.resolveModel(desired);
          const slash = desired.indexOf("/");
          if (!model && slash <= 0)
            throw new Error(`Ambiguous or unavailable Pi model: ${desired}`);
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
        },
        this.canonicalModel(this.model.desired),
      );
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
  private finish(
    turn: Turn,
    terminal?: StreamEvent,
    contextPending?: Promise<ContextUsage | null>,
    limit?: PiTurnLimit,
  ): void {
    if (this.activeTurn !== turn || turn.settled) return;
    turn.settled = true;
    this.finishSteer(turn, "outcome_unknown");
    if (turn.written && !turn.accepted && turn.inputId && terminal?.kind === "error") {
      this.emit("prompt_outcome_unknown", { inputId: turn.inputId, reason: terminal.content });
    }
    this.emit("runState", this.runState);
    if (terminal) {
      this.emit("event", terminal, contextPending, limit);
      if (terminal.kind === "error" && this.listenerCount("error"))
        this.emit("error", new Error(terminal.content));
      this.emit("done", terminal);
    }
  }

  private emitWakeup(): void {
    this.event({ kind: "notice", level: "wakeup", content: "Pi carried on" });
    this.emit("wakeup");
  }

  private clearUnacceptedInputClaim(turn: Turn): void {
    if (!turn.anchorInput || turn.started || this.persistedSessionAnchor) return;
    turn.anchorInput = undefined;
    if (!this.hasUnanchoredInput) return;
    this.hasUnanchoredInput = false;
    this.emit("session_checkpoint");
  }

  private readonly lifecycle: ReturnType<typeof lifecycleWriter>;

  private recordAssistantEnd(turn: Turn, msg: Json, at: number): void {
    const observation = this.sessionId
      ? this.lifecycle
        ? piAssistantUsage(this.sessionId, msg)
        : this.options.recordUsage && piUsage(this.sessionId, msg)
      : null;
    if (observation?.id) this.options.recordUsage?.({ ...observation, id: observation.id });
    if (!this.lifecycle) return;
    this.lifecycle({
      turnId: turn.id,
      stepId: turn.modelStep?.id ?? randomUUID(),
      kind: "model",
      marker: "stepEnd",
      at,
      model: text(msg.model),
      ...(observation && {
        inferenceId: observation.id,
        piMessageKey: observation.piMessageKey,
        promptTokens: observation.input + observation.cacheRead + observation.cacheWrite,
      }),
    });
    delete turn.modelStep;
    if (msg.stopReason === "toolUse") turn.modelTrigger = "continuation";
  }

  private handleEvent(event: Json): void {
    const at = this.lifecycle ? Date.now() : 0;
    if (event.type === "extension_ui_request") {
      const widget = decodePiSubagentWidget(event);
      if (widget) {
        if (widget.runs) this.observeWidget(widget.runs);
        return;
      }
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
      if (
        event.type === "compaction_start" &&
        reason === "manual" &&
        this.openingTurn?.compact &&
        this.openingTurn.written
      ) {
        this.activeTurn = this.openingTurn;
        this.openingTurn = undefined;
      }
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
        const compacted = Boolean(event.result) && !event.aborted && !error;
        let reconcile: ((proof: SessionCheckpoint) => void) | undefined;
        if (compacted && this.lifecycle) {
          const mark = {
            turnId: turn && this.live(turn) ? turn.id : randomUUID(),
            stepId: randomUUID(),
            kind: "compaction" as const,
            marker: "compaction" as const,
            at,
            ...(manual && { trigger: turn.trigger }),
          };
          this.lifecycle(mark);
          const beforeCount = Math.max(this.minEntryCount, this.sessionProof?.entryCount ?? 0);
          reconcile = (proof) => {
            const id = this.provenCompactionEntry(proof, beforeCount, result);
            if (id) this.lifecycle?.({ ...mark, marker: "nativeEntry", piCompactionEntryId: id });
          };
        }
        const window = this.model.applied
          ? this.resolveModel(this.model.applied)?.contextWindow
          : undefined;
        const context = compacted ? estimatedContext(after, window) : undefined;
        if (context !== undefined) {
          this.context = context;
          this.contextRevision++;
        }
        if (event.result) {
          this.stats = null;
          this.compactionBoundary = { reconcile };
          void this.syncCompactionCheckpoint(this.rpc!);
        }
        if (manual && error) this.finish(turn, { kind: "error", content: error });
        else {
          this.event({
            kind: "compact",
            content,
            ...(context !== undefined && { context }),
          });
          if (manual)
            this.finish(turn, {
              kind: "result",
              content: "",
              interrupted: event.aborted === true,
              ...(context !== undefined && { context }),
            });
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
      if (!this.activeTurn || this.activeTurn.settled || this.activeTurn === this.openingTurn) {
        const uncertainWrite = this.openingTurn?.written;
        this.activeTurn = newTurn(this.processGeneration);
        this.emit("runState", "working");
        // A transport cut may have lost preflight: don't label an unproven write as a wakeup.
        if (!uncertainWrite) this.emitWakeup();
      }
      this.activeTurn.started = true;
      return;
    }
    const turn = this.activeTurn;
    if (!turn || !this.live(turn) || (!turn.written && !turn.started)) return;
    switch (event.type) {
      case "message_start":
        if (msg.role === "assistant") {
          if (this.lifecycle) {
            // An unsolicited model may start while the prompt reply is still in flight.
            // The caller's trigger only belongs to a prompt Pi has actually read.
            const id = randomUUID();
            turn.modelStep = { id, firstDelta: false };
            this.lifecycle({
              turnId: turn.id,
              stepId: id,
              kind: "model",
              marker: "stepStart",
              at,
              model: text(msg.model),
              trigger: turn.steer?.observed
                ? (turn.steer.input.envelope.trigger ?? "user")
                : turn.started && !turn.accepted && turn.modelTrigger === turn.trigger
                  ? "auto"
                  : turn.modelTrigger,
            });
          }
          turn.messageBaseOffset = turn.replyTextLength;
          turn.blocks.clear();
          turn.finalText = "";
          turn.error = undefined;
          turn.limit = undefined;
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
        if (
          turn.modelStep &&
          !turn.modelStep.firstDelta &&
          (update.type === "text_delta" ||
            update.type === "thinking_delta" ||
            update.type === "toolcall_delta") &&
          typeof update.delta === "string" &&
          update.delta.length
        ) {
          turn.modelStep.firstDelta = true;
          this.lifecycle?.({
            turnId: turn.id,
            stepId: turn.modelStep.id,
            kind: "model",
            marker: "firstDelta",
            at,
          });
        }
        this.updateMessage(turn, update);
        break;
      }
      case "message_end": {
        if (msg.role === "user" && turn.written && turn.inputId && !turn.accepted) {
          this.lifecycle?.({
            turnId: turn.id,
            stepId: turn.inputId,
            kind: "user",
            marker: "stepEnd",
            at,
            trigger: turn.trigger,
          });
          if (turn.anchorInput) {
            // Skills, input hooks and image normalization finalize the text before
            // Pi emits message_end and only then appends it to the JSONL file.
            turn.anchorInput.text = sessionMessageText({ message: msg }) ?? turn.anchorInput.text;
            if (this.rpc) this.schedulePersistedAnchor(turn, this.rpc, true);
          }
          if (!turn.paired) this.acceptUserMessage(turn);
        } else if (
          turn.paired &&
          turn.written &&
          turn.inputId &&
          !turn.accepted &&
          msg.role === "custom" &&
          msg.customType === PI_PANEL_CONTEXT_TYPE &&
          object(msg.details).reportId === turn.reportId
        ) {
          this.acceptUserMessage(turn);
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
          this.recordAssistantEnd(turn, msg, at);
          const blocks = list(msg.content);
          turn.finalText = blocks
            .filter((block) => block.type === "text")
            .map((block) => text(block.text) ?? "")
            .join("");
          const replyUsage = object(msg.usage);
          // The context hook can supersede only provably empty failed assistant
          // records. Never schedule a replacement the hook could not remove.
          if (
            turn.recovery &&
            (msg.stopReason !== "error" ||
              replyUsage.output !== 0 ||
              !Array.isArray(msg.content) ||
              msg.content.length !== 0)
          )
            turn.recoveryNotEmpty = true;
          if (msg.usage) turn.replyUsage = replyUsage;
          turn.error =
            msg.stopReason === "error"
              ? (text(msg.errorMessage) ?? "Pi assistant failed")
              : undefined;
          const acp = msg.provider === ACP;
          const model = turn.acpAttempt?.model;
          const acpError =
            model &&
            turn.error &&
            (turn.error.startsWith(`Antigravity quota exceeded for ${model}.`) ||
              turn.error.startsWith(
                "Antigravity quota exceeded: the model path refused requests with HTTP 429 RESOURCE_EXHAUSTED (rate limit or entitlement);",
              ));
          const reportedAt =
            acpError &&
            turn.error?.startsWith(`Antigravity quota exceeded for ${model}. Resets at `)
              ? Date.parse(
                  turn.error.slice(
                    `Antigravity quota exceeded for ${model}. Resets at `.length,
                    -1,
                  ),
                ) / 1000
              : undefined;
          const reset = futureReset(
            acp ? acpError && (turn.acpAttempt?.reset ?? reportedAt) : msg.yaatLimitReset,
          );
          turn.limit =
            reset && turn.error
              ? { resetsAt: reset, refusalText: refusalText(turn.finalText, turn.error, acp) }
              : undefined;
          turn.acpAttempt = undefined;
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
        this.recordToolBoundary(turn, event, "toolStart", at);
        this.startTool(turn, event);
        break;
      case "tool_execution_update":
        this.updateTool(turn, event);
        break;
      case "tool_execution_end":
        this.recordToolBoundary(turn, event, "toolResult", at);
        this.endTool(turn, event);
        break;
      case "agent_settled":
        this.settle(turn, event.aborted === true);
        break;
      case "auto_retry_start": {
        turn.limit = undefined;
        turn.acpAttempt = undefined;
        turn.modelTrigger = "retry";
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
        if (event.success === false) {
          if (turn.error !== (text(event.finalError) ?? turn.error)) turn.limit = undefined;
          turn.error = text(event.finalError) ?? turn.error;
        } else turn.limit = undefined;
        this.event({ kind: "retry", content: "" });
        break;
    }
  }

  private recordToolBoundary(
    turn: Turn,
    event: Json,
    marker: "toolStart" | "toolResult",
    at: number,
  ): void {
    const toolCallId = text(event.toolCallId);
    if (toolCallId)
      this.lifecycle?.({
        turnId: turn.id,
        stepId: toolCallId,
        toolCallId,
        kind: "tool",
        marker,
        at,
      });
  }

  private updateMessage(turn: Turn, update: Json): void {
    const index = num(update.contentIndex);
    if (index === undefined) return;
    const now = Date.now();
    for (const [otherIndex, other] of turn.blocks) {
      if (otherIndex !== index && other.kind === "thinking" && !other.ended)
        other.thinkingEndedAt ??= now;
    }
    const block = turn.blocks.get(index) ?? { content: "", startedAt: now, emittedTextLength: 0 };
    turn.blocks.set(index, block);
    const kind = String(update.type).split("_", 1)[0];
    if (kind === "text" || kind === "thinking" || kind === "toolcall") block.kind ??= kind;
    switch (update.type) {
      case "thinking_start":
        this.event({ kind: "thinking_delta", content: "", startedAt: block.startedAt });
        break;
      case "text_delta":
      case "thinking_delta": {
        const delta = text(update.delta) ?? "";
        block.content += delta;
        if (update.type === "text_delta") {
          block.emittedTextLength += delta.length;
          turn.replyTextLength += delta.length;
        }
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
          if (block.content.startsWith(streamed) && streamed.length < block.content.length) {
            const delta = block.content.slice(streamed.length);
            block.emittedTextLength += delta.length;
            turn.replyTextLength += delta.length;
            this.event({ kind: "text_delta", content: delta });
          }
          this.event({ kind: "text", content: block.content });
        } else {
          const durationMs = Math.max(0, (block.thinkingEndedAt ?? now) - block.startedAt);
          const contentOffset =
            turn.messageBaseOffset +
            [...turn.blocks].reduce(
              (offset, [otherIndex, other]) =>
                otherIndex < index && other.kind === "text"
                  ? offset + other.emittedTextLength
                  : offset,
              0,
            );
          this.event({ kind: "thinking_delta", content: "", durationMs, thinkingFollows: true });
          this.event({ kind: "thinking", content: block.content, durationMs, contentOffset });
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

  private acceptUserMessage(turn: Turn): void {
    turn.accepted = true;
    this.emit("user_message_accepted", {
      inputId: turn.inputId,
      reportId: turn.reportId,
      generation: turn.generation,
    });
  }

  private settle(turn: Turn, aborted: boolean): void {
    this.hasConfirmedTurns = true;
    if (turn.anchorInput && this.rpc) this.schedulePersistedAnchor(turn, this.rpc, true);
    if (turn.paired && !turn.accepted && turn.inputId) {
      this.emit("prompt_outcome_unknown", {
        inputId: turn.inputId,
        reason: "Pi did not confirm the paired panel context",
      });
    }
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
    this.context = null;
    const revision = ++this.contextRevision;
    const contextPending = rpc
      .getSessionStats({ timeoutMs: this.statsTimeoutMs })
      .then((stats) => {
        if (!this.current(turn.generation, rpc)) return null;
        const reported = object(stats.contextUsage);
        const context = estimatedContext(
          reported.tokens,
          reported.contextWindow ?? reported.window,
        );
        if (this.contextRevision === revision) this.context = context;
        if (this.activeTurn?.id === turn.id && this.contextRevision === revision) {
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
        }
        return context;
      })
      .catch(() => null);
    const authGuidance = turn.error && piAcpAuthGuidance(turn.error, this.usesAcpModel());
    this.finish(
      turn,
      turn.error && !this.interrupting
        ? {
            ...(authGuidance
              ? { kind: "error" as const, content: authGuidance }
              : turn.recovery && (turn.recoveryNotEmpty || !turn.accepted || reply.output !== 0)
                ? { kind: "error" as const, content: turn.error }
                : piTerminalError(turn.error)),
            context: null,
          }
        : {
            kind: "result",
            content: turn.finalText,
            effort: this.effort.applied,
            interrupted: Boolean(this.interrupting),
            context: null,
          },
      contextPending,
      turn.error &&
        !aborted &&
        !this.interrupting &&
        (!turn.inputId || turn.accepted) &&
        !turn.recovery &&
        futureReset(turn.limit?.resetsAt)
        ? turn.limit
        : undefined,
    );
  }

  private schedulePersistedAnchor(turn: Turn, rpc: PiRpcClient, renew = false): void {
    const input = turn.anchorInput;
    const generation = turn.generation;
    if (!input || this.persistedSessionAnchor) return;
    const timeoutMs = this.options.anchorTimeoutMs ?? 2_000;
    const active = this.anchorProbe;
    if (active?.generation === generation) {
      // Finalization gets one fresh bounded window even when the raw-input
      // probe is still active; both read the same mutable finalized claim.
      if (renew) active.deadline = Date.now() + timeoutMs;
      return;
    }
    const probe: AnchorProbe = { generation, deadline: Date.now() + timeoutMs };
    const pending = this.provePersistedAnchor(input, rpc, probe).finally(() => {
      if (this.anchorProbe?.pending === pending) this.anchorProbe = undefined;
    });
    probe.pending = pending;
    this.anchorProbe = probe;
    void pending;
  }

  private async provePersistedAnchor(
    input: FirstInputClaim,
    rpc: PiRpcClient,
    probe: AnchorProbe,
  ): Promise<void> {
    const generation = probe.generation;
    const pollInterval = Math.max(1, this.options.anchorPollIntervalMs ?? 10);
    let anchorToSave: PersistedSessionAnchor | undefined;
    while (this.current(generation, rpc) && Date.now() <= probe.deadline) {
      if (anchorToSave) {
        try {
          // This is deliberately not user_message_accepted or agent_settled: only
          // the on-disk anchor changed, and the claimed input must not be replayed.
          this.emit("session_anchor", { ...anchorToSave });
          return;
        } catch {
          // Snapshot persistence is a separate, idempotent commit. Retry it
          // without weakening or repeating the already-observed disk proof.
        }
      } else {
        try {
          if (!input.sessionFile || !input.sessionId) return;
          const parsed = readSessionFile(input.sessionFile);
          if (parsed.corruptLine) throw new Error("incomplete session proof");
          validateSessionHeader(parsed, input.sessionId, this.normalizedCwd);
          const beforeIndex = input.beforeLeafId
            ? parsed.branch.findIndex((entry) => entry.id === input.beforeLeafId)
            : -1;
          const beforeMatches =
            input.beforeEntryCount === 0
              ? input.beforeLeafId === null
              : input.beforeLeafId !== null &&
                parsed.entries[input.beforeEntryCount - 1]?.id === input.beforeLeafId &&
                beforeIndex >= 0;
          const persistedInput = beforeMatches
            ? parsed.branch
                .slice(beforeIndex + 1)
                .find(
                  (entry) =>
                    entry.type === "message" &&
                    object(entry.message).role === "user" &&
                    sessionMessageText(entry) === input.text,
                )
            : undefined;
          if (persistedInput && parsed.leafId && parsed.entries.length > input.beforeEntryCount) {
            const sessionFile = realpath(input.sessionFile);
            const anchor: PersistedSessionAnchor = {
              sessionFile,
              sessionId: input.sessionId,
              leafId: parsed.leafId,
              entryCount: parsed.entries.length,
            };
            if (
              !this.current(generation, rpc) ||
              this.sessionId !== anchor.sessionId ||
              this.persistedSessionAnchor
            )
              return;
            this.persistedSessionAnchor = anchor;
            this.hasUnanchoredInput = false;
            this.sessionFile = sessionFile;
            if (anchor.entryCount >= this.minEntryCount) {
              this.expectedLeafAnchorId = anchor.leafId;
              this.minEntryCount = anchor.entryCount;
              if (this.sessionProof)
                this.sessionProof = {
                  ...this.sessionProof,
                  sessionFile,
                  leafId: anchor.leafId,
                  entryCount: anchor.entryCount,
                };
            }
            anchorToSave = anchor;
            continue;
          }
        } catch {
          // A missing file, an incomplete append, or a transient read is not proof.
        }
      }
      await delay(Math.min(pollInterval, Math.max(1, probe.deadline - Date.now())));
    }
  }

  private provenCompactionEntry(proof: SessionCheckpoint, beforeCount: number, result: Json) {
    if (!proof.sessionFile || !proof.leafId || proof.entryCount <= beforeCount) return;
    if (
      typeof result.firstKeptEntryId !== "string" ||
      typeof result.tokensBefore !== "number" ||
      typeof result.summary !== "string"
    )
      return;
    const native = proof.compaction;
    if (
      native &&
      native.index >= beforeCount &&
      native.index < proof.entryCount &&
      native.firstKeptEntryId === result.firstKeptEntryId &&
      native.tokensBefore === result.tokensBefore &&
      native.summaryKey === createHash("sha256").update(result.summary).digest("hex")
    )
      return text(native.id);
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
          if (boundary && this.compactionBoundary === boundary) {
            this.compactionBoundary = undefined;
            try {
              boundary.reconcile?.(proof);
            } catch {
              // The checkpoint can be valid even when the append cannot be read here.
            }
          }
          this.updateCheckpoint(proof.leafId, proof.entryCount, proof.sessionFile);
        }
      })
      .catch(() => undefined);
  }

  private updateCheckpoint(leafId: string | null, count: number, file: string | null): void {
    if (count < this.minEntryCount) return;
    this.expectedLeafAnchorId = leafId;
    this.minEntryCount = count;
    if (file) {
      let checkpointFile = file;
      if (this.persistedSessionAnchor) {
        try {
          if (realpath(file) === this.persistedSessionAnchor.sessionFile)
            checkpointFile = this.persistedSessionAnchor.sessionFile;
        } catch {
          // A later strict restore will report an unreadable checkpoint path.
        }
      }
      this.sessionFile = checkpointFile;
    }
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
      this.hasUnanchoredInput = false;
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
    this.earlyWidgetRoots.length = 0;
    this.latestWidgetIds.clear();
    this.pushCoverage.clear();
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
    turn.subagents.set(id, { mode, asyncLaunch, children });
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

  private updateTool(turn: Turn, event: Json): void {
    const id = text(event.toolCallId);
    if (!id) return;
    const call = turn.subagents.get(id);
    if (!call) return;
    const detail = object(object(event.partialResult).details);
    let tracker = this.foregroundTrackers.get(id);
    if (!tracker) {
      tracker = { toolCallId: id, rowBindings: new Map(), childWatches: new Map() };
      this.foregroundTrackers.set(id, tracker);
    }

    const workflowRows = list(object(detail.workflowChildren).children);
    if (workflowRows.length) {
      const boundChildren = new Set<ActiveAsyncChildRecord>(tracker.rowBindings.values());
      for (let rowIndex = 0; rowIndex < workflowRows.length; rowIndex++) {
        const row = workflowRows[rowIndex];
        const rowKey =
          text(row.childId) ?? text(row.workflowKey) ?? text(row.runId) ?? `row:${rowIndex}`;
        let child = tracker.rowBindings.get(rowKey);
        if (!child) {
          const wantedCanonical = text(row.childId ?? row.workflowKey);
          if (wantedCanonical) {
            child = call.children.find(
              (c) => !boundChildren.has(c) && c.canonicalChildId === wantedCanonical,
            );
          }
          if (!child) {
            const idx = resolveWorkflowStepIndex(row, call.children.length);
            if (idx !== undefined && !boundChildren.has(call.children[idx])) {
              child = call.children[idx];
            }
          }
          if (!child) {
            child = call.children.find((c) => !boundChildren.has(c) && !terminalStatus(c.status));
          }
          if (!child && call.mode === "workflow") {
            const index = call.children.length;
            const taskId = makeSyntheticSubagentTaskId(id, index);
            const canonicalChildId = resolveCanonicalChildId(row, index);
            const initialStatus = terminalStatus(row.state ?? row.status) ?? "running";
            child = {
              taskId,
              stepIndex: index,
              canonicalChildId,
              status: initialStatus,
            };
            call.children.push(child);
            this.event({
              kind: "subagent_start",
              content: "",
              subagent: {
                taskId,
                description: text(row.agent) ?? canonicalChildId,
                status: "running",
                cancellable: call.asyncLaunch,
              },
            });
          }
          if (!child) continue;
          if (wantedCanonical) child.canonicalChildId = wantedCanonical;
          tracker.rowBindings.set(rowKey, child);
          boundChildren.add(child);
        }

        const observed = observedStatusExecution(row);
        const lastTool = text(object(row.activity).currentTool) ?? text(row.currentTool);
        this.emitSubagentMetaProgress(child.taskId, call.asyncLaunch, observed, lastTool);

        if (!terminalStatus(child.status) && !tracker.childWatches.has(child.taskId)) {
          const childRunId = text(row.runId);
          const root = this.asyncRunsRoot();
          const eventsPath =
            childRunId && isSafeChildRunId(childRunId) && root
              ? path.join(root, childRunId, "events.jsonl")
              : undefined;
          const sessionFile = text(row.sessionFile ?? row.sessionPath);
          if (eventsPath && (fs.existsSync(eventsPath) || !sessionFile)) {
            this.attachForegroundWatch(
              tracker,
              child.taskId,
              eventsPath,
              "async_events",
              call.asyncLaunch,
            );
          } else if (sessionFile) {
            this.attachForegroundWatch(
              tracker,
              child.taskId,
              sessionFile,
              "session_v3",
              call.asyncLaunch,
            );
          } else if (eventsPath) {
            this.attachForegroundWatch(
              tracker,
              child.taskId,
              eventsPath,
              "async_events",
              call.asyncLaunch,
            );
          }
        }
      }
      this.pollForegroundTracker(tracker);
      return;
    }

    const results = list(detail.results);
    const progress = list(detail.progress);
    const pickIndexed = (items: Json[], stepIndex: number): Json | undefined => {
      if (items.some((item) => typeof item.index === "number")) {
        const indices = items.map((item) => item.index);
        if (
          indices.every((index) => typeof index === "number") &&
          new Set(indices).size === indices.length
        ) {
          return items.find((item) => item.index === stepIndex);
        }
      }
      return items[stepIndex];
    };
    for (const child of call.children) {
      const p = pickIndexed(progress, child.stepIndex);
      const r = pickIndexed(results, child.stepIndex);
      const observed = {
        ...observedStatusExecution(p),
        ...observedStatusExecution(r),
      };
      const lastTool = text(r?.currentTool ?? p?.currentTool);
      this.emitSubagentMetaProgress(child.taskId, call.asyncLaunch, observed, lastTool);

      if (!terminalStatus(child.status) && !tracker.childWatches.has(child.taskId)) {
        const transcriptPath = text(r?.transcriptPath ?? p?.transcriptPath);
        const childRunId = text(r?.runId ?? p?.runId ?? r?.asyncId ?? p?.asyncId);
        const root = this.asyncRunsRoot();
        const eventsPath =
          childRunId && isSafeChildRunId(childRunId) && root
            ? path.join(root, childRunId, "events.jsonl")
            : undefined;
        const sessionFile = text(
          r?.sessionFile ?? r?.sessionPath ?? p?.sessionFile ?? p?.sessionPath,
        );
        if (transcriptPath) {
          this.attachForegroundWatch(
            tracker,
            child.taskId,
            transcriptPath,
            "transcript",
            call.asyncLaunch,
          );
        } else if (eventsPath) {
          this.attachForegroundWatch(
            tracker,
            child.taskId,
            eventsPath,
            "async_events",
            call.asyncLaunch,
          );
        } else if (sessionFile) {
          this.attachForegroundWatch(
            tracker,
            child.taskId,
            sessionFile,
            "session_v3",
            call.asyncLaunch,
          );
        }
      }
    }
    this.pollForegroundTracker(tracker);
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
    this.stopForegroundTracker(id);
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
        if (execution.model) {
          child.execution = execution;
          const entry = this.getOrCreateProjectionState(child.taskId);
          entry.state.execution = { ...execution };
          entry.emittedExecution = { ...execution };
        }
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
      this.startAsyncRunTracker(run);
      for (const root of this.earlyWidgetRoots.filter((node) => node.id === runId)) {
        if (this.activeAsyncRuns.includes(run)) this.applyWidgetRoot(run, root);
      }
      if (!this.latestWidgetIds.has(runId)) this.pushCoverage.delete(runId);
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
    execution = projectSubagentExecution(result),
    enrichment = false,
    binding?: ActiveAsyncChildRecord,
  ): void {
    const projectionEntry = this.subagentProjectionStates.get(taskId);
    const trackedExecution = projectionEntry?.emittedExecution ?? projectionEntry?.state.execution;
    const hadLiveEvents = projectionEntry?.hasLiveEvents ?? false;
    this.subagentProjectionStates.delete(taskId);
    const summary = text(result?.summary ?? result?.output ?? result?.preview);
    const hasChildRef = Boolean(
      text(result?.sessionFile ?? result?.sessionPath) || text(result?.transcriptPath),
    );
    const child =
      result && (hasChildRef || (!enrichment && !hadLiveEvents))
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
    // If live events were streamed (e.g. from events.jsonl) and no authoritative
    // session/transcript file exists (or turn aborted), omit events/eventCount so
    // Workspace and client preserve the live transcript instead of wiping it.
    const preserveLive = !hasChildRef && hadLiveEvents;
    const usefulTranscript = child?.events.some((e) => e.kind !== "notice");
    const events =
      (hadLiveEvents || enrichment) && !usefulTranscript
        ? undefined
        : (child?.events ?? (preserveLive ? undefined : []));
    let observed: ReturnType<typeof assistantExecution> = {};
    for (const message of list(result?.messages)) {
      if (message.role === "assistant") observed = { ...observed, ...assistantExecution(message) };
    }
    const model = child?.model ?? observed.model ?? execution.model ?? trackedExecution?.model;
    const effort = child?.effort ?? observed.effort ?? execution.effort ?? trackedExecution?.effort;
    const durationMs = executionDuration(result);
    if (enrichment && !summary && !events && durationMs == null && !model && !effort) return;
    if (binding) {
      // Notify may deliver both message_start and message_end. Keep only a compact signature
      // in the checkpoint, not a second copy of the potentially large child transcript.
      const signature = createHash("sha256")
        .update(JSON.stringify([summary, events, durationMs, model, effort]))
        .digest("hex");
      if (enrichment && binding.detailSignature === signature) return;
      binding.detailSignature = signature;
    }
    this.event({
      kind: enrichment ? "subagent_enrichment" : "subagent_done",
      content: "",
      subagent: {
        taskId,
        description: "",
        ...(!enrichment && { status }),
        ...(summary && { summary }),
        ...(events !== undefined ? { events, eventCount: events.length } : {}),
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
    for (const [id, call] of turn.subagents) {
      this.stopForegroundTracker(id);
      for (const child of call.children) this.childDone(child.taskId, "stopped");
    }
    turn.tools.clear();
    turn.subagents.clear();
  }
  private observeWidget(roots: PiSubagentWidgetNode[]): void {
    // Absence or retraction only releases push coverage to the fallback. Neither settles work.
    this.latestWidgetIds = new Set(roots.map((node) => node.id));
    this.pushCoverage.clear();
    for (const root of roots) {
      if (roots.some((other) => other !== root && other.id === root.id)) continue;
      const run = this.activeAsyncRuns.find((item) => item.runId === root.id);
      if (run) this.applyWidgetRoot(run, root);
      else if (!this.settledAsyncRuns.some((item) => item.runId === root.id)) {
        this.earlyWidgetRoots.push(root);
        if (this.earlyWidgetRoots.length > 64) this.earlyWidgetRoots.shift();
      }
    }
  }

  private applyWidgetRoot(run: ActiveAsyncRunRecord, root: PiSubagentWidgetNode): void {
    let pairs = bindPiSubagentWidgetChildren(root, run);
    const steps = root.children?.filter((node) => node.kind === "step") ?? [];
    if (steps.length > pairs.length) {
      // Materialized workflow keys and runner IDs are not necessarily the same. Load the
      // canonical roster to resolve aliases before claiming pre-existing card positions.
      const tracker = this.asyncTrackers.get(run.runId);
      if (tracker) this.discoverWorkflowChildrenFromDisk(tracker);
      pairs = bindPiSubagentWidgetChildren(root, run);
      if (run.mode === "workflow") {
        // A workflow launch can have only a generic placeholder, not a roster. Allocate by
        // the published key, never by snapshot position (which changes with omissions).
        for (const node of steps) {
          if (
            pairs.some((p) => p.node === node) ||
            steps.filter((s) => s.id === node.id).length !== 1 ||
            run.children.some((c) => c.canonicalChildId === node.id || c.childRunId === node.id)
          )
            continue;
          const placeholder =
            run.children.length === 1 &&
            run.children[0].canonicalChildId === "step:0" &&
            !run.children[0].childRunId
              ? run.children[0]
              : undefined;
          const child: ActiveAsyncChildRecord = placeholder ?? {
            taskId: `${run.toolCallId}:key:${node.id}`,
            canonicalChildId: node.id,
            stepIndex: -1,
          };
          child.canonicalChildId = node.id;
          child.stepIndex = -1; // Unknown until the canonical roster identifies the keyed lane.
          if (!placeholder) {
            run.children.push(child);
            this.event({
              kind: "subagent_start",
              toolUseId: run.toolCallId,
              content: "",
              subagent: {
                taskId: child.taskId,
                description: node.agent ?? node.label,
                status: node.state === "queued" ? "queued" : "running",
                cancellable: true,
              },
            });
          }
          pairs.push({ node, child });
        }
      }
    }
    if (run.mode === "single" && run.children.length === 1 && !steps.length)
      pairs = [{ child: run.children[0], node: root }];
    const covered = new Set<string>();
    this.pushCoverage.set(run.runId, covered);
    const terminalChildren: SubagentNotifyRun["children"] = [];
    let changed = false;
    for (const { node, child } of pairs) {
      covered.add(child.taskId);
      const nested = [
        ...(node.children ?? []),
        ...(node !== root && child === run.children[0]
          ? (root.children ?? []).filter((n) => n.kind !== "step")
          : []),
      ];
      if (nested.length) {
        const tree = projectPiSubagentTree(child.taskId, nested, child.tree);
        child.tree = tree.state;
        for (const e of tree.events) this.emitSubagentInnerEvent(child.taskId, e);
        if (tree.events.length) {
          child.hasLiveEvents = true;
          this.getOrCreateProjectionState(child.taskId).hasLiveEvents = true;
        }
      }
      if (terminalStatus(child.status)) continue;
      child.startedAt = node.startedAt ?? child.startedAt;
      child.endedAt = node.endedAt ?? child.endedAt;
      if (terminalStatus(node.state)) {
        if (
          node.model &&
          node.state !== "rejected" &&
          (node.state === "completed" || node.activity?.turnCount)
        )
          child.execution ??= { model: node.model, effort: node.thinking };
        terminalChildren.push({
          canonicalChildId: child.canonicalChildId,
          stepIndex: child.stepIndex,
          status: node.state,
        });
      } else if (node.state === "queued" || node.state === "running") {
        const execution =
          node.state === "running"
            ? {
                model: child.execution?.model ?? node.model,
                effort: child.execution?.effort ?? node.thinking,
              }
            : {};
        const statusChanged = child.status !== node.state;
        child.status = node.state;
        if (
          this.emitSubagentMetaProgress(
            child.taskId,
            true,
            execution,
            node.activity?.currentTool,
            child,
            statusChanged,
          )
        )
          changed = true;
      }
    }
    if (terminalChildren.length || terminalStatus(root.state)) {
      this.completeAsyncRun(
        { runId: run.runId, status: root.state, children: terminalChildren },
        true,
        true,
      );
    }
    if (changed) this.backgroundChanged();
  }

  private completeAsyncRun(update: SubagentNotifyRun, fromDisk = false, pushed = false): void {
    const active = this.activeAsyncRuns.find((item) => item.runId === update.runId);
    const run = active ?? this.settledAsyncRuns.find((item) => item.runId === update.runId);
    if (!run) return;
    const diskStatus = this.runStatus(run);
    const diskSteps = this.syncRunChildrenFromDisk(run, diskStatus);
    const terminal = terminalStatus(update.status);
    let changed = false;
    for (const child of run.children) {
      const alreadySettled = terminalStatus(child.status);
      if (alreadySettled && fromDisk) continue;
      const wireResult =
        update.children.find(
          (item) =>
            item.canonicalChildId === child.canonicalChildId ||
            (child.childRunId && item.runId === child.childRunId),
        ) ??
        (child.stepIndex >= 0 && !pushed
          ? update.children.find((item) => item.stepIndex === child.stepIndex)
          : undefined);
      const diskStep =
        diskSteps.find(
          (step, index) => resolveCanonicalChildId(step, index) === child.canonicalChildId,
        ) ?? diskSteps[child.stepIndex];
      const childRunId = text(diskStep?.runId ?? wireResult?.runId ?? child.childRunId);
      const childStep = list(this.childRunStatus(run, childRunId)?.steps)[0];
      if (pushed && !wireResult && !terminal) continue;
      const status =
        alreadySettled ??
        terminalStatus(wireResult?.status) ??
        terminalStatus(diskStep?.status) ??
        terminalStatus(childStep?.status) ??
        (pushed && run.mode !== "single" && !wireResult ? undefined : terminal);
      const wireStep = object(wireResult);
      const observed = {
        ...child.execution,
        ...observedStatusExecution(diskStep),
        ...observedStatusExecution(wireStep),
        ...observedStatusExecution(childStep),
      };
      if (!status) {
        if (
          observed.model &&
          this.emitSubagentMetaProgress(child.taskId, true, observed, undefined, child)
        ) {
          changed = true;
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
      const tempRoot = this.asyncRunsRoot() ?? path.dirname(run.asyncDir);
      const sessionRoot =
        this.config.piSessionDir ?? (this.sessionFile ? path.dirname(this.sessionFile) : undefined);
      const archiveFor = (runId: string, stepIndex: number) =>
        readPiSubagentFinalOutput({
          resultsDir: path.join(path.dirname(tempRoot), "async-subagent-results"),
          runId,
          stepIndex,
          ownsSession: this.ownsSession,
          artifactRoots: [
            path.join(path.dirname(tempRoot), "artifacts"),
            ...(sessionRoot ? [path.join(sessionRoot, "subagent-artifacts")] : []),
          ],
          sessionRoots: sessionRoot ? [sessionRoot] : [],
        });
      const archived =
        archiveFor(run.runId, child.stepIndex) ??
        (childRunId && childRunId !== run.runId ? archiveFor(childRunId, 0) : undefined);
      const summary =
        archived?.text ??
        text(
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
        archived?.truncated === true ||
        wireResult?.outputTruncated === true ||
        diskStep?.outputTruncated === true ||
        childStep?.outputTruncated === true;
      const merged: Json | undefined =
        wireResult || diskStep || childStep || archived || child.endedAt !== undefined
          ? {
              ...(sessionFile ? { sessionFile } : {}),
              ...(transcriptPath ? { transcriptPath } : {}),
              ...(summary ? { summary } : {}),
              durationMs: executionDuration(
                childStep,
                diskStep,
                wireStep,
                { startedAt: child.startedAt, endedAt: child.endedAt },
                run.mode === "single" ? diskStatus : undefined,
              ),
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
      // Drain complete records before terminal state makes tail handlers ignore them.
      const tracker = this.asyncTrackers.get(run.runId);
      if (!alreadySettled && tracker) {
        this.pollLiveWatch(tracker.parentWatch, run);
        for (const watch of tracker.childWatches.values())
          if (watch.targetTaskId === child.taskId) this.pollLiveWatch(watch, run);
      }
      child.status = status;
      this.closeAsyncChildWatchesForTask(run.runId, child.taskId);
      changed ||= !alreadySettled;
      this.childDone(
        child.taskId,
        status,
        merged,
        {
          ...projectSubagentExecution(...completedSteps),
          ...observed,
        },
        Boolean(alreadySettled),
        child,
      );
    }
    const childrenSettled = run.children.every((child) => terminalStatus(child.status));
    if (active && childrenSettled && (terminal || (!pushed && !this.pushCoverage.has(run.runId)))) {
      this.pushCoverage.delete(run.runId);
      if (fromDisk && this.rpc) this.pendingDeployNotices.add(run.runId);
      this.stopAsyncRunTracker(run.runId);
      this.activeAsyncRuns = this.activeAsyncRuns.filter((item) => item !== run);
      this.settledAsyncRuns = [...this.settledAsyncRuns.slice(-127), run];
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
      const step =
        diskSteps.find(
          (row, index) => resolveCanonicalChildId(row, index) === child.canonicalChildId,
        ) ??
        (child.canonicalChildId === `step:${child.stepIndex}`
          ? diskSteps[child.stepIndex]
          : undefined);
      if (!step) continue;
      const resolved = resolveCanonicalChildId(step, child.stepIndex);
      if (resolved !== `step:${child.stepIndex}`) child.canonicalChildId = resolved;
      child.stepIndex = diskSteps.indexOf(step);
      if (typeof step.runId === "string" && isSafeChildRunId(step.runId))
        child.childRunId = step.runId;
    }
    return diskSteps;
  }

  private asyncRunsRoot(): string | undefined {
    const tempRoot =
      this.home?.env.PI_SUBAGENTS_TEMP_ROOT ??
      this.options.env?.PI_SUBAGENTS_TEMP_ROOT ??
      process.env.PI_SUBAGENTS_TEMP_ROOT;
    if (tempRoot) return path.join(tempRoot, "async-subagent-runs");
    if (this.activeAsyncRuns.length) return path.dirname(this.activeAsyncRuns[0].asyncDir);
    return undefined;
  }

  private getOrCreateProjectionState(taskId: string) {
    let entry = this.subagentProjectionStates.get(taskId);
    if (!entry) {
      entry = { state: createSubagentProjectionState() };
      this.subagentProjectionStates.set(taskId, entry);
    }
    return entry;
  }

  private emitSubagentInnerEvent(taskId: string, innerEvent: StreamEvent): void {
    if (this.disposed) return;
    this.event({
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId,
        description: "",
        status: "running",
        _innerEvent: innerEvent,
      },
    });
  }

  private emitSubagentMetaProgress(
    taskId: string,
    cancellable: boolean,
    execution: { model?: string; effort?: string },
    lastTool?: string,
    asyncChild?: ActiveAsyncChildRecord,
    statusChanged = false,
  ): boolean {
    if (this.disposed) return false;
    const entry = this.getOrCreateProjectionState(taskId);
    const prevExecution = entry.emittedExecution;
    const nextModel =
      execution.model ??
      prevExecution?.model ??
      entry.state.execution.model ??
      asyncChild?.execution?.model;
    const nextEffort =
      execution.effort ??
      prevExecution?.effort ??
      entry.state.execution.effort ??
      asyncChild?.execution?.effort;
    const nextLastTool = lastTool ?? entry.lastTool;
    const changed =
      statusChanged ||
      nextModel !== prevExecution?.model ||
      nextEffort !== prevExecution?.effort ||
      nextLastTool !== entry.lastTool;
    if (!changed) {
      if (asyncChild && nextModel && !asyncChild.execution) {
        asyncChild.execution = {
          ...(nextModel ? { model: nextModel } : {}),
          ...(nextEffort ? { effort: nextEffort } : {}),
        };
      }
      return false;
    }
    const nextExecution = {
      ...(nextModel ? { model: nextModel } : {}),
      ...(nextEffort ? { effort: nextEffort } : {}),
    };
    entry.emittedExecution = nextExecution;
    entry.state.execution = { ...nextExecution };
    if (asyncChild && nextModel) {
      asyncChild.execution = { ...nextExecution };
    }
    entry.lastTool = nextLastTool;
    this.event({
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId,
        description: "",
        status: asyncChild?.status === "queued" ? "queued" : "running",
        cancellable,
        ...(nextModel ? { model: nextModel } : {}),
        ...(nextEffort ? { effort: nextEffort } : {}),
        ...(nextLastTool ? { lastTool: nextLastTool } : {}),
      },
    });
    return true;
  }

  private projectRecordToChild(
    taskId: string,
    cancellable: boolean,
    record: Json,
    format: ChildSourceFormat,
    asyncChild?: ActiveAsyncChildRecord,
  ): void {
    const entry = this.getOrCreateProjectionState(taskId);
    const batch =
      format === "async_events"
        ? projectAsyncEventRecord(record, entry.state, this.bridgeOwnedToolNames)
        : format === "transcript"
          ? projectTranscriptArtifactRecord(record, entry.state, this.bridgeOwnedToolNames)
          : projectSessionV3Record(record, entry.state, this.bridgeOwnedToolNames);
    if (batch.executionChanged) {
      this.emitSubagentMetaProgress(
        taskId,
        cancellable,
        entry.state.execution,
        entry.lastTool,
        asyncChild,
      );
    }
    if (batch.events.length > 0) {
      entry.hasLiveEvents = true;
      if (asyncChild) asyncChild.hasLiveEvents = true;
    }
    for (const innerEvent of batch.events) {
      if (innerEvent.kind === "tool_use" && innerEvent.toolName) {
        this.emitSubagentMetaProgress(
          taskId,
          cancellable,
          entry.state.execution,
          innerEvent.toolName,
          asyncChild,
        );
      }
      this.emitSubagentInnerEvent(taskId, innerEvent);
    }
  }

  private createLiveWatch(
    filePath: string,
    format: ChildSourceFormat,
    onRecords: (records: Json[]) => void,
    options?: {
      initialOffset?: number;
      run?: ActiveAsyncRunRecord;
      cursorKey?: string;
      targetTaskId?: string;
    },
  ): LiveTailWatch {
    const watch: LiveTailWatch = {
      cursor: createIncrementalJsonlCursor(filePath, options?.initialOffset ?? 0),
      format,
      run: options?.run,
      cursorKey: options?.cursorKey,
      targetTaskId: options?.targetTaskId,
      active: true,
      scheduled: false,
      onRecords,
    };
    this.refreshLiveWatchFs(watch);
    return watch;
  }

  private refreshLiveWatchFs(watch: LiveTailWatch): void {
    if (!watch.active || this.disposed) return;
    if (!watch.fileWatcher && fs.existsSync(watch.cursor.filePath)) {
      watch.dirWatcher?.close();
      watch.dirWatcher = undefined;
      watch.watchedDir = undefined;
      try {
        const watcher = fs.watch(watch.cursor.filePath, { persistent: false }, () =>
          this.scheduleWatchPoll(watch),
        );
        watcher.on("error", () => undefined);
        watch.fileWatcher = watcher;
      } catch {
        /* Poll timer remains as fallback. */
      }
      return;
    }
    if (!watch.fileWatcher && !watch.dirWatcher) {
      const parentDir = path.dirname(watch.cursor.filePath);
      const grandParentDir = path.dirname(parentDir);
      const watchDir = fs.existsSync(parentDir)
        ? parentDir
        : fs.existsSync(grandParentDir)
          ? grandParentDir
          : undefined;
      if (watchDir) {
        watch.watchedDir = watchDir;
        try {
          const watcher = fs.watch(watchDir, { persistent: false }, () =>
            this.scheduleWatchPoll(watch),
          );
          watcher.on("error", () => undefined);
          watch.dirWatcher = watcher;
        } catch {
          /* Poll timer remains as fallback. */
        }
      }
    }
  }

  private scheduleWatchPoll(watch: LiveTailWatch): void {
    if (!watch.active || this.disposed || watch.scheduled) return;
    watch.scheduled = true;
    queueMicrotask(() => {
      watch.scheduled = false;
      if (!watch.active || this.disposed) return;
      this.pollLiveWatch(watch);
    });
  }

  private pollLiveWatch(watch: LiveTailWatch, run = watch.run): void {
    if (!watch.active || this.disposed) return;
    if (!watch.fileWatcher) {
      if (
        watch.dirWatcher &&
        watch.watchedDir !== path.dirname(watch.cursor.filePath) &&
        fs.existsSync(path.dirname(watch.cursor.filePath))
      ) {
        watch.dirWatcher.close();
        watch.dirWatcher = undefined;
        watch.watchedDir = undefined;
      }
      this.refreshLiveWatchFs(watch);
    }
    const records = readIncrementalJsonlRecords(watch.cursor);
    if (run && watch.cursorKey) {
      run.tailCursors ??= {};
      run.tailCursors[watch.cursorKey] = consumedJsonlOffset(watch.cursor);
    }
    if (records.length) watch.onRecords(records);
  }

  private closeLiveWatch(watch: LiveTailWatch): void {
    watch.active = false;
    watch.fileWatcher?.close();
    watch.fileWatcher = undefined;
    watch.dirWatcher?.close();
    watch.dirWatcher = undefined;
    watch.watchedDir = undefined;
  }

  private attachForegroundWatch(
    tracker: ForegroundSubagentTracker,
    taskId: string,
    filePath: string,
    format: ChildSourceFormat,
    cancellable: boolean,
  ): void {
    if (this.disposed || tracker.childWatches.has(taskId)) return;
    const watch = this.createLiveWatch(filePath, format, (records) => {
      for (const record of records) {
        this.projectRecordToChild(taskId, cancellable, record, format);
      }
    });
    tracker.childWatches.set(taskId, watch);
    this.ensureForegroundPollTimer();
  }

  private pollForegroundTracker(tracker: ForegroundSubagentTracker): void {
    if (this.disposed) return;
    for (const watch of tracker.childWatches.values()) {
      this.pollLiveWatch(watch);
    }
  }

  private ensureForegroundPollTimer(): void {
    if (!this.foregroundTrackers.size || this.disposed) {
      clearInterval(this.foregroundPollTimer);
      this.foregroundPollTimer = undefined;
      return;
    }
    if (!this.foregroundPollTimer) {
      this.foregroundPollTimer = setInterval(() => {
        for (const tracker of this.foregroundTrackers.values()) {
          this.pollForegroundTracker(tracker);
        }
      }, this.options.livePollIntervalMs ?? 250);
      this.foregroundPollTimer.unref();
    }
  }

  private stopForegroundTracker(toolCallId: string): void {
    const tracker = this.foregroundTrackers.get(toolCallId);
    if (!tracker) return;
    for (const watch of tracker.childWatches.values()) this.closeLiveWatch(watch);
    tracker.childWatches.clear();
    tracker.rowBindings.clear();
    this.foregroundTrackers.delete(toolCallId);
    if (!this.foregroundTrackers.size) {
      clearInterval(this.foregroundPollTimer);
      this.foregroundPollTimer = undefined;
    }
  }

  private startAsyncRunTracker(run: ActiveAsyncRunRecord): void {
    if (this.disposed || this.asyncTrackers.has(run.runId)) return;
    const tracker: AsyncRunTracker = {
      run,
      parentWatch: this.createLiveWatch(
        path.join(run.asyncDir, "events.jsonl"),
        "async_events",
        (records) => this.handleAsyncParentRecords(tracker, records),
        {
          initialOffset: run.tailCursors?.parent ?? 0,
          run,
          cursorKey: "parent",
        },
      ),
      childWatches: new Map(),
      childTaskIds: new Map(),
    };
    this.asyncTrackers.set(run.runId, tracker);
    for (const child of run.children) {
      if (child.execution?.model || child.execution?.effort) {
        const entry = this.getOrCreateProjectionState(child.taskId);
        entry.emittedExecution = { ...child.execution };
        entry.state.execution = { ...child.execution };
      }
      if (child.childRunId && isSafeChildRunId(child.childRunId) && !terminalStatus(child.status)) {
        this.attachAsyncWorkflowChildWatch(tracker, child, child.childRunId);
      }
    }
    this.ensureAsyncPollTimer();
    this.pollAsyncRunTracker(tracker);
  }

  private handleAsyncParentRecords(tracker: AsyncRunTracker, records: Json[]): void {
    const { run } = tracker;
    for (const record of records) {
      if (record.type === "subagent.child-status") {
        const canonicalId = text(record.childId ?? record.workflowKey);
        const explicitIndex =
          typeof record.stepIndex === "number" &&
          Number.isInteger(record.stepIndex) &&
          record.stepIndex >= 0
            ? record.stepIndex
            : undefined;
        let hintedIndex = explicitIndex;
        if (hintedIndex === undefined && canonicalId) {
          const match = /^(?:task|step)-(\d+)$/.exec(canonicalId);
          if (match) {
            const parsed = Number(match[1]) - 1;
            if (Number.isInteger(parsed) && parsed >= 0) hintedIndex = parsed;
          }
        }
        let child = canonicalId
          ? run.children.find((c) => c.canonicalChildId === canonicalId)
          : undefined;
        if (!child && hintedIndex !== undefined) {
          child = run.children.find((c) => c.stepIndex === hintedIndex);
        }
        if (
          !child &&
          run.mode === "workflow" &&
          canonicalId &&
          (hintedIndex === undefined || hintedIndex === 0)
        ) {
          child = run.children.find((c) => c.canonicalChildId === "step:0");
        }
        if (!child && run.mode === "workflow") {
          let index = hintedIndex;
          if (index === undefined || run.children.some((c) => c.stepIndex === index)) {
            index = 0;
            while (run.children.some((c) => c.stepIndex === index)) index++;
          }
          const resolvedId = resolveCanonicalChildId(record, index);
          const taskId = workflowTaskId(run, index, resolvedId);
          const initialStatus =
            record.state === "pending" || record.status === "pending" ? "pending" : "running";
          child = {
            taskId,
            stepIndex: index,
            canonicalChildId: resolvedId,
            status: initialStatus,
          };
          run.children.push(child);
          this.event({
            kind: "subagent_start",
            toolUseId: run.toolCallId,
            content: "",
            subagent: {
              taskId,
              description: text(record.agent) ?? resolvedId,
              status: "running",
              cancellable: true,
            },
          });
        }
        if (!child) continue;
        if (canonicalId && child.canonicalChildId.startsWith("step:")) {
          child.canonicalChildId = canonicalId;
        }
        const observed = observedStatusExecution(record);
        const lastTool = text(object(record.activity).currentTool) ?? text(record.currentTool);
        this.emitSubagentMetaProgress(child.taskId, true, observed, lastTool, child);
        const childRunId = text(record.childRunId ?? record.runId);
        if (childRunId && isSafeChildRunId(childRunId) && !terminalStatus(child.status)) {
          this.attachAsyncWorkflowChildWatch(tracker, child, childRunId);
        }
        continue;
      }

      if (typeof record.type === "string" && record.type.startsWith("subagent.")) continue;

      const stepIndex = num(record.subagentStepIndex);
      const child =
        stepIndex !== undefined
          ? (run.children.find((c) => c.stepIndex === stepIndex) ?? run.children[stepIndex])
          : run.children.length === 1
            ? run.children[0]
            : undefined;
      if (child && !terminalStatus(child.status)) {
        this.projectRecordToChild(child.taskId, true, record, "async_events", child);
      }
    }
  }

  private attachAsyncWorkflowChildWatch(
    tracker: AsyncRunTracker,
    child: ActiveAsyncChildRecord,
    childRunId: string,
  ): void {
    if (this.disposed || tracker.childWatches.has(childRunId)) return;
    child.childRunId = childRunId;
    tracker.childTaskIds.set(childRunId, child.taskId);
    const cursorKey = `child:${childRunId}`;
    const eventsPath = path.join(path.dirname(tracker.run.asyncDir), childRunId, "events.jsonl");
    const watch = this.createLiveWatch(
      eventsPath,
      "async_events",
      (records) => {
        if (terminalStatus(child.status)) return;
        for (const record of records) {
          this.projectRecordToChild(child.taskId, true, record, "async_events", child);
        }
      },
      {
        initialOffset: tracker.run.tailCursors?.[cursorKey] ?? 0,
        run: tracker.run,
        cursorKey,
        targetTaskId: child.taskId,
      },
    );
    tracker.childWatches.set(childRunId, watch);
    this.pollLiveWatch(watch, tracker.run);
  }

  private discoverWorkflowChildrenFromDisk(tracker: AsyncRunTracker): void {
    const { run } = tracker;
    const diskStatus = this.runStatus(run);
    if (!diskStatus) return;
    const diskSteps = this.syncRunChildrenFromDisk(run, diskStatus);
    if (run.mode === "workflow") {
      for (let index = 0; index < diskSteps.length; index++) {
        const step = diskSteps[index];
        const canonicalChildId = resolveCanonicalChildId(step, index);
        const existing =
          run.children.find((c) => c.canonicalChildId === canonicalChildId) ??
          run.children.find((c) => c.stepIndex === index);
        if (existing) continue;
        const taskId = workflowTaskId(run, index, canonicalChildId);
        const status = step.status === "pending" ? "pending" : "running";
        const child: ActiveAsyncChildRecord = {
          taskId,
          stepIndex: index,
          canonicalChildId,
          status,
        };
        run.children.push(child);
        this.event({
          kind: "subagent_start",
          toolUseId: run.toolCallId,
          content: "",
          subagent: {
            taskId,
            description: text(step.agent) ?? canonicalChildId,
            status: "running",
            cancellable: true,
          },
        });
      }
    }
    for (const child of run.children) {
      if (terminalStatus(child.status)) continue;
      const diskStep =
        diskSteps.find(
          (step, index) => resolveCanonicalChildId(step, index) === child.canonicalChildId,
        ) ?? diskSteps[child.stepIndex];
      if (!diskStep) continue;
      const observed = observedStatusExecution(diskStep);
      const lastTool = text(object(diskStep.activity).currentTool) ?? text(diskStep.currentTool);
      this.emitSubagentMetaProgress(child.taskId, true, observed, lastTool, child);
      if (run.mode === "workflow") {
        const childRunId = text(diskStep.runId);
        if (childRunId && isSafeChildRunId(childRunId)) {
          this.attachAsyncWorkflowChildWatch(tracker, child, childRunId);
        }
      }
    }
  }

  private pollAsyncRunTracker(tracker: AsyncRunTracker): void {
    if (this.disposed) return;
    this.pollLiveWatch(tracker.parentWatch, tracker.run);
    const covered = this.pushCoverage.get(tracker.run.runId);
    if (
      !covered ||
      tracker.run.children.some(
        (child) =>
          !terminalStatus(child.status) &&
          (!covered.has(child.taskId) ||
            (tracker.run.mode === "workflow" &&
              (!child.childRunId || !tracker.childWatches.has(child.childRunId)))),
      )
    )
      this.discoverWorkflowChildrenFromDisk(tracker);
    for (const watch of tracker.childWatches.values()) {
      this.pollLiveWatch(watch, tracker.run);
    }
  }

  private ensureAsyncPollTimer(): void {
    if (!this.asyncTrackers.size || this.disposed) {
      clearInterval(this.asyncPollTimer);
      this.asyncPollTimer = undefined;
      return;
    }
    if (!this.asyncPollTimer) {
      this.asyncPollTimer = setInterval(() => {
        for (const tracker of this.asyncTrackers.values()) {
          this.pollAsyncRunTracker(tracker);
        }
      }, this.options.livePollIntervalMs ?? 250);
      this.asyncPollTimer.unref();
    }
  }

  private closeAsyncChildWatchesForTask(runId: string, taskId: string): void {
    const tracker = this.asyncTrackers.get(runId);
    if (!tracker) return;
    for (const [childRunId, watch] of tracker.childWatches) {
      if (watch.targetTaskId === taskId || tracker.childTaskIds.get(childRunId) === taskId) {
        this.closeLiveWatch(watch);
        tracker.childWatches.delete(childRunId);
        tracker.childTaskIds.delete(childRunId);
      }
    }
  }

  private stopAsyncRunTracker(runId: string): void {
    const tracker = this.asyncTrackers.get(runId);
    if (!tracker) return;
    this.closeLiveWatch(tracker.parentWatch);
    for (const watch of tracker.childWatches.values()) this.closeLiveWatch(watch);
    tracker.childWatches.clear();
    tracker.childTaskIds.clear();
    this.asyncTrackers.delete(runId);
    if (!this.asyncTrackers.size) {
      clearInterval(this.asyncPollTimer);
      this.asyncPollTimer = undefined;
    }
  }

  private stopAllLiveTrackers(): void {
    for (const toolCallId of [...this.foregroundTrackers.keys()]) {
      this.stopForegroundTracker(toolCallId);
    }
    for (const runId of [...this.asyncTrackers.keys()]) {
      this.stopAsyncRunTracker(runId);
    }
    clearInterval(this.foregroundPollTimer);
    this.foregroundPollTimer = undefined;
    clearInterval(this.asyncPollTimer);
    this.asyncPollTimer = undefined;
    this.subagentProjectionStates.clear();
  }
  async reconcileAsyncRuns(): Promise<void> {
    if (this.disposed || !this.activeAsyncRuns.length) return;
    this.reconciliation ??= this.reconcile().finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }
  private async reconcile(only?: ActiveAsyncRunRecord): Promise<void> {
    const generation = this.processGeneration;
    for (const run of only ? [only] : [...this.activeAsyncRuns]) {
      if (this.disposed || generation !== this.processGeneration) return;
      const status = this.runStatus(run);
      const diskSteps = this.syncRunChildrenFromDisk(run, status);
      const pid = num(status?.pid ?? status?.runnerPid);
      const remote =
        (only || !this.pushCoverage.has(run.runId)) &&
        this.panelHttp.isControlConnected(this.sessionKey)
          ? object(
              await this.panelHttp
                .sendSubagentsRpc(this.sessionKey, "status", { id: run.runId }, this.statsTimeoutMs)
                .catch(() => undefined),
            )
          : {};
      if (
        this.disposed ||
        generation !== this.processGeneration ||
        !this.activeAsyncRuns.includes(run)
      )
        continue;
      const snapshot = object(remote.asyncSnapshot);
      // The control endpoint also returns the bounded v1 projection. It is not an
      // indexed completion roster. Apply its explicit identities, without claiming push coverage.
      const projected = decodePiSubagentSnapshot(snapshot)?.find((node) => node.id === run.runId);
      if (projected) {
        const coverage = this.pushCoverage.get(run.runId);
        this.applyWidgetRoot(run, projected);
        if (this.activeAsyncRuns.includes(run) && coverage)
          this.pushCoverage.set(run.runId, coverage);
        else this.pushCoverage.delete(run.runId);
        if (!this.activeAsyncRuns.includes(run)) continue;
      }
      const remoteRun = [
        ...list(snapshot.jobs),
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
  private async checkAcceptedStop(
    target: NonNullable<ReturnType<typeof resolveStopTarget>>,
  ): Promise<void> {
    const generation = this.processGeneration;
    for (const waitMs of [0, 50, 150, 400, 1000]) {
      if (waitMs) await delay(waitMs);
      if (
        this.disposed ||
        generation !== this.processGeneration ||
        !this.activeAsyncRuns.includes(target.run) ||
        (target.scope === "child" && terminalStatus(target.child.status))
      )
        return;
      await this.reconcile(target.run);
    }
  }

  async stopTask(id: string): Promise<void> {
    if (this.disposed) throw new Error("Pi session is disposed");
    await this.stop(id);
  }
  private async stop(id: string, timeoutMs?: number): Promise<void> {
    const target = resolveStopTarget(this.activeAsyncRuns, id);
    if (!target || (target.scope === "child" && terminalStatus(target.child.status)))
      throw new Error(`Unknown Pi subagent task: ${id}`);
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
      void this.checkAcceptedStop(target);
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
    void this.checkAcceptedStop(target);
  }

  private retiring?: Promise<void>;
  private onExit(
    generation: number,
    rpc: PiRpcClient,
    reason: string,
    transportBroken = false,
  ): void {
    if (!this.current(generation, rpc)) return;
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
    this.failProcessTurns(reason);
  }

  private failProcessTurns(reason: string): void {
    const opening = this.openingTurn;
    const turn = this.activeTurn;
    if (opening && opening !== turn && !opening.settled) {
      opening.settled = true;
      if (opening.written)
        this.emit("prompt_outcome_unknown", { inputId: opening.inputId, reason });
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
    this.context = null;
    this.contextRevision++;
    this.cancelDialogs();
    if (this.rpc) void this.retireProcess();
    this.sessionId = null;
    this.sessionFile = null;
    this.subagentsSessionId = undefined;
    this.hasConfirmedTurns = false;
    this.hasUnanchoredInput = false;
    this.persistedSessionAnchor = undefined;
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
    this.acpRoute?.dispose();
    this.acpRoute = undefined;
    if (this.registered) this.panelHttp.unregisterSession(this.sessionKey);
    this.registered = false;
    this.panelToken = undefined;
  }

  dispose(totalTimeoutMs = 10_000): Promise<void> {
    if (this.closing) return this.closing;
    this.cancelDialogs();
    this.disposed = true;
    this.advanceGeneration();
    clearInterval(this.reconcileTimer);
    this.stopAllLiveTrackers();
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
