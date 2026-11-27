import { isOutstandingSubagentStatus } from "../../../shared/subagent-status";
import type { Message, Workspace } from "./useServer";

export const INACTIVE_TRANSCRIPT_BUDGET = 1024 * 1024;

const encoder = new TextEncoder();
const messageBytes = new WeakMap<Message, number>();
const expendablePrefixes = new WeakMap<Message[], { count: number; bytes: number }>();

function isProtected(message: Message): boolean {
  if (message.queuedFor || message.pendingDelivery || message.steering) return true;
  switch (message.status) {
    case "done":
    case "error":
    case "outcome_unknown": {
      if (!message.events?.length) return false;
      const terminal = new Set<string>();
      for (const event of message.events) {
        if (event.kind === "subagent_done" && event.subagent) terminal.add(event.subagent.taskId);
      }
      return message.events.some(
        (e) =>
          e.subagent &&
          !terminal.has(e.subagent.taskId) &&
          isOutstandingSubagentStatus(e.subagent.status),
      );
    }
    default:
      return true;
  }
}

function expendablePrefix(messages: Message[]): { count: number; bytes: number } {
  const cached = expendablePrefixes.get(messages);
  if (cached) return cached;
  let count = messages.length;
  const prompts = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isProtected(message) && !prompts.has(message.id)) continue;
    count = i;
    if (message.replyTo) prompts.add(message.replyTo);
  }
  // The oldest row is also the paging cursor. Keep the live suffix contiguous
  // and don't split its first timestamp group (older pages replay those ties).
  while (count > 0 && messages[count - 1].timestamp === messages[count]?.timestamp) count--;

  // UTF-8 JSON payload budget, not a browser heap estimate. Use the projected
  // message (including fetched events and images), not its recorded length hints.
  let bytes = count === 0 ? 0 : 2;
  for (let i = 0; i < count; i++) {
    const message = messages[i];
    let size = messageBytes.get(message);
    if (size === undefined) {
      size = encoder.encode(JSON.stringify(message)).byteLength;
      messageBytes.set(message, size);
    }
    bytes += size + (i === 0 ? 0 : 1);
  }
  const prefix = { count, bytes };
  expendablePrefixes.set(messages, prefix);
  return prefix;
}

export function inactiveTranscriptBytes(workspaces: Workspace[], activeId: string | null): number {
  return workspaces.reduce(
    (bytes, workspace) =>
      bytes + (workspace.id === activeId ? 0 : expendablePrefix(workspace.messages).bytes),
    0,
  );
}

// Only expendable prefixes are charged: if a live row is older than the byte
// limit can accommodate, keep its entire suffix rather than hide it or create
// a gap that older-page requests (anchored at the first row) cannot recover.
export function retainInactiveTranscripts(
  workspaces: Workspace[],
  activeId: string | null,
  oldestToNewest: readonly string[],
  budget = INACTIVE_TRANSCRIPT_BUDGET,
): Workspace[] {
  const rank = new Map(oldestToNewest.map((id, i) => [id, i]));
  const candidates = workspaces.flatMap((workspace, index) => {
    if (workspace.id === activeId) return [];
    const { count, bytes } = expendablePrefix(workspace.messages);
    return bytes === 0 ? [] : [{ workspace, index, count, bytes }];
  });
  let bytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
  if (bytes <= budget) return workspaces;

  candidates.sort((a, b) => (rank.get(a.workspace.id) ?? -1) - (rank.get(b.workspace.id) ?? -1));
  const retained = workspaces.slice();
  for (const { workspace, index, count, bytes: cost } of candidates) {
    const messages = workspace.messages.slice(count);
    const loaded = messages.length > 0 && workspace.messagesLoaded === true;
    retained[index] = {
      ...workspace,
      messages,
      messagesLoaded: loaded,
      hasMore: loaded,
      loadingOlder: false,
    };
    bytes -= cost;
    if (bytes <= budget) break;
  }
  return retained;
}
