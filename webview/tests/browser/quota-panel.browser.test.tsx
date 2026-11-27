import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { QUOTA_STALE_AFTER, type QuotaState } from "../../../shared/quota";
import { Sidebar } from "../../src/sidebar/Sidebar";
import { QuotaPanel } from "../../src/sidebar/QuotaPanel";
import { workspace } from "../helpers/fixtures";
import { sidebarProps } from "../helpers/sidebar";
import "../../src/styles.css";

const NOW = 1_800_000_000_000;

const sampleWorkspace = workspace("w1", {
  name: "main-workspace",
  project: "yaat",
  createdAt: NOW - 60_000,
});

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
      windows: [{ label: "5h", usedPct: 100, resetsAt: NOW + 3_600_000 }],
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
  const props = sidebarProps({
    workspaces: [sampleWorkspace],
    activeWsId: "w1",
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
  });
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
  expect(collapsedHeight).toBeLessThan(145);
  expect(panel.querySelector(".quota-refresh")).toBeNull();
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

  // Moderate use stays quiet; only low (>=80%) and exhausted (100%) stand out.
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
  const toggleBox = toggles[1].getBoundingClientRect();
  const caret = toggles[1].querySelector(".quota-caret")!;
  expect(caret.textContent).toBe("▸");
  fireEvent.click(toggles[1]);
  expect(toggles[1].getAttribute("aria-expanded")).toBe("true");
  // Details grow the bottom-anchored panel upward; the caret itself adds no size shift.
  expect(toggles[1].getBoundingClientRect()).toMatchObject({
    width: toggleBox.width,
    height: toggleBox.height,
  });
  expect(getComputedStyle(caret).transitionProperty.split(", ")).toContain("transform");
  expect(getComputedStyle(caret).transitionDuration).toBe("0.12s");
  await expect.poll(() => getComputedStyle(caret).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
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

it("keeps pending refresh calm rather than animating", () => {
  const { container, getByRole } = render(
    <QuotaPanel quota={{ rows: [], refreshing: true }} refresh={vi.fn()} now={NOW} connected />,
  );
  expect((getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(getComputedStyle(container.querySelector(".quota-refresh svg.icon")!).animationName).toBe(
    "none",
  );
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

it("shows only observation detail, not a stale badge, when cached quota ages", () => {
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
  expect(healthy.textContent).not.toContain("stale");
  fireEvent.click(healthy);
  expect(view.getByText(/stale · Updated 15m ago/)).toBeTruthy();
  expect(failed.textContent).not.toContain("stale");
  expect(failed.textContent).toContain("70%");
  expect(view.getByText(/^Updated 15m ago$/)).toBeTruthy();
});

it("maintains >= 32px touch targets and zero horizontal overflow inside the 280px mobile drawer", async () => {
  await page.viewport(390, 760);
  const view = renderSidebar(sampleQuota, vi.fn(), true);

  const sidebar = view.container.querySelector<HTMLElement>(".sidebar")!;
  const panel = view.container.querySelector<HTMLElement>(".quota-panel")!;
  const sidebarRect = sidebar.getBoundingClientRect();
  expect(Math.round(sidebarRect.width)).toBe(280);

  expect(panel.querySelector(".quota-refresh")).toBeNull();

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
  const refreshBtn = panel.querySelector<HTMLButtonElement>(".quota-refresh")!;
  expect(refreshBtn.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
  expect(refreshBtn.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
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
