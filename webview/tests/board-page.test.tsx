import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import { BoardPage, type SessionInfo } from "../src/project/BoardPage";
import { layout, reach, relations, stage, matches } from "../src/project/board";
import type { Objective } from "../src/state/useServer";
import { boardProject, boardProps, renderBoard } from "./helpers/board";
import { objective as o } from "./helpers/fixtures";

// A slice of a real board: prerequisites across areas, work in progress,
// things put off and dropped, open and settled decisions.
const objectives: Objective[] = [
  o("foundation/identity", {
    title: "Declaration identity",
    priority: "high",
    tasks: [
      { id: "t1", text: "entity hash", state: "done" },
      { id: "t2", text: "content closure", state: "doing", session: "w1" },
      { id: "t3", text: "old USR path", state: "dropped" },
    ],
    decisions: [{ id: "d1", question: "hash width?", outcome: "64 bits" }],
    sessions: ["w1"],
    context: "Half of the **index** uses it.",
  }),
  o("index/name-ranges", {
    title: "Multi-token name ranges",
    dependsOn: ["foundation/identity"],
    decisions: [{ id: "d1", question: "store ranges or recompute?" }],
  }),
  o("cli/refactor", {
    title: "Rename across the project",
    dependsOn: ["index/name-ranges", "foundation/identity", "cli/edits"],
  }),
  o("infra/lto", {
    title: "LTO build",
    status: "later",
    priority: "low",
    reason: "after the toolchain bump",
  }),
  o("infra/codec", { title: "Drop codec", status: "dropped", reason: "not worth it" }),
  o("foundation/paths", { title: "Canonical paths", status: "done" }),
];

const project = boardProject([
  ...objectives,
  { id: "infra/broken", error: "Unexpected character at row 2" },
]);

const sessions = new Map<string, SessionInfo>([["w1", { name: "identity", state: "working" }]]);

const page = (p = project) => renderBoard(p, { sessions });

describe("board relations", () => {
  it("know what blocks what, where each stands and how deep it sits", () => {
    const rel = relations(objectives);
    expect(rel.get("cli/refactor")).toEqual({
      blockedBy: ["index/name-ranges", "foundation/identity"],
      unblocks: [],
      dropped: [],
      missing: ["cli/edits"],
    });
    expect(rel.get("foundation/identity")!.unblocks).toEqual(["index/name-ranges", "cli/refactor"]);
    expect(stage(objectives[0], rel.get("foundation/identity")!)).toBe("in progress");
    expect(stage(objectives[1], rel.get("index/name-ranges")!)).toBe("blocked");
    expect(stage(objectives[3], rel.get("infra/lto")!)).toBeNull();
    expect(layout(objectives.slice(0, 3)).columns.map((c) => c.map((x) => x.id))).toEqual([
      ["foundation/identity"],
      ["index/name-ranges"],
      ["cli/refactor"],
    ]);
    expect([...reach(objectives, "cli/refactor", "up")].sort()).toEqual([
      "foundation/identity",
      "index/name-ranges",
    ]);
    expect([...reach(objectives, "foundation/identity", "down")].sort()).toEqual([
      "cli/refactor",
      "index/name-ranges",
    ]);
    expect(
      matches(objectives[0], {
        area: null,
        statuses: ["active"],
        search: "closure",
        archive: false,
      }),
    ).toBe(true);
  });

  it("lay out a hand-made cycle without hanging", () => {
    const loop = [o("a/x", { dependsOn: ["a/y"] }), o("a/y", { dependsOn: ["a/x"] })];
    expect(layout(loop).columns.flat()).toHaveLength(2);
  });
});

describe("BoardPage", () => {
  it("puts the state of each card on its face", () => {
    const { container } = page();
    const card = (title: string) =>
      [...container.querySelectorAll(".bp-card")].find(
        (c) => c.querySelector(".bp-card-title")!.textContent === title,
      )!;
    const identity = within(card("Declaration identity") as HTMLElement);
    expect(identity.getByText("in progress")).toBeTruthy();
    expect(identity.getByTitle("1 of 2 tasks done")).toBeTruthy();
    expect(identity.getByText("high")).toBeTruthy();
    expect(
      within(card("Multi-token name ranges") as HTMLElement).getByText("1 to decide"),
    ).toBeTruthy();
    expect(
      within(card("Rename across the project") as HTMLElement).getByText("blocked by 2"),
    ).toBeTruthy();
    expect(
      within(card("LTO build") as HTMLElement).getByText("after the toolchain bump"),
    ).toBeTruthy();
  });

  it("opens an objective in full and walks its dependencies", () => {
    const { getByText, container, onOpenSession, onAskLead } = page();
    fireEvent.click(getByText("Rename across the project"));
    const detail = () => within(container.querySelector(".bp-detail") as HTMLElement);
    expect(detail().getByRole("heading", { name: "Rename across the project" })).toBeTruthy();
    // Prerequisites: two blocking, one that is not an objective.
    const refs = [...container.querySelectorAll(".bp-detail .bp-ref")];
    expect(refs.map((r) => [r.textContent, r.className.includes("blocking")])).toEqual([
      ["Multi-token name ranges", true],
      ["Declaration identity", true],
      ["cli/edits", false],
    ]);
    fireEvent.click(detail().getByText("Declaration identity"));
    expect(detail().getByText("Tasks · 1/2")).toBeTruthy();
    expect(detail().getByText("Needed by")).toBeTruthy();
    expect(detail().getByText("hash width?")).toBeTruthy();
    expect(detail().getByText("64 bits")).toBeTruthy();
    expect(container.querySelector(".bp-detail strong")!.textContent).toBe("index");
    fireEvent.click(container.querySelector(".bp-detail .bp-session")!);
    expect(onOpenSession).toHaveBeenCalledWith("w1");
    fireEvent.click(detail().getByText("Ask the lead"));
    expect(onAskLead).toHaveBeenCalledWith("foundation/identity");
  });

  it("opens each objective at its top, its markdown styled like the chat's", () => {
    const { getByText, container } = page();
    fireEvent.click(getByText("Declaration identity"));
    const first = container.querySelector(".bp-detail")!;
    first.scrollTop = 180;
    expect(container.querySelector(".bp-detail .message-content.bp-md strong")!.textContent).toBe(
      "index",
    );
    // A click focuses the link, as a browser does.
    const link = within(first as HTMLElement)
      .getByText("Rename across the project")
      .closest("button")!;
    link.focus();
    fireEvent.click(link);
    const next = container.querySelector(".bp-detail")!;
    expect(next).not.toBe(first);
    expect(next.scrollTop).toBe(0);
    // The link that had focus went with the old details: the new ones take it.
    expect(document.activeElement).toBe(next);
  });

  it("writes the markdown of titles, goals, tasks and decisions out instead of its marks", () => {
    const md = o("cli/graph", {
      title: "Split `TaskGraph`",
      goal: "One **round** state",
      tasks: [{ id: "t1", text: "merge `join_node`\nand `request`", state: "todo" }],
      decisions: [{ id: "d1", question: "keep `round`?", outcome: "**no**" }],
    });
    const { getByText, container } = page({ ...project, objectives: [md] });
    const card = container.querySelector(".bp-card")!;
    expect(card.querySelector(".bp-card-title code")!.textContent).toBe("TaskGraph");
    expect(card.querySelector(".bp-card-goal strong")!.textContent).toBe("round");
    fireEvent.click(getByText("TaskGraph"));
    const detail = container.querySelector(".bp-detail")!;
    expect(detail.querySelector(".bp-detail-title")!.textContent).toBe("Split TaskGraph");
    const task = detail.querySelector(".bp-task-text")!;
    expect(task.textContent).toBe("merge join_node and request");
    expect(task.querySelectorAll("code")).toHaveLength(2);
    expect(detail.querySelector(".bp-question code")!.textContent).toBe("round");
    expect(detail.querySelector(".bp-outcome strong")!.textContent).toBe("no");
  });

  it("draws the dependency graph in columns with an edge per prerequisite", () => {
    const { getByRole, container } = page();
    fireEvent.click(getByRole("button", { name: "Dependencies" }));
    const columns = [...container.querySelectorAll(".bp-column")].map((c) =>
      [...c.querySelectorAll(".bp-node-title")].map((n) => n.textContent),
    );
    expect(columns).toEqual([
      ["Declaration identity"],
      ["Multi-token name ranges"],
      ["Rename across the project"],
      ["LTO build"],
    ]);
    expect(container.querySelector(".bp-independent .bp-node-title")!.textContent).toBe(
      "LTO build",
    );
    expect(container.querySelectorAll(".bp-edges path")).toHaveLength(3);
    const nodeOf = (id: string) =>
      [...container.querySelectorAll<HTMLElement>(".bp-node")].find(
        (n) => n.dataset.objective === id,
      )!;
    fireEvent.click(nodeOf("index/name-ranges"));
    const cls = (id: string) => nodeOf(id).className;
    expect(cls("foundation/identity")).toContain(" up");
    expect(cls("cli/refactor")).toContain(" down");
    expect(cls("infra/lto")).toContain(" dim");
  });
});

describe("BoardPage header", () => {
  it("renames on Enter, keeps the name on Escape and ignores an IME Enter", () => {
    const { getByTitle, getByLabelText, onRename, onClose } = page();
    fireEvent.click(getByTitle("Rename"));
    fireEvent.keyDown(getByLabelText("Project name"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(getByTitle("Rename"));
    const input = getByLabelText("Project name");
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " clice next " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("clice next");
  });

  it("closes on the backdrop but not inside the board", () => {
    const { container, onClose } = page();
    fireEvent.click(container.querySelector(".board-page")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".board-overlay")!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("archiving the project from its board", () => {
  it("files it away, or brings an archived one back", () => {
    const onArchive = vi.fn();
    const p = {
      id: "p1",
      name: "clice",
      root: "/r",
      leadWorkspaceId: null,
      createdAt: 0,
      objectives: [],
    };
    const props = boardProps({ onAskLead: null, onArchive });
    const { getByText, rerender } = render(<BoardPage project={p} {...props} />);
    fireEvent.click(getByText("Archive project"));
    expect(onArchive).toHaveBeenCalledWith(true);
    rerender(<BoardPage project={{ ...p, archivedAt: 1 }} {...props} />);
    fireEvent.click(getByText("Restore project"));
    expect(onArchive).toHaveBeenLastCalledWith(false);
  });
});
