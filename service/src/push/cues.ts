import type { Message, Workspace, TurnInput } from "../workspace/workspace";
import type { PushNotice } from "./store";

export function replyPreview(text: string) {
  const plain = text
    .slice(0, 8192)
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*(?:#{1,6}|>|[-*+] |\d+\. )\s*/gm, "")
    .replace(/[*`~]|__+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(plain))
    .slice(0, 2)
    .map((s) => s.segment)
    .join("")
    .trim();
  if (
    !/\p{L}/u.test(sentences) ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(sentences)
  )
    return "Lead replied";
  const chars = Array.from(sentences);
  return chars.length > 180 ? `${chars.slice(0, 179).join("").trimEnd()}…` : sentences;
}

// These callbacks are live transitions, not observers of workspace snapshots.
export class PushCues {
  private notified = new WeakSet<TurnInput>();
  private pending = new WeakMap<
    Workspace,
    { agentId: string; turn: TurnInput; ids: string[]; body: string }
  >();
  private failedOutages = new WeakSet<NonNullable<Workspace["leadOutage"]>>();
  constructor(
    private eligible: (w: Workspace) => boolean,
    private finalState: (w: Workspace, ids: string[]) => "none" | "busy" | "ready",
    private emit: (notice: PushNotice) => void,
  ) {}
  waiting(w: Workspace) {
    if (this.eligible(w) && !w.isArchived && w.projectLink?.role === "worker")
      this.emit({ wsId: w.id, trigger: "yourTurn", body: "Waiting for your reply" });
  }
  failure(w: Workspace, agentId: string) {
    if (!this.eligible(w) || w.isArchived || w.agents.get(agentId)?.retryPending) return;
    this.pending.delete(w);
    const outage = w.leadOutage;
    if (outage?.agentId === agentId) {
      if (outage.phase !== "held" || this.failedOutages.has(outage)) return;
      this.failedOutages.add(outage);
    }
    this.emit({ wsId: w.id, trigger: "failed", body: "Run failed — needs attention" });
  }
  terminal(w: Workspace, agentId: string, reply: Message, interrupted: boolean) {
    const agent = w.agents.get(agentId);
    if (
      !agent ||
      !this.eligible(w) ||
      w.isArchived ||
      interrupted ||
      agent.retryPending ||
      agent.input?.stopped ||
      (w.leadOutage?.agentId === agentId && w.leadOutage.phase !== "held")
    )
      return;
    if (reply.status === "error") {
      this.failure(w, agentId);
      return;
    }
    if (
      reply.status !== "done" ||
      w.projectLink?.role !== "lead" ||
      !agent.input ||
      this.notified.has(agent.input)
    )
      return;
    const input = w.findMessage(agent.input.id);
    if (
      input?.kind !== "user" ||
      input.localCommand ||
      (input.from && input.from.role !== "worker")
    )
      return;
    this.conclusion(w, agentId, reply, !input.from, [input.id]);
  }

  conclusion(w: Workspace, agentId: string, reply: Message, direct: boolean, ids: string[]) {
    const turn = w.agents.get(agentId)?.input;
    if (!turn || turn.stopped || !this.eligible(w) || w.isArchived || this.notified.has(turn))
      return;
    const tools =
      reply.events?.filter((e) => ["tool_use", "tool_result", "subagent_start"].includes(e.kind)) ??
      [];
    const text = reply.content
      .slice(tools.reduce((n, e) => Math.max(n, e.contentOffset ?? 0), 0))
      .trim();
    if (tools.length && !text) return;
    const body = replyPreview(text);
    this.pending.delete(w);
    if (!direct) {
      // A fast Lead can wrap up before finish_task has returned to the reporting worker.
      this.pending.set(w, { agentId, turn, ids, body });
      this.flush(w);
      return;
    }
    this.notified.add(turn);
    this.emit({ wsId: w.id, trigger: "reply", body });
  }
  flush(w: Workspace) {
    const pending = this.pending.get(w);
    if (!pending) return;
    const { agentId, turn, ids, body } = pending;
    this.pending.delete(w);
    if (
      !this.eligible(w) ||
      w.isArchived ||
      w.projectLink?.role !== "lead" ||
      w.agents.get(agentId)?.input !== turn ||
      turn.stopped ||
      this.notified.has(turn)
    )
      return;
    const state = this.finalState(w, ids);
    if (state === "busy") this.pending.set(w, pending);
    if (state === "ready") {
      this.notified.add(turn);
      this.emit({ wsId: w.id, trigger: "reply", body });
    }
  }
}
