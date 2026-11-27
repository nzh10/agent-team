import { randomUUID } from "node:crypto";
import type { Workspace, Message, ManualInputAdmission } from "../workspace/workspace";
import type { ReportJournalStore, ReportLeadDelivery } from "./report-journal";
import { isTransientTransportFailure } from "./network-failure";

const WINDOW = 30 * 60_000;
const DISPATCH_RECHECK_MS = 1000;
const DELAYS = [30_000, 60_000, 120_000, 300_000, 600_000];

// The hold survives cutoff and restart: draining the saved inbox must not wake a
// stopped Lead. A manual message releases it. Never reconstruct it from history.
export interface LeadOutage {
  id: string;
  agentId: string;
  started: number;
  deadline: number;
  next: number;
  attempts: number;
  supersedes: string[];
  retainedReports: string[];
  originInputId?: string;
  reason: string;
  phase: "waiting" | "sending" | "held";
  batch?: {
    id: string;
    reports: string[];
    manual: boolean;
    manualFollowUp?: boolean;
    progress?: boolean;
    admitted?: boolean;
    completed?: boolean;
    replyId?: string;
    terminalFailure?: "retryable" | "hold";
  };
}

interface Host {
  journal(w: Workspace): ReportJournalStore;
  save(w: Workspace): void;
  availability(w: Workspace): "gone" | "unavailable" | "blocked" | "ready";
  slot(delay: number): number;
  drain(w: Workspace): void;
  exhausted?(w: Workspace): void;
  recovered?(
    w: Workspace,
    agentId: string,
    reply: Message,
    originId: string | undefined,
    reports: string[],
  ): void;
}

export class LeadRecovery {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(private host: Host) {}

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  cancel(w: Workspace): void {
    clearTimeout(this.timers.get(w.id));
    this.timers.delete(w.id);
  }

  private save(w: Workspace): void {
    this.host.save(w);
  }

  stop(w: Workspace, agentId?: string): void {
    const o = w.leadOutage;
    if (!o || (agentId && o.agentId !== agentId) || this.host.availability(w) === "gone") return;
    this.hold(w, false);
  }

  private exhausted(w: Workspace): void {
    this.stop(w);
    if (w.leadOutage?.phase === "held") this.host.exhausted?.(w);
  }

  private hold(w: Workspace, restoring: boolean): void {
    const o = w.leadOutage!;
    this.cancel(w);
    o.phase = "held";
    w.setNetworkWaiting(o.agentId, false);
    if (o.batch) {
      const row = w.findRecoveryInput(o.batch.id);
      if (row?.status === "queued" || row?.status === "starting" || (!row && !o.batch.admitted))
        delete o.batch;
      else this.record(w, "outcome_unknown");
      if (row) w.settleRecoveryOnHold(row, restoring);
    }
    this.save(w);
  }

  private fail(w: Workspace, unwritten: boolean): void {
    const o = w.leadOutage!;
    const release = o.batch?.manualFollowUp || (unwritten && o.batch?.manual);
    if (unwritten) delete o.batch;
    if (release) {
      if (o.batch) this.record(w, "outcome_unknown");
      this.release(w);
    } else this.exhausted(w);
  }

  private release(w: Workspace): void {
    w.setNetworkWaiting(w.leadOutage!.agentId, false);
    this.cancel(w);
    delete w.leadOutage;
    this.save(w);
    queueMicrotask(() => this.host.drain(w));
  }

  terminal(w: Workspace, agentId: string, reply: Message, interrupted: boolean): void {
    if (w.projectLink?.role !== "lead") return;
    const availability = this.host.availability(w);
    if (availability === "gone" || availability === "unavailable") return;
    const o = w.leadOutage;
    if (o && o.agentId !== agentId) return;
    if (o) {
      if (o.phase === "sending" && o.batch && w.agents.get(agentId)?.input?.recovery) {
        const providerFailure = reply.events?.some((e) => e.kind === "error" && e.networkFailure);
        o.batch.completed = true;
        o.batch.replyId = reply.id;
        if (reply.status === "error" || interrupted) {
          o.batch.terminalFailure =
            !interrupted &&
            providerFailure &&
            !o.batch.progress &&
            !reply.content &&
            !reply.events?.some(
              (e) => e.kind !== "error" && e.kind !== "retry" && e.kind !== "notice",
            )
              ? "retryable"
              : "hold";
        }
        // A fast terminal event can precede the dispatch receipt.
        this.complete(w);
      }
      return;
    }
    const agent = w.agents.get(agentId);
    if (
      this.closed ||
      reply.status !== "error" ||
      interrupted ||
      agent?.input?.recovery ||
      agent?.retryPending
    )
      return;
    const error = reply.events?.filter((e) => e.kind === "error").at(-1);
    if (!error?.networkFailure) return;
    const reason = error.content;
    const started = Date.now();
    w.leadOutage = {
      id: randomUUID(),
      agentId,
      started,
      deadline: started + WINDOW,
      next: started,
      attempts: 0,
      supersedes: [],
      retainedReports: [],
      originInputId: agent?.input?.id,
      reason: reason.slice(0, 500),
      phase: "waiting",
    };
    this.schedule(w);
  }

  private schedule(w: Workspace, restore = false): void {
    if (this.host.availability(w) === "gone") return;
    const o = w.leadOutage!;
    const now = Date.now();
    if (now >= o.deadline && !this.closed) return this.exhausted(w);
    const delay = restore
      ? Math.max(0, o.next - now)
      : DELAYS[Math.min(o.attempts, DELAYS.length - 1)];
    w.setNetworkWaiting(o.agentId, true);
    o.next = Math.min(o.deadline, now + this.host.slot(delay));
    this.save(w);
    this.cancel(w);
    if (!this.closed) this.arm(w, o, o.next);
  }

  private arm(w: Workspace, o: LeadOutage, at: number, deferred = false): void {
    this.timers.set(
      w.id,
      setTimeout(
        () => {
          this.timers.delete(w.id);
          try {
            if (this.closed || o !== w.leadOutage || o.phase !== "waiting") return;
            const host = this.host.availability(w);
            if (host === "gone") return;
            const agent = w.recoveryAvailability(o.agentId);
            const now = Date.now();
            if (now >= o.deadline || host === "unavailable" || agent === "unavailable")
              return this.exhausted(w);
            if (host === "blocked" || agent === "blocked") {
              // Keep the saved wake and cutoff intact during a temporary dispatch hold.
              this.arm(w, o, Math.min(o.deadline, now + DISPATCH_RECHECK_MS), true);
              return;
            }
            // The reserved start slot passed while blocked. Space the new start too.
            if (deferred) return this.schedule(w, true);
            const batch = this.take(w, false);
            w.startRecovery(o.agentId, batch.reportId, batch.text, batch.recovery);
          } catch (error) {
            console.error("[projects] lead recovery failed", error);
            this.exhausted(w);
          }
        },
        Math.max(0, at - Date.now()),
      ),
    );
  }

  restore(w: Workspace): void {
    const availability = this.host.availability(w);
    if (this.closed || availability === "gone") return;
    const o = w.leadOutage;
    if (!o || o.phase === "held") return;
    if (o.phase === "sending") return this.hold(w, true);
    if (availability === "unavailable" || Date.now() >= o.deadline) return this.stop(w);
    this.schedule(w, true);
  }

  private take(w: Workspace, manual: boolean) {
    const o = w.leadOutage!;
    this.cancel(w);
    const batch = this.prepareBatch(w, o, manual);
    w.setNetworkWaiting(o.agentId, false);
    this.save(w); // A crash from here until positive receipt is ambiguous.
    if (!manual)
      this.timers.set(
        w.id,
        setTimeout(() => this.exhausted(w), Math.max(0, o.deadline - Date.now())),
      );
    return batch;
  }

  private prepareBatch(w: Workspace, o: LeadOutage, manual: boolean) {
    const entries = this.host
      .journal(w)
      .list()
      .filter(
        (e) =>
          e.leadDelivery.state === "pending" ||
          (e.leadDelivery.state === "enqueued" && w.unsentInboxRow(e.leadMessageId)),
      );
    const reportId = `outage-${o.id}-${++o.attempts}`;
    o.phase = "sending";
    o.batch = { id: reportId, reports: entries.map((e) => e.reportId), manual };
    const notice = (e: (typeof entries)[number]) =>
      `${e.workerName} (${e.workerWsId}), ${e.kind}: ${e.payload.text ?? ""}`;
    // Codex retains admitted user inputs. Never append an old notice again;
    // Pi projects a replacement context before the provider request instead.
    const delta =
      o.supersedes.length && w.agents.get(o.agentId)?.session.getState().config.backend === "codex"
        ? entries
            .filter((e) => !o.retainedReports.includes(e.reportId))
            .map(notice)
            .join("\n\n")
        : undefined;
    const full = [
      `Lead network interruption at ${new Date(o.started).toISOString()}: ${o.reason}`,
      ...entries.map(notice),
      "Inspect prior work before repeating any tool action.",
    ].join("\n\n");
    return {
      reportId,
      recovery: {
        outageId: o.id,
        supersedes: [...o.supersedes],
        ...(delta !== undefined && { delta }),
      },
      text:
        manual && delta !== undefined
          ? delta || "No new worker reports since the previous recovery attempt."
          : full,
    };
  }

  manual(w: Workspace, agentId: string, pair: boolean): ManualInputAdmission | undefined {
    const o = w.leadOutage;
    if (!o) return;
    if (o.phase !== "sending") {
      const next =
        pair && o.phase === "waiting" && Date.now() < o.deadline
          ? {
              ...o,
              agentId,
              // A different target has none of the failed agent's retained context.
              ...(o.agentId !== agentId && { supersedes: [], retainedReports: [] }),
            }
          : undefined;
      const panelContext = next && this.prepareBatch(w, next, true);
      return {
        panelContext,
        stage: () => {
          w.leadOutage = next;
        },
        rollback: () => {
          // The timer closes over the original object. Metadata may already
          // have been written before the queue history write failed.
          w.leadOutage = o;
          this.save(w);
        },
        committed: () => {
          this.cancel(w);
          w.setNetworkWaiting(o.agentId, false);
          if (!next) queueMicrotask(() => this.host.drain(w));
        },
      };
    }
    if (o.phase === "sending" && o.batch) {
      // Keep settling the original batch, but neither retry it nor hold the
      // manual queue if it fails.
      const batch = o.batch;
      const prior = batch.manualFollowUp;
      return {
        stage: () => {
          batch.manualFollowUp = true;
        },
        rollback: () => {
          batch.manualFollowUp = prior;
          this.save(w);
        },
        committed: () => this.cancel(w),
      };
    }
    this.release(w);
  }

  private record(w: Workspace, state: "outcome_unknown" | "sent_to_pi"): void {
    const batch = w.leadOutage!.batch!;
    const journal = this.host.journal(w);
    for (const id of batch.reports) {
      const entry = journal.getByReportId(id);
      if (!entry) continue;
      w.finishBatchedRow(entry.leadMessageId, state === "sent_to_pi" ? "done" : state);
      if (["pending", "enqueued"].includes(entry.leadDelivery.state))
        journal.updateLeadDelivery(id, {
          state,
          ...(state === "sent_to_pi" && { acceptedByPiAt: Date.now() }),
        });
    }
    delete w.leadOutage!.batch;
  }

  private complete(w: Workspace): void {
    const o = w.leadOutage!;
    const batch = o.batch!;
    if (batch.admitted && batch.completed) {
      if (batch.terminalFailure === "retryable" && !batch.manual && !batch.manualFollowUp) {
        // The backend hides superseded zero-output recovery turns from model input.
        o.supersedes.push(batch.id);
        o.retainedReports = batch.reports;
        delete o.batch;
        o.phase = "waiting";
        this.schedule(w);
        return;
      }
      if (batch.terminalFailure) return this.fail(w, false);
      this.record(w, "sent_to_pi");
      delete w.leadOutage;
      this.cancel(w);
      const reply = !batch.manual && batch.replyId && w.findMessage(batch.replyId);
      if (reply) this.host.recovered?.(w, o.agentId, reply, o.originInputId, batch.reports);
      this.host.drain(w);
    }
    this.save(w);
  }

  receipt(w: Workspace, id: string, state: ReportLeadDelivery["state"], reason?: string): boolean {
    const o = w.leadOutage;
    if (!o?.batch || o.batch.id !== id) return false;
    if (state === "sent_to_pi") {
      o.batch.admitted = true;
      this.complete(w);
    } else if (
      state === "error" &&
      !o.batch.manual &&
      !o.batch.manualFollowUp &&
      !o.batch.admitted &&
      reason &&
      isTransientTransportFailure(reason)
    ) {
      // Workspace reports `error` for a rejected/unwritten input. A questionable
      // write reports `outcome_unknown`; a provider error AFTER admission is not
      // evidence the backend conversation lacks the context.
      delete o.batch;
      o.phase = "waiting";
      this.schedule(w);
    } else if (state === "error" || state === "outcome_unknown") {
      this.fail(w, state === "error" && !o.batch.admitted);
    }
    return true;
  }
}
