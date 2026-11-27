import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectCommitLock } from "../../src/project/commit-lock";
import {
  computeNoteVersion,
  ProjectNotesStore,
  validateNoteSlug,
  writeNote,
} from "../../src/project/notes";
import type { MessageStatus } from "../../src/session/types";
import {
  buildReportEnvelope,
  deliveryStateRank,
  messageStatusToDeliveryState,
  reconcileReportDeliveryState,
  ReportJournalStore,
  reportLeadMessageId,
  reportPromptInputId,
  type NewReportJournalEntry,
  type ReportLeadDeliveryState,
} from "../../src/project/report-journal";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-building-blocks-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ProjectCommitLock", () => {
  it("runs same-project tasks in strict FIFO order and cleans up at idle", async () => {
    const lock = new ProjectCommitLock();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = lock.run("p1", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = lock.run("p1", () => {
      events.push("second:start");
      return 2;
    });
    const third = lock.run("p1", () => {
      events.push("third:start");
      return 3;
    });

    expect(lock.isLocked("p1")).toBe(true);
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "third:start"]);
    await lock.waitForIdle("p1");
    expect(lock.isLocked("p1")).toBe(false);
  });

  it("runs different projects in parallel", async () => {
    const lock = new ProjectCommitLock();
    const events: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    const gateB = new Promise<void>((resolve) => (releaseB = resolve));
    const a = lock.run("a", async () => {
      events.push("a:start");
      await gateA;
      events.push("a:end");
    });
    const b = lock.run("b", async () => {
      events.push("b:start");
      await gateB;
      events.push("b:end");
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toEqual(["a:start", "b:start"]);
    } finally {
      releaseA();
      releaseB();
    }
    await Promise.all([a, b]);
    await Promise.all([lock.waitForIdle("a"), lock.waitForIdle("b")]);
  });

  it("does not let a rejected or synchronously thrown task poison the queue", async () => {
    const lock = new ProjectCommitLock();
    const failed = lock.run("p", () => Promise.reject(new Error("expected failure")));
    const afterFailure = lock.run("p", () => "still runs");
    const syncFailure = lock.run("p", () => {
      throw new Error("expected sync failure");
    });
    const last = lock.run("p", () => "last runs");

    await expect(failed).rejects.toThrow("expected failure");
    await expect(afterFailure).resolves.toBe("still runs");
    await expect(syncFailure).rejects.toThrow("expected sync failure");
    await expect(last).resolves.toBe("last runs");
    await lock.waitForIdle("p");
    expect(lock.isLocked("p")).toBe(false);
  });
});

describe("ProjectNotesStore", () => {
  it("creates, lists, reads and updates markdown notes", () => {
    const store = new ProjectNotesStore(path.join(tmpDir(), "notes"));
    const created = store.writeNote("zeta", "# Zeta\n");
    expect(created.version).toBe(computeNoteVersion("# Zeta\n"));
    store.writeNote("alpha", "Alpha", null);

    expect(store.readNote("zeta")).toMatchObject({
      slug: "zeta",
      content: "# Zeta\n",
      version: created.version,
    });
    expect(store.listNotes().map((note) => note.slug)).toEqual(["alpha", "zeta"]);
    expect(store.listNotes()[1].sizeBytes).toBe(Buffer.byteLength("# Zeta\n"));

    const updated = store.writeNote("zeta", "Updated", created.version);
    expect(updated.version).toBe(computeNoteVersion("Updated"));
    expect(store.readNote("zeta").content).toBe("Updated");
    expect(fs.readdirSync(store.notesDir).sort()).toEqual(["alpha.md", "zeta.md"]);
  });

  it("rejects traversal, hidden, repeated-dot and extension-bearing slugs", () => {
    const store = new ProjectNotesStore(path.join(tmpDir(), "notes"));
    for (const slug of ["../x", "a/b", "a\\b", ".hidden", "a..b", "a b", "a\0b", "guide.md"]) {
      expect(() => validateNoteSlug(slug), slug).toThrow(/Bad note slug/);
      expect(() => store.readNote(slug), slug).toThrow(/Bad note slug/);
      expect(() => store.writeNote(slug, "bad"), slug).toThrow(/Bad note slug/);
    }
    expect(store.listNotes()).toEqual([]);
  });

  it("refuses file and directory symlinks that escape and skips them in listings", () => {
    const base = tmpDir();
    const notesDir = path.join(base, "notes");
    const outside = path.join(base, "outside");
    fs.mkdirSync(notesDir);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret"), "secret");
    fs.symlinkSync(path.join(outside, "secret"), path.join(notesDir, "escape.md"));
    fs.symlinkSync(outside, path.join(notesDir, "directory.md"));
    const store = new ProjectNotesStore(notesDir);
    store.writeNote("safe", "safe");

    expect(() => store.readNote("escape")).toThrow(/outside the notes directory/);
    expect(() => store.writeNote("escape", "overwrite")).toThrow(/outside the notes directory/);
    expect(() => store.readNote("directory")).toThrow(/outside the notes directory/);
    expect(store.listNotes().map((note) => note.slug)).toEqual(["safe"]);
    expect(fs.readFileSync(path.join(outside, "secret"), "utf8")).toBe("secret");
  });

  it("returns NOTE_VERSION_CONFLICT with the current version", () => {
    const store = new ProjectNotesStore(path.join(tmpDir(), "notes"));
    expect(() => store.writeNote("missing", "x", "stale")).toThrow(
      expect.objectContaining({ code: "NOTE_VERSION_CONFLICT", currentVersion: null }),
    );

    const created = store.writeNote("note", "one", "");
    for (const expected of [undefined, null, "", "stale"]) {
      expect(() => store.writeNote("note", "two", expected)).toThrow(
        expect.objectContaining({
          code: "NOTE_VERSION_CONFLICT",
          currentVersion: created.version,
        }),
      );
    }
    expect(store.readNote("note").content).toBe("one");
  });

  it("rejects a stale version after a hand edit, then accepts the freshly read version", () => {
    const notesDir = path.join(tmpDir(), "notes");
    const store = new ProjectNotesStore(notesDir);
    const stale = store.writeNote("shared", "original");
    fs.writeFileSync(path.join(notesDir, "shared.md"), "edited by hand");

    expect(() => store.writeNote("shared", "stale overwrite", stale.version)).toThrow(
      expect.objectContaining({
        code: "NOTE_VERSION_CONFLICT",
        currentVersion: computeNoteVersion("edited by hand"),
      }),
    );
    expect(store.readNote("shared").content).toBe("edited by hand");

    const fresh = store.readNote("shared");
    store.writeNote("shared", "accepted", fresh.version);
    expect(store.readNote("shared").content).toBe("accepted");
  });

  it("also exposes the standalone write function with the same locking contract", () => {
    const notesDir = path.join(tmpDir(), "notes");
    const created = writeNote(notesDir, "standalone", "one");
    expect(() => writeNote(notesDir, "standalone", "two")).toThrow(
      expect.objectContaining({ code: "NOTE_VERSION_CONFLICT" }),
    );
    writeNote(notesDir, "standalone", "two", created.version);
  });
});

function reportInput(
  reportId: string,
  callId: string,
  over: Partial<NewReportJournalEntry> = {},
): NewReportJournalEntry {
  return {
    reportId,
    callId,
    kind: "final",
    workerWsId: "worker-ws",
    workerName: "worker",
    payload: { text: `payload for ${reportId}` },
    frozenPlan: {
      answeredInputIds: ["input-1"],
      contextWrite: null,
      taskTransitions: [],
    },
    boardState: "pending",
    leadDelivery: { state: "pending" },
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe("ReportJournalStore", () => {
  it("deduplicates callId, allocates monotonic seq, persists updates and reloads", () => {
    const projectDir = tmpDir();
    const store = new ReportJournalStore();
    expect(store.load(projectDir)).toEqual([]);

    const first = store.append(reportInput("r1", "call-1"));
    expect(first).toMatchObject({ duplicate: false, entry: { seq: 1 } });
    expect(first.entry.leadMessageId).toBe("report-r1");
    const duplicate = store.append(
      reportInput("different-report", "call-1", { payload: { text: "ignored" } }),
    );
    expect(duplicate).toEqual({ entry: first.entry, duplicate: true });

    const second = store.append(reportInput("r2", "call-2", { kind: "progress" }));
    expect(second.entry.seq).toBe(2);
    expect(store.list()).toHaveLength(2);
    expect(store.findByCallId("call-1")?.reportId).toBe("r1");
    expect(store.getByReportId("r2")?.seq).toBe(2);

    store.updateBoardState("r1", "applied");
    store.updateLeadDelivery("r1", {
      state: "sent_to_pi",
      acceptedByPiAt: 1_700_000_000_100,
    });
    const reloaded = new ReportJournalStore();
    reloaded.load(projectDir);
    expect(reloaded.list()).toEqual(store.list());
    expect(reloaded.getByReportId("r1")).toMatchObject({
      boardState: "applied",
      leadDelivery: { state: "sent_to_pi", acceptedByPiAt: 1_700_000_000_100 },
    });
    if (process.platform !== "win32")
      expect(fs.statSync(path.join(projectDir, "inbox.json")).mode & 0o777).toBe(0o600);
  });

  it("upgrades legacy sequence numbers and keeps a larger durable high-water mark", () => {
    const projectDir = tmpDir();
    const file = path.join(projectDir, "inbox.json");
    const legacy = { ...reportInput("legacy", "old"), seq: 91, leadMessageId: "report-legacy" };
    fs.writeFileSync(file, JSON.stringify([legacy]));
    const store = new ReportJournalStore();
    store.load(projectDir);
    store.compact();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ version: 1, nextSeq: 92 });
    expect(store.append(reportInput("new", "new")).entry.seq).toBe(92);
    fs.writeFileSync(file, JSON.stringify({ version: 1, nextSeq: 400, entries: [legacy] }));
    store.load(projectDir);
    expect(store.append(reportInput("later", "later")).entry.seq).toBe(400);
  });

  it("compacts only fully settled reports and deduplicates old retries before and after compaction", () => {
    const projectDir = tmpDir();
    const file = path.join(projectDir, "inbox.json");
    const large = "large report body\n".repeat(1000);
    const rows = [
      reportInput("settled", "old", {
        payload: { text: large },
        boardState: "applied",
        leadDelivery: { state: "settled" },
      }),
      reportInput("board-pending", "board", { leadDelivery: { state: "settled" } }),
      reportInput("unknown", "unknown", {
        boardState: "applied",
        leadDelivery: { state: "outcome_unknown" },
      }),
      reportInput("dispatching", "dispatching", {
        boardState: "applied",
        leadDelivery: { state: "dispatching" },
      }),
    ].map((row, index) => ({
      ...row,
      seq: index + 10,
      leadMessageId: reportLeadMessageId(row.reportId),
    }));
    fs.writeFileSync(file, JSON.stringify(rows));
    const store = new ReportJournalStore();
    store.load(projectDir);
    const retry = reportInput("different", "old");
    expect(store.append(retry)).toMatchObject({
      duplicate: true,
      entry: { seq: 10, payload: { text: large } },
    });
    store.compact();
    expect(store.list().slice(1)).toEqual(rows.slice(1));
    const snapshot = fs.readFileSync(file, "utf8");
    expect(snapshot).not.toContain("large report body");
    store.load(projectDir);
    expect(store.append(retry)).toMatchObject({
      duplicate: true,
      entry: { seq: 10, reportId: "settled", payload: {}, frozenPlan: null },
    });
    store.compact();
    expect(fs.readFileSync(file, "utf8")).toBe(snapshot);
    expect(store.append(reportInput("new", "new")).entry.seq).toBe(14);
  });

  it("beforeRename failure leaves the old snapshot and memory untouched with no temp files", () => {
    const projectDir = tmpDir();
    const initial = new ReportJournalStore();
    initial.load(projectDir);
    initial.append(reportInput("r1", "call-1"));
    const file = path.join(projectDir, "inbox.json");
    const before = fs.readFileSync(file, "utf8");

    let shouldCrash = true;
    const crashing = new ReportJournalStore({
      beforeRename: () => {
        if (shouldCrash) throw new Error("crash before rename");
      },
    });
    crashing.load(projectDir);
    expect(() => crashing.append(reportInput("r2", "call-2"))).toThrow("crash before rename");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(crashing.list()).toEqual(initial.list());
    expect(fs.readdirSync(projectDir)).toEqual(["inbox.json"]);

    shouldCrash = false;
    expect(crashing.append(reportInput("r2", "call-2")).entry.seq).toBe(2);
    expect(new ReportJournalStore().load(projectDir)).toHaveLength(2);
  });

  it("builds a deterministic envelope with exactly one report marker", () => {
    const store = new ReportJournalStore();
    store.load(tmpDir());
    const entry = store.append(reportInput("report-α", "call")).entry;
    const body = "Worker finished\n\nDetails";
    const envelope = buildReportEnvelope(entry, body);
    expect(envelope).toEqual({
      inputId: "report:report-α",
      reportId: "report-α",
      text: `[agent-team:report:report-α]\n${body}`,
    });
    expect(reportLeadMessageId(entry.reportId)).toBe("report-report-α");
    expect(reportPromptInputId(entry.reportId)).toBe("report:report-α");

    const marked = `preface [agent-team:report:${entry.reportId}] suffix`;
    expect(buildReportEnvelope(entry, marked).text).toBe(marked);
  });
});

describe("report delivery reconciliation", () => {
  it("maps every MessageStatus to its delivery phase", () => {
    const expected: Record<MessageStatus, ReportLeadDeliveryState> = {
      queued: "enqueued",
      starting: "enqueued",
      dispatching: "dispatching",
      streaming: "dispatching",
      done: "sent_to_pi",
      outcome_unknown: "outcome_unknown",
      error: "error",
    };
    for (const [status, state] of Object.entries(expected) as Array<
      [MessageStatus, ReportLeadDeliveryState]
    >) {
      expect(messageStatusToDeliveryState(status)).toBe(state);
    }
    expect(deliveryStateRank("pending")).toBe(0);
    expect(deliveryStateRank("enqueued")).toBe(1);
    expect(deliveryStateRank("dispatching")).toBe(2);
    expect(deliveryStateRank("sent_to_pi")).toBe(3);
    expect(deliveryStateRank("outcome_unknown")).toBe(3);
    expect(deliveryStateRank("error")).toBe(3);
    expect(deliveryStateRank("settled")).toBe(4);
  });

  it.each([
    // Missing history authorizes a fresh enqueue only for a pending report.
    ["pending", null, "pending", { shouldEnqueue: true }],
    ["enqueued", null, "enqueued", {}],
    // Window 4a: the message is already in the queue.
    ["pending", "queued", "enqueued", { journalNeedsUpdate: true }],
    ["enqueued", "queued", "enqueued", {}],
    // Window 5a: probe a dispatch rather than replaying it.
    [
      "enqueued",
      "dispatching",
      "dispatching",
      { journalNeedsUpdate: true, shouldProbeDispatching: true },
    ],
    [
      "enqueued",
      "streaming",
      "dispatching",
      { journalNeedsUpdate: true, shouldProbeDispatching: true },
    ],
    ["dispatching", null, "dispatching", { shouldProbeDispatching: true }],
    ["dispatching", "queued", "dispatching", { shouldProbeDispatching: true }],
    ["pending", "done", "sent_to_pi", { journalNeedsUpdate: true, isTerminal: true }],
    [
      "dispatching",
      "outcome_unknown",
      "outcome_unknown",
      { journalNeedsUpdate: true, isTerminal: true },
    ],
    ["enqueued", "error", "error", { journalNeedsUpdate: true, isTerminal: true }],
  ] as const)(
    "reconciles journal %s + message %s to %s",
    (journal, message, targetState, effects) => {
      expect(reconcileReportDeliveryState(journal, message)).toEqual({
        targetState,
        journalNeedsUpdate: false,
        shouldEnqueue: false,
        shouldProbeDispatching: false,
        isTerminal: false,
        ...effects,
      });
    },
  );

  it("preserves explicit error and never regresses or re-enqueues terminal states", () => {
    for (const terminal of ["sent_to_pi", "outcome_unknown", "error", "settled"] as const) {
      for (const status of [null, "queued", "dispatching", "done", "error"] as const) {
        expect(reconcileReportDeliveryState(terminal, status)).toEqual({
          targetState: terminal,
          journalNeedsUpdate: false,
          shouldEnqueue: false,
          shouldProbeDispatching: false,
          isTerminal: true,
        });
      }
    }
    expect(reconcileReportDeliveryState("error", "outcome_unknown").targetState).toBe("error");
  });
});
