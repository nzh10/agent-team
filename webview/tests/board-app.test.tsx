// The board page wired into the App: asking the lead, dialogs over it, and
// stream frames that must not re-render it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import * as board from "../src/project/board";
import type { Project, Workspace } from "../src/state/useServer";
import {
  bootProjectApp as boot,
  cliceProject,
  frame,
  repoSession,
  resetProjectApp,
  setupProjectApp,
} from "./helpers/projectApp";

vi.mock("../src/project/board", async (orig) => {
  const real = await orig<typeof import("../src/project/board")>();
  return { ...real, areaCounts: vi.fn(real.areaCounts) };
});

const NOW = Date.now();

const ws = (id: string, fields?: Partial<Workspace>) => repoSession(id, NOW, fields);

const project = (over: Partial<Project> = {}) =>
  cliceProject(NOW, {
    objectives: [
      {
        id: "core/modules",
        area: "core",
        title: "C++20 modules",
        goal: "Serve modules",
        status: "active",
        priority: "high",
        dependsOn: [],
        tasks: [],
        decisions: [],
        sessions: [],
        updatedAt: NOW,
      },
    ],
    ...over,
  });

const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo/clice",
  projectLink: { projectId: "p1", role: "lead" },
  lastMessageAt: NOW - 4000,
  agents: [{ id: "a-lead", name: "Lead", model: "m", avatar: "L", color: "#fff", isDefault: true }],
});
const worker = ws("w1", {
  name: "modules",
  cwd: "/wt/clice-modules",
  projectLink: { projectId: "p1", role: "worker" },
  lastMessageAt: NOW - 3000,
});

const textarea = () => document.querySelector("textarea") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const openBoard = () =>
  fireEvent.click(document.querySelector('.side-rail [aria-label^="Objectives of"]')!);
const ask = () => {
  fireEvent.click(document.querySelector(".bp-card")!);
  fireEvent.click(document.querySelector(".bp-ask")!);
  frame();
};

beforeEach(setupProjectApp);
afterEach(resetProjectApp);

describe("Ask the lead", () => {
  it("adds the objective to the draft in the lead's composer", () => {
    boot([lead, worker], [project()], "lead");
    type("half-written question for the lead");
    openBoard();
    ask();
    expect(textarea().value).toBe("half-written question for the lead\nAbout core/modules: ");
  });

  it.each([
    { draft: "", expected: "About core/modules: " },
    { draft: "Half-written question", expected: "Half-written question\nAbout core/modules: " },
  ])("opens the lead's composer from a worker with draft '$draft'", ({ draft, expected }) => {
    boot([lead, worker], [project()], "lead");
    if (draft) type(draft);
    fireEvent.click(
      [...document.querySelectorAll(".task-item")].find((e) => e.textContent.includes("modules"))!,
    );
    frame();
    expect(textarea().value).toBe("");
    openBoard();
    ask();
    expect(document.querySelector(".panel-title")!.textContent).toMatch(/^clice · lead/);
    expect(textarea().value).toBe(expected);
    expect(document.activeElement).toBe(textarea());
  });

  it("is not offered when the project has no lead", () => {
    boot([worker], [project({ leadWorkspaceId: null })], "w1");
    openBoard();
    fireEvent.click(document.querySelector(".bp-card")!);
    expect(document.querySelector(".bp-ask")).toBeNull();
  });
});

describe("stream frames", () => {
  it("keeps BoardPage out of App re-renders", () => {
    const busy = ws("other", {
      name: "other",
      lastMessageAt: NOW - 2000,
      agents: [
        {
          id: "a1",
          name: "coder",
          model: "m",
          avatar: "C",
          color: "#fff",
          isDefault: true,
          busy: true,
        },
      ],
    });
    // The board is open from the lead while another workspace streams.
    const { recv } = boot([lead, worker, busy], [project()], "lead");
    recv({
      type: "new_message",
      workspaceId: "other",
      message: {
        id: "m1",
        kind: "agent",
        agentId: "a1",
        content: "",
        timestamp: NOW,
        status: "streaming",
      },
    });
    openBoard();
    frame();
    const areas = vi.mocked(board.areaCounts);
    const before = areas.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      recv({
        type: "stream_event",
        workspaceId: "other",
        messageId: "m1",
        event: { type: "text", text: `chunk ${i} ` },
      });
      recv({ type: "agent_activity", workspaceId: "other", agentId: "a1", activity: `step ${i}` });
      recv({
        type: "system_status",
        osName: "linux",
        osArch: "x64",
        cpuModel: "x",
        cpuCores: 8,
        cpuUsage: i,
        memTotal: 100,
        memUsed: 50,
        uptime: 1,
        hostname: "h",
        quota: [],
      });
      frame();
    }
    expect(areas.mock.calls.length - before).toBe(0);
  });
});

describe("Issues from the server", () => {
  const module = (id: string, issueId: string, text: string) => ({
    id,
    title: id,
    objectives: [],
    issues: [{ id: issueId, state: "open", tags: [], text, objectives: [] }],
    groups: [],
    updatedAt: NOW,
  });
  const rows = () => [...document.querySelectorAll(".bi-row .bp-id")].map((e) => e.textContent);

  it("come with init and are replaced by a project's own message, apart from its objectives", () => {
    const { recv } = boot([lead, worker], [project()], "lead", {
      issues: { p1: [module("paths", "10-07#1", "Bad path")] },
    });
    openBoard();
    fireEvent.click(
      [...document.querySelectorAll(".bp-modes button")].find((b) =>
        b.textContent.startsWith("Issues"),
      )!,
    );
    expect(rows()).toEqual(["10-07#1"]);

    recv({ type: "project_updated", project: project({ name: "clice!" }) });
    expect(rows()).toEqual(["10-07#1"]);

    recv({
      type: "project_issues",
      projectId: "p1",
      modules: [module("paths", "10-07#1", "Bad path"), module("hosting", "10-07#2", "Host")],
    });
    expect(rows()).toEqual(["10-07#1", "10-07#2"]);
  });
});

describe("the board over a session", () => {
  it("leaves the session's new messages unread while it covers it", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { sock, recv } = boot([lead, worker], [project()], "lead");
    const marks = () => sock.frames().filter((f) => f.type === "mark_seen");
    openBoard();
    sock.sent = [];
    recv({
      type: "new_message",
      workspaceId: "lead",
      message: {
        id: "n1",
        kind: "agent",
        agentId: "a-lead",
        content: "x",
        timestamp: NOW,
        status: "done",
      },
    });
    expect(marks()).toEqual([]);
  });
});
