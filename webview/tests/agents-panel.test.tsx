import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, within, act } from "@testing-library/react";
import {
  scopeSessions,
  scopeSummary,
  sessionState,
  sessionWork,
  stateSummary,
} from "../src/panels/scope";
import { CODEX_SETUP_VALUE } from "../src/workspace/models";
import type {
  AgentInfo,
  CodexAuthState,
  ModelOption,
  Objective,
  Project,
  Workspace,
} from "../src/state/useServer";
import { agentsActions, renderAgents } from "./helpers/agentsPanel";
import { agent as makeAgent, workspace } from "./helpers/fixtures";
import { bootProjectApp, stubAppSocket } from "./helpers/projectApp";

const NOW = Date.now();
const agent = (id: string, over: Partial<AgentInfo> = {}) =>
  makeAgent(id, { name: id, model: "claude-opus-5-5[1m]", color: "#fff", ...over });
const ws = (id: string, over: Partial<Workspace> = {}) =>
  workspace(id, {
    cwd: `/home/me/work/${id}`,
    git: null,
    pr: null,
    agents: [agent(`${id}-a`)],
    createdAt: NOW - 50_000,
    lastMessageAt: NOW - 50_000,
    ...over,
  });
const objective = (over: Partial<Objective>): Objective => ({
  id: "core/modules",
  area: "core",
  title: "C++20 modules",
  goal: "g",
  status: "active",
  priority: "normal",
  dependsOn: [],
  tasks: [],
  decisions: [],
  sessions: [],
  updatedAt: NOW,
  ...over,
});
const project: Project = {
  id: "p1",
  name: "clice",
  root: "/repo",
  leadWorkspaceId: "lead",
  createdAt: 0,
  objectives: [
    objective({
      sessions: ["w1"],
      tasks: [{ id: "t1", text: "scan imports", state: "doing", session: "w1" }],
    }),
  ],
};
const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo",
  git: { branch: "main", dirty: 1, ahead: 0, behind: 0 },
  agents: [agent("lead-a", { context: { tokens: 225_000, window: 1_000_000 } })],
  projectLink: { projectId: "p1", role: "lead" },
  lastMessageAt: NOW - 90_000,
});
const w1 = ws("w1", {
  name: "modules",
  projectLink: { projectId: "p1", role: "worker" },
  git: { branch: "feat/modules", dirty: 2, ahead: 0, behind: 0 },
  lastMessageAt: NOW - 1000,
  agents: [
    agent("kisara", {
      busy: true,
      state: "working",
      activity: "running tests",
      context: { tokens: 850_000, window: 1_000_000 },
      effort: "high",
    }),
  ],
});
const w2 = ws("w2", {
  name: "docs",
  projectLink: { projectId: "p1", role: "worker" },
  archivedAt: NOW - 10,
});
const other = ws("other");

describe("panel scope", () => {
  it("covers the project's sessions, lead first, or the open workspace alone", () => {
    const all = [other, w2, w1, lead];
    expect(scopeSessions(w1, all, project).map((w) => w.id)).toEqual(["lead", "w1", "w2"]);
    expect(scopeSessions(other, all, undefined).map((w) => w.id)).toEqual(["other"]);
    expect(scopeSessions(undefined, all, undefined)).toEqual([]);
  });

  it("names a session by its busiest agent and links it to its task", () => {
    expect(sessionState(w1)).toBe("working");
    expect(sessionState(w2)).toBe("archived");
    expect(sessionState(ws("s", { agents: [agent("x", { state: "sleeping" })] }))).toBe("sleeping");
    expect(stateSummary(["working", "idle", "working", "waiting"])).toBe("2 working · 1 waiting");
    expect(stateSummary(["idle"])).toBe("idle");
    const [work] = sessionWork("w1", project.objectives);
    expect([work.objective.id, work.task?.id]).toEqual(["core/modules", "t1"]);
  });
});

describe("AgentsPanel", () => {
  const panel = () => renderAgents([lead, w1, w2], { project, activeWsId: "w1" });

  it("shows each session with where it works, what it works on and its agents", () => {
    const { container } = panel();
    expect(scopeSummary([lead, w1, w2], project)).toBe("clice · 2 sessions · 1 working");
    const card = within(container.querySelector('[aria-label="modules"]') as HTMLElement);
    expect(card.getByText("feat/modules")).toBeTruthy();
    expect(card.getByText("2 changed")).toBeTruthy();
    const work = container.querySelector('[aria-label="modules"] .ap-work')!;
    expect(work.querySelector(".ap-work-title")!.textContent).toBe("C++20 modules");
    expect(work.querySelector(".ap-task")!.textContent).toBe("scan imports");
    expect(card.getByText("running tests")).toBeTruthy();
    expect(card.getByText("opus 5.5 [1m] · high")).toBeTruthy();
    expect(card.getByText("850k / 1M")).toBeTruthy();
    expect(container.querySelector('[aria-label="modules"] .ap-context-bar span')!.className).toBe(
      "high",
    );
    expect(container.querySelector('[aria-label="modules"]')!.className).toContain("active");
  });

  it("summarizes idle and working agents and stops a turn without unfolding", () => {
    const { container, actions: a } = renderAgents([lead, w1, w2], { project, overview: true });
    const brief = (name: string) => container.querySelector(`[aria-label="${name}"] .ap-brief`)!;
    expect(brief("clice · lead").textContent).toContain("225k");
    expect(brief("modules").textContent).toContain("running tests");
    fireEvent.click(within(brief("modules") as HTMLElement).getByRole("button", { name: "Stop" }));
    expect(a.onStop).toHaveBeenCalledWith("w1");
  });

  it("shows estimated context without a tilde in folded and expanded cards", () => {
    const estimated = ws("estimated", {
      agents: [
        agent("a", {
          context: { tokens: 225_000, window: 1_000_000, estimated: true },
        }),
      ],
    });
    const { container } = renderAgents([estimated], { overview: true });
    const brief = container.querySelector(".ap-brief-meta")!;
    expect(brief.textContent).toBe("225k");
    expect(brief.textContent).not.toContain("~");

    fireEvent.click(container.querySelector(".ap-toggle")!);
    const context = container.querySelector(".ap-context")!;
    expect(context.textContent).toBe("225k / 1M");
    expect(context.textContent).not.toContain("~");
    expect(context.getAttribute("title")).toBe("Estimate: 225,000 of 1,000,000 tokens");
  });

  it("hides context for fresh agents and unloaded archived snapshots", () => {
    const { container } = renderAgents([ws("fresh"), ws("archived", { archivedAt: 1 })], {
      overview: true,
    });
    expect(container.querySelectorAll(".ap-context")).toHaveLength(0);
    expect(container.textContent).not.toContain("ctx unknown");
    expect([...container.querySelectorAll(".ap-brief-meta")].map((el) => el.textContent)).toEqual([
      "",
      "",
    ]);
  });

  it("writes a task's markdown out: its code and bold, its lines run together", () => {
    const md: Project = {
      ...project,
      objectives: [
        objective({
          title: "`modules` support",
          sessions: ["w1"],
          tasks: [
            {
              id: "t1",
              text: "评估：`CMake` / **Bazel**\n先跑 `check.py`",
              state: "doing",
              session: "w1",
            },
          ],
        }),
      ],
    };
    const { container } = renderAgents([w1], { project: md });
    const task = container.querySelector(".ap-task")!;
    expect(task.textContent).toBe("评估：CMake / Bazel 先跑 check.py");
    expect([...task.querySelectorAll("code")].map((c) => c.textContent)).toEqual([
      "CMake",
      "check.py",
    ]);
    expect(task.querySelector("strong")!.textContent).toBe("Bazel");
    expect(container.querySelector(".ap-work-title code")!.textContent).toBe("modules");
  });

  it("says where a session works only when it is not the project's checkout on main", () => {
    const { container } = panel();
    const where = (id: string) => container.querySelector(`[aria-label="${id}"] .ap-where`);
    expect(where("clice · lead")).toBeNull();
    expect(where("modules")!.textContent).toBe("feat/modules2 changed…/work/w1");
  });

  it("does not offer Stop or Archive on the idle lead card", () => {
    const { container } = panel();
    const leadCard = within(container.querySelector('[aria-label="clice · lead"]') as HTMLElement);
    expect(leadCard.queryByText("Stop")).toBeNull();
    // A lead goes with its project.
    expect(leadCard.queryByText("Archive")).toBeNull();
  });

  it("marks an idle worker waiting for the user's reply beside its name, whole in the title", () => {
    const long = "fix the wake-up time the CLI rounds up to the minute so the panel shows it early";
    const quiet = ws("w3", {
      name: long,
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
    });
    const { container } = renderAgents([lead, { ...w1, awaitsUser: true }, quiet], {
      project,
      activeWsId: "w1",
    });
    const name = container.querySelector(`[aria-label="${long}"] .ap-session-name`)!;
    expect(name.querySelector(".clip")!.getAttribute("title")).toBe(long);
    expect(name.querySelector(".awaits-tag")!.textContent).toBe("your turn");
    // A working session is not waiting, whatever the last word was.
    expect(container.querySelector('[aria-label="modules"] .awaits-tag')).toBeNull();
  });

  it("switches whether a session reports to the lead, the lead having no switch", () => {
    const { container, actions: a } = panel();
    const card = (name: string) => container.querySelector(`[aria-label="${name}"]`)!;
    expect(card("clice · lead").querySelector(".report-switch")).toBeNull();
    const own = card("modules").querySelector<HTMLButtonElement>(
      ".ap-session-foot .report-switch",
    )!;
    expect(own.textContent).toBe("Reports to lead");
    fireEvent.click(own);
    expect(a.onSetReporting).toHaveBeenCalledWith("w1", false);
  });

  it("keeps archived sessions folded away, restorable", () => {
    const { container, actions: a } = panel();
    const archived = container.querySelector(".ap-archived")!;
    expect(archived.querySelector("summary")!.textContent).toBe("Archived · 1");
    fireEvent.click(within(archived as HTMLElement).getByText("Restore"));
    expect(a.onRestore).toHaveBeenCalledWith("w2");
  });
});

describe("a session's actions by its state", () => {
  const buttons = (state: AgentInfo["state"]) => {
    const { container, unmount } = renderAgents([ws("s", { agents: [agent("a", { state })] })]);
    // Under the agents: adding one first, the session's own action at the edge.
    expect(container.querySelector(".ap-session-head .panel-btn")).toBeNull();
    const names = [...container.querySelectorAll(".ap-session-foot .panel-btn")].map(
      (b) => b.textContent,
    );
    unmount();
    return names;
  };

  it("stops only a running turn, and archives a sleeping session like an idle one", () => {
    expect(buttons("working")).toEqual(["+ Agent", "Stop"]);
    expect(buttons("waiting")).toEqual(["+ Agent"]);
    expect(buttons("sleeping")).toEqual(["+ Agent", "Archive"]);
    expect(buttons("idle")).toEqual(["+ Agent", "Archive"]);
  });
});

describe("the agents panel in the app", () => {
  beforeEach(stubAppSocket);
  afterEach(() => vi.unstubAllGlobals());

  const opus = { id: "claude-opus-5-5", label: "Opus", backend: "pi" };
  const boot = (
    active = "lead",
    workspaces = [lead, w1, w2],
    models: object[] = [opus],
    codexAuth?: CodexAuthState,
  ) =>
    bootProjectApp(workspaces, [project], active, {
      config: {
        presets: [{ name: "Isla", avatar: "I", color: "#ccc" }],
        models,
        commands: [],
        hosts: {},
        ...(codexAuth ? { codexAuth } : {}),
      },
    }).sock;

  it("opens from the header chip, which sums up the open session's agents", () => {
    boot("w1");
    const chip = document.querySelector(".agents-chip")!;
    expect(chip.textContent).toBe("Arunning tests");
    fireEvent.click(chip);
    expect(document.querySelector(".side-panel")!.getAttribute("aria-label")).toBe("Agents");
    fireEvent.click(chip);
    expect(document.querySelector(".side-panel")).toBeNull();
  });

  it("tags the lead and an isolated worker, in the sidebar and on the cards", () => {
    const isolated = {
      ...w1,
      projectLink: { projectId: "p1", role: "worker" as const, isolated: true },
    };
    boot("lead", [lead, isolated, w2]);
    fireEvent.click(document.querySelector(".agents-chip")!);
    const tags = (selector: string) =>
      [...document.querySelectorAll(selector)].map((e) => [
        e.querySelector(".clip")!.textContent,
        e.querySelector(".task-role-tag")?.textContent ?? null,
      ]);
    // The lead heads its group; an archived worker is out of the list.
    expect(tags(".task-item")).toEqual([["modules", "isolated"]]);
    // The lead's card is named "lead" already.
    expect(tags(".ap-session-name")).toEqual([
      ["lead", null],
      ["modules", "isolated"],
      ["docs", null],
    ]);
  });

  it("counts working agents on the rail without adding a separate background tasks panel", () => {
    boot("lead");
    expect(
      document.querySelector('.side-rail [aria-label="Agents and sessions"]')!.textContent,
    ).toBe("1");
    expect(document.querySelector('.side-rail [aria-label="Background tasks"]')).toBeNull();
  });

  it("pins beside the chat and remembers it", () => {
    boot();
    fireEvent.click(document.querySelector('.side-rail [aria-label="Agents and sessions"]')!);
    expect(document.querySelector(".side-panel")!.className).toContain("docked");
    fireEvent.click(document.querySelector(".side-panel-pin")!);
    expect(document.querySelector(".side-panel")!.className).toContain("floating");
    expect(localStorage.getItem("panelDock")).toBe("0");
    fireEvent.click(document.querySelector(".side-panel-pin")!);
    expect(document.querySelector(".side-panel")!.className).toContain("docked");
    expect(localStorage.getItem("panelDock")).toBe("1");
    fireEvent.keyDown(document.querySelector(".side-panel-body")!, { key: "Escape" });
    expect(document.querySelector(".side-panel")).toBeNull();
  });

  it("opens beside the chat, where floating would cut its lines", () => {
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    expect(document.querySelector(".side-panel")!.className).toContain("docked");
    expect(localStorage.getItem("panelDock")).toBeNull();
  });

  it("names project sessions without the project's name, the lead once", () => {
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    const names = [...document.querySelectorAll(".ap-session-name")].map((n) => n.textContent);
    expect(names).toContain("lead");
    expect(names.some((n) => n?.includes("clice"))).toBe(false);
  });

  it("fits a width saved on a wider screen, leaving the chat its room", () => {
    localStorage.setItem("listPanelWidth", "5000");
    vi.stubGlobal("innerWidth", 1000);
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    // 1000 - 260 (sidebar) - 44 (rail) - 360 (the chat's least).
    expect((document.querySelector(".side-panel") as HTMLElement).style.width).toBe("336px");
  });

  it("grows with the window until dragged, and goes back to that on a double-click", () => {
    vi.stubGlobal("innerWidth", 2560);
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    const panel = () => document.querySelector(".side-panel") as HTMLElement;
    expect(panel().style.width).toBe("560px");
    expect(localStorage.getItem("listPanelWidth")).toBeNull();
    const edge = document.querySelector(".side-panel-resize")!;
    fireEvent.pointerDown(edge, { clientX: 2000, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 1800, pointerId: 1 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(panel().style.width).toBe("760px");
    expect(localStorage.getItem("listPanelWidth")).toBe("760");
    fireEvent.doubleClick(edge);
    expect(panel().style.width).toBe("560px");
    expect(localStorage.getItem("listPanelWidth")).toBeNull();
  });

  it("puts the phone's rail on the branch line, not a line of its own", () => {
    boot();
    const rail = document.querySelector(".header-rail")!;
    expect(rail.parentElement!.className).toBe("workspace-info-bar");
    // Stats shares the existing objectives, agents, files and changes rail.
    expect(rail.querySelectorAll(".rail-btn")).toHaveLength(5);
    expect(rail.querySelector('.rail-btn[aria-label="Session stats"]')).not.toBeNull();
  });

  it("leaves the lead to the sidebar: a worker's branch line has no button for it", () => {
    boot("w1");
    const bar = document.querySelector(".workspace-info-bar")!;
    expect(bar.querySelector('[title^="Open the lead"]')).toBeNull();
    expect([...bar.querySelectorAll("button:not(.rail-btn)")].map((b) => b.textContent)).toEqual([
      "Reports to lead",
      "Archive",
    ]);
  });

  it("maximises over the chat until closed", () => {
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    fireEvent.click(document.querySelector(".side-panel-max")!);
    const panel = () => document.querySelector(".side-panel") as HTMLElement;
    expect(panel().className).toContain("maximized");
    expect(panel().style.left).toBe("260px");
    expect(panel().style.width).toBe("");
    expect(document.querySelector(".side-panel-pin")).toBeNull();
    expect(document.querySelector(".side-panel-resize")).toBeNull();
    fireEvent.click(document.querySelector(".side-panel-max")!);
    expect(panel().className).not.toContain("maximized");
    fireEvent.click(document.querySelector(".side-panel-max")!);
    fireEvent.click(document.querySelector(".side-panel-close")!);
    fireEvent.click(document.querySelector(".agents-chip")!);
    expect(panel().className).not.toContain("maximized");
  });

  it("steps aside for a session opened on a phone held sideways", () => {
    vi.stubGlobal(
      "matchMedia",
      (q: string) => ({ matches: q.includes("(max-height: 500px)") }) as MediaQueryList,
    );
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    fireEvent.click(document.querySelector('[aria-label="clice · lead"] .ap-session-name')!);
    expect(document.querySelector(".side-panel")).toBeNull();
  });

  for (const state of ["idle", "waiting"] as const) {
    it(`clears stale context when agent_updated omits it (${state}), matching a fresh snapshot`, () => {
      const baseAgent =
        state === "waiting"
          ? agent("kisara", {
              state: "waiting",
              busy: false,
              backgroundTasks: [
                { id: "bg-1", type: "bash", description: "sleep 10", since: NOW - 1000 },
              ],
              context: { tokens: 96_000, window: 1_000_000 },
            })
          : agent("kisara", { context: { tokens: 96_000, window: 1_000_000 } });
      const clearedAgent = { ...baseAgent };
      delete clearedAgent.context;
      const used = ws("w1", {
        name: "modules",
        projectLink: { projectId: "p1", role: "worker" },
        agents: [baseAgent],
      });
      const sock = boot("w1", [lead, used, w2]);
      fireEvent.click(document.querySelector(".agents-chip")!);
      const card = () => document.querySelector('[aria-label="modules"]')!;
      expect(card().textContent).toContain("96k / 1M");

      act(() => {
        sock.receive({ type: "agent_updated", workspaceId: "w1", agent: clearedAgent });
        sock.receive({
          type: "new_message",
          workspaceId: "w1",
          message: {
            id: "sys-1",
            kind: "system",
            agentId: "kisara",
            content: "A **kisara** context cleared",
            timestamp: NOW,
            status: "done",
          },
        });
      });

      expect(card().querySelector(".ap-context")).toBeNull();
      expect(card().textContent).not.toContain("96k / 1M");
      expect(card().textContent).not.toContain("ctx unknown");
      fireEvent.click(card().querySelector(".ap-toggle")!);
      const liveBrief = card().querySelector(".ap-brief")!.textContent;
      if (state === "idle") expect(card().querySelector(".ap-brief-meta")!.textContent).toBe("");
      else expect(liveBrief).toContain("waiting on background work");

      const freshUsed = ws("w1", {
        name: "modules",
        projectLink: { projectId: "p1", role: "worker" },
        agents: [clearedAgent],
      });
      document.body.innerHTML = "";
      boot("w1", [lead, freshUsed, w2]);
      fireEvent.click(document.querySelector(".agents-chip")!);
      expect(card().querySelector(".ap-context")).toBeNull();
      expect(card().textContent).not.toContain("ctx unknown");
      fireEvent.click(card().querySelector(".ap-toggle")!);
      expect(card().querySelector(".ap-brief")!.textContent).toBe(liveBrief);
    });
  }

  for (const state of ["idle", "waiting"] as const) {
    it(`shows unknown for agent_updated with context: null (${state}), matching a fresh snapshot`, () => {
      const baseAgent =
        state === "waiting"
          ? agent("kisara", {
              state: "waiting",
              busy: false,
              backgroundTasks: [
                { id: "bg-1", type: "bash", description: "sleep 10", since: NOW - 1000 },
              ],
              context: { tokens: 96_000, window: 1_000_000 },
            })
          : agent("kisara", { context: { tokens: 96_000, window: 1_000_000 } });
      const used = ws("w1", {
        name: "modules",
        projectLink: { projectId: "p1", role: "worker" },
        agents: [baseAgent],
      });
      const sock = boot("w1", [lead, used, w2]);
      fireEvent.click(document.querySelector(".agents-chip")!);
      const card = () => document.querySelector('[aria-label="modules"]')!;
      expect(card().textContent).toContain("96k / 1M");

      act(() => {
        sock.receive({
          type: "agent_updated",
          workspaceId: "w1",
          agent: { ...baseAgent, context: null },
        });
      });

      expect(card().querySelector(".ap-context")!.textContent).toBe("ctx unknown");
      expect(card().textContent).not.toContain("96k / 1M");
      // Folded overview brief also matches the fresh snapshot.
      fireEvent.click(card().querySelector(".ap-toggle")!);
      const liveBrief = card().querySelector(".ap-brief")!.textContent;
      if (state === "idle")
        expect(card().querySelector(".ap-brief-meta")!.textContent).toBe("ctx unknown");
      else expect(liveBrief).toContain("waiting on background work");

      // Fresh snapshot from init renders the exact same cleared state.
      const freshUsed = ws("w1", {
        name: "modules",
        projectLink: { projectId: "p1", role: "worker" },
        agents: [{ ...baseAgent, context: null }],
      });
      document.body.innerHTML = "";
      boot("w1", [lead, freshUsed, w2]);
      fireEvent.click(document.querySelector(".agents-chip")!);
      expect(card().querySelector(".ap-context")!.textContent).toBe("ctx unknown");
      fireEvent.click(card().querySelector(".ap-toggle")!);
      expect(card().querySelector(".ap-brief")!.textContent).toBe(liveBrief);
    });
  }

  it("hides unloaded context on archive and accepts the restored agent snapshot", () => {
    const baseAgent = agent("kisara", { context: null });
    const used = ws("w1", {
      name: "modules",
      projectLink: { projectId: "p1", role: "worker" },
      agents: [baseAgent],
    });
    const sock = boot("w1", [lead, used, w2]);
    fireEvent.click(document.querySelector(".agents-chip")!);
    const card = () => document.querySelector('[aria-label="modules"]')!;
    expect(card().querySelector(".ap-context")!.textContent).toBe("ctx unknown");

    act(() =>
      sock.receive({ type: "workspace_archived", workspaceId: "w1", archivedAt: NOW + 1000 }),
    );
    expect(card().querySelector(".ap-context")).toBeNull();
    expect(card().textContent).not.toContain("ctx unknown");

    act(() => {
      sock.receive({ type: "workspace_unarchived", workspaceId: "w1" });
      sock.receive({
        type: "agent_updated",
        workspaceId: "w1",
        agent: { ...baseAgent, context: { tokens: 96_000, window: 1_000_000 } },
      });
    });
    expect(card().querySelector(".ap-context")!.textContent).toBe("96k / 1M");
  });

  it("ignores legacy account updates and offers no account control", () => {
    const sock = boot(
      "lead",
      [lead, w1, w2],
      [opus, { id: "cursor/composer-2.5", label: "Composer 2.5", backend: "pi" }],
    );
    act(() => sock.receive({ type: "config_update", accounts: ["work"], defaultAccount: null }));
    fireEvent.click(document.querySelector(".agents-chip")!);
    fireEvent.click(document.querySelector('[aria-label="clice · lead"] .ap-toggle')!);
    const leadCard = within(document.querySelector('[aria-label="clice · lead"]') as HTMLElement);
    fireEvent.click(leadCard.getByText("+ Agent"));
    const fields = () =>
      [...document.querySelectorAll(".dialog-field > span")].map((e) => e.textContent);
    expect(fields()).not.toContain("Account");
    const [modelSelect] = document.querySelectorAll<HTMLSelectElement>(".dialog select");
    fireEvent.change(modelSelect, { target: { value: "cursor/composer-2.5" } });
    expect(fields()).not.toContain("Account");
    fireEvent.click(document.querySelector(".dialog .btn-primary")!);
    const added = sock.frames().find((f) => f.type === "add_agent")!;
    expect(added).toMatchObject({ model: "cursor/composer-2.5" });
    expect(added.account).toBeUndefined();
  });

  it("gates unauthenticated Codex models, preserves Pi openai-codex models, and unlocks live on recheck", () => {
    const piCodex = { id: "openai-codex/gpt-5.4", label: "GPT-5.4", backend: "pi" };
    const nativeCodex = { id: "gpt-6-astra", label: "GPT-6 Astra", backend: "codex" };
    const sock = boot("lead", [lead, w1, w2], [opus, piCodex, nativeCodex], {
      cliAvailable: true,
      authenticated: false,
      status: "unauthenticated",
      accountType: null,
      checkedAt: 1,
    });
    fireEvent.click(document.querySelector(".agents-chip")!);
    fireEvent.click(document.querySelector('[aria-label="clice · lead"] .ap-toggle')!);
    const leadCard = within(document.querySelector('[aria-label="clice · lead"]') as HTMLElement);
    fireEvent.click(leadCard.getByText("+ Agent"));

    const select = document.querySelector<HTMLSelectElement>("#add-agent-model")!;
    const optionValues = [...select.options].map((o) => o.value);
    expect(optionValues).toContain("claude-opus-5-5");
    expect(optionValues).toContain("openai-codex/gpt-5.4");
    expect(optionValues).not.toContain("gpt-6-astra");
    expect(optionValues).toContain(CODEX_SETUP_VALUE);

    fireEvent.click(document.querySelector(".codex-auth-hint")!);
    expect(document.querySelector(".dialog-codex-setup")).not.toBeNull();

    fireEvent.click(within(document.querySelector(".dialog-codex-setup")!).getByText("Re-check"));
    expect(sock.frames().some((f) => f.type === "recheck_codex_auth")).toBe(true);

    act(() => {
      sock.receive({
        type: "codex_auth_update",
        codexAuth: {
          cliAvailable: true,
          authenticated: true,
          status: "authenticated",
          accountType: "chatgpt",
          checkedAt: 2,
        },
      });
      sock.receive({
        type: "models_update",
        models: [opus, piCodex, nativeCodex],
      });
    });

    expect(document.querySelector(".dialog-codex-setup")).toBeNull();
    const updatedValues = [
      ...document.querySelectorAll<HTMLOptionElement>("#add-agent-model option"),
    ].map((o) => o.value);
    expect(updatedValues).toContain("gpt-6-astra");
    expect(updatedValues).not.toContain(CODEX_SETUP_VALUE);
  });
});

describe("an agent's state line", () => {
  const task = { id: "t1", type: "local_bash", description: "build", since: 1 };
  const lines = (session: Workspace, connected = true) => {
    const { container, unmount } = renderAgents([session], { connected });
    const out = Object.fromEntries(
      [...container.querySelectorAll(".ap-agent")].map((row) => [
        row.querySelector(".ap-agent-name")!.textContent,
        row.querySelector(".ap-agent-state")?.textContent ?? null,
      ]),
    );
    unmount();
    return out;
  };

  it("is left out for an idle agent, kept for anything worth knowing", () => {
    expect(
      lines(
        ws("s", {
          agents: [
            agent("idle"),
            agent("busy", { state: "working", activity: "running tests" }),
            agent("bg", { state: "waiting", backgroundTasks: [task] }),
            agent("nap", { state: "sleeping", backgroundTasks: [task] }),
          ],
        }),
      ),
    ).toEqual({
      idle: null,
      busy: "running tests",
      bg: "waiting on background work",
      nap: "sleeping · 1 in background",
    });
    expect(lines(ws("s", { agents: [agent("idle")] }), false)).toEqual({ idle: "offline" });
    expect(lines(ws("s", { agents: [agent("idle")], archivedAt: 1 }))).toEqual({
      idle: "archived",
    });
  });
});

describe("the summary of a workspace on its own", () => {
  it("counts its agents, not its one session", () => {
    const solo = ws("solo", {
      agents: [agent("a", { state: "working" }), agent("b", { state: "working" })],
    });
    expect(scopeSummary([solo], undefined)).toBe("solo · 2 agents · 2 working");
    expect(scopeSummary([{ ...solo, archivedAt: 1 }], undefined)).toBe("solo · archived");
  });
});

describe("switching an agent's model and effort", () => {
  const five = ["low", "medium", "high", "xhigh", "max"];
  const models = [
    { id: "claude-opus-5-5", label: "Opus 5.5", backend: "pi" as const, effortLevels: five },
    { id: "claude-fable-5-1", label: "Fable 5.1", backend: "pi" as const, effortLevels: five },
    {
      id: "gpt-6-astra",
      label: "GPT-6 Astra",
      backend: "codex" as const,
      effortLevels: ["low", "high"],
      defaultEffort: "high",
    },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", backend: "codex" as const, effortLevels: ["low"] },
    { id: "cursor/composer-2.5", label: "Composer", backend: "pi" as const, effortLevels: [] },
    {
      id: "agy/gemini-4-carbon",
      label: "Gemini 4 Carbon",
      backend: "pi" as const,
      effortLevels: ["low", "medium", "high"],
    },
    {
      id: "agy/gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      backend: "pi" as const,
      effortLevels: ["low", "medium", "high"],
    },
  ];
  const render1 = (a: AgentInfo, connected = true, available: ModelOption[] = models) => {
    const onSetModel = vi.fn();
    const onSetEffort = vi.fn();
    const utils = renderAgents([ws("s", { agents: [a] })], {
      connected,
      models: available,
      actions: agentsActions({ onSetModel, onSetEffort }),
    });
    return { ...utils, onSetModel, onSetEffort };
  };
  const options = (el: Element | null) =>
    [...(el as HTMLSelectElement).options].map((o) => o.textContent);

  it("offers both backends when the server says the session is empty", () => {
    const { container, onSetModel } = render1(
      agent("a", {
        model: "claude-opus-5-5",
        canSwitchBackend: true,
      }),
    );
    const select = container.querySelector(".ap-model") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(models.map((m) => m.id));
    fireEvent.change(select, { target: { value: "gpt-6-astra" } });
    expect(onSetModel).toHaveBeenCalledWith("s", "a", "gpt-6-astra");
  });

  it("moves a Pi conversation between provider models, one the list lacks first", () => {
    const { container, onSetModel } = render1(agent("g", { model: "agy/gemini-4-argon" }));
    const select = container.querySelector(".ap-model:not(.ap-effort)") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "agy/gemini-4-argon",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "cursor/composer-2.5",
      "agy/gemini-4-carbon",
      "agy/gemini-3.8-flash",
    ]);
    fireEvent.change(select, { target: { value: "agy/gemini-3.8-flash" } });
    expect(onSetModel).toHaveBeenCalledWith("s", "g", "agy/gemini-3.8-flash");
  });

  it("moves a Codex thread between Codex models, and offers nothing while offline", () => {
    const { container, onSetModel } = render1(agent("c", { model: "gpt-6-astra" }));
    const select = container.querySelector(".ap-model:not(.ap-effort)")!;
    expect(options(select)).toEqual(["gpt 6 astra", "gpt 5.6 sol"]);
    fireEvent.change(select, { target: { value: "gpt-5.6-sol" } });
    expect(onSetModel).toHaveBeenCalledWith("s", "c", "gpt-5.6-sol");
    expect(
      render1(agent("a", { model: "claude-opus-5-5" }), false).container.querySelector(".ap-model"),
    ).toBeNull();
  });

  it("offers the model's effort levels, its default while none is set", () => {
    const fresh = render1(agent("c", { model: "gpt-6-astra", effortLevels: ["low", "high"] }));
    const select = fresh.container.querySelector(".ap-effort")!;
    expect(options(select)).toEqual(["default (high)", "low", "high"]);
    fireEvent.change(select, { target: { value: "low" } });
    expect(fresh.onSetEffort).toHaveBeenCalledWith("s", "c", "low");
    fresh.unmount();

    const set = render1(
      agent("a", { model: "claude-opus-5-5", effort: "max", effortLevels: five }),
    );
    expect(options(set.container.querySelector(".ap-effort"))).toEqual(five);
    expect((set.container.querySelector(".ap-effort") as HTMLSelectElement).value).toBe("max");
    set.unmount();

    // A level its model's list has since lost still shows as it is.
    const lost = render1(
      agent("c", { model: "gpt-6-astra", effort: "xhigh", effortLevels: ["low", "high"] }),
    );
    const kept = lost.container.querySelector(".ap-effort") as HTMLSelectElement;
    expect(options(kept)).toEqual(["xhigh", "low", "high"]);
    expect(kept.value).toBe("xhigh");
    lost.unmount();

    // A model with no levels, or no connection: the effort as text, if any.
    const none = render1(agent("k", { model: "cursor/composer-2.5", effortLevels: [] }));
    expect(none.container.querySelector(".ap-effort")).toBeNull();
    const off = render1(agent("k", { model: "cursor/composer-2.5", effortLevels: ["off"] }));
    expect(off.container.querySelector(".ap-effort")).toBeNull();
    none.unmount();
    const offline = render1(
      agent("a", { model: "claude-opus-5-5", effort: "max", effortLevels: five }),
      false,
    );
    expect(offline.container.querySelector(".ap-effort")).toBeNull();
    expect(offline.container.querySelector(".ap-meta")!.textContent).toContain(" · max");
  });

  it("shortens provider prefixes locally and disambiguates colliding model labels while submitting full IDs", () => {
    const colliding = [
      {
        id: "anthropic/claude-opus-4-6",
        label: "Opus 4.6",
        backend: "pi" as const,
        effortLevels: ["low", "high"],
        defaultEffort: "high",
      },
      {
        id: "github-copilot/claude-opus-4-6",
        label: "Opus 4.6",
        backend: "pi" as const,
        effortLevels: ["low", "high"],
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Haiku 4.5",
        backend: "pi" as const,
        effortLevels: ["low"],
      },
      {
        id: "claude-haiku-4-5-20260115",
        label: "Haiku 4.5",
        backend: "pi" as const,
        effortLevels: ["low"],
      },
      {
        id: "google-antigravity/gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        backend: "pi" as const,
        effortLevels: ["low"],
      },
    ];
    const { container, onSetModel } = render1(
      agent("a", { model: colliding[0].id, effortLevels: ["low", "high"] }),
      true,
      colliding,
    );
    const modelSelect = container.querySelector(".ap-model:not(.ap-effort)") as HTMLSelectElement;
    expect([...modelSelect.options].map((o) => o.value)).toEqual([
      "anthropic/claude-opus-4-6",
      "github-copilot/claude-opus-4-6",
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5-20260115",
      "google-antigravity/gemini-3.8-flash",
    ]);
    expect([...modelSelect.options].map((o) => o.textContent)).toEqual([
      "opus 4.6 (anthropic)",
      "opus 4.6 (github-copilot)",
      "haiku 4.5 (20251001)",
      "haiku 4.5 (20260115)",
      "gemini 3.8 flash",
    ]);
    fireEvent.change(modelSelect, { target: { value: "github-copilot/claude-opus-4-6" } });
    expect(onSetModel).toHaveBeenCalledWith("s", "a", "github-copilot/claude-opus-4-6");
    fireEvent.change(modelSelect, { target: { value: "claude-haiku-4-5-20260115" } });
    expect(onSetModel).toHaveBeenCalledWith("s", "a", "claude-haiku-4-5-20260115");
  });

  it("handles mixed provider+date collisions, undated vs dated pairs, and single-model effort rows", () => {
    const mixed = [
      { id: "anthropic/claude-haiku-4-5-20251001", label: "Haiku", backend: "pi" as const },
      { id: "anthropic/claude-haiku-4-5-20260115", label: "Haiku", backend: "pi" as const },
      { id: "bedrock/claude-haiku-4-5-20251001", label: "Haiku", backend: "pi" as const },
      { id: "claude-opus-4-6", label: "Opus", backend: "pi" as const },
      { id: "claude-opus-4-6-20251001", label: "Opus", backend: "pi" as const },
    ];
    const { container, unmount } = render1(agent("a", { model: mixed[0].id }), true, mixed);
    const select = container.querySelector(".ap-model:not(.ap-effort)") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "haiku 4.5 (anthropic, 20251001)",
      "haiku 4.5 (anthropic, 20260115)",
      "haiku 4.5 (bedrock, 20251001)",
      "opus 4.6",
      "opus 4.6 (20251001)",
    ]);
    unmount();
  });

  it("keeps model and effort independently visible when only one is switchable", () => {
    const id = "anthropic/claude-opus-5-5";
    const effortLevels = ["low", "high"];
    const single = render1(agent("a", { model: id, effort: "high", effortLevels }), true, [
      { id, label: "Opus 5.5", backend: "pi", effortLevels },
    ]);
    expect(single.container.querySelector(".ap-meta-model")!.textContent).toBe("opus 5.5");
    expect(single.container.querySelector(".ap-effort")).not.toBeNull();
    single.unmount();

    const modelOnly = render1(agent("a", { model: "cursor/composer-2.5", effort: "high" }));
    expect(modelOnly.container.querySelector(".ap-meta-effort")!.textContent).toBe(" · high");
  });

  it("excludes unauthenticated native Codex models, preserves Pi openai-codex/*, and opens setup on selection", () => {
    const onSetModel = vi.fn();
    const onOpenCodexSetup = vi.fn();
    const mixedModels: ModelOption[] = [
      { id: "claude-opus-5-5", label: "Opus 5.5", backend: "pi" },
      { id: "openai-codex/gpt-5.4", label: "GPT-5.4", backend: "pi" },
      { id: "gpt-6-astra", label: "GPT-6 Astra", backend: "codex" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", backend: "codex" },
    ];
    const unauth: CodexAuthState = {
      cliAvailable: true,
      authenticated: false,
      status: "unauthenticated",
      accountType: null,
      checkedAt: 1,
    };
    const baseActions = agentsActions({ onSetModel });

    // Empty session with backend switching enabled hides native codex models, keeps Pi openai-codex/*,
    // shows italic Codex (not signed in) entry, and invokes onOpenCodexSetup instead of onSetModel.
    const empty = renderAgents(
      [ws("s", { agents: [agent("a", { model: "claude-opus-5-5", canSwitchBackend: true })] })],
      { models: mixedModels, codexAuth: unauth, onOpenCodexSetup, actions: baseActions },
    );
    const select = empty.container.querySelector(".ap-model:not(.ap-effort)") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "claude-opus-5-5",
      "openai-codex/gpt-5.4",
      CODEX_SETUP_VALUE,
    ]);
    expect(select.options[2].textContent).toBe("Codex (not signed in)");
    fireEvent.change(select, { target: { value: CODEX_SETUP_VALUE } });
    expect(onOpenCodexSetup).toHaveBeenCalledTimes(1);
    expect(onSetModel).not.toHaveBeenCalled();
    empty.unmount();

    // Even when only 1 Pi model exists, an empty session with unauthenticated Codex still exposes the setup entry.
    const singlePi = renderAgents(
      [
        ws("s2", {
          agents: [agent("b", { model: "openai-codex/gpt-5.4", canSwitchBackend: true })],
        }),
      ],
      {
        models: [mixedModels[1], mixedModels[2]],
        codexAuth: unauth,
        onOpenCodexSetup,
        actions: baseActions,
      },
    );
    const singleSelect = singlePi.container.querySelector(
      ".ap-model:not(.ap-effort)",
    ) as HTMLSelectElement;
    expect(singleSelect).not.toBeNull();
    expect([...singleSelect.options].map((o) => o.value)).toEqual([
      "openai-codex/gpt-5.4",
      CODEX_SETUP_VALUE,
    ]);
    singlePi.unmount();
  });
});
