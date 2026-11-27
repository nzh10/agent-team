import { describe, expect, it } from "vitest";
import { describeAttention, sessionAttention, summarizeAttention } from "../src/sidebar/attention";
import type { AgentInfo, Workspace } from "../src/state/useServer";
import { agent as makeAgent, project as makeProject, workspace } from "./helpers/fixtures";

const NOW = 1_800_000_000_000;
const agent = (state: AgentInfo["state"]) => makeAgent("a", { model: "m", color: "#fff", state });
const ws = (id: string, over: Partial<Workspace> = {}) =>
  workspace(id, { cwd: `/repo/${id}`, createdAt: NOW - 1000, lastMessageAt: NOW, ...over });
const project = (id: string, archivedAt?: number) =>
  makeProject(id, {
    name: id,
    root: `/repo/${id}`,
    createdAt: NOW - 10_000,
    ...(archivedAt !== undefined && { archivedAt }),
  });
const linked = (id: string, role: "lead" | "worker", over: Partial<Workspace> = {}) =>
  ws(id, { projectLink: { projectId: "p1", role }, ...over });

describe("sessionAttention", () => {
  it.each(["working", "waiting"] as const)(
    "suppresses a stale failure while %s but preserves your-turn and unread cues",
    (state) => {
      const running = ws("running", {
        agents: [{ ...agent(state), busy: state === "working" }],
        lastResult: "failed",
        unread: 1,
      });
      expect(sessionAttention(running)).toBe("unread");
      expect(sessionAttention({ ...running, unread: 0 })).toBeUndefined();
      expect(sessionAttention({ ...running, awaitsUser: true })).toBe("yourTurn");
    },
  );

  it("keeps failure and unread result behavior while idle", () => {
    expect(sessionAttention(ws("failed", { lastResult: "failed" }))).toBe("failed");
    expect(sessionAttention(ws("done", { lastResult: "done", unread: 1 }))).toBe("unread");
  });
});

describe("summarizeAttention", () => {
  it("counts each live background session once with Sidebar's exact unread and running predicates", () => {
    const sessions = [
      ws("active", { unread: 5, awaitsUser: true }),
      linked("both", "worker", { unread: 8, awaitsUser: true }),
      linked("unread", "worker", { unread: 8 }),
      linked("working", "worker", { awaitsUser: true, agents: [agent("working")] }),
      linked("waiting", "worker", { awaitsUser: true, agents: [agent("waiting")] }),
      linked("archived", "worker", { archivedAt: NOW, unread: 3, awaitsUser: true }),
      ws("archived-project", {
        projectLink: { projectId: "p2", role: "worker" },
        unread: 4,
      }),
      ws("quiet"),
    ];
    expect(summarizeAttention(sessions, "active", [project("p1"), project("p2", NOW)])).toEqual({
      count: 4,
      unread: 1,
      yourTurn: 3,
      failed: 0,
    });
  });

  it("summarizes a project's lead and workers with the same background exclusion", () => {
    const sessions = [
      linked("lead", "lead", { unread: 2 }),
      linked("waiting", "worker", { awaitsUser: true }),
      linked("unread", "worker", { unread: 8 }),
    ];
    expect(summarizeAttention(sessions, "active", [project("p1")])).toEqual({
      count: 3,
      unread: 2,
      yourTurn: 1,
      failed: 0,
    });
    expect(summarizeAttention(sessions, "lead", [project("p1")])).toEqual({
      count: 2,
      unread: 1,
      yourTurn: 1,
      failed: 0,
    });
    expect(summarizeAttention(sessions, "active", [project("p1", NOW)])).toEqual({
      count: 0,
      unread: 0,
      yourTurn: 0,
      failed: 0,
    });
  });
});

describe("describeAttention", () => {
  it("states the session count and your-turn status accessibly", () => {
    expect(
      describeAttention({ count: 0, unread: 0, yourTurn: 0, failed: 0 }, "background session"),
    ).toBe("no background sessions need attention");
    expect(
      describeAttention({ count: 1, unread: 1, yourTurn: 0, failed: 0 }, "background session"),
    ).toBe("1 background session needs attention");
    expect(describeAttention({ count: 2, unread: 1, yourTurn: 1, failed: 0 })).toBe(
      "2 sessions need attention, 1 your turn",
    );
  });
});
