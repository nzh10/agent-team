import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { QUOTA_STALE_AFTER, type QuotaState } from "../../../service/src/session/quota-schema";
import { QuotaPanel, Sidebar, type SidebarProps } from "../../src/sidebar/Sidebar";
import type { Workspace } from "../../src/state/useServer";
import "../../src/styles.css";

const NOW = 1_800_000_000_000;

const sampleWorkspace: Workspace = {
  id: "w1",
  name: "main-workspace",
  project: "yaat",
  cwd: "/repo",
  hostId: "local",
  agents: [],
  messages: [],
  createdAt: NOW - 60_000,
};

const sampleQuota: QuotaState = {
  refreshing: false,
  rows: [
    {
      provider: "openai-codex",
      name: "Codex",
      availability: "available",
      observedAt: NOW - 15_000,
      windows: [
        { label: "5h", usedPct: 40, resetsAt: NOW + 2 * 3_600_000 },
        { label: "weekly", usedPct: 62, resetsAt: NOW + 4 * 86_400_000 },
      ],
    },
    {
      provider: "kimi-coding",
      name: "Kimi Code",
      availability: "available",
      observedAt: NOW - 20_000,
      windows: [
        { label: "5h", usedPct: 18 },
        { label: "monthly total", usedPct: 86, resetsAt: NOW + 10 * 86_400_000 },
        { label: "monthly code", usedPct: 54 },
      ],
    },
    {
      provider: "antigravity-acp",
      name: "Gemini 3 Pro Preview",
      availability: "available",
      observedAt: NOW - 180_000,
      windows: [{ label: "5h", usedPct: 35, resetsAt: NOW + 3_600_000 }],
    },
    {
      provider: "antigravity-acp",
      name: "Flash",
      availability: "unavailable",
      reason: "usage unavailable",
      observedAt: NOW - 300_000,
      windows: [{ label: "5h", usedPct: 88 }],
    },
    {
      provider: "native-codex",
      name: "extra",
      availability: "unavailable",
      reason: "not configured",
      observedAt: 0,
      windows: [],
    },
  ],
};

function renderSidebar(quota: QuotaState, onRefreshQuota = vi.fn(), mobileOpen = false) {
  const noop = () => {};
  const props: SidebarProps = {
    workspaces: [sampleWorkspace],
    activeWsId: "w1",
    connected: true,
    groupOverrides: {},
    finishedStatus: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: {
      osName: "Darwin",
      osArch: "arm64",
      cpuModel: "Apple M3",
      cpuCores: 8,
      hostname: "dev",
      cpuUsage: 22,
      memUsed: 4 * 1024 ** 3,
      memTotal: 16 * 1024 ** 3,
      uptime: 3600,
    },
    quota,
    onRefreshQuota,
    now: NOW,
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
  return render(
    <div className="app" style={{ height: "100dvh", display: "flex" }}>
      <aside
        className={`sidebar${mobileOpen ? " sidebar-open" : ""}`}
        style={mobileOpen ? undefined : { width: "260px" }}
      >
        <Sidebar {...props} />
      </aside>
    </div>,
  );
}

afterEach(() => {
  cleanup();
});

it("renders compact quota rows on desktop with threshold colors, error badges, and click/keyboard inline expansion", async () => {
  await page.viewport(1280, 800);
  const onRefresh = vi.fn();
  const view = renderSidebar(sampleQuota, onRefresh);

  const sidebar = view.container.querySelector<HTMLElement>(".sidebar")!;
  const panel = view.container.querySelector<HTMLElement>(".quota-panel")!;
  expect(panel.getAttribute("aria-label")).toBe("Quota used");
  expect(panel.querySelector(".quota-heading")?.textContent).toBe("Quota used");
  expect(panel.querySelector('[role="progressbar"]')).toBeNull();

  // Compact default height fits comfortably without internal scrollbars.
  const collapsedHeight = panel.getBoundingClientRect().height;
  expect(collapsedHeight).toBeLessThan(200);
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);

  const toggles = [...panel.querySelectorAll<HTMLButtonElement>(".quota-row-toggle")];
  expect(toggles).toHaveLength(5);
  expect(toggles.map((b) => b.querySelector(".quota-name")?.textContent)).toEqual([
    "Codex",
    "Kimi",
    "Agy · Gemini 3 Pro Preview",
    "Agy · Flash",
    "Codex · extra",
  ]);
  for (const btn of toggles) {
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getBoundingClientRect().right).toBeLessThanOrEqual(
      sidebar.getBoundingClientRect().right + 0.5,
    );
  }

  // Distinct threshold coloring for normal (<50%), warn (>=50%), and danger (>=80%).
  const normalColor = getComputedStyle(panel.querySelector(".quota-pct-normal")!).color;
  const warnColor = getComputedStyle(panel.querySelector(".quota-pct-warn")!).color;
  const dangerColor = getComputedStyle(panel.querySelector(".quota-pct-danger")!).color;
  expect(warnColor).not.toBe(normalColor);
  expect(dangerColor).not.toBe(normalColor);
  expect(dangerColor).not.toBe(warnColor);

  // A transient error is independent of the healthy-row stale indicator.
  expect(toggles[2].querySelector(".quota-badge-stale")).toBeNull();
  expect(toggles[3].querySelector(".quota-badge-error")?.textContent).toBe("!");
  expect(toggles[3].querySelector(".quota-badge-stale")).toBeNull();
  expect(toggles[4].querySelector(".quota-badge-error")).toBeNull();
  expect(toggles[4].querySelector(".quota-summary")?.textContent).toBe("not configured");

  // Click expands Kimi inline directly underneath its row and shows all 3 windows.
  fireEvent.click(toggles[1]);
  expect(toggles[1].getAttribute("aria-expanded")).toBe("true");
  expect(onRefresh).toHaveBeenLastCalledWith(false, ["kimi-coding"]);
  const kimiDetails = document.getElementById(toggles[1].getAttribute("aria-controls")!)!;
  expect(kimiDetails).toBeTruthy();
  expect(kimiDetails.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    toggles[1].getBoundingClientRect().bottom - 1,
  );
  expect(kimiDetails.getBoundingClientRect().right).toBeLessThanOrEqual(
    sidebar.getBoundingClientRect().right + 0.5,
  );
  expect(kimiDetails.textContent).toContain("5h: 18% used");
  expect(kimiDetails.textContent).toContain("Monthly total: 86% used");
  expect(kimiDetails.textContent).toContain("Monthly code: 54% used");
  expect(kimiDetails.textContent).toContain("Resets");
  expect(kimiDetails.textContent).toContain("Updated just now");
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);

  // Keyboard Enter and Space toggle expansion inline.
  toggles[0].focus();
  await userEvent.keyboard("{Enter}");
  expect(toggles[0].getAttribute("aria-expanded")).toBe("true");
  const codexDetails = document.getElementById(toggles[0].getAttribute("aria-controls")!)!;
  expect(codexDetails.textContent).toContain("5h: 40% used");
  expect(codexDetails.textContent).toContain("Weekly: 62% used");
  await userEvent.keyboard(" ");
  expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(toggles[0].getAttribute("aria-controls")!)).toBeNull();

  // Refresh button works from the compact header.
  fireEvent.click(panel.querySelector<HTMLButtonElement>(".quota-refresh")!);
  expect(onRefresh.mock.calls).toEqual([
    [false, ["kimi-coding"]],
    [false, ["openai-codex"]],
    [true],
  ]);
});

it("animates the dedicated quota refresh icon while refreshing", () => {
  const { container } = render(
    <QuotaPanel quota={{ rows: [], refreshing: true }} now={NOW} connected />,
  );
  const icon = container.querySelector(".quota-refresh svg.icon")!;
  expect(icon).not.toBeNull();
  expect(getComputedStyle(icon).animationName).toBe("quota-spin");
});

it("gives explicit setup instructions and distinguishes warming from a transient quota error", () => {
  const waitingRows = [
    ["antigravity-acp", "waiting for ACP setup"],
    ["openai-codex", "waiting for Pi session"],
    ["kimi-coding", "usage unavailable"],
  ] as const;
  const view = renderSidebar({
    refreshing: false,
    acpPrepareStep: "yaat-service prepare-acp",
    rows: waitingRows.map(([provider, reason]) => ({
      provider,
      reason,
      name: "",
      observedAt: NOW - 1,
      availability: "unavailable",
      windows: [],
    })),
  });
  const [acp, codex, kimi] =
    view.container.querySelectorAll<HTMLButtonElement>(".quota-row-toggle");
  expect(acp.querySelector(".quota-summary")?.textContent).toBe("waiting for setup");
  expect(codex.querySelector(".quota-summary")?.textContent).toBe("warming up");
  expect(acp.querySelector(".quota-badge-error")).toBeNull();
  expect(codex.querySelector(".quota-badge-error")).toBeNull();
  expect(kimi.querySelector(".quota-badge-error")?.textContent).toBe("!");
  expect(kimi.querySelector(".quota-summary")?.textContent).toContain("usage unavailable");
  fireEvent.click(acp);
  const details = document.getElementById(acp.getAttribute("aria-controls")!)!;
  expect(details.textContent).toContain("Waiting for explicit ACP setup");
  expect(details.querySelector("code")?.textContent).toBe("yaat-service prepare-acp");
  expect(details.textContent).toContain("Not yet observed");
});

it("marks only healthy rows stale at QUOTA_STALE_AFTER and keeps failed cached rows fresh-age aware", () => {
  const observedAt = NOW - 14 * 60_000;
  const quota: QuotaState = {
    refreshing: false,
    rows: [
      {
        provider: "acp",
        name: "healthy",
        availability: "available",
        observedAt,
        windows: [{ label: "5h", usedPct: 20 }],
      },
      {
        provider: "acp",
        name: "failed",
        availability: "unavailable",
        reason: "usage unavailable",
        observedAt,
        windows: [{ label: "5h", usedPct: 70 }],
      },
    ],
  };
  const view = render(<QuotaPanel quota={quota} now={NOW} connected={false} />);
  const healthy = view.getByRole("button", { name: /acp · healthy/ });
  const failed = view.getByRole("button", { name: /acp · failed/ });
  expect(healthy.textContent).not.toContain("stale");
  expect(failed.querySelector(".quota-badge-error")?.textContent).toBe("!");
  expect(failed.textContent).not.toContain("stale");

  fireEvent.click(failed);
  expect(view.getByText(/Updated 14m ago/)).toBeTruthy();
  view.rerender(
    <QuotaPanel quota={quota} now={NOW + (QUOTA_STALE_AFTER - 14 * 60_000)} connected={false} />,
  );
  expect(healthy.textContent).toContain("stale");
  expect(failed.textContent).not.toContain("stale");
  expect(failed.textContent).toContain("70%");
  expect(view.getByText(/Updated 15m ago/)).toBeTruthy();
});

it("maintains >= 32px touch targets and zero horizontal overflow inside the 280px mobile drawer", async () => {
  await page.viewport(390, 760);
  const view = renderSidebar(sampleQuota, vi.fn(), true);

  const sidebar = view.container.querySelector<HTMLElement>(".sidebar")!;
  const panel = view.container.querySelector<HTMLElement>(".quota-panel")!;
  const sidebarRect = sidebar.getBoundingClientRect();
  expect(Math.round(sidebarRect.width)).toBe(280);

  const refreshBtn = panel.querySelector<HTMLButtonElement>(".quota-refresh")!;
  expect(refreshBtn.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
  expect(refreshBtn.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);

  const toggles = [...panel.querySelectorAll<HTMLButtonElement>(".quota-row-toggle")];
  expect(toggles).toHaveLength(5);
  for (const btn of toggles) {
    const r = btn.getBoundingClientRect();
    expect(r.height).toBeGreaterThanOrEqual(32);
    expect(r.left).toBeGreaterThanOrEqual(sidebarRect.left);
    expect(r.right).toBeLessThanOrEqual(sidebarRect.right + 0.5);
  }
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);

  // Expand an available row and an error row in the 280px drawer; still no horizontal overflow.
  fireEvent.click(toggles[2]);
  fireEvent.click(toggles[3]);
  expect(toggles[2].getAttribute("aria-expanded")).toBe("true");
  expect(toggles[3].getAttribute("aria-expanded")).toBe("true");
  const details = [...panel.querySelectorAll<HTMLElement>(".quota-details")];
  expect(details).toHaveLength(2);
  for (const d of details) {
    expect(d.getBoundingClientRect().right).toBeLessThanOrEqual(sidebarRect.right + 0.5);
  }
  expect(details[0].textContent).toContain("Updated 3m ago");
  expect(details[0].textContent).not.toContain("stale");
  expect(details[1].textContent).toContain("unavailable · usage unavailable");
  expect(details[1].textContent).toContain("Updated 5m ago");
  expect(details[1].textContent).not.toContain("stale");
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
});
