import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProjectManager, awaitsUser } from "../../src/project/manager";
import { ReportJournalStore } from "../../src/project/report-journal";
import { localPiBinary } from "../local-pi";
import { Server } from "../../src/server/server";
import { PiSession } from "../../src/session/pi";
import { formatReportMarker } from "../../src/session/types";
import type {
  DispatchAttempt,
  PromptEnvelope,
  SendHooks,
  SendReceipt,
  UiDialogRequest,
} from "../../src/session/types";
import {
  loadAll,
  saveIndex,
  saveWorkspace,
  loadWorkspaceMessages,
} from "../../src/workspace/state";
import { Workspace, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { setupProjects, withTask } from "./projectHarness";

const objective = "core/modules";
const callId = "worker-tool-call-1";

async function fixture() {
  const f = setupProjects();
  let manager = f.manager;
  let online = true;
  f.host.isLeadOnline = () => online;
  const save = (w: Workspace) => {
    saveWorkspace(f.base, w.getState(), w.takeChanged());
    saveIndex(f.base, [...f.workspaces.keys()]);
    f.host.history.changed();
  };
  f.host.saveWorkspaceNow = save;
  const { lead, project } = f.create("journal");
  await withTask(f.call, lead);
  await f.call(lead, "start_session", {
    title: "worker",
    cwd: "wt",
    task: "implement",
    objective_id: objective,
    task_id: "t1",
  });
  const worker = f.workers()[0];
  const initialInput = worker.lastDelivered()[0].input.id;
  const inboxFile = path.join(f.base, ".agent-team", "projects", project.id, "inbox.json");
  const journal = () => new ReportJournalStore().load(path.dirname(inboxFile));
  const restart = () => {
    for (const w of f.workspaces.values()) void w.dispose();
    f.workspaces.clear();
    manager.close();
    manager = new ProjectManager(f.base, f.host);
    const callbacks = (id: string): WorkspaceCallbacks => ({
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      onSaveNow: () => save(f.workspaces.get(id)!),
      canDispatch: (w) => manager.get(w.projectLink!.projectId)?.status === "active",
      onReportDeliveryState: (reportId, state, meta) =>
        manager.mirrorReportDelivery(f.workspaces.get(id)!, reportId, state, meta),
    });
    for (const state of loadAll(f.base)) {
      const w = Workspace.fromState(state, f.registry, callbacks(state.id));
      f.workspaces.set(w.id, w);
      for (const entry of w.agents.values()) entry.session.setPanelTools?.(manager.toolsFor(w));
    }
    const leadAfter = f.workspaces.get(lead.id)!;
    const workerAfter = f.workspaces.get(worker.id)!;
    return {
      manager,
      lead: leadAfter,
      worker: workerAfter,
      get session() {
        return f.session(leadAfter);
      },
    };
  };
  const call = (w: Workspace, name: string, args: Record<string, unknown> = {}, id?: string) =>
    f
      .session(w)
      .panelTools!.tools.find((tool) => tool.name === name)!
      .handler(args, undefined, id);
  const finish = (w = worker) =>
    call(w, "finish_task", { summary: "done", context: "frozen context" }, callId);
  const close = () => manager.close();
  save(lead);
  save(worker);
  return {
    ...f,
    lead,
    worker,
    project,
    initialInput,
    setOnline: (value: boolean) => {
      online = value;
    },
    inboxFile,
    journal,
    restart,
    call,
    finish,
    save,
    close,
  };
}

function attempt(envelope: PromptEnvelope): DispatchAttempt {
  return {
    inputId: envelope.inputId,
    reportId: envelope.reportId,
    generation: 1,
    beforeLeafId: null,
    beforeEntryCount: 0,
    startedAt: 100,
  };
}

describe("Project v2", () => {
  it("keeps null roots separate and exposes versioned notes only to allowed roles", async () => {
    const f = setupProjects();
    const a = f.manager.create("first", null, undefined, f.root);
    const b = f.manager.create("second", null, undefined, f.root);
    const lead = f.workspaces.get(a.leadWorkspaceId!)!;
    const other = f.workspaces.get(b.leadWorkspaceId!)!;
    expect(a).toMatchObject({
      schemaVersion: 2,
      root: null,
      status: "active",
      lead: { hostId: "local", workspaceId: lead.id },
    });
    expect(a.id).not.toBe(b.id);
    expect(f.session(lead).panelTools!.instructions).toContain("no Git repository");
    expect(await f.call(lead, "project_status")).toContain("No Git repository");
    const args = { slug: "design", content: "contents", expected_version: null };
    const written = JSON.parse(await f.call(lead, "write_note", args)) as { version: string };
    expect(written.version).toHaveLength(16);
    expect(await f.call(other, "list_notes")).toBe("[]");
    await expect(f.call(lead, "write_note", args)).rejects.toThrow(/version conflict/);
    await expect(f.call(lead, "write_note", { ...args, slug: "../escape" })).rejects.toThrow(
      /slug/,
    );
    await f.call(lead, "start_session", { title: "worker", cwd: ".", task: "read notes" });
    await f.call(lead, "start_session", {
      title: "isolated",
      cwd: ".",
      task: "do not read notes",
      isolated: true,
    });
    const [worker, isolated] = f.workers();
    const names = (w: Workspace) => f.session(w).panelTools!.tools.map((t) => t.name);
    expect(names(worker)).toContain("write_note");
    expect(
      names(isolated).filter((name) => name.endsWith("note") || name.endsWith("notes")),
    ).toEqual([]);
    f.manager.setReporting(worker.id, false);
    expect(names(worker)).toEqual(expect.arrayContaining(["list_notes", "read_note"]));
    expect(names(worker)).not.toContain("write_note");
    await f.manager.sealProject(a.id, "complete");
    await expect(
      f.call(lead, "write_note", { ...args, expected_version: written.version }),
    ).rejects.toThrow(/sealed/);
    expect(await f.call(lead, "read_note", { slug: "design" })).toContain("contents");
  });

  it("prioritizes a pending dialog on a busy workspace", async () => {
    const f = setupProjects();
    const { lead } = f.create("dialog");
    await lead.sendMessage("working");
    const agentId = lead.resolveAgent()!.info.id;
    f.session(lead).emit("ui_dialog_request", {
      workspaceId: lead.id,
      agentId,
      processGeneration: 2,
      requestId: "confirm",
    } satisfies Partial<UiDialogRequest>);
    expect(lead.isQuiet).toBe(false);
    expect(awaitsUser(lead)).toBe(true);
    expect(f.manager.awaitsUser(lead)).toBe(true);
  });
});

describe("Report outbox crash boundaries", () => {
  it("1: no ACK or dirty board before the first journal commit; same callId can retry", async () => {
    const f = await fixture();
    const append = vi.spyOn(ReportJournalStore.prototype, "append").mockImplementationOnce(() => {
      throw new Error("crash before rename");
    });
    try {
      await expect(f.finish()).rejects.toThrow("before rename");
      expect(fs.existsSync(f.inboxFile)).toBe(false);
      expect(f.objectives()[0].tasks[0].state).toBe("doing");
      expect(f.worker.lastDelivered()[0].answered).toBe(false);
      f.setOnline(false);
      await f.finish();
      await f.finish();
      expect(f.journal()).toHaveLength(1);
      expect(f.journal()[0].callId).toBe(callId);
    } finally {
      append.mockRestore();
      f.close();
    }
  });

  it("2: journal alone survives an offline ACK and replays without the worker retrying", async () => {
    const f = await fixture();
    try {
      f.setOnline(false);
      await expect(f.finish()).resolves.toContain("offline");
      expect(f.journal()[0]).toMatchObject({
        boardState: "pending",
        leadDelivery: { state: "pending" },
      });
      expect(f.objectives()[0].tasks[0].state).toBe("doing");
      const next = f.restart();
      f.setOnline(true);
      await next.manager.drainInbox(f.project.id);
      expect(f.journal()[0]).toMatchObject({
        boardState: "applied",
        leadDelivery: { state: "sent_to_pi" },
      });
      expect(next.manager.list()[0].objectives[0]).toMatchObject({
        context: "frozen context",
        tasks: [{ state: "review" }],
      });
      expect(next.worker.lastDelivered()[0].answered).toBe(true);
      expect(next.session.sent).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("3: replay after board mutation does not consume later tasks, contexts, or lead inputs", async () => {
    const f = await fixture();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const update = vi
      .spyOn(ReportJournalStore.prototype, "updateBoardState")
      .mockImplementationOnce(() => {
        throw new Error("crash after board writes");
      });
    try {
      await f.finish();
      expect(f.journal()[0].boardState).toBe("pending");
      expect(f.worker.lastDelivered()[0]).toMatchObject({ answered: true });
      expect(f.objectives()[0].tasks[0].state).toBe("review");
      await f.call(f.lead, "add_items", { objective_id: objective, tasks: ["new task"] });
      await f.call(f.worker, "update_item", {
        objective_id: objective,
        item_id: "t2",
        state: "doing",
      });
      expect(f.objectives()[0].tasks[1].session).toBe(f.worker.id);
      await f.call(f.lead, "write_objective", { id: objective, context: "new context" });
      f.endTurn(f.worker);
      f.worker.deliver(
        "new input",
        { workspaceId: f.lead.id, name: "lead", role: "lead" },
        "new input",
      );
      await Promise.resolve();
      f.save(f.worker);
      const next = f.restart();
      await next.manager.drainInbox(f.project.id);
      expect(next.worker.lastDelivered()[0]).toMatchObject({
        input: { content: "new input" },
        answered: false,
      });
      expect(next.manager.list()[0].objectives[0]).toMatchObject({
        context: "new context",
        tasks: [{ state: "review" }, { state: "doing" }],
      });
      expect(next.session.sent).toHaveLength(1);
    } finally {
      update.mockRestore();
      quiet.mockRestore();
      f.close();
    }
  });

  it.each(["4a", "4b"])(
    "%s: a persisted queued report is dispatched exactly once",
    async (window) => {
      const f = await fixture();
      try {
        f.setOnline(false);
        await f.finish();
        const next = f.restart();
        f.setOnline(true);
        const update = vi.spyOn(ReportJournalStore.prototype, "updateLeadDelivery");
        if (window === "4a")
          update.mockImplementationOnce(() => {
            throw new Error("crash after history enqueue");
          });
        try {
          if (window === "4a")
            await expect(next.manager.drainInbox(f.project.id, false)).rejects.toThrow(
              "crash after history enqueue",
            );
          else await next.manager.drainInbox(f.project.id, false);
        } finally {
          update.mockRestore();
        }
        const [pending] = f.journal();
        expect(pending.leadDelivery.state).toBe(window === "4a" ? "pending" : "enqueued");
        expect(
          loadWorkspaceMessages(f.base, next.lead.id).find((m) => m.id === pending.leadMessageId)
            ?.status,
        ).toBe("queued");
        expect(next.session.sent).toEqual([]);
        const recovered = f.restart();
        await recovered.manager.drainInbox(f.project.id);
        await recovered.manager.drainInbox(f.project.id);
        expect(recovered.lead.messages.filter((m) => m.id === pending.leadMessageId)).toHaveLength(
          1,
        );
        expect(recovered.session.sent).toHaveLength(1);
      } finally {
        f.close();
      }
    },
  );

  it("keeps a queued report through removal of the last Lead and delivers it to the successor", async () => {
    const f = await fixture();
    try {
      f.setOnline(false);
      await f.finish();
      const before = f.restart();
      f.setOnline(true);
      await before.manager.drainInbox(f.project.id, false);
      const [report] = f.journal();
      expect(before.lead.findMessage(report.leadMessageId)?.status).toBe("queued");
      before.lead.removeAgent(before.lead.resolveAgent()!.info.id);
      f.save(before.lead);
      const after = f.restart();
      expect(after.lead.agents.size).toBe(0);
      after.lead.addAgent("successor", "test", "", "", { backend: "codex" });
      after.manager.leadAgentsChanged(after.lead);
      await vi.waitFor(() => expect(after.session.sent).toHaveLength(1));
      expect(after.lead.findMessage(report.leadMessageId)?.status).toBe("done");
    } finally {
      f.close();
    }
  });

  it.each(["rejected", "received", "unknown"])(
    "recovers a removed Lead's dispatching report: %s",
    async (evidence) => {
      const f = await fixture();
      try {
        f.setOnline(false);
        await f.finish();
        const before = f.restart();
        f.setOnline(true);
        await before.manager.drainInbox(f.project.id, false);
        const [report] = f.journal();
        const file = path.join(f.base, "removed-pi.jsonl");
        const id = "removed-session";
        let respond!: (receipt: SendReceipt) => void;
        Object.assign(before.session, {
          send: (envelope: PromptEnvelope, hooks: SendHooks) => {
            hooks.onBeforeWrite?.({ ...attempt(envelope), piSession: { file, id } });
            return new Promise<SendReceipt>((resolve) => {
              respond = resolve;
            });
          },
        });
        const oldAgent = before.lead.resolveAgent()!.info.id;
        before.lead.dequeueNext(oldAgent);
        expect(f.journal()[0].leadDelivery.state).toBe("dispatching");
        before.lead.removeAgent(oldAgent);
        f.save(before.lead);
        if (evidence === "received") {
          const timestamp = new Date().toISOString();
          fs.writeFileSync(
            file,
            [
              { type: "session", id, cwd: before.lead.cwd },
              {
                type: "message",
                id: "entry",
                parentId: null,
                message: {
                  role: "user",
                  content: formatReportMarker(report.reportId),
                  timestamp: Date.now(),
                },
                timestamp,
              },
            ]
              .map((row) => JSON.stringify(row))
              .join("\n") + "\n",
          );
        } else if (evidence === "rejected") {
          respond({ disposition: "rejected", retryable: true });
          await vi.waitFor(() => expect(f.journal()[0].leadDelivery.state).toBe("enqueued"));
        }
        const after = f.restart();
        after.lead.addAgent("successor", "test", "", "", { backend: "codex" });
        after.manager.leadAgentsChanged(after.lead);
        await vi.waitFor(() =>
          expect(after.lead.findMessage(report.leadMessageId)?.status).toBe(
            evidence === "unknown" ? "outcome_unknown" : "done",
          ),
        );
        expect(after.session.sent).toHaveLength(evidence === "rejected" ? 1 : 0);
        if (evidence === "received") expect(f.journal()[0].leadDelivery.state).toBe("sent_to_pi");
      } finally {
        f.close();
      }
    },
  );

  it("does not let recovery of a removed Lead settle the successor's in-flight dispatch", async () => {
    const f = await fixture();
    try {
      f.setOnline(false);
      await f.finish();
      const { lead, manager, session } = f.restart();
      f.setOnline(true);
      await manager.drainInbox(f.project.id, false);
      const [report] = f.journal();
      const original = lead.resolveAgent()!.info.id;
      let respond!: (receipt: SendReceipt) => void;
      let stopOld!: () => void;
      vi.spyOn(f.registry.get("local")!, "destroySession").mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            stopOld = resolve;
          }),
      );
      Object.assign(session, {
        send(envelope: PromptEnvelope, hooks: SendHooks) {
          hooks.onBeforeWrite?.(attempt(envelope));
          return new Promise<SendReceipt>((resolve) => {
            respond = resolve;
          });
        },
      });
      const successor = lead.addAgent("successor", "test", "", "", { backend: "codex" });
      let newWrite!: () => void;
      const started = new Promise<void>((resolve) => {
        newWrite = resolve;
      });
      Object.assign(lead.agents.get(successor.id)!.session, {
        send(envelope: PromptEnvelope, hooks: SendHooks) {
          hooks.onBeforeWrite?.(attempt(envelope));
          newWrite();
          return new Promise<SendReceipt>(() => {});
        },
      });
      lead.dequeueNext(original);
      lead.removeAgent(original);
      f.save(lead);
      const recovering = manager.drainInbox(f.project.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      respond({ disposition: "rejected" });
      await started;
      stopOld();
      await recovering;
      expect(lead.findMessage(report.leadMessageId)).toMatchObject({
        status: "dispatching",
        queuedFor: successor.id,
      });
      expect(f.journal()[0].leadDelivery.state).toBe("dispatching");
    } finally {
      f.close();
    }
  });

  it("journals a report with no Lead agent and retains the worker's report-time commit", async () => {
    const f = await fixture();
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: f.worker.cwd, encoding: "utf8" }).trim();
      git("init", "-q");
      const commit = (message: string) => {
        git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-qm",
          message,
        );
        return git("rev-parse", "--short=9", "HEAD");
      };
      const original = commit("before report");
      const before = f.restart();
      before.lead.removeAgent(before.lead.resolveAgent()!.info.id);
      f.save(before.lead);
      // Dispatch admission can independently defer the drain during deploy.
      let allowed = false;
      f.host.dispatchAllowed = () => allowed;
      expect(await f.finish(before.worker)).toMatch(/saved.*awaiting a Lead/);
      expect(f.journal()[0]).toMatchObject({
        boardState: "pending",
        leadDelivery: { state: "pending" },
      });
      expect(commit("after report")).not.toBe(original);
      allowed = true;
      before.lead.addAgent("successor", "test", "", "", { backend: "codex" });
      before.manager.leadAgentsChanged(before.lead);
      await vi.waitFor(() => expect(before.session.sent).toHaveLength(1));
      expect(f.frames.filter((frame) => frame.type === "project_updated").at(-1)).toMatchObject({
        project: {
          objectives: [
            { id: objective, contextCommit: original, contextWritten: f.journal()[0].createdAt },
          ],
        },
      });
    } finally {
      f.close();
    }
  });

  it.each(["5a", "5b", "5c"])("%s: dispatching recovery never resends a report", async (window) => {
    const f = await fixture();
    try {
      f.setOnline(false);
      await f.finish();
      const next = f.restart();
      f.setOnline(true);
      await next.manager.drainInbox(f.project.id, false);
      const [report] = f.journal();
      const msg = next.lead.findMessage(report.leadMessageId)!;
      const hook =
        window === "5a"
          ? vi
              .spyOn(ReportJournalStore.prototype, "updateLeadDelivery")
              .mockImplementationOnce(() => {
                throw new Error("crash before inbox mirror");
              })
          : undefined;
      let sends = 0;
      const wire = next.session as unknown as {
        send: (envelope: PromptEnvelope, hooks: SendHooks) => Promise<unknown>;
      };
      wire.send = async (envelope, hooks) => {
        next.session.sessionId = "allocated-first-session-id";
        try {
          hooks.onBeforeWrite?.(attempt(envelope));
        } catch (error) {
          if (window !== "5a") throw error;
        }
        if (window !== "5a") sends++;
        return new Promise(() => {});
      };
      next.lead.dequeueNext(msg.queuedFor!);
      hook?.mockRestore();
      expect(loadWorkspaceMessages(f.base, next.lead.id).find((m) => m.id === msg.id)?.status).toBe(
        "dispatching",
      );
      expect(f.journal()[0].leadDelivery.state).toBe(window === "5a" ? "enqueued" : "dispatching");
      expect(
        loadAll(f.base).find((state) => state.id === next.lead.id)?.agents[0].session.sessionId,
      ).toBe("allocated-first-session-id");
      const recovered = f.restart();
      const found = window === "5b";
      const probe = vi.fn(() => {
        expect(f.journal()[0].leadDelivery.state).toBe("dispatching");
        return Promise.resolve({ found, anchorMissing: false });
      });
      Object.assign(recovered.session, { probeDispatchedReport: probe });
      await recovered.manager.drainInbox(f.project.id);
      expect(probe).toHaveBeenCalledExactlyOnceWith(null, report.reportId);
      expect(f.journal()[0].leadDelivery.state).toBe(found ? "sent_to_pi" : "outcome_unknown");
      expect(
        loadWorkspaceMessages(f.base, recovered.lead.id).find((m) => m.id === msg.id)?.status,
      ).toBe(found ? "done" : "outcome_unknown");
      expect(recovered.session.sent).toEqual([]);
      expect(sends).toBe(window === "5a" ? 0 : 1);
      if (!found)
        expect(
          recovered.lead.messages.some((m) => m.content.includes("Delivery outcome unknown")),
        ).toBe(true);
    } finally {
      f.close();
    }
  });

  it.skipIf(!localPiBinary).each(["unique marker", "handled extension"])(
    "5b/5c: actual Pi recovery of a first %s",
    async (kind) => {
      const f = await fixture();
      const host = f.registry.get("local")!;
      const restore = host.restoreSession.bind(host);
      const live: PiSession[] = [];
      let server: Server | undefined;
      const wrap = vi.spyOn(host, "restoreSession").mockImplementation((agentId, state) => {
        if (state.config.backend !== "pi") return restore(agentId, state);
        const pi = PiSession.fromState(state);
        live.push(pi);
        return pi;
      });
      try {
        const positive = kind === "unique marker";
        f.setOnline(false);
        await f.finish();
        const staged = f.restart();
        f.setOnline(true);
        await staged.manager.drainInbox(f.project.id, false);
        const [report] = f.journal();
        const home = path.join(f.base, "pi-home");
        const sessions = path.join(f.base, "pi-sessions");
        fs.mkdirSync(home);
        fs.mkdirSync(sessions);
        fs.writeFileSync(path.join(home, "settings.json"), '{"packages":[]}');
        const count = path.join(f.base, "input-side-effect");
        const extension = path.join(f.base, "consume.mjs");
        fs.writeFileSync(
          extension,
          `import fs from "node:fs";
export default (pi) => {
  pi.on("input", (event) => {
    if (!event.text.includes("[agent-team:report:")) return;
    fs.appendFileSync(${JSON.stringify(count)}, "handled\\n");
    return { action: "handled" };
  });
};`,
        );
        const state = staged.lead.getState();
        const agent = state.agents[0].session;
        agent.config = {
          ...agent.config,
          backend: "pi",
          model: undefined,
          piBinary: localPiBinary,
          piAgentDir: home,
          piSessionDir: sessions,
          piArgs: ["-e", extension],
        };
        agent.hasConfirmedTurns = false;
        if (positive) {
          agent.sessionId = randomUUID();
          const file = path.join(sessions, "first.jsonl");
          const timestamp = new Date().toISOString();
          const msg = state.messages!.find((message) => message.id === report.leadMessageId)!;
          msg.status = "dispatching";
          msg.dispatchAttempt = attempt(msg.queuedEnvelope!);
          fs.writeFileSync(
            file,
            [
              {
                type: "session",
                version: 3,
                id: agent.sessionId,
                timestamp,
                cwd: staged.lead.normalizedCwd,
              },
              {
                type: "message",
                id: "first-leaf",
                parentId: null,
                timestamp,
                message: {
                  role: "user",
                  content: [{ type: "text", text: formatReportMarker(report.reportId) }],
                  timestamp: Date.now(),
                },
              },
            ]
              .map((row) => JSON.stringify(row))
              .join("\n") + "\n",
          );
        }
        saveWorkspace(f.base, state);
        if (!positive) {
          const running = f.restart();
          let observed!: (receipt: string | undefined) => void;
          const sawReceipt = new Promise<string | undefined>((resolve) => {
            observed = resolve;
          });
          const pi = live.at(-1)!;
          const send = pi.send.bind(pi);
          vi.spyOn(pi, "send").mockImplementation(async (envelope, hooks) => {
            const receipt = await send(envelope, hooks);
            observed(receipt.disposition);
            // Model loss of the Hub before it can record the real handled receipt.
            return new Promise(() => {});
          });
          await running.manager.drainInbox(f.project.id);
          expect(
            await Promise.race([
              sawReceipt,
              new Promise((resolve) => setTimeout(resolve, 5000, "receipt timed out").unref()),
            ]),
          ).toBe("handled");
          expect(f.journal()[0].leadDelivery.state).toBe("dispatching");
          expect(fs.readFileSync(count, "utf8")).toBe("handled\n");
          await pi.dispose();
        }
        const before = loadAll(f.base).find((row) => row.id === staged.lead.id)!;
        const sessionBefore = before.agents[0].session;
        expect(sessionBefore.sessionId).toBeTruthy();
        expect(sessionBefore.hasConfirmedTurns).toBe(false);
        expect(before.messages!.some((m) => m.status === "queued")).toBe(false);
        fs.writeFileSync(path.join(f.base, "config.toml"), "");
        const send = vi.spyOn(PiSession.prototype, "send");
        server = new Server(0, f.base, f.base);
        await server.listening;
        expect(send).not.toHaveBeenCalled();
        send.mockRestore();
        const recovered = (
          server as unknown as { workspaces: Map<string, Workspace> }
        ).workspaces.get(staged.lead.id)!;
        const pi = recovered.resolveAgent()!.session as PiSession;
        expect(pi.sessionId).toBe(sessionBefore.sessionId);
        expect(f.journal()[0].leadDelivery.state).toBe(positive ? "sent_to_pi" : "outcome_unknown");
        expect(recovered.findMessage(report.leadMessageId)?.status).toBe(
          positive ? "done" : "outcome_unknown",
        );
        if (positive) {
          expect(pi.getState()).toMatchObject({
            hasConfirmedTurns: true,
            sessionFile: path.join(sessions, "first.jsonl"),
          });
          expect(pi.getState().expectedLeafAnchorId).toBeTruthy();
          const confirmed = loadAll(f.base).find((row) => row.id === recovered.id)!.agents[0]
            .session;
          expect(confirmed).toMatchObject({
            hasConfirmedTurns: true,
            expectedLeafAnchorId: pi.getState().expectedLeafAnchorId,
          });
        } else expect(fs.readFileSync(count, "utf8")).toBe("handled\n");
      } finally {
        wrap.mockRestore();
        await server?.close();
        await Promise.allSettled(live.map((pi) => pi.dispose()));
        f.close();
      }
    },
    30_000,
  );

  it.each(["preflight throw", "explicit rejection"])(
    "5c: preserves a known %s after restart, with no dispatch loop",
    async (mode) => {
      const f = await fixture();
      try {
        f.setOnline(false);
        await f.finish();
        const next = f.restart();
        f.setOnline(true);
        const send = vi.fn((envelope: PromptEnvelope, hooks: SendHooks) => {
          if (mode === "preflight throw") return Promise.reject(new Error(mode));
          hooks.onBeforeWrite?.(attempt(envelope));
          return Promise.resolve({ disposition: "rejected", error: mode });
        });
        Object.assign(next.session, { send });
        await next.manager.drainInbox(f.project.id);
        await vi.waitFor(() => expect(f.journal()[0].leadDelivery.state).toBe("error"));
        expect(send).toHaveBeenCalledTimes(1);
        const recovered = f.restart();
        await recovered.manager.drainInbox(f.project.id);
        expect(recovered.session.sent).toEqual([]);
        expect(recovered.lead.findMessage(f.journal()[0].leadMessageId)?.status).toBe("error");
      } finally {
        f.close();
      }
    },
  );

  it("5d: settles ordinary uncertainty without cold start, content guessing, or dropping the index entry", async () => {
    const f = await fixture();
    try {
      const next = f.restart();
      const send = vi.fn((envelope: PromptEnvelope, hooks: SendHooks) => {
        hooks.onBeforeWrite?.(attempt(envelope));
        return Promise.resolve({ disposition: "started" });
      });
      Object.assign(next.session, { send });
      await next.lead.sendMessage("ordinary uncertain sentinel");
      const state = next.lead.getState();
      const pending = state.messages!.find((m) => m.status === "dispatching")!;
      pending.queuedEnvelope!.attachmentIds = ["same.png"];
      const extensionHistory = path.join(f.base, "extension-input.jsonl");
      fs.writeFileSync(
        extensionHistory,
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: pending.queuedEnvelope!.text },
              { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
            ],
          },
        }) + "\n",
      );
      const leadSession = state.agents[0].session;
      leadSession.sessionFile = extensionHistory;
      saveWorkspace(f.base, state);
      const recovered = f.restart();
      const probe = vi.fn(() => Promise.resolve({ found: true, anchorMissing: false }));
      Object.assign(recovered.session, { probeDispatchedReport: probe });
      recovered.lead.settlePlainDispatchingOnRestore();
      expect(recovered.lead.isIdle).toBe(true);
      expect(recovered.session.sent).toEqual([]);
      expect(probe).not.toHaveBeenCalled();
      const stored = loadWorkspaceMessages(f.base, recovered.lead.id);
      expect(stored.find((m) => m.kind === "user")?.status).toBe("outcome_unknown");
      expect(stored.some((m) => m.content.includes("Verify it before retrying"))).toBe(true);
      const hits = await f.host.history.search({
        terms: ["ordinary uncertain sentinel"],
        limit: 20,
      });
      expect(hits.hits).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("6: persists the seal fence before stopping sessions and rejects concurrent new board writes and reports", async () => {
    const f = await fixture();
    try {
      const next = f.restart();
      let stop!: () => void;
      const blocked = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const destroy = vi
        .spyOn(f.registry.get("local")!, "destroySession")
        .mockImplementationOnce(() => blocked);
      const seal = next.manager.sealProject(f.project.id, "done");
      const board = expect(
        f.call(next.lead, "write_objective", { id: objective, context: "late" }),
      ).rejects.toThrow(/sealed/);
      const report = expect(f.finish(next.worker)).rejects.toThrow(/sealed/);
      await vi.waitFor(() => expect(next.manager.get(f.project.id)?.status).toBe("sealed"));
      const manifest = path.join(path.dirname(f.inboxFile), "project.json");
      expect(JSON.parse(fs.readFileSync(manifest, "utf8"))).toMatchObject({
        status: "sealed",
        sealedReason: "done",
      });
      stop();
      await Promise.all([seal, board, report]);
      destroy.mockRestore();
      expect(fs.existsSync(f.inboxFile)).toBe(false);
    } finally {
      f.close();
    }
  });
});
