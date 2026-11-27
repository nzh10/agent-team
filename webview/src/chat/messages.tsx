import {
  useState,
  useCallback,
  useMemo,
  memo,
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  createContext,
  useContext,
} from "react";
import { telemetryTarget } from "../telemetryEvents";
import type { ReactNode } from "react";
import type { Message, MessageOrigin, AgentInfo, StreamEvent } from "../state/useServer";
import {
  hasOutstandingSubagents,
  SUBAGENT_KINDS,
  timelineBlocks,
  type TimelineBlock,
} from "./events";
import { SubagentTraceContext, useTracePage } from "./subagentTrace";
import { traceBytes, type TraceRow, type TraceWindow } from "../../../shared/subagent-trace";
import { isOutstandingSubagentStatus, type SubagentStatus } from "../../../shared/subagent-status";
import { toolNameOf, toolSummary } from "../state/stream";
import { copySelectionAsMarkdown } from "./clipboard";
import { CodeBlock, CopyButton, FileRefCode, MdBlock, StreamingMdBlock } from "./markdown";
import { FileOpenContext } from "./fileRef";
import { LocalDayContext, parseLocalDayKey } from "./localDay";
import {
  TranscriptChoiceScope,
  useResetTranscriptChoices,
  useTranscriptChoice,
} from "./transcriptChoices";
import { DEFAULT_USER } from "../state/useServer";
import { AgentAvatar, Avatar, isImageAvatar } from "../workspace/avatar";
import {
  formatTokens,
  formatDuration,
  formatRunTime,
  formatMessageTime,
  formatFullDateTime,
} from "../format";
import { shortModel } from "../workspace/models";
import { agentNameColor } from "../workspace/agents";

function renderMentionContent(content: string, agents: AgentInfo[]) {
  const match = content.match(/^@(\S+)(\s+|$)/);
  if (!match) {
    return <MdBlock>{content}</MdBlock>;
  }
  const mentionName = match[1];
  const rest = content.slice(match[0].length);
  const mentioned = agents.find((a) => a.name === mentionName);
  return (
    <>
      <span
        className="mention-pill"
        style={
          mentioned
            ? { background: `color-mix(in srgb, ${mentioned.color} 12%, transparent)` }
            : undefined
        }
      >
        @{mentionName}
      </span>
      {rest && <MdBlock>{rest}</MdBlock>}
    </>
  );
}

// The sender of a message another session delivered (the server names it
// the same way in quotes and forwards).
const ORIGIN_GLYPH: Record<MessageOrigin["role"], string> = {
  lead: "◆",
  peer: "◆",
  worker: "◇",
  panel: "▣",
};

export function originLabel(from: MessageOrigin): string {
  if (from.role === "lead") return "Lead";
  if (from.role === "panel") return `Panel · ${from.name}`;
  return from.role === "peer" ? `${from.name} · lead` : from.name;
}

// Banners that carry a whole prompt (a wake-up's text, a scheduled
// wake-up's instructions, a skill's body) start folded to their first line.
const FOLDING_LEVELS = new Set(["wakeup", "schedule", "skill"]);
const FOLD_OVER_CHARS = 160;
const BANNER_LABEL: Record<string, string> = {
  wakeup: "Woke up",
  schedule: "Scheduled",
  skill: "Skill",
  error: "Error",
};

export function bannerFirstLine(content: string): string {
  const line = (content ?? "").split("\n").find((l) => l.trim()) ?? "";
  const plain = line.replace(/[*_`#>]/g, "").trim();
  return plain.length > FOLD_OVER_CHARS ? plain.slice(0, FOLD_OVER_CHARS - 1) + "…" : plain;
}

export function bannerFolds(level: string, content: string): boolean {
  if (!FOLDING_LEVELS.has(level)) return false;
  const text = content ?? "";
  return text.trim().includes("\n") || text.length > FOLD_OVER_CHARS;
}

// Inline status line: compaction, CLI notices, API retries. Rendered as a
// sibling of the step box so it is visible without expanding anything.
export const BannerItem = memo(function BannerItem({
  ev,
  onLoadDetails,
}: {
  ev: StreamEvent;
  // Summary pages cap banner bodies; opening one fetches the full message.
  onLoadDetails?: () => void;
}) {
  const [open, setOpen] = useTranscriptChoice<boolean>("banner", false);
  const level =
    ev.kind === "compact"
      ? "compact"
      : ev.kind === "retry"
        ? "retry"
        : ev.kind === "error"
          ? "error"
          : (ev.level ?? "notice");
  const truncated = (ev.contentLength ?? 0) > (ev.content ?? "").length;
  const icon =
    ev.kind === "compact"
      ? "⇢"
      : ev.kind === "retry"
        ? "↻"
        : level === "wakeup" || level === "schedule"
          ? "⏰"
          : level === "skill"
            ? "✦"
            : level === "warning" || level === "error"
              ? "!"
              : "i";
  const folds = bannerFolds(level, ev.content);
  const label = BANNER_LABEL[level];
  return (
    <div
      className={`banner banner-${level}${folds && !open ? " banner-folded" : ""}`}
      data-kind={ev.kind}
    >
      <span className="banner-icon">{icon}</span>
      <div className="banner-text">
        {label && <span className="banner-label">{label}</span>}
        {folds && !open ? (
          <span className="banner-first-line">{bannerFirstLine(ev.content)}</span>
        ) : ev.kind === "notice" || ev.kind === "error" ? (
          <MdBlock>{ev.content}</MdBlock>
        ) : (
          ev.content
        )}
      </div>
      {(folds || truncated) && (
        <button
          className="btn-inline banner-toggle"
          onClick={() => {
            if (truncated) onLoadDetails?.();
            setOpen((v) => !v);
          }}
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
});

// Sessions and projects named in the chat (a panel action's target): their
// names as they are now, and a session opened on a click.
export interface SessionLinks {
  open?: (workspaceId: string) => void;
  nameOf?: (id: string) => string | undefined;
}
export const SessionLinkContext = createContext<SessionLinks>({});

// The message's turn is still running: a call left without a result by a
// stopped one (a restart) is not counted up for ever.
const TurnRunningContext = createContext(false);

const ACTION_LABEL: Record<string, string> = {
  start_session: "New session",
  message_session: "Message",
  message_project: "Message to project",
  stop_session: "Stopped",
  archive_session: "Archived",
  report_progress: "Progress to lead",
  finish_task: "Task finished",
};

// A panel call as the panel renders it (claude.ts formatPanelTool): the
// line after the tool's name (a title, an id), then the quoted text (a
// task, a message, a report).
function actionParts(content: string): { head: string; quote: string } {
  const lines = (content ?? "").split("\n");
  const head = lines[0]
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
  const quote = lines
    .filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n");
  return { head, quote };
}

// A panel call that changed something elsewhere, as a line of its own:
// what was done, to whom (the session opens on a click), the first line of
// what was sent, and whether it failed.
export const PanelActionItem = memo(function PanelActionItem({
  ev,
  action,
  onLoadDetails,
}: {
  ev: StreamEvent;
  action: string;
  onLoadDetails?: () => void;
}) {
  const [open, setOpen] = useTranscriptChoice<boolean>("action", false);
  const links = useContext(SessionLinkContext);
  const { head, quote } = actionParts(ev.content);
  const failed = !!ev.toolResultIsError;
  const result = ev.toolResult ?? "";
  const pending = ev.toolResult == null && ev.resultLength == null;
  // A summary page cut the text or the answer: expanding fetches them.
  const partial =
    (ev.resultLength ?? 0) > result.length || (ev.bodyLength ?? 0) > (ev.content ?? "").length;
  const session = /\b(ws-[\w-]+)/.exec(failed ? head : `${head} ${result}`)?.[1];
  const project = /\b(proj-[\w-]+)/.exec(head)?.[1];
  // The name as it is now; else as the answer quotes it ('Sent to
  // "modules".'); else a new session's title ("title in folder").
  const cut = head.lastIndexOf(" in ");
  const target =
    links.nameOf?.(session ?? project ?? "") ??
    ((!failed && /"([^"]+)"/.exec(result)?.[1]) ||
      (action === "start_session" && cut > 0 ? head.slice(0, cut) : head));
  const preview = bannerFirstLine(quote);
  return (
    <div
      className={`banner banner-action${open ? "" : " banner-folded"}${failed ? " banner-failed" : ""}${pending ? " banner-pending" : ""}`}
      data-action={action}
    >
      <span className="banner-icon">{failed ? "!" : "◆"}</span>
      <div className="banner-text">
        <span className="banner-label">{ACTION_LABEL[action] ?? action}</span>
        {target &&
          (session && links.open ? (
            <button
              className="action-target"
              title="Open that session"
              onClick={() => links.open!(session)}
            >
              {target}
            </button>
          ) : (
            <span className="action-target">{target}</span>
          ))}
        {failed ? (
          <span className="action-error">{bannerFirstLine(result)}</span>
        ) : (
          !open && preview && <span className="banner-first-line">{preview}</span>
        )}
        {open && (
          <>
            {quote && <MdBlock>{quote}</MdBlock>}
            {result && <div className="action-result">{result}</div>}
          </>
        )}
      </div>
      {(quote || result || partial) && (
        <button
          className="btn-inline banner-toggle"
          onClick={() => {
            if (partial) onLoadDetails?.();
            setOpen((v) => !v);
          }}
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
});

// Tools that schedule the session's own future (ScheduleWakeup, cron) get a
// distinct chip so a "sleeping until X" step reads differently from work.
const SCHEDULE_TOOLS = new Set(["ScheduleWakeup", "CronCreate", "CronDelete"]);

function chipClassFor(toolName: string | null, kind: string): string {
  if (toolName && SCHEDULE_TOOLS.has(toolName)) return "chip-schedule";
  if (toolName?.startsWith("mcp__panel__")) return "chip-panel";
  return kind === "tool_use" ? "chip-tool" : `chip-${kind}`;
}

// MCP tools arrive as mcp__<server>__<tool>; the panel's own read as plain
// names.
export function chipLabelFor(toolName: string): string {
  if (toolName === "ScheduleWakeup") return "⏰ Wake-up";
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return mcp[1] === "panel" ? mcp[2] : `${mcp[1]} · ${mcp[2]}`;
  return toolName;
}

// Effort, fast mode and context occupancy line under an agent message
// header. Thinking time and tokens show on the blocks in the steps.
export function MessageStatus({
  msg: { effort, fast, context: ctx },
}: {
  msg: Pick<AgentInfo, "effort" | "fast" | "context">;
}) {
  if (!effort && !fast && ctx === undefined) return null;
  const pct =
    ctx && ctx.window > 0 ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : null;
  const tone = pct == null ? "" : pct >= 90 ? " ctx-high" : pct >= 70 ? " ctx-warn" : "";
  return (
    <div className="message-status">
      {effort && (
        <span className="status-chip" title="Reasoning effort">
          effort {effort}
        </span>
      )}
      {fast && (
        <span className="status-chip fast-chip" title="Fast mode">
          ⚡ fast
        </span>
      )}
      {ctx === null && <span className="status-chip ctx-chip">ctx unknown</span>}
      {ctx && pct != null && (
        <span
          className={`status-chip ctx-chip${tone}`}
          title={`Context${ctx.estimated ? " estimate" : ""}: ${ctx.tokens.toLocaleString()} / ${ctx.window.toLocaleString()} tokens`}
        >
          <span className="ctx-bar">
            <span className="ctx-bar-fill" style={{ width: `${pct}%` }} />
          </span>
          ctx {formatTokens(ctx.tokens)} / {formatTokens(ctx.window)} · {pct}%
        </span>
      )}
    </div>
  );
}

function thinkingLabel(ev: StreamEvent): string {
  const head = ev.durationMs != null ? `Thought for ${formatDuration(ev.durationMs)}` : "Thinking";
  if (!ev.tokens) return head;
  const tokens = ev.tokens < 1000 ? String(ev.tokens) : `${(ev.tokens / 1000).toFixed(1)}k`;
  return `${head} · ${tokens} tokens`;
}

const KIND_LABEL: Record<string, string> = {
  thinking: "Thinking",
  tool_result: "Result",
  text: "Text",
  error: "Error",
};

// A tool body under its row: the row already shows the first line.
function afterFirstLine(content: string, singleLine = content): string {
  const nl = content.indexOf("\n");
  return nl < 0 ? singleLine : content.slice(nl + 1);
}

function resultLabel(len: number): string {
  return len > 1000 ? `${Math.round(len / 1000)}k chars` : `${len} chars`;
}

function formatSize(len: number): string {
  return len > 1000 ? `${(len / 1000).toFixed(len < 10000 ? 1 : 0)}k chars` : `${len} chars`;
}

// Strip Codex's outer Markdown delimiters only. toolSummary also removes
// backticks from the filename itself, which would open a different file.
function viewImagePathOf(ev: StreamEvent): string {
  const body = (ev.content ?? "").replace(/^\*\*[^*]+\*\*\s*/, "");
  if (!body.startsWith("`")) return body.trim();
  const inner = body.slice(1);
  return inner.endsWith("`") ? inner.slice(0, -1) : inner;
}

function ViewImagePath({
  path,
  truncated,
  onLoadDetails,
}: {
  path: string;
  truncated: boolean;
  onLoadDetails?: () => void;
}) {
  const openFile = useContext(FileOpenContext);
  const pending = useRef(false);
  const open = useCallback(
    (target: string) => {
      if (truncated) {
        pending.current = true;
        // A send can be dropped while disconnected: every activation may retry.
        onLoadDetails?.();
        return;
      }
      pending.current = false;
      openFile?.(target, { literalPath: true });
    },
    [onLoadDetails, openFile, truncated],
  );
  // Loading message details replaces this row's props without remounting it.
  // Only then open, using the now-complete path rather than its ellipsis.
  useEffect(() => {
    if (!pending.current || truncated || !path || !openFile) return;
    open(path);
  }, [open, openFile, path, truncated]);

  if (!openFile || !path) return <code>{path}</code>;
  return (
    <FileRefCode target={path} title="Open image in Files" onOpen={open}>
      {path}
    </FileRefCode>
  );
}

export const EventItem = memo(function EventItem({
  ev,
  onLoadDetails,
  liveThinking = false,
}: {
  ev: StreamEvent;
  liveThinking?: boolean;
  // Set while the message is a summary: called on first expand so the
  // bodies get fetched.
  onLoadDetails?: () => void;
}) {
  const [resultOpen, setResultOpen] = useTranscriptChoice<boolean>("tool-result", false);
  const [bodyOpen, setBodyOpen] = useTranscriptChoice<boolean>("tool-body", false);
  const resultFold = useBottomCollapse(resultOpen, () => setResultOpen(false));
  const bodyFold = useBottomCollapse(bodyOpen, () => setBodyOpen(false));
  const summarized = !!onLoadDetails;
  const running = useContext(TurnRunningContext) && isRunningTool(ev);
  const runningSecs = useElapsed(running ? ev.startedAt : undefined);

  if (ev.kind === "compact" || ev.kind === "notice" || ev.kind === "retry" || ev.kind === "error") {
    return <BannerItem ev={ev} onLoadDetails={onLoadDetails} />;
  }

  const isResult = ev.kind === "tool_result";
  const isToolUse = ev.kind === "tool_use";
  const isThinking = ev.kind === "thinking";
  const toolName = isToolUse ? toolNameOf(ev) : null;
  const summary = isToolUse
    ? toolName === "ViewImage"
      ? viewImagePathOf(ev)
      : toolSummary(ev)
    : "";
  const label = toolName
    ? chipLabelFor(toolName)
    : isThinking
      ? thinkingLabel(ev)
      : (KIND_LABEL[ev.kind] ?? ev.kind);
  const chipClass = chipClassFor(toolName, ev.kind);
  const [firstLine, nextLine] = isToolUse && !summary ? ev.content.split("\n", 2) : [];
  const duplicateHeading =
    firstLine?.trimEnd().toLowerCase() === `**${label.toLowerCase()}**` &&
    /^(?:| {0,3}(?:`{3,}[^`]*|~{3,}.*))$/.test(nextLine?.trimEnd() ?? "");
  const body =
    summary || duplicateHeading
      ? afterFirstLine(ev.content, duplicateHeading ? "" : ev.content)
      : ev.content;
  // Multi-line tool calls (Bash commands, edits) always show their body;
  // single-line ones (Read, Grep) get a summary and an optional details toggle.
  const bodyLen = ev.bodyLength ?? ev.content.length;
  const multiLine =
    isToolUse &&
    toolName !== "ViewImage" &&
    (ev.content.includes("\n") || bodyLen > ev.content.length);
  const showBodyByDefault = isToolUse && (multiLine || !summary);
  const hasHiddenBody =
    isToolUse && toolName !== "ViewImage" && !showBodyByDefault && bodyLen > summary.length + 16;
  const resultLen = isResult
    ? (ev.contentLength ?? ev.content.length)
    : (ev.resultLength ?? ev.toolResult?.length ?? 0);
  const placeholderResult =
    toolName === "ViewImage" &&
    !ev.toolResultIsError &&
    (ev.toolResult === "" ||
      ev.toolResult === "done" ||
      (ev.toolResult == null && ev.resultLength === 0));
  const hasResult =
    isToolUse && !placeholderResult && (ev.toolResult != null || ev.resultLength != null);
  // A summarised body renders as a placeholder until the details arrive.
  const bodyMissing = summarized && !isToolUse && !ev.content && (ev.contentLength ?? 0) > 0;
  const toolBodyMissing =
    summarized && isToolUse && showBodyByDefault && bodyLen > ev.content.length;
  // A summary page cuts a long first line short: nothing whole to copy yet.
  const summaryCut = summarized && ev.content.endsWith("…");
  const toggleResult = () => {
    if (summarized) onLoadDetails?.();
    setResultOpen((v) => !v);
  };
  const toggleBody = () => {
    if (summarized) onLoadDetails?.();
    setBodyOpen((v) => !v);
  };

  const failed = ev.isError || ev.toolResultIsError;
  return (
    <div
      className={`event event-${ev.kind}${failed ? " event-failed" : ""}${liveThinking ? " live-thinking" : ""}`}
    >
      {!liveThinking && (
        <div className="event-row">
          <span className={`event-chip ${chipClass}`}>{label}</span>
          {isToolUse && ev.durationMs != null && (
            <span className="event-time" title="From the call to its result">
              {formatRunTime(ev.durationMs)}
            </span>
          )}
          {running && ev.startedAt != null && (
            <span className="event-time event-time-live" title="Running for">
              {formatDuration(runningSecs * 1000)}
            </span>
          )}
          {hasHiddenBody && (
            <button
              className="btn-inline"
              {...telemetryTarget("trace.tool_toggle")}
              ref={bodyFold.toggle}
              aria-expanded={bodyOpen}
              onClick={toggleBody}
            >
              {bodyOpen ? "Hide" : "Details"}
            </button>
          )}
          {(isResult || hasResult) && (
            <button
              className="btn-inline btn-diff"
              ref={resultFold.toggle}
              aria-expanded={resultOpen}
              {...telemetryTarget("trace.tool_toggle")}
              onClick={toggleResult}
            >
              {isResult ? (resultOpen ? "Hide" : "Show") : resultOpen ? "Hide result" : "Result"} ·{" "}
              {resultLabel(resultLen)}
              {failed ? " · failed" : ""}
            </button>
          )}
        </div>
      )}
      {isToolUse && summary && (
        <div className="event-summary-line">
          {!summaryCut && <CopyButton text={() => summary} />}
          {toolName === "ViewImage" ? (
            <ViewImagePath path={summary} truncated={summaryCut} onLoadDetails={onLoadDetails} />
          ) : (
            <code>{summary}</code>
          )}
        </div>
      )}
      {(bodyMissing || (toolBodyMissing && !bodyOpen)) && (
        <button
          type="button"
          className="event-content event-placeholder"
          {...telemetryTarget("trace.tool_toggle")}
          onClick={isResult ? toggleResult : toggleBody}
        >
          Load details · {formatSize(bodyMissing ? (ev.contentLength ?? 0) : bodyLen)}
        </button>
      )}
      {isResult ? (
        resultOpen &&
        ev.content && (
          <div className="event-content event-result">
            {ev.isMarkdown ? (
              <MdBlock>{ev.content}</MdBlock>
            ) : (
              <CodeBlock>
                <code>{ev.content}</code>
              </CodeBlock>
            )}
          </div>
        )
      ) : (
        <>
          {!bodyMissing &&
            !toolBodyMissing &&
            (!isToolUse || showBodyByDefault || bodyOpen) &&
            (!duplicateHeading || body) &&
            (!liveThinking || body) && (
              <div className="event-content">
                {isThinking ? (
                  <StreamingMdBlock thinking>{body}</StreamingMdBlock>
                ) : (
                  <MdBlock>{body}</MdBlock>
                )}
              </div>
            )}
          {hasHiddenBody && bodyOpen && (
            <BottomCollapse
              onClick={bodyFold.collapse}
              label="Hide details"
              action="trace.tool_toggle"
            />
          )}
          {hasResult && resultOpen && ev.toolResult != null && (
            <div className="event-content event-result">
              {ev.toolResultIsMarkdown ? (
                <MdBlock diagramSlot="result">{ev.toolResult}</MdBlock>
              ) : (
                <CodeBlock>
                  <code>{ev.toolResult}</code>
                </CodeBlock>
              )}
            </div>
          )}
        </>
      )}
      {resultOpen && (isResult ? ev.content : ev.toolResult) && (
        <BottomCollapse
          onClick={resultFold.collapse}
          label="Hide result"
          action="trace.tool_toggle"
        />
      )}
    </div>
  );
});

function useBottomCollapse(open: boolean, close: () => void) {
  const header = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ scroller: HTMLElement | null; clipped: boolean } | null>(null);
  const topOfViewport = (scroller: HTMLElement | null) =>
    scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;

  useLayoutEffect(() => {
    const el = header.current ?? toggle.current;
    if (open || !pending.current || !el) return;
    const { scroller, clipped } = pending.current;
    pending.current = null;
    toggle.current?.focus({ preventScroll: true });
    if (!clipped) return;
    // Measure again after the body is removed: the browser may already have
    // clamped the scroll offset, particularly at the end of the transcript.
    const delta = el.getBoundingClientRect().top - topOfViewport(scroller);
    if (delta < 0) (scroller ?? window).scrollBy({ top: delta, behavior: "instant" });
  }, [open]);

  return {
    header,
    toggle,
    collapse: () => {
      const el = header.current ?? toggle.current;
      if (el) {
        let scroller = el.parentElement;
        while (scroller && !/^(auto|scroll|overlay)$/.test(getComputedStyle(scroller).overflowY)) {
          scroller = scroller.parentElement;
        }
        pending.current = {
          scroller,
          clipped: el.getBoundingClientRect().top < topOfViewport(scroller),
        };
      }
      close();
    },
  };
}

function BottomCollapse({
  onClick,
  label,
  action,
}: {
  onClick: () => void;
  label: string;
  action: "trace.step_toggle" | "trace.subagent_toggle" | "trace.tool_toggle";
}) {
  const tool = action === "trace.tool_toggle";
  const button = (
    <button
      type="button"
      className={tool ? "btn-inline tool-collapse" : "trace-collapse"}
      {...telemetryTarget(action)}
      onClick={onClick}
    >
      <span aria-hidden="true">▴</span> {label}
    </button>
  );
  return tool ? button : <div className="trace-collapse-footer">{button}</div>;
}

function hasVisibleEventBody(ev: StreamEvent): boolean {
  return ev.kind !== "thinking" || !!ev.content.trim() || (ev.contentLength ?? 0) > 0;
}

const SUBAGENT_STATUS_ICONS: Record<SubagentStatus, string> = {
  queued: "◷",
  running: "↻",
  completed: "✓",
  failed: "✗",
  partial: "◐",
  paused: "Ⅱ",
  stopped: "◼",
  rejected: "⊘",
};

type TraceScope = {
  messageId: string;
  rootTaskId: string;
  path: readonly string[];
  revision: number;
};
const ROOT_TRACE_PATH: readonly string[] = [];
const LATEST_TRACE_PAGE: Pick<TraceWindow, "cursor" | "direction"> = {};

export const SubAgentItem = memo(function SubAgentItem({
  ev,
  messageId,
  traceParent,
  onCancel,
}: {
  ev: StreamEvent;
  messageId?: string;
  traceParent?: TraceScope;
  onCancel?: (taskId: string) => void;
}) {
  const [open, setOpen] = useTranscriptChoice<boolean>("subagent", false);
  const reset = useResetTranscriptChoices();
  const close = () => {
    reset("trace");
    setOpen(false);
  };
  const bottom = useBottomCollapse(open, close);
  const sa = ev.subagent;
  const parentPath = traceParent?.path;
  const taskId = sa?.taskId;
  const path = useMemo(
    () => (parentPath && taskId ? [...parentPath, taskId] : ROOT_TRACE_PATH),
    [parentPath, taskId],
  );
  if (!sa) return null;
  const scope: TraceScope = {
    path,
    messageId: traceParent?.messageId ?? messageId ?? "",
    rootTaskId: traceParent?.rootTaskId ?? sa.taskId,
    revision: traceParent?.revision ?? sa.transcriptRevision ?? 0,
  };
  const status = sa.status ?? (ev.kind === "subagent_done" ? "failed" : "stopped");
  const outstanding = isOutstandingSubagentStatus(status);
  const ran = sa.durationMs ?? (outstanding ? undefined : sa.usage?.durationMs);
  const role = sa.description || "Subagent";
  return (
    <div className={`subagent-item subagent-${status}`}>
      <div
        className="subagent-header"
        ref={bottom.header}
        {...telemetryTarget("trace.subagent_toggle")}
        onClick={open ? close : () => setOpen(true)}
      >
        <button
          type="button"
          className="events-toggle trace-header-toggle"
          ref={bottom.toggle}
          aria-expanded={open}
          {...telemetryTarget("trace.subagent_toggle")}
          aria-label={`${open ? "Collapse" : "Expand"} subagent: ${role}`}
        >
          <span className="trace-caret" aria-hidden="true">
            ▸
          </span>
        </button>
        <span className={`subagent-status-icon subagent-icon-${status}`} title={status}>
          {SUBAGENT_STATUS_ICONS[status]}
        </span>
        <span className="subagent-desc" title={role}>
          {role}
        </span>
        {sa.model && (
          <span className="subagent-model" title={sa.model}>
            {shortModel(sa.model)}
          </span>
        )}
        {sa.effort && (
          <span className="subagent-effort" title={`Effort: ${sa.effort}`}>
            {sa.effort}
          </span>
        )}
        {ran != null && (
          <span className="subagent-time" title="How long it ran">
            {formatRunTime(ran)}
          </span>
        )}
        {status === "running" && <span className="streaming-dot" />}
        {outstanding && sa.cancellable !== false && onCancel && (
          <button
            className="btn-cancel-subagent"
            title="Cancel this subagent"
            onClick={(e) => {
              e.stopPropagation();
              onCancel(sa.taskId);
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {open && <SubagentDetails scope={scope} onCollapse={bottom.collapse} />}
    </div>
  );
});

function eventFromTraceRow(row: TraceRow): StreamEvent {
  const hiddenChild = !row.child && SUBAGENT_KINDS.has(row.kind);
  return {
    kind: row.kind === "omitted" || hiddenChild ? "notice" : row.kind,
    content: row.kind === "omitted" ? "Step shortened to fit this page." : row.content,
    toolName: row.toolName,
    toolUseId: row.toolUseId,
    toolResult: row.toolResult,
    isMarkdown: row.isMarkdown,
    toolResultIsMarkdown: row.toolResultIsMarkdown,
    ...(row.failed && (row.kind === "tool_use" ? { toolResultIsError: true } : { isError: true })),
    durationMs: row.durationMs,
    subagent: row.child,
  };
}

function SubagentDetails({ scope, onCollapse }: { scope: TraceScope; onCollapse: () => void }) {
  const connection = useContext(SubagentTraceContext);
  const workspaceId = connection?.workspaceId;
  const { messageId, rootTaskId, path, revision } = scope;
  const target = useMemo(
    () => (workspaceId && messageId ? { workspaceId, messageId, taskId: rootTaskId } : null),
    [workspaceId, messageId, rootTaskId],
  );
  const [cursor, setCursor] = useTranscriptChoice<Pick<TraceWindow, "cursor" | "direction">>(
    "trace-page",
    LATEST_TRACE_PAGE,
  );
  const window = useMemo(() => ({ ...cursor, ...(path.length ? { path } : {}) }), [cursor, path]);
  const { page, isNavigating, timedOut } = useTracePage(connection, target, window, revision);
  const projection = useMemo(() => {
    const events = page?.events.map(eventFromTraceRow) ?? [];
    return { blocks: timelineBlocks(events), indexes: new Map(events.map((ev, i) => [ev, i])) };
  }, [page]);
  const loading = !target
    ? "Trace is unavailable."
    : connection?.epoch == null
      ? "Offline. Waiting to reconnect…"
      : timedOut
        ? "Trace request timed out."
        : !page || (isNavigating && page.unavailable)
          ? "Loading trace…"
          : isNavigating
            ? "Loading page…"
            : page.unavailable
              ? "Trace is unavailable."
              : null;
  const usage = page?.usage;
  const reset = () => setCursor(LATEST_TRACE_PAGE);
  return (
    <div className="subagent-details subagent-body">
      {loading && (
        <div className="subagent-loading" role="status">
          {loading}
          {(timedOut || (!isNavigating && page?.unavailable)) && connection?.epoch != null && (
            <button
              type="button"
              className="btn-inline"
              {...telemetryTarget("trace.subagent_page")}
              onClick={() => setCursor({ ...cursor })}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {page && !page.unavailable && (
        <div
          className="subagent-trace-page"
          data-trace-entries={page.events.length}
          data-trace-bytes={traceBytes(page)}
        >
          {page.prompt && (
            <div className="subagent-prompt">
              <MdBlock>{page.prompt}</MdBlock>
            </div>
          )}
          {page.totalEvents > page.events.length && (
            <nav className="subagent-pagination" aria-label="Trace pages">
              <span>
                {page.events.length ? `${page.start + 1}–${page.end} of ` : ""}
                {page.totalEvents} steps
              </span>
              <button
                type="button"
                className="btn-inline"
                {...telemetryTarget("trace.subagent_page")}
                disabled={!page.start || isNavigating || connection?.epoch == null}
                onClick={() => setCursor({ direction: "before", cursor: page.start })}
              >
                Earlier
              </button>
              <button
                type="button"
                className="btn-inline"
                {...telemetryTarget("trace.subagent_page")}
                disabled={page.end >= page.totalEvents || isNavigating || connection?.epoch == null}
                onClick={() => setCursor({ direction: "after", cursor: page.end })}
              >
                Newer
              </button>
              <button
                type="button"
                className="btn-inline"
                {...telemetryTarget("trace.subagent_page")}
                disabled={cursor.cursor == null || connection?.epoch == null}
                onClick={reset}
              >
                Latest
              </button>
            </nav>
          )}
          {page.truncated && (
            <div className="subagent-loading">Some detail was shortened to fit this page.</div>
          )}
          {!page.totalEvents && !page.prompt && !page.result && (
            <div className="subagent-loading">No trace steps recorded.</div>
          )}
          {projection.blocks.length > 0 && (
            <div className="subagent-events">
              {projection.blocks.flatMap((block, i) =>
                block.kind === "steps"
                  ? block.events.map((ev) => {
                      const key = `trace:${page.start + projection.indexes.get(ev)!}`;
                      return (
                        <TranscriptChoiceScope key={key} id={key}>
                          <EventItem ev={ev} />
                        </TranscriptChoiceScope>
                      );
                    })
                  : [
                      <TranscriptChoiceScope
                        key={`trace:${page.start}:${timelineBlockKey(block, i)}`}
                        id={`trace:${page.start}:${timelineBlockKey(block, i)}`}
                      >
                        <TimelineBlockItem block={block} traceParent={scope} />
                      </TranscriptChoiceScope>,
                    ],
              )}
            </div>
          )}
          {page.result && (
            <div className="subagent-summary">
              <MdBlock diagramSlot="result">{page.result}</MdBlock>
            </div>
          )}
          {usage && (
            <div className="subagent-usage">
              {formatTokens(usage.totalTokens)} tokens · {usage.toolUses} tools
            </div>
          )}
        </div>
      )}
      <BottomCollapse
        onClick={onCollapse}
        label="Collapse subagent"
        action="trace.subagent_toggle"
      />
    </div>
  );
}

function stepSummary(regular: StreamEvent[]): string {
  const count = (kind: string) => regular.filter((e) => e.kind === kind).length;
  const thinkingCount = count("thinking");
  const toolCount = count("tool_use");
  const errorCount = count("error");
  const resultCount = count("tool_result");
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
  if (resultCount > 0) parts.push(`${resultCount} result${resultCount === 1 ? "" : "s"}`);
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
  const other = regular.length - thinkingCount - toolCount - resultCount - errorCount;
  if (other > 0) parts.push(`${other} other`);
  if (parts.length === 0) parts.push(`${regular.length} event${regular.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// Tool names in order of first use, for the collapsed step header.
function stepTools(regular: StreamEvent[]): string[] {
  const seen: string[] = [];
  for (const e of regular) {
    if (e.kind !== "tool_use") continue;
    const n = toolNameOf(e);
    if (n && !seen.includes(n)) seen.push(n);
  }
  return seen;
}

function elapsedSeconds(now: number, since: number): number {
  return Math.max(0, Math.floor((now - since) / 1000));
}

function nextSecondAt(now: number, since: number): number {
  return since + (elapsedSeconds(now, since) + 1) * 1000;
}

// Schedule against the phase's start, not the previous phase's tick cadence.
function useRenderAt(at: number) {
  const [ticks, tick] = useState(0);
  // Re-arm even at the same deadline if the wall clock moved backward.
  useEffect(() => {
    if (!Number.isFinite(at)) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [at, ticks]);
}

function useElapsed(since: number | undefined): number {
  const now = Date.now();
  useRenderAt(since == null ? Infinity : nextSecondAt(now, since));
  return since == null ? 0 : elapsedSeconds(now, since);
}

function StepTools({ tools }: { tools: string[] }) {
  const strip = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const [fadeStart, setFadeStart] = useState(false);
  const [fadeEnd, setFadeEnd] = useState(false);
  const measure = useCallback(() => {
    // A queued resize can arrive after React clears the ref, before effect cleanup.
    const el = strip.current;
    if (!el) return;
    setFadeStart(el.scrollLeft > 1);
    setFadeEnd(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
  }, []);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip.current!);
    observer.observe(track.current!);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <span
      className="step-tools"
      ref={strip}
      onScroll={measure}
      tabIndex={fadeStart || fadeEnd ? 0 : undefined}
      data-fade-start={fadeStart || undefined}
      data-fade-end={fadeEnd || undefined}
    >
      <span className="step-tools-track" ref={track}>
        {tools.slice(0, 6).map((t) => (
          <span key={t} className={`event-chip chip-mini ${chipClassFor(t, "tool_use")}`}>
            {chipLabelFor(t)}
          </span>
        ))}
        {tools.length > 6 && <span className="step-tools-more">+{tools.length - 6}</span>}
      </span>
    </span>
  );
}

// Live thinking joins the last box without changing the reader's choice to open it.
function StepBox({
  events,
  live,
  liveSince,
  onLoadDetails,
  defaultOpen = false,
}: {
  events: StreamEvent[];
  live?: string;
  liveSince?: number;
  onLoadDetails?: () => void;
  defaultOpen?: boolean;
}) {
  const [toggled, setToggled] = useTranscriptChoice<boolean | null>("steps", null);
  const reset = useResetTranscriptChoices();
  const hasBody = !!live?.trim() || events.some(hasVisibleEventBody);
  const open = hasBody && (toggled ?? defaultOpen);
  const close = () => {
    reset("step:");
    setToggled(false);
  };
  const bottom = useBottomCollapse(open, close);
  if (events.length === 0 && live == null && liveSince == null) return null;
  const toggle = () => {
    if (open) close();
    else {
      onLoadDetails?.();
      setToggled(true);
    }
  };
  const tools = stepTools(events);
  const items = open
    ? events.map((ev, i) => (
        <TranscriptChoiceScope key={i} id={`step:${i}`}>
          <EventItem ev={ev} onLoadDetails={onLoadDetails} />
        </TranscriptChoiceScope>
      ))
    : [];
  // The persisted event takes the same slot, preserving state inside its Markdown body.
  if (open && live != null) {
    items.push(
      <TranscriptChoiceScope key={events.length} id={`step:${events.length}`}>
        <EventItem ev={{ kind: "thinking", content: live }} liveThinking />
      </TranscriptChoiceScope>,
    );
  }
  return (
    <div className={`step-group${open ? " open" : ""}`}>
      <div
        className={`step-header${hasBody ? "" : " step-header-static"}`}
        ref={bottom.header}
        {...telemetryTarget(hasBody ? "trace.step_toggle" : undefined)}
        onClick={hasBody ? toggle : undefined}
      >
        {hasBody ? (
          <button
            type="button"
            className="events-toggle trace-header-toggle"
            ref={bottom.toggle}
            aria-expanded={open}
            {...telemetryTarget("trace.step_toggle")}
            aria-label={open ? "Collapse steps" : "Expand steps"}
          >
            <span className="trace-caret" aria-hidden="true">
              ▸
            </span>
          </button>
        ) : (
          <span className="trace-header-placeholder" aria-hidden="true" />
        )}
        {events.length > 0 && <span className="step-summary">{stepSummary(events)}</span>}
        {liveSince != null && <StepThinkingStatus since={liveSince} />}
        {!open && tools.length > 0 && <StepTools tools={tools} />}
      </div>
      {open && (
        <div className="events-list">
          {items}
          <BottomCollapse
            onClick={bottom.collapse}
            label="Collapse steps"
            action="trace.step_toggle"
          />
        </div>
      )}
    </div>
  );
}

// A segment's events in timeline order: each subagent card and banner is a
// boundary, so the step boxes between them count only what happened there.
type StepTimelineProps = {
  blocks: TimelineBlock[];
  messageId?: string;
  traceParent?: TraceScope;
  onCancelSubagent?: (taskId: string) => void;
  onLoadDetails?: () => void;
  defaultOpen?: boolean;
  // A thinking block streaming in or between its closing delta and final event.
  live?: string;
  liveSince?: number;
};

export function StepGroup({
  group,
  ...props
}: Omit<StepTimelineProps, "blocks"> & { group: { step: number; events: StreamEvent[] } }) {
  return <StepTimeline blocks={timelineBlocks(group.events)} {...props} />;
}

function StepTimeline({
  blocks,
  messageId,
  onCancelSubagent,
  onLoadDetails,
  defaultOpen = false,
  live,
  liveSince,
}: StepTimelineProps) {
  if ((live != null || liveSince != null) && blocks.at(-1)?.kind !== "steps") {
    blocks = [...blocks, { kind: "steps", events: [] }];
  }
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "steps") {
          return (
            <TranscriptChoiceScope key={`s${i}`} id={`steps:${i}`}>
              <StepBox
                events={block.events}
                live={i === blocks.length - 1 ? live : undefined}
                liveSince={i === blocks.length - 1 ? liveSince : undefined}
                onLoadDetails={onLoadDetails}
                defaultOpen={defaultOpen}
              />
            </TranscriptChoiceScope>
          );
        }
        return (
          <TranscriptChoiceScope key={timelineBlockKey(block, i)} id={timelineBlockKey(block, i)}>
            <TimelineBlockItem
              block={block}
              messageId={messageId}
              onCancelSubagent={onCancelSubagent}
              onLoadDetails={onLoadDetails}
            />
          </TranscriptChoiceScope>
        );
      })}
    </>
  );
}

type TimelineCard = Exclude<TimelineBlock, { kind: "steps" }>;

function timelineBlockKey(block: TimelineCard, index: number): string {
  return block.kind === "subagent" ? `task-${block.ev.subagent!.taskId}` : `${block.kind}-${index}`;
}

function TimelineBlockItem({
  block,
  messageId,
  traceParent,
  onCancelSubagent,
  onLoadDetails,
}: Pick<StepTimelineProps, "messageId" | "traceParent" | "onCancelSubagent" | "onLoadDetails"> & {
  block: TimelineCard;
}) {
  switch (block.kind) {
    case "banner":
      return <BannerItem ev={block.ev} onLoadDetails={onLoadDetails} />;
    case "action":
      return <PanelActionItem ev={block.ev} action={block.action} onLoadDetails={onLoadDetails} />;
    case "subagent":
      return (
        <SubAgentItem
          ev={block.ev}
          messageId={messageId}
          traceParent={traceParent}
          onCancel={onCancelSubagent}
        />
      );
  }
}

function StepThinkingStatus({ since }: { since: number }) {
  const secs = useElapsed(since);
  return (
    <span className="event-chip chip-thinking chip-live">
      <span className="streaming-dot" />
      Thinking · {secs}s
    </span>
  );
}

const CALL_SHOWN_AFTER_S = 3;

function isRunningTool(e: StreamEvent): boolean {
  return (
    e.kind === "tool_use" && e.toolResult == null && e.resultLength == null && e.durationMs == null
  );
}

// A tool call still running or a subagent still working: the turn is not
// waiting on the model.
function workInFlight(events: StreamEvent[]): boolean {
  return events.some(isRunningTool) || hasOutstandingSubagents(events);
}

const WAIT_SHOWN_AFTER_S = 15;

function TurnFooter({
  msg,
  activity,
  detailEvents,
}: {
  msg: Message;
  activity?: string | null;
  detailEvents: StreamEvent[];
}) {
  const now = Date.now();
  const thinkingLive = msg.liveThinkingSince != null;
  let call: StreamEvent | undefined;
  let waitElapsed: number | null = null;
  let tickAt = Infinity;
  if (!activity && !thinkingLive) {
    for (let i = detailEvents.length - 1; i >= 0; i--) {
      const e = detailEvents[i];
      if (!isRunningTool(e) || e.startedAt == null) continue;
      const showAt = e.startedAt + CALL_SHOWN_AFTER_S * 1000;
      if (showAt <= now) {
        call = e;
        break;
      }
      tickAt = Math.min(tickAt, showAt);
    }
    if (call?.startedAt != null) {
      tickAt = Math.min(tickAt, nextSecondAt(now, call.startedAt));
    } else if (
      msg.waitingSince != null &&
      !workInFlight(detailEvents) &&
      !detailEvents.some((e) => e.kind === "retry")
    ) {
      const elapsed = elapsedSeconds(now, msg.waitingSince);
      if (elapsed >= WAIT_SHOWN_AFTER_S) {
        waitElapsed = elapsed;
        tickAt = Math.min(tickAt, nextSecondAt(now, msg.waitingSince));
      } else {
        tickAt = Math.min(tickAt, msg.waitingSince + WAIT_SHOWN_AFTER_S * 1000);
      }
    }
  }
  useRenderAt(tickAt);

  const label =
    activity ||
    (call
      ? `${chipLabelFor(toolNameOf(call) ?? "tool")} · ${formatDuration(elapsedSeconds(now, call.startedAt!) * 1000)}`
      : null);

  if (!label && waitElapsed == null) return null;

  return (
    <div className="turn-footer">
      {label ? <span className="turn-activity">{label}</span> : `No new events for ${waitElapsed}s`}
    </div>
  );
}

// One broken message (an old persisted event missing a field, an unexpected
// shape) must not blank the whole transcript.
export class MessageBoundary extends Component<
  { children: ReactNode; messageId: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(err: unknown): void {
    console.error("[render] message", this.props.messageId, err);
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div id={`msg-${this.props.messageId}`} className="message-render-error" tabIndex={-1}>
          This message could not be rendered.
        </div>
      );
    }
    return this.props.children;
  }
}

// The server leads an agent's notices with its avatar ("avatars/Alice.jpg
// **Alice** joined the team"): an image, not text to show.
function systemAvatar(content: string): [string | null, string] {
  const m = /^(avatars\/[^\s]+\.(?:jpe?g|png|webp|gif)) (.*)$/is.exec(content);
  return m ? [m[1], m[2]] : [null, content];
}

function PendingDeliveryStatus({ label }: { label: string }) {
  return (
    <span className="delivery-inline" role="status">
      <span className="streaming-dot" aria-hidden="true" /> {label}
    </span>
  );
}

function ReplyAvatar({ agent }: { agent?: AgentInfo }) {
  return agent ? <AgentAvatar agent={agent} size={32} /> : <div className="avatar-user">?</div>;
}

function AgentHeading({
  agent,
  model,
  time,
  timeTitle,
  streaming,
  starting,
}: {
  agent?: AgentInfo;
  model?: string;
  time?: string;
  timeTitle?: string;
  streaming?: boolean;
  starting?: boolean;
}) {
  const modelLabel = agent && shortModel(model ?? agent.model);
  return (
    <>
      {(agent || starting) && (
        <span
          className="message-author"
          title={agent?.name}
          style={agent ? { color: agentNameColor(agent.color) } : undefined}
        >
          {agent?.name ?? "Agent"}
        </span>
      )}
      {modelLabel !== undefined && (
        <span className="message-model" title={modelLabel}>
          {modelLabel}
        </span>
      )}
      <span
        className={`message-time${starting || streaming ? " message-live-time" : ""}`}
        title={timeTitle}
        role={starting ? "status" : undefined}
      >
        {starting ? "Starting…" : time}
      </span>
      {(starting || streaming) && <span className="streaming-dot" aria-hidden="true" />}
    </>
  );
}

export const MessageItem = memo(function MessageItem({
  user = DEFAULT_USER,
  msg,
  agents,
  compact,
  highlight,
  hasReply,
  onStartingRow,
  onQuote,
  onJumpToMessage,
  onCancelSubagent,
  onCancelQueued,
  onLoadDetails,
  onOpenWorkspace,
}: {
  msg: Message;
  agents: AgentInfo[];
  user?: typeof DEFAULT_USER;
  compact?: boolean;
  highlight?: boolean;
  hasReply?: boolean;
  onStartingRow?: (row: HTMLDivElement | null) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
  onQuote?: (msg: Message) => void;
  onJumpToMessage?: (messageId: string) => void;
  onCancelSubagent?: (agentId: string, taskId: string) => void;
  onCancelQueued?: (messageId: string) => void;
  onLoadDetails?: (messageId: string) => void;
}) {
  // Only wired while the message is a summary; once details arrive the
  // prop becomes undefined and the items render their bodies directly.
  const summarized = msg.detail === "summary";
  const handleLoadDetails = useMemo(
    () => (summarized && onLoadDetails ? () => onLoadDetails(msg.id) : undefined),
    [summarized, onLoadDetails, msg.id],
  );
  const outerLinks = useContext(SessionLinkContext);
  const localDayKey = useContext(LocalDayContext);
  const sessionLinks = useMemo(
    () => ({ ...outerLinks, ...(onOpenWorkspace && { open: onOpenWorkspace }) }),
    [outerLinks, onOpenWorkspace],
  );
  const agentId = msg.agentId;
  const handleCancelSubagent = useMemo(
    () =>
      onCancelSubagent && agentId
        ? (taskId: string) => onCancelSubagent(agentId, taskId)
        : undefined,
    [agentId, onCancelSubagent],
  );

  const isUser = msg.kind === "user";
  const starting = isUser && msg.status === "starting";
  const sending = isUser && msg.status === "dispatching";
  const pending = (starting || sending) && !hasReply;
  const showStarting = pending && msg.pendingDelivery === "starting";
  const showSending = pending && msg.pendingDelivery === "sending";
  const target = showStarting ? agents.find((a) => a.id === msg.queuedFor) : undefined;

  if (msg.kind === "system") {
    const [avatar, text] = systemAvatar(msg.content);
    return (
      <div id={`msg-${msg.id}`} className="system-message" tabIndex={-1}>
        {avatar && <img className="system-avatar" src={avatar} alt="" />}
        <div className="system-message-body">
          <MdBlock>{text}</MdBlock>
        </div>
      </div>
    );
  }

  const from = isUser ? msg.from : undefined;
  const agent = !isUser ? agents.find((a) => a.id === msg.agentId) : undefined;
  const streaming = msg.status === "streaming";
  const deliveryClass =
    msg.status === "queued"
      ? " message-queued"
      : msg.status === "outcome_unknown"
        ? " message-outcome-unknown"
        : msg.status === "error"
          ? " message-error"
          : "";
  const events = msg.events ?? [];
  const detailEvents = events.filter(
    (e) => e.kind !== "text" && e.kind !== "text_delta" && e.kind !== "thinking_delta",
  );

  // Interleaved segments, using contentOffset to split msg.content. One
  // layout whatever has arrived so far: switching shapes when the first text
  // lands would remount the step boxes and fold whatever the reader opened.
  type Segment = { text: string; events: StreamEvent[] };
  const segments: Segment[] = [];
  const body = msg.content ?? "";
  // A thinking block that starts now lands at the current end of the text:
  // with the last events if no text followed them.
  let joinsLastEvents = false;
  if (!isUser && detailEvents.length === 0 && body) {
    segments.push({ text: body, events: [] });
  } else if (!isUser && detailEvents.length > 0) {
    // Events without an offset (older logs, error events) belong after all
    // the text rather than nowhere; subagent lifecycle events always sit
    // with their subagent_start so a task never splits across segments.
    const startOffsets = new Map<string, number>();
    for (const e of detailEvents) {
      if (e.kind === "subagent_start" && e.subagent?.taskId && e.contentOffset != null) {
        startOffsets.set(e.subagent.taskId, e.contentOffset);
      }
    }
    // Older logs carry no offsets at all: those events all happened before
    // the answer, so they go first, not after it. Within newer logs an event
    // without one (errors, some notices) sits with the event before it.
    const anyOffset = detailEvents.some((e) => e.contentOffset != null);
    const resolved = new Map<StreamEvent, number>();
    let last = 0;
    for (const e of detailEvents) {
      const taskId = e.subagent?.taskId;
      const own = taskId && startOffsets.has(taskId) ? startOffsets.get(taskId)! : e.contentOffset;
      const off = !anyOffset ? 0 : (own ?? last);
      resolved.set(e, off);
      last = off;
    }
    const offsetOf = (e: StreamEvent): number => resolved.get(e) ?? 0;
    const uniqueOffsets = [...new Set(detailEvents.map(offsetOf))].sort((a, b) => a - b);

    let prevOff = 0;
    for (const off of uniqueOffsets) {
      const text = body.substring(prevOff, off).trim();
      const evtsAtOff = detailEvents.filter((e) => offsetOf(e) === off);
      segments.push({ text, events: evtsAtOff });
      prevOff = off;
    }
    const trailing = body.substring(prevOff).trim();
    if (trailing || streaming) {
      segments.push({ text: trailing, events: [] });
    }
    joinsLastEvents = body.length === prevOff;
  }

  let tailAt = -1;
  if (!isUser && streaming) {
    if (segments.length === 0) segments.push({ text: "", events: [] });
    tailAt = joinsLastEvents ? segments.length - 2 : segments.length - 1;
  }
  const liveSince = msg.liveThinkingSince;
  const headerLiveSince = agent?.activity ? undefined : liveSince;
  const liveBlock = headerLiveSince != null ? (msg.liveThinking ?? "") : msg.closingThinking;
  const tailBlocks = tailAt >= 0 ? timelineBlocks(segments[tailAt].events) : [];

  const time = formatMessageTime(
    msg.timestamp,
    localDayKey ? parseLocalDayKey(localDayKey) : Date.now(),
  );
  const timeTitle = formatFullDateTime(msg.timestamp);

  const quoteButton =
    !isUser && onQuote && segments.length > 0 ? (
      <button
        type="button"
        className="btn-quote"
        aria-label="Quote this message"
        title="Quote this message"
        onClick={() => onQuote(msg)}
      >
        ↩
      </button>
    ) : null;
  const copyBody =
    (msg.status === "done" || msg.status === "error" || msg.status === "outcome_unknown") &&
    body.trim();
  // Keep the timestamp and the delivery label in place until the copy action mounts.
  const reserveCopy = (starting || sending) && body.trim();
  const actions =
    !streaming && (quoteButton || copyBody || reserveCopy) ? (
      <div className="message-actions">
        {quoteButton}
        {copyBody && (
          <CopyButton className="btn-copy-message" label="Copy message" text={() => body} />
        )}
      </div>
    ) : null;

  const forward = msg.forwardRef;
  const jump = forward?.messageId && onJumpToMessage;
  const ForwardRef = jump ? "button" : "div";

  return (
    <SessionLinkContext.Provider value={sessionLinks}>
      <TurnRunningContext.Provider value={streaming}>
        <div
          id={`msg-${msg.id}`}
          tabIndex={-1}
          className={`message${isUser ? " message-user" : " message-agent"}${compact ? " message-compact" : ""}${highlight ? " message-highlight" : ""}${deliveryClass}`}
        >
          <div className="message-gutter">
            {compact ? null : from ? (
              <div className="avatar-from">{ORIGIN_GLYPH[from.role]}</div>
            ) : isUser ? (
              <div className="avatar-user">
                {isImageAvatar(user.avatar) ? (
                  <img
                    src={user.avatar}
                    alt={user.name}
                    style={{
                      width: "100%",
                      height: "100%",
                      borderRadius: "50%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  user.avatar
                )}
              </div>
            ) : (
              <ReplyAvatar agent={agent} />
            )}
          </div>
          <div className="message-body">
            {!compact && (
              <div className="message-header">
                {isUser ? (
                  <>
                    {from && onOpenWorkspace ? (
                      <button
                        className="message-author from-author"
                        title="Open that session"
                        onClick={() => onOpenWorkspace(from.workspaceId)}
                      >
                        {originLabel(from)}
                      </button>
                    ) : from ? (
                      <span className="message-author from-author">{originLabel(from)}</span>
                    ) : (
                      <span className="message-author user-author" title={user.name}>
                        {user.name}
                      </span>
                    )}
                    {msg.status === "queued" && (
                      <span
                        className="queued-badge"
                        title={msg.steering ? "Sent into the running turn" : undefined}
                      >
                        queued
                        {onCancelQueued && !msg.steering && (
                          <button
                            className="queued-cancel"
                            title="Remove from queue"
                            onClick={() => onCancelQueued(msg.id)}
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    )}
                    <span className="message-time" title={timeTitle}>
                      {time}
                    </span>
                    {msg.status !== "queued" && (
                      <span className="delivery-inline-slot">
                        {showSending && <PendingDeliveryStatus label="Sending…" />}
                      </span>
                    )}
                  </>
                ) : (
                  <AgentHeading
                    agent={agent}
                    model={msg.model}
                    time={time}
                    timeTitle={timeTitle}
                    streaming={streaming}
                  />
                )}
                {actions}
              </div>
            )}
            {compact && (
              <div className="compact-header">
                <span className="message-time" title={timeTitle}>
                  {time}
                </span>
                {streaming && <span className="streaming-dot" />}
                {actions}
              </div>
            )}
            {!isUser && <MessageStatus msg={msg} />}

            {msg.status === "outcome_unknown" && (
              <div className="delivery-status delivery-outcome-unknown" role="alert">
                <strong>Delivery outcome unknown.</strong> The agent may still process this message.
                The panel will not resend it automatically. Verify what happened before retrying.
              </div>
            )}

            {forward && (
              <ForwardRef
                className="forward-ref"
                {...(jump && {
                  type: "button" as const,
                  title: "Jump to quoted message",
                  ...telemetryTarget("chat.quote_jump"),
                  "aria-label": `Jump to quoted message from ${forward.fromAgent}: ${forward.preview}`,
                  onClick: () => jump(forward.messageId),
                })}
              >
                <span className="forward-ref-icon">↩</span>
                <span className="forward-ref-agent">
                  <Avatar
                    avatar={forward.fromAvatar}
                    color={agents.find((a) => a.name === forward.fromAgent)?.color ?? "transparent"}
                    name={forward.fromAgent}
                    size={16}
                  />
                  {forward.fromAgent}
                </span>
                <span className="forward-ref-preview">{forward.preview}</span>
              </ForwardRef>
            )}

            {msg.images && msg.images.length > 0 && (
              <div className="msg-images">
                {msg.images.map((img, i) => (
                  <a key={i} href={img.url} target="_blank" rel="noopener noreferrer">
                    <img src={img.url} alt={img.name} />
                  </a>
                ))}
              </div>
            )}

            {isUser
              ? msg.content && (
                  <div className="message-content" onCopy={copySelectionAsMarkdown}>
                    {renderMentionContent(msg.content, agents)}
                  </div>
                )
              : segments.length > 0 && (
                  <div className="message-content" onCopy={copySelectionAsMarkdown}>
                    {segments.map((seg, si) => (
                      <div key={si}>
                        <TranscriptChoiceScope id={`segment:${si}`}>
                          {seg.text &&
                            (streaming ? (
                              <StreamingMdBlock>{seg.text}</StreamingMdBlock>
                            ) : (
                              <MdBlock>{seg.text}</MdBlock>
                            ))}
                          {(seg.events.length > 0 || si === tailAt) && (
                            <StepTimeline
                              blocks={si === tailAt ? tailBlocks : timelineBlocks(seg.events)}
                              messageId={msg.id}
                              onCancelSubagent={handleCancelSubagent}
                              onLoadDetails={handleLoadDetails}
                              live={si === tailAt ? liveBlock : undefined}
                              liveSince={si === tailAt ? headerLiveSince : undefined}
                            />
                          )}
                        </TranscriptChoiceScope>
                      </div>
                    ))}
                  </div>
                )}
            {!isUser && streaming && (
              <TurnFooter msg={msg} activity={agent?.activity} detailEvents={detailEvents} />
            )}
          </div>
        </div>
        {showStarting && (
          <div className="message message-agent message-starting" ref={onStartingRow}>
            <div className="message-gutter">
              <ReplyAvatar agent={target} />
            </div>
            <div className="message-body">
              <div className="message-header">
                <AgentHeading agent={target} starting />
              </div>
              {target && (
                <MessageStatus
                  msg={{ effort: target.effort ?? target.effectiveEffort, fast: target.fast }}
                />
              )}
            </div>
          </div>
        )}
      </TurnRunningContext.Provider>
    </SessionLinkContext.Provider>
  );
});
