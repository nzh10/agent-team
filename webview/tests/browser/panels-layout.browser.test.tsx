import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { page, cdp } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { AgentsPanel, type AgentsPanelActions } from "../../src/panels/AgentsPanel";
import { AgentTasks } from "../../src/panels/SessionTasks";
import { CodeView } from "../../src/panels/FilesPanel";
import { DiffView } from "../../src/panels/ChangesView";
import { Sidebar, SystemStatusPanel, type SidebarProps } from "../../src/sidebar/Sidebar";
import type { AgentInfo, Workspace } from "../../src/state/useServer";
import "highlight.js/styles/github-dark.css";
import "../../src/styles.css";

const long = "A long name that must not push other controls off the edge ".repeat(8).trim();
const workspace = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  hostId: "local",
  project: "repo",
  cwd: "/repo",
  agents: [],
  messages: [],
  createdAt: 1,
  git: null,
  pr: null,
  ...over,
});
const no = () => {};
const rect = (el: Element) => el.getBoundingClientRect();
const get = <T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string) => {
  const el = root.querySelector<T>(selector);
  expect(el, selector).not.toBeNull();
  return el!;
};
const style = getComputedStyle;
const textRect = (el: Element) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect();
};
let touch = false;
afterEach(async () => {
  cleanup();
  if (touch) await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  touch = false;
});

const sidebar: SidebarProps = {
  workspaces: [
    workspace("lead", { projectLink: { projectId: "p", role: "lead" } }),
    workspace("worker", {
      name: long,
      awaitsUser: true,
      projectLink: { projectId: "p", role: "worker" },
    }),
  ],
  projects: [
    { id: "p", name: "repo", root: "/repo", leadWorkspaceId: "lead", createdAt: 1, objectives: [] },
  ],
  activeWsId: "lead",
  connected: true,
  groupOverrides: {},
  finishedStatus: {},
  searchQuery: "",
  searchHits: null,
  systemStatus: null,
  onSelect: no,
  onDelete: no,
  onToggleGroup: no,
  onSearchChange: no,
  onJump: no,
  onCreate: no,
  onDeleteProject: no,
  onCreateIn: no,
  onReplayDemo: no,
  onDebugSnapshot: no,
  onPurgeArchived: no,
  onArchiveProject: no,
  onRestoreProject: no,
};

it("keeps session deletion confirmation in the viewport outside the mobile drawer", async () => {
  await page.viewport(390, 760);
  const { container } = render(
    <div className="sidebar sidebar-open">
      <Sidebar {...sidebar} />
    </div>,
  );
  fireEvent.click(get(container, '[title="Delete session"]'));
  const modal = get(document, ".dialog-confirm");
  expect(rect(modal.parentElement!).width).toBe(390);
  expect(rect(modal).left).toBeGreaterThanOrEqual(0);
  expect(rect(modal).right).toBeLessThanOrEqual(390);
});

const archivedProject = {
  id: "archived",
  name: "Archived",
  root: "/archive",
  leadWorkspaceId: "old",
  createdAt: 1,
  archivedAt: 2,
  objectives: [],
};
const archivedRows = [
  workspace("old-worker", { archivedAt: 2, projectLink: { projectId: "p", role: "worker" } }),
  workspace("old", {
    cwd: "/archive",
    archivedAt: 2,
    projectLink: { projectId: "archived", role: "lead" },
  }),
];

const sidebarView = (props: SidebarProps) => (
  <div style={{ width: 260 }}>
    <Sidebar {...props} />
  </div>
);

it("clips only the session title and reveals actions on hover or keyboard focus without moving the row", async () => {
  await page.viewport(1000, 800);
  expect(matchMedia("(hover: hover)").matches).toBe(true);
  const { container } = render(sidebarView(sidebar));
  const row = get(container, ".task-item");
  const name = get(row, ".task-name-text .clip");
  const tag = get(row, ".awaits-tag");
  const hover = get(row, ".task-hover");
  const del = get(hover, "button");
  expect(name.title).toBe(long);
  expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
  expect(style(name).textOverflow).toBe("ellipsis");
  expect(rect(tag).right).toBeLessThanOrEqual(rect(row).right);
  const measureRow = () => {
    const { x, y, width, height } = rect(row);
    return [x, y, width, height];
  };
  const before = measureRow();
  expect(style(hover).pointerEvents).toBe("none");
  del.focus();
  expect(style(hover).pointerEvents).toBe("auto");
  del.blur();
  await page.elementLocator(row).hover();
  await expect.poll(() => style(hover).opacity).toBe("1");
  expect(measureRow()).toEqual(before);
});

it("exposes touch actions only on the open session and gives the lists a larger type scale", async () => {
  await page.viewport(1000, 800);
  const unrelated = {
    id: "other",
    name: "Other",
    root: "/other",
    leadWorkspaceId: "other-lead",
    createdAt: 1,
    objectives: [],
  };
  const props = {
    ...sidebar,
    projects: [...sidebar.projects!, unrelated, archivedProject],
    workspaces: [
      ...sidebar.workspaces,
      workspace("other-lead", { cwd: "/other", projectLink: { projectId: "other", role: "lead" } }),
      ...archivedRows,
    ],
  };
  const { container, rerender } = render(sidebarView(props));
  const row = get(container, ".task-item");
  const root = style(document.documentElement);
  const scale = () =>
    ["name", "text", "meta", "tag"].map((size) =>
      parseFloat(root.getPropertyValue(`--fs-${size}`)),
    );
  const desktop = scale();
  const listText = [
    get(row, ".task-name .clip"),
    get(row, ".awaits-tag"),
    get(container, ".ws-archive-toggle"),
  ];
  const renderedDesktop = listText.map((el) => parseFloat(style(el).fontSize));
  const icon = get(container, ".sidebar-header .icon");
  const desktopIcon = rect(icon).width;
  await page.elementLocator(get(container, ".sidebar-header")).hover();
  touch = true;
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.viewport(390, 800);
  expect(matchMedia("(hover: none)").matches).toBe(true);
  scale().forEach((value, i) => expect(value).toBeGreaterThan(desktop[i]));
  listText.forEach((el, i) =>
    expect(parseFloat(style(el).fontSize)).toBeGreaterThan(renderedDesktop[i]),
  );
  expect(rect(icon).width).toBeGreaterThan(desktopIcon);
  expect(rect(get(container, ".ws-group-add .icon")).width).toBe(
    rect(get(container, ".task-delete .icon")).width,
  );
  expect(style(get(row, ".task-hover")).pointerEvents).toBe("none");
  const current = get(container, ".ws-group-header.current");
  const inactive = get(container, ".ws-group-project:not(.current)");
  expect(style(get(current, ".ws-group-add")).opacity).toBe("1");
  expect(style(get(current, ".task-delete")).visibility).toBe("visible");
  for (const selector of [".ws-group-add", ".ws-group-archive"]) {
    expect(rect(get(inactive, selector)).width).toBe(0);
  }
  expect(style(get(inactive, ".task-delete")).visibility).toBe("hidden");
  fireEvent.click(get(container, ".ws-archive-toggle"));
  expect(style(get(container, ".ws-archived-purge")).opacity).toBe("1");
  fireEvent.click(get(container, ".ws-shelf .ws-archived-header"));
  expect(style(get(container, 'button[title^="Bring Archived"]')).opacity).toBe("1");

  rerender(sidebarView({ ...props, activeWsId: "worker" }));
  await expect.poll(() => style(get(row, ".task-hover")).opacity).toBe("1");
  expect(style(get(row, ".task-hover")).pointerEvents).toBe("auto");
  rerender(sidebarView({ ...props, activeWsId: "other-lead" }));
  expect(rect(get(current, ".ws-group-add")).width).toBe(0);
  expect(rect(get(inactive, ".ws-group-add")).width).toBeGreaterThan(0);
  expect(style(get(inactive, ".task-delete")).visibility).toBe("visible");
});

it("uses the sidebar type scale and hover affordance on archived project rows", async () => {
  await page.viewport(1040, 760);
  const { container } = render(
    sidebarView({
      ...sidebar,
      projects: [...sidebar.projects!, archivedProject],
      workspaces: [...sidebar.workspaces, ...archivedRows],
    }),
  );
  const toggle = get(container, ".ws-archive-toggle");
  expect(style(toggle).fontSize).toBe(
    style(document.documentElement).getPropertyValue("--fs-meta").trim(),
  );
  fireEvent.click(get(container, ".ws-shelf .ws-archived-header"));
  const restore = get(container, '.ws-shelf button[title^="Bring"]');
  const row = restore.closest(".ws-group-header")!;
  expect(style(restore).borderRadius).toBe("8px");
  expect(style(restore).opacity).toBe("0");
  await page.elementLocator(row).hover();
  await expect.poll(() => style(restore).opacity).toBe("1");
  fireEvent.click(toggle);
  const archivedSession = get(container, ".task-item-archived");
  const time = get(archivedSession, ".task-name .task-time");
  expect(style(time).visibility).toBe("visible");
  await page.elementLocator(archivedSession).hover();
  expect(style(time).visibility).toBe("hidden");
  await expect.poll(() => style(get(archivedSession, ".task-hover")).opacity).toBe("1");
});

it("gives model and effort their own unclipped row in a narrow panel, independently of viewport width", async () => {
  await page.viewport(1100, 800);
  const agent: AgentInfo = {
    id: "a",
    name: long,
    model: "anthropic/claude-opus-5-5",
    effortLevels: ["low", "high"],
    fast: true,
    avatar: "A",
    color: "#fff",
    isDefault: true,
  };
  const actions: AgentsPanelActions = {
    onOpen: no,
    onStop: no,
    onArchive: no,
    onRestore: no,
    onSetReporting: no,
    onAddAgent: no,
    onClearContext: no,
    onRemoveAgent: no,
    onSetModel: no,
    onSetEffort: no,
    onStopTask: no,
    onCancelWake: no,
    onStopAll: no,
  };
  const view = (width: number, current = agent, connected = true) => (
    <div style={{ width }}>
      <AgentsPanel
        sessions={[workspace("s", { agents: [current], lastMessageAt: 1 })]}
        project={undefined}
        activeWsId="s"
        connected={connected}
        models={[
          { id: agent.model, label: "Opus", backend: "pi" },
          { id: "github-copilot/claude-opus-5-5", label: "Opus", backend: "pi" },
        ]}
        actions={actions}
      />
    </div>
  );
  const { container, rerender } = render(view(680));
  const top = get(container, ".ap-agent-top");
  const name = get(top, ".ap-agent-name");
  const meta = get(top, ".ap-meta");
  const model = get(top, ".ap-model:not(.ap-effort)");
  const effort = get(top, ".ap-effort");
  const action = get(top, ".ap-agent-actions");
  expect(rect(meta).top).toBeLessThan(rect(name).bottom);
  rerender(view(336));
  expect(rect(meta).top).toBeGreaterThanOrEqual(rect(name).bottom);
  expect(rect(action).right).toBeLessThanOrEqual(rect(container.firstElementChild!).right);
  expect(rect(model).width).toBeGreaterThan(40);
  expect(rect(effort).left).toBeGreaterThanOrEqual(rect(model).right);
  expect(rect(effort).right).toBeLessThanOrEqual(rect(top).right);
  expect(meta.scrollWidth).toBeLessThanOrEqual(meta.clientWidth);
  expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
  expect(style(name).textOverflow).toBe("ellipsis");
  expect(meta.textContent).toContain("⚡");
  expect(action.querySelectorAll("button")).toHaveLength(2);
  rerender(view(336, { ...agent, effortLevels: undefined, effort: "high" }));
  const staticEffort = get(meta, ".ap-meta-effort");
  expect(staticEffort.textContent?.trim()).toBe("· high");
  expect(textRect(staticEffort).right).toBeLessThanOrEqual(rect(meta).right);
  expect(rect(get(meta, ".ap-meta-fast")).right).toBeLessThanOrEqual(rect(meta).right);

  rerender(view(680));
  const when = get(container, ".ap-when");
  const archive = get(container, ".ap-actions > :last-child");
  const border = style(archive).borderColor;
  await page.elementLocator(archive).hover();
  await expect.poll(() => style(archive).borderColor).not.toBe(border);
  expect(textRect(archive).right).toBeCloseTo(rect(when).right, 0);
  expect(rect(get(action, "button:last-child svg")).right).toBeCloseTo(rect(when).right, 0);
  expect(textRect(get(container, ".ap-add")).left).toBeCloseTo(
    rect(get(container, ".ap-agent svg, .ap-agent .agent-avatar")).left,
    0,
  );

  rerender(view(336, agent, false));
  for (const field of [get(container, ".ap-agent-state"), get(container, ".ap-meta")]) {
    expect(style(field).whiteSpace).toBe("nowrap");
    expect(style(field).overflow).toBe("hidden");
    expect(style(field).textOverflow).toBe("ellipsis");
    expect(style(field).display).not.toBe("flex");
  }
});

it("aligns status bars across rows even with differently sized values", async () => {
  await page.viewport(1000, 800);
  const { getAllByRole } = render(
    <div style={{ width: 260 }}>
      <SystemStatusPanel
        status={{
          osName: "Darwin",
          osArch: "arm64",
          cpuModel: "Apple",
          cpuCores: 8,
          cpuUsage: 9,
          memUsed: 2 * 1024 ** 3,
          memTotal: 8 * 1024 ** 3,
          uptime: 1000,
          hostname: "local",
        }}
      />
    </div>,
  );
  const [cpu, memory] = getAllByRole("progressbar").map(rect);
  expect(cpu.left).toBe(memory.left);
  expect(cpu.bottom).toBeLessThan(memory.top);
  expect(cpu.width).toBeGreaterThan(30);
});

it("wraps task descriptions above their times and leaves room under the last action on a phone", async () => {
  await page.viewport(390, 800);
  const agent: AgentInfo = {
    id: "a",
    name: "A",
    avatar: "A",
    color: "#fff",
    model: "claude-opus-5-5",
    isDefault: true,
    backgroundTasks: [
      { id: "task", type: "local_bash", description: long, since: Date.now() - 1000 },
    ],
  };
  const actions = { onStopTask: no, onCancelWake: no, onStopAll: no };
  const session = workspace("s");
  const { container } = render(
    <div className="side-panel-body" style={{ width: 330, height: 120 }}>
      <AgentTasks agent={agent} session={session} actions={actions} />
      <AgentTasks
        agent={{
          ...agent,
          backgroundTasks: [],
          wake: { at: Date.now() + 60_000, reason: "Review the results" },
        }}
        session={session}
        actions={actions}
      />
    </div>,
  );
  const panel = get(container, ".side-panel-body");
  const desc = get(panel, ".tp-desc");
  const time = get(panel, ".tp-when");
  expect(rect(desc).height).toBeGreaterThan(parseFloat(style(desc).fontSize) * 2);
  expect(rect(time).top).toBeGreaterThanOrEqual(rect(desc).bottom);
  const buttons = [...panel.querySelectorAll<HTMLElement>(".tp-stop")];
  expect(buttons).toHaveLength(2);
  expect(rect(buttons[0]).width).toBeCloseTo(rect(buttons[1]).width, 0);
  expect(rect(buttons[0]).width).toBeGreaterThan(44);
  await cdp().send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 30 } });
  try {
    expect(style(panel).paddingBottom).toBe("54px");
    panel.scrollTop = panel.scrollHeight;
    expect(rect(panel).bottom - rect(buttons[1]).bottom).toBeGreaterThanOrEqual(52);
  } finally {
    await cdp().send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
  }
});

it("scrolls highlighted file and diff lines horizontally beneath stationary line numbers", async () => {
  await page.viewport(390, 800);
  const code = `const sentence = ${JSON.stringify(long)};`;
  const { container } = render(
    <div className="side-panel-body" style={{ width: 320 }}>
      <CodeView content={`const n = 1;\n${code}\n`} lang="typescript" target={{ path: "a.ts" }} />
      <DiffView
        lang="typescript"
        diff={{
          path: "a.ts",
          diff: `@@ -98 +99 @@\n-const n = 1;\n+${code}\n`,
          binary: false,
          truncated: false,
        }}
      />
    </div>,
  );
  expect(style(document.documentElement).colorScheme).toBe("dark");
  const bg = style(get(container, ".side-panel-body")).backgroundColor;
  for (const [view, gutter, text, highlight] of [
    [".code-view", ".code-gutter", ".code-text", ".code-text.hljs"],
    [".diff-view", ".diff-add .diff-gutter", ".diff-add .diff-code", ".diff-inner.hljs"],
  ]) {
    const scroll = get(container, view);
    const numbers = get(scroll, gutter);
    const line = get(scroll, text);
    const start = rect(numbers).left;
    const left = rect(line).left;
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth + 200);
    expect(style(line).whiteSpace).toBe("pre");
    scroll.scrollLeft = 160;
    expect(rect(line).left).toBeLessThan(left - 100);
    expect(rect(numbers).left).toBeCloseTo(start);
    const background = style(get(scroll, highlight)).backgroundColor;
    expect(["rgba(0, 0, 0, 0)", bg]).toContain(background);
  }
  expect(get(container, ".diff-add .diff-gutter").textContent).toContain("99+");
  expect(get(container, ".diff-del .diff-gutter").textContent).toContain("98");
});
