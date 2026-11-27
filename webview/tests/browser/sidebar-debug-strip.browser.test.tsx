import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { Sidebar, type SidebarProps } from "../../src/sidebar/Sidebar";
import "../../src/styles.css";

const TRIGGER = "Debug tools";
const TRIGGER_OFFLINE = "Debug tools (service diagnostics offline)";
const DIAGNOSTICS_OFFLINE = "Service diagnostics (offline)";
const DEMO = "Replay demo";
const SNAPSHOT = "Capture debug snapshot";
const noop = () => {};
const rect = (el: Element) => el.getBoundingClientRect();
const style = (el: Element) => getComputedStyle(el);
const get = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => {
  const element = root.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
};

const props: SidebarProps = {
  workspaces: [],
  activeWsId: null,
  connected: true,
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
  onCreateProject: noop,
  onCreateIn: noop,
  onReplayDemo: noop,
  onDebugSnapshot: () => Promise.resolve(),
  onPurgeArchived: noop,
};

function healthyProbe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ issues: [] }) })),
  );
}

function MobileDrawer({
  onDebugSnapshot,
  initialOpen = true,
}: {
  onDebugSnapshot: SidebarProps["onDebugSnapshot"];
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div className="app" style={{ height: "100dvh" }}>
      <button
        type="button"
        className={open ? "" : "mobile-menu-btn"}
        style={{ position: "fixed", top: 8, right: 8, zIndex: 200 }}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close drawer" : "Open drawer"}
      </button>
      <div className={`sidebar${open ? " sidebar-open" : ""}`}>
        <Sidebar
          {...props}
          connected={false}
          sidebarOpen={open}
          onDebugSnapshot={onDebugSnapshot}
        />
      </div>
      <main className="main-panel">
        <textarea aria-label="Chat input" style={{ marginTop: 64 }} />
      </main>
    </div>
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", location.pathname);
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

it("unfolds a right-aligned icon desktop strip without layout shift, focus theft, or auto-snapshot", async () => {
  await page.viewport(1280, 800);
  healthyProbe();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const { container } = render(
    <div className="app" style={{ height: "100dvh" }}>
      <aside className="sidebar" style={{ width: 280 }}>
        <Sidebar {...props} onDebugSnapshot={onDebugSnapshot} />
      </aside>
      <main className="main-panel">
        <textarea aria-label="Chat input" />
      </main>
    </div>,
  );
  const sidebar = get(container, ".sidebar");
  const header = get(container, ".sidebar-header");
  const mainPanel = get(container, ".main-panel");
  const chatInput = screen.getByRole("textbox", { name: "Chat input" });
  const trigger = screen.getByRole("button", { name: TRIGGER });
  const beforeMain = rect(mainPanel);

  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();

  await userEvent.click(chatInput);
  expect(document.activeElement).toBe(chatInput);
  await userEvent.click(trigger);
  expect(onDebugSnapshot).not.toHaveBeenCalled();
  // Real pointer click preserves composer focus and causes zero chat layout shift.
  expect(document.activeElement).toBe(chatInput);
  const afterMain = rect(mainPanel);
  expect(afterMain.left).toBe(beforeMain.left);
  expect(afterMain.top).toBe(beforeMain.top);
  expect(afterMain.width).toBe(beforeMain.width);
  expect(afterMain.height).toBe(beforeMain.height);

  const strip = get(container, ".sidebar-debug-strip");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-pressed")).toBe("true");
  expect(style(trigger).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(style(strip).animationName).toBe("chrome-reveal");
  expect(style(strip).visibility).toBe("visible");
  await expect.poll(() => style(strip).opacity).toBe("1");
  expect(rect(strip).top).toBeCloseTo(rect(header).bottom, 0);
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  expect(sidebar.scrollWidth).toBeLessThanOrEqual(sidebar.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

  const controls = [...strip.querySelectorAll<HTMLElement>("a, button")];
  expect(controls).toHaveLength(4);
  expect(controls).toContain(screen.getByRole("button", { name: "Send test push" }));
  for (const control of controls) {
    expect(rect(control).width).toBe(24);
    expect(rect(control).height).toBe(24);
    const svg = get<SVGSVGElement>(control, "svg.icon");
    expect(rect(svg).width).toBe(14);
    expect(rect(svg).height).toBe(14);
  }
  // Right-aligned toolbar: controls sit on the right half and align with # in .sidebar-header.
  expect(rect(controls[0]).left).toBeGreaterThan(rect(strip).left + rect(strip).width / 2);
  expect(rect(controls[controls.length - 1]).right).toBeCloseTo(rect(trigger).right, 0);

  // Interacting with the chat panel does not collapse the debug strip.
  await userEvent.click(chatInput);
  expect(container.querySelector(".sidebar-debug-strip")).not.toBeNull();

  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await userEvent.click(trigger);
  await userEvent.click(trigger);
  expect(style(get(container, ".sidebar-debug-strip")).animationName).toBe("none");
});

it.each(["dark", "light"])(
  "keeps the %s bell and title visually separate at desktop and mobile widths",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    window.yaatTheme = {
      get: () => (theme === "dark" ? "dark" : "light"),
      subscribe: () => () => {},
      toggle: noop,
    };
    try {
      healthyProbe();
      const view = (connected: boolean) => (
        <div className="sidebar sidebar-open" style={{ width: 260 }}>
          <Sidebar {...props} connected={connected} />
        </div>
      );
      const { container, rerender } = render(view(true));
      const bell = screen.getByRole("button", { name: "Notifications" });
      for (const width of [1280, 390]) {
        await page.viewport(width, 800);
        for (const connected of [true, false]) {
          rerender(view(connected));
          const range = document.createRange();
          range.selectNodeContents(get(container, ".sidebar-title"));
          expect(range.getBoundingClientRect().right).toBeLessThanOrEqual(rect(bell).left);
        }
        const next = screen.getByRole("button", { name: "Dark theme" });
        expect(rect(bell).width).toBe(rect(next).width);
        expect(style(bell).color).not.toBe("transparent");
      }
    } finally {
      delete window.yaatTheme;
      delete document.documentElement.dataset.theme;
    }
  },
);

it.each(["dark", "light"])(
  "shows test-push results to an unsubscribed browser in the %s debug strip",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      let failing = false;
      const fetch = vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              url.endsWith("/test")
                ? { accepted: 1, expired: 0, failed: failing ? 2 : 0 }
                : { issues: [] },
            ),
        }),
      );
      vi.stubGlobal("fetch", fetch);
      vi.stubGlobal("Notification", { permission: "denied" });
      const { container } = render(
        <div className="sidebar sidebar-open" style={{ width: 280 }}>
          <Sidebar
            {...props}
            onDebugSnapshot={() =>
              failing ? Promise.reject(new Error("Offline test")) : Promise.resolve()
            }
          />
        </div>,
      );
      expect(
        screen.getByRole("button", { name: "Notifications" }).getAttribute("aria-pressed"),
      ).toBe("false");
      fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
      const strip = get(container, ".sidebar-debug-strip");
      const push = screen.getByRole("button", { name: "Send test push" });
      for (const width of [1280, 390]) {
        await page.viewport(width, 800);
        for (const failure of [false, true]) {
          failing = failure;
          await userEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
          const snapshotText = failure ? "Snapshot failed" : "Snapshot saved";
          const snapshotColor = style(await screen.findByText(snapshotText)).color;
          expect(push.hasAttribute("disabled")).toBe(false);
          await userEvent.click(push);
          const result = await screen.findByText(failure ? "2 failed · 1 accepted" : "1 accepted");
          expect(screen.queryByText(snapshotText)).toBeNull();
          expect(style(result).color).toBe(snapshotColor);
          // A narrow drawer may ellipsize the trailing count, but the primary result fits.
          const marks = document.createRange();
          marks.setStart(result.firstChild!, 0);
          marks.setEnd(result.firstChild!, (failure ? "2 failed" : "1 accepted").length);
          expect(marks.getBoundingClientRect().right).toBeLessThan(rect(result).right);
          expect(rect(result).right).toBeLessThanOrEqual(rect(push).left);
          expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
        }
      }
      expect(fetch.mock.calls.filter(([url]) => url.endsWith("/test"))).toHaveLength(4);
    } finally {
      delete document.documentElement.dataset.theme;
    }
  },
);

it("fits the offline 280px mobile drawer with touch targets, single moving dot, and drawer-close reset", async () => {
  await page.viewport(390, 844);
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const { container } = render(<MobileDrawer onDebugSnapshot={onDebugSnapshot} />);
  const sidebar = get(container, ".sidebar");
  const header = get(container, ".sidebar-header");
  expect(sidebar.textContent).toContain("offline");
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();

  const collapsedTrigger = screen.getByRole("button", { name: TRIGGER_OFFLINE });
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(1);
  expect(collapsedTrigger.querySelector(".sidebar-debug-dot")).not.toBeNull();

  fireEvent.click(collapsedTrigger);
  const strip = get(container, ".sidebar-debug-strip");
  await expect.poll(() => style(strip).opacity).toBe("1");
  expect(onDebugSnapshot).not.toHaveBeenCalled();

  const diagnostics = screen.getByRole("link", { name: DIAGNOSTICS_OFFLINE });
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: TRIGGER }).querySelector(".sidebar-debug-dot"),
  ).toBeNull();
  expect(diagnostics.querySelector(".sidebar-debug-dot")).not.toBeNull();

  expect(rect(strip).top).toBeCloseTo(rect(header).bottom, 0);
  expect(rect(strip).left).toBeGreaterThanOrEqual(0);
  expect(rect(strip).right).toBeLessThanOrEqual(280);
  expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  expect(sidebar.scrollWidth).toBeLessThanOrEqual(280);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  for (const control of strip.querySelectorAll("a, button")) {
    expect(rect(control).left).toBeGreaterThanOrEqual(0);
    expect(rect(control).right).toBeLessThanOrEqual(280);
    expect(rect(control).width).toBe(36);
    expect(rect(control).height).toBe(36);
    const svg = get<SVGSVGElement>(control, "svg.icon");
    expect(rect(svg).width).toBe(14);
    expect(rect(svg).height).toBe(14);
  }

  fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();
  expect(screen.getByRole("button", { name: TRIGGER_OFFLINE }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();
  expect(screen.getByRole("button", { name: TRIGGER_OFFLINE }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("keeps ?debug=1 controls untabbable and ignores Escape while the initial mobile drawer is closed", async () => {
  await page.viewport(390, 844);
  history.replaceState(null, "", "?debug=1");
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const { container } = render(
    <MobileDrawer onDebugSnapshot={onDebugSnapshot} initialOpen={false} />,
  );
  const strip = get(container, ".sidebar-debug-strip");
  const chatInput = screen.getByRole("textbox", { name: "Chat input" });
  expect(style(strip).display).toBe("none");
  expect(onDebugSnapshot).not.toHaveBeenCalled();

  const focused: string[] = [];
  for (let i = 0; i < 10; i++) {
    await userEvent.tab();
    const active = document.activeElement;
    focused.push(active?.textContent ?? "", active?.getAttribute("aria-label") ?? "");
  }
  expect(focused).not.toContain(DIAGNOSTICS_OFFLINE);
  expect(focused).not.toContain(DEMO);
  expect(focused).not.toContain(SNAPSHOT);

  // Escape in chat must not focus the offscreen # trigger while the mobile drawer is closed.
  await userEvent.click(chatInput);
  expect(document.activeElement).toBe(chatInput);
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(chatInput);
  expect(container.querySelector(".sidebar-debug-strip")).not.toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
  expect(style(strip).display).toBe("flex");
  expect(screen.getByRole("button", { name: TRIGGER }).getAttribute("aria-expanded")).toBe("true");
  expect(onDebugSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});
