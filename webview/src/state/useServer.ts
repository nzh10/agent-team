import {
  TRACE_MAX_BYTES,
  TRACE_MAX_EVENTS,
  traceBytes,
  type TracePage,
  type TraceTarget,
  type TraceWindow,
} from "../../../shared/subagent-trace";
import type { SubagentStatus } from "../../../shared/subagent-status";
import type { ContextUsage } from "../../../shared/context-usage";
import { configureTelemetry, recordTelemetry } from "../telemetry";
import type { TelemetryAction } from "../../../shared/telemetry";
import { emptyUi, receiveUi, withoutOwner, type LiveNotice } from "./extensionUi";
import {
  sameAgent,
  type ExtensionUiEvent,
  type ExtensionUiSnapshot,
} from "../../../shared/extension-ui";
import type { QuotaState } from "../../../shared/quota";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  MOCK_WORKSPACES,
  MOCK_PROJECTS,
  MOCK_PROJECT_WORKSPACES,
  MOCK_SYSTEM_STATUS,
  MOCK_PRESETS,
  MOCK_MODELS,
} from "../dev/mockData";
import {
  applyStreamBatch,
  downgradedMessageIds,
  mergeLatestPage,
  PendingEvent,
  withoutLiveTiming,
} from "./stream";
import { retainInactiveTranscripts } from "./transcriptRetention";

// Liveness probing. Mobile browsers freeze the page when the screen turns off
// or the app goes to the background and the socket often dies underneath it
// without a close event, so the UI would sit on "working" forever. Probe on
// every return to the foreground and on a slow timer while visible; a probe
// with no answer means the socket is dead and gets replaced.
export const PROBE_TIMEOUT_MS = 5_000;
export const HEARTBEAT_MS = 30_000;
const RECONNECT_DELAY_MS = 2_000;
// Hidden tabs get no animation frames; stream events still need applying.
export const HIDDEN_FLUSH_MS = 1_000;

export interface ToolInput {
  tool: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

export interface SubAgentInfo {
  taskId: string;
  description: string;
  model?: string;
  effort?: string;
  agentType?: string;
  // SDK task type; absent on older records (all agents).
  taskType?: string;
  status?: SubagentStatus;
  lastTool?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  // From the task's start to its end: every kind of task.
  durationMs?: number;
  summary?: string;
  transcriptRevision?: number;
  eventCount?: number;
  cancellable?: boolean;
}

export type NoticeLevel = "info" | "notice" | "warning" | "error" | "schedule" | "wakeup" | "skill";

export type RunState = "idle" | "working" | "waiting" | "sleeping";

export interface GitInfo {
  branch: string | null;
  dirty: number;
  ahead: number;
  behind: number;
}

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  checks: "success" | "failure" | "pending" | null;
}

// Thinking over a whole turn (Claude only).
export interface ThinkingStats {
  tokens: number;
  durationMs: number;
}

export interface StreamEvent {
  kind: string;
  content: string;
  toolName?: string;
  level?: NoticeLevel;
  toolInput?: ToolInput;
  step?: number;
  contentOffset?: number;
  toolUseId?: string;
  isMarkdown?: boolean;
  // A tool_result the tool reported as failed.
  isError?: boolean;
  toolResult?: string;
  toolResultIsMarkdown?: boolean;
  toolResultIsError?: boolean;
  // A finished thinking block: how long it took and, once its API call
  // ends, how many tokens it spent. A tool call: from call to result.
  durationMs?: number;
  // A closing thinking_delta immediately followed by a persisted thinking event.
  thinkingFollows?: true;
  // Start of a tool call or a live thinking block.
  startedAt?: number;
  waitingSince?: number | null;
  tokens?: number;
  context?: ContextUsage | null;
  subagent?: SubAgentInfo;
  // Present on summary pages instead of the bodies.
  contentLength?: number;
  bodyLength?: number;
  resultLength?: number;
}

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

export type ProjectRole = "lead" | "worker";

export interface ProjectLink {
  projectId: string;
  role: ProjectRole;
  isolated?: boolean;
  unreported?: boolean;
}

export interface MessageOrigin {
  workspaceId: string;
  name: string;
  role: "lead" | "worker" | "peer" | "panel";
  projectId?: string;
}

// A project's objectives (server: project/objectives.ts).
export type ObjectiveStatus = "active" | "later" | "done" | "dropped";
export type Priority = "high" | "normal" | "low";
export type TaskState = "todo" | "doing" | "review" | "done" | "dropped";

export interface ObjectiveTask {
  id: string;
  text: string;
  state: TaskState;
  session?: string;
}

export interface ObjectiveDecision {
  id: string;
  question: string;
  outcome?: string;
}

export interface Objective {
  id: string;
  area: string;
  title: string;
  goal: string;
  status: ObjectiveStatus;
  priority: Priority;
  reason?: string;
  // Where it stands, and when and at which commit that was written.
  context?: string;
  contextWritten?: number;
  contextCommit?: string;
  dependsOn: string[];
  tasks: ObjectiveTask[];
  decisions: ObjectiveDecision[];
  sessions: string[];
  // Links to design docs.
  notes?: string;
  updatedAt: number;
  // In the archive, out of the board's main view.
  archived?: boolean;
}

// A file the server could not read.
export interface BrokenObjective {
  id: string;
  error: string;
  archived?: boolean;
}

// A project's issues, one module per file (server: project/issues.ts).
export type IssueState = "open" | "decision" | "accepted";
export type Evidence = "R" | "V" | "H" | "S" | "C";

export interface Issue {
  id: string;
  state: IssueState;
  evidence?: Evidence;
  tags: string[];
  // When its text was written, and at which commit.
  text: string;
  written?: number;
  commit?: string;
  objectives: string[];
}

export interface IssueGroup {
  id: string;
  title: string;
  notes?: string;
  objectives: string[];
  issues: Issue[];
}

export interface IssueModule {
  id: string;
  title: string;
  notes?: string;
  objectives: string[];
  issues: Issue[];
  groups: IssueGroup[];
  updatedAt: number;
}

// A module file the server could not read.
export interface BrokenIssueModule {
  id: string;
  error: string;
}

export type IssueModules = Array<IssueModule | BrokenIssueModule>;

export interface Project {
  id: string;
  name: string;
  root: string | null;
  leadWorkspaceId: string | null;
  createdAt: number;
  schemaVersion?: number;
  status?: "active" | "sealed";
  sealedAt?: number | null;
  sealedReason?: string | null;
  lead?: { hostId: string; workspaceId: string } | null;
  // Filed away: listed apart in the sidebar.
  archivedAt?: number | null;
  objectives: Array<Objective | BrokenObjective>;
}

export interface Message {
  id: string;
  kind: "user" | "agent" | "system";
  agentId: string | null;
  content: string;
  timestamp: number;
  status:
    "streaming" | "done" | "error" | "queued" | "starting" | "dispatching" | "outcome_unknown";
  events?: StreamEvent[];
  turnId?: string;
  images?: MessageImage[];
  forwardRef?: ForwardRef;
  queuedFor?: string;
  // The delivery status already revealed by the workspace.
  pendingDelivery?: "starting" | "sending";
  replyTo?: string;
  // Handed to the agent's running turn (Codex steer): no taking it back.
  steering?: boolean;
  // Sent by another session, not the user: the project's lead, one of its
  // sessions, or another project's lead (peer, named by its project).
  from?: MessageOrigin;
  effort?: string;
  fast?: boolean;
  // The model the turn ran on; an agent's model can change mid-session.
  model?: string;
  context?: ContextUsage | null;
  thinking?: ThinkingStats;
  // History pages arrive as summaries; full events load on first expand.
  detail?: "summary";
  // Text is client-only; the timestamps also arrive in streaming snapshots.
  liveThinking?: string;
  // Keep the body in place until the separately batched thinking event arrives.
  closingThinking?: string;
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
  canSwitchBackend?: boolean;
  busy?: boolean;
  networkWaiting?: boolean;
  retryPending?: boolean;
  state?: RunState;
  lastStreamAt?: number;
  retryLabel?: string;
  // Transient label of what the agent is doing (compacting, a long tool...).
  activity?: string | null;
  // Configured override and the backend's reasoning effort when known.
  effort?: string | null;
  effectiveEffort?: string;
  // The levels /effort takes for its model.
  effortLevels?: string[];
  fast?: boolean;
  // Background work the agent is waiting on (background Bash, subagents,
  // Monitor); the CLI reports back on its own when it finishes.
  backgroundTasks?: BackgroundTask[];
  // Context occupancy at its latest backend boundary, when known.
  context?: ContextUsage | null;
  // The scheduled wake-up it sleeps until.
  wake?: { at: number; reason: string } | null;
}

export interface BackgroundTask {
  id: string;
  type: string;
  description: string;
  since: number;
  status?: SubagentStatus;
  cancellable?: boolean;
}

export interface HostInfo {
  id: string;
  label: string;
  type: "local" | "remote";
  connected: boolean;
}

export interface HostConfig {
  label: string;
  type: "local" | "remote";
}

// Set before the page reloads itself for a new build: nobody asked for that
// load, so it is no sign that someone is at the screen.
export const AUTO_RELOAD = "agentTeamAutoReload";

export interface Workspace {
  id: string;
  name: string;
  project: string;
  hostId: string;
  cwd: string;
  git?: GitInfo | null;
  pr?: PrInfo | null;
  agents: AgentInfo[];
  messages: Message[];
  createdAt: number;
  lastMessageAt?: number;
  archivedAt?: number | null;
  projectLink?: ProjectLink;
  // A worker stopped on the user's reply (its task asked them something).
  awaitsUser?: boolean;
  // Actionable results since any client last read the session (server-owned).
  unread?: number;
  lastResult?: "done" | "failed";
  queued?: boolean;
  hasMore?: boolean;
  messagesLoaded?: boolean;
  // An older page has been requested and not yet arrived.
  loadingOlder?: boolean;
}

export interface SystemStatus {
  osName: string;
  osArch: string;
  cpuModel: string;
  cpuCores: number;
  cpuUsage: number;
  memTotal: number;
  memUsed: number;
  uptime: number;
  hostname: string;
}

export const DEFAULT_USER = { name: "You", avatar: "avatars/header.jpg" };

export interface AgentPreset {
  model?: string;
  effort?: string;
  name: string;
  avatar: string;
  color: string;
}

export interface ModelOption {
  id: string;
  label: string;
  backend: "pi" | "codex";
  // The effort levels it takes (none: it takes none), and the one it runs at
  // when none is chosen (`effort` the panel sets, else the backend's own).
  effortLevels?: string[];
  effort?: string;
  defaultEffort?: string;
}

export type CodexAuthStatus = "authenticated" | "unauthenticated" | "unavailable" | "error";

export interface CodexAuthState {
  cliAvailable: boolean;
  authenticated: boolean;
  status: CodexAuthStatus;
  accountType?: string | null;
  error?: string;
  checkedAt: number;
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  source?: "panel" | "pi" | "extension" | "skill" | "prompt";
}

export type CommandsByAgent = Record<string, Record<string, CommandInfo[]>>;

export type UiDialogMethod = "select" | "confirm" | "input" | "editor";

export interface UiDialogRequest {
  requestId: string;
  workspaceId: string;
  agentId: string;
  processGeneration: number;
  method: UiDialogMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeoutMs: number;
  createdAt: number;
  expiresAt: number;
}

export interface UiDialogAnswer {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

function sameDialog(a: UiDialogRequest, b: UiDialogRequest): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.agentId === b.agentId &&
    a.processGeneration === b.processGeneration &&
    a.requestId === b.requestId
  );
}

export interface SearchHit {
  workspaceId: string;
  workspaceName: string;
  messageId: string;
  timestamp: number;
  snippet: string;
}

function resolveWsUrl(): string {
  const loc = window.location;
  if (loc.port === "5173" || loc.port === "9800") {
    return `ws://${loc.hostname}:9800`;
  }
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}${loc.pathname}`;
}

export type SendOutcome = "not_sent" | "rejected" | "accepted" | "unknown";

function wsTelemetryAction(data: { type: string; force?: unknown }): TelemetryAction | undefined {
  switch (data.type) {
    case "send_message":
      return "chat.send";
    case "interrupt":
    case "abort":
    case "cancel_subagent":
      return "chat.stop";
    case "cancel_queued":
      return "chat.cancel_queued";
    case "cancel_wakeup":
      return "chat.cancel_wakeup";
    case "load_message_details":
      return "trace.load_details";
    case "archive_workspace":
      return "workspace.archive";
    case "unarchive_workspace":
      return "workspace.restore";
    case "refresh_quota":
      return data.force === true ? "quota.refresh" : undefined;
  }
}

export function useServer() {
  const useMock = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");
  const useReplay =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("replay");
  const [transcripts, setTranscripts] = useState<{
    workspaces: Workspace[];
    activeId: string | null;
    lastUsed: string[];
  }>({ workspaces: [], activeId: null, lastUsed: [] });
  const { workspaces } = transcripts;
  const setWorkspaces = useCallback(
    (update: Workspace[] | ((prev: Workspace[]) => Workspace[])) => {
      setTranscripts((prev) => {
        const next = typeof update === "function" ? update(prev.workspaces) : update;
        // Stand-alone dev fixtures have no server from which to reload a page.
        const workspaces =
          useMock || useReplay
            ? next
            : retainInactiveTranscripts(next, prev.activeId, prev.lastUsed);
        return workspaces === prev.workspaces ? prev : { ...prev, workspaces };
      });
    },
    [useMock, useReplay],
  );
  const [projects, setProjects] = useState<Project[]>([]);
  // By project; a project with no issues has no entry.
  const [issues, setIssues] = useState<Record<string, IssueModules>>({});
  const [connected, setConnected] = useState(false);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const traceRequestId = useRef(0);
  const traceReceivers = useRef(new Map<number, (page: TracePage) => void>());
  const [user, setUser] = useState(DEFAULT_USER);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [codexAuth, setCodexAuth] = useState<CodexAuthState | null>(null);
  const [recheckingCodexAuth, setRecheckingCodexAuth] = useState(false);
  const [globalCommands, setGlobalCommands] = useState<CommandInfo[]>([]);
  const [commandsByAgent, setCommandsByAgent] = useState<CommandsByAgent>({});
  const [commandTarget, setCommandTarget] = useState<{
    workspaceId: string;
    agentId: string;
  } | null>(null);
  const [extensionUi, setExtensionUi] = useState(emptyUi);
  const nextExpiry = extensionUi.notices[0]?.expiresAt;
  useEffect(() => {
    if (nextExpiry === undefined) return;
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setExtensionUi((prev) => ({
          ...prev,
          notices: prev.notices.filter((n) => n.expiresAt > now),
        }));
      },
      Math.max(0, nextExpiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  const dismissNotice = (notice: LiveNotice) =>
    setExtensionUi((prev) => ({ ...prev, notices: prev.notices.filter((n) => n !== notice) }));
  const [pendingDialogs, setPendingDialogs] = useState<UiDialogRequest[]>([]);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [hostConfigs, setHostConfigs] = useState<Record<string, HostConfig>>({});
  const [quota, setQuota] = useState<QuotaState | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [archiveAfterDays, setArchiveAfterDays] = useState<number>(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<{ query: string; hits: SearchHit[] }>({
    query: "",
    hits: [],
  });
  const [dirSuggestions, setDirSuggestions] = useState<{ prefix: string; dirs: string[] }>({
    prefix: "",
    dirs: [],
  });
  const wsRef = useRef<WebSocket | null>(null);
  const buildIdRef = useRef<string | null>(null);
  const sendReceiptRef = useRef(false);
  const nextSendRef = useRef(0);
  const sendWaitersRef = useRef(new Map<string, (outcome: SendOutcome) => void>());
  const failPendingSends = useCallback(() => {
    for (const finish of sendWaitersRef.current.values()) finish("unknown");
  }, []);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Pending liveness probe; cleared by any frame from the server.
  const probeRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Sends waiting for the pending probe's verdict.
  const probeWaitersRef = useRef<Array<() => void>>([]);
  // Detail re-fetches owed after a resync ("ws/msg" keys). Collected inside
  // the state updater (which React runs lazily, at render) and sent from an
  // effect after the commit, once each even under StrictMode's double run.
  const detailRefetchRef = useRef<Set<string>>(new Set());

  const flushDetailRefetches = useCallback((workspaces: Workspace[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const key of detailRefetchRef.current) {
      const [workspaceId, messageId] = key.split("/");
      if (
        workspaces
          .find((w) => w.id === workspaceId)
          ?.messages.some((m) => m.id === messageId && m.detail === "summary")
      ) {
        ws.send(JSON.stringify({ type: "load_message_details", workspaceId, messageId }));
      }
    }
    detailRefetchRef.current.clear();
  }, []);

  const settleProbe = useCallback(() => {
    clearTimeout(probeRef.current);
    probeRef.current = undefined;
    const waiters = probeWaitersRef.current;
    probeWaitersRef.current = [];
    for (const wake of waiters) wake();
  }, []);

  const pendingEventsRef = useRef<PendingEvent[]>([]);
  const scheduledFlushRef = useRef<{ hidden: boolean; cancel: () => void } | null>(null);

  // Applies every stream event received so far. Snapshot replies (a page,
  // details, a transcript, message_done) call it first: the server's copy
  // already contains those events, applying them after it would repeat them.
  const flushStreamEvents = useCallback(() => {
    scheduledFlushRef.current?.cancel();
    scheduledFlushRef.current = null;
    const batch = pendingEventsRef.current;
    if (batch.length === 0) return;
    pendingEventsRef.current = [];
    type Progress = Pick<AgentInfo, "lastStreamAt" | "retryLabel">;
    const updates = new Map<string, Map<string, Progress>>();
    for (const { wsId, agentId, streamAt, retryLabel } of batch) {
      if (!agentId || (streamAt == null && retryLabel === undefined)) continue;
      let agents = updates.get(wsId);
      if (!agents) updates.set(wsId, (agents = new Map<string, Progress>()));
      const progress = agents.get(agentId) ?? {};
      if (streamAt != null) progress.lastStreamAt = streamAt;
      if (retryLabel !== undefined) progress.retryLabel = retryLabel ?? undefined;
      agents.set(agentId, progress);
    }
    setWorkspaces((prev) =>
      applyStreamBatch(prev, batch).map((w) => {
        const agents = updates.get(w.id);
        if (!agents) return w;
        return {
          ...w,
          agents: w.agents.map((a) => {
            const progress = agents.get(a.id);
            return progress ? { ...a, ...progress } : a;
          }),
        };
      }),
    );
  }, [setWorkspaces]);

  const setActiveTranscript = useCallback(
    (workspaceId: string | null) => {
      // Exempt the new reader before applying a queued stream batch, then
      // account for the workspace the reader just left.
      setTranscripts((prev) => {
        if (prev.activeId === workspaceId) return prev;
        const ids = new Set(prev.workspaces.map((w) => w.id));
        const lastUsed = prev.lastUsed.filter((id) => id !== workspaceId && ids.has(id));
        if (workspaceId !== null) lastUsed.push(workspaceId);
        return { ...prev, activeId: workspaceId, lastUsed };
      });
      flushStreamEvents();
      setWorkspaces((prev) => prev);
    },
    [flushStreamEvents, setWorkspaces],
  );

  const scheduleFlush = useCallback(() => {
    const hidden = document.visibilityState === "hidden";
    const scheduled = scheduledFlushRef.current;
    if (scheduled?.hidden === hidden) return;
    scheduled?.cancel();
    if (hidden) {
      const timer = setTimeout(flushStreamEvents, HIDDEN_FLUSH_MS);
      scheduledFlushRef.current = { hidden, cancel: () => clearTimeout(timer) };
    } else {
      const frame = requestAnimationFrame(flushStreamEvents);
      scheduledFlushRef.current = { hidden, cancel: () => cancelAnimationFrame(frame) };
    }
  }, [flushStreamEvents]);

  const handleServerMessage = useCallback(
    (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "init": {
          sendReceiptRef.current = msg.sendReceipt === true;
          const buildId = msg.buildId as string | undefined;
          if (buildId && buildIdRef.current && buildIdRef.current !== buildId) {
            // The server was redeployed while we were connected; pick up the
            // new bundle instead of running stale code against it.
            try {
              sessionStorage.setItem(AUTO_RELOAD, "1");
            } catch {}
            window.location.reload();
            return;
          }
          if (buildId) buildIdRef.current = buildId;
          flushStreamEvents();
          setQuota((msg.quota as QuotaState | undefined) ?? null);
          const incoming = msg.workspaces as Workspace[];
          setWorkspaces((prev) => {
            if (prev.length === 0) return incoming;
            const prevMap = new Map(prev.map((w) => [w.id, w]));
            return incoming.map((w) => {
              const existing = prevMap.get(w.id);
              if (existing?.messagesLoaded) {
                return {
                  ...w,
                  messages: existing.messages,
                  messagesLoaded: true,
                  hasMore: existing.hasMore,
                };
              }
              return w;
            });
          });
          const config = msg.config as {
            presets?: AgentPreset[];
            user?: typeof DEFAULT_USER;
            models: ModelOption[];
            codexAuth?: CodexAuthState;
            commands?: CommandInfo[];
            telemetryEnabled?: boolean;
            hosts: Record<string, HostConfig>;
          };
          configureTelemetry(config.telemetryEnabled === true);
          setUser(config.user ?? DEFAULT_USER);
          setPresets(config.presets ?? []);
          setModels(config.models);
          setCodexAuth((msg.codexAuth as CodexAuthState | undefined) ?? config.codexAuth ?? null);
          setRecheckingCodexAuth(false);
          const cfgExtra = config as unknown as { archiveAfterDays?: number };
          setArchiveAfterDays(cfgExtra.archiveAfterDays ?? 0);
          setGlobalCommands((msg.commands as CommandInfo[] | undefined) ?? config.commands ?? []);
          setCommandsByAgent((msg.commandsByAgent as CommandsByAgent | undefined) ?? {});
          setExtensionUi({
            agents: (msg.extensionUi as ExtensionUiSnapshot[] | undefined) ?? [],
            notices: [],
          });
          setPendingDialogs((msg.pendingDialogs as UiDialogRequest[] | undefined) ?? []);
          if (config.hosts) setHostConfigs(config.hosts);
          if (msg.hosts) setHosts(msg.hosts as HostInfo[]);
          setProjects((msg.projects as Project[] | undefined) ?? []);
          setIssues((msg.issues as Record<string, IssueModules> | undefined) ?? {});
          setSnapshotReady(true);
          break;
        }

        case "workspace_updated": {
          flushStreamEvents();
          const info = msg.workspace as Workspace;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === info.id
                ? {
                    ...info,
                    messages: w.messages,
                    messagesLoaded: w.messagesLoaded,
                    hasMore: w.hasMore,
                    loadingOlder: w.loadingOlder,
                  }
                : w,
            ),
          );
          break;
        }

        case "workspace_attention": {
          const unread = msg.unread as number;
          const lastResult = msg.lastResult as Workspace["lastResult"];
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === msg.workspaceId ? { ...w, unread, lastResult } : w)),
          );
          break;
        }

        case "workspace_seen": {
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === msg.workspaceId ? { ...w, unread: 0 } : w)),
          );
          break;
        }

        case "project_deleted":
          setProjects((prev) => prev.filter((p) => p.id !== msg.projectId));
          setIssues((prev) =>
            Object.fromEntries(Object.entries(prev).filter(([id]) => id !== msg.projectId)),
          );
          break;

        case "project_issues":
          setIssues((prev) => ({
            ...prev,
            [msg.projectId as string]: msg.modules as IssueModules,
          }));
          break;

        case "project_updated": {
          const project = msg.project as Project;
          setProjects((prev) =>
            prev.some((p) => p.id === project.id)
              ? prev.map((p) => (p.id === project.id ? project : p))
              : [...prev, project],
          );
          break;
        }

        case "hosts_update":
          setHosts(msg.hosts as HostInfo[]);
          break;

        case "commands_update":
          // Older servers have one global command list.
          setGlobalCommands(msg.commands as CommandInfo[]);
          break;

        case "agent_commands_update": {
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          const commands = msg.commands as CommandInfo[];
          setCommandsByAgent((prev) => ({
            ...prev,
            [wsId]: { ...prev[wsId], [agentId]: commands },
          }));
          break;
        }

        case "telemetry_config":
          configureTelemetry(msg.telemetryEnabled === true);
          break;
        case "identities_update":
          setUser(msg.user as typeof DEFAULT_USER);
          setPresets(msg.presets as AgentPreset[]);
          break;

        case "models_update":
          setModels(msg.models as ModelOption[]);
          break;

        case "codex_auth_update":
          setCodexAuth((msg.codexAuth as CodexAuthState | undefined) ?? null);
          setRecheckingCodexAuth(false);
          break;

        case "extension_ui": {
          const event = msg.event as ExtensionUiEvent;
          const now = Date.now();
          setExtensionUi((prev) => receiveUi(prev, event, now));
          break;
        }
        case "ui_dialog_request": {
          const dialog = msg.dialog as UiDialogRequest;
          setPendingDialogs((prev) =>
            prev.some((d) => sameDialog(d, dialog)) ? prev : [...prev, dialog],
          );
          break;
        }

        case "ui_dialog_resolved": {
          // Current servers replay the request; accepting the identity fields
          // directly also makes resolution tolerant of older broadcasts.
          const dialog = (msg.dialog ?? msg) as UiDialogRequest;
          setPendingDialogs((prev) => prev.filter((d) => !sameDialog(d, dialog)));
          break;
        }

        case "workspace_messages": {
          const wsId = msg.workspaceId as string;
          if (Array.isArray(msg.extensionUi)) {
            const agents = msg.extensionUi as ExtensionUiSnapshot[];
            setExtensionUi((prev) => ({
              agents: [...prev.agents.filter((a) => a.workspaceId !== wsId), ...agents],
              notices: prev.notices.filter(
                (n) =>
                  n.workspaceId !== wsId ||
                  agents.some(
                    (a) => sameAgent(n, a) && n.processGeneration === a.processGeneration,
                  ),
              ),
            }));
          }
          if (Array.isArray(msg.pendingDialogs)) {
            const dialogs = msg.pendingDialogs as UiDialogRequest[];
            setPendingDialogs((prev) => [
              ...prev.filter((d) => d.workspaceId !== wsId),
              ...dialogs,
            ]);
          }
          const incoming = msg.messages as Message[];
          const hasMore = msg.hasMore as boolean;
          // Set on older-page replies; null/absent on a fetch of the newest page.
          const before = (msg.before as number | null | undefined) ?? null;
          flushStreamEvents();
          setWorkspaces((prev) =>
            prev.map((w) => {
              if (w.id !== wsId) return w;
              if (before != null) {
                // An older page cannot start a dropped cache or prepend to a
                // different cursor after eviction, archive, or resync.
                if (!w.messagesLoaded || before !== w.messages[0]?.timestamp) return w;
                const existingIds = new Set(w.messages.map((m) => m.id));
                const newMsgs = incoming.filter((m) => !existingIds.has(m.id));
                return {
                  ...w,
                  messages: [...newMsgs, ...w.messages],
                  hasMore,
                  loadingOlder: false,
                };
              }
              // Reconcile a resync, including any contiguous live tail that
              // arrived after eviction. The incoming page wins where it overlaps.
              const merged = mergeLatestPage(w.messages, incoming);
              // A complete snapshot can also prove that a cached row outside
              // (or tied with) its first timestamp was removed.
              const messages =
                !hasMore && merged.length > incoming.length
                  ? merged.slice(-incoming.length)
                  : merged;
              for (const id of downgradedMessageIds(w.messages, messages)) {
                detailRefetchRef.current.add(`${wsId}/${id}`);
              }
              const keptOlder = messages.length > incoming.length;
              return {
                ...w,
                messages,
                messagesLoaded: true,
                hasMore: keptOlder ? !w.messagesLoaded || w.hasMore : hasMore,
                // A newest-page reply cannot complete an older-page request
                // that still targets the same cursor.
                loadingOlder:
                  !!w.loadingOlder && messages[0]?.timestamp === w.messages[0]?.timestamp,
              };
            }),
          );
          break;
        }

        case "workspace_created":
          flushStreamEvents();
          setWorkspaces((prev) => [...prev, msg.workspace as Workspace]);
          break;

        case "workspace_deleted": {
          const wsId = msg.workspaceId as string;
          setWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
          setCommandsByAgent((prev) => {
            if (!(wsId in prev)) return prev;
            const next = { ...prev };
            delete next[wsId];
            return next;
          });
          setExtensionUi((prev) => withoutOwner(prev, wsId));
          setPendingDialogs((prev) => prev.filter((d) => d.workspaceId !== wsId));
          break;
        }

        case "agent_added": {
          const wsId = msg.workspaceId as string;
          const agent = msg.agent as AgentInfo;
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === wsId ? { ...w, agents: [...w.agents, agent] } : w)),
          );
          break;
        }

        case "agent_updated": {
          flushStreamEvents();
          const wsId = msg.workspaceId as string;
          const agent = msg.agent as AgentInfo;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    agents: w.agents.map((a) =>
                      a.id === agent.id
                        ? {
                            ...a,
                            ...agent,
                            context: agent.context,
                            lastStreamAt: agent.lastStreamAt,
                            retryLabel: agent.retryLabel,
                          }
                        : a,
                    ),
                  }
                : w,
            ),
          );
          break;
        }

        case "agent_removed": {
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId ? { ...w, agents: w.agents.filter((a) => a.id !== agentId) } : w,
            ),
          );
          setCommandsByAgent((prev) => {
            if (!prev[wsId]?.[agentId]) return prev;
            const agents = { ...prev[wsId] };
            delete agents[agentId];
            const next = { ...prev };
            if (Object.keys(agents).length > 0) next[wsId] = agents;
            else delete next[wsId];
            return next;
          });
          setExtensionUi((prev) => withoutOwner(prev, wsId, agentId));
          setPendingDialogs((prev) =>
            prev.filter((d) => d.workspaceId !== wsId || d.agentId !== agentId),
          );
          break;
        }

        case "new_message": {
          const wsId = msg.workspaceId as string;
          const message = msg.message as Message;
          flushStreamEvents();
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    messages: [...w.messages, message],
                    lastMessageAt: Math.max(w.lastMessageAt ?? w.createdAt, message.timestamp),
                    queued: (msg.queued as boolean | undefined) ?? w.queued,
                  }
                : w,
            ),
          );
          break;
        }

        case "stream_event": {
          if (!msg.event) break;
          pendingEventsRef.current.push({
            wsId: msg.workspaceId as string,
            messageId: msg.messageId as string,
            event: msg.event as StreamEvent,
            agentId: msg.agentId as string | undefined,
            streamAt: msg.streamAt as number | undefined,
            retryLabel: msg.retryLabel as string | null | undefined,
          });
          scheduleFlush();
          break;
        }

        case "message_done": {
          const wsId = msg.workspaceId as string;
          const messageId = msg.messageId as string;
          const status = msg.status as Message["status"];
          const content = msg.content as string;
          const events = msg.events as StreamEvent[] | undefined;
          const context = msg.context as ContextUsage | null | undefined;
          const effort = msg.effort as string | undefined;
          const thinking = msg.thinking as ThinkingStats | undefined;
          flushStreamEvents();
          setWorkspaces((prev) =>
            prev.map((w) => {
              if (w.id !== wsId) return w;
              return {
                ...w,
                queued: (msg.queued as boolean | undefined) ?? w.queued,
                messages: w.messages.map((m) => {
                  if (m.id !== messageId) return m;
                  return {
                    ...withoutLiveTiming(m),
                    status,
                    content,
                    ...("queuedFor" in msg
                      ? { queuedFor: (msg.queuedFor as string | null) ?? undefined }
                      : {}),
                    ...("steering" in msg ? { steering: msg.steering === true || undefined } : {}),
                    ...(m.kind === "user" && {
                      pendingDelivery:
                        status === "starting" || status === "dispatching"
                          ? (msg.pendingDelivery as Message["pendingDelivery"])
                          : undefined,
                    }),
                    ...(events ? { events } : {}),
                    ...(context !== undefined ? { context } : {}),
                    ...(effort ? { effort } : {}),
                    ...(thinking ? { thinking } : {}),
                  };
                }),
              };
            }),
          );
          break;
        }

        case "agent_busy": {
          flushStreamEvents();
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    agents: w.agents.map((a) =>
                      a.id === agentId
                        ? {
                            ...a,
                            busy: true,
                            canSwitchBackend: false,
                            lastStreamAt: msg.streamAt as number | undefined,
                            retryLabel: undefined,
                          }
                        : a,
                    ),
                  }
                : w,
            ),
          );
          break;
        }

        case "agent_idle": {
          flushStreamEvents();
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    agents: w.agents.map((a) =>
                      a.id === agentId
                        ? { ...a, busy: false, lastStreamAt: undefined, retryLabel: undefined }
                        : a,
                    ),
                  }
                : w,
            ),
          );
          break;
        }

        case "agent_activity": {
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          const activity = (msg.activity as string | null) ?? null;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    agents: w.agents.map((a) => (a.id === agentId ? { ...a, activity } : a)),
                  }
                : w,
            ),
          );
          break;
        }

        case "workspace_archived": {
          const wsId = msg.workspaceId as string;
          const archivedAt = msg.archivedAt as number;
          // The server dropped the history; forget ours so reopening reloads.
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    archivedAt,
                    agents: w.agents.map((a) => ({ ...a, context: undefined })),
                    messages: [],
                    messagesLoaded: false,
                    hasMore: false,
                    loadingOlder: false,
                  }
                : w,
            ),
          );
          break;
        }

        case "workspace_unarchived": {
          const wsId = msg.workspaceId as string;
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === wsId ? { ...w, archivedAt: null } : w)),
          );
          break;
        }

        case "message_details": {
          const wsId = msg.workspaceId as string;
          const messageId = msg.messageId as string;
          const events = msg.events as StreamEvent[];
          flushStreamEvents();
          setWorkspaces((prev) =>
            prev.map((w) => {
              if (w.id !== wsId) return w;
              const index = w.messages.findIndex((m) => m.id === messageId);
              if (index < 0) return w;
              const messages = w.messages.slice();
              messages[index] = { ...messages[index], events, detail: undefined };
              return { ...w, messages };
            }),
          );
          break;
        }

        case "subagent_trace_page": {
          if (typeof msg.requestId !== "number") break;
          const pending = traceReceivers.current.get(msg.requestId);
          if (!pending) break;
          traceReceivers.current.delete(msg.requestId);
          if (
            Array.isArray(msg.events) &&
            msg.events.length <= TRACE_MAX_EVENTS &&
            traceBytes(msg) <= TRACE_MAX_BYTES
          ) {
            pending(msg as unknown as TracePage);
          }
          break;
        }

        case "workspace_git_update": {
          const wsId = msg.workspaceId as string;
          const git = (msg.git as GitInfo | null) ?? null;
          const pr = (msg.pr as PrInfo | null) ?? null;
          setWorkspaces((prev) => prev.map((w) => (w.id === wsId ? { ...w, git, pr } : w)));
          break;
        }

        case "agent_state": {
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          const state = msg.state as RunState;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? { ...w, agents: w.agents.map((a) => (a.id === agentId ? { ...a, state } : a)) }
                : w,
            ),
          );
          break;
        }

        case "message_removed": {
          const wsId = msg.workspaceId as string;
          const messageId = msg.messageId as string;
          flushStreamEvents();
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    queued: (msg.queued as boolean | undefined) ?? w.queued,
                    messages: w.messages.filter((m) => m.id !== messageId),
                  }
                : w,
            ),
          );
          break;
        }

        case "search_results":
          setSearchResults({ query: msg.query as string, hits: msg.hits as SearchHit[] });
          break;

        case "dirs":
          setDirSuggestions({ prefix: msg.prefix as string, dirs: msg.dirs as string[] });
          break;

        case "quota_snapshot":
          setQuota(msg.quota as QuotaState);
          break;

        case "system_status":
          setSystemStatus({
            osName: msg.osName as string,
            osArch: msg.osArch as string,
            cpuModel: msg.cpuModel as string,
            cpuCores: msg.cpuCores as number,
            cpuUsage: msg.cpuUsage as number,
            memTotal: msg.memTotal as number,
            memUsed: msg.memUsed as number,
            uptime: msg.uptime as number,
            hostname: msg.hostname as string,
          });
          break;

        case "pong":
          // Answer to a liveness probe; receipt alone clears the timer.
          break;

        case "send_receipt":
          sendWaitersRef.current.get(String(msg.requestId))?.("accepted");
          break;

        case "error":
          if (typeof msg.requestId === "string")
            sendWaitersRef.current.get(msg.requestId)?.("rejected");
          console.error("[server]", msg.message);
          setLastError(String(msg.message));
          break;
      }
    },
    [flushStreamEvents, scheduleFlush, setWorkspaces],
  );

  useEffect(() => {
    if (detailRefetchRef.current.size > 0) flushDetailRefetches(workspaces);
  }, [workspaces, flushDetailRefetches]);

  const send = useCallback(
    (data: { type: string; [key: string]: unknown }, userIntent = false): boolean => {
      if (userIntent) {
        const action = wsTelemetryAction(data);
        if (action) recordTelemetry(action);
      }
      if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
      wsRef.current.send(JSON.stringify(data));
      return true;
    },
    [],
  );

  const refreshQuota = useCallback(
    (force = true, providers?: readonly string[]) =>
      send(
        {
          type: "refresh_quota",
          force,
          ...(providers ? { providers: [...providers] } : {}),
        },
        force,
      ),
    [send],
  );

  const connect = useCallback((): WebSocket => {
    configureTelemetry(false);
    setSnapshotReady(false);
    const ws = new WebSocket(resolveWsUrl());
    failPendingSends();
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      setConnectionEpoch((n) => n + 1);
      refreshQuota(false);
    };
    ws.onclose = () => {
      // A socket we already gave up on (failed probe) must not schedule a
      // second reconnect on top of the replacement.
      if (wsRef.current !== ws) return;
      configureTelemetry(false);
      failPendingSends();
      setConnected(false);
      setRecheckingCodexAuth(false);
      wsRef.current = null;
      settleProbe();
      reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return;
      settleProbe();
      handleServerMessage(JSON.parse(e.data as string) as Record<string, unknown>);
    };
    return ws;
  }, [failPendingSends, handleServerMessage, refreshQuota, settleProbe]);

  // Gives `ws` PROBE_TIMEOUT_MS to show it is alive: any frame, or for an
  // attempt still connecting, opening. Otherwise it is replaced by a new
  // attempt under the same deadline, since an attempt can hang in CONNECTING
  // for minutes after a network switch before the browser gives up.
  const watchSocket = useCallback(
    (ws: WebSocket, connecting: boolean) => {
      const watch = (sock: WebSocket, attempt: boolean) => {
        probeRef.current = setTimeout(() => {
          const dead = wsRef.current === sock && !(attempt && sock.readyState === WebSocket.OPEN);
          if (dead) {
            wsRef.current = null;
            sock.close();
            setConnected(false);
          }
          settleProbe();
          if (dead) watch(connect(), true);
        }, PROBE_TIMEOUT_MS);
      };
      watch(ws, connecting);
    },
    [connect, settleProbe],
  );

  // Check that the socket still carries traffic; reconnect right away if it
  // is gone rather than waiting for the browser to notice.
  const probe = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) {
      // Between attempts: skip the rest of the back-off.
      clearTimeout(reconnectRef.current);
      watchSocket(connect(), true);
      return;
    }
    if (probeRef.current) return;
    const state: number = ws.readyState;
    const connecting = state === WebSocket.CONNECTING;
    if (!connecting && state !== WebSocket.OPEN) return;
    if (!connecting) ws.send(JSON.stringify({ type: "ping" }));
    watchSocket(ws, connecting);
  }, [connect, watchSocket]);

  useEffect(() => {
    if (useMock) {
      setWorkspaces([...MOCK_WORKSPACES, ...MOCK_PROJECT_WORKSPACES]);
      setProjects(MOCK_PROJECTS);
      setPresets(MOCK_PRESETS);
      setModels(MOCK_MODELS);
      setCodexAuth({
        cliAvailable: true,
        authenticated: true,
        status: "authenticated",
        accountType: "chatgpt",
        checkedAt: Date.now(),
      });
      setSystemStatus(MOCK_SYSTEM_STATUS);
      setConnected(true);
      setSnapshotReady(true);
      return;
    }
    if (useReplay) {
      setConnected(true);
      void import("../dev/replay").then(({ startReplay }) =>
        startReplay(handleServerMessage).catch((e) => console.error("[replay]", e)),
      );
      return;
    }
    connect();
    return () => {
      configureTelemetry(false);
      clearTimeout(reconnectRef.current);
      clearTimeout(probeRef.current);
      // Detached first, or its onclose would schedule a reconnect.
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [connect, useMock, useReplay, handleServerMessage, setWorkspaces]);

  useEffect(() => {
    if (useMock || useReplay) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refreshQuota(false);
      probe();
    };
    const heartbeat = () => {
      if (document.visibilityState === "visible") probe();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Back/forward cache restores and network changes bypass visibilitychange.
    window.addEventListener("pageshow", onVisible);
    window.addEventListener("online", onVisible);
    const timer = setInterval(heartbeat, HEARTBEAT_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      window.removeEventListener("online", onVisible);
      clearInterval(timer);
    };
  }, [probe, refreshQuota, useMock, useReplay]);

  const recheckCodexAuth = useCallback(() => {
    if (!send({ type: "recheck_codex_auth" })) return;
    setRecheckingCodexAuth(true);
  }, [send]);

  const commands = commandTarget
    ? (commandsByAgent[commandTarget.workspaceId]?.[commandTarget.agentId] ?? globalCommands)
    : globalCommands;

  return {
    workspaces,
    projects,
    issues,
    connected,
    snapshotReady,
    connectionEpoch,
    setActiveTranscript,
    user,
    presets,
    models,
    codexAuth,
    recheckingCodexAuth,
    recheckCodexAuth,
    commands,
    commandsByAgent,
    globalCommands,
    extensionUi,
    dismissNotice,
    pendingDialogs,
    selectCommandAgent: useCallback((workspaceId: string | null, agentId: string | null) => {
      setCommandTarget(workspaceId && agentId ? { workspaceId, agentId } : null);
    }, []),
    hosts,
    hostConfigs,
    systemStatus,
    quota,
    refreshQuota,
    archiveAfterDays,
    lastError,
    showError: setLastError,
    clearError: useCallback(() => setLastError(null), []),
    loadMessages: useCallback(
      (wsId: string, before?: number, pageSize?: number) => {
        // Small screens get smaller first pages; scrolling back fetches more.
        const limit = pageSize ?? (before != null ? 50 : window.innerWidth < 768 ? 25 : 50);
        const requested = send({ type: "load_messages", workspaceId: wsId, before, limit });
        if (requested && before != null) {
          recordTelemetry("chat.history_page");
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId && w.messagesLoaded && w.messages[0]?.timestamp === before
                ? { ...w, loadingOlder: true }
                : w,
            ),
          );
        }
        return requested;
      },
      [send, setWorkspaces],
    ),
    loadMessageDetails: useCallback(
      (wsId: string, messageId: string) =>
        send({ type: "load_message_details", workspaceId: wsId, messageId }, true),
      [send],
    ),
    // An open trace can refetch as new events arrive. Its toggle is tracked
    // at the UI, not here at the effect-driven request.
    requestSubagentTrace: useCallback(
      (target: TraceTarget, window: TraceWindow, receive: (page: TracePage) => void) => {
        const id = ++traceRequestId.current;
        traceReceivers.current.set(id, receive);
        if (target.workspaceId === "replay-demo") {
          void import("../dev/replayFixture").then(({ demoTracePage }) =>
            handleServerMessage({ ...demoTracePage(id, target, window) }),
          );
        } else if (!send({ type: "load_subagent_trace", ...target, ...window, requestId: id })) {
          traceReceivers.current.delete(id);
        }
        return () => {
          traceReceivers.current.delete(id);
        };
      },
      [send, handleServerMessage],
    ),

    respondUiDialog: useCallback(
      (dialog: UiDialogRequest, answer: UiDialogAnswer) =>
        send({
          type: "ui_dialog_response",
          workspaceId: dialog.workspaceId,
          agentId: dialog.agentId,
          processGeneration: dialog.processGeneration,
          requestId: dialog.requestId,
          ...answer,
        }),
      [send],
    ),
    cancelSubagent: useCallback(
      (wsId: string, agentId: string, taskId: string) => {
        if (wsId === "replay-demo") {
          // Demo workspace exists only client-side; emulate the stop locally.
          recordTelemetry("chat.stop");
          void import("../dev/replayFixture").then(({ cancelDemoSubagent }) =>
            cancelDemoSubagent(handleServerMessage, taskId),
          );
          return;
        }
        send({ type: "cancel_subagent", workspaceId: wsId, agentId, taskId }, true);
      },
      [send, handleServerMessage],
    ),
    // Plays the synthetic rendering-review fixture through the same dispatch
    // path as live server frames. Returns the demo workspace id.
    startReplayDemo: useCallback(() => {
      void import("../dev/replayFixture").then(({ startDemoReplay }) =>
        startDemoReplay(handleServerMessage).catch((e) => console.error("[replay-demo]", e)),
      );
      return "replay-demo";
    }, [handleServerMessage]),
    createWorkspace: useCallback(
      (name: string, path: string, hostId?: string, projectName?: string) =>
        send({ type: "create_workspace", name, path, hostId, projectName }),
      [send],
    ),
    createProject: useCallback(
      (name: string, root: string | null) => send({ type: "create_project", name, root }),
      [send],
    ),
    renameProject: useCallback(
      (projectId: string, name: string) => send({ type: "rename_project", projectId, name }),
      [send],
    ),
    sealProject: useCallback(
      (projectId: string, reason?: string) => send({ type: "seal_project", projectId, reason }),
      [send],
    ),
    deleteProject: useCallback(
      (projectId: string) => send({ type: "delete_project", projectId }),
      [send],
    ),
    cancelQueued: useCallback(
      (wsId: string, messageId: string) =>
        send({ type: "cancel_queued", workspaceId: wsId, messageId }, true),
      [send],
    ),
    searchServer: useCallback((query: string) => send({ type: "search", query }), [send]),
    searchResults,
    listDirs: useCallback((prefix: string) => send({ type: "list_dirs", prefix }), [send]),
    dirSuggestions,
    deleteWorkspace: useCallback(
      (id: string) => send({ type: "delete_workspace", workspaceId: id }),
      [send],
    ),
    addAgent: useCallback(
      (wsId: string, name: string, model: string, avatar: string, color: string, effort?: string) =>
        send({ type: "add_agent", workspaceId: wsId, name, model, avatar, color, effort }),
      [send],
    ),
    removeAgent: useCallback(
      (wsId: string, agentId: string) => send({ type: "remove_agent", workspaceId: wsId, agentId }),
      [send],
    ),
    // Resolves to whether the message went out; the caller keeps the draft
    // otherwise. A socket under probe may be dead (the phone just woke up),
    // so a send waits for the verdict rather than writing into it.
    sendMessage: useCallback(
      async (
        wsId: string,
        content: string,
        target?: string,
        images?: Array<{ name: string; url: string }>,
        quote?: { messageId: string; agentId: string | null; content: string },
        source?: "composer",
      ): Promise<SendOutcome> => {
        if (probeRef.current) await new Promise<void>((r) => probeWaitersRef.current.push(r));
        const data = { type: "send_message", workspaceId: wsId, content, target, images, quote };
        const outcome = !sendReceiptRef.current
          ? send(data, source === "composer")
            ? "unknown"
            : "not_sent"
          : await new Promise<SendOutcome>((resolve) => {
              const requestId = String(++nextSendRef.current);
              const timer = setTimeout(() => finish("unknown"), 120_000);
              const finish = (result: SendOutcome) => {
                clearTimeout(timer);
                sendWaitersRef.current.delete(requestId);
                resolve(result);
              };
              sendWaitersRef.current.set(requestId, finish);
              if (!send({ ...data, requestId }, source === "composer")) finish("not_sent");
            });
        if (outcome === "unknown")
          setLastError("Delivery is unconfirmed. Check the conversation before sending again.");
        else if (outcome === "not_sent")
          setLastError("Not connected: the message was not sent. You can retry.");
        return outcome;
      },
      [send],
    ),
    forwardMessage: useCallback(
      (wsId: string, messageId: string, targetAgentId: string) =>
        send({ type: "forward_message", workspaceId: wsId, messageId, targetAgentId }),
      [send],
    ),
    abort: useCallback(
      (wsId: string, agentId?: string) => send({ type: "abort", workspaceId: wsId, agentId }, true),
      [send],
    ),
    // One stop intent may fan out to several running turns; tasks and wake-ups go on.
    interrupt: useCallback(
      (wsId: string, agentIds?: string[]) => {
        for (const [i, agentId] of (agentIds ?? [undefined]).entries()) {
          send({ type: "interrupt", workspaceId: wsId, agentId }, i === 0);
        }
      },
      [send],
    ),
    markSeen: useCallback((wsId: string) => send({ type: "mark_seen", workspaceId: wsId }), [send]),
    cancelWakeup: useCallback(
      (wsId: string, agentId: string) =>
        send({ type: "cancel_wakeup", workspaceId: wsId, agentId }, true),
      [send],
    ),
    clearContext: useCallback(
      (wsId: string, agentId: string) =>
        send({ type: "clear_context", workspaceId: wsId, agentId }),
      [send],
    ),
    restartServer: useCallback(() => send({ type: "restart_server" }), [send]),
    archiveWorkspace: useCallback(
      (wsId: string) => send({ type: "archive_workspace", workspaceId: wsId }, true),
      [send],
    ),
    unarchiveWorkspace: useCallback(
      (wsId: string) => send({ type: "unarchive_workspace", workspaceId: wsId }, true),
      [send],
    ),
    setReporting: useCallback(
      (wsId: string, reports: boolean) =>
        send({ type: "set_reporting", workspaceId: wsId, reports }),
      [send],
    ),
    // One project's archived sessions, or (null) those in no project.
    purgeArchived: useCallback(
      (projectId: string | null) => send({ type: "purge_archived", projectId }),
      [send],
    ),
    archiveProject: useCallback(
      (projectId: string, archived: boolean) =>
        send({ type: "archive_project", projectId, archived }),
      [send],
    ),
  };
}
