import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { Sidebar, type SidebarProps } from "../../src/sidebar/Sidebar";
import type { Workspace } from "../../src/state/useServer";
import "../../src/styles.css";

const noop = () => {};
const project = {
  id: "p",
  name: "Project",
  root: "/repo",
  createdAt: 1,
  leadWorkspaceId: "lead",
  objectives: [],
};
function ws(id: string, extra: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    cwd: "/repo",
    hostId: "local",
    project: "repo",
    createdAt: 1,
    agents: [],
    messages: [],
    projectLink: { projectId: "p", role: "worker" },
    ...extra,
  };
}
const workspaces = [
  ws("lead", { projectLink: { projectId: "p", role: "lead" } }),
  ...Array.from({ length: 28 }, (_, i) => ws(`idle-${i}`)),
  ...Array.from({ length: 28 }, (_, i) => ws(`old-${i}`, { archivedAt: 2 })),
  ws("other", { projectLink: undefined, cwd: "/other" }),
];
const props: SidebarProps = {
  projects: [project],
  workspaces,
  activeWsId: "lead",
  connected: false,
  groupOverrides: {},
  searchQuery: "",
  searchHits: null,
  systemStatus: null,
  onSelect: noop,
  onDelete: noop,
  onToggleGroup: noop,
  onSearchChange: noop,
  onJump: noop,
  onCreate: noop,
  onCreateIn: noop,
  onReplayDemo: noop,
  onDebugSnapshot: noop,
  onPurgeArchived: noop,
};
function Drawer(extra: Partial<SidebarProps>) {
  const [groups, setGroups] = useState<Record<string, boolean>>({});
  return (
    <aside className="sidebar sidebar-open" style={{ width: 260, height: "100dvh" }}>
      <Sidebar
        {...props}
        {...extra}
        groupOverrides={groups}
        onToggleGroup={(key, open) => setGroups({ ...groups, [key]: open })}
      />
    </aside>
  );
}
const el = (s: string) => document.querySelector<HTMLElement>(s)!;
const rect = (s: string) => el(s).getBoundingClientRect();
const box = (s: string) => {
  const { left, top, right, bottom } = rect(s);
  return [left, top, right, bottom];
};
const edges = (s: string) => [rect(s).left, rect(s).right];
async function expectDisclosure(
  toggleSelector: string,
  open: boolean,
  caretSelector = ".events-toggle",
  duration = "0.12s",
) {
  const toggle = el(toggleSelector);
  const caret = toggle.querySelector<HTMLElement>(caretSelector)!;
  expect(toggle.getAttribute("aria-expanded")).toBe(String(open));
  expect(caret.textContent).toBe("▸");
  const style = getComputedStyle(caret);
  expect(style.display).toBe("flex");
  expect(style.alignItems).toBe("center");
  expect(style.justifyContent).toBe("center");
  if (duration === "0s") expect(style.transitionDuration).toBe("0s");
  else {
    expect(style.transitionProperty.split(", ")).toContain("transform");
    for (const value of style.transitionDuration.split(", ")) expect(value).toBe(duration);
  }
  await expect
    .poll(() => getComputedStyle(caret).transform)
    .toBe(open ? "matrix(0, 1, -1, 0, 0, 0)" : "none");
}
// Headless Chromium can hide the thumb but still lay out the stable gutter.
// Compare geometry with the platform's stable gutter, not a fixed pixel count.
function checkGutter(s: string, overflow: boolean) {
  const list = el(s);
  expect(list.scrollHeight > list.clientHeight).toBe(overflow);
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;width:100px;height:40px;overflow:auto;scrollbar-gutter:stable";
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  expect.soft(list.offsetWidth - list.clientWidth).toBe(width);
  expect.soft(getComputedStyle(list).scrollbarGutter).toBe("stable");
}
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});
for (const theme of ["light", "dark"])
  for (const width of [1280, 390])
    describe(`${theme} at ${width}px`, () => {
      async function viewport() {
        await page.viewport(width, 650);
        document.documentElement.dataset.theme = theme;
      }
      it("keeps disclosure labels, hit boxes and neighboring row edges stable across overflow", async () => {
        await viewport();
        render(<Drawer />);
        const group = ".ws-group-project",
          below = ".ws-group:last-child .ws-group-header";
        for (const toggle of [".ws-archive-toggle", ".ws-idle-toggle"]) {
          const mark = `${toggle} span:nth-child(2)`;
          const before = [box(mark), box(toggle), edges(group), edges(below)];
          const { x, y, width: w, height: h } = rect(mark);
          checkGutter(".task-list", false);
          for (const open of [true, false]) {
            await userEvent.click(el(mark));
            await expectDisclosure(toggle, open);
            checkGutter(".task-list", open);
            expect.soft([box(mark), box(toggle), edges(group), edges(below)]).toEqual(before);
            expect(el(toggle).contains(document.elementFromPoint(x + w / 2, y + h / 2))).toBe(true);
          }
        }
        await userEvent.click(el(".ws-idle-toggle"));
        const toggle = ".ws-group-toggle";
        await userEvent.hover(el(toggle));
        const before = [box(toggle), edges(group), edges(below)];
        for (const open of [false, true]) {
          await userEvent.click(el(toggle));
          await expectDisclosure(toggle, open);
          checkGutter(".task-list", open);
          expect.soft([box(toggle), edges(group), edges(below)]).toEqual(before);
        }
        const folder =
          ".ws-group > .ws-group-header:not(.ws-group-project):not(.ws-archived-header)";
        await userEvent.hover(el(folder));
        const folderBox = box(folder);
        const folderInitial = el(folder).getAttribute("aria-expanded") === "true";
        for (const open of [!folderInitial, folderInitial]) {
          await userEvent.click(el(`${folder} .ws-group-label`));
          await expectDisclosure(folder, open);
          expect(box(folder)).toEqual(folderBox);
        }
      });
      it("keeps the standalone archive header anchored while its sessions unfold", async () => {
        await viewport();
        render(
          <Drawer
            workspaces={[
              ...workspaces,
              ...Array.from({ length: 28 }, (_, i) =>
                ws(`loose-${i}`, { projectLink: undefined, archivedAt: 2 }),
              ),
            ]}
          />,
        );
        const header = ".ws-archived-header";
        const before = box(header);
        for (const open of [true, false]) {
          await userEvent.click(el(`${header} .ws-group-label`));
          await expectDisclosure(header, open);
          checkGutter(".task-list", open);
          expect(box(header)).toEqual(before);
        }
      });
      it("keeps the Archived projects header anchored while its shelf unfolds", async () => {
        await viewport();
        const shelvedProject = {
          ...project,
          id: "shelf",
          name: "Shelved",
          leadWorkspaceId: "shelf-lead",
          archivedAt: 2,
        };
        const shelfLead = ws("shelf-lead", {
          projectLink: { projectId: "shelf", role: "lead" },
          archivedAt: 2,
        });
        render(
          <Drawer projects={[project, shelvedProject]} workspaces={[...workspaces, shelfLead]} />,
        );
        const header = ".ws-shelf .ws-archived-header";
        const before = box(header);
        for (const open of [true, false]) {
          await userEvent.click(el(`${header} .ws-group-label`));
          await expectDisclosure(header, open);
          expect(box(header)).toEqual(before);
        }
      });
      if (width === 390)
        it("keeps touch group heights when the active session changes", async () => {
          await viewport();
          await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
          try {
            expect(matchMedia("(hover: none)").matches).toBe(true);
            const view = render(<Drawer />);
            const folder = ".ws-group:last-child .ws-group-header";
            const heights = () => [rect(folder).height, rect(".ws-group-project").height];
            const before = heights();
            view.rerender(<Drawer activeWsId="other" />);
            expect(heights()).toEqual(before);
            const add = rect(`${folder} .ws-group-add`);
            expect([add.width, add.height]).toEqual([32, 32]);
          } finally {
            await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
          }
        });
      it("keeps neighboring rows still on hover and active controls still on status updates", async () => {
        await viewport();
        const systemStatus = {
          osName: "Linux",
          osArch: "arm64",
          cpuModel: "test",
          cpuCores: 4,
          hostname: "test",
          cpuUsage: 9,
          memUsed: 1e9,
          memTotal: 12e9,
          uptime: 1,
        };
        const view = render(<Drawer systemStatus={systemStatus} />);
        await userEvent.click(el(".sidebar-debug"));
        const capture = "[aria-label='Capture debug snapshot']";
        const debugBox = box(capture);
        await userEvent.click(el(capture));
        await expect.poll(() => el(".sidebar-debug-status").textContent).toBe("Snapshot saved");
        expect(box(capture)).toEqual(debugBox);
        const below = ".ws-idle-toggle",
          header = ".ws-group-project";
        const folder = ".ws-group:last-child .ws-group-header";
        const folderBox = box(folder);
        await userEvent.hover(el(folder));
        expect(box(folder)).toEqual(folderBox);
        const idleBox = box(below);
        await userEvent.hover(el(`${header} .ws-group-label`));
        expect.soft(box(below)).toEqual(idleBox);
        const add = `${header} .ws-group-add`;
        await userEvent.hover(el(add));
        const target = box(add);
        const bars = () =>
          Array.from(document.querySelectorAll(".status-bar,.status-label"), (e) => [
            e.getBoundingClientRect().x,
            e.getBoundingClientRect().y,
          ]);
        const anchors = bars();
        const busy = ws("lead", {
          ...workspaces[0],
          agents: [
            { id: "a", name: "a", model: "m", avatar: "", color: "", isDefault: true, busy: true },
          ],
        });
        view.rerender(
          <Drawer
            workspaces={[busy, ...workspaces.slice(1)]}
            systemStatus={{ ...systemStatus, cpuUsage: 100, memUsed: 12e9 }}
          />,
        );
        expect(el(`${header} .task-status.running`)).toBeTruthy();
        expect(box(add)).toEqual(target);
        expect(box(below)).toEqual(idleBox);
        expect(bars()).toEqual(anchors);
      });
      it("keeps the first search result's reading width when more hits arrive", async () => {
        await viewport();
        const hit = {
          workspaceName: "repo",
          workspaceId: "w",
          messageId: "m",
          timestamp: 1,
          snippet: "matching message",
        };
        const view = render(<Drawer searchQuery="match" searchHits={[hit]} />);
        checkGutter(".search-results", false);
        const before = box(".search-result-snippet");
        view.rerender(<Drawer searchQuery="match" searchHits={Array(30).fill(hit)} />);
        checkGutter(".search-results", true);
        expect.soft(box(".search-result-snippet")).toEqual(before);
      });
      it("holds quota summary labels in place as digits change and details reach the scroll limit", async () => {
        await viewport();
        const quota = (usedPct: number) => ({
          refreshing: false,
          rows: Array.from({ length: 6 }, (_, i) => ({
            provider: "acp",
            name: `acct${i}`,
            availability: "available" as const,
            observedAt: 1,
            windows: [
              { label: "5h", usedPct },
              { label: "weekly", usedPct },
            ],
          })),
        });
        const view = render(<Drawer quota={quota(9)} onRefreshQuota={noop} />);
        const marks = () =>
          Array.from(
            el(".quota-row-toggle").querySelectorAll(".quota-win-label"),
            (e) => e.getBoundingClientRect().left,
          );
        const before = marks();
        view.rerender(<Drawer quota={quota(100)} onRefreshQuota={noop} />);
        expect.soft(marks()).toEqual(before);
        const narrow = marks();
        checkGutter(".quota-panel", false);
        for (const row of document.querySelectorAll(".quota-row-toggle")) {
          fireEvent.click(row);
          if (el(".quota-panel").scrollHeight > el(".quota-panel").clientHeight) break;
        }
        checkGutter(".quota-panel", true);
        expect.soft(marks()).toEqual(narrow);
      });
    });

it("disables every sidebar and quota caret transition in reduced motion", async () => {
  await page.viewport(1280, 650);
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    const quota = {
      refreshing: false,
      rows: [
        {
          provider: "acp",
          name: "acct",
          availability: "available" as const,
          observedAt: 1,
          windows: [{ label: "5h", usedPct: 9 }],
        },
      ],
    };
    const shelvedProject = {
      ...project,
      id: "shelf",
      name: "Shelved",
      leadWorkspaceId: "shelf-lead",
      archivedAt: 2,
    };
    const shelfLead = ws("shelf-lead", {
      projectLink: { projectId: "shelf", role: "lead" },
      archivedAt: 2,
    });
    render(
      <Drawer
        projects={[project, shelvedProject]}
        quota={quota}
        onRefreshQuota={noop}
        workspaces={[
          ...workspaces,
          shelfLead,
          ws("loose-archived", { projectLink: undefined, archivedAt: 2 }),
        ]}
      />,
    );
    const folder = ".ws-group > .ws-group-header:not(.ws-group-project):not(.ws-archived-header)";
    await expectDisclosure(
      folder,
      el(folder).getAttribute("aria-expanded") === "true",
      ".events-toggle",
      "0s",
    );
    await expectDisclosure(".ws-shelf .ws-archived-header", false, ".events-toggle", "0s");
    await expectDisclosure(".ws-group-toggle", true, ".events-toggle", "0s");
    await expectDisclosure(".ws-archive-toggle", false, ".events-toggle", "0s");
    await expectDisclosure(".ws-idle-toggle", false, ".events-toggle", "0s");
    await expectDisclosure(".ws-archived-header", false, ".events-toggle", "0s");
    await expectDisclosure(".quota-row-toggle", false, ".quota-caret", "0s");
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});
