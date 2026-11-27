import * as fs from "node:fs";
import * as path from "node:path";
import { isOutstandingSubagentStatus } from "../../../shared/subagent-status";
import { applyExtensionUi } from "../../../shared/extension-ui";
import { classifyProbeDelivery } from "../project/network-failure";
import { hasPersistedPiReport, validatePiAttachments } from "../session/pi";
import {
  SessionConfig,
  StreamEvent,
  SubAgentInfo,
  SessionState,
  CommandInfo,
  ContextUsage,
  RunState,
  BackgroundTask,
  ThinkingStats,
  MessageStatus,
  PromptEnvelope,
  InputTrigger,
  DispatchAttempt,
  ExtensionUiEvent,
  ExtensionUiSnapshot,
  UiDialogRequest,
  UiDialogResponse,
} from "../session/types";
import type { GitInfo, PrInfo } from "../repo/git";
import { type BoundarySteer, HostSessionHandle, HostRegistry } from "../session/host";
import {
  MODEL_OPTIONS,
  type ModelOption,
  backendForModel,
  defaultEffortForModel,
  effortLevelsForModel,
  supportsFastMode,
} from "../config/presets";

export type { MessageStatus } from "../session/types";
export type MessageKind = "user" | "agent" | "system";

export interface MessageImage {
  name: string;
  url: string;
}

export interface ForwardRef {
  messageId: string;
  fromAgent: string;
  fromAvatar: string;
  preview: string;
}

export interface Message {
  id: string;
  kind: MessageKind;
  agentId: string | null;
  content: string;
  timestamp: number;
  status: MessageStatus;
  events?: StreamEvent[];
  turnId?: string;
  localCommand?: true;
  images?: MessageImage[];
  forwardRef?: ForwardRef;
  // Sent by another session rather than typed by the user.
  from?: MessageOrigin;
  // Queued-message bookkeeping: which agent will run it and the fully built
  // prompt to dispatch (kept on the message so queues survive restarts).
  queuedFor?: string;
  queuedEnvelope?: PromptEnvelope;
  dispatchAttempt?: DispatchAttempt;
  // The delayed status already shown to readers; keep it stable through the write.
  pendingDelivery?: "starting" | "sending";
  // First agent reply opened for a pending input, independent of delivery receipt.
  replyTo?: string;
  // Handed to the running turn (Codex steer) and not yet read by the model:
  // the queue leaves it alone and it cannot be cancelled. A turn that ends
  // without reading it, or a restart, gives it back to the queue.
  steering?: boolean;
  // Agent replies: reasoning effort the turn ran with, whether it ran in
  // fast mode, and the context occupancy reported when it finished.
  effort?: string;
  fast?: boolean;
  // Agent replies: the model the turn ran on (an agent's model can change).
  model?: string;
  context?: ContextUsage | null;
  // Thinking tokens and time of the turn, when the backend reports them.
  thinking?: ThinkingStats;
  // "summary" when the events carry only chips/counts (history pages); the
  // full events arrive via load_message_details.
  detail?: "summary";
  liveThinkingSince?: number;
  waitingSince?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  avatar: string;
  color: string;
  isDefault: boolean;
  // Named account from config [accounts.*]; undefined = local login.
  account?: string;
}

// Wire form of an agent: info plus transient runtime state.
export interface AgentRuntimeInfo extends AgentInfo {
  canSwitchBackend: boolean;
  busy: boolean;
  networkWaiting: boolean;
  retryPending: boolean;
  state: RunState;
  activity: string | null;
  lastStreamAt?: number;
  retryLabel?: string;
  effort: string | null;
  // Backend default when known; does not change the configured override above.
  effectiveEffort?: string;
  // The levels /effort takes for its model.
  effortLevels: string[];
  fast: boolean;
  // Background work the agent is waiting on (see RunState "waiting").
  backgroundTasks: BackgroundTask[];
  // Context occupancy at its latest backend boundary. Undefined means there
  // is no occupancy to show (fresh, cleared, or an archived/unloaded history).
  context?: ContextUsage | null;
  // A scheduled wake-up it is sleeping until.
  wake: { at: number; reason: string } | null;
}

export interface AgentState extends AgentInfo {
  session: SessionState;
  // AgentEntry.delivered, and whether the agent got another message since.
  delivered?: TurnInput & { since?: boolean };
  pendingTurnFailures?: PendingTurnFailure[];
  // A rate-limit pause still to be retried, with the prompt the retry sends.
  pausedUntil?: number;
  lastEnvelope?: PromptEnvelope;
}

// A workspace in a project: its lead agent's, or a worker session the lead
// started (see project/manager.ts).
export type ProjectRole = "lead" | "worker";

export interface ProjectLink {
  projectId: string;
  role: ProjectRole;
  // A worker kept to its own task: its panel tools reach nothing else of
  // the project.
  isolated?: boolean;
  // A worker that does not report to the lead (one the user made, or one
  // the user switched off): it reads the project, the lead neither hears
  // from it nor sends it work.
  unreported?: boolean;
}

// Who sent a message the user did not type: the project's lead, one of its
// worker sessions, another project's lead, or the panel about a worker (its
// workspace and name).
export interface MessageOrigin {
  workspaceId: string;
  name: string;
  role: "lead" | "worker" | "peer" | "panel";
  // The sender's project, for a peer.
  projectId?: string;
}

function isInboxReport(msg: Message): boolean {
  return !!msg.queuedEnvelope?.reportId && msg.queuedEnvelope.panelContext === undefined;
}

function pairedPanelMessageId(userMessageId: string): string {
  return `${userMessageId}:panel`;
}

function inputTrigger(input?: Message): InputTrigger {
  const role = input?.from?.role;
  return !input || role === "panel" ? "system" : (role ?? "user");
}

// How the panel names a message's sender (the client's label matches).
export function originLabel(from: MessageOrigin): string {
  if (from.role === "lead") return "Lead";
  if (from.role === "panel") return `Panel · ${from.name}`;
  return from.role === "peer" ? `${from.name} · lead` : from.name;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  project: string;
  hostId: string;
  cwd: string;
  git: GitInfo | null;
  pr: PrInfo | null;
  agents: AgentRuntimeInfo[];
  messages: Message[];
  createdAt: number;
  lastMessageAt?: number;
  // Set while the workspace is archived (idle past the configured window or
  // archived by hand). Archived workspaces keep their history on disk only.
  archivedAt: number | null;
  projectLink?: ProjectLink;
  // A worker stopped on the user (project/manager.ts awaitsUser); the server
  // adds it to the list it sends.
  awaitsUser?: boolean;
  // Actionable results since any client last read the session.
  unread: number;
  lastResult?: "done" | "failed";
  queued?: boolean;
}

export interface WorkspaceState {
  leadOutage?: import("../project/lead-recovery").LeadOutage;
  id: string;
  name: string;
  project: string;
  hostId: string;
  cwd: string;
  normalizedCwd?: string;
  agents: AgentState[];
  // Absent when the workspace's history is not loaded in memory; the
  // persistence layer then keeps whatever is already on disk.
  messages?: Message[];
  createdAt: number;
  lastActivityAt?: number;
  archivedAt?: number | null;
  projectLink?: ProjectLink;
  attention?: { unread: number; lastResult?: WorkspaceInfo["lastResult"]; awaitsUser: boolean };
}

type CommandOutcome = string | { forward: string } | null;

export interface AgentEntry {
  extensionUi?: ExtensionUiSnapshot;
  info: AgentInfo;
  session: HostSessionHandle;
  handler: (event: StreamEvent) => void;
  currentMsg: Message | null;
  openingPrompt?: {
    envelope: PromptEnvelope;
    input?: Message;
    writeClaimed: boolean;
    replied: boolean;
  };
  recoveringDispatching?: boolean;
  networkWaiting?: boolean;
  activeReportId?: string;
  // Last prompt dispatched to the session — the retry unit for rate limits.
  lastEnvelope?: PromptEnvelope;
  // While set (epoch ms), the queue holds and dequeueNext is a no-op.
  pausedUntil?: number;
  // The pause ends in a retry of lastEnvelope (a rate limit), not just in the
  // queue moving on (spaced starts); with no lastEnvelope, in a carry-on.
  retryPending?: boolean;
  // Transient "doing X right now" label from the session (see setActivity).
  activity?: string | null;
  runState?: RunState;
  lastStreamAt?: number;
  retryLabel?: string;
  // Context at the latest boundary; the cache flag distinguishes an
  // intentionally absent value from one that has not been resolved yet.
  lastContext?: ContextUsage | null;
  hasCachedContext?: boolean;
  contextRevision?: number;
  // The message the agent got last, and the last one from another session
  // (the same record while nothing came after it).
  input?: TurnInput;
  delivered?: TurnInput;
  pendingTurnFailures?: PendingTurnFailure[];
}

interface PendingTurnFailure {
  inputId: string;
  replyId: string;
}

// A message an agent got and the turns it drove: their replies (a wake-up's
// included, not a local command's), what cut the latest short, and whether
// its sender has heard what came of it.
export interface TurnInput {
  recovery?: true;
  id: string;
  replies: string[];
  stopped?: "user" | "restart" | "lead";
  answered?: boolean;
  finished?: boolean;
  // Background work or a wake-up was still to come: a crash cuts it off.
  waiting?: boolean;
}

export interface ManualInputAdmission {
  panelContext?: {
    reportId: string;
    text: string;
    recovery: NonNullable<PromptEnvelope["recovery"]>;
  };
  stage(): void;
  rollback(): void;
  committed(): void;
}

export interface WorkspaceCallbacks {
  onNewMessage: (wsId: string, msg: Message) => void;
  onStreamEvent: (
    wsId: string,
    msg: Message,
    event: StreamEvent,
    streamAt?: number,
    retryLabel?: string | null,
  ) => void;
  onAttention?: (wsId: string, unread: number, lastResult: WorkspaceInfo["lastResult"]) => void;
  onMessageDone: (
    wsId: string,
    msgId: string,
    status: MessageStatus,
    content: string,
    events?: StreamEvent[],
    patch?: Partial<Pick<Message, "context" | "effort" | "thinking">> & {
      queuedFor?: string | null;
      steering?: boolean;
      pendingDelivery?: Message["pendingDelivery"];
    },
  ) => void;
  onLeadTerminal?: (
    workspace: Workspace,
    agentId: string,
    reply: Message,
    interrupted: boolean,
    liveTurn: boolean,
  ) => void;
  onLeadStop?: (workspace: Workspace, agentId?: string) => void;
  onAgentBusy?: (wsId: string, agentId: string, streamAt: number) => void;
  onAgentIdle?: (wsId: string, agentId: string) => void;
  onSaveNow?: () => void;
  prepareManualInput?: (
    workspace: Workspace,
    agentId: string,
    pair: boolean,
  ) => ManualInputAdmission | undefined;
  onReportDeliveryState?: (
    reportId: string,
    state: "enqueued" | "dispatching" | "sent_to_pi" | "outcome_unknown" | "error" | "settled",
    meta?: { errorMessage?: string; acceptedByPiAt?: number; settledAt?: number },
  ) => void;
  onExtensionUi?: (event: ExtensionUiEvent) => void;
  onUiDialogRequest?: (dialog: UiDialogRequest) => void;
  onUiDialogResolved?: (
    dialog: Pick<UiDialogRequest, "workspaceId" | "agentId" | "processGeneration" | "requestId">,
  ) => void;
  onCommandsUpdate?: (agentId: string, commands: CommandInfo[]) => void;
  onSessionCapabilities?: (wsId: string, agentId: string) => void;
  ensureLoaded?: (ws: Workspace) => boolean;
  canDispatch?: (ws: Workspace) => boolean;
  onDeployActivity?: () => void;
  trackCleanup?: (work: Promise<void>) => Promise<void>;
  canDequeue?: () => boolean;
  onRateLimit?: (
    wsId: string,
    agentId: string,
    info: { rateLimitType?: string; resetsAt?: number; turnFinal?: true },
  ) => void;
  onAgentActivity?: (wsId: string, agentId: string, activity: string | null) => void;
  onAgentState?: (wsId: string, agentId: string, state: RunState) => void;
  // Agent attributes changed: persistent ones (effort level...) or, when
  // `transient`, runtime-only ones (background tasks) that need no save.
  onAgentUpdated?: (wsId: string, agent: AgentRuntimeInfo, transient?: boolean) => void;
  // A message left the list (an empty reply a steered message replaced).
  onMessageRemoved?: (wsId: string, msgId: string) => void;
  // An SDK message the session did not know how to render; logged so a
  // missing rendering is diagnosable instead of silent.
  onUnhandled?: (wsId: string, agentId: string, msg: unknown) => void;
  modelOptions?(): ModelOption[];
  piConfig?: () => Partial<SessionConfig>;
  onSessionReplaced?: (workspace: Workspace, session: HostSessionHandle) => void;
}

// Persisted events from older versions may lack fields the renderer
// indexes (content). Only detached tasks tracked by the session survive a restart.
export function normalizeEvents(events: StreamEvent[], activeTasks?: ReadonlySet<string>): void {
  for (const ev of events) {
    if (typeof ev.content !== "string") ev.content = "";
    const sa = ev.subagent;
    if (!sa) continue;
    if (
      !activeTasks?.has(sa.taskId) &&
      (isOutstandingSubagentStatus(sa.status) ||
        (ev.kind === "subagent_start" && sa.status == null))
    ) {
      sa.status = "stopped";
    }
    if (sa.events) normalizeEvents(sa.events, activeTasks);
  }
}

const RETRY_PROGRESS_KINDS = new Set([
  "text_delta",
  "thinking_delta",
  "thinking",
  "tool_use",
  "subagent_start",
]);

function clearRetry(msg: Message): boolean {
  if (!msg.events?.some((e) => e.kind === "retry")) return false;
  msg.events = msg.events.filter((e) => e.kind !== "retry");
  return true;
}

function copySubagentExecution(target: SubAgentInfo, source: SubAgentInfo | undefined): void {
  if (source?.model != null) target.model = source.model;
  if (source?.effort != null) target.effort = source.effort;
  if (source?.lastTool != null) target.lastTool = source.lastTool;
}

function enrichSubagent(events: StreamEvent[], patch: SubAgentInfo): number | undefined {
  const matches = events.filter(
    (e) =>
      (e.kind === "subagent_start" || e.kind === "subagent_done") &&
      e.subagent?.taskId === patch.taskId,
  );
  if (matches.length === 0) return;
  const owner = matches.find((e) => e.kind === "subagent_start") ?? matches[0];
  const revision = 1 + Math.max(...matches.map((e) => e.subagent!.transcriptRevision ?? 0));
  for (const e of matches) {
    const sa = e.subagent!;
    sa.transcriptRevision = revision;
    copySubagentExecution(sa, patch);
    if (patch.summary != null) sa.summary = patch.summary;
    if (patch.durationMs != null) sa.durationMs = patch.durationMs;
    if (patch.events != null) sa.events = e === owner ? patch.events : undefined;
    const count = patch.events?.length ?? patch.eventCount;
    if (count != null) sa.eventCount = count;
  }
  return revision;
}

// Apply an inner event to a subagent's transcript. Carriers nest: a
// grandchild's event arrives as progress(child, _innerEvent: progress(grand,
// _innerEvent: ev)), so recurse into the nested start's own transcript.
export function applyInnerEvent(saEvents: StreamEvent[], innerEvent: StreamEvent): boolean {
  if (innerEvent.kind === "subagent_enrichment") {
    const patch = innerEvent.subagent;
    if (!patch) return false;
    const revision = enrichSubagent(saEvents, patch);
    if (revision == null) return false;
    innerEvent.subagent = { ...patch, transcriptRevision: revision };
    return true;
  }
  if (
    innerEvent.kind === "tool_use" &&
    innerEvent.toolUseId &&
    saEvents.some((e) => e.kind === "tool_use" && e.toolUseId === innerEvent.toolUseId)
  ) {
    return false;
  }
  if (innerEvent.kind === "tool_result" && innerEvent.toolUseId) {
    const i = saEvents.findIndex(
      (e) => e.kind === "tool_use" && e.toolUseId === innerEvent.toolUseId,
    );
    if (i >= 0) {
      saEvents[i].toolResult = innerEvent.content;
      if (innerEvent.isMarkdown) saEvents[i].toolResultIsMarkdown = true;
      if (innerEvent.isError) saEvents[i].toolResultIsError = true;
      if (innerEvent.durationMs != null) saEvents[i].durationMs = innerEvent.durationMs;
      return true;
    }
  }
  if (innerEvent.kind === "subagent_progress" && innerEvent.subagent?.taskId) {
    const nid = innerEvent.subagent.taskId;
    const nested = innerEvent.subagent._innerEvent;
    if (nested) {
      const si = saEvents.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === nid,
      );
      if (si >= 0) return applyInnerEvent((saEvents[si].subagent!.events ??= []), nested);
      // No start here: the carrier has nowhere to go; drop it.
      return false;
    }
    const i = saEvents.findIndex(
      (e) => e.kind === "subagent_progress" && e.subagent?.taskId === nid,
    );
    if (i >= 0) {
      saEvents[i] = innerEvent;
      return true;
    }
  }
  if (innerEvent.kind === "subagent_done" && innerEvent.subagent?.taskId) {
    const nid = innerEvent.subagent.taskId;
    const pi = saEvents.findIndex(
      (e) => e.kind === "subagent_progress" && e.subagent?.taskId === nid,
    );
    if (pi >= 0) saEvents.splice(pi, 1);
    const si = saEvents.findIndex((e) => e.kind === "subagent_start" && e.subagent?.taskId === nid);
    if (si >= 0) {
      copySubagentExecution(saEvents[si].subagent!, innerEvent.subagent);
      saEvents[si].subagent!.status = innerEvent.subagent.status;
      saEvents[si].subagent!.summary = innerEvent.subagent.summary;
      saEvents[si].subagent!.usage = innerEvent.subagent.usage;
      saEvents[si].subagent!.durationMs = innerEvent.subagent.durationMs;
    }
  }
  saEvents.push(innerEvent);
  return true;
}

export class Workspace {
  leadOutage?: WorkspaceState["leadOutage"];
  id: string;
  name: string;
  project: string;
  hostId: string;
  cwd: string;
  normalizedCwd: string;
  private readonly pendingDialogs = new Map<string, UiDialogRequest>();
  agents = new Map<string, AgentEntry>();
  messages: Message[] = [];
  createdAt: number;
  // Timestamp of the newest message; maintained so it survives unloading.
  lastActivityAt: number;
  archivedAt: number | null = null;
  projectLink?: ProjectLink;
  unseen = 0;
  lastResult: WorkspaceInfo["lastResult"];
  // Last projected wait state, persisted so reconnecting does not re-mark it unread.
  projectedAwaitsUser = false;
  // False once the history has been unloaded (archived workspace). Every
  // path that touches `messages` must call ensureLoaded via the server first.
  messagesLoaded = true;
  // Filled by the server's background git scanner; getInfo must never run
  // git itself (a synchronous call here used to block the whole event loop).
  git: GitInfo | null = null;
  pr: PrInfo | null = null;

  private cb?: WorkspaceCallbacks;
  private hostRegistry: HostRegistry;
  private disposed = false;
  // Messages changed since the history was last saved; new and dropped
  // ones are found without it (HistoryDb.save).
  private changed = new Set<string>();

  constructor(
    id: string,
    name: string,
    project: string,
    hostId: string,
    cwd: string,
    hostRegistry: HostRegistry,
    cb?: WorkspaceCallbacks,
    private readonly storage?: { dataDir: string; uploadsDir: string },
    normalizedCwd?: string,
  ) {
    this.id = id;
    this.name = name;
    this.project = project;
    this.hostId = hostId;
    this.cwd = cwd;
    this.normalizedCwd =
      normalizedCwd ?? (fs.existsSync(cwd) ? fs.realpathSync.native(cwd) : path.resolve(cwd));
    this.hostRegistry = hostRegistry;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    this.cb = cb;
  }

  get isArchived(): boolean {
    return this.archivedAt !== null;
  }

  get isIdle(): boolean {
    for (const a of this.agents.values()) {
      if (this.dispatchHeld(a)) return false;
      if (this.agentState(a) === "waiting") return false;
    }
    return !this.messages.some(
      (m) =>
        m.status === "queued" ||
        m.status === "streaming" ||
        m.status === "starting" ||
        m.status === "dispatching",
    );
  }

  // Nothing will run here until a message arrives: no turn, queued message,
  // background task, scheduled wake-up or rate-limit pause.
  get isQuiet(): boolean {
    if (!this.isIdle) return false;
    const now = Date.now();
    for (const a of this.agents.values()) {
      if (this.agentState(a) !== "idle") return false;
      if (a.retryPending || (a.pausedUntil && now < a.pausedUntil)) return false;
    }
    return true;
  }

  get deployBusy(): boolean {
    if (this.disposed) return false;
    if (!this.isQuiet || this.hasPendingDialogs) return true;
    return [...this.agents.values()].some(
      (entry) => this.dispatchHeld(entry) || entry.session.deployBusy || entry.session.wake,
    );
  }

  async retireIdleProcesses(signal: AbortSignal): Promise<void> {
    if (this.disposed) return;
    if (this.deployBusy) throw new Error("Workspace is busy");
    const results = await Promise.allSettled(
      [...this.agents.values()].map(async ({ session }) => {
        await session.retireIdleProcess?.(signal);
      }),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Backend retirement failed");
  }

  // Per agent, the last message another session sent it and what came of
  // it: the replies of the turns it drove, whether the latest was stopped,
  // and whether the user has written to the agent since.
  lastDelivered(): Array<{
    agentId: string;
    input: Message;
    replies: Message[];
    stopped?: "user" | "restart" | "lead";
    answered: boolean;
    finished: boolean;
    since: boolean;
  }> {
    const out = [];
    for (const [agentId, a] of this.agents) {
      const d = a.delivered;
      const input = d && this.messages.find((m) => m.id === d.id);
      if (!input) continue;
      const replies = this.messages.filter((m) => d.replies.includes(m.id));
      out.push({
        agentId,
        input,
        replies,
        stopped: d.stopped,
        answered: !!d.answered,
        finished: !!d.finished,
        since: a.input !== d && !a.input?.finished,
      });
    }
    return out;
  }

  // Per agent, the last message it got, the replies of the turns it drove
  // and what cut the latest short. A restart keeps that record only for a
  // message from another session; for the user's the messages stand in: the
  // last one not a slash command (the panel may have answered it itself)
  // and the replies up to the next.
  lastTurns(): Array<{
    agentId: string;
    input: Message;
    replies: Message[];
    stopped?: "user" | "restart" | "lead";
    finished?: boolean;
  }> {
    const out = [];
    for (const [agentId, a] of this.agents) {
      const t = a.input;
      if (t) {
        const input = this.messages.find((m) => m.id === t.id);
        if (!input) continue;
        const replies = this.messages.filter((m) => t.replies.includes(m.id));
        out.push({ agentId, input, replies, stopped: t.stopped, finished: t.finished });
        continue;
      }
      const typed = (idx: number) => {
        const m = this.messages[idx];
        return (
          m.kind === "user" &&
          m.status !== "queued" &&
          !m.content.trimStart().startsWith("/") &&
          !this.messages[idx + 1]?.localCommand
        );
      };
      let i = this.messages.length - 1;
      while (i >= 0 && !typed(i)) i--;
      if (i < 0) continue;
      let next = i + 1;
      while (next < this.messages.length && this.messages[next].kind !== "user") next++;
      const replies = this.messages
        .slice(i + 1, next)
        .filter((m) => m.kind === "agent" && m.agentId === agentId);
      out.push({ agentId, input: this.messages[i], replies });
    }
    return out;
  }

  pendingTurnFailures(): PendingTurnFailure[] {
    return [...this.agents.values()].flatMap((a) => a.pendingTurnFailures ?? []);
  }

  clearTurnFailure(replyId: string): void {
    for (const a of this.agents.values()) {
      if (a.pendingTurnFailures)
        a.pendingTurnFailures = a.pendingTurnFailures.filter(
          (failure) => failure.replyId !== replyId,
        );
    }
  }

  // Archived: no retry is left to run, and nobody waits on a word from it.
  settleForArchive(): void {
    for (const a of this.agents.values()) {
      this.dropRetry(a);
      a.pendingTurnFailures = undefined;
      if (a.delivered) a.delivered.answered = true;
    }
  }

  // The session no longer reports to the lead: a rate-limit retry of what
  // the lead sent is not run.
  dropLeadRetries(): void {
    for (const a of this.agents.values()) {
      a.pendingTurnFailures = undefined;
      const from = this.messages.find((m) => m.id === a.input?.id)?.from?.role;
      if (from !== "lead" && from !== "panel") continue;
      this.dropRetry(a);
      a.lastEnvelope = undefined;
    }
  }

  // Its sender has heard what came of a delivered message.
  markAnswered(messageId: string): void {
    for (const a of this.agents.values()) {
      if (a.delivered?.id === messageId) a.delivered.answered = true;
    }
  }

  // Active turn input IDs across agents, captured when finish_task runs so
  // replaying an offline report never hands back a newer user-owned turn.
  currentInputIds(): string[] {
    const ids = new Set<string>();
    for (const a of this.agents.values()) {
      const id = a.input?.id ?? a.delivered?.id;
      if (id) ids.add(id);
    }
    return [...ids];
  }

  // A successful finish_task handed the reporting turn back to the lead.
  markFinished(inputIds: readonly string[]): void {
    for (const a of this.agents.values()) {
      const turn = a.input ?? a.delivered;
      // Replay may see the same input after the user stopped it. A report
      // already applied to that input cannot release it again.
      if (!turn || turn.finished || !inputIds.includes(turn.id)) continue;
      turn.finished = true;
      if (turn.stopped === "user") delete turn.stopped;
      if (a.delivered) {
        a.delivered.finished = true;
        if (a.delivered.stopped === "user") delete a.delivered.stopped;
      }
    }
  }

  // Ownership blockers readable from persisted agent state even when an
  // archived workspace's messages are not loaded in memory.
  persistedOwnershipBlocker(): "taken_over" | "user_stopped" | null {
    for (const a of this.agents.values()) {
      const d = a.delivered;
      if (d && a.input !== d && !a.input?.finished) return "taken_over";
      if (d?.stopped === "user" || a.input?.stopped === "user") return "user_stopped";
    }
    return null;
  }

  takeChanged(): Set<string> {
    const changed = this.changed;
    this.changed = new Set();
    return changed;
  }

  hasChanges(): boolean {
    return this.changed.size > 0;
  }

  touch(ids: Iterable<string>): void {
    for (const id of ids) this.changed.add(id);
  }

  // Every change a client is told about is one to save.
  private streamed(msg: Message, event: StreamEvent): void {
    this.changed.add(msg.id);
    const timed = updateLiveTiming(msg, event);
    const agent = msg.agentId ? this.agents.get(msg.agentId) : undefined;
    // Do not reset the turn's clock for token estimates or detached work.
    const streamAt =
      agent?.currentMsg === msg &&
      msg.status === "streaming" &&
      event.kind !== "thinking_tokens" &&
      event.kind !== "subagent_enrichment"
        ? (agent.lastStreamAt = Date.now())
        : undefined;
    let retryLabel: string | null | undefined;
    if (agent && agent.currentMsg === msg) {
      if (event.kind === "retry") retryLabel = event.content || null;
      else if (agent.retryLabel && RETRY_PROGRESS_KINDS.has(event.kind)) retryLabel = null;
      if (retryLabel !== undefined) agent.retryLabel = retryLabel ?? undefined;
    }
    this.cb?.onStreamEvent(this.id, msg, timed, streamAt, retryLabel);
  }

  private beganTurn(entry: AgentEntry, clearFailure = true): void {
    if (clearFailure && this.lastResult === "failed") {
      this.lastResult = undefined;
      this.cb?.onAttention?.(this.id, this.unseen, this.lastResult);
    }
    entry.lastStreamAt ??= Date.now();
    this.cb?.onAgentBusy?.(this.id, entry.info.id, entry.lastStreamAt);
  }

  private endedTurn(entry: AgentEntry): void {
    entry.lastStreamAt = undefined;
    entry.retryLabel = undefined;
    this.cb?.onAgentIdle?.(this.id, entry.info.id);
  }

  private recordResult(result: NonNullable<WorkspaceInfo["lastResult"]>): void {
    this.lastResult = result;
    this.unseen++;
    this.cb?.onAttention?.(this.id, this.unseen, result);
  }

  private finished(
    id: string,
    status: MessageStatus,
    content: string,
    events?: StreamEvent[],
    patch?: Partial<Pick<Message, "context" | "effort" | "thinking">>,
  ): void {
    this.changed.add(id);
    const msg = this.findMessage(id);
    const queue =
      msg?.kind === "user"
        ? {
            queuedFor: msg.queuedFor ?? null,
            steering: msg.steering ?? false,
            ...(msg.pendingDelivery && { pendingDelivery: msg.pendingDelivery }),
          }
        : undefined;
    this.cb?.onMessageDone(this.id, id, status, content, events, { ...patch, ...queue });
  }

  private pushMessage(msg: Message): void {
    this.messages.push(msg);
    if (msg.timestamp > this.lastActivityAt) this.lastActivityAt = msg.timestamp;
    this.cb?.onNewMessage(this.id, msg);
  }

  // Drop the history from memory (it stays on disk). Only meaningful for an
  // idle workspace; the server persists before calling this.
  unloadMessages(): void {
    this.messages = [];
    this.messagesLoaded = false;
    for (const entry of this.agents.values()) entry.currentMsg = null;
  }

  setMessages(messages: Message[]): void {
    const activeTasks = new Map(
      [...this.agents].map(([id, entry]) => [id, activeSubagentTaskIds(entry.session.getState())]),
    );
    for (const m of messages) restoreMessage(m, activeTasks.get(m.agentId ?? ""));
    this.messages = messages;
    this.messagesLoaded = true;
    const last = messages[messages.length - 1];
    if (last && last.timestamp > this.lastActivityAt) this.lastActivityAt = last.timestamp;
  }

  private pushSystemMessage(
    content: string,
    extra?: Pick<Message, "agentId" | "events" | "context">,
  ): void {
    const msg: Message = {
      id: genId("msg"),
      kind: "system",
      agentId: extra?.agentId ?? null,
      content,
      timestamp: Date.now(),
      status: "done",
      ...(extra?.events && { events: extra.events }),
      ...(extra?.context !== undefined && { context: extra.context }),
    };
    this.pushMessage(msg);
  }

  private makeAgentMsg(agentId: string): Message {
    const session = this.agents.get(agentId)?.session;
    const config = session?.nextTurnOptions ?? session?.getState().config;
    const effort = config?.effort ?? session?.effectiveEffort ?? undefined;
    const model = config?.model ?? this.agents.get(agentId)?.info.model;
    const timestamp = Date.now();
    return {
      id: genId("msg"),
      kind: "agent",
      agentId,
      content: "",
      timestamp,
      waitingSince: timestamp,
      status: "streaming",
      events: [],
      turnId: genId("turn"),
      ...(effort && { effort }),
      ...(config?.fast && { fast: true }),
      ...(model && { model }),
    };
  }

  // A reply no result will finish: done as it stands, and clients told.
  private settle(msg: Message): void {
    if (msg.status !== "streaming") return;
    msg.status = "done";
    clearLiveTiming(msg);
    this.finished(msg.id, "done", msg.content, msg.events);
  }

  // Every reply of the agent left streaming that no running turn will finish.
  private settleStale(entry: AgentEntry): void {
    const live = entry.session.isRunning ? entry.currentMsg : null;
    for (const m of this.messages) if (m.agentId === entry.info.id && m !== live) this.settle(m);
    if (entry.currentMsg && !live) {
      entry.currentMsg = null;
      this.endedTurn(entry);
    }
  }

  private ensureAgentMsg(entry: AgentEntry): Message {
    if (!entry.currentMsg) {
      // A turn the CLI started itself: no prompt of ours to retry, unless
      // one is still waiting for its retry.
      if (entry.openingPrompt) entry.openingPrompt.replied = true;
      else if (!entry.retryPending) entry.lastEnvelope = undefined;
      entry.currentMsg = this.makeAgentMsg(entry.info.id);
      if (entry.openingPrompt?.input) entry.currentMsg.replyTo = entry.openingPrompt.input.id;
      entry.input?.replies.push(entry.currentMsg.id);
      this.pushMessage(entry.currentMsg);
    }
    return entry.currentMsg;
  }

  // Process subagent progress/done on a specific message (may differ from currentMsg
  // when events arrive after the originating message was finalized by a result event).
  private handleSubagentOnMsg(msg: Message, event: StreamEvent): void {
    if (!msg.events) msg.events = [];
    const taskId = event.subagent?.taskId;

    if (
      event.subagent?.events &&
      (event.kind === "subagent_enrichment" || event.kind === "subagent_done")
    ) {
      // A child's own Pi transcript does not contain host-observed nested jobs or monitors.
      const owner = msg.events.find(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === taskId,
      );
      const nested = owner?.subagent?.events?.filter(
        (e) =>
          e.subagent?.taskId.startsWith("pi-subagent-tree:") ||
          e.toolUseId?.startsWith("pi-host-step:"),
      );
      if (nested?.length)
        event = {
          ...event,
          subagent: { ...event.subagent, events: [...event.subagent.events, ...nested] },
        };
    }
    if (event.kind === "subagent_enrichment") {
      const patch = event.subagent;
      if (!patch) return;
      const revision = enrichSubagent(msg.events, patch);
      if (revision == null) return;
      // Keep the authoritative transcript on the server; open cards reload it.
      const { events, ...fields } = patch;
      event = {
        ...event,
        subagent: {
          ...fields,
          eventCount: events?.length ?? fields.eventCount,
          transcriptRevision: revision,
        },
      };
    } else if (event.kind === "subagent_progress") {
      const innerEvent = event.subagent?._innerEvent;
      const startIdx = msg.events.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === taskId,
      );

      if (innerEvent && startIdx >= 0) {
        const started = msg.events[startIdx].subagent!;
        const saEvents = (started.events ??= []);
        if (applyInnerEvent(saEvents, innerEvent)) {
          started.transcriptRevision = (started.transcriptRevision ?? 0) + 1;
          started.eventCount = saEvents.length;
          if (innerEvent.kind === "tool_use") {
            const tool =
              innerEvent.toolName ?? /^\*\*([^*]{1,80})\*\*/.exec(innerEvent.content)?.[1];
            if (tool) started.lastTool = tool;
          }
          // Detached descendants can still add detail after the parent settles.
          const done = msg.events.find(
            (e) => e.kind === "subagent_done" && e.subagent?.taskId === taskId,
          )?.subagent;
          if (done) {
            done.transcriptRevision = started.transcriptRevision;
            done.eventCount = started.eventCount;
            done.lastTool = started.lastTool;
          }
          this.streamed(msg, event);
        }
        return;
      }
      if (innerEvent) {
        // A carrier for a task whose start this message does not hold: not
        // renderable on its own, and pushing it made a phantom, permanently
        // running card. Drop it.
        return;
      }

      if (startIdx >= 0) {
        event.contentOffset = msg.events[startIdx].contentOffset;
        const started = msg.events[startIdx].subagent!;
        copySubagentExecution(started, event.subagent);
        if (
          event.subagent?.status != null &&
          (started.status == null || isOutstandingSubagentStatus(started.status))
        ) {
          started.status = event.subagent.status;
        }
      }
      const prev = msg.events.findIndex(
        (e) => e.kind === "subagent_progress" && e.subagent?.taskId === taskId,
      );
      if (prev >= 0) msg.events[prev] = event;
      else msg.events.push(event);
    } else if (event.kind === "subagent_done") {
      const startIdx = msg.events.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === taskId,
      );
      const finished = event.subagent;
      if (startIdx >= 0) {
        const start = msg.events[startIdx];
        event.contentOffset = start.contentOffset;
        const started = start.subagent!;
        copySubagentExecution(started, finished);
        if (finished?.events) {
          started.events = finished.events;
          started.eventCount = finished.events.length;
        }
        started.status = finished?.status;
        if (finished?.summary != null) started.summary = finished.summary;
        started.usage = finished?.usage;
        if (finished?.durationMs != null) started.durationMs = finished.durationMs;
      }
      if (finished) {
        const started = startIdx >= 0 ? msg.events[startIdx].subagent : undefined;
        const transcriptRevision =
          (started?.transcriptRevision ?? finished.transcriptRevision ?? 0) + 1;
        if (started) started.transcriptRevision = transcriptRevision;
        const { events, ...summary } = finished;
        event = {
          ...event,
          subagent: {
            ...summary,
            // Without a start this event itself owns the detail (legacy/orphan runs).
            ...(startIdx < 0 && { events }),
            eventCount:
              (events ?? started?.events)?.length ?? started?.eventCount ?? finished.eventCount,
            transcriptRevision,
          },
        };
      }
      const progIdx = msg.events.findIndex(
        (e) => e.kind === "subagent_progress" && e.subagent?.taskId === taskId,
      );
      if (progIdx >= 0) msg.events.splice(progIdx, 1);
      msg.events.push(event);
    }
    this.streamed(msg, event);
  }

  private findToolUseOwner(toolUseId: string, agentId?: string): Message | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (agentId != null && m.agentId !== agentId) continue;
      if (m.events?.some((e) => e.kind === "tool_use" && e.toolUseId === toolUseId)) return m;
    }
    return null;
  }

  private findSubagentOwner(taskId: string, agentId: string, includeDone: boolean): Message | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.agentId !== agentId) continue;
      if (
        m.events?.some(
          (e) =>
            (e.kind === "subagent_start" || (includeDone && e.kind === "subagent_done")) &&
            e.subagent?.taskId === taskId,
        )
      ) {
        return m;
      }
    }
    return null;
  }

  private updateLastContext(entry: AgentEntry, context: ContextUsage | null | undefined): number {
    entry.lastContext = context;
    entry.hasCachedContext = true;
    const revision = (entry.contextRevision ?? 0) + 1;
    entry.contextRevision = revision;
    this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
    return revision;
  }

  private recordTerminalContext(
    entry: AgentEntry,
    msg: Message,
    context: ContextUsage | null | undefined,
    pending?: Promise<ContextUsage | null>,
  ): void {
    if (context === undefined) return;
    msg.context = context;
    const revision = this.updateLastContext(entry, context);
    if (!pending) return;
    // Pi reads terminal stats without delaying settlement or queue delivery.
    void pending.then((reported) => {
      if (!reported || this.agents.get(entry.info.id) !== entry) return;
      if (!this.messagesLoaded && !this.cb?.ensureLoaded?.(this)) return;
      const stored = this.findMessage(msg.id);
      if (!stored) return;
      stored.context = reported;
      if (entry.contextRevision === revision) this.updateLastContext(entry, reported);
      this.finished(stored.id, stored.status, stored.content, stored.events, { context: reported });
    });
  }

  private createEventHandler(agentId: string) {
    return (
      event: StreamEvent,
      contextPending?: Promise<ContextUsage | null>,
      limit?: import("../session/pi-rate-limit").PiTurnLimit,
    ) => {
      const entry = this.agents.get(agentId);
      if (!entry) return;

      if (event.kind === "subagent_start" && event.toolUseId) {
        if (!this.messagesLoaded && !this.cb?.ensureLoaded?.(this)) return;
        const owner = this.findToolUseOwner(event.toolUseId, agentId);
        if (owner && owner !== entry.currentMsg) {
          const call = owner.events!.find(
            (e) => e.kind === "tool_use" && e.toolUseId === event.toolUseId,
          )!;
          const start = { ...event, contentOffset: call.contentOffset };
          owner.events!.push(start);
          this.streamed(owner, start);
          this.cb?.onSaveNow?.();
          return;
        }
      }

      // Route subagent events to the message containing their subagent_start,
      // even if that message was already finalized. This prevents orphaned
      // subagent entries from appearing in a new message bubble.
      const enrichment = event.kind === "subagent_enrichment";
      if (event.kind === "subagent_progress" || event.kind === "subagent_done" || enrichment) {
        if (
          !this.messagesLoaded &&
          (event.kind === "subagent_progress" || !this.cb?.ensureLoaded?.(this))
        )
          return;
        const taskId = event.subagent?.taskId;
        const owner = taskId && this.findSubagentOwner(taskId, agentId, enrichment);
        if (owner && (owner !== entry.currentMsg || enrichment)) {
          this.handleSubagentOnMsg(owner, event);
          if (enrichment || event.kind === "subagent_done") this.cb?.onSaveNow?.();
          return;
        }
        if (enrichment) return;
      }

      const batch = this.leadOutage?.agentId === agentId && this.leadOutage.batch;
      if (
        batch &&
        (entry.openingPrompt?.envelope.reportId === batch.id ||
          entry.activeReportId === batch.id) &&
        (event.kind === "tool_use" ||
          event.kind === "tool_result" ||
          event.kind === "subagent_start" ||
          ((event.kind === "text_delta" ||
            event.kind === "text" ||
            event.kind === "thinking_delta" ||
            event.kind === "thinking") &&
            event.content.length > 0))
      )
        batch.progress = true;
      if (event.kind === "thinking_tokens" && !entry.currentMsg) return;
      // Pi can report an option reset before writing the prompt. It is not
      // output from the turn, and the prompt may be handled without a turn.
      if (
        event.kind === "notice" &&
        entry.openingPrompt &&
        event.level === "warning" &&
        entry.session.getState().config.backend === "pi" &&
        !entry.openingPrompt.writeClaimed
      ) {
        this.pushSystemMessage(event.content);
        return;
      }
      if (event.kind === "retry" && !event.content) {
        if (entry.currentMsg && clearRetry(entry.currentMsg))
          this.streamed(entry.currentMsg, event);
        return;
      }
      if (entry.currentMsg && RETRY_PROGRESS_KINDS.has(event.kind)) clearRetry(entry.currentMsg);

      // Nothing in flight: a late tool result belongs to the call that
      // made it, and a banner (CLI notice, post-turn compaction, hook
      // failure) is a system line — opening an agent bubble for either left
      // a "streaming" message nothing would ever finish.
      if (!entry.currentMsg && !entry.session.isRunning) {
        if (event.kind === "tool_result" && event.toolUseId) {
          const owner = this.findToolUseOwner(event.toolUseId);
          if (owner) {
            const call = owner.events!.find(
              (e) => e.kind === "tool_use" && e.toolUseId === event.toolUseId,
            )!;
            call.toolResult = event.content;
            if (event.isMarkdown) call.toolResultIsMarkdown = true;
            if (event.isError) call.toolResultIsError = true;
            if (event.durationMs != null) call.durationMs = event.durationMs;
            this.streamed(owner, event);
            this.finished(owner.id, owner.status, owner.content, owner.events);
            return;
          }
          return;
        }
        if (event.kind === "notice" || event.kind === "compact" || event.kind === "retry") {
          if (event.kind === "compact" && event.context !== undefined) {
            this.updateLastContext(entry, event.context);
            this.pushSystemMessage(event.content, {
              agentId,
              events: [event],
              context: event.context,
            });
            return;
          }
          this.pushSystemMessage(event.content);
          return;
        }
        // A card update whose card is in no loaded message (see above).
        if (event.kind === "subagent_progress" || event.kind === "subagent_done") return;
        // A task no turn of ours started: its card gets a reply of its own,
        // finished at once; its updates find it like any finished card's.
        if (event.kind === "subagent_start") {
          const msg = this.makeAgentMsg(agentId);
          this.pushMessage(msg);
          event.contentOffset = 0;
          msg.events!.push(event);
          this.streamed(msg, event);
          this.settle(msg);
          return;
        }
      }

      if (
        !entry.currentMsg &&
        event.kind !== "result" &&
        event.kind !== "error" &&
        event.kind !== "compact"
      ) {
        this.beganTurn(entry);
      }

      if (event.kind === "text_delta") {
        const msg = this.ensureAgentMsg(entry);
        msg.content += event.content;
        this.streamed(msg, event);
      } else if (event.kind === "thinking_delta") {
        // Live only: relayed so the client can show thinking as it streams;
        // the finished block arrives as a "thinking" event and is what stays.
        const msg = this.ensureAgentMsg(entry);
        this.streamed(msg, event);
      } else if (event.kind === "thinking_tokens") {
        const msg = entry.currentMsg;
        if (!msg) return;
        const block = lastThinking(msg.events!);
        if (block && block.tokens == null) block.tokens = event.tokens;
        this.streamed(msg, event);
      } else if (event.kind === "text") {
        // text comes via text_delta streaming; finalized text event is redundant
      } else if (event.kind === "result") {
        // A fast Codex turn can finish before the turn/start promise resumes.
        // Its terminal event still proves a turn ran, even without output.
        if (
          !entry.currentMsg &&
          entry.openingPrompt &&
          entry.session.getState().config.backend === "codex"
        )
          this.ensureAgentMsg(entry);
        if (event.interrupted && entry.input) entry.input.stopped = "user";
        if (entry.currentMsg) {
          if (!event.interrupted && (concludingText(entry.currentMsg) || entry.input?.finished)) {
            this.recordResult("done");
          }
          // Defense in depth: a turn that ends with neither text nor any
          // visible event is a failure (CLI crash, network drop, spawn
          // problem) — render a diagnostic instead of a silent empty bubble.
          if (event.interrupted) {
            entry.currentMsg.content = withInterrupted(entry.currentMsg.content);
          } else if (!entry.currentMsg.content.trim() && !(entry.currentMsg.events ?? []).length) {
            entry.currentMsg.content =
              "*(no output — the session ended without producing anything; check network/credentials or server logs)*";
          }
          entry.currentMsg.status = "done";
          clearLiveTiming(entry.currentMsg);
          // The retry succeeded; "API retry 2/10 in 5s" is no longer true.
          clearRetry(entry.currentMsg);
          this.recordTerminalContext(entry, entry.currentMsg, event.context, contextPending);
          if (event.effort) entry.currentMsg.effort = event.effort;
          if (event.thinking) entry.currentMsg.thinking = event.thinking;
          const contextPatch = entry.currentMsg.context;
          const patch = {
            ...(contextPatch !== undefined && { context: contextPatch }),
            ...(event.effort && { effort: event.effort }),
            ...(event.thinking && { thinking: event.thinking }),
          };
          this.finished(
            entry.currentMsg.id,
            "done",
            entry.currentMsg.content,
            entry.currentMsg.events,
            Object.keys(patch).length ? patch : undefined,
          );
          this.cb?.onLeadTerminal?.(
            this,
            entry.info.id,
            entry.currentMsg,
            !!event.interrupted,
            true,
          );
          // A turn the model answered while a retry waits (a wake-up, a
          // task's report): the limit is over. That turn saw the cut prompt,
          // so the retry carries on rather than sending it again, and now.
          if (entry.retryPending && answered(entry.currentMsg)) {
            entry.lastEnvelope = undefined;
            entry.pausedUntil = Date.now();
          }
        }
        this.finishReply(entry);
        if (event.interrupted && this.projectLink?.role === "worker") this.cb?.onSaveNow?.();
      } else if (event.kind === "error") {
        // The error is an event (rendered as a red banner where it
        // happened); appending it to the text as well showed it twice.
        // A late process diagnostic after an already settled turn is not
        // another failed turn. A usage-limit error awaiting retry is not final.
        const activeTurn =
          entry.currentMsg ||
          (entry.openingPrompt ? !entry.openingPrompt.replied : entry.lastStreamAt != null);
        const input = entry.input;
        const msg = this.ensureAgentMsg(entry);
        const from = input && this.findMessage(input.id)?.from;
        // Classify before the server announces and persists the recovery mode.
        // The refusal remains in the transcript; only its exact final span is
        // omitted from the progress check. Tools/thinking and earlier text count.
        const confirmed =
          limit && limit.resetsAt * 1000 > Date.now() && this.isWritable() && !input?.stopped;
        if (confirmed) {
          const before =
            limit.refusalText && msg.content.endsWith(limit.refusalText)
              ? msg.content.slice(0, -limit.refusalText.length)
              : msg.content;
          if (answered(msg, before)) entry.lastEnvelope = undefined;
        }
        const failedWorkerTurn =
          activeTurn &&
          input &&
          !input.stopped &&
          !confirmed &&
          !entry.retryPending &&
          this.projectLink?.role === "worker" &&
          !this.projectLink.unreported &&
          (from?.role === "lead" || from?.role === "panel");
        if (failedWorkerTurn) {
          (entry.pendingTurnFailures ??= []).push({ inputId: input.id, replyId: msg.id });
        }
        clearRetry(msg);
        // The model saw the prompt a waiting retry would send: it carries on.
        if (!confirmed && entry.retryPending && answered(msg)) entry.lastEnvelope = undefined;
        msg.status = "error";
        this.recordResult("failed");
        clearLiveTiming(msg);
        this.recordTerminalContext(entry, msg, event.context, contextPending);
        event.contentOffset = msg.content.length;
        msg.events!.push(event);
        this.touch([msg.id]);
        if (confirmed)
          this.cb?.onRateLimit?.(this.id, agentId, { resetsAt: limit.resetsAt, turnFinal: true });
        this.streamed(msg, event);
        this.finished(
          msg.id,
          "error",
          msg.content,
          msg.events,
          msg.context !== undefined ? { context: msg.context } : undefined,
        );
        this.cb?.onLeadTerminal?.(this, entry.info.id, msg, false, !!activeTurn && !confirmed);
        this.finishReply(entry);
        if (failedWorkerTurn) this.cb?.onSaveNow?.();
      } else if (event.kind === "subagent_progress" || event.kind === "subagent_done") {
        const msg = this.ensureAgentMsg(entry);
        this.handleSubagentOnMsg(msg, event);
      } else if (event.kind === "retry") {
        // One retry banner per turn, updated in place.
        const msg = this.ensureAgentMsg(entry);
        const prev = msg.events!.findIndex((e) => e.kind === "retry");
        if (prev >= 0) {
          event.contentOffset = msg.events![prev].contentOffset;
          msg.events![prev] = event;
        } else {
          event.contentOffset = msg.content.length;
          msg.events!.push(event);
        }
        this.streamed(msg, event);
      } else if (event.kind === "tool_result" && event.toolUseId) {
        const msg = this.ensureAgentMsg(entry);
        const matchIdx = msg.events!.findIndex(
          (e) => e.kind === "tool_use" && e.toolUseId === event.toolUseId,
        );
        // A call an earlier reply of the turn made (a steered message
        // started a new one while it ran).
        const owner = matchIdx < 0 ? this.findToolUseOwner(event.toolUseId) : null;
        if (owner && owner !== msg) {
          const call = owner.events!.find(
            (e) => e.kind === "tool_use" && e.toolUseId === event.toolUseId,
          )!;
          call.toolResult = event.content;
          if (event.isMarkdown) call.toolResultIsMarkdown = true;
          if (event.isError) call.toolResultIsError = true;
          if (event.durationMs != null) call.durationMs = event.durationMs;
          this.streamed(owner, event);
          this.finished(owner.id, owner.status, owner.content, owner.events);
          return;
        }
        if (matchIdx >= 0) {
          msg.events![matchIdx].toolResult = event.content;
          if (event.isMarkdown) msg.events![matchIdx].toolResultIsMarkdown = true;
          if (event.isError) msg.events![matchIdx].toolResultIsError = true;
          if (event.durationMs != null) msg.events![matchIdx].durationMs = event.durationMs;
        } else {
          event.contentOffset = msg.content.length;
          msg.events!.push(event);
        }
        this.streamed(msg, event);
      } else {
        const msg = this.ensureAgentMsg(entry);
        event.contentOffset =
          event.contentOffset != null && Number.isFinite(event.contentOffset)
            ? Math.min(Math.max(0, event.contentOffset), msg.content.length)
            : msg.content.length;
        msg.events!.push(event);
        if (event.kind === "compact" && event.context !== undefined) {
          msg.context = event.context;
          this.updateLastContext(entry, event.context);
        }
        this.streamed(msg, event);
      }
    };
  }

  private finishReply(entry: AgentEntry): void {
    entry.currentMsg = null;
    // A terminal event can arrive before send() has resolved. Leave the
    // input fenced until its receipt arrives, then notify idle after settlement.
    if (entry.openingPrompt?.input) return;
    if (entry.session.getState().config.backend === "codex") this.settleActiveReport(entry);
    entry.openingPrompt = undefined;
    this.endedTurn(entry);
    setTimeout(() => this.afterTurn(entry.info.id), 0);
  }

  addAgent(
    name: string,
    model: string,
    avatar: string,
    color: string,
    config: Partial<SessionConfig>,
    account?: string,
  ): AgentInfo {
    const host = this.hostRegistry.get(this.hostId);
    if (!host) throw new Error(`Host not found: ${this.hostId}`);
    if (!host.connected) throw new Error(`Host not connected: ${this.hostId}`);

    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isDefault = this.agents.size === 0;

    const info: AgentInfo = { id, name, model, avatar, color, isDefault, account };
    const session = host.createSession(id, {
      cwd: this.cwd,
      model,
      ...config,
      ...this.sessionStorage(),
    });
    const handler = this.attachSession(id, session);

    this.agents.set(id, { info, session, handler, currentMsg: null });
    this.pushSystemMessage(`${avatar} **${name}** joined the team`);
    return info;
  }

  private attachSession(agentId: string, session: HostSessionHandle): (e: StreamEvent) => void {
    const handler = this.createEventHandler(agentId);
    session.on("event", handler);
    session.on("commands", (cmds: CommandInfo[]) => {
      this.cb?.onCommandsUpdate?.(agentId, cmds);
      this.cb?.onSessionCapabilities?.(this.id, agentId);
    });
    const updateAgent = (transient: boolean) => {
      const entry = this.agents.get(agentId);
      if (entry) this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), transient);
    };
    session.on("thinking_levels", () => updateAgent(true));
    session.on("effort_preset_cleared", () => updateAgent(false));
    session.on("session_checkpoint", () => {
      if (!this.agents.get(agentId)?.recoveringDispatching) this.cb?.onSaveNow?.();
    });
    // A first-input disk proof is durable recovery state, not turn completion.
    // Save it even while a report recovery probe owns the dispatch fence.
    session.on("session_anchor", () => this.cb?.onSaveNow?.());
    session.on("user_message_accepted", (event: { inputId: string }) => {
      const entry = this.agents.get(agentId);
      if (entry) this.acceptDispatch(entry, event.inputId, true);
    });
    session.on("prompt_outcome_unknown", (event: { inputId: string; reason: string }) => {
      const entry = this.agents.get(agentId);
      const msg = entry?.openingPrompt?.input;
      if (
        entry &&
        msg &&
        msg.status === "dispatching" &&
        msg.queuedEnvelope?.inputId === event.inputId
      ) {
        this.failDispatch(entry, msg, "outcome_unknown", event.reason);
      }
    });
    session.on("agent_settled", (event: { inputId?: string }) => {
      const entry = this.agents.get(agentId);
      if (!entry) return;
      this.acceptDispatch(entry, event.inputId);
      this.settleActiveReport(entry);
    });
    session.on("extension_ui", ({ processGeneration, change }: ExtensionUiEvent) => {
      const entry = this.agents.get(agentId);
      if (
        !entry ||
        entry.session !== session ||
        processGeneration < (entry.extensionUi?.processGeneration ?? 0)
      )
        return;
      const event = { workspaceId: this.id, agentId, processGeneration, change };
      entry.extensionUi = applyExtensionUi(entry.extensionUi, event);
      this.cb?.onExtensionUi?.(event);
    });
    session.on("ui_dialog_request", (dialog: UiDialogRequest) => {
      this.pendingDialogs.set(
        dialogKey(agentId, dialog.processGeneration, dialog.requestId),
        dialog,
      );
      this.cb?.onUiDialogRequest?.(dialog);
    });
    session.on("ui_dialog_resolved", (dialog: UiDialogRequest) => {
      if (
        !this.pendingDialogs.delete(dialogKey(agentId, dialog.processGeneration, dialog.requestId))
      )
        return;
      this.cb?.onUiDialogResolved?.({
        workspaceId: this.id,
        agentId,
        processGeneration: dialog.processGeneration,
        requestId: dialog.requestId,
      });
    });
    session.on("rateLimit", (info: { rateLimitType?: string; resetsAt?: number }) => {
      this.cb?.onRateLimit?.(this.id, agentId, info);
    });
    session.setBoundarySteerSource?.(() => this.nextBoundarySteer(agentId, session));
    session.on("steered", (inputId: string) => this.steered(agentId, inputId));
    session.on("unread", (ids: string[]) => this.unread(ids));
    session.on("deploy_activity", () => this.cb?.onDeployActivity?.());
    session.on("backgroundTasks", () => {
      if (session.runState === "waiting") this.cb?.onDeployActivity?.();
      this.cb?.onSaveNow?.();
      const entry = this.agents.get(agentId);
      if (entry) this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
    });
    session.on("wake", () => {
      const entry = this.agents.get(agentId);
      if (entry) this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
    });
    session.on("wakeDue", () => this.dequeueNext(agentId));
    session.on("runState", (state: RunState) => {
      const entry = this.agents.get(agentId);
      if (entry) {
        entry.runState = state;
        if (state === "working") entry.lastStreamAt ??= Date.now();
        else entry.lastStreamAt = undefined;
      }
      if (entry?.input) {
        if (state === "working") delete entry.input.stopped;
        if (state === "waiting" || state === "sleeping") entry.input.waiting = true;
        else delete entry.input.waiting;
      }
      if (state !== "idle") this.cb?.onDeployActivity?.();
      this.cb?.onAgentState?.(this.id, agentId, state);
      // The pending wake-up (and its time) comes and goes with the state.
      if (entry) this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
      // A turn a session's abort ended has no terminal event; this is the
      // one signal that the queue may move.
      if (state === "idle") setTimeout(() => this.dequeueNext(agentId), 0);
    });
    session.on("activity", (activity: string | null) => {
      const entry = this.agents.get(agentId);
      if (entry) entry.activity = activity;
      this.cb?.onAgentActivity?.(this.id, agentId, activity);
    });
    session.on("unhandled", (msg: unknown) => {
      this.cb?.onUnhandled?.(this.id, agentId, msg);
    });
    return handler;
  }

  private readonly retiredReportAgents = new Map<string, Promise<void>>();

  // Returns the ids of messages dropped with the agent; null if absent.
  removeAgent(agentId: string): string[] | null {
    const entry = this.agents.get(agentId);
    if (!entry) return null;

    const opening = entry.openingPrompt;
    if (opening?.envelope.reportId && opening.input) {
      entry.openingPrompt = undefined;
      if (!opening.writeClaimed) this.requeueReport(opening.input);
    } else {
      this.cancelOpeningPrompt(entry, "Agent removed");
    }
    const cleanup = this.releaseSession(agentId, entry);
    if (
      this.messages.some(
        (m) => m.queuedFor === agentId && m.status === "dispatching" && m.dispatchAttempt?.reportId,
      )
    ) {
      this.retiredReportAgents.set(agentId, cleanup);
      void cleanup.finally(() => this.retiredReportAgents.delete(agentId)).catch(() => {});
    }
    this.finalizeAbort(entry, false);
    this.agents.delete(agentId);
    this.cb?.onCommandsUpdate?.(agentId, []);

    if (entry.info.isDefault && this.agents.size > 0) {
      const first = this.agents.values().next().value!;
      first.info.isDefault = true;
    }
    // What another session sent waits for the agent that takes over; the
    // sender was told it was queued and expects an answer.
    const heir = this.resolveAgent();
    const queued = this.messages.filter((m) => m.status === "queued" && m.queuedFor === agentId);
    for (const m of queued) {
      if (heir && m.from) m.queuedFor = heir.info.id;
      else if (m.queuedEnvelope?.reportId) delete m.queuedFor;
      else continue;
      delete m.steering;
      this.finished(m.id, m.status, m.content);
    }
    const dropped = queued.filter((m) => m.queuedFor === agentId).map((m) => m.id);
    this.messages = this.messages.filter((m) => !dropped.includes(m.id));
    if (heir && dropped.length < queued.length) {
      setTimeout(() => this.dequeueNext(heir.info.id), 0);
    }

    this.pushSystemMessage(`${entry.info.avatar} **${entry.info.name}** left the team`);
    return dropped;
  }

  // Stopped first, detached after: stopping closes the agent's open cards
  // through its own events.
  private releaseSession(agentId: string, entry: AgentEntry): Promise<void> {
    const cleanup = (async () => {
      const host = this.hostRegistry.get(this.hostId);
      if (host) await host.destroySession(agentId);
      else if (entry.session.dispose) await entry.session.dispose();
      else entry.session.abort();
      entry.session.removeAllListeners();
    })();
    return this.cb?.trackCleanup?.(cleanup) ?? cleanup;
  }

  // The workspace is being deleted: stop every session and let the host
  // forget it, without starting anything still queued.
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      [...this.agents].map(([agentId, entry]) => this.releaseSession(agentId, entry)),
    );
    this.agents.clear();
  }

  setDefaultAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;

    for (const a of this.agents.values()) {
      a.info.isDefault = a.info.id === agentId;
    }
    return true;
  }

  resolveAgent(target?: string): AgentEntry | null {
    if (target) {
      for (const entry of this.agents.values()) {
        if (entry.info.id === target || entry.info.name === target) {
          return entry;
        }
      }
      return null;
    }
    for (const entry of this.agents.values()) {
      if (entry.info.isDefault) return entry;
    }
    const first = this.agents.values().next();
    return first.done ? null : first.value;
  }

  // A slash command handled here answers locally (string), rewrites the
  // prompt that goes to the agent ({ forward }), or is not ours (null).
  private tryHandleCommand(text: string, agent: AgentEntry): CommandOutcome | Promise<string> {
    if (text === "/usage" || text === "/cost") {
      return (
        agent.session
          .getUsageInfo?.()
          .then((data) => (data ? formatUsageInfo(data) : NO_ACTIVE_SESSION)) ?? NO_ACTIVE_SESSION
      );
    }
    if (text === "/context") {
      return formatContextUsage(this.lastContext(agent), agent.info.model);
    }
    if (text === "/effort" || text.startsWith("/effort ")) {
      return this.handleEffortCommand(text.slice("/effort".length).trim(), agent);
    }
    if (text === "/model" || text.startsWith("/model ")) {
      return this.handleModelCommand(text.slice("/model".length).trim(), agent);
    }
    if (text === "/fast" || text.startsWith("/fast ")) {
      return this.handleFastCommand(text.slice("/fast".length).trim(), agent);
    }
    if (text === "/goal" || text.startsWith("/goal ")) {
      return this.handleGoalCommand(text.slice("/goal".length).trim(), agent);
    }
    return null;
  }

  private handleFastCommand(arg: string, agent: AgentEntry): string {
    const model = agent.info.model;
    const name = agent.info.name;
    if (!supportsFastMode(model) || !agent.session.setFastMode) {
      return `**${name}** (${model}) does not support fast mode.`;
    }
    const current = Boolean(agent.session.getState().config.fast);
    const want = arg === "" ? !current : arg.toLowerCase();
    if (want !== true && want !== false && want !== "on" && want !== "off") {
      return `Usage: \`/fast [on|off]\` — fast mode for **${name}** is currently **${current ? "on" : "off"}**.`;
    }
    const on = want === true || want === "on";
    if (on === current) {
      return `Fast mode for **${name}** is already **${on ? "on" : "off"}**.`;
    }
    agent.session.setFastMode(on);
    this.cb?.onAgentUpdated?.(this.id, this.agentInfo(agent));
    const cost = on ? " Faster responses at higher usage." : "";
    return `Fast mode for **${name}** turned **${on ? "on" : "off"}**.${cost} ${this.appliesWhen(agent)}`;
  }

  private handleGoalCommand(_arg: string, _agent: AgentEntry): CommandOutcome {
    return "/goal is disabled.";
  }

  private canSwitchBackend(agent: AgentEntry, state: SessionState): boolean {
    return (
      this.messagesLoaded &&
      !!this.hostRegistry.get(this.hostId)?.replaceSession &&
      (state.config.backend === "codex" || state.config.backend === "pi") &&
      this.agentState(agent) === "idle" &&
      !this.dispatchHeld(agent) &&
      !this.held(agent) &&
      !agent.currentMsg &&
      !agent.input &&
      !agent.delivered &&
      !state.sessionId &&
      !state.sessionFile &&
      !state.hasUnanchoredInput &&
      !state.persistedSessionAnchor &&
      !state.hasConfirmedTurns &&
      !state.usage.turns &&
      !this.messages.some(
        (m, index) =>
          m.queuedFor === agent.info.id ||
          (m.kind === "agent" &&
            m.agentId === agent.info.id &&
            !m.localCommand &&
            !isLegacyLocalCommandReply(this.messages[index - 1], m)),
      )
    );
  }

  private handleModelCommand(arg: string, agent: AgentEntry): string {
    const { name, model: current } = agent.info;
    const state = agent.session.getState();
    const backend =
      state.config.backend === "pi" || state.config.backend === "codex"
        ? state.config.backend
        : backendForModel(current);
    const canSwitchBackend = this.canSwitchBackend(agent, state);
    const catalog: ModelOption[] = this.cb?.modelOptions?.() ?? [
      ...MODEL_OPTIONS,
      ...(agent.session.getAvailableModels?.() ?? [])
        .filter((m) => !MODEL_OPTIONS.some((preset) => preset.id === m.id))
        .map((m) => ({ id: m.id, label: m.name ?? m.id, backend: "pi" as const })),
    ];
    const choices = canSwitchBackend ? catalog : catalog.filter((m) => m.backend === backend);
    const label = (id: string) => choices.find((m) => m.id === id)?.label ?? id;
    if (!arg) {
      return [
        `**${name}** runs on **${label(current)}** (\`${current}\`).`,
        `Available: ${choices.map((m) => (m.id === current ? `**${m.id}**` : `\`${m.id}\``)).join(" · ")}`,
        "",
        canSwitchBackend
          ? "Use `/model <id>` to switch, including to another backend before the first turn."
          : "Use `/model <id>` to switch; the conversation carries over.",
      ].join("\n");
    }
    const next = arg;
    if (next === current) return `**${name}** already runs on **${label(current)}**.`;
    const target = catalog.find((m) => m.id === next);
    const nextBackend = target?.backend ?? backendForModel(next);
    const crossesBackend = backend !== nextBackend;
    if (crossesBackend && !canSwitchBackend) {
      const [kind, of] = {
        pi: ["Pi session", "Pi"],
        codex: ["Codex thread", "Codex"],
      }[backend];
      return `**${name}** cannot move to \`${next}\`: a ${kind} continues only on a ${of} model.`;
    }
    if (crossesBackend && !target) return `\`${next}\` is not in the model list.`;
    if (!crossesBackend && !agent.session.setModel) {
      return `**${name}** cannot switch models; add an agent on \`${next}\` instead.`;
    }

    const declared = crossesBackend
      ? effortLevelsForModel(next, catalog)
      : this.effortLevels(agent, next);
    const effort = state.config.effort;
    const fallback = target?.effort ?? target?.defaultEffort ?? defaultEffortForModel(next);
    const keep =
      effort && declared?.includes(effort)
        ? effort
        : fallback && declared?.includes(fallback) !== false
          ? fallback
          : undefined;
    const fast = Boolean(state.config.fast) && supportsFastMode(next);
    if (crossesBackend) {
      const host = this.hostRegistry.get(this.hostId);
      if (!host?.connected || !host.replaceSession) return `Host not connected: ${this.hostId}`;
      const session = host.replaceSession(agent.info.id, {
        ...state.config,
        ...(nextBackend === "pi" && this.cb?.piConfig?.()),
        backend: nextBackend,
        model: next,
        effort: keep,
        fast,
        ...this.sessionStorage(),
      });
      agent.session = session;
      agent.handler = this.attachSession(agent.info.id, session);
      agent.runState = undefined;
      agent.activity = undefined;
      this.cb?.onSessionReplaced?.(this, session);
      this.cb?.onCommandsUpdate?.(agent.info.id, session.getCommands?.() ?? []);
    } else {
      agent.session.setModel!(next, keep, fast);
    }
    agent.info.model = next;
    this.cb?.onAgentUpdated?.(this.id, this.agentInfo(agent));
    const known = choices.some((m) => m.id === next);
    return [
      `**${name}** moves from ${label(current)} to **${label(next)}**${crossesBackend ? "." : "; the conversation carries over."} ${this.appliesWhen(agent)}`,
      ...(known
        ? []
        : [
            "",
            `\`${next}\` is not in the model list: if the CLI does not know it, the next turn fails.`,
          ]),
    ].join("\n");
  }

  private effortLevels(agent: AgentEntry, model: string) {
    return (
      agent.session.getAvailableThinkingLevels?.(model) ??
      effortLevelsForModel(model, this.cb?.modelOptions?.())
    );
  }

  private handleEffortCommand(arg: string, agent: AgentEntry): string {
    const model = agent.info.model;
    const levels = this.effortLevels(agent, model);
    if (!levels) return `Effort levels for ${model} are not yet known.`;
    if (levels.length === 0) {
      return `**${agent.info.name}** (${model}) does not support effort levels.`;
    }

    const current = agent.session.getState().config.effort;
    const levelList = levels.map((l) => (l === current ? `**${l}**` : `\`${l}\``)).join(" · ");

    if (!arg) {
      return [
        `**${agent.info.name}** (${model})`,
        `Effort: ${current ?? "*(default)*"}`,
        `Available: ${levelList}`,
        "",
        "Use `/effort <level>` to change it.",
      ].join("\n");
    }

    const level = arg.toLowerCase();
    if (!levels.includes(level)) {
      return `Invalid effort level \`${arg}\` for ${model}. Available: ${levelList}`;
    }
    if (level === current) {
      return `Effort for **${agent.info.name}** is already **${level}**.`;
    }
    if (!agent.session.setEffort) {
      return `**${agent.info.name}** does not support changing the effort level.`;
    }

    agent.session.setEffort(level);
    this.cb?.onAgentUpdated?.(this.id, this.agentInfo(agent));
    return `Effort for **${agent.info.name}** set to **${level}**${current ? ` (was ${current})` : ""}. ${this.appliesWhen(agent)}`;
  }

  private appliesWhen(agent: AgentEntry): string {
    const state = this.agentState(agent);
    return agent.session.optionsPending && (state === "waiting" || state === "sleeping")
      ? `Applies once **${agent.info.name}** has no background work or pending wake-up.`
      : "Applies from the next message.";
  }

  async sendMessage(
    content: string,
    target?: string,
    images?: Array<{ name: string; url: string; path: string }>,
    quote?: { messageId: string; agentId: string | null; content: string },
    onAccepted?: () => void,
  ): Promise<void> {
    this.assertWritable();
    let resolvedTarget = target;
    let cleanContent = content;
    const mentionMatch = content.match(/(?:^|\s)@(\S+)/);
    if (mentionMatch) {
      if (!resolvedTarget) resolvedTarget = mentionMatch[1];
      cleanContent = content.replace(/(?:^|\s)@\S+\s*/, " ").trim();
    }

    const agent = this.resolveAgent(resolvedTarget);
    if (!agent)
      throw new Error(resolvedTarget ? `Agent not found: ${resolvedTarget}` : "No default agent");

    // A prompt must enter the queue before a later /model can test for an empty session.
    const command = this.tryHandleCommand(cleanContent.trim(), agent);
    let cmdResult = command instanceof Promise ? await command : command;
    if (cmdResult !== null && typeof cmdResult !== "string") {
      cleanContent = cmdResult.forward;
      cmdResult = null;
    }
    if (cmdResult !== null) {
      const userMsg: Message = {
        id: genId("msg"),
        kind: "user",
        agentId: null,
        content,
        timestamp: Date.now(),
        status: "done",
      };
      this.pushMessage(userMsg);

      const agentMsg = this.makeAgentMsg(agent.info.id);
      agentMsg.content = cmdResult;
      agentMsg.status = "done";
      agentMsg.localCommand = true;
      clearLiveTiming(agentMsg);
      this.pushMessage(agentMsg);
      this.finished(agentMsg.id, "done", cmdResult);
      const text = cleanContent.trim();
      if (/^\/fast(?: |$)|^\/(?:model|effort) +\S/.test(text)) this.cb?.onSaveNow?.();
      onAccepted?.();
      return;
    }

    const msgImages = images?.map(({ name, url }) => ({ name, url }));

    let forwardRef: ForwardRef | undefined;
    if (quote) {
      const author = this.authorOf(
        this.messages.find((m) => m.id === quote.messageId) ?? { agentId: quote.agentId },
      );
      const preview = quote.content.slice(0, 120) + (quote.content.length > 120 ? "..." : "");
      forwardRef = {
        messageId: quote.messageId,
        fromAgent: author.name,
        fromAvatar: author.avatar,
        preview,
      };
    }

    let prompt = cleanContent;
    if (quote) {
      const quotedFrom = forwardRef?.fromAgent ?? "Unknown";
      prompt = `[Quoted from ${quotedFrom}]:\n${quote.content}\n\n${prompt}`;
    }
    const pi = agent.session.getState().config.backend === "pi";
    const attachmentIds = pi ? images?.map((img) => path.basename(img.url)) : undefined;
    if (attachmentIds?.length)
      validatePiAttachments(
        this.storage?.uploadsDir ?? agent.session.getState().config.uploadsDir,
        attachmentIds,
      );
    if (!pi && images?.length) {
      const refs = images.map((img) => img.path).join("\n");
      prompt = `[User attached image(s). Use the Read tool to view:\n${refs}]\n\n${prompt || "Please look at the attached image(s)."}`;
    }

    // A busy agent queues the message instead of rejecting it; the queue
    // drains in order whenever the agent becomes idle. A pending rate-limit
    // retry goes first: the user writing is the cue to try now. A carry-on
    // would only hold their message up: it goes in its place.
    if (!agent.lastEnvelope) this.dropRetry(agent);
    const retried = agent.retryPending && !agent.session.isRunning && this.retryLast(agent.info.id);
    // Leave backend slash handling intact, including cold Pi extension commands
    // whose names may not be available yet and /compact's separate RPC.
    const admission = this.cb?.prepareManualInput?.(
      this,
      agent.info.id,
      !cleanContent.trimStart().startsWith("/"),
    );
    const paired = admission?.panelContext;
    const busy =
      retried || this.dispatchHeld(agent) || this.held(agent) || this.hasQueued(agent, !!paired);
    const steering = !paired && !this.leadOutage && busy && !retried && this.steerable(agent);
    const userMsg: Message = {
      id: genId("msg"),
      kind: "user",
      agentId: null,
      content,
      timestamp: Date.now(),
      status: busy ? "queued" : "starting",
      images: msgImages?.length ? msgImages : undefined,
      forwardRef,
      queuedFor: agent.info.id,
      ...(steering && { steering: true }),
    };
    this.enqueueManualInput(
      userMsg,
      { inputId: userMsg.id, text: prompt, attachmentIds },
      admission,
    );
    if (steering) {
      const steeringPrompt = this.steer(agent, userMsg);
      onAccepted?.();
      await steeringPrompt;
      return;
    }
    if (busy) {
      onAccepted?.();
      return;
    }

    const dispatching = this.dispatchPrompt(agent, userMsg.queuedEnvelope!, userMsg);
    onAccepted?.();
    await dispatching;
  }

  // Whether a message for the agent now goes into its running turn: the
  // backend takes one mid-turn (Codex), and neither messages waiting ahead
  // nor a rate limit hold the queue. Decided before the message is shown,
  // so clients know it from the start (no cancelling it).
  private steerable(agent: AgentEntry): boolean {
    return (
      !!agent.session.steer &&
      agent.session.isRunning &&
      agent.session.canSteer !== false &&
      !this.held(agent) &&
      !this.messages.some(
        (m) => m.status === "queued" && m.queuedFor === agent.info.id && !m.steering,
      )
    );
  }

  private nextBoundarySteer(
    agentId: string,
    session: HostSessionHandle,
  ): BoundarySteer | undefined {
    const entry = this.agents.get(agentId);
    const available = () =>
      entry &&
      this.agents.get(agentId)?.session === session &&
      this.isWritable() &&
      this.cb?.canDequeue?.() !== false &&
      !this.leadOutage &&
      !this.held(entry) &&
      !entry.openingPrompt &&
      !entry.recoveringDispatching;
    if (!available()) return;
    const msg = this.messages.find(
      (item) => item.queuedFor === agentId && item.status === "queued",
    );
    const envelope = msg?.queuedEnvelope;
    if (
      !msg ||
      !envelope ||
      envelope.reportId ||
      envelope.panelContext !== undefined ||
      envelope.text.trimStart().startsWith("/")
    )
      return;
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    return {
      envelope: { ...envelope, trigger: inputTrigger(msg) },
      claim: () => {
        if (
          !available() ||
          msg.status !== "queued" ||
          msg.queuedFor !== agentId ||
          !this.messages.includes(msg)
        )
          return false;
        // Commit before the RPC write. Restart recovery already treats dispatching as non-replayable.
        msg.status = "dispatching";
        this.touch([msg.id]);
        try {
          this.cb?.onSaveNow?.();
        } catch (error) {
          msg.status = "queued";
          throw error;
        }
        this.finished(msg.id, msg.status, msg.content);
        deliveryTimer = this.revealPendingDelivery(msg, available);
        return true;
      },
      finish: (outcome) => {
        clearTimeout(deliveryTimer);
        if (msg.status !== "dispatching") return;
        if (outcome === "rejected") {
          msg.status = "queued";
          delete msg.pendingDelivery;
          this.finished(msg.id, msg.status, msg.content);
        } else if (outcome === "read") this.steered(agentId, msg.id);
        else this.completeDispatch(msg, outcome === "handled" ? "done" : outcome);
      },
    };
  }

  // A message handed to the running turn stays queued until the model reads
  // it (steered); not taken, it waits like any other.
  private async steer(agent: AgentEntry, msg: Message): Promise<void> {
    const taken = await agent.session.steer!(
      msg.queuedEnvelope?.text ?? msg.content,
      msg.id,
      inputTrigger(msg),
    ).catch(() => false);
    // Given back meanwhile (unread) when the turn ended under the request.
    if (taken || !msg.steering) return;
    delete msg.steering;
    this.finished(msg.id, msg.status, msg.content);
    this.dequeueNext(agent.info.id);
  }

  // The model read a steered message: what follows answers it, as a reply
  // of its own under it.
  private steered(agentId: string, inputId: string): void {
    const entry = this.agents.get(agentId);
    const msg = this.messages.find((m) => m.id === inputId);
    if (!entry || !msg) return;
    delete msg.steering;
    delete msg.queuedFor;
    delete msg.queuedEnvelope;
    delete msg.pendingDelivery;
    msg.status = "done";
    this.finished(msg.id, "done", msg.content);
    const current = entry.currentMsg;
    if (current && !current.content.trim() && !current.events?.length) {
      // Read with the prompt, before any output: the empty reply goes.
      this.messages = this.messages.filter((m) => m !== current);
      if (entry.input) entry.input.replies = entry.input.replies.filter((id) => id !== current.id);
      this.cb?.onMessageRemoved?.(this.id, current.id);
    } else if (current) {
      this.settle(current);
    }
    // The model has seen every prompt so far: a usage limit from here on
    // is retried by carrying on, not by sending one of them again.
    if (!entry.retryPending) entry.lastEnvelope = undefined;
    if (!msg.from) entry.pendingTurnFailures = undefined;
    entry.input = { id: msg.id, replies: [] };
    if (msg.from) entry.delivered = entry.input;
    entry.currentMsg = this.makeAgentMsg(agentId);
    entry.input.replies.push(entry.currentMsg.id);
    this.pushMessage(entry.currentMsg);
  }

  // Steered messages a turn ended without reading: the queue's again, and
  // it runs them next; the lead's, once the session no longer reports to
  // it or is taken over / stopped by the user, are dropped.
  private unread(ids: string[]): void {
    const back = this.messages.filter((m) => m.steering && ids.includes(m.id));
    for (const m of back) {
      delete m.steering;
      const entry = m.queuedFor ? this.agents.get(m.queuedFor) : undefined;
      if (
        (m.from?.role === "lead" || m.from?.role === "panel") &&
        (this.projectLink?.unreported || (entry && this.leadBlockedOnAgent(entry)))
      ) {
        this.messages.splice(this.messages.indexOf(m), 1);
        this.cb?.onMessageRemoved?.(this.id, m.id);
      } else {
        this.finished(m.id, m.status, m.content);
      }
    }
  }

  // Who wrote a message, for quotes and forwards.
  private authorOf(msg: Pick<Message, "agentId" | "from">): { name: string; avatar: string } {
    const agent = msg.agentId ? this.agents.get(msg.agentId) : undefined;
    if (agent) return { name: agent.info.name, avatar: agent.info.avatar };
    if (msg.from) return { name: originLabel(msg.from), avatar: "◆" };
    return { name: "User", avatar: "👤" };
  }

  // A message from another session, to the default agent: the panel shows
  // `text` with its sender, the model reads `prompt`. It waits in the queue
  // behind a running turn, earlier queued messages or a rate-limit pause,
  // unless it can be steered into the running turn.
  deliver(text: string, from: MessageOrigin, prompt: string): "sent" | "queued" | "steered" {
    this.assertWritable();
    const agent = this.resolveAgent();
    if (!agent) throw new Error(`"${this.name}" has no agent to take the message`);
    const paused = this.held(agent);
    const waiting = this.messages.some(
      (m) => m.status === "queued" && m.queuedFor === agent.info.id && !m.steering,
    );
    const queued = !!this.leadOutage || this.dispatchHeld(agent) || paused || waiting;
    const steering = !this.leadOutage && queued && this.steerable(agent);
    const msg: Message = {
      id: genId("msg"),
      kind: "user",
      agentId: null,
      content: text,
      timestamp: Date.now(),
      status: queued ? "queued" : "starting",
      from,
      queuedFor: agent.info.id,
      ...(steering && { steering: true }),
    };
    this.enqueue(msg, { inputId: msg.id, text: prompt });
    if (!queued) {
      void this.dispatchPrompt(agent, msg.queuedEnvelope!, msg);
      return "sent";
    }
    if (!steering) return "queued";
    void this.steer(agent, msg);
    return "steered";
  }

  // Choose the surface once so a fresh transcript and a live reader see the same status.
  private revealPendingDelivery(input: Message, isCurrent: () => boolean | undefined) {
    return setTimeout(() => {
      if (!isCurrent() || (input.status !== "starting" && input.status !== "dispatching")) return;
      input.pendingDelivery = input.status === "starting" ? "starting" : "sending";
      this.finished(input.id, input.status, input.content);
    }, 350);
  }

  // `banner` opens the reply of a turn no message of the user's started.
  private async dispatchPrompt(
    agent: AgentEntry,
    prompt: PromptEnvelope | string,
    input?: Message,
    banner?: StreamEvent,
    trigger: InputTrigger = inputTrigger(input),
  ): Promise<void> {
    const envelope =
      typeof prompt === "string" ? { inputId: genId("input"), text: prompt } : prompt;
    const outage = envelope.recovery ? this.leadOutage : undefined;
    const opening = { envelope, input, writeClaimed: false, replied: false };
    agent.openingPrompt = opening;
    agent.lastEnvelope = envelope.reportId ? undefined : envelope;
    if (input) {
      input.queuedEnvelope ??= envelope;
      if (!input.from) agent.pendingTurnFailures = undefined;
      agent.input = { id: input.id, replies: [], ...(envelope.recovery && { recovery: true }) };
      if (input.from) agent.delivered = agent.input;
    }
    if (agent.currentMsg) this.settle(agent.currentMsg);
    agent.currentMsg = null;
    agent.lastStreamAt = undefined;
    agent.retryLabel = undefined;
    const backend = agent.session.getState().config.backend;
    // Pi compaction is a standalone command, not a new model turn.
    const standaloneCompact =
      backend === "pi" &&
      envelope.panelContext === undefined &&
      /^\/compact(?:\s|$)/.test(envelope.text.trim());
    this.beganTurn(agent, !standaloneCompact);

    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    const isOpeningReply = () => agent.openingPrompt === opening && !opening.replied;
    try {
      if (input?.status === "queued") {
        input.status = "starting";
        this.finished(input.id, input.status, input.content);
      }
      if (input?.status === "starting")
        deliveryTimer = this.revealPendingDelivery(input, isOpeningReply);
      if (banner) {
        this.ensureAgentMsg(agent);
        agent.handler(banner);
      }
      const receipt = await agent.session.send(
        backend === "pi" || backend === "codex" ? { ...envelope, trigger } : envelope.text,
        {
          onBeforeWrite: (attempt) => {
            this.assertWritable();
            if (agent.openingPrompt !== opening) throw new Error("Prompt dispatch cancelled");
            if (
              outage &&
              (this.leadOutage !== outage ||
                !outage.batch ||
                outage.batch.id !== envelope.reportId ||
                (!outage.batch.manual && Date.now() >= outage.deadline))
            ) {
              throw new Error("Outage recovery cancelled before sending");
            }
            if (!input) {
              this.cb?.onSaveNow?.();
              opening.writeClaimed = true;
              return;
            }
            this.touch([input.id]);
            input.dispatchAttempt = attempt;
            input.status = "dispatching";
            this.cb?.onSaveNow?.();
            opening.writeClaimed = true;
            if (envelope.reportId)
              this.cb?.onReportDeliveryState?.(envelope.reportId, "dispatching");
            this.finished(input.id, input.status, input.content);
          },
        },
      );
      if (agent.openingPrompt !== opening) {
        if (
          envelope.reportId &&
          input?.status === "dispatching" &&
          !this.agents.has(agent.info.id) &&
          receipt?.disposition === "rejected"
        ) {
          const heir = this.resolveAgent();
          input.queuedFor = heir?.info.id;
          this.requeueReport(input);
          if (heir) this.dequeueNext(heir.info.id);
        }
        return;
      }
      if (receipt?.disposition === "rejected") {
        if (
          receipt.retryable &&
          input &&
          !(envelope.reportId && envelope.reportId === this.leadOutage?.batch?.id)
        ) {
          this.requeueReport(input);
          agent.openingPrompt = undefined;
          this.settleIdleReply(agent);
          setTimeout(() => this.dequeueNext(agent.info.id), 100);
        } else {
          this.failDispatch(agent, input, "error", receipt.error ?? "Prompt rejected");
        }
      } else if (receipt?.disposition !== "started") {
        const handled = receipt?.disposition === "handled";
        this.acceptDispatch(agent, envelope.inputId, !handled);
        if (handled) agent.activeReportId = undefined;
        if (backend === "codex" && !agent.session.isRunning) this.settleActiveReport(agent);
        this.settleIdleReply(agent);
      }
    } catch (err) {
      if (agent.openingPrompt !== opening) return;
      this.failDispatch(
        agent,
        input,
        input?.status === "dispatching" ? "outcome_unknown" : "error",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      // A Pi `started` RPC receipt can precede proof of acceptance.
      if (!isOpeningReply()) clearTimeout(deliveryTimer);
    }
  }

  // Flush the proof of an unsent attempt before mirroring the journal.
  private requeueReport(msg: Message): void {
    this.touch([msg.id]);
    msg.status = "queued";
    delete msg.pendingDelivery;
    delete msg.dispatchAttempt;
    this.cb?.onSaveNow?.();
    if (msg.queuedEnvelope?.reportId)
      this.cb?.onReportDeliveryState?.(msg.queuedEnvelope.reportId, "enqueued");
    this.finished(msg.id, msg.status, msg.content);
  }

  private enqueueManualInput(
    msg: Message,
    envelope: PromptEnvelope,
    admission?: ManualInputAdmission,
  ): void {
    const paired = admission?.panelContext;
    this.enqueue(
      msg,
      paired
        ? {
            ...envelope,
            panelContext: paired.text,
            reportId: paired.reportId,
            recovery: paired.recovery,
          }
        : envelope,
      admission,
    );
  }

  private enqueue(msg: Message, envelope: PromptEnvelope, admission?: ManualInputAdmission): void {
    this.assertWritable();
    msg.queuedEnvelope = envelope;
    const panelMessage: Message | undefined =
      envelope.panelContext === undefined
        ? undefined
        : {
            id: pairedPanelMessageId(msg.id),
            kind: "user",
            agentId: null,
            content: envelope.panelContext,
            timestamp: msg.timestamp,
            status: "done",
            from: { workspaceId: this.id, name: "Outage report", role: "panel" },
          };
    const messages = panelMessage ? [panelMessage, msg] : [msg];
    this.messages.push(...messages);
    this.touch(messages.map((message) => message.id));
    admission?.stage();
    try {
      this.cb?.onSaveNow?.();
    } catch (error) {
      for (const message of messages) {
        const idx = this.messages.lastIndexOf(message);
        if (idx >= 0) this.messages.splice(idx, 1);
        this.changed.delete(message.id);
      }
      try {
        admission?.rollback();
      } catch (rollbackError) {
        console.error(
          `[workspace] ${this.id}: could not persist manual input rollback`,
          rollbackError,
        );
      }
      throw error;
    }
    admission?.committed();
    if (msg.timestamp > this.lastActivityAt) this.lastActivityAt = msg.timestamp;
    if (panelMessage && envelope.reportId)
      this.cb?.onReportDeliveryState?.(envelope.reportId, "enqueued");
    for (const message of messages) this.cb?.onNewMessage(this.id, message);
  }

  private completeDispatch(
    msg: Message,
    status: "done" | "error" | "outcome_unknown",
    errorMessage?: string,
    beforeBroadcast?: () => void,
  ): void {
    const reportId = msg.dispatchAttempt?.reportId ?? msg.queuedEnvelope?.reportId;
    this.touch([msg.id]);
    msg.status = status;
    delete msg.pendingDelivery;
    delete msg.queuedEnvelope;
    delete msg.queuedFor;
    delete msg.steering;
    this.cb?.onSaveNow?.();
    if (reportId)
      this.cb?.onReportDeliveryState?.(
        reportId,
        status === "done" ? "sent_to_pi" : status,
        status === "done" ? { acceptedByPiAt: Date.now() } : { errorMessage },
      );
    beforeBroadcast?.();
    this.finished(msg.id, status, msg.content);
    if (status === "outcome_unknown") {
      this.postSystemMessage(
        `⚠ Delivery outcome unknown for message ${msg.id}. Verify it before retrying; it will not be resent automatically.`,
      );
      this.cb?.onSaveNow?.();
    }
  }

  private acceptDispatch(entry: AgentEntry, inputId?: string, started = false): void {
    const opening = entry.openingPrompt;
    if (!opening || inputId !== opening.envelope.inputId) return;
    const openReply = () => {
      if (started && entry.session.isRunning && !opening.replied) this.ensureAgentMsg(entry);
    };
    if (opening.input) {
      entry.activeReportId = opening.envelope.reportId;
      // Commit the receipt first, then announce the replacement before clearing the pending row.
      this.completeDispatch(opening.input, "done", undefined, openReply);
    } else {
      openReply();
    }
    entry.openingPrompt = undefined;
    setTimeout(() => this.dequeueNext(entry.info.id), 0);
  }

  private settleActiveReport(entry: AgentEntry): void {
    if (!entry.activeReportId) return;
    this.cb?.onReportDeliveryState?.(entry.activeReportId, "settled", {
      settledAt: Date.now(),
    });
    entry.activeReportId = undefined;
  }

  private failDispatch(
    entry: AgentEntry,
    msg: Message | undefined,
    status: "error" | "outcome_unknown",
    reason: string,
  ): void {
    if (msg) {
      entry.lastEnvelope = undefined;
      this.completeDispatch(msg, status, reason);
    }
    const replied = entry.openingPrompt?.replied;
    entry.openingPrompt = undefined;
    if (status === "error" && !this.disposed && (!replied || entry.currentMsg))
      entry.handler({ kind: "error", content: `[send failed] ${reason}` });
    else if (!entry.currentMsg) this.settleIdleReply(entry);
    setTimeout(() => this.dequeueNext(entry.info.id), 0);
  }

  private settleIdleReply(entry: AgentEntry): void {
    if (entry.session.isRunning) return;
    if (entry.currentMsg) this.settle(entry.currentMsg);
    entry.currentMsg = null;
    this.endedTurn(entry);
  }

  private cancelOpeningPrompt(entry: AgentEntry, reason: string): void {
    const opening = entry.openingPrompt;
    if (!opening) return;
    entry.openingPrompt = undefined;
    entry.lastEnvelope = undefined;
    const input = opening.input;
    if (input?.status === "starting") this.completeDispatch(input, "error", reason);
    else if (input?.status === "dispatching") this.completeDispatch(input, "outcome_unknown");
  }

  findMessage(id: string): Message | undefined {
    return this.messages.find((msg) => msg.id === id);
  }

  findRecoveryInput(reportId: string): Message | undefined {
    return this.messages.find(
      (m) => (m.dispatchAttempt?.reportId ?? m.queuedEnvelope?.reportId) === reportId,
    );
  }

  settleRecoveryOnHold(row: Message, restoring: boolean): void {
    if (row.status === "queued" || row.status === "starting")
      this.completeDispatch(
        row,
        "error",
        restoring
          ? "Server restarted before recovery dispatch"
          : "Recovery stopped before dispatch",
      );
    else if (restoring && row.status === "dispatching")
      this.completeDispatch(row, "outcome_unknown");
  }

  unsentInboxRow(id: string): boolean {
    const m = this.findMessage(id);
    return !!m && m.status === "queued" && !m.steering && !m.dispatchAttempt && isInboxReport(m);
  }

  finishBatchedRow(id: string, status: "done" | "outcome_unknown"): void {
    if (this.unsentInboxRow(id)) this.completeDispatch(this.findMessage(id)!, status);
  }

  recoveryAvailability(agentId: string): "unavailable" | "blocked" | "ready" {
    const entry = this.agents.get(agentId);
    if (!entry || this.disposed) return "unavailable";
    return !this.isWritable() || this.dispatchHeld(entry) || this.held(entry) ? "blocked" : "ready";
  }

  startRecovery(
    agentId: string,
    reportId: string,
    text: string,
    recovery: NonNullable<PromptEnvelope["recovery"]>,
  ): void {
    const entry = this.agents.get(agentId)!;
    const envelope = { inputId: reportId, reportId, text, recovery };
    const msg: Message = {
      id: reportId,
      kind: "user",
      agentId: null,
      status: "starting",
      timestamp: Date.now(),
      content: text,
      from: { workspaceId: this.id, name: "Network recovery", role: "panel" },
    };
    this.enqueue(msg, envelope);
    void this.dispatchPrompt(entry, envelope, msg);
  }

  ensureReportQueued(
    id: string,
    agentId: string,
    envelope: PromptEnvelope,
    from: MessageOrigin,
    content: string,
  ): Message {
    const existing = this.findMessage(id);
    if (existing) {
      if (existing.status === "queued" && !existing.queuedFor) {
        existing.queuedFor = agentId;
        this.finished(existing.id, existing.status, existing.content);
        this.cb?.onSaveNow?.();
      }
      return existing;
    }
    const msg: Message = {
      id,
      agentId: null,
      kind: "user",
      status: "queued",
      queuedFor: agentId,
      from,
      content,
      timestamp: Date.now(),
    };
    this.enqueue(msg, envelope);
    return msg;
  }

  settleStartingOnRestore(): void {
    for (const msg of this.messages) {
      // Recovery restore settles the batch and its unwritten input together.
      const batch = this.leadOutage?.batch;
      if (msg.status === "starting" && !(batch && msg.queuedEnvelope?.reportId === batch.id))
        this.completeDispatch(msg, "error", "Server restarted before sending the message");
    }
  }

  settlePlainDispatchingOnRestore(): void {
    for (const msg of this.messages) {
      if (msg.status === "dispatching" && !msg.dispatchAttempt?.reportId) {
        this.completeDispatch(msg, "outcome_unknown");
      }
    }
  }

  async recoverDispatchingReport(
    msg: Message,
    commit: (settle: () => void) => Promise<void>,
    probe = true,
  ): Promise<void> {
    const agentId = msg.queuedFor;
    const entry = this.agents.get(agentId ?? "");
    if (!entry && msg.status === "dispatching") {
      const attempt = msg.dispatchAttempt;
      await this.retiredReportAgents.get(agentId ?? "")?.catch(() => {});
      await commit(() => {
        if (
          msg.status !== "dispatching" ||
          msg.queuedFor !== agentId ||
          msg.dispatchAttempt !== attempt ||
          !attempt?.reportId
        )
          return;
        const found = hasPersistedPiReport(attempt, this.normalizedCwd);
        this.completeDispatch(msg, found ? "done" : "outcome_unknown");
      });
      return;
    }
    if (
      !entry ||
      entry.recoveringDispatching ||
      entry.openingPrompt ||
      msg.status !== "dispatching"
    )
      return;
    entry.recoveringDispatching = true;
    const attempt = msg.dispatchAttempt;
    try {
      // Set the queue fence synchronously; run the probe outside the caller’s board commit.
      await Promise.resolve();
      let found = false;
      if (probe && attempt?.reportId && this.isWritable()) {
        try {
          const result = await entry.session.probeDispatchedReport?.(
            attempt.beforeLeafId,
            attempt.reportId,
          );
          found = classifyProbeDelivery({ result }) === "delivered";
        } catch {
          /* No positive proof: never resend. */
        }
      }
      if (!this.agents.has(entry.info.id)) {
        await this.recoverDispatchingReport(msg, commit, probe);
      } else {
        await commit(() => {
          if (msg.status === "dispatching")
            this.completeDispatch(msg, found && this.isWritable() ? "done" : "outcome_unknown");
        });
      }
    } finally {
      entry.recoveringDispatching = false;
    }
  }

  private hasQueued(agent: AgentEntry, skipInboxReports = false): boolean {
    return this.messages.some(
      (msg) =>
        msg.status === "queued" &&
        msg.queuedFor === agent.info.id &&
        (!skipInboxReports || !isInboxReport(msg)),
    );
  }

  private dispatchHeld(agent: AgentEntry): boolean {
    return agent.session.isRunning || !!agent.openingPrompt || !!agent.recoveringDispatching;
  }

  private isWritable(): boolean {
    return !this.disposed && this.cb?.canDispatch?.(this) !== false;
  }

  private assertWritable(): void {
    if (!this.isWritable()) throw new Error("Workspace no longer accepts writes");
  }

  private sessionStorage(): Partial<SessionConfig> {
    return { ...this.storage, workspaceId: this.id, normalizedCwd: this.normalizedCwd };
  }

  get hasPendingDialogs(): boolean {
    return this.pendingDialogs.size > 0;
  }

  getExtensionUi(): ExtensionUiSnapshot[] {
    return [...this.agents.values()].flatMap((entry) =>
      entry.extensionUi ? [entry.extensionUi] : [],
    );
  }

  getPendingDialogs(): UiDialogRequest[] {
    return [...this.pendingDialogs.values()];
  }

  respondToUiDialog(
    agentId: string,
    generation: number,
    requestId: string,
    response: UiDialogResponse,
  ): void {
    if (!this.pendingDialogs.has(dialogKey(agentId, generation, requestId))) return;
    this.agents.get(agentId)?.session.respondToUiDialog?.(requestId, response);
  }

  async seal(): Promise<void> {
    this.disposed = true;
    for (const msg of this.messages) {
      if (msg.status === "queued" || msg.status === "starting")
        this.completeDispatch(msg, "error", "Project sealed");
      else if (msg.status === "dispatching") this.completeDispatch(msg, "outcome_unknown");
    }
    for (const entry of this.agents.values()) {
      entry.openingPrompt = undefined;
      this.dropRetry(entry);
    }
    await Promise.allSettled(
      [...this.agents].map(async ([agentId, entry]) => {
        await this.releaseSession(agentId, entry);
        this.finalizeAbort(entry, true);
      }),
    );
    this.cb?.onSaveNow?.();
  }

  // A turn ended. A retry that fell due while it ran goes now, through the
  // process already up: the start slots space new ones (the server's timer).
  private afterTurn(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (entry?.retryPending && Date.now() >= (entry.pausedUntil ?? 0) && this.retryLast(agentId)) {
      return;
    }
    this.dequeueNext(agentId);
  }

  // Whether the lead has lost dispatch rights on this worker agent (unreported,
  // taken over by a direct user turn/queue, or stopped by the user).
  private leadBlockedOnAgent(entry: AgentEntry): boolean {
    if (this.projectLink?.role !== "worker") return false;
    if (this.projectLink.unreported) return true;
    const d = entry.delivered;
    if (d && entry.input !== d && !entry.input?.finished) return true;
    if (d?.stopped === "user" || entry.input?.stopped === "user") return true;
    return this.messages.some((m) => m.status === "queued" && m.kind === "user" && !m.from);
  }

  private dropQueuedLeadFor(agentId: string): void {
    if (this.projectLink?.role !== "worker") return;
    const queued = this.messages.filter(
      (m) =>
        m.status === "queued" &&
        m.queuedFor === agentId &&
        (m.from?.role === "lead" || m.from?.role === "panel"),
    );
    for (const m of queued) {
      if (this.cancelQueued(m.id, true)) {
        this.cb?.onMessageRemoved?.(this.id, m.id);
      }
    }
  }

  // Runs whenever an agent becomes idle: promote the oldest queued message
  // for that agent and dispatch its stored prompt.
  dequeueNext(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (
      !this.isWritable() ||
      this.cb?.canDequeue?.() === false ||
      !entry ||
      this.dispatchHeld(entry)
    )
      return;
    if (this.held(entry)) return;
    const pending = (m: Message) => m.status === "queued" && m.queuedFor === agentId && !m.steering;
    const paired = this.messages.find(
      (m) => pending(m) && m.queuedEnvelope?.panelContext !== undefined,
    );
    if (
      this.leadOutage &&
      !(paired && this.leadOutage.batch?.id === paired.queuedEnvelope?.reportId)
    )
      return;
    let msg: Message | undefined;
    while (true) {
      const candidate = paired ?? this.messages.find(pending);
      if (!candidate) break;
      if (
        (candidate.from?.role === "lead" || candidate.from?.role === "panel") &&
        this.leadBlockedOnAgent(entry)
      ) {
        if (!this.cancelQueued(candidate.id)) break;
        this.cb?.onMessageRemoved?.(this.id, candidate.id);
        continue;
      }
      msg = candidate;
      break;
    }
    if (!msg) {
      // After the queue, as the CLI orders its own wake-ups.
      const wake = entry.session.wakeDue ? entry.session.takeWake?.() : null;
      if (wake) {
        void this.dispatchPrompt(
          entry,
          wake.prompt,
          undefined,
          {
            kind: "notice",
            level: "wakeup",
            content:
              "Scheduled wake-up fired — sent by the panel: the CLI process that held it is gone.",
          },
          "auto",
        );
      }
      return;
    }
    void this.dispatchPrompt(
      entry,
      msg.queuedEnvelope ?? { inputId: msg.id, text: msg.content },
      msg,
    );
  }

  // Hold an agent's queue until `until`; with `retry`, a rate-limit backoff
  // that only retryLast ends.
  pauseAgent(agentId: string, until: number, retry = false): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    entry.pausedUntil = until;
    entry.retryPending = retry;
    if (retry) this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
  }

  // A spacing pause is over: lift it and move the queue. Its timer can fire
  // a millisecond before Date.now() reaches the end of the pause.
  endPause(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.retryPending) return;
    entry.pausedUntil = undefined;
    this.dequeueNext(agentId);
  }

  private held(entry: AgentEntry): boolean {
    return !!entry.retryPending || (!!entry.pausedUntil && Date.now() < entry.pausedUntil);
  }

  private dropRetry(entry: AgentEntry): void {
    if (!entry.retryPending) return;
    entry.retryPending = false;
    entry.pausedUntil = undefined;
    this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry));
  }

  // Rate-limit recovery, if a retry is still pending (a stop or an archive
  // drops it): re-dispatch the last prompt, or tell the agent to carry on
  // when the turn cut was one the CLI started. A turn running now keeps it
  // pending; it goes when that turn ends.
  retryLast(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (
      !this.isWritable() ||
      this.cb?.canDequeue?.() === false ||
      !entry?.retryPending ||
      this.dispatchHeld(entry)
    )
      return false;
    this.dropRetry(entry);
    if (entry.lastEnvelope) {
      void this.dispatchPrompt(entry, entry.lastEnvelope, undefined, undefined, "retry");
      return true;
    }
    // A message waiting for the agent resumes it as well as a carry-on.
    if (this.messages.some((m) => m.status === "queued" && m.queuedFor === agentId)) return false;
    this.pushSystemMessage(
      `↻ **${entry.info.name}** was told to carry on where the usage limit cut it off.`,
    );
    void this.dispatchPrompt(
      entry,
      "[From the panel] A usage limit cut your turn off. Carry on where you left off.",
      undefined,
      undefined,
      "retry",
    );
    // Cut off again, it is told to carry on again, not as a prompt of ours.
    entry.lastEnvelope = undefined;
    return true;
  }

  postSystemMessage(content: string): void {
    this.pushSystemMessage(content);
  }

  // Remove a still-queued message. Returns false if it no longer exists or
  // already started running.
  // A steered one is the running turn's already: only a stop that ends the
  // turn with it (`evenSteered`) takes it back.
  cancelQueued(messageId: string, evenSteered = false): boolean {
    const idx = this.messages.findIndex(
      (m) => m.id === messageId && m.status === "queued" && (evenSteered || !m.steering),
    );
    if (idx < 0) return false;
    const [removed] = this.messages.splice(idx, 1);
    if (removed.queuedEnvelope?.panelContext !== undefined) {
      const panelId = pairedPanelMessageId(removed.id);
      const panelIndex = this.messages.findIndex((msg) => msg.id === panelId);
      if (panelIndex >= 0) this.messages.splice(panelIndex, 1);
      this.cb?.onMessageRemoved?.(this.id, panelId);
    }
    const reportId = removed.queuedEnvelope?.reportId ?? removed.dispatchAttempt?.reportId;
    if (reportId) {
      this.cb?.onSaveNow?.();
      this.cb?.onReportDeliveryState?.(reportId, "error", {
        errorMessage: "Cancelled by user",
      });
    }
    return true;
  }

  async forwardMessage(messageId: string, targetAgentId: string): Promise<void> {
    this.assertWritable();
    const original = this.messages.find((m) => m.id === messageId);
    if (!original || !original.content) throw new Error("Message not found");

    const author = this.authorOf(original);

    const agent = this.resolveAgent(targetAgentId);
    if (!agent) throw new Error("Target agent not found");

    const preview = original.content.slice(0, 120) + (original.content.length > 120 ? "..." : "");
    const forwardRef: ForwardRef = {
      messageId,
      fromAgent: author.name,
      fromAvatar: author.avatar,
      preview,
    };

    const prompt = `[Forwarded message from ${author.name}]:\n\n${original.content}`;
    if (!agent.lastEnvelope) this.dropRetry(agent);
    const retried = agent.retryPending && !agent.session.isRunning && this.retryLast(agent.info.id);
    const admission = this.cb?.prepareManualInput?.(this, agent.info.id, true);
    const busy =
      retried ||
      this.dispatchHeld(agent) ||
      this.held(agent) ||
      this.hasQueued(agent, !!admission?.panelContext);
    const userMsg: Message = {
      id: genId("msg"),
      kind: "user",
      agentId: null,
      content: "",
      timestamp: Date.now(),
      status: busy ? "queued" : "starting",
      forwardRef,
      queuedFor: agent.info.id,
    };
    this.enqueueManualInput(userMsg, { inputId: userMsg.id, text: prompt }, admission);
    if (busy) return;

    await this.dispatchPrompt(agent, userMsg.queuedEnvelope!, userMsg);
  }

  cancelSubagent(agentId: string, taskId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent not found: ${agentId}`);
    if (!entry.session.stopTask) throw new Error("This backend does not support stopping tasks");
    return entry.session.stopTask(taskId);
  }

  isNetworkWaiting(agentId: string): boolean {
    return this.agents.get(agentId)?.networkWaiting ?? false;
  }

  // Recovery is stoppable, but is not a running turn and does not hold dispatch.
  setNetworkWaiting(agentId: string, waiting: boolean): void {
    const entry = this.agents.get(agentId);
    if (!entry || this.isNetworkWaiting(agentId) === waiting) return;
    entry.networkWaiting = waiting;
    this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
  }

  abortAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    this.cb?.onLeadStop?.(this, agentId);
    const busy = this.hasWork(entry);
    this.cancelOpeningPrompt(entry, "Cancelled by user");
    this.dropQueuedLeadFor(agentId);
    entry.session.abort();
    this.finalizeAbort(entry, busy);
    if (this.projectLink?.role === "worker") this.cb?.onSaveNow?.();
  }

  abortAll(by: "user" | "restart" | "lead" = "user"): void {
    if (by === "user") this.cb?.onLeadStop?.(this);
    for (const entry of this.agents.values()) {
      const busy = this.hasWork(entry);
      if (by !== "restart") {
        this.cancelOpeningPrompt(
          entry,
          by === "lead" ? "Cancelled by project lead" : "Cancelled by user",
        );
      }
      if (by === "user") this.dropQueuedLeadFor(entry.info.id);
      entry.session.abort();
      this.finalizeAbort(entry, busy, by);
    }
    if (by === "user" && this.projectLink?.role === "worker") this.cb?.onSaveNow?.();
  }

  // A turn, background task or wake-up that a stop would cut short.
  private hasWork(entry: AgentEntry): boolean {
    return (
      !!entry.openingPrompt ||
      entry.currentMsg?.status === "streaming" ||
      this.agentState(entry) !== "idle"
    );
  }

  // Stop the running turns and nothing else: background tasks and pending
  // wake-ups go on. A Stop the backend cannot take as an interrupt stops by
  // abort: a second one while the first is unanswered (the SDK's request has
  // no timeout), or one while the process is still starting.
  async interruptAgent(agentId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    this.cb?.onLeadStop?.(this, agentId);
    this.dropRetry(entry);
    const session = entry.session;
    if (
      !session.interrupt ||
      session.interruptPending ||
      (entry.openingPrompt && (!session.isRunning || !entry.openingPrompt.writeClaimed))
    ) {
      this.abortAgent(agentId);
      return;
    }
    this.settleStale(entry);
    const inputBefore = entry.input;
    const msgBefore = entry.currentMsg?.id;
    if (this.projectLink?.role === "worker") {
      // Codex can return unread steers before its interrupted result, and
      // Pi can stop before producing any result. Fence both before the call.
      this.dropQueuedLeadFor(agentId);
      entry.pendingTurnFailures = undefined;
      if (session.isRunning && inputBefore) inputBefore.stopped = "user";
      this.cb?.onSaveNow?.();
    }
    if (
      session.isRunning &&
      !(await session.interrupt()) &&
      session.isRunning &&
      entry.input === inputBefore &&
      entry.currentMsg?.id === msgBefore
    ) {
      this.abortAgent(agentId);
    }
  }

  async interruptAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((id) => this.interruptAgent(id)));
  }

  // Drops an agent's pending wake-up; null once dropped, else why not.
  cancelWake(agentId: string): string | null {
    const entry = this.agents.get(agentId);
    if (!entry?.session.cancelWake) return "No wake-up to cancel";
    const refused = entry.session.cancelWake();
    if (refused) return refused;
    if (entry.input) entry.input.stopped = "user";
    entry.pendingTurnFailures = undefined;
    this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
    return null;
  }

  private finalizeAbort(
    entry: AgentEntry,
    busy: boolean,
    by: "user" | "restart" | "lead" = "user",
  ): void {
    if (busy && entry.input) entry.input.stopped = by;
    if (by !== "restart") {
      entry.pendingTurnFailures = undefined;
      this.dropRetry(entry);
    }
    if (entry.currentMsg && entry.currentMsg.status === "streaming") {
      entry.currentMsg.content = withInterrupted(entry.currentMsg.content);
      this.settle(entry.currentMsg);
    }
    entry.currentMsg = null;
    this.settleStale(entry);
    this.endedTurn(entry);
    setTimeout(() => this.dequeueNext(entry.info.id), 0);
  }

  clearContext(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    if (this.dispatchHeld(entry)) return false;
    if (this.hasWork(entry) && entry.input) entry.input.stopped = "user";
    entry.pendingTurnFailures = undefined;
    this.dropRetry(entry);
    if (entry.session.resetContext) entry.session.resetContext();
    else {
      entry.session.abort();
      entry.session.sessionId = null;
    }
    entry.session.usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turns: 0,
      duration_ms: 0,
    };
    this.settleStale(entry);
    this.updateLastContext(entry, undefined);
    this.pushSystemMessage(`${entry.info.avatar} **${entry.info.name}** context cleared`, {
      agentId,
    });
    return true;
  }

  private agentState(a: AgentEntry): RunState {
    return a.runState ?? a.session.runState ?? (a.session.isRunning ? "working" : "idle");
  }

  agentInfo(a: AgentEntry): AgentRuntimeInfo {
    const state = a.session.getState();
    const context = this.lastContext(a);
    const effectiveEffort = a.session.effectiveEffort;
    return {
      ...a.info,
      canSwitchBackend: this.canSwitchBackend(a, state),
      busy: a.session.isRunning || !!a.openingPrompt,
      networkWaiting: a.networkWaiting ?? false,
      retryPending: a.retryPending ?? false,
      state: this.agentState(a),
      activity: a.activity ?? null,
      ...(a.lastStreamAt != null && { lastStreamAt: a.lastStreamAt }),
      ...(a.retryLabel && { retryLabel: a.retryLabel }),
      effort: state.config.effort ?? null,
      ...(effectiveEffort && { effectiveEffort }),
      effortLevels: this.effortLevels(a, a.info.model) ?? [],
      fast: Boolean(state.config.fast),
      backgroundTasks: a.session.backgroundTaskList ?? [],
      ...(context !== undefined && { context }),
      wake: a.session.wake ?? null,
    };
  }

  // Undefined hides occupancy for fresh, cleared, and archived histories.
  // Null is an explicitly unknown backend boundary: both it and compaction
  // stop the search so older occupancy never resurfaces.
  private lastContext(a: AgentEntry): ContextUsage | null | undefined {
    if (this.isArchived || !this.messagesLoaded) return undefined;
    if (a.hasCachedContext) return a.lastContext;
    let found: ContextUsage | null | undefined;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.agentId !== a.info.id) continue;
      // Older clear markers carried context: null. They mean absent, not an
      // unknown turn boundary, regardless of what older messages recorded.
      if (isContextClearedMessage(m)) break;
      if (m.context !== undefined) {
        found = m.context;
        break;
      }
      if (isCompactedMessage(m)) {
        found = null;
        break;
      }
    }
    a.lastContext = found;
    a.hasCachedContext = true;
    return found;
  }

  getInfo(includeMessages = true): WorkspaceInfo {
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      hostId: this.hostId,
      cwd: this.cwd,
      git: this.git,
      pr: this.pr,
      agents: [...this.agents.values()].map((a) => this.agentInfo(a)),
      messages: includeMessages ? this.messages : [],
      createdAt: this.createdAt,
      lastMessageAt: this.lastActivityAt,
      archivedAt: this.archivedAt,
      ...(this.projectLink && { projectLink: this.projectLink }),
      unread: this.unseen,
      lastResult: this.lastResult,
      queued: this.hasQueuedInput,
    };
  }

  get hasQueuedInput(): boolean {
    return this.messages.some((m) => m.kind === "user" && m.status === "queued");
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getState(): WorkspaceState {
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      hostId: this.hostId,
      cwd: this.cwd,
      normalizedCwd: this.normalizedCwd,
      ...(this.leadOutage && { leadOutage: this.leadOutage }),
      agents: [...this.agents.values()].map((a) => {
        return {
          ...a.info,
          session: a.session.getState(),
          ...(a.delivered && {
            delivered: {
              ...a.delivered,
              ...(a.input?.finished && a.input.stopped === "user" && { stopped: "user" }),
              ...(a.input !== a.delivered && !a.input?.finished && { since: true }),
            },
          }),
          ...(a.pendingTurnFailures?.length && { pendingTurnFailures: a.pendingTurnFailures }),
          ...(a.retryPending && { pausedUntil: a.pausedUntil, lastEnvelope: a.lastEnvelope }),
        };
      }),
      ...(this.messagesLoaded && { messages: this.messages.map(withoutLiveTiming) }),
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      archivedAt: this.archivedAt,
      ...(this.projectLink && { projectLink: this.projectLink }),
      attention: {
        unread: this.unseen,
        lastResult: this.lastResult,
        awaitsUser: this.projectedAwaitsUser,
      },
    };
  }

  static fromState(
    state: WorkspaceState,
    hostRegistry: HostRegistry,
    cb?: WorkspaceCallbacks,
    storage?: { dataDir: string; uploadsDir: string },
  ): Workspace {
    const hostId = state.hostId || "local";
    const ws = new Workspace(
      state.id,
      state.name,
      state.project,
      hostId,
      state.cwd,
      hostRegistry,
      cb,
      storage,
      state.normalizedCwd,
    );
    ws.createdAt = state.createdAt;
    ws.archivedAt = state.archivedAt ?? null;
    ws.projectLink = state.projectLink;
    ws.leadOutage = state.leadOutage;
    // Old unread counts included input, placeholders, and system messages.
    ws.unseen = state.attention?.unread ?? 0;
    ws.lastResult = state.attention?.lastResult;
    ws.projectedAwaitsUser = state.attention?.awaitsUser ?? false;
    // No messages: the history could not be read, and a save must not
    // write an empty one over it.
    ws.messagesLoaded = state.messages !== undefined;
    const cut = new Set<string>();
    const activeTasks = new Map(state.agents.map((a) => [a.id, activeSubagentTaskIds(a.session)]));
    ws.messages = (state.messages ?? []).map((m) => {
      const msg = {
        ...m,
        kind: m.kind ?? (m.agentId === null ? "user" : "agent"),
        status: m.status === "streaming" ? ("done" as MessageStatus) : m.status,
      };
      // The turn it was steered into went with the process.
      delete msg.steering;
      // Cut off by a server restart or crash mid-turn.
      if (m.status === "streaming") {
        msg.content = m.content ? `${m.content}\n\n*\\[interrupted\\]*` : "*\\[interrupted\\]*";
        ws.changed.add(m.id);
        cut.add(m.id);
      }
      if (restoreMessage(msg, activeTasks.get(msg.agentId ?? ""))) ws.touch([msg.id]);
      return msg;
    });
    // An orphaned queued report is still owned by the Lead workspace.
    const agentIds = new Set(state.agents.map((a) => a.id));
    ws.messages = ws.messages.filter((m) => {
      if (m.status !== "queued" || !m.queuedFor || agentIds.has(m.queuedFor)) return true;
      if (!m.queuedEnvelope?.reportId) return false;
      delete m.queuedFor;
      ws.touch([m.id]);
      return true;
    });
    const lastMsg = ws.messages[ws.messages.length - 1];
    ws.lastActivityAt = Math.max(
      state.lastActivityAt ?? 0,
      lastMsg?.timestamp ?? 0,
      state.createdAt,
    );

    const host = hostRegistry.get(hostId) ?? hostRegistry.getDefault()!;
    for (const agentState of state.agents) {
      const session = host.restoreSession(agentState.id, {
        ...agentState.session,
        config: { ...agentState.session.config, ...ws.sessionStorage() },
      });
      const legacyPrompt = (agentState as AgentState & { lastPrompt?: string }).lastPrompt;
      const handler = ws.attachSession(agentState.id, session);
      ws.agents.set(agentState.id, {
        info: {
          id: agentState.id,
          name: agentState.name,
          model: agentState.model,
          avatar: agentState.avatar,
          color: agentState.color,
          isDefault: agentState.isDefault,
          account: agentState.account,
        },
        session,
        handler,
        currentMsg: null,
        pausedUntil: agentState.pausedUntil,
        lastEnvelope:
          agentState.lastEnvelope ??
          (legacyPrompt != null ? { inputId: genId("input"), text: legacyPrompt } : undefined),
        retryPending: agentState.pausedUntil !== undefined,
        pendingTurnFailures: agentState.pendingTurnFailures,
      });
      if (agentState.delivered) {
        const { since, waiting, ...delivered } = agentState.delivered;
        if (!delivered.stopped && (waiting || cut.has(delivered.replies.at(-1)!))) {
          delivered.stopped = "restart";
        }
        const entry = ws.agents.get(agentState.id)!;
        entry.delivered = delivered;
        if (!since) entry.input = delivered;
      }
    }

    return ws;
  }
}

function updateLiveTiming(msg: Message, event: StreamEvent): StreamEvent {
  if (msg.status !== "streaming" || event.kind === "subagent_enrichment") return event;
  if (event.kind === "thinking_delta" && event.durationMs == null) {
    const startedAt = event.startedAt ?? msg.liveThinkingSince ?? Date.now();
    msg.liveThinkingSince = startedAt;
    delete msg.waitingSince;
    return { ...event, startedAt, waitingSince: null };
  }

  // Background card updates aren't progress by the main model.
  if (
    event.kind === "subagent_progress" ||
    event.kind === "subagent_done" ||
    event.kind === "subagent_start"
  ) {
    if (msg.liveThinkingSince != null || event.kind === "subagent_progress") return event;
  }
  delete msg.liveThinkingSince;
  const hasWork = msg.events?.some(
    (e) =>
      (e.kind === "tool_use" && e.toolResult == null) ||
      (e.kind === "subagent_start" && isOutstandingSubagentStatus(e.subagent?.status)),
  );
  if (hasWork) delete msg.waitingSince;
  else msg.waitingSince = Date.now();
  return { ...event, waitingSince: msg.waitingSince ?? null };
}

function clearLiveTiming(msg: Message): void {
  delete msg.liveThinkingSince;
  delete msg.waitingSince;
}

function withoutLiveTiming(msg: Message): Message {
  if (msg.liveThinkingSince == null && msg.waitingSince == null) return msg;
  const copy = { ...msg };
  clearLiveTiming(copy);
  return copy;
}

function dialogKey(agentId: string, generation: number, requestId: string): string {
  return `${agentId}:${generation}:${requestId}`;
}

function activeSubagentTaskIds(session: SessionState): Set<string> {
  return new Set(
    session.activeAsyncRuns?.flatMap((run) =>
      run.children.flatMap((child) => [
        child.taskId,
        ...Object.entries(child.tree?.nodes ?? {})
          .filter(([, facts]) => isOutstandingSubagentStatus(facts.status))
          .map(([id]) => id),
      ]),
    ),
  );
}

function restoreMessage(
  msg: Message & { queuedPrompt?: string },
  activeTasks?: ReadonlySet<string>,
): boolean {
  clearLiveTiming(msg);
  if (msg.events) normalizeEvents(msg.events, activeTasks);
  if (msg.queuedPrompt === undefined) return false;
  msg.queuedEnvelope ??= { inputId: msg.id, text: msg.queuedPrompt };
  delete msg.queuedPrompt;
  return true;
}

// The model answered in the reply: text, thinking or a tool call, not just
// the notices and retry banners of a turn the API refused.
function answered(msg: Message, content = msg.content): boolean {
  const output = ["thinking", "tool_use", "subagent_start"];
  return !!content.trim() || !!msg.events?.some((e) => output.includes(e.kind));
}

// A plan or preamble before the last tool call is not the turn's conclusion.
function concludingText(msg: Message): boolean {
  let after = 0;
  for (const e of msg.events ?? []) {
    if (e.kind === "tool_use" || e.kind === "tool_result" || e.kind === "subagent_start") {
      after = Math.max(after, e.contentOffset ?? 0);
    }
  }
  return !!msg.content.slice(after).trim();
}

function lastThinking(events: StreamEvent[]): StreamEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === "thinking") return events[i];
  return undefined;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const NO_ACTIVE_SESSION = "No active session — send a message first to start a session.";

function isLegacyLocalCommandReply(input: Message | undefined, reply: Message): boolean {
  if (
    input?.kind !== "user" ||
    input.from ||
    input.status !== "done" ||
    reply.status !== "done" ||
    !reply.turnId ||
    reply.events?.length !== 0
  )
    return false;
  const prompt = input.content.replace(/(?:^|\s)@\S+\s*/, " ").trim();
  const hasArgs = (name: string) => prompt === name || prompt.startsWith(`${name} `);
  // Older local commands wrote adjacent user/reply pairs with no localCommand marker.
  if (hasArgs("/model"))
    return /^\*\*.*\*\* (?:runs on|already runs on|moves from|cannot move to|cannot switch models)\b/.test(
      reply.content,
    );
  if (hasArgs("/effort"))
    return /^(?:Effort (?:levels for|for)|Invalid effort level|\*\*[^\n]+(?:does not support|\nEffort:))/.test(
      reply.content,
    );
  if (hasArgs("/fast"))
    return /^(?:Fast mode for|Usage: `\/fast|\*\*.*\*\* .*does not support fast mode)/.test(
      reply.content,
    );
  if (prompt === "/usage" || prompt === "/cost")
    return reply.content.startsWith("## Session Usage") || reply.content === NO_ACTIVE_SESSION;
  if (prompt === "/context")
    return reply.content.startsWith("## Context Usage") || reply.content === NO_ACTIVE_SESSION;
  return hasArgs("/goal") && reply.content === "/goal is disabled.";
}

function formatUsageInfo(data: Record<string, unknown>): string {
  const lines: string[] = ["## Session Usage"];

  const session = data.session as Record<string, unknown> | undefined;
  if (session) {
    const cost = session.total_cost_usd as number | undefined;
    if (cost != null) lines.push(`**Session cost:** $${cost.toFixed(4)}`);
    const dur = session.total_duration_ms as number | undefined;
    if (dur != null) lines.push(`**Duration:** ${Math.round(dur / 1000)}s`);
    const added = session.total_lines_added as number | undefined;
    const removed = session.total_lines_removed as number | undefined;
    if (added != null || removed != null)
      lines.push(`**Lines:** +${added ?? 0} / -${removed ?? 0}`);
  }

  const sub = data.subscription_type as string | undefined;
  if (sub) lines.push(`**Plan:** ${sub}`);

  const rl = data.rate_limits as Record<string, unknown> | undefined;
  if (rl) {
    lines.push("", "### Rate Limits");
    for (const key of ["five_hour", "seven_day"] as const) {
      const w = rl[key] as Record<string, unknown> | undefined;
      if (!w) continue;
      const util = w.utilization as number;
      const resets = w.resets_at as string | undefined;
      const label = key === "five_hour" ? "5-hour" : "7-day";
      const bar = renderBar(util);
      const resetStr = resets ? ` (resets ${new Date(resets).toLocaleTimeString()})` : "";
      lines.push(`**${label}:** ${bar} ${util.toFixed(1)}%${resetStr}`);
    }
  }

  return lines.join("\n");
}

function formatContextUsage(context: ContextUsage | null | undefined, model: string): string {
  const lines = ["## Context Usage", `**Model:** ${model}`];
  if (context === undefined) return [...lines, "**Occupancy:** Empty"].join("\n");
  if (context === null) return [...lines, "**Occupancy:** Unknown"].join("\n");
  const { tokens, window, estimated } = context;
  const pct = (tokens / window) * 100;
  lines.push(
    `**Tokens${estimated ? " (estimate)" : ""}:** ${(tokens / 1000).toFixed(1)}k / ${(window / 1000).toFixed(1)}k ${renderBar(pct)} ${pct.toFixed(1)}%`,
  );
  return lines.join("\n");
}

function renderBar(pct: number): string {
  const filled = Math.max(0, Math.min(20, Math.round(pct / 5)));
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

// A turn the user stopped keeps what it said, marked.
function withInterrupted(content: string): string {
  return content ? `${content}\n\n*\\[interrupted\\]*` : "*\\[interrupted\\]*";
}

function isContextClearedMessage(msg: Message): boolean {
  return msg.kind === "system" && msg.content.endsWith(" context cleared");
}

function isCompactedEvent(event: StreamEvent): boolean {
  return event.kind === "compact" && /^Context compacted\b/.test(event.content);
}

function isCompactedMessage(msg: Message): boolean {
  return Boolean(msg.events?.some(isCompactedEvent));
}
