import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDED_IDLE_STORAGE_KEY, Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";
import { IDLE_FOLD_MS } from "../src/sidebar/groups";
import { SILENCE_MS, StreamSilence } from "../src/sidebar/StreamSilence";
import type { Project, Workspace } from "../src/state/useServer";
import { agent, project as makeProject, workspace } from "./helpers/fixtures";
import { sidebarProps } from "./helpers/sidebar";

const NOW = 1_800_000_000_000;
const baseAgent = agent("a1", { model: "model" });
const ws = (id: string, over: Partial<Workspace> = {}) =>
  workspace(id, {
    agents: [baseAgent],
    createdAt: NOW - 1000,
    lastMessageAt: NOW - 1000,
    git: null,
    pr: null,
    ...over,
  });

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("StreamSilence", () => {
  it("stays quiet before 120s (showing Queued if queued), switches to Quiet at 120s without 1Hz churn, and refreshes title on pointerEnter", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(SILENCE_MS).toBe(120_000);

    let renders = 0;
    function Spy({ workspace }: { workspace: Workspace }) {
      renders += 1;
      return <StreamSilence workspace={workspace} />;
    }

    const busyQueued = ws("w1", {
      queued: true,
      agents: [{ ...baseAgent, busy: true, lastStreamAt: NOW - 60_000 }],
    });
    const { container } = render(<Spy workspace={busyQueued} />);
    expect(container.textContent).toBe("Queued");

    // 59s later (119s elapsed): still Queued, not Quiet.
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(container.textContent).toBe("Queued");

    // 1s later (120s elapsed): crosses SILENCE_MS -> renders fixed Quiet with factual detail in title.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    const badge = container.querySelector(".session-silence")!;
    expect(badge.textContent).toBe("Quiet");
    expect(badge.getAttribute("title")).toBe("No new events for 120s");
    expect(badge.getAttribute("aria-label")).toBe("Quiet: No new events for 120s");

    // Zero 1Hz re-renders after crossing SILENCE_MS.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const rendersAtQuiet = renders;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(renders).toBe(rendersAtQuiet);
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    // Pointer enter refreshes the factual detail tooltip on demand.
    fireEvent.pointerEnter(badge);
    expect(badge.textContent).toBe("Quiet");
    expect(badge.getAttribute("title")).toBe("No new events for 150s");

    // Keyboard focus is reachable via tabIndex=0, refreshes elapsed detail,
    // exposes a visible role="tooltip", and dismisses on blur/Escape.
    expect(badge.getAttribute("tabindex")).toBe("0");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    fireEvent.focus(badge);
    const tip = container.querySelector('[role="tooltip"]')!;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toBe("No new events for 160s");
    expect(badge.getAttribute("aria-describedby")).toBe(tip.id);
    fireEvent.blur(badge);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("shows nothing before 120s when busy and not queued", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const busy = ws("w1", {
      agents: [{ ...baseAgent, busy: true, lastStreamAt: NOW - 90_000 }],
    });
    const { container } = render(<StreamSilence workspace={busy} />);
    expect(container.querySelector(".session-silence")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.querySelector(".session-silence")?.textContent).toBe("Quiet");
    expect(container.querySelector(".session-silence")?.getAttribute("title")).toBe(
      "No new events for 120s",
    );
  });
});

describe("Sidebar idle disclosure and worker archive action", () => {
  const project = makeProject("p1", { name: "agent-team", createdAt: NOW - 5000 });

  const baseProps = (over: Partial<SidebarProps> = {}) =>
    sidebarProps(
      {
        workspaces: [
          ws("lead", { projectLink: { projectId: "p1", role: "lead" } }),
          ws("done-worker", {
            name: "Done Worker",
            lastResult: "done",
            projectLink: { projectId: "p1", role: "worker" },
          }),
          ws("idle-worker", {
            name: "Idle Worker",
            projectLink: { projectId: "p1", role: "worker" },
          }),
        ],
        projects: [project],
        activeWsId: "lead",
        now: NOW,
        onArchiveWorkspace: vi.fn(),
        onArchiveProject: vi.fn(),
        ...over,
      },
      () => vi.fn(),
    );

  it("renders ... (N) disclosure with sibling Fold (+M) (no nested buttons) and unfolds items below", () => {
    const props = baseProps();
    const { container, getByRole } = render(<Sidebar {...props} />);
    const toggle = getByRole("button", { name: "Show 1 folded session" });
    const fold = getByRole("button", { name: "Fold (+1)" });
    expect(toggle.textContent).toContain("... (1)");

    // No nested <button> inside <button>.
    expect(toggle.querySelector("button")).toBeNull();
    expect(fold.closest("button")).toBe(fold);
    expect(toggle.closest(".ws-idle-row")).toBe(fold.closest(".ws-idle-row"));
    expect(container.querySelectorAll(".ws-idle-row")).toHaveLength(1);
    expect(container.textContent).not.toContain("Idle / Done");

    // Unfolding renders Done Worker below the ... (1) row in DOM order.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = container.querySelector(".ws-group-items")!;
    const children = [...items.children];
    const idleRowIdx = children.indexOf(toggle.closest(".ws-idle-row")!);
    const doneRow = [...items.querySelectorAll(".task-item")].find((el) =>
      el.textContent?.includes("Done Worker"),
    )!;
    const doneRowIdx = children.indexOf(doneRow);
    expect(doneRowIdx).toBeGreaterThan(idleRowIdx);

    // Clicking Fold (+1) folds the visible idle worker without toggling the disclosure open.
    fireEvent.click(fold);
    expect(
      getByRole("button", { name: "Show 2 folded sessions" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(container.querySelector(".ws-idle-fold")).toBeNull();
  });

  it("persists a manual fold across a fresh mount and prunes it when promoted", () => {
    const props = baseProps({
      workspaces: [
        ws("lead", { projectLink: { projectId: "p1", role: "lead" } }),
        ws("idle-worker", {
          name: "Idle Worker",
          projectLink: { projectId: "p1", role: "worker" },
        }),
      ],
    });
    const first = render(<Sidebar {...props} />);
    fireEvent.click(first.getByRole("button", { name: "Fold (1)" }));
    expect(first.getByRole("button", { name: "Show 1 folded session" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)!)).toEqual(["idle-worker"]);
    first.unmount();

    const second = render(<Sidebar {...props} />);
    expect(second.getByRole("button", { name: "Show 1 folded session" })).toBeTruthy();
    expect(second.queryByText("Idle Worker")).toBeNull();
    second.rerender(<Sidebar {...props} activeWsId="idle-worker" />);
    expect(second.getByText("Idle Worker")).toBeTruthy();
    expect(second.queryByRole("button", { name: "Show 1 folded session" })).toBeNull();
    expect(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)).toBeNull();
  });

  it("folds old quiet null-result workers on reload but leaves fresh ones visible", () => {
    const oldQuiet = ws("old-quiet", {
      name: "Old Quiet",
      createdAt: NOW - IDLE_FOLD_MS - 10_000,
      lastMessageAt: NOW - IDLE_FOLD_MS - 1,
      projectLink: { projectId: "p1", role: "worker" },
    });
    const fresh = ws("fresh", {
      name: "Fresh",
      projectLink: { projectId: "p1", role: "worker" },
    });
    const view = render(<Sidebar {...baseProps({ workspaces: [oldQuiet, fresh] })} />);
    expect(view.getByRole("button", { name: "Show 1 folded session" }).textContent).toContain(
      "... (1)",
    );
    expect(view.queryByText("Old Quiet")).toBeNull();
    expect(view.getByText("Fresh")).toBeTruthy();
  });

  it("prunes deleted, archived, and promoted manual IDs from durable storage", () => {
    localStorage.setItem(
      FOLDED_IDLE_STORAGE_KEY,
      JSON.stringify(["idle-worker", "deleted", "archived-worker", "active-worker"]),
    );
    const active = ws("active-worker", {
      projectLink: { projectId: "p1", role: "worker" },
    });
    const idle = ws("idle-worker", {
      projectLink: { projectId: "p1", role: "worker" },
    });
    const archived = ws("archived-worker", {
      archivedAt: NOW - 1,
      projectLink: { projectId: "p1", role: "worker" },
    });
    render(
      <Sidebar {...baseProps({ workspaces: [idle, active, archived], activeWsId: active.id })} />,
    );
    expect(JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)!)).toEqual(["idle-worker"]);
  });

  it("keeps storage before init and prunes it after an authoritative empty snapshot", () => {
    localStorage.setItem(FOLDED_IDLE_STORAGE_KEY, JSON.stringify(["deleted"]));
    const props = baseProps({ workspaces: [], snapshotReady: false });
    const view = render(<Sidebar {...props} />);
    expect(JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)!)).toEqual(["deleted"]);
    view.rerender(<Sidebar {...props} snapshotReady={true} />);
    expect(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)).toBeNull();
  });

  it("merges manual folds from two mounted clients instead of overwriting them", () => {
    const a = ws("idle-a", { projectLink: { projectId: "p1", role: "worker" } });
    const b = ws("idle-b", { projectLink: { projectId: "p1", role: "worker" } });
    const first = render(<Sidebar {...baseProps({ workspaces: [a, b], activeWsId: b.id })} />);
    const second = render(<Sidebar {...baseProps({ workspaces: [a, b], activeWsId: a.id })} />);
    fireEvent.click(first.container.querySelector(".ws-idle-toggle")!);
    fireEvent.click(second.container.querySelector(".ws-idle-toggle")!);
    expect(new Set(JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)!) as string[])).toEqual(
      new Set(["idle-a", "idle-b"]),
    );
  });

  it("offers Archive session only on eligible non-running, non-queued, non-archived, non-sealed worker rows", () => {
    const onArchiveWorkspace = vi.fn();
    const onSelect = vi.fn();
    const sealedProject: Project = {
      ...project,
      id: "p-sealed",
      name: "sealed-proj",
      leadWorkspaceId: "s-lead",
      status: "sealed",
    };
    const { container } = render(
      <Sidebar
        {...baseProps({
          projects: [project, sealedProject],
          workspaces: [
            ws("lead", { projectLink: { projectId: "p1", role: "lead" } }),
            ws("w-idle", { name: "W Idle", projectLink: { projectId: "p1", role: "worker" } }),
            ws("w-busy", {
              name: "W Busy",
              projectLink: { projectId: "p1", role: "worker" },
              agents: [{ ...baseAgent, busy: true }],
            }),
            ws("w-starting", {
              name: "W Starting",
              queued: false,
              projectLink: { projectId: "p1", role: "worker" },
              agents: [{ ...baseAgent, busy: true, state: "idle" }],
            }),
            ws("w-queued", {
              name: "W Queued",
              queued: true,
              projectLink: { projectId: "p1", role: "worker" },
            }),
            ws("w-archived", {
              name: "W Archived",
              archivedAt: NOW - 500,
              projectLink: { projectId: "p1", role: "worker" },
            }),
            ws("s-lead", { projectLink: { projectId: "p-sealed", role: "lead" } }),
            ws("w-sealed", {
              name: "W Sealed",
              projectLink: { projectId: "p-sealed", role: "worker" },
            }),
          ],
          onArchiveWorkspace,
          onSelect,
        })}
      />,
    );

    const findRow = (name: string) =>
      [...container.querySelectorAll(".task-item")].find((el) => el.textContent?.includes(name));

    const idleBtn = findRow("W Idle")!.querySelector<HTMLButtonElement>(".task-archive");
    expect(idleBtn).not.toBeNull();
    fireEvent.click(idleBtn!);
    expect(onArchiveWorkspace).toHaveBeenCalledWith("w-idle");
    expect(onSelect).not.toHaveBeenCalled();

    expect(findRow("W Busy")!.querySelector(".task-archive")).toBeNull();
    // agent_busy before agent_state (busy:true, state:"idle", queued:false) keeps running dot & hides Archive.
    expect(findRow("W Starting")!.querySelector(".task-status.running")).not.toBeNull();
    expect(findRow("W Starting")!.querySelector(".task-archive")).toBeNull();
    expect(findRow("W Queued")!.querySelector(".task-archive")).toBeNull();
    expect(findRow("W Sealed")!.querySelector(".task-archive")).toBeNull();

    // Open archived section and confirm archived rows do not offer Archive session.
    fireEvent.click(container.querySelector(".ws-archive-toggle")!);
    expect(findRow("W Archived")!.querySelector(".task-archive")).toBeNull();
  });
});
