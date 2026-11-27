import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { App } from "../../src/App";
import { ICONS } from "../../src/panels/Icon";
import { Sidebar, type SidebarProps } from "../../src/sidebar/Sidebar";
import type { AgentInfo, Project, Workspace } from "../../src/state/useServer";
import { FakeSocket } from "../fakeSocket";
import "../../src/fonts/sarasa-mono-sc/regular/result.css";
import "../../src/fonts/sarasa-mono-sc/bold/result.css";
import "../../src/styles.css";

const NOW = 1_800_000_000_000;
const no = () => {};
const rect = (element: Element) => element.getBoundingClientRect();
const center = (element: Element) => {
  const box = rect(element);
  return box.top + box.height / 2;
};
const get = <T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string) => {
  const element = root.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
};

const agent: AgentInfo = {
  id: "agent",
  name: "Agent",
  model: "model",
  avatar: "A",
  color: "#888",
  isDefault: true,
};
const project: Project = {
  id: "project",
  name: "Project",
  root: "/repo",
  leadWorkspaceId: "lead",
  createdAt: NOW,
  objectives: [],
};
function workspace(id: string, fields: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    project: "Project",
    hostId: "local",
    cwd: "/repo",
    agents: [agent],
    messages: [],
    createdAt: NOW,
    lastMessageAt: NOW,
    projectLink: { projectId: project.id, role: id === "lead" ? "lead" : "worker" },
    ...fields,
  };
}
const sidebarWorkspaces = [
  workspace("lead"),
  workspace("plain"),
  workspace("attention", { awaitsUser: true }),
  workspace("archived", { archivedAt: NOW - 1000 }),
  workspace("two-line", { archivedAt: NOW - 1000, cwd: "/elsewhere/folder" }),
];

function sidebarProps(activeWsId: string): SidebarProps {
  return {
    workspaces: sidebarWorkspaces,
    projects: [project],
    activeWsId,
    connected: true,
    groupOverrides: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: null,
    now: NOW,
    onSelect: no,
    onDelete: no,
    onDeleteProject: no,
    onToggleGroup: no,
    onSearchChange: no,
    onJump: no,
    onCreate: no,
    onCreateProject: no,
    onCreateIn: no,
    onReplayDemo: no,
    onDebugSnapshot: no,
    onPurgeArchived: no,
    onArchiveWorkspace: no,
  };
}

function healthyProbe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ issues: [] }) })),
  );
}

let touch = false;
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeSocket.instances = [];
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete window.yaatTheme;
  if (touch) await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  touch = false;
});

function expectCentered(reference: Element, element: Element, label: string) {
  // display:none metadata is intentional on phones; visible marks are audited.
  if (!element.getClientRects().length) return;
  expect(Math.abs(center(reference) - center(element)), label).toBeLessThanOrEqual(1);
}

it.each([
  { width: 1200, height: 800, theme: "light" },
  { width: 1200, height: 800, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
])(
  "centers active sidebar marks at $width px in $theme theme",
  async ({ width, height, theme }) => {
    await page.viewport(width, height);
    touch = width === 390;
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: touch });
    document.documentElement.dataset.theme = theme;
    healthyProbe();
    const view = render(
      <div style={{ width: 260 }}>
        <Sidebar {...sidebarProps("plain")} />
      </div>,
    );
    await document.fonts.ready;

    for (const active of ["plain", "archived", "attention", "two-line"]) {
      view.rerender(
        <div style={{ width: 260 }}>
          <Sidebar {...sidebarProps(active)} />
        </div>,
      );
      const row = get(view.container, ".task-item.active");
      const name = get(row, ".task-name");
      const twoLine = row.querySelector<HTMLElement>(".task-meta");
      // Focus reveals the same hover/action marks without depending on a pointer.
      get(row, ".task-delete").focus({ preventScroll: true });
      const reference = twoLine ? name : row;
      for (const selector of [
        ".task-name",
        ".task-name-text",
        ".task-status",
        ".task-name .task-time",
        ".task-hover",
        ".task-hover .task-time",
        ".session-attention",
      ]) {
        const element = row.querySelector<HTMLElement>(selector);
        if (element) expectCentered(reference, element, `${active} ${selector}`);
      }
      if (active === "two-line") expect(twoLine).not.toBeNull();
      else expect(twoLine).toBeNull();
    }

    view.rerender(
      <div style={{ width: 260 }}>
        <Sidebar {...sidebarProps("lead")} />
      </div>,
    );
    const header = get(view.container, ".ws-group-header.active");
    get(header, ".ws-group-add").focus({ preventScroll: true });
    for (const selector of [
      ".ws-group-label",
      ".events-toggle",
      ".ws-group-status",
      ".ws-group-actions",
      ".task-status",
    ]) {
      const element = header.querySelector<HTMLElement>(selector);
      if (element) expectCentered(header, element, `project ${selector}`);
    }
  },
);

const appAgents: AgentInfo[] = [
  { ...agent, id: "idle", name: "Idle" },
  {
    ...agent,
    id: "working",
    name: "Working",
    isDefault: false,
    busy: true,
    lastStreamAt: NOW,
  },
];
const appWorkspace = workspace("lead", { agents: appAgents, messagesLoaded: true });

function bootApp() {
  localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  healthyProbe();
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  render(<App />, { container: root });
  const socket = FakeSocket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.receive({
      type: "init",
      workspaces: [appWorkspace],
      projects: [project],
      config: { presets: [], models: [], commands: [], hosts: {} },
      hosts: [],
    });
  });
  return root;
}

it.each(["light", "dark"])(
  "gives every distinct-meaning chrome control a unique icon path in %s theme",
  async (theme) => {
    await page.viewport(1200, 800);
    document.documentElement.dataset.theme = theme;
    window.yaatTheme = {
      get: () => (theme === "dark" ? "dark" : "light"),
      subscribe: () => () => {},
      toggle: no,
    };
    const root = bootApp();
    fireEvent.click(within(root).getByRole("button", { name: "Debug tools" }));
    const rail = get(root, ".side-rail");
    const controls: Array<[string, HTMLElement]> = [
      ["Notifications", within(root).getByRole("button", { name: "Notifications" })],
      ["Dark theme", within(root).getByRole("button", { name: "Dark theme" })],
      ["New session", within(root).getByRole("button", { name: "New session" })],
      ["New project", within(root).getByRole("button", { name: "New project" })],
      ["Usage", within(root).getByRole("button", { name: "Usage" })],
      ["Debug tools", within(root).getByRole("button", { name: "Debug tools" })],
      ["Send test push", within(root).getByRole("button", { name: "Send test push" })],
      ["Service diagnostics", within(root).getByRole("link", { name: "Service diagnostics" })],
      ["Replay demo", within(root).getByRole("button", { name: "Replay demo" })],
      [
        "Capture debug snapshot",
        within(root).getByRole("button", { name: "Capture debug snapshot" }),
      ],
      ["Objectives", within(rail).getByRole("button", { name: "Objectives of Project" })],
      ["Agents", within(rail).getByRole("button", { name: "Agents and sessions" })],
      ["Files", within(rail).getByRole("button", { name: "Files" })],
      ["Changes", within(rail).getByRole("button", { name: "Changes" })],
      ["Session stats", within(rail).getByRole("button", { name: "Session stats" })],
      ["Attach image", within(root).getByRole("button", { name: "Attach image" })],
      ["Send", within(root).getByRole("button", { name: "Send" })],
      ["Stop", within(root).getByRole("button", { name: "Stop Working" })],
    ];
    const paths = new Map(
      controls.map(([label, control]) => [label, get(control, "svg path").getAttribute("d") ?? ""]),
    );
    expect(new Set(paths.values()).size).toBe(controls.length);
    expect(paths.get("Send test push")).toBe(ICONS.testPush);
    expect(paths.get("New project")).toBe(ICONS.newProject);
    expect(paths.get("Session stats")).toBe(ICONS.stats);
    expect(paths.get("Attach image")).toBe(ICONS.attach);
    expect(paths.get("Notifications")).toBe(ICONS.bell);
    expect(paths.get("Objectives")).toBe(ICONS.board);
    expect(paths.get("Usage")).toBe(ICONS.usage);
    expect(paths.get("New session")).toBe(ICONS.plus);
    for (const label of ["Send test push", "New project", "Session stats", "Attach image"]) {
      const control = controls.find(([name]) => name === label)![1];
      const path = control.querySelector<SVGPathElement>("svg path")!;
      const box = path.getBBox();
      // getBBox excludes the 1.5px stroke, so preserve a half-stroke inset.
      expect(box.x, `${label} left`).toBeGreaterThanOrEqual(0.75);
      expect(box.y, `${label} top`).toBeGreaterThanOrEqual(0.75);
      expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(15.25);
      expect(box.y + box.height, `${label} bottom`).toBeLessThanOrEqual(15.25);
      expect(Math.abs(box.x + box.width / 2 - 8), `${label} optical x`).toBeLessThanOrEqual(1);
      expect(Math.abs(box.y + box.height / 2 - 8), `${label} optical y`).toBeLessThanOrEqual(1);
    }
    // The header and project-row plus buttons intentionally share one meaning.
    expect(get(root, ".ws-group-add svg path").getAttribute("d")).toBe(ICONS.plus);
  },
);

it.each([
  { width: 1200, height: 800, theme: "light", expectedHeight: 36 },
  { width: 390, height: 844, theme: "dark", expectedHeight: 40 },
])(
  "aligns one composer line and bottom-anchors controls at $width px",
  async ({ width, height, theme, expectedHeight }) => {
    await page.viewport(width, height);
    touch = width === 390;
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: touch });
    document.documentElement.dataset.theme = theme;
    const root = bootApp();
    await document.fonts.ready;
    const row = get(root, ".input-row");
    const input = get<HTMLTextAreaElement>(row, ".chat-input");
    const attach = get(row, ".btn-attach");
    const send = get(row, ".btn-primary-slot");
    const stop = get(row, ".btn-abort");
    const controls = [attach, send, stop];

    const checkSingleLine = () => {
      expect(input.value.includes("\n")).toBe(false);
      expect(rect(input).height).toBe(expectedHeight);
      for (const control of controls) {
        expect(rect(control).height).toBe(expectedHeight);
        expectCentered(input, control, `${control.className} box`);
        const icon = control.querySelector("svg");
        if (icon) expectCentered(control, icon, `${control.className} icon`);
      }
      const inputStyle = getComputedStyle(input);
      const inputBox = rect(input);
      const paddingTop = Number.parseFloat(inputStyle.paddingTop);
      const paddingBottom = Number.parseFloat(inputStyle.paddingBottom);
      const lineHeight = Number.parseFloat(inputStyle.lineHeight);
      expect(lineHeight).toBe(20);
      expect(Math.abs(paddingTop - paddingBottom)).toBeLessThanOrEqual(1);
      // Textarea text has no DOM Range: measure its CSS line box, not glyph ink.
      const firstLineCenter = inputBox.top + input.clientTop + paddingTop + lineHeight / 2;
      expect(Math.abs(firstLineCenter - center(input))).toBeLessThanOrEqual(1);
      const label = width === 1200 ? get(send, ".btn-text") : get(send, ".btn-icon");
      const range = document.createRange();
      range.selectNodeContents(label);
      const labelBox = range.getBoundingClientRect();
      expect(Math.abs(labelBox.top + labelBox.height / 2 - center(send))).toBeLessThanOrEqual(1);
    };

    checkSingleLine(); // Placeholder and empty single-line box.
    fireEvent.change(input, { target: { value: "Single line" } });
    checkSingleLine(); // Entered text uses the same baseline and box.

    fireEvent.change(input, { target: { value: "First line\nSecond line\nThird line" } });
    expect(rect(input).height).toBeGreaterThan(expectedHeight);
    expect(getComputedStyle(row).alignItems).toMatch(/^(?:flex|flow)-end$/);
    for (const control of controls) {
      expect(Math.abs(rect(control).bottom - rect(input).bottom)).toBeLessThanOrEqual(1);
    }
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);

    if (width === 390) {
      fireEvent.change(input, { target: { value: "Single line" } });
      expect(rect(input).height).toBe(40);
      await page.viewport(1200, 800);
      await expect.poll(() => rect(input).height).toBe(36);
      for (const control of controls) {
        expect(rect(control).height).toBe(36);
        expectCentered(input, control, `${control.className} after resize`);
      }
    }
  },
);
