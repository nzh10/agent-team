import * as fs from "node:fs";
import * as path from "node:path";
import { applyExtensionUi } from "../../../shared/extension-ui";
import { validatePiAttachments } from "../session/pi";
import {
  SessionConfig,
  StreamEvent,
  SessionState,
  CommandInfo,
  ContextUsage,
  RunState,
  BackgroundTask,
  ThinkingStats,
  MessageStatus,
  PromptEnvelope,
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
  context?: ContextUsage;
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
  state: RunState;
  activity: string | null;
  effort: string | null;
  // The levels /effort takes for its model.
  effortLevels: string[];
  fast: boolean;
  // Background work the agent is waiting on (see RunState "waiting").
  backgroundTasks: BackgroundTask[];
  // Context occupancy at the end of its last turn, when known.
  context: ContextUsage | null;
  // A scheduled wake-up it is sleeping until.
  wake: { at: number; reason: string } | null;
}

export interface AgentState extends AgentInfo {
  session: SessionState;
  // AgentEntry.delivered, and whether the agent got another message since.
  delivered?: TurnInput & { since?: boolean };
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
  // Messages since any client last showed the session: one count for every
  // device, so a reply read on the phone is read on the desktop too.
  unread: number;
}

export interface WorkspaceState {
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
  unread?: number;
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
  // Context at the end of the last turn; undefined until looked up.
  lastContext?: ContextUsage | null;
  // The message the agent got last, and the last one from another session
  // (the same record while nothing came after it).
  input?: TurnInput;
  delivered?: TurnInput;
}

// A message an agent got and the turns it drove: their replies (a wake-up's
// included, not a local command's), what cut the latest short, and whether
// its sender has heard what came of it.
export interface TurnInput {
  id: string;
  replies: string[];
  stopped?: "user" | "restart";
  answered?: boolean;
  // Background work or a wake-up was still to come: a crash cuts it off.
  waiting?: boolean;
}

export interface WorkspaceCallbacks {
  onNewMessage: (wsId: string, msg: Message) => void;
  onStreamEvent: (wsId: string, msg: Message, event: StreamEvent) => void;
  onMessageDone: (
    wsId: string,
    msgId: string,
    status: MessageStatus,
    content: string,
    events?: StreamEvent[],
    patch?: Partial<Pick<Message, "context" | "effort" | "thinking">>,
  ) => void;
  onAgentBusy?: (wsId: string, agentId: string) => void;
  onAgentIdle?: (wsId: string, agentId: string) => void;
  onSaveNow?: () => void;
  onReportDeliveryState?: (
    reportId: string,
    state: "dispatching" | "sent_to_pi" | "outcome_unknown" | "error" | "settled",
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
    info: { rateLimitType?: string; resetsAt?: number },
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
  // Provider settings a model runs with.
  sessionEnv?: (model: string, account?: string) => Record<string, string> | undefined;
  piConfig?: () => Partial<SessionConfig>;
  onSessionReplaced?: (workspace: Workspace, session: HostSessionHandle) => void;
}

// Persisted events from older versions may lack fields the renderer
// indexes (content), and running tasks cannot survive a restart — at any
// nesting depth.
export function normalizeEvents(events: StreamEvent[]): void {
  for (const ev of events) {
    if (typeof ev.content !== "string") ev.content = "";
    const sa = ev.subagent;
    if (!sa) continue;
    if (ev.kind === "subagent_start" && (sa.status === "running" || sa.status == null)) {
      sa.status = "stopped";
    } else if (sa.status === "running") {
      sa.status = "stopped";
    }
    if (sa.events) normalizeEvents(sa.events);
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

function copySubagentExecution(target: StreamEvent, source: StreamEvent): void {
  if (!target.subagent || !source.subagent) return;
  const { model, effort } = source.subagent;
  if (model != null) target.subagent.model = model;
  if (effort != null) target.subagent.effort = effort;
}

// Apply an inner event to a subagent's transcript. Carriers nest: a
// grandchild's event arrives as progress(child, _innerEvent: progress(grand,
// _innerEvent: ev)), so recurse into the nested start's own transcript.
function applyInnerEvent(saEvents: StreamEvent[], innerEvent: StreamEvent): void {
  if (innerEvent.kind === "tool_result" && innerEvent.toolUseId) {
    const i = saEvents.findIndex(
      (e) => e.kind === "tool_use" && e.toolUseId === innerEvent.toolUseId,
    );
    if (i >= 0) {
      saEvents[i].toolResult = innerEvent.content;
      if (innerEvent.isMarkdown) saEvents[i].toolResultIsMarkdown = true;
      if (innerEvent.isError) saEvents[i].toolResultIsError = true;
      if (innerEvent.durationMs != null) saEvents[i].durationMs = innerEvent.durationMs;
      return;
    }
  }
  if (innerEvent.kind === "subagent_progress" && innerEvent.subagent?.taskId) {
    const nid = innerEvent.subagent.taskId;
    const nested = innerEvent.subagent._innerEvent;
    if (nested) {
      const si = saEvents.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === nid,
      );
      if (si >= 0) applyInnerEvent((saEvents[si].subagent!.events ??= []), nested);
      // No start here: the carrier has nowhere to go; drop it.
      return;
    }
    const i = saEvents.findIndex(
      (e) => e.kind === "subagent_progress" && e.subagent?.taskId === nid,
    );
    if (i >= 0) {
      saEvents[i] = innerEvent;
      return;
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
      copySubagentExecution(saEvents[si], innerEvent);
      saEvents[si].subagent!.status = innerEvent.subagent.status;
      saEvents[si].subagent!.summary = innerEvent.subagent.summary;
      saEvents[si].subagent!.usage = innerEvent.subagent.usage;
      saEvents[si].subagent!.durationMs = innerEvent.subagent.durationMs;
    }
  }
  saEvents.push(innerEvent);
}

export class Workspace {
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
  // Messages since a client last showed it (WorkspaceInfo.unread).
  unseen = 0;
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
    stopped?: "user" | "restart";
    answered: boolean;
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
        since: a.input !== d,
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
    stopped?: "user" | "restart";
  }> {
    const out = [];
    for (const [agentId, a] of this.agents) {
      const t = a.input;
      if (t) {
        const input = this.messages.find((m) => m.id === t.id);
        if (!input) continue;
        const replies = this.messages.filter((m) => t.replies.includes(m.id));
        out.push({ agentId, input, replies, stopped: t.stopped });
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
      const replies = this.messages.slice(i + 1, next).filter((m) => m.agentId === agentId);
      out.push({ agentId, input: this.messages[i], replies });
    }
    return out;
  }

  // Archived: no retry is left to run, and nobody waits on a word from it.
  settleForArchive(): void {
    for (const a of this.agents.values()) {
      this.dropRetry(a);
      if (a.delivered) a.delivered.answered = true;
    }
  }

  // The session no longer reports to the lead: a rate-limit retry of what
  // the lead sent is not run.
  dropLeadRetries(): void {
    for (const a of this.agents.values()) {
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
    this.cb?.onStreamEvent(this.id, msg, timed);
  }

  private finished(
    id: string,
    status: MessageStatus,
    content: string,
    events?: StreamEvent[],
    patch?: Partial<Pick<Message, "context" | "effort" | "thinking">>,
  ): void {
    this.changed.add(id);
    this.cb?.onMessageDone(this.id, id, status, content, events, patch);
  }

  private pushMessage(msg: Message): void {
    this.messages.push(msg);
    if (msg.timestamp > this.lastActivityAt) this.lastActivityAt = msg.timestamp;
    this.unseen++;
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
    for (const m of messages) restoreMessage(m);
    this.messages = messages;
    this.messagesLoaded = true;
    const last = messages[messages.length - 1];
    if (last && last.timestamp > this.lastActivityAt) this.lastActivityAt = last.timestamp;
  }

  private pushSystemMessage(content: string): void {
    const msg: Message = {
      id: genId("msg"),
      kind: "system",
      agentId: null,
      content,
      timestamp: Date.now(),
      status: "done",
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
      this.cb?.onAgentIdle?.(this.id, entry.info.id);
    }
  }

  private ensureAgentMsg(entry: AgentEntry): Message {
    if (!entry.currentMsg) {
      // A turn the CLI started itself: no prompt of ours to retry, unless
      // one is still waiting for its retry.
      if (entry.openingPrompt) entry.openingPrompt.replied = true;
      else if (!entry.retryPending) entry.lastEnvelope = undefined;
      entry.currentMsg = this.makeAgentMsg(entry.info.id);
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

    if (event.kind === "subagent_progress") {
      const innerEvent = event.subagent?._innerEvent;
      const startIdx = msg.events.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === taskId,
      );

      if (innerEvent && startIdx >= 0) {
        // Codex streams its child transcript incrementally; Pi supplies an authoritative final transcript.
        if (this.agents.get(msg.agentId ?? "")?.session.getState().config.backend === "codex") {
          const saEvents = (msg.events[startIdx].subagent!.events ??= []);
          applyInnerEvent(saEvents, innerEvent);
        }
        this.streamed(msg, event);
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
        copySubagentExecution(msg.events[startIdx], event);
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
        copySubagentExecution(start, event);
        const started = start.subagent!;
        if (finished?.events) {
          started.events = finished.events;
          started.eventCount = finished.events.length;
        }
        started.status = finished?.status;
        started.summary = finished?.summary;
        started.usage = finished?.usage;
        if (finished?.durationMs != null) started.durationMs = finished.durationMs;
      }
      if (finished?.events) {
        const { events, ...summary } = finished;
        event = { ...event, subagent: { ...summary, eventCount: events.length } };
      }
      const progIdx = msg.events.findIndex(
        (e) => e.kind === "subagent_progress" && e.subagent?.taskId === taskId,
      );
      if (progIdx >= 0) msg.events.splice(progIdx, 1);
      msg.events.push(event);
    }
    this.streamed(msg, event);
  }

  // Subagent events can arrive after the message containing subagent_start is
  // finalized. Search backwards to find the message that owns this subagent.
  private findToolUseOwner(toolUseId: string): Message | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.events?.some((e) => e.kind === "tool_use" && e.toolUseId === toolUseId)) return m;
    }
    return null;
  }

  private findSubagentOwner(taskId: string): Message | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.events?.some((e) => e.kind === "subagent_start" && e.subagent?.taskId === taskId)) {
        return m;
      }
    }
    return null;
  }

  private createEventHandler(agentId: string): (event: StreamEvent) => void {
    return (event: StreamEvent) => {
      const entry = this.agents.get(agentId);
      if (!entry) return;

      // Route subagent events to the message containing their subagent_start,
      // even if that message was already finalized. This prevents orphaned
      // subagent entries from appearing in a new message bubble.
      if (event.kind === "subagent_progress" || event.kind === "subagent_done") {
        if (
          !this.messagesLoaded &&
          (event.kind !== "subagent_done" || !this.cb?.ensureLoaded?.(this))
        )
          return;
        const taskId = event.subagent?.taskId;
        if (taskId) {
          const ownerMsg = this.findSubagentOwner(taskId);
          if (ownerMsg && ownerMsg !== entry.currentMsg) {
            this.handleSubagentOnMsg(ownerMsg, event);
            if (event.kind === "subagent_done") this.cb?.onSaveNow?.();
            return;
          }
        }
      }

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
        this.cb?.onAgentBusy?.(this.id, agentId);
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
        if (entry.currentMsg) {
          // Defense in depth: a turn that ends with neither text nor any
          // visible event is a failure (CLI crash, network drop, spawn
          // problem) — render a diagnostic instead of a silent empty bubble.
          if (event.interrupted) {
            if (entry.input) entry.input.stopped = "user";
            entry.currentMsg.content = withInterrupted(entry.currentMsg.content);
          } else if (!entry.currentMsg.content.trim() && !(entry.currentMsg.events ?? []).length) {
            entry.currentMsg.content =
              "*(no output — the session ended without producing anything; check network/credentials or server logs)*";
          }
          entry.currentMsg.status = "done";
          clearLiveTiming(entry.currentMsg);
          // The retry succeeded; "API retry 2/10 in 5s" is no longer true.
          clearRetry(entry.currentMsg);
          if (event.context) {
            entry.currentMsg.context = event.context;
            entry.lastContext = event.context;
            this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
          }
          if (event.effort) entry.currentMsg.effort = event.effort;
          if (event.thinking) entry.currentMsg.thinking = event.thinking;
          const patch = {
            ...(event.context && { context: event.context }),
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
          // A turn the model answered while a retry waits (a wake-up, a
          // task's report): the limit is over. That turn saw the cut prompt,
          // so the retry carries on rather than sending it again, and now.
          if (entry.retryPending && answered(entry.currentMsg)) {
            entry.lastEnvelope = undefined;
            entry.pausedUntil = Date.now();
          }
        }
        this.finishReply(entry);
      } else if (event.kind === "error") {
        // The error is an event (rendered as a red banner where it
        // happened); appending it to the text as well showed it twice.
        const msg = this.ensureAgentMsg(entry);
        clearRetry(msg);
        // The model saw the prompt a waiting retry would send: it carries on.
        if (entry.retryPending && answered(msg)) entry.lastEnvelope = undefined;
        msg.status = "error";
        clearLiveTiming(msg);
        event.contentOffset = msg.content.length;
        msg.events!.push(event);
        this.streamed(msg, event);
        this.finished(msg.id, "error", msg.content, msg.events);
        this.finishReply(entry);
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
        this.streamed(msg, event);
      }
    };
  }

  private finishReply(entry: AgentEntry): void {
    entry.currentMsg = null;
    // A terminal event can arrive before send() has resolved. Leave the
    // input fenced until its receipt arrives, then notify idle after settlement.
    if (entry.openingPrompt?.input) return;
    entry.openingPrompt = undefined;
    this.cb?.onAgentIdle?.(this.id, entry.info.id);
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
      if (entry.activeReportId) {
        this.cb?.onReportDeliveryState?.(entry.activeReportId, "settled", {
          settledAt: Date.now(),
        });
        entry.activeReportId = undefined;
      }
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
      if (entry) entry.runState = state;
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

  // Returns the ids of the agent's queued messages, which are dropped with
  // it; null if there is no such agent.
  removeAgent(agentId: string): string[] | null {
    const entry = this.agents.get(agentId);
    if (!entry) return null;

    this.cancelOpeningPrompt(entry, "Agent removed");
    void this.releaseSession(agentId, entry);
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
      if (!heir || !m.from) continue;
      m.queuedFor = heir.info.id;
      delete m.steering;
      this.changed.add(m.id);
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
      return (
        agent.session
          .getContextUsage?.()
          .then((data) => (data ? formatContextUsage(data) : NO_ACTIVE_SESSION)) ??
        NO_ACTIVE_SESSION
      );
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
    const providerEnv = this.cb?.sessionEnv?.(next, agent.info.account);
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
        providerEnv,
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
      agent.session.setProviderEnv?.(providerEnv);
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
    const busy = retried || this.dispatchHeld(agent) || this.held(agent) || this.hasQueued(agent);
    const steering = busy && !retried && this.steerable(agent);
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
    this.enqueue(userMsg, { inputId: userMsg.id, text: prompt, attachmentIds });
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
      !this.held(entry) &&
      !entry.openingPrompt &&
      !entry.recoveringDispatching;
    if (!available()) return;
    const msg = this.messages.find(
      (item) => item.queuedFor === agentId && item.status === "queued",
    );
    const envelope = msg?.queuedEnvelope;
    if (!msg || !envelope || envelope.reportId || envelope.text.trimStart().startsWith("/")) return;
    return {
      envelope,
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
        return true;
      },
      finish: (outcome) => {
        if (msg.status !== "dispatching") return;
        if (outcome === "rejected") {
          msg.status = "queued";
          this.finished(msg.id, msg.status, msg.content);
        } else if (outcome === "read") this.steered(agentId, msg.id);
        else this.completeDispatch(msg, outcome === "handled" ? "done" : outcome);
      },
    };
  }

  // A message handed to the running turn stays queued until the model reads
  // it (steered); not taken, it waits like any other.
  private async steer(agent: AgentEntry, msg: Message): Promise<void> {
    const taken = await agent.session.steer!(msg.queuedEnvelope?.text ?? msg.content, msg.id).catch(
      () => false,
    );
    // Given back meanwhile (unread) when the turn ended under the request.
    if (taken || !msg.steering) return;
    delete msg.steering;
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
    entry.input = { id: msg.id, replies: [] };
    if (msg.from) entry.delivered = entry.input;
    entry.currentMsg = this.makeAgentMsg(agentId);
    entry.input.replies.push(entry.currentMsg.id);
    this.pushMessage(entry.currentMsg);
  }

  // Steered messages a turn ended without reading: the queue's again, and
  // it runs them next; the lead's, once the session no longer reports to
  // it, are dropped.
  private unread(ids: string[]): void {
    const back = this.messages.filter((m) => m.steering && ids.includes(m.id));
    for (const m of back) {
      delete m.steering;
      if (this.projectLink?.unreported && (m.from?.role === "lead" || m.from?.role === "panel")) {
        this.messages.splice(this.messages.indexOf(m), 1);
        this.cb?.onMessageRemoved?.(this.id, m.id);
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
    const queued = this.dispatchHeld(agent) || paused || waiting;
    const steering = queued && this.steerable(agent);
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

  // `banner` opens the reply of a turn no message of the user's started.
  private async dispatchPrompt(
    agent: AgentEntry,
    prompt: PromptEnvelope | string,
    input?: Message,
    banner?: StreamEvent,
  ): Promise<void> {
    const envelope =
      typeof prompt === "string" ? { inputId: genId("input"), text: prompt } : prompt;
    const opening = { envelope, input, writeClaimed: false, replied: false };
    agent.openingPrompt = opening;
    agent.lastEnvelope = envelope.reportId ? undefined : envelope;
    if (input) {
      input.queuedEnvelope ??= envelope;
      agent.input = { id: input.id, replies: [] };
      if (input.from) agent.delivered = agent.input;
    }
    if (agent.currentMsg) this.settle(agent.currentMsg);
    agent.currentMsg = null;
    this.cb?.onAgentBusy?.(this.id, agent.info.id);

    try {
      if (input?.status === "queued") {
        input.status = "starting";
        this.finished(input.id, input.status, input.content);
      }
      if (banner) {
        this.ensureAgentMsg(agent);
        agent.handler(banner);
      }
      const backend = agent.session.getState().config.backend;
      const receipt = await agent.session.send(
        backend === "pi" || backend === "codex" ? envelope : envelope.text,
        {
          onBeforeWrite: (attempt) => {
            this.assertWritable();
            if (agent.openingPrompt !== opening) throw new Error("Prompt dispatch cancelled");
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
      if (agent.openingPrompt !== opening) return;
      if (receipt?.disposition === "rejected") {
        if (receipt.retryable && input) {
          this.touch([input.id]);
          input.status = "queued";
          delete input.dispatchAttempt;
          this.cb?.onSaveNow?.();
          agent.openingPrompt = undefined;
          this.finished(input.id, "queued", input.content);
          this.settleIdleReply(agent);
          setTimeout(() => this.dequeueNext(agent.info.id), 100);
        } else {
          this.failDispatch(agent, input, "error", receipt.error ?? "Prompt rejected");
        }
      } else if (receipt?.disposition !== "started") {
        const handled = receipt?.disposition === "handled";
        this.acceptDispatch(agent, envelope.inputId, !handled);
        if (handled) agent.activeReportId = undefined;
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
    }
  }

  private enqueue(msg: Message, envelope: PromptEnvelope): void {
    this.assertWritable();
    msg.queuedEnvelope = envelope;
    this.messages.push(msg);
    this.touch([msg.id]);
    try {
      this.cb?.onSaveNow?.();
    } catch (error) {
      const idx = this.messages.lastIndexOf(msg);
      if (idx >= 0) this.messages.splice(idx, 1);
      this.changed.delete(msg.id);
      throw error;
    }
    if (msg.timestamp > this.lastActivityAt) this.lastActivityAt = msg.timestamp;
    this.unseen++;
    this.cb?.onNewMessage(this.id, msg);
  }

  private completeDispatch(
    msg: Message,
    status: "done" | "error" | "outcome_unknown",
    errorMessage?: string,
  ): void {
    const reportId = msg.dispatchAttempt?.reportId ?? msg.queuedEnvelope?.reportId;
    this.touch([msg.id]);
    msg.status = status;
    delete msg.queuedEnvelope;
    delete msg.queuedFor;
    this.cb?.onSaveNow?.();
    if (reportId)
      this.cb?.onReportDeliveryState?.(
        reportId,
        status === "done" ? "sent_to_pi" : status,
        status === "done" ? { acceptedByPiAt: Date.now() } : { errorMessage },
      );
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
    const msg = opening.input;
    if (msg) {
      entry.activeReportId = opening.envelope.reportId;
      this.completeDispatch(msg, "done");
    }
    if (started && entry.session.isRunning && !opening.replied) this.ensureAgentMsg(entry);
    entry.openingPrompt = undefined;
    setTimeout(() => this.dequeueNext(entry.info.id), 0);
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
    this.cb?.onAgentIdle?.(this.id, entry.info.id);
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

  ensureReportQueued(
    id: string,
    agentId: string,
    envelope: PromptEnvelope,
    from: MessageOrigin,
    content: string,
  ): Message {
    const existing = this.findMessage(id);
    if (existing) return existing;
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
      if (msg.status === "starting")
        this.completeDispatch(msg, "error", "Server restarted before sending the message");
    }
  }

  settlePlainDispatchingOnRestore(): void {
    for (const msg of this.messages) {
      if (
        msg.status === "dispatching" &&
        (!msg.dispatchAttempt?.reportId || !msg.queuedFor || !this.agents.has(msg.queuedFor))
      ) {
        this.completeDispatch(msg, "outcome_unknown");
      }
    }
  }

  async recoverDispatchingReport(
    msg: Message,
    commit: (settle: () => void) => Promise<void>,
    probe = true,
  ): Promise<void> {
    const entry = this.agents.get(msg.queuedFor ?? "");
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
          found = result?.found === true && !result.anchorMissing;
        } catch {
          /* No positive proof: never resend. */
        }
      }
      await commit(() => {
        if (msg.status === "dispatching")
          this.completeDispatch(msg, found && this.isWritable() ? "done" : "outcome_unknown");
      });
    } finally {
      entry.recoveringDispatching = false;
    }
  }

  private hasQueued(agent: AgentEntry): boolean {
    return this.messages.some((msg) => msg.status === "queued" && msg.queuedFor === agent.info.id);
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
    const msg = this.messages.find(
      (m) => m.status === "queued" && m.queuedFor === agentId && !m.steering,
    );
    if (!msg) {
      // After the queue, as the CLI orders its own wake-ups.
      const wake = entry.session.wakeDue ? entry.session.takeWake?.() : null;
      if (wake) {
        void this.dispatchPrompt(entry, wake.prompt, undefined, {
          kind: "notice",
          level: "wakeup",
          content:
            "Scheduled wake-up fired — sent by the panel: the CLI process that held it is gone.",
        });
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
    entry.pausedUntil = undefined;
    entry.retryPending = false;
    if (entry.lastEnvelope) {
      void this.dispatchPrompt(entry, entry.lastEnvelope);
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
    const busy = retried || this.dispatchHeld(agent) || this.held(agent) || this.hasQueued(agent);
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
    this.enqueue(userMsg, { inputId: userMsg.id, text: prompt });
    if (busy) return;

    await this.dispatchPrompt(agent, userMsg.queuedEnvelope!, userMsg);
  }

  cancelSubagent(agentId: string, taskId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent not found: ${agentId}`);
    if (!entry.session.stopTask) throw new Error("This backend does not support stopping tasks");
    return entry.session.stopTask(taskId);
  }

  abortAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    const busy = this.hasWork(entry);
    this.cancelOpeningPrompt(entry, "Cancelled by user");
    entry.session.abort();
    this.finalizeAbort(entry, busy);
  }

  abortAll(by: "user" | "restart" = "user"): void {
    for (const entry of this.agents.values()) {
      const busy = this.hasWork(entry);
      if (by === "user") this.cancelOpeningPrompt(entry, "Cancelled by user");
      entry.session.abort();
      this.finalizeAbort(entry, busy, by);
    }
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
    const inputBefore = entry.input?.id;
    const msgBefore = entry.currentMsg?.id;
    if (
      session.isRunning &&
      !(await session.interrupt()) &&
      session.isRunning &&
      entry.input?.id === inputBefore &&
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
    this.cb?.onAgentUpdated?.(this.id, this.agentInfo(entry), true);
    return null;
  }

  private finalizeAbort(entry: AgentEntry, busy: boolean, by: "user" | "restart" = "user"): void {
    if (busy && entry.input) entry.input.stopped = by;
    if (by === "user") this.dropRetry(entry);
    if (entry.currentMsg && entry.currentMsg.status === "streaming") {
      entry.currentMsg.content = withInterrupted(entry.currentMsg.content);
      this.settle(entry.currentMsg);
    }
    entry.currentMsg = null;
    this.settleStale(entry);
    this.cb?.onAgentIdle?.(this.id, entry.info.id);
    setTimeout(() => this.dequeueNext(entry.info.id), 0);
  }

  clearContext(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    if (this.dispatchHeld(entry)) return false;
    if (this.hasWork(entry) && entry.input) entry.input.stopped = "user";
    this.dropRetry(entry);
    if (entry.session.resetContext) entry.session.resetContext();
    else {
      entry.session.abort();
      entry.session.sessionId = null;
    }
    entry.lastContext = null;
    entry.session.usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turns: 0,
      duration_ms: 0,
    };
    this.settleStale(entry);
    this.pushSystemMessage(`${entry.info.avatar} **${entry.info.name}** context cleared`);
    return true;
  }

  private agentState(a: AgentEntry): RunState {
    return a.runState ?? a.session.runState ?? (a.session.isRunning ? "working" : "idle");
  }

  agentInfo(a: AgentEntry): AgentRuntimeInfo {
    const state = a.session.getState();
    return {
      ...a.info,
      canSwitchBackend: this.canSwitchBackend(a, state),
      busy: a.session.isRunning || !!a.openingPrompt,
      state: this.agentState(a),
      activity: a.activity ?? null,
      effort: state.config.effort ?? null,
      effortLevels: this.effortLevels(a, a.info.model) ?? [],
      fast: Boolean(state.config.fast),
      backgroundTasks: a.session.backgroundTaskList ?? [],
      context: this.lastContext(a),
      wake: a.session.wake ?? null,
    };
  }

  // From the newest reply that recorded one; an unloaded history (archived)
  // leaves it unknown.
  private lastContext(a: AgentEntry): ContextUsage | null {
    if (a.lastContext !== undefined) return a.lastContext;
    if (!this.messagesLoaded) return null;
    let found: ContextUsage | null = null;
    for (let i = this.messages.length - 1; i >= 0 && !found; i--) {
      const m = this.messages[i];
      if (m.agentId === a.info.id && m.context) found = m.context;
    }
    a.lastContext = found;
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
    };
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
      agents: [...this.agents.values()].map((a) => {
        const session = a.session.getState();
        // Account tokens and provider keys: recomputed from config.toml on
        // restore, never written to the state files.
        return {
          ...a.info,
          session: { ...session, config: { ...session.config, providerEnv: undefined } },
          ...(a.delivered && {
            delivered: { ...a.delivered, ...(a.input !== a.delivered && { since: true }) },
          }),
          ...(a.retryPending && { pausedUntil: a.pausedUntil, lastEnvelope: a.lastEnvelope }),
        };
      }),
      ...(this.messagesLoaded && { messages: this.messages.map(withoutLiveTiming) }),
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      archivedAt: this.archivedAt,
      ...(this.projectLink && { projectLink: this.projectLink }),
      ...(this.unseen && { unread: this.unseen }),
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
    ws.unseen = state.unread ?? 0;
    // No messages: the history could not be read, and a save must not
    // write an empty one over it.
    ws.messagesLoaded = state.messages !== undefined;
    const cut = new Set<string>();
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
      if (restoreMessage(msg)) ws.touch([msg.id]);
      return msg;
    });
    // Queued for an agent that no longer exists: nothing will ever run it.
    const agentIds = new Set(state.agents.map((a) => a.id));
    ws.messages = ws.messages.filter(
      (m) => m.status !== "queued" || !m.queuedFor || agentIds.has(m.queuedFor),
    );
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
      });
      if (agentState.delivered) {
        const { since, waiting, ...delivered } = agentState.delivered;
        if (waiting || cut.has(delivered.replies[delivered.replies.length - 1])) {
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
  if (msg.status !== "streaming") return event;
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
      (e.kind === "subagent_start" && e.subagent?.status === "running"),
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

function restoreMessage(msg: Message & { queuedPrompt?: string }): boolean {
  clearLiveTiming(msg);
  if (msg.events) normalizeEvents(msg.events);
  if (msg.queuedPrompt === undefined) return false;
  msg.queuedEnvelope ??= { inputId: msg.id, text: msg.queuedPrompt };
  delete msg.queuedPrompt;
  return true;
}

// The model answered in the reply: text, thinking or a tool call, not just
// the notices and retry banners of a turn the API refused.
function answered(msg: Message): boolean {
  const output = ["thinking", "tool_use", "subagent_start"];
  return !!msg.content.trim() || !!msg.events?.some((e) => output.includes(e.kind));
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

function formatContextUsage(data: Record<string, unknown>): string {
  const total = data.totalTokens as number | undefined;
  const max = data.maxTokens as number | undefined;
  const pct = data.percentage as number | undefined;
  const model = data.model as string | undefined;
  const categories = data.categories as Array<Record<string, unknown>> | undefined;

  const lines: string[] = ["## Context Usage"];
  if (model) lines.push(`**Model:** ${model}`);
  if (total != null && max != null) {
    const bar = renderBar(pct ?? (total / max) * 100);
    lines.push(
      `**Tokens:** ${(total / 1000).toFixed(1)}k / ${(max / 1000).toFixed(1)}k ${bar} ${(pct ?? 0).toFixed(1)}%`,
    );
  }

  if (categories?.length) {
    lines.push("", "| Category | Tokens | % |", "|---|---:|---:|");
    for (const c of categories) {
      const name = c.name as string;
      const tokens = c.tokens as number;
      const share = max ? ((tokens / max) * 100).toFixed(1) : "—";
      lines.push(`| ${name} | ${(tokens / 1000).toFixed(1)}k | ${share}% |`);
    }
  }

  const api = data.apiUsage as Record<string, number> | undefined;
  if (api) {
    lines.push("", "### API Usage (this session)");
    lines.push(`- **Input:** ${(api.input_tokens / 1000).toFixed(1)}k`);
    lines.push(`- **Output:** ${(api.output_tokens / 1000).toFixed(1)}k`);
    if (api.cache_read_input_tokens)
      lines.push(`- **Cache read:** ${(api.cache_read_input_tokens / 1000).toFixed(1)}k`);
    if (api.cache_creation_input_tokens)
      lines.push(`- **Cache write:** ${(api.cache_creation_input_tokens / 1000).toFixed(1)}k`);
  }

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
