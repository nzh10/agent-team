import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { formatReportMarker, type MessageStatus, type PromptEnvelope } from "../session/types";

export type ReportKind = "final" | "progress";
export type ReportBoardState = "not_applicable" | "pending" | "applied";
export type ReportLeadDeliveryState =
  "pending" | "enqueued" | "dispatching" | "sent_to_pi" | "outcome_unknown" | "error" | "settled";

export interface FrozenContextWrite {
  objectiveId: string;
  expectedPrevUpdatedAt: number | null;
  context: string;
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
  payload: { text: string; context?: string; objectiveId?: string };
  frozenPlan: FrozenReportPlan | null;
  boardState: ReportBoardState;
  leadDelivery: ReportLeadDelivery;
  createdAt: number;
}

export type NewReportJournalEntry = Omit<ReportJournalEntry, "seq" | "leadMessageId">;

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

// Writes a complete JSON snapshot without exposing a partially-written file.
// The hook runs at the precise crash boundary after the durable temporary
// file is closed and before it replaces the previous snapshot.
export function writeAtomicJson(file: string, value: unknown, beforeRename?: () => void): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    beforeRename?.();
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

export class ReportJournalStore {
  private file: string | null = null;
  private entries: ReportJournalEntry[] = [];

  constructor(private readonly options: ReportJournalStoreOptions = {}) {}

  load(projectDir: string): ReportJournalEntry[] {
    const file = path.join(projectDir, "inbox.json");
    let entries: ReportJournalEntry[] = [];
    if (fs.existsSync(file)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(parsed))
        throw new Error(`Invalid report journal "${file}": expected an array`);
      entries = parsed as ReportJournalEntry[];
    }
    this.file = file;
    this.entries = entries;
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

    const seq = this.entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0) + 1;
    const entry: ReportJournalEntry = {
      ...input,
      seq,
      leadMessageId: reportLeadMessageId(input.reportId),
    };
    this.persist([...this.entries, entry]);
    return { entry, duplicate: false };
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
    return updated;
  }

  private persist(entries: ReportJournalEntry[]): void {
    if (!this.file) throw new Error("Report journal is not loaded; call load(projectDir) first");
    writeAtomicJson(this.file, entries, this.options.beforeRename);
    this.entries = entries;
  }
}
