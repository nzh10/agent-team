import type { StreamEvent, Message, SubAgentInfo } from "./useServer";
import {
  attachToolResult,
  findSubagentEvent,
  innerSubagentEvent,
  isSubagentEvent,
  isTerminalSubagent,
  mergeSubagentInfo,
  transcriptLength,
  upsertSubagentProgress,
} from "../chat/events";

export interface PendingEvent {
  wsId: string;
  messageId: string;
  event: StreamEvent;
}

// Kinds that only carry streamed text and never land in `events`.
const DELTA_KINDS = new Set(["text_delta", "thinking_delta"]);
const RETRY_PROGRESS_KINDS = new Set([
  "text_delta",
  "thinking_delta",
  "thinking",
  "tool_use",
  "subagent_start",
]);

function clearsRetry(e: StreamEvent): boolean {
  return (
    RETRY_PROGRESS_KINDS.has(e.kind) ||
    e.kind === "error" ||
    e.kind === "result" ||
    (e.kind === "retry" && !e.content)
  );
}

// Fold a batch of stream events into a message. Mirrors the server-side
// aggregation in task.ts so the client view converges with what gets
// persisted: tool results attach to their tool_use, subagent lifecycles fold
// onto the start event, retries update in place.
export function applyEventsToMessage(m: Message, evts: StreamEvent[]): Message {
  if (evts.length === 0) return m;
  const deltas = evts.filter((e) => DELTA_KINDS.has(e.kind));
  const regular = evts.filter((e) => !DELTA_KINDS.has(e.kind));
  let events = [...(m.events ?? [])];

  let content = m.content;
  const textDelta = deltas
    .filter((e) => e.kind === "text_delta")
    .map((e) => e.content)
    .join("");
  if (textDelta) content = (content || "") + textDelta;
  const live = liveThinkingAfter(m, evts);
  const liveChanged =
    live.liveThinking !== m.liveThinking ||
    live.closingThinking !== m.closingThinking ||
    live.liveThinkingSince !== m.liveThinkingSince ||
    live.waitingSince !== m.waitingSince;
  if (regular.length === 0) {
    const retryCleared = evts.some(clearsRetry) && events.some((e) => e.kind === "retry");
    if (retryCleared) events = events.filter((e) => e.kind !== "retry");
    return textDelta || liveChanged || retryCleared
      ? { ...withoutLiveTiming(m), content, ...live, ...(retryCleared && { events }) }
      : m;
  }

  // Subagent starts are copied before their transcript changes, once per
  // batch: the rest are shared with the previous state or are the wire
  // objects themselves, and React may run the same batch twice (StrictMode,
  // a rebased updater). Untouched cards keep their identity for memo.
  const owned = new Set<StreamEvent>();
  const ownSubagent = (i: number): SubAgentInfo => {
    if (!owned.has(events[i])) {
      const sa = events[i].subagent!;
      events[i] = { ...events[i], subagent: { ...sa, events: sa.events && [...sa.events] } };
      owned.add(events[i]);
    }
    return events[i].subagent!;
  };

  for (const ev of evts) {
    if (clearsRetry(ev) && events.some((e) => e.kind === "retry")) {
      events = events.filter((e) => e.kind !== "retry");
    }
    if (DELTA_KINDS.has(ev.kind)) continue;
    const attached = attachToolResult(events, ev);
    if (attached) {
      events[attached.index] = attached.event;
      continue;
    }
    // Tokens of the latest thinking block (task.ts does the same).
    if (ev.kind === "thinking_tokens") {
      let idx = events.length - 1;
      while (idx >= 0 && events[idx].kind !== "thinking") idx--;
      if (idx >= 0 && events[idx].tokens == null) {
        events[idx] = { ...events[idx], tokens: ev.tokens };
      }
      continue;
    }
    if (ev.kind === "retry") {
      if (!ev.content) continue;
      const idx = events.findIndex((e) => e.kind === "retry");
      if (idx >= 0) {
        events[idx] = { ...ev, contentOffset: events[idx].contentOffset };
        continue;
      }
    }
    const taskId = ev.subagent?.taskId;
    if (ev.kind === "subagent_progress" && taskId) {
      const inner = innerSubagentEvent(ev);
      const start = findSubagentEvent(events, "subagent_start", taskId);
      if (inner) {
        if (start >= 0) {
          const sa = ownSubagent(start);
          // A live tail must not pass for a transcript the client never loaded.
          if (sa.events) applyInnerEvent(sa, inner);
          else sa.eventCount = (sa.eventCount ?? 0) + unloadedGrowth(sa, inner);
        }
      } else {
        events = recordSubagentProgress(events, ev, taskId, start);
      }
      continue;
    }
    if (ev.kind === "subagent_done" && taskId) {
      finishSubagent(events, ev, taskId);
      continue;
    }
    events.push(ev);
  }
  return { ...withoutLiveTiming(m), content, events, ...live };
}

type LiveTiming = Pick<
  Message,
  "liveThinking" | "closingThinking" | "liveThinkingSince" | "waitingSince"
>;

// The thinking block streaming in, in batch order: an empty delta opens a
// block, the next ones extend it, and the main loop moving on ends it — its
// "thinking" event, a delta carrying the block's duration (a block whose
// text is not returned gets no event), the reply's text, a tool call.
function liveThinkingAfter(m: Message, evts: StreamEvent[]): LiveTiming {
  if (m.status !== "streaming") return {};
  let text = m.liveThinking;
  let closing = m.closingThinking;
  let since = m.liveThinkingSince;
  let waitingSince = m.waitingSince;
  for (const e of evts) {
    if (e.waitingSince !== undefined) waitingSince = e.waitingSince ?? undefined;
    // A background task reporting on this message is not the main loop
    // moving on.
    if (isSubagentEvent(e)) continue;
    if (e.kind === "thinking_delta" && e.durationMs != null && e.thinkingFollows) {
      closing = since != null ? (text ?? "") : closing;
    } else {
      closing = undefined;
    }
    if (e.kind !== "thinking_delta" || e.durationMs != null) {
      text = undefined;
      since = undefined;
    } else if (e.startedAt != null) {
      text = (e.startedAt === since ? (text ?? "") : "") + e.content;
      since = e.startedAt;
    } else if (text == null || !e.content) {
      text = e.content ?? "";
      since = !e.content ? Date.now() : (since ?? Date.now());
    } else {
      text += e.content;
    }
  }
  return {
    ...(text != null && { liveThinking: text }),
    ...(closing != null && { closingThinking: closing }),
    ...(since != null && { liveThinkingSince: since }),
    ...(waitingSince != null && { waitingSince }),
  };
}

export function withoutLiveTiming(m: Message): Message {
  if (
    m.liveThinking == null &&
    m.closingThinking == null &&
    m.liveThinkingSince == null &&
    m.waitingSince == null
  )
    return m;
  const {
    liveThinking: _text,
    closingThinking: _closing,
    liveThinkingSince: _thinking,
    waitingSince: _waiting,
    ...rest
  } = m;
  return rest;
}

// How much one live inner event grows the server's copy of a transcript the
// client never loaded (the cases of applyInnerEvent), so the card's count
// tracks what loading it would show.
function unloadedGrowth(sa: SubAgentInfo, innerEv: StreamEvent): number {
  const nid = innerEv.subagent?.taskId;
  if (innerEv.kind === "tool_result") return 0;
  if (innerEv.kind === "subagent_progress" && nid) {
    if (innerSubagentEvent(innerEv)) return 0;
    if (sa.liveProgress?.includes(nid)) return 0;
    sa.liveProgress = [...(sa.liveProgress ?? []), nid];
    return 1;
  }
  if (innerEv.kind === "subagent_done" && nid && sa.liveProgress?.includes(nid)) {
    sa.liveProgress = sa.liveProgress.filter((id) => id !== nid);
    return 0;
  }
  return 1;
}

function mergeLifecycle(start: StreamEvent, update: StreamEvent): StreamEvent {
  if (update.kind === "subagent_progress" && isTerminalSubagent(start)) return start;
  return { ...start, subagent: mergeSubagentInfo(start.subagent, update.subagent!) };
}

function recordSubagentProgress(
  events: StreamEvent[],
  update: StreamEvent,
  taskId: string,
  start: number,
): StreamEvent[] {
  const next = upsertSubagentProgress(events, update, taskId);
  if (start >= 0) {
    const progress = findSubagentEvent(next, "subagent_progress", taskId);
    next[start] = mergeLifecycle(next[start], next[progress]);
  }
  return next;
}

// Keep the terminal frame in wire order, and keep the original card's position.
// Both callers own their event array before changing it.
function finishSubagent(events: StreamEvent[], done: StreamEvent, taskId: string): void {
  const progress = findSubagentEvent(events, "subagent_progress", taskId);
  const fallback = progress >= 0 ? events.splice(progress, 1)[0] : undefined;
  const start = findSubagentEvent(events, "subagent_start", taskId);
  if (start >= 0) {
    // A loaded transcript can hold metadata only on the progress event.
    const base = fallback ? mergeLifecycle(events[start], fallback) : events[start];
    events[start] = mergeLifecycle(base, done);
  }
  events.push(
    start < 0 && fallback
      ? { ...done, subagent: mergeSubagentInfo(fallback.subagent, done.subagent!) }
      : done,
  );
}

function applyInnerEvent(sa: SubAgentInfo, innerEv: StreamEvent): void {
  const events = (sa.events ??= []);
  const attached = attachToolResult(events, innerEv);
  if (attached) {
    events[attached.index] = attached.event;
    return;
  }
  const taskId = innerEv.subagent?.taskId;
  if (innerEv.kind === "subagent_progress" && taskId) {
    const inner = innerSubagentEvent(innerEv);
    const start = findSubagentEvent(events, "subagent_start", taskId);
    if (!inner) {
      sa.events = recordSubagentProgress(events, innerEv, taskId, start);
    } else if (start >= 0) {
      const child = events[start].subagent!;
      const subagent = { ...child, events: [...(child.events ?? [])] };
      applyInnerEvent(subagent, inner);
      events[start] = { ...events[start], subagent };
    }
  } else if (innerEv.kind === "subagent_done" && taskId) {
    finishSubagent(events, innerEv, taskId);
  } else {
    events.push(innerEv);
  }
}

// Apply a batch of pending events to every workspace it touches.
export function applyStreamBatch<W extends { id: string; messages: Message[] }>(
  workspaces: W[],
  batch: PendingEvent[],
): W[] {
  const byWs = new Map<string, Map<string, StreamEvent[]>>();
  for (const { wsId, messageId, event } of batch) {
    let byMsg = byWs.get(wsId);
    if (!byMsg) byWs.set(wsId, (byMsg = new Map<string, StreamEvent[]>()));
    const list = byMsg.get(messageId);
    if (list) list.push(event);
    else byMsg.set(messageId, [event]);
  }
  return workspaces.map((w) => {
    const byMsg = byWs.get(w.id);
    if (!byMsg) return w;
    return {
      ...w,
      messages: w.messages.map((m) => {
        const evts = byMsg.get(m.id);
        return evts ? applyEventsToMessage(m, evts) : m;
      }),
    };
  });
}

// Replace a message's events with the server's full copy while keeping any
// subagent transcripts the client already loaded (the server strips those).
export function mergeDetailEvents(
  clientEvents: StreamEvent[] | undefined,
  serverEvents: StreamEvent[],
): StreamEvent[] {
  if (!clientEvents?.length) return serverEvents;
  return serverEvents.map((serverEv) => {
    if (!serverEv.subagent?.taskId) return serverEv;
    const clientEv = clientEvents.find((e) => e.subagent?.taskId === serverEv.subagent!.taskId);
    const kept = clientEv?.subagent?.events;
    // Shorter than the server's is a live tail with a gap before it.
    if (kept?.length && kept.length >= transcriptLength(serverEv.subagent)) {
      return { ...serverEv, subagent: { ...serverEv.subagent, events: kept } };
    }
    return serverEv;
  });
}

// Reconcile a freshly fetched newest page with what the client already
// holds. Used after a reconnect: anything that finished, failed or was
// removed while the socket was down is only visible in the server's copy.
// Older pages the client scrolled back to are kept; the window covered by the
// incoming page is replaced by it, message by message.
export function mergeLatestPage(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return incoming;
  const incomingIds = new Set(incoming.map((m) => m.id));
  const oldest = incoming[0].timestamp;
  const byId = new Map(existing.map((m) => [m.id, m]));
  // Older history the client paged to. A tie on the page's first timestamp
  // is still "older" when the id is not on the page (same-millisecond
  // neighbours), otherwise a reconnect would drop a loaded message. Unless
  // the page reaches back into what the client holds, more arrived while
  // away than fits on it: the two are not adjacent, and paging (which
  // continues from the oldest loaded message) would never fill the gap. A
  // message that came live before the reply must not count as reaching.
  const reaches = byId.has(incoming[0].id);
  const retained = reaches
    ? existing.filter((m) => !incomingIds.has(m.id) && m.timestamp <= oldest)
    : [];
  const page = incoming.map((next) => {
    const cur = byId.get(next.id);
    return cur ? reconcileMessage(cur, next) : next;
  });
  return [...retained, ...page];
}

// Messages whose bodies the client had (streamed live or expanded) but that
// came back from the resync as summaries. Their full events must be
// re-fetched, or what the user was reading turns into "tap to load".
export function downgradedMessageIds(existing: Message[], merged: Message[]): string[] {
  const hadBodies = new Set(
    existing.filter((m) => m.detail !== "summary" && m.events?.length).map((m) => m.id),
  );
  return merged.filter((m) => m.detail === "summary" && hadBodies.has(m.id)).map((m) => m.id);
}

const SETTLED = new Set<Message["status"]>(["done", "error", "outcome_unknown"]);

// The server sends summaries; keep the client's full bodies only when the
// message is settled on both sides and its events did not move, so nothing
// the user expanded reloads. Anything still streaming when the socket dropped
// takes the server's copy — the client's events stop wherever the connection
// did — and so does a settled message whose background card finished, grew
// or was stopped by a server restart in the meantime.
function reconcileMessage(cur: Message, next: Message): Message {
  const unchanged =
    SETTLED.has(cur.status) && cur.status === next.status && sameEvents(cur.events, next.events);
  if (unchanged && cur.detail !== "summary" && cur.events?.length) {
    const { detail: _summary, ...rest } = next;
    return { ...rest, events: cur.events };
  }
  const merged = next.events
    ? { ...next, events: mergeDetailEvents(cur.events, next.events) }
    : next;
  // Keep a locally received prefix only if the server is still on that block.
  if (
    next.status === "streaming" &&
    next.liveThinkingSince != null &&
    next.liveThinkingSince === cur.liveThinkingSince &&
    cur.liveThinking != null
  ) {
    return { ...merged, liveThinking: cur.liveThinking };
  }
  return merged;
}

function sameEvents(cur: StreamEvent[] = [], next: StreamEvent[] = []): boolean {
  return (
    cur.length === next.length &&
    next.every((n, i) => {
      const c = cur[i];
      if (c.kind !== n.kind) return false;
      // A result that came (or failed) while the socket was down.
      if (n.kind === "tool_use") {
        const had = c.toolResult != null || c.resultLength != null;
        const has = n.toolResult != null || n.resultLength != null;
        return had === has && !!c.toolResultIsError === !!n.toolResultIsError;
      }
      if (!n.subagent) return true;
      return (
        !!c.subagent &&
        c.subagent.taskId === n.subagent.taskId &&
        c.subagent.description === n.subagent.description &&
        c.subagent.status === n.subagent.status &&
        c.subagent.model === n.subagent.model &&
        c.subagent.effort === n.subagent.effort &&
        transcriptLength(c.subagent) >= transcriptLength(n.subagent)
      );
    })
  );
}

// Tool name of a tool_use event. New servers tag it explicitly; older
// persisted events only carry the "**Name** ..." markdown prefix.
export function toolNameOf(ev: StreamEvent): string | null {
  if (ev.toolName) return ev.toolName;
  const m = (ev.content ?? "").match(/^\*\*([^*]+)\*\*/);
  return m ? m[1] : null;
}

// One-line summary for a tool_use row: the first line with the bold name
// stripped, so "**Read** `a.ts`" shows as "a.ts".
export function toolSummary(ev: StreamEvent): string {
  const firstLine = (ev.content ?? "").split("\n", 1)[0] ?? "";
  if (/^(?: {4}| {0,3}\t)/.test(firstLine)) return "";
  return firstLine
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/`/g, "")
    .trim();
}
