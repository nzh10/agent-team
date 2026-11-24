export type Backend = "pi" | "codex";
export type LegacyBackend = "claude" | "cursor" | "agy";
export type AnyBackend = Backend | LegacyBackend;

export function isLegacyBackend(b: string | undefined): b is LegacyBackend {
  return b === "claude" || b === "cursor" || b === "agy";
}

export function isActiveBackend(b: string | undefined): b is Backend {
  return b === "pi" || b === "codex";
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  source?: "panel" | "pi" | "extension" | "skill" | "prompt";
}

export interface ToolInput {
  tool: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

export type ToolSource = "panel" | "builtin" | "extension" | "mcp";

export type StreamEventKind =
  | "thinking"
  | "thinking_delta"
  // Thinking tokens of the API call whose thinking block was the last
  // "thinking" event; applied to that event, never listed itself.
  | "thinking_tokens"
  | "text"
  | "text_delta"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error"
  | "subagent_start"
  | "subagent_progress"
  | "subagent_done"
  | "compact"
  // One-line banner from the CLI loop: hook feedback, notifications,
  // permission denials, compact failures, auth prompts.
  | "notice"
  // API retry in progress; replaces the previous retry event of the turn.
  // Empty content clears it, as do real assistant progress and terminal errors.
  | "retry";

// "schedule": the agent scheduled its own wake-up (what it will do, when).
// "wakeup": that wake-up (or a background task) fired and started a turn.
// "skill": the CLI expanded a slash command we sent (a skill's instructions)
// into the user turn; shown collapsed so the reply has its context.
export type NoticeLevel = "info" | "notice" | "warning" | "error" | "schedule" | "wakeup" | "skill";

export interface StreamEvent {
  kind: StreamEventKind;
  content: string;
  // Tool name for tool_use events (the content is the formatted markdown).
  toolName?: string;
  toolSource?: ToolSource;
  level?: NoticeLevel;
  // On result events: size of the context sent on the turn's last request
  // and the model's window, for the per-message usage row.
  context?: ContextUsage;
  // On result events: the effort the turn actually ran at.
  effort?: string;
  // On result events: thinking tokens and time of the turn's main loop.
  thinking?: ThinkingStats;
  // On result events: the user stopped the turn (interrupt); the process and
  // its background work go on.
  interrupted?: boolean;
  // On thinking events: how long the block took to think, and (patched in
  // by a later thinking_tokens event) how many tokens it spent. On a tool
  // call (its result, then the call it merges into): from call to result.
  durationMs?: number;
  // Start of a tool call or a live thinking block (ms since the epoch).
  startedAt?: number;
  // Workspace stream only: when the wait began, or null when it ended.
  waitingSince?: number | null;
  tokens?: number;
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
  subagent?: SubAgentInfo;
  // Summary-page fields (see summary.ts): sizes of bodies not included.
  contentLength?: number;
  bodyLength?: number;
  resultLength?: number;
}

// What an agent is doing from the user's point of view. "waiting" = the
// turn ended but background work (subagents, tasks) will re-invoke it;
// "sleeping" = a scheduled wake-up is pending. Messages can be sent in every
// state but "working" (where they queue).
export type RunState = "idle" | "working" | "waiting" | "sleeping";

export interface ContextUsage {
  tokens: number;
  window: number;
}

export interface ThinkingStats {
  tokens: number;
  durationMs: number;
}

export interface SubAgentInfo {
  taskId: string;
  description: string;
  model?: string;
  effort?: string;
  prompt?: string;
  agentType?: string;
  status?: "running" | "completed" | "failed" | "stopped";
  lastTool?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  // From the task's start to its end, by our clock: every kind of task.
  durationMs?: number;
  summary?: string;
  eventCount?: number;
  events?: StreamEvent[];
  hasPrompt?: boolean;
  summaryLength?: number;
  // SDK task type ("local_agent", "local_bash", "local_monitor"...). Absent
  // on older records, which were all agents.
  taskType?: string;
  cancellable?: boolean;
  _innerEvent?: StreamEvent;
}

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  turns: number;
  duration_ms: number;
  cost_usd?: number;
}

export interface BackgroundTask {
  id: string;
  type: string;
  description: string;
  // Epoch ms when the panel first saw it.
  since: number;
  cancellable?: boolean;
}

export type MessageStatus =
  "done" | "streaming" | "error" | "queued" | "dispatching" | "outcome_unknown";

export interface PromptEnvelope {
  inputId: string;
  text: string;
  attachmentIds?: string[];
  reportId?: string;
}

export interface DispatchAttempt {
  inputId: string;
  reportId?: string;
  generation: number;
  beforeLeafId: string | null;
  beforeEntryCount: number;
  startedAt: number;
}

export type SendDisposition = "started" | "handled" | "rejected";

export interface SendReceipt {
  disposition: SendDisposition;
  error?: string;
  retryable?: boolean;
}

export interface SendHooks {
  onBeforeWrite?: (attempt: DispatchAttempt) => void;
}

export interface ActiveAsyncChildRecord {
  taskId: string;
  stepIndex: number;
  canonicalChildId: string;
  status?: "pending" | "running" | "completed" | "failed" | "stopped";
  // Observed execution, retained across restore even if the runner artifacts disappear.
  execution?: Pick<SubAgentInfo, "model" | "effort">;
}

export interface ActiveAsyncRunRecord {
  runId: string;
  mode: "single" | "parallel" | "chain" | "workflow";
  asyncDir: string;
  startedAt: number;
  ownerMessageId: string;
  toolCallId: string;
  children: ActiveAsyncChildRecord[];
}

export interface BoundedSessionProof {
  sessionId: string | null;
  sessionFile: string | null;
  cwd: string;
  headerCwd: string | null;
  entryCount: number;
  leafId: string | null;
  anchorOnActiveBranch: boolean;
  anchorExistsInFile: boolean;
}

export type { ExtensionUiEvent, ExtensionUiSnapshot, UiChange } from "../../../shared/extension-ui";

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

export interface UiDialogResponse {
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface PiAvailableModel {
  id: string;
  provider: string;
  modelId: string;
  name?: string;
  reasoning?: boolean;
  effortLevels?: string[];
  contextWindow?: number;
}

export interface DispatchedReportProbeResult {
  found: boolean;
  anchorMissing: boolean;
  matchedEntryId?: string;
  sessionProof?: BoundedSessionProof;
}

export interface SessionConfig {
  cwd: string;
  backend?: AnyBackend;
  model?: string;
  effort?: string;
  // Fast mode (codex: the model's fast service tier).
  fast?: boolean;
  // Retained for backward-compatible state deserialization only; /goal is disabled.
  goal?: string;
  permissionMode?: string;
  systemPrompt?: string;
  panelInstructions?: string;
  providerEnv?: Record<string, string>;
  // Pi host runtime wiring (populated by LocalHost / tests, omitted from user presets).
  dataDir?: string;
  uploadsDir?: string;
  normalizedCwd?: string;
  piAgentDir?: string;
  piSessionDir?: string;
  piBridgeExtensionPath?: string;
  piSubagentsRoot?: string;
  piAntigravityEntryPath?: string;
  piPackages?: string[];
  piExcludePackages?: string[];
  piOffline?: boolean;
  piBinary?: string;
  piArgs?: string[];
  workspaceId?: string;
  agentId?: string;
}

export interface PersistedSessionAnchor {
  sessionFile: string;
  sessionId: string;
  leafId: string;
  entryCount: number;
}

export interface SessionState {
  sessionId: string | null;
  config: SessionConfig;
  usage: UsageStats;
  sessionFile?: string | null;
  normalizedCwd?: string;
  expectedLeafAnchorId?: string | null;
  minEntryCount?: number;
  // A first input crossed the write claim before its durable file anchor was saved.
  hasUnanchoredInput?: boolean;
  // Directly verified on disk; independent of turn or dispatch completion.
  persistedSessionAnchor?: PersistedSessionAnchor;
  hasConfirmedTurns?: boolean;
  desiredModel?: string;
  desiredEffort?: string;
  activeAsyncRuns?: ActiveAsyncRunRecord[];
}

export const REPORT_MARKER_PREFIX = "[agent-team:report:";

export function formatReportMarker(reportId: string): string {
  return `${REPORT_MARKER_PREFIX}${reportId}]`;
}

// What the panel's instructions and tool descriptions may take.
export const MCP_TEXT_LIMIT = 8192;

// Card label for a non-agent background task ("local_bash" -> "shell").
export function backgroundTaskLabel(taskType: string | undefined): string {
  switch (taskType) {
    case "local_bash":
      return "shell";
    case "local_monitor":
      return "monitor";
    case "local_workflow":
      return "workflow";
    default:
      return taskType?.replace(/^local_/, "") || "task";
  }
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

function formatDelay(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(seconds % 3600 ? 1 : 0)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

// A fence longer than any backtick run in the body, so a heredoc or a
// markdown file holding its own ``` cannot close it early.
export function fenced(body: string, lang = ""): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

export function formatToolUse(block: Record<string, unknown>): string {
  const name = block.name as string;
  const input = block.input as Record<string, unknown> | undefined;

  if (!input) return `**${name}**`;

  switch (name) {
    case "Bash":
      return `**Bash**\n${fenced(str(input.command), "bash")}`;

    case "Read":
      return `**Read** \`${str(input.file_path)}\``;

    case "Write":
      return `**Write** \`${str(input.file_path)}\`\n${fenced(str(input.content))}`;

    case "Edit": {
      const old_str = str(input.old_string ?? "");
      const new_str = str(input.new_string ?? "");
      return `**Edit** \`${str(input.file_path)}\`\n\`\`\`diff\n${old_str
        .split("\n")
        .map((l) => "- " + l)
        .join("\n")}\n${new_str
        .split("\n")
        .map((l) => "+ " + l)
        .join("\n")}\n\`\`\``;
    }

    case "Grep":
      return `**Grep** \`${str(input.pattern)}\`${input.path ? ` in \`${str(input.path)}\`` : ""}`;

    case "Glob":
      return `**Glob** \`${str(input.pattern)}\``;

    case "Agent":
      return `**Agent** ${str(input.prompt ?? "")}`;

    case "ScheduleWakeup": {
      if (input.stop) return "**ScheduleWakeup** stop — loop ended";
      const delay = Number(input.delaySeconds ?? 0);
      const when = formatDelay(delay);
      const reason = input.reason ? ` — ${input.reason as string}` : "";
      const prompt = input.prompt ? `\n\n> ${str(input.prompt).replace(/\n/g, "\n> ")}` : "";
      return `**ScheduleWakeup** in ${when}${input.noop ? " (no change)" : ""}${reason}${prompt}`;
    }

    case "CronCreate":
      return `**CronCreate** \`${str(input.cron ?? "")}\`${input.prompt ? ` — ${str(input.prompt).slice(0, 120)}` : ""}`;

    default:
      if (name.startsWith("mcp__panel__")) {
        return formatPanelTool(name.slice("mcp__panel__".length), input);
      }
      return `**${name}**\n${fenced(JSON.stringify(input, null, 2), "json")}`;
  }
}

// The panel's own tools (project/tools.ts), shown by what they do.
export function formatPanelTool(tool: string, input: Record<string, unknown>): string {
  const head = `**${tool}**`;
  const quote = (v: unknown) => `\n\n> ${str(v).replace(/\n/g, "\n> ")}`;
  switch (tool) {
    case "start_session":
      return `${head} ${str(input.title)} in \`${str(input.cwd)}\`${quote(input.task)}`;
    case "message_session":
      return `${head} \`${str(input.session_id)}\`${quote(input.message)}`;
    case "message_project":
      return `${head} \`${str(input.project_id)}\`${quote(input.message)}`;
    case "read_session":
    case "stop_session":
    case "archive_session":
      return `${head} \`${str(input.session_id)}\``;
    case "update_objective": {
      const what = [input.id ?? "new", input.status && `→ ${str(input.status)}`, input.title];
      const notes = input.notes ? quote(input.notes) : "";
      return `${head} ${what.filter(Boolean).map(str).join(" ")}${notes}`;
    }
    case "report_progress":
      return `${head}${quote(input.text)}`;
    case "finish_task":
      return `${head}${quote(input.summary)}`;
    case "read_note":
      return `${head} \`${str(input.slug)}\``;
    case "write_note":
      return `${head} \`${str(input.slug)}\`${input.expected_version ? ` (v:${str(input.expected_version)})` : ""}`;
    case "list_notes":
      return head;
    default:
      return Object.keys(input).length
        ? `${head}\n${fenced(JSON.stringify(input, null, 2), "json")}`
        : head;
  }
}
