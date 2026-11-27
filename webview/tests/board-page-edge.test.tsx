// The board page at clice's scale and at its edges: selection, Escape,
// focus, broken files, counts, the archive.
import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { BoardPage, type SessionInfo } from "../src/project/BoardPage";
import type { Objective, ObjectiveStatus, Project } from "../src/state/useServer";
import { boardProject as project, boardProps, renderBoard } from "./helpers/board";
import { objective as o } from "./helpers/fixtures";

// A clice-sized board: 60 objectives over 8 areas, long Chinese titles,
// foundation items with wide fan-out, chains four deep, a third isolated.
const AREAS = ["foundation", "engine", "build", "index", "service", "cli", "infra", "root"];
function bigBoard(): Objective[] {
  const out: Objective[] = [];
  const statuses: ObjectiveStatus[] = ["active", "active", "active", "later", "done", "dropped"];
  for (let i = 0; i < 60; i++) {
    const area = AREAS[i % AREAS.length];
    const id = `${area}/item-${i}`;
    const deps: string[] = [];
    if (area !== "foundation" && i % 3 !== 0) deps.push(`foundation/item-${8 * ((i * 7) % 8)}`);
    if (area === "cli" && i > 16) deps.push(`index/item-${8 * Math.floor((i - 3) / 8 - 1) + 3}`);
    if (area === "cli" && i > 30) deps.push(`cli/item-${i - 8}`);
    out.push(
      o(id, {
        title: `全项目${i}号目标：跨 TU 的声明身份与索引键稳定化，覆盖模板特化和宏展开的边角情况`,
        goal: "entity + content 闭包替换 USR：索引键、query 稳定 ID、doc 提取、modulize 分析与 lint ODR 检查的地基。".repeat(
          2,
        ),
        status: statuses[i % statuses.length],
        priority: i % 5 === 0 ? "high" : "normal",
        dependsOn: deps.filter((d) => d !== id),
        tasks: [
          { id: "t1", text: "第一步", state: i % 2 ? "doing" : "todo" },
          { id: "t2", text: "第二步", state: "done" },
        ],
        decisions: i % 4 === 0 ? [{ id: "d1", question: "要不要拆？" }] : [],
        updatedAt: 1_800_000_000_000 - i * 1000,
      }),
    );
  }
  return out;
}

const sessions = new Map<string, SessionInfo>();

afterEach(() => vi.unstubAllGlobals());

const page = (p: Project) => renderBoard(p, { sessions });

const graph = (c: HTMLElement) =>
  fireEvent.click(within(c).getByRole("button", { name: "Dependencies" }));
const node = (c: HTMLElement, id: string) =>
  [...c.querySelectorAll<HTMLElement>(".bp-node")].find((n) => n.dataset.objective === id)!;
const card = (c: HTMLElement, id: string) =>
  [...c.querySelectorAll(".bp-card")].find((x) => x.querySelector(".bp-id")!.textContent === id)!;

describe("a clice-sized board", () => {
  it("renders 60 long-titled objectives, keeping unconnected ones apart in the graph", () => {
    const objs = bigBoard();
    const { container } = page(project(objs));
    const shown = objs.filter((x) => x.status === "active" || x.status === "later");
    expect(container.querySelectorAll(".bp-card")).toHaveLength(shown.length);
    graph(container);
    expect(container.querySelectorAll(".bp-node")).toHaveLength(shown.length);
    const independent = container.querySelector(".bp-independent");
    expect(independent).not.toBeNull();
    const ids = new Set(shown.map((x) => x.id));
    for (const n of independent!.querySelectorAll<HTMLElement>(".bp-node")) {
      const x = shown.find((y) => y.id === n.dataset.objective)!;
      expect(x.dependsOn.some((d) => ids.has(d))).toBe(false);
      expect(shown.some((y) => y.dependsOn.includes(x.id))).toBe(false);
    }
  });
});

describe("selection", () => {
  const objs = [
    o("foundation/identity"),
    o("index/name-ranges", { dependsOn: ["foundation/identity"] }),
    o("cli/refactor", { dependsOn: ["index/name-ranges"] }),
  ];

  it("does not dim the graph for a selection that is filtered out", () => {
    const { container } = page(project(objs));
    graph(container);
    fireEvent.click(node(container, "index/name-ranges"));
    const nav = within(container.querySelector(".bp-nav") as HTMLElement);
    fireEvent.click(nav.getByRole("button", { name: /^cli/ }));
    expect(node(container, "cli/refactor").className).not.toContain(" dim");
  });

  it("forgets an objective that disappears", () => {
    const { container, rerender, onClose } = page(project(objs));
    fireEvent.click(card(container, "cli/refactor"));
    const props = boardProps({ sessions, onClose });
    rerender(<BoardPage project={project(objs.slice(0, 2))} {...props} />);
    expect(container.querySelector(".bp-detail")).toBeNull();
    rerender(<BoardPage project={project(objs)} {...props} />);
    expect(container.querySelector(".bp-detail")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("graph hover", () => {
  it("lights the chain under a mouse but not after a tap", () => {
    const objs = [o("a/x"), o("a/y", { dependsOn: ["a/x"] }), o("b/z")];
    const { container } = page(project(objs));
    graph(container);
    fireEvent.pointerEnter(node(container, "a/y"), { pointerType: "touch" });
    expect(container.querySelectorAll(".bp-node.dim")).toHaveLength(0);
    fireEvent.pointerEnter(node(container, "a/y"), { pointerType: "mouse" });
    expect(node(container, "a/x").className).toContain(" up");
    expect(node(container, "b/z").className).toContain(" dim");
    fireEvent.pointerLeave(node(container, "a/y"), { pointerType: "mouse" });
    expect(container.querySelectorAll(".bp-node.dim")).toHaveLength(0);
  });
});

describe("graph columns", () => {
  it("number the steps and show prerequisites that are not on screen", () => {
    const objs = [
      o("foundation/fixit", { status: "done" }),
      o("foundation/identity"),
      o("cli/edits", { dependsOn: ["foundation/fixit"] }),
      o("cli/lint", { dependsOn: ["foundation/identity", "cli/edits"] }),
    ];
    const { container } = page(project(objs));
    graph(container);
    expect([...container.querySelectorAll(".bp-column-title")].map((t) => t.textContent)).toEqual([
      "Step 1",
      "Step 2",
    ]);
    expect(node(container, "cli/edits").textContent).toContain("+1 not shown");
    const nav = within(container.querySelector(".bp-nav") as HTMLElement);
    fireEvent.click(nav.getByRole("button", { name: /^cli/ }));
    const lint = node(container, "cli/lint");
    expect(lint.textContent).toContain("blocked");
    expect(lint.querySelector(".bp-hidden")!.getAttribute("title")).toBe(
      "Not shown: foundation/identity",
    );
  });
});

describe("Escape", () => {
  it("leaves an Escape that belongs to an IME composition alone", () => {
    const { getByPlaceholderText, onClose } = page(project([o("a/x")]));
    const search = getByPlaceholderText("Search objectives…");
    fireEvent.keyDown(search, { key: "Escape", isComposing: true, keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("focus", () => {
  it("cycles Tab and Shift+Tab inside the dialog, even from background focus", () => {
    const { container, getByTitle } = page(project([o("a/x")]));
    const dialog = container.querySelector<HTMLElement>("[role=dialog]")!;
    const first = getByTitle("Rename");
    const last = container.querySelector<HTMLElement>(".bp-card")!;

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    const background = document.body.appendChild(document.createElement("button"));
    background.focus();
    fireEvent.keyDown(background, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    background.remove();
  });

  it("moves into the dialog on open and back to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { container, unmount } = page(project([o("a/x")]));
    const dialog = container.querySelector("[role=dialog]")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("dialog and selection semantics", () => {
  it("names every mode and exposes area and objective detail state", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const { container, getByRole } = page(project([o("a/x")]));
    expect(getByRole("dialog", { name: "clice objectives" })).toBeTruthy();

    const areas = container.querySelectorAll<HTMLButtonElement>(".bp-area");
    expect(areas[0].getAttribute("aria-pressed")).toBe("true");
    expect(areas[1].getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(areas[1]);
    expect(areas[0].getAttribute("aria-pressed")).toBe("false");
    expect(areas[1].getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(getByRole("button", { name: "Dependencies" }));
    const node = container.querySelector<HTMLButtonElement>(".bp-node")!;
    expect(node.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(node);
    expect(node.getAttribute("aria-expanded")).toBe("true");
    expect(node.getAttribute("aria-controls")).toBe("bp-objective-detail");
    expect(container.querySelector("#bp-objective-detail")).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "Issues" }));
    expect(getByRole("dialog", { name: "clice issues" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Notes" }));
    expect(getByRole("dialog", { name: "clice notes" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Objectives" }));
    expect(getByRole("dialog", { name: "clice objectives" })).toBeTruthy();
  });
});

describe("broken files", () => {
  it("shows only the broken files when nothing else can be read", () => {
    const { container } = page(project([{ id: "a/x", error: "bad toml" }]));
    expect(container.querySelector(".bp-broken")).not.toBeNull();
    expect(container.querySelector(".bp-empty")).toBeNull();
  });
});

describe("what is left of dropped and done work", () => {
  it("shows a dropped objective kept as its title and the reason, and nothing it no longer has", () => {
    const { container } = page(
      project([
        o("build/cmake", {
          title: "CMake build",
          goal: "",
          status: "dropped",
          reason: "Bazel builds clice",
        }),
      ]),
    );
    fireEvent.click(within(container).getByRole("button", { name: /^Dropped/ }));
    const c = card(container, "build/cmake");
    expect(c.querySelector(".bp-card-goal")).toBeNull();
    expect(within(c as HTMLElement).getByText("Bazel builds clice")).toBeTruthy();
    fireEvent.click(c);
    const titles = [...container.querySelectorAll(".bp-detail .bp-section-title")].map(
      (e) => e.textContent,
    );
    expect(titles).toEqual([]);
    expect(container.querySelector(".bp-detail .bp-reason")!.textContent).toBe(
      "Bazel builds clice",
    );
  });

  it("shows what a dropped objective still holds", () => {
    const { container } = page(
      project([
        o("build/cmake", {
          goal: "",
          status: "dropped",
          reason: "Bazel",
          tasks: [{ id: "t1", text: "presets", state: "todo" }],
        }),
      ]),
    );
    fireEvent.click(within(container).getByRole("button", { name: /^Dropped/ }));
    fireEvent.click(card(container, "build/cmake"));
    expect(
      within(container.querySelector(".bp-detail") as HTMLElement).getByText("presets"),
    ).toBeTruthy();
  });

  it("says when and at which commit where it stands was written", () => {
    const { container } = page(
      project([
        o("index/format", {
          context: "v2 reads, v1 still writes.",
          contextWritten: Date.now() - 3 * 86_400_000,
          contextCommit: "6974365ab",
        }),
      ]),
    );
    fireEvent.click(card(container, "index/format"));
    expect(container.querySelector(".bp-detail .bp-written")!.textContent).toBe(
      "written 3d ago at 6974365ab",
    );
  });
});

describe("the archive", () => {
  const objs = [
    o("foundation/paths", { status: "done", archived: true }),
    o("infra/mingw", { status: "dropped", archived: true, reason: "MSVC only" }),
    o("index/format", { dependsOn: ["foundation/paths"] }),
  ];

  it("keeps archived objectives off the board, where they still count as done", () => {
    const { container } = page(project(objs));
    expect([...container.querySelectorAll(".bp-card .bp-id")].map((e) => e.textContent)).toEqual([
      "index/format",
    ]);
    expect(within(card(container, "index/format") as HTMLElement).getByText("ready")).toBeTruthy();
  });

  it("lists them on their own, read-only, with the status filters set aside", () => {
    const { container, getByRole } = page(project(objs));
    fireEvent.click(getByRole("button", { name: /^Archive/ }));
    expect([...container.querySelectorAll(".bp-card .bp-id")].map((e) => e.textContent)).toEqual([
      "foundation/paths",
      "infra/mingw",
    ]);
    expect(getByRole("button", { name: /^Active/ })).toHaveProperty("disabled", true);
    expect(
      within(card(container, "infra/mingw") as HTMLElement).getByText("MSVC only"),
    ).toBeTruthy();
    fireEvent.click(card(container, "infra/mingw"));
    expect(container.querySelector(".bp-detail")!.textContent).toContain("Archived");
  });

  it("goes back to the board once the last archived objective is deleted", () => {
    const { container, getByRole, queryByRole, rerender, onClose, onOpenSession, onAskLead } = page(
      project(objs),
    );
    fireEvent.click(getByRole("button", { name: /^Archive/ }));
    rerender(
      <BoardPage
        project={project([objs[2]])}
        {...boardProps({ sessions, onClose, onOpenSession, onAskLead })}
      />,
    );
    expect(queryByRole("button", { name: /^Archive/ })).toBeNull();
    expect(getByRole("button", { name: /^Active/ })).toHaveProperty("disabled", false);
    expect([...container.querySelectorAll(".bp-card .bp-id")].map((e) => e.textContent)).toEqual([
      "index/format",
    ]);
  });
});
