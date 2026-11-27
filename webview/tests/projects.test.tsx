import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, renderHook, act } from "@testing-library/react";
import { groupWorkspaces } from "../src/sidebar/groups";
import { Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";
import { MessageItem, chipLabelFor } from "../src/chat/messages";
import { CreateWorkspaceDialog } from "../src/workspace/dialogs";
import { useServer, type Message, type Workspace } from "../src/state/useServer";
import { FakeSocket, initFrame, messagePage } from "./fakeSocket";
import { project as makeProject, workspace } from "./helpers/fixtures";
import { sidebarProps as makeSidebarProps } from "./helpers/sidebar";

const NOW = 1_800_000_000_000;

const ws = (id: string, over: Partial<Workspace> = {}) =>
  workspace(id, { git: null, pr: null, createdAt: NOW - 5000, lastMessageAt: NOW - 5000, ...over });
const project = makeProject("p1", { name: "clice", root: "/repo/clice", createdAt: NOW - 10_000 });

const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo/clice",
  projectLink: { projectId: "p1", role: "lead" },
  lastMessageAt: NOW - 4000,
});
const worker = ws("w1", {
  name: "modules",
  cwd: "/wt/clice-modules",
  projectLink: { projectId: "p1", role: "worker" },
  lastMessageAt: NOW - 1000,
});

describe("project groups", () => {
  it("fold a project's sessions under it wherever they work, lead first, projects on top", () => {
    const groups = groupWorkspaces([ws("other", { lastMessageAt: NOW }), worker, lead], [project]);
    expect(groups.map((g) => g.label)).toEqual(["clice", "repo"]);
    expect(groups[0].project).toBe(project);
    expect(groups[0].workspaces.map((w) => w.id)).toEqual(["lead", "w1"]);
  });

  const sidebarProps = () =>
    makeSidebarProps(
      {
        workspaces: [lead, worker],
        projects: [project],
        activeWsId: "lead",
        now: NOW,
        onDeleteProject: vi.fn(),
      },
      () => vi.fn(),
    );

  it("starts a new session in the project root without opening the lead", () => {
    const props = sidebarProps();
    const { getByTitle } = render(<Sidebar {...props} />);
    fireEvent.click(getByTitle("New session in clice"));
    expect(props.onCreateIn).toHaveBeenCalledWith("/repo/clice");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("keep a project's row short: a count only when folded, no board, no changed-files dot, the branch only off main", () => {
    const git = (branch: string, dirty: number) => ({ branch, dirty, ahead: 0, behind: 0 });
    const props = sidebarProps();
    const { container, rerender } = render(
      <Sidebar {...props} groupOverrides={{ "project:p1": false }} />,
    );
    const header = () => container.querySelector(".ws-group-project")!;
    expect(header().querySelector(".ws-group-count")!.textContent).toBe("1");
    // The board opens from the chat header of any of its sessions.
    expect(header().querySelector('[title^="Objectives"]')).toBeNull();
    const branch = (b: string, dirty: number) => {
      rerender(<Sidebar {...props} workspaces={[{ ...lead, git: git(b, dirty) }, worker]} />);
      return header().querySelector(".ws-group-branch")?.textContent ?? null;
    };
    expect(branch("main", 0)).toBeNull();
    expect(branch("master", 0)).toBeNull();
    // Changed files are no mark on the row (the header and the changes panel
    // tell them); a branch off main is.
    expect(branch("main", 2)).toBeNull();
    expect(branch("feat/x", 2)).toBe("feat/x");
    // On touch, only the open session's project offers a new session.
    expect(header().className).toContain("current");
    rerender(<Sidebar {...props} activeWsId={null} />);
    expect(header().className).not.toContain("current");
  });

  it("offer no arrow while the lead has no sessions under it", () => {
    const props = { ...sidebarProps(), workspaces: [lead] };
    const { container, queryByLabelText } = render(<Sidebar {...props} />);
    expect(queryByLabelText("Fold clice")).toBeNull();
    expect(container.querySelector(".ws-group-project .events-toggle")!.textContent).toBe("");
  });

  it("shows an authoritative user wait even when the session is open or a dialog holds an active turn", () => {
    const waiting = { ...worker, awaitsUser: true };
    const working = {
      ...waiting,
      agents: [{ id: "a", name: "A", model: "m", avatar: "", color: "#fff", isDefault: true }].map(
        (a) => ({ ...a, busy: true, state: "working" as const }),
      ),
    };
    const tag = (w: Workspace, activeWsId = "lead") =>
      render(
        <Sidebar {...sidebarProps()} workspaces={[lead, w]} activeWsId={activeWsId} />,
      ).container.querySelector(".task-item .awaits-tag");
    expect(tag(waiting)?.textContent).toBe("Your turn");
    expect(tag(worker)).toBeNull();
    expect(tag(working)?.textContent).toBe("Your turn");
    expect(tag(waiting, "w1")?.textContent).toBe("Your turn");
  });

  it("includes the lead's unread result in the project summary", () => {
    const props = {
      ...sidebarProps(),
      activeWsId: "w1",
      workspaces: [{ ...lead, unread: 2 }, worker],
    };
    const { container } = render(<Sidebar {...props} />);
    const header = container.querySelector(".ws-group-project")!;
    expect(header.className).not.toContain("active");
    expect(header.querySelector(".ws-group-attention")!.textContent).toBe("1 unread");
  });

  it("summarizes lead and worker attention on a collapsed row without expanding it", () => {
    const active = ws("w3", {
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
    });
    const props = {
      ...sidebarProps(),
      activeWsId: active.id,
      groupOverrides: { "project:p1": false },
      workspaces: [
        { ...lead, unread: 2 },
        { ...worker, awaitsUser: true, unread: 8 },
        ws("w2", { projectLink: { projectId: "p1", role: "worker" }, unread: 3 }),
        active,
      ],
    };
    const { container, getByRole } = render(<Sidebar {...props} />);
    const header = container.querySelector(".ws-group-project")!;
    const summary = getByRole("status", { name: "clice: 2 need you · 2 unread" });
    expect(summary.textContent).toBe("2 need you · 2 unread");
    expect(header.querySelector(".ws-group-count")).toBeNull();
    expect(container.querySelector(".ws-group-items")).toBeNull();
    expect(props.onToggleGroup).not.toHaveBeenCalled();
  });

  it("fold from anywhere on the row when the lead is gone", () => {
    const props = { ...sidebarProps(), workspaces: [worker], activeWsId: "w1" };
    const { container } = render(<Sidebar {...props} />);
    fireEvent.click(container.querySelector(".ws-group-project")!);
    expect(props.onToggleGroup).toHaveBeenCalledWith("project:p1", false);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});

describe("messages from the project", () => {
  const msg = (from: Message["from"]): Message => ({
    id: "m",
    kind: "user",
    agentId: null,
    content: "fix it",
    timestamp: NOW,
    status: "done",
    from,
  });

  it("name the lead as the sender and open it on click", () => {
    const onOpen = vi.fn();
    const { getByText, queryByText } = render(
      <MessageItem
        msg={msg({ workspaceId: "lead", name: "lead", role: "lead" })}
        agents={[]}
        onOpenWorkspace={onOpen}
      />,
    );
    expect(queryByText("You")).toBeNull();
    fireEvent.click(getByText("Lead"));
    expect(onOpen).toHaveBeenCalledWith("lead");
  });

  it("name another project's lead by its project", () => {
    const { getByText } = render(
      <MessageItem
        msg={msg({ workspaceId: "ws-x", name: "clangd", role: "peer", projectId: "p2" })}
        agents={[]}
      />,
    );
    expect(getByText("clangd · lead")).toBeTruthy();
  });

  it("name a worker session by its title", () => {
    const { getByText } = render(
      <MessageItem msg={msg({ workspaceId: "w1", name: "modules", role: "worker" })} agents={[]} />,
    );
    expect(getByText("modules").className).toContain("from-author");
  });

  it("name the panel's word about a worker apart from the worker, and open the worker", () => {
    const onOpen = vi.fn();
    const { getByText, container } = render(
      <MessageItem
        msg={msg({ workspaceId: "w1", name: "modules", role: "panel" })}
        agents={[]}
        onOpenWorkspace={onOpen}
      />,
    );
    expect(container.querySelector(".avatar-from")!.textContent).toBe("▣");
    fireEvent.click(getByText("Panel · modules"));
    expect(onOpen).toHaveBeenCalledWith("w1");
  });
});

describe("panel tools in the steps", () => {
  it("read as their own names; other MCP tools keep their server", () => {
    expect(chipLabelFor("mcp__panel__start_session")).toBe("start_session");
    expect(chipLabelFor("mcp__github__get_issue")).toBe("github · get_issue");
    expect(chipLabelFor("Bash")).toBe("Bash");
  });
});

describe("project frames", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("unlink sessions and drop a deleted project, keeping loaded history", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances.at(-1)!;
    const history: Message = {
      id: "m",
      kind: "user",
      agentId: null,
      content: "hi",
      timestamp: NOW,
      status: "done",
    };
    act(() => {
      ws.open();
      ws.receive(initFrame([lead, worker], { projects: [project] }));
      ws.receive(messagePage("w1", [history]));
    });
    expect(result.current.projects).toEqual([project]);

    act(() => {
      ws.receive({ type: "workspace_updated", workspace: { ...worker, projectLink: undefined } });
      ws.receive({ type: "project_deleted", projectId: "p1" });
    });
    const w1 = result.current.workspaces.find((w) => w.id === "w1")!;
    expect(w1.projectLink).toBeUndefined();
    expect(w1.messages).toEqual([history]);
    expect(result.current.projects).toEqual([]);
  });

  it("send project management requests", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances.at(-1)!;
    act(() => ws.open());
    result.current.renameProject("p1", "clice 2");
    result.current.deleteProject("p1");
    expect(ws.frames()).toEqual([
      { type: "refresh_quota", force: false },
      { type: "rename_project", projectId: "p1", name: "clice 2" },
      { type: "delete_project", projectId: "p1" },
    ]);
  });
});

describe("CreateWorkspaceDialog", () => {
  it("makes a workspace: every folder is a project, so there is no project option", () => {
    const onCreate = vi.fn();
    const { getByPlaceholderText, getByText, queryByRole } = render(
      <CreateWorkspaceDialog
        hosts={[]}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "", dirs: [] }}
      />,
    );
    fireEvent.change(getByPlaceholderText("~/workspace/..."), {
      target: { value: "/repo/clice" },
    });
    expect(queryByRole("checkbox")).toBeNull();
    fireEvent.click(getByText("Create session"));
    expect(onCreate).toHaveBeenCalledWith("clice", "/repo/clice", "local", undefined);
  });

  it("closes on Escape, the path's suggestions first", () => {
    const onClose = vi.fn();
    const { getByPlaceholderText, baseElement } = render(
      <CreateWorkspaceDialog
        hosts={[]}
        onClose={onClose}
        onCreate={() => {}}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "/repo/", dirs: ["/repo/clice/", "/repo/other/"] }}
      />,
    );
    fireEvent.change(getByPlaceholderText("~/workspace/..."), { target: { value: "/repo/" } });
    expect(baseElement.querySelector(".dir-suggest")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(baseElement.querySelector(".dir-suggest")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("archives in the sidebar", () => {
  const archived = (id: string, over: Partial<Workspace> = {}) =>
    ws(id, {
      name: id,
      cwd: "/repo/clice",
      projectLink: { projectId: "p1", role: "worker" },
      archivedAt: NOW - 1000,
      lastMessageAt: NOW - 2000,
      ...over,
    });
  const props = (over: Partial<SidebarProps> = {}) =>
    makeSidebarProps(
      {
        workspaces: [
          lead,
          worker,
          archived("old-a"),
          archived("old-b", { cwd: "/wt/clice-x" }),
          archived("old-c", { cwd: "/repo/clice-wt-1" }),
        ],
        projects: [project],
        activeWsId: "lead",
        now: NOW,
        onRestoreProject: vi.fn(),
        onDeleteProject: vi.fn(),
        ...over,
      },
      () => vi.fn(),
    );
  const names = (c: HTMLElement) =>
    [...c.querySelectorAll(".task-item .task-name-text")].map((e) => e.textContent);

  it("fold a project's archived sessions under it, and clear only those", () => {
    const p = props();
    const { container, getByTitle } = render(<Sidebar {...p} />);
    expect(names(container)).toEqual(["modules"]);
    expect(container.querySelector(".ws-archived")).toBeNull();
    const toggle = container.querySelector(".ws-archive-toggle")!;
    // Folded, the row is just its name: the count and Clear come with the list.
    expect(toggle.textContent).toBe("▸Archived");
    fireEvent.click(toggle);
    expect(toggle.querySelector(".ws-group-count")!.textContent).toBe("3");
    expect(names(container)).toEqual(["modules", "old-a", "old-b", "old-c"]);
    // Only a genuinely external folder repeats its basename. Project worktrees
    // keep their full cwd on the row tooltip without a redundant second line.
    expect(
      [...container.querySelectorAll(".task-item-archived .task-meta")].map((e) => e.textContent),
    ).toEqual(["clice-x"]);
    const worktree = [...container.querySelectorAll<HTMLElement>(".task-item-archived")].find(
      (row) => row.textContent?.includes("old-c"),
    )!;
    expect(worktree.title).toBe("/repo/clice-wt-1");
    expect(worktree.querySelector(".task-meta")).toBeNull();
    fireEvent.click(getByTitle("Delete the archived sessions of clice"));
    expect(p.onPurgeArchived).toHaveBeenCalledWith("p1");
  });

  it("open the archive that holds the open session", () => {
    const { container } = render(<Sidebar {...props({ activeWsId: "old-a" })} />);
    expect(names(container)).toContain("old-a");
  });

  it("open an archived project's lead from its row, and list it nowhere else", () => {
    const shelved = { ...project, archivedAt: NOW - 10 };
    const p = props({
      workspaces: [{ ...lead, archivedAt: NOW - 10 }, archived("old-a")],
      projects: [shelved],
    });
    const { container } = render(<Sidebar {...p} />);
    fireEvent.click(container.querySelector(".ws-shelf .ws-archived-header")!);
    const row = container.querySelector(".ws-group-project")!;
    expect(row.querySelector(".ws-group-label")!.textContent).toBe("clice");
    fireEvent.click(row);
    expect(p.onSelect).toHaveBeenCalledWith("lead");
    fireEvent.click(container.querySelector(".ws-archive-toggle")!);
    expect(
      [...container.querySelectorAll(".task-item-archived .task-name-text")].map(
        (e) => e.textContent,
      ),
    ).toEqual(["old-a"]);
  });

  it("rename a project from its row on a double click", () => {
    const p = props({ onRenameProject: vi.fn() });
    const { container, getByLabelText, queryByLabelText } = render(<Sidebar {...p} />);
    const label = () => container.querySelector(".ws-group-project .ws-group-label")!;
    fireEvent.doubleClick(label());
    fireEvent.keyDown(getByLabelText("Project name"), { key: "Escape" });
    expect(queryByLabelText("Project name")).toBeNull();
    fireEvent.doubleClick(label());
    const input = getByLabelText("Project name");
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: " clice next " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onRenameProject).toHaveBeenCalledTimes(1);
    expect(p.onRenameProject).toHaveBeenCalledWith("p1", "clice next");
    // Editing the name opens nothing.
    expect(p.onSelect).toHaveBeenCalledTimes(0);
  });

  it("archive a live project from its row; an archived one offers Restore instead", () => {
    const shelved = { ...project, id: "p2", name: "clice2", root: "/repo/clice2", archivedAt: 1 };
    const lead2 = ws("lead2", {
      cwd: "/repo/clice2",
      projectLink: { projectId: "p2", role: "lead" },
    });
    const p = props({
      workspaces: [lead, worker, { ...lead2, archivedAt: 1 }],
      projects: [project, shelved],
      onArchiveProject: vi.fn(),
    });
    const { container, getByTitle, queryByTitle } = render(<Sidebar {...p} />);
    fireEvent.click(getByTitle("Archive clice with its sessions"));
    expect(p.onArchiveProject).toHaveBeenCalledWith("p1");
    // The row's own click (opening the lead) is not taken too.
    expect(p.onSelect).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".ws-shelf .ws-archived-header")!);
    expect(queryByTitle("Archive clice2 with its sessions")).toBeNull();
    expect(getByTitle("Bring clice2 back among the projects")).toBeTruthy();
  });
});
