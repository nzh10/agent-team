import type { Message } from "./workspace";
import type { StreamEvent } from "../session/types";
import { panelActionOf } from "../../../shared/panel-actions";

// History pages carry only what the collapsed view needs: kinds, chips,
// counts, banners. Bodies (thinking text, tool output, subagent transcripts)
// are fetched per message when the user expands something. This keeps a
// 50-message page in the tens of KB instead of megabytes.

const FIRST_LINE_MAX = 200;
const BANNER_MAX = 600;

// Cut to BANNER_MAX with the ellipsis inside it, so a cut text is always
// shorter than its recorded length.
function capped(s: string): string {
  return s.length > BANNER_MAX ? s.slice(0, BANNER_MAX - 1) + "…" : s;
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > FIRST_LINE_MAX ? line.slice(0, FIRST_LINE_MAX) + "…" : line;
}

export function summarizeEvent(e: StreamEvent): StreamEvent {
  const base: StreamEvent = { kind: e.kind, content: "" };
  if (e.toolName) base.toolName = e.toolName;
  if (e.level) base.level = e.level;
  if (e.toolUseId) base.toolUseId = e.toolUseId;
  if (e.contentOffset != null) base.contentOffset = e.contentOffset;
  if (e.step != null) base.step = e.step;
  if (e.isMarkdown) base.isMarkdown = true;
  if (e.toolResultIsMarkdown) base.toolResultIsMarkdown = true;
  if (e.toolResultIsError) base.toolResultIsError = true;
  if (e.durationMs != null) base.durationMs = e.durationMs;
  if (e.startedAt != null) base.startedAt = e.startedAt;
  if (e.tokens != null) base.tokens = e.tokens;

  switch (e.kind) {
    case "tool_use":
      // The panel's calls show as lines of their own (a session started, a
      // message sent): what was sent and answered, like a banner's text.
      if (panelActionOf(e)) {
        base.content = capped(e.content ?? "");
        base.bodyLength = (e.content ?? "").length;
        if (e.toolResult != null) {
          base.toolResult = capped(e.toolResult);
          base.resultLength = e.toolResult.length;
        }
        break;
      }
      base.content = firstLine(e.content ?? "");
      base.bodyLength = (e.content ?? "").length;
      if (e.toolResult != null) base.resultLength = e.toolResult.length;
      break;
    case "compact":
    case "notice":
    case "retry":
    case "error": {
      const text = e.content ?? "";
      base.content = capped(text);
      if (text.length > BANNER_MAX) base.contentLength = text.length;
      break;
    }
    case "subagent_start":
    case "subagent_progress":
    case "subagent_done":
      if (e.subagent) {
        const sa = e.subagent;
        base.subagent = {
          taskId: sa.taskId,
          description: sa.description,
          ...(sa.agentType && { agentType: sa.agentType }),
          ...(sa.taskType && { taskType: sa.taskType }),
          ...(sa.status && { status: sa.status }),
          ...(sa.lastTool && { lastTool: sa.lastTool }),
          ...(sa.usage && { usage: sa.usage }),
          ...(sa.durationMs != null && { durationMs: sa.durationMs }),
          ...(sa.model != null && { model: sa.model }),
          ...(sa.effort != null && { effort: sa.effort }),
          ...(sa.cancellable !== undefined && { cancellable: sa.cancellable }),
          eventCount: sa.events?.length ?? sa.eventCount ?? 0,
          ...(sa.prompt && { hasPrompt: true }),
          ...(sa.summary && { summaryLength: sa.summary.length }),
        };
      }
      break;
    default:
      // thinking, text, tool_result and anything else: body on demand.
      base.contentLength = (e.content ?? "").length;
      break;
  }
  return base;
}

/** Strip persistence-only dispatch fields before broadcasting a message over WS. */
export function toWireMessage(m: Message): Message {
  if (m.queuedEnvelope === undefined && m.dispatchAttempt === undefined) return m;
  const copy = { ...m };
  delete copy.queuedEnvelope;
  delete copy.dispatchAttempt;
  return copy;
}

export function summarizeMessage(m: Message): Message {
  const wire = toWireMessage(m);
  if (!wire.events?.length) return wire;
  return { ...wire, events: wire.events.map(summarizeEvent), detail: "summary" };
}

export function summarizeMessages(messages: Message[]): Message[] {
  return messages.map(summarizeMessage);
}
