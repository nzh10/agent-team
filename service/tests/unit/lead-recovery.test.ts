import { afterEach, describe, expect, it, vi } from "vitest";
import { setupProjects, useRecoveryClock } from "./projectHarness";
import { ProjectStore } from "../../src/project/store";
import { ReportJournalStore } from "../../src/project/report-journal";
import type { Workspace } from "../../src/workspace/workspace";

const minute = 60_000;
afterEach(() => vi.useRealTimers());
async function outage() {
  useRecoveryClock();
  vi.setSystemTime(new Date("2026-02-01T02:00:00Z"));
  const h = setupProjects();
  const p = h.create("night shift");
  let lead = p.lead;
  const entry = () => [...lead.agents.values()][0];
  const fail = (w: Workspace = lead) => {
    const s = h.session(w);
    s.isRunning = false;
    s.emit("event", { kind: "error", content: "connect ECONNREFUSED", networkFailure: true });
  };
  await lead.sendMessage("run once");
  fail();
  expect(lead.leadOutage?.phase).toBe("waiting");
  const restore = () => {
    h.manager.recovery.cancel(lead);
    lead = h.restart(lead);
    h.manager.recovery.restore(lead);
  };
  const next = () => vi.advanceTimersByTimeAsync(lead.leadOutage!.next - Date.now());
  const journal = () =>
    new ReportJournalStore().load(new ProjectStore(h.base).projectDir(p.project.id));
  return {
    ...h,
    get lead() {
      return lead;
    },
    entry,
    fail,
    next,
    restore,
    journal,
  };
}

describe("bounded project Lead recovery", () => {
  it("batches worker reports, survives restart and recovers once before the 02:30 cutoff", async () => {
    const h = await outage();
    const recovered = (h.host.onRecoveredReply = vi.fn());
    const deadline = h.lead.leadOutage!.deadline;
    await h.call(h.lead, "start_session", { title: "worker", cwd: "wt", task: "work" });
    await h.call(h.lead, "start_session", {
      title: "second worker",
      cwd: "wt",
      task: "check build",
    });
    const [w, second] = h.workers();
    await vi.advanceTimersByTimeAsync(16_000);
    await h.call(w, "report_progress", { text: "already reported" });
    h.session(w).emit("event", {
      kind: "tool_use",
      content: "",
      toolUseId: "side",
      toolName: "edit",
    });
    h.session(w).emit("event", { kind: "tool_result", content: "written", toolUseId: "side" });
    h.fail(w);
    h.fail(second);
    for (let i = 0; i < 5; i++) {
      await h.next();
      expect(h.lead.leadOutage?.batch?.admitted).toBe(true);
      h.fail();
      expect(h.lead.leadOutage?.supersedes).toHaveLength(i + 1);
      if (i === 2) h.restore();
      expect(h.lead.leadOutage?.deadline).toBe(deadline);
    }
    expect(h.journal().map((r) => r.leadDelivery.state)).toEqual(Array(3).fill("pending"));
    await h.next();
    const batch = h.session(h.lead).sent.at(-1)!;
    expect(batch).toContain("already reported");
    expect(batch).toContain("written");
    expect(batch).toContain("second worker");
    expect(batch).not.toContain("run once");
    h.session(h.lead).emit("event", { kind: "text_delta", content: "read both" });
    h.endTurn(h.lead);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lead.leadOutage).toBeUndefined();
    expect(h.journal().map((r) => r.leadDelivery.state)).toEqual(Array(3).fill("sent_to_pi"));
    expect(recovered).toHaveBeenCalledWith(
      h.lead,
      h.entry().info.id,
      expect.objectContaining({ content: "read both" }),
      true,
      expect.arrayContaining(h.journal().map((r) => r.leadMessageId)),
    );
    expect(h.session(second).sent).toHaveLength(1);
    expect(h.session(w).sent).toHaveLength(1);
    expect(h.lead.messages.filter((m) => m.events?.some((e) => e.kind === "error"))).toHaveLength(
      6,
    );
  });

  it.each(["finish_task", "report_progress"])(
    "classifies a recovered %s report independently of the synthetic panel input",
    async (tool) => {
      useRecoveryClock();
      const h = setupProjects(),
        { lead } = h.create("demo");
      const recovered = vi.fn();
      h.host.onRecoveredReply = (w, _agentId, reply, direct, ids) =>
        void recovered(direct, h.manager.finalReportState(w, ids), reply.content);
      await h.call(lead, "start_session", { title: "worker", cwd: "wt", task: "work" });
      const [worker] = h.workers();
      await h.call(
        worker,
        tool,
        tool === "finish_task" ? { summary: "ready" } : { text: "working" },
      );
      h.endTurn(worker);
      const s = h.session(lead);
      s.isRunning = false;
      s.emit("event", { kind: "error", networkFailure: true, content: "connection refused" });
      await vi.advanceTimersByTimeAsync(lead.leadOutage!.next - Date.now());
      s.emit("event", { kind: "text_delta", content: "Recovered." });
      h.endTurn(lead);
      expect(recovered).toHaveBeenCalledWith(
        false,
        tool === "finish_task" ? "ready" : "none",
        "Recovered.",
      );
    },
  );

  it("pairs only newly arrived Codex reports with a manual message and cancels the automatic wake", async () => {
    const h = await outage();
    await h.call(h.lead, "start_session", { title: "worker", cwd: "wt", task: "work" });
    await h.call(h.workers()[0], "report_progress", { text: "first report" });
    await h.next();
    h.fail();
    await h.call(h.workers()[0], "report_progress", { text: "second report" });
    const before = h.lead.messages.length;
    await h.lead.sendMessage("check results");
    const records = h.lead.messages.slice(before).filter((m) => m.kind === "user");
    expect(records).toHaveLength(2);
    expect(records[0].from?.role).toBe("panel");
    expect(records[0].content).toContain("second report");
    expect(records[0].content).not.toContain("first report");
    expect(records[1].content).toBe("check results");
    h.session(h.lead).emit("event", { kind: "text_delta", content: "ack" });
    h.endTurn(h.lead);
    await vi.advanceTimersByTimeAsync(31 * minute);
    expect(h.session(h.lead).sent).toHaveLength(3);
    expect(h.journal().map((r) => r.leadDelivery.state)).toEqual(["sent_to_pi", "sent_to_pi"]);
  });

  it.each(["cutoff", "Stop"])(
    "%s persists the hold; reconnecting never wakes Lead",
    async (mode) => {
      const h = await outage();
      const exhausted = (h.host.onRecoveryExhausted = vi.fn());
      if (mode === "Stop") await h.lead.interruptAgent(h.entry().info.id);
      else {
        const { started, deadline } = h.lead.leadOutage!;
        for (const elapsed of [30, 90, 210, 510, 1110, 1710]) {
          await h.next();
          expect(Date.now() - started).toBe(elapsed * 1000);
          expect(h.lead.leadOutage?.batch?.admitted).toBe(true);
          h.fail();
        }
        await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
        expect(h.lead.leadOutage?.phase).toBe("waiting");
        await vi.advanceTimersByTimeAsync(1);
        expect(new Date().toISOString()).toContain("02:30:00");
        expect(h.session(h.lead).sent).toHaveLength(7);
      }
      expect(h.lead.leadOutage?.phase).toBe("held");
      h.restore();
      await vi.advanceTimersByTimeAsync(60 * minute);
      expect(h.session(h.lead).sent).toEqual([]);
      expect(exhausted).toHaveBeenCalledTimes(mode === "Stop" ? 0 : 1);
      await h.lead.sendMessage("new manual request");
      expect(h.session(h.lead).sent).toEqual(["new manual request"]);
    },
  );

  it.each(["partial text", "tool use", "ambiguous RPC"])("stops after %s", async (kind) => {
    const h = await outage();
    await h.next();
    const s = h.session(h.lead);
    if (kind === "ambiguous RPC") {
      expect(h.lead.leadOutage?.batch?.admitted).toBe(true);
      s.isRunning = false;
      s.emit("event", { kind: "error", content: "RPC connection reset" });
    } else {
      s.emit(
        "event",
        kind === "tool use"
          ? { kind: "tool_use", toolName: "edit", toolUseId: "one", content: "" }
          : { kind: "text_delta", content: "partial" },
      );
      h.fail();
    }
    expect(h.lead.leadOutage?.phase).toBe("held");
    await vi.advanceTimersByTimeAsync(31 * minute);
    expect(s.sent).toHaveLength(2);
  });
});
