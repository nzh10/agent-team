import * as fs from "fs";
import * as path from "path";
import { formatReportMarker, type MessageStatus, type PromptEnvelope } from "../session/types";
import { writeAtomicJson } from "../storage/atomic-write";

export type ReportKind = "final" | "progress";
export type ReportBoardState = "not_applicable" | "pending" | "applied";
export type ReportLeadDeliveryState =
  "pending" | "enqueued" | "dispatching" | "sent_to_pi" | "outcome_unknown" | "error" | "settled";

export interface FrozenContextWrite {
  objectiveId: string;
  expectedPrevUpdatedAt: number | null;
  context: string;
  stamp?: { at: number; commit?: string };
}

export interface FrozenTaskTransition {
  objectiveId: string;
  taskId: string;
  expectedSession: string;
}

export interface FrozenReportPlan {
  answeredInputIds: string[];
  contextWrite: FrozenContextWrite | null;
  taskTransitions: FrozenTaskTransition[];
}

export interface ReportLeadDelivery {
  state: ReportLeadDeliveryState;
  acceptedByPiAt?: number;
  settledAt?: number;
  errorMessage?: string;
}

export interface ReportJournalEntry {
  reportId: string;
  callId: string;
  seq: number;
  kind: ReportKind;
  workerWsId: string;
  workerName: string;
  leadMessageId: string;
  payload: { text?: string; context?: string; objectiveId?: string };
  frozenPlan: FrozenReportPlan | null;
  boardState: ReportBoardState;
  leadDelivery: ReportLeadDelivery;
  createdAt: number;
}

export type NewReportJournalEntry = Omit<
  ReportJournalEntry,
  "seq" | "leadMessageId" | "payload"
> & {
  payload: ReportJournalEntry["payload"] & { text: string };
};

interface JournalSnapshot {
  version: 1;
  nextSeq: number;
  entries: ReportJournalEntry[];
}

export interface ReportJournalStoreOptions {
  beforeRename?: () => void;
}

export function reportLeadMessageId(reportId: string): string {
  return `report-${reportId}`;
}

export function reportPromptInputId(reportId: string): string {
  return `report:${reportId}`;
}

export function buildReportEnvelope(
  entry: ReportJournalEntry,
  formattedBody: string,
): PromptEnvelope {
  const marker = formatReportMarker(entry.reportId);
  return {
    inputId: reportPromptInputId(entry.reportId),
    text: formattedBody.includes(marker)
      ? formattedBody
      : `${marker}${formattedBody ? `\n${formattedBody}` : ""}`,
    reportId: entry.reportId,
  };
}

export function deliveryStateRank(state: ReportLeadDeliveryState): number {
  switch (state) {
    case "pending":
      return 0;
    case "enqueued":
      return 1;
    case "dispatching":
      return 2;
    case "sent_to_pi":
    case "outcome_unknown":
    case "error":
      return 3;
    case "settled":
      return 4;
  }
}

export function messageStatusToDeliveryState(
  status: MessageStatus,
): ReportLeadDeliveryState | null {
  switch (status) {
    case "queued":
    case "starting":
      return "enqueued";
    case "dispatching":
    case "streaming":
      return "dispatching";
    case "done":
      return "sent_to_pi";
    case "outcome_unknown":
      return "outcome_unknown";
    case "error":
      return "error";
    default:
      return null;
  }
}

function terminalDeliveryState(state: ReportLeadDeliveryState): boolean {
  return deliveryStateRank(state) >= deliveryStateRank("sent_to_pi");
}

export function reconcileReportDeliveryState(
  journalState: ReportLeadDeliveryState,
  messageStatus: MessageStatus | null,
): {
  targetState: ReportLeadDeliveryState;
  journalNeedsUpdate: boolean;
  shouldEnqueue: boolean;
  shouldProbeDispatching: boolean;
  isTerminal: boolean;
} {
  const messageState = messageStatus === null ? null : messageStatusToDeliveryState(messageStatus);
  const targetState =
    messageState !== null && deliveryStateRank(messageState) > deliveryStateRank(journalState)
      ? messageState
      : journalState;
  return {
    targetState,
    journalNeedsUpdate: targetState !== journalState,
    shouldEnqueue: targetState === "pending" && messageStatus === null,
    shouldProbeDispatching: targetState === "dispatching",
    isTerminal: terminalDeliveryState(targetState),
  };
}

function compactEntry(entry: ReportJournalEntry): ReportJournalEntry {
  if (entry.boardState === "pending" || entry.leadDelivery.state !== "settled") return entry;
  if (entry.frozenPlan === null && !Object.keys(entry.payload).length) return entry;
  // The bridge forwards Pi's toolCallId and Codex sends the app-server callId.
  // Neither gives the hub a retry expiry or durable acknowledgement of the
  // tool result. Keep every settled call's deduplication tombstone for the
  // project's lifetime, not just the latest calls or a wall-clock window.
  return { ...entry, payload: {}, frozenPlan: null };
}

export class ReportJournalStore {
  private file: string | null = null;
  private entries: ReportJournalEntry[] = [];
  private nextSeq = 1;
  private legacy = false;

  constructor(private readonly options: ReportJournalStoreOptions = {}) {}

  load(projectDir: string): ReportJournalEntry[] {
    const file = path.join(projectDir, "inbox.json");
    let entries: ReportJournalEntry[] = [];
    let nextSeq = 1;
    let legacy = false;
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as
        Partial<JournalSnapshot> | ReportJournalEntry[] | null;
      if (Array.isArray(parsed)) {
        entries = parsed;
        legacy = true;
      } else if (
        parsed?.version === 1 &&
        Array.isArray(parsed.entries) &&
        Number.isSafeInteger(parsed.nextSeq) &&
        parsed.nextSeq! > 0
      ) {
        entries = parsed.entries;
        nextSeq = parsed.nextSeq!;
      } else {
        throw new Error(
          `Invalid report journal "${file}": expected an array or version 1 snapshot`,
        );
      }
      for (const entry of entries) {
        if (
          !Number.isSafeInteger(entry.seq) ||
          entry.seq < 1 ||
          entry.seq >= Number.MAX_SAFE_INTEGER
        )
          throw new Error(`Invalid report sequence in "${file}"`);
        nextSeq = Math.max(nextSeq, entry.seq + 1);
      }
    }
    this.file = file;
    this.entries = entries;
    this.nextSeq = nextSeq;
    this.legacy = legacy;
    return this.list();
  }

  list(): ReportJournalEntry[] {
    return [...this.entries];
  }

  getByReportId(reportId: string): ReportJournalEntry | undefined {
    return this.entries.find((entry) => entry.reportId === reportId);
  }

  findByCallId(callId: string): ReportJournalEntry | undefined {
    return this.entries.find((entry) => entry.callId === callId);
  }

  append(input: NewReportJournalEntry): { entry: ReportJournalEntry; duplicate: boolean } {
    const duplicate = this.findByCallId(input.callId);
    if (duplicate) return { entry: duplicate, duplicate: true };

    const seq = this.nextSeq;
    if (seq >= Number.MAX_SAFE_INTEGER) throw new Error("Report sequence exhausted");
    const entry: ReportJournalEntry = {
      ...input,
      seq,
      leadMessageId: reportLeadMessageId(input.reportId),
    };
    this.persist([...this.entries, entry], seq + 1);
    return { entry: this.entries.at(-1)!, duplicate: false };
  }

  updateBoardState(reportId: string, boardState: ReportBoardState): ReportJournalEntry {
    return this.update(reportId, (entry) => ({ ...entry, boardState }));
  }

  updateLeadDelivery(reportId: string, patch: Partial<ReportLeadDelivery>): ReportJournalEntry {
    return this.update(reportId, (entry) => ({
      ...entry,
      leadDelivery: { ...entry.leadDelivery, ...patch },
    }));
  }

  private update(
    reportId: string,
    change: (entry: ReportJournalEntry) => ReportJournalEntry,
  ): ReportJournalEntry {
    const index = this.entries.findIndex((entry) => entry.reportId === reportId);
    if (index < 0) throw new Error(`Report "${reportId}" is not in the journal`);
    const updated = change(this.entries[index]);
    const entries = [...this.entries];
    entries[index] = updated;
    this.persist(entries);
    return this.entries[index];
  }

  compact(): void {
    const entries = this.entries.map(compactEntry);
    if (this.legacy || entries.some((entry, index) => entry !== this.entries[index]))
      this.persist(entries);
  }

  private persist(entries: ReportJournalEntry[], nextSeq = this.nextSeq): void {
    if (!this.file) throw new Error("Report journal is not loaded; call load(projectDir) first");
    const snapshot: JournalSnapshot = { version: 1, nextSeq, entries: entries.map(compactEntry) };
    writeAtomicJson(this.file, snapshot, this.options.beforeRename);
    this.entries = snapshot.entries;
    this.nextSeq = nextSeq;
    this.legacy = false;
  }
}
