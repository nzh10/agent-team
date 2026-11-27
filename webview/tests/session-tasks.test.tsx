import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, within, act, cleanup } from "@testing-library/react";
import { workCount } from "../src/panels/SessionTasks";
import type { AgentInfo, Workspace } from "../src/state/useServer";
import { agentsActions as actions, renderAgents } from "./helpers/agentsPanel";
import { agent as makeAgent, workspace } from "./helpers/fixtures";
import { bootProjectApp, stubAppSocket } from "./helpers/projectApp";

const NOW = 1_800_000_000_000;
const agent = (id: string, over: Partial<AgentInfo> = {}) =>
  makeAgent(id, { name: id, color: "#fff", ...over });
const ws = (id: string, agents: AgentInfo[]) =>
  workspace(id, {
    cwd: `/w/${id}`,
    git: null,
    pr: null,
    agents,
    createdAt: NOW - 1000,
    lastMessageAt: NOW - 1000,
  });

const busy = ws("indexer", [
  agent("kisara", {
    state: "waiting",
    backgroundTasks: [
      { id: "b1", type: "local_bash", description: "npm run build", since: NOW - 95_000 },
      { id: "a1", type: "local_agent", description: "Profile the indexer", since: NOW - 5_000 },
    ],
  }),
  agent("isla", {
    state: "sleeping",
    wake: { at: NOW + 12 * 60_000, reason: "check the CI run" },
  }),
  agent("alice"),
]);
const quiet = ws("docs", [agent("bob")]);

const panel = (sessions: Workspace[], a = actions(), overview = false) =>
  renderAgents(sessions, { actions: a, overview }).container;

describe("a session's background work, in its card", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("is listed by agent, with its age or its time", () => {
    const container = panel([busy]);
    const rows = [...container.querySelectorAll(".tp-task")].map((r) =>
      [...r.querySelectorAll(".tp-type, .tp-desc, .tp-when")].map((e) => e.textContent),
    );
    const at = new Date(NOW + 12 * 60_000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(rows).toEqual([
      ["shell", "npm run build", "1m 35s"],
      ["agent", "Profile the indexer", "5s"],
      ["wake-up", "check the CI run", `${at} · in 12m`],
    ]);
    // Each agent's under its own row, not under a name of its own again.
    expect(
      [...container.querySelectorAll(".tp-tasks")].map(
        (t) => t.previousElementSibling!.querySelector(".ap-agent-name")!.textContent,
      ),
    ).toEqual(["kisara", "isla"]);
    expect(workCount([busy, quiet])).toBe(3);
    // A quiet session has none to list.
    expect(panel([quiet]).querySelector(".tp-tasks")).toBeNull();
  });

  it("counts queued tasks without showing elapsed time or including settled children", () => {
    const card = ws("work", [
      agent("a", {
        backgroundTasks: [
          {
            id: "q",
            type: "local_agent",
            description: "Queued child",
            status: "queued",
            since: NOW - 1000,
          },
          {
            id: "p",
            type: "local_agent",
            description: "Paused child",
            status: "paused",
            since: NOW - 1000,
          },
        ],
      }),
    ]);
    const container = panel([card]);
    expect(workCount([card])).toBe(1);
    expect(container.querySelectorAll(".tp-task")).toHaveLength(1);
    expect(container.querySelector(".tp-when")?.textContent).toBe("Queued");
    expect(within(container).getByRole("button", { name: "Stop Queued child" })).toBeTruthy();
  });

  it("hides the stop button for a task that cannot be cancelled", () => {
    const card = ws("readonly", [
      agent("a", {
        state: "waiting",
        backgroundTasks: [
          {
            id: "foreground",
            type: "local_agent",
            description: "foreground child",
            since: NOW,
            cancellable: false,
          },
        ],
      }),
    ]);
    expect(panel([card]).querySelector(".tp-stop")).toBeNull();
  });

  it("shows a wake-up past its time as due until it fires", () => {
    const late = ws("late", [
      agent("isla", { state: "sleeping", wake: { at: NOW - 30_000, reason: "check the CI run" } }),
    ]);
    const at = new Date(NOW - 30_000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(panel([late]).querySelector(".tp-wake .tp-when")!.textContent).toBe(`${at} · due`);
  });

  it("stops one task, cancels a wake-up, or stops everything of the session", () => {
    const a = actions();
    const card = within(panel([busy], a));
    fireEvent.click(card.getByLabelText("Stop npm run build"));
    fireEvent.click(card.getByText("Cancel"));
    fireEvent.click(card.getByText("Stop everything"));
    expect(a.onStopTask).toHaveBeenCalledWith("indexer", "kisara", "b1");
    expect(a.onCancelWake).toHaveBeenCalledWith("indexer", "isla");
    expect(a.onStopAll).toHaveBeenCalledWith("indexer");
  });

  it("shows in a folded card as how much runs and when it wakes", () => {
    const container = panel([busy, quiet], actions(), true);
    const tag = (id: string) =>
      container.querySelector(`[aria-label="${id}"] .ap-brief-tasks`)?.textContent ?? null;
    expect(tag("indexer")).toBe("2 in background · wake in 12m");
    expect(tag("docs")).toBeNull();
    expect(container.querySelector(".tp-tasks")).toBeNull();
  });
});

describe("Stop in the app", () => {
  beforeEach(stubAppSocket);
  afterEach(() => vi.unstubAllGlobals());

  const boot = (workspaces: Workspace[]) => bootProjectApp(workspaces, [], workspaces[0].id).sock;

  it("stops only the turn of a working agent", () => {
    const sock = boot([ws("w", [agent("a"), agent("b", { isDefault: false, state: "working" })])]);
    const row = within(document.querySelector<HTMLElement>(".input-row")!);
    expect(row.queryByRole("group")).toBeNull();
    fireEvent.click(row.getByRole("button", { name: "Stop b" }));
    expect(sock.frames().filter((f) => f.type === "interrupt" || f.type === "abort")).toEqual([
      { type: "interrupt", workspaceId: "w", agentId: "b" },
    ]);
  });

  it.each(["waiting", "sleeping"] as const)(
    "offers Stop as soon as a prompt opens from %s",
    (state) => {
      const sock = boot([ws("w", [agent("a", { state, busy: false })])]);
      const row = within(document.querySelector<HTMLElement>(".input-row")!);
      expect(row.queryByRole("button", { name: "Stop a" })).toBeNull();
      act(() =>
        sock.receive({ type: "agent_busy", workspaceId: "w", agentId: "a", streamAt: Date.now() }),
      );
      fireEvent.click(row.getByRole("button", { name: "Stop a" }));
      expect(sock.frames()).toContainEqual({ type: "interrupt", workspaceId: "w", agentId: "a" });
    },
  );

  it("lists only working agents, including a legacy busy agent, and stops the chosen turns", () => {
    const sock = boot([
      ws("w", [
        agent("a", { state: "working", busy: false }),
        agent("b", { busy: true }),
        agent("waiting", { state: "waiting", busy: true }),
        agent("sleeping", { state: "sleeping", busy: true }),
      ]),
    ]);
    const row = within(document.querySelector<HTMLElement>(".input-row")!);
    const toggle = row.getByRole("button", { name: "Stop running agents (2)" });
    expect(row.queryByRole("button", { name: "Queue" })).toBeNull();
    fireEvent.change(row.getByRole("textbox"), { target: { value: "next turn" } });
    expect(row.getByRole<HTMLButtonElement>("button", { name: "Queue" }).disabled).toBe(false);

    fireEvent.click(toggle);
    const group = () => within(row.getByRole("group", { name: "Stop running turns" }));
    expect(
      group()
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Stop a", "Stop b", "Stop all (2)"]);
    fireEvent.click(group().getByRole("button", { name: "Stop b" }));
    expect(row.queryByRole("group")).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(group().getByRole("button", { name: "Stop all (2)" }));
    expect(sock.frames().filter((f) => f.type === "interrupt" || f.type === "abort")).toEqual([
      { type: "interrupt", workspaceId: "w", agentId: "b" },
      { type: "interrupt", workspaceId: "w", agentId: "a" },
      { type: "interrupt", workspaceId: "w", agentId: "b" },
    ]);
  });

  it("delays hover opening and cancels a brief pass over the stop control", () => {
    boot([ws("w", [agent("a", { busy: true }), agent("b", { busy: true })])]);
    const row = within(document.querySelector<HTMLElement>(".input-row")!);
    const toggle = row.getByRole("button", { name: "Stop running agents (2)" });
    const mouse = (type: string) =>
      fireEvent(toggle, new PointerEvent(type, { pointerType: "mouse", bubbles: true }));
    const advance = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    const expanded = () => toggle.getAttribute("aria-expanded");
    // jsdom does not implement matchMedia. Without it this is click-only.
    mouse("pointerover");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    vi.useFakeTimers();
    try {
      mouse("pointerover");
      advance(100);
      expect(expanded()).toBe("false");
      mouse("pointerout");
      advance(150);
      expect(expanded()).toBe("false");
      mouse("pointerover");
      advance(150);
      expect(expanded()).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports keyboard navigation and restores trigger focus on Escape", () => {
    const sock = boot([ws("w", [agent("a", { busy: true }), agent("b", { busy: true })])]);
    const row = within(document.querySelector<HTMLElement>(".input-row")!);
    const toggle = row.getByRole("button", { name: "Stop running agents (2)" });
    fireEvent.click(toggle);
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row.getByRole("button", { name: "Stop a" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(row.getByRole("button", { name: "Stop all (2)" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(row.queryByRole("group")).toBeNull();
    expect(sock.frames().some((f) => f.type === "interrupt")).toBe(false);

    fireEvent.click(toggle);
    act(() => row.getByRole("textbox").focus());
    expect(row.queryByRole("group")).toBeNull();

    act(() => sock.receive({ type: "agent_state", workspaceId: "w", agentId: "a", state: "idle" }));
    expect(row.getByRole("button", { name: "Stop b" })).toBeTruthy();
    expect(row.queryByRole("button", { name: "Stop running agents (2)" })).toBeNull();
  });

  it("leaves an agent that only waits on background work to its card's own stops", () => {
    const waiting = agent("a", {
      state: "waiting",
      backgroundTasks: [{ id: "b1", type: "local_bash", description: "sleep", since: NOW }],
    });
    const sock = boot([ws("w", [waiting])]);
    expect(document.querySelector(".btn-abort")).toBeNull();
    // The agents button counts it.
    const agents = document.querySelector('.side-rail [aria-label="Agents and sessions"]')!;
    expect(agents.textContent).toBe("1");
    fireEvent.click(agents);
    fireEvent.click(within(document.querySelector(".tp-tasks") as HTMLElement).getByText("Stop"));
    expect(sock.frames().at(-1)).toEqual({
      type: "cancel_subagent",
      workspaceId: "w",
      agentId: "a",
      taskId: "b1",
    });
  });
});

describe("cancelling a wake-up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  const wake = { at: NOW + 60_000, reason: "check CI" };
  const cancels = (a: AgentInfo) => {
    const container = panel([ws("w", [a])]);
    const tasks = container.querySelector(".tp-tasks") as HTMLElement;
    const offered = within(tasks).queryByRole("button", { name: "Cancel" }) !== null;
    cleanup();
    return offered;
  };

  it("is offered only when closing the process takes nothing else with it", () => {
    expect(cancels(agent("a", { state: "sleeping", wake }))).toBe(true);
    expect(cancels(agent("a", { state: "working", busy: true, wake }))).toBe(false);
    expect(
      cancels(
        agent("a", {
          state: "waiting",
          wake,
          backgroundTasks: [{ id: "b1", type: "local_bash", description: "sleep", since: NOW }],
        }),
      ),
    ).toBe(false);
  });
});
