import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { UsageDashboard } from "../../src/usage/UsageDashboard";
import { FakeSocket } from "../fakeSocket";
import { mountFixedApp } from "../helpers/browser";
import { paintedContrast } from "../helpers/contrast";
import { deferred } from "../helpers/deferred";
import {
  compaction,
  journeyResponse,
  observation,
  overviewResponse,
  recordsUntil,
  usageUrl,
} from "../usageFixtures";
import "../../src/styles.css";

function bounds(element: Element | Range) {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

function textBounds(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  return bounds(range);
}

function expectTextContained(element: Element, label: string) {
  const box = bounds(element);
  const text = textBounds(element);
  expect(text.x, `${label}: text left`).toBeGreaterThanOrEqual(box.x - 0.5);
  expect(text.x + text.width, `${label}: text right`).toBeLessThanOrEqual(box.x + box.width + 0.5);
  expect(text.y, `${label}: text top`).toBeGreaterThanOrEqual(box.y - 0.5);
  expect(text.y + text.height, `${label}: text bottom`).toBeLessThanOrEqual(
    box.y + box.height + 0.5,
  );
}

const contrastRatio = (foreground: string, ...backgrounds: string[]) =>
  paintedContrast(foreground, backgrounds, { opaque: true, validateColors: true });

function expectNoHorizontalOverflow(dialog: HTMLElement, label: string) {
  const box = dialog.getBoundingClientRect();
  expect(box.left, `${label}: dialog left`).toBeGreaterThanOrEqual(-1);
  expect(box.right, `${label}: dialog right`).toBeLessThanOrEqual(window.innerWidth + 1);
  const regions: [string, HTMLElement][] = [
    ["document", document.documentElement],
    ["dialog", dialog],
    ["body", dialog.querySelector<HTMLElement>(".usage-body")!],
    ["actions", dialog.querySelector<HTMLElement>(".usage-actions")!],
    ...Array.from(
      dialog.querySelectorAll<HTMLElement>(".usage-card, .usage-row summary, .usage-pages"),
      (element, index): [string, HTMLElement] => [`${element.className}[${index}]`, element],
    ),
  ];
  for (const [name, element] of regions) {
    expect(element.scrollWidth, `${label}: ${name} horizontal overflow`).toBeLessThanOrEqual(
      element.clientWidth + 1,
    );
  }
}

afterEach(() => {
  cleanup();
  document.getElementById("root")?.remove();
  document.body.style.zoom = "";
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

it("opens the mobile overview without shifting chat and renders a bounded token chart and ranked models", async () => {
  await page.viewport(390, 760);
  vi.stubGlobal("WebSocket", FakeSocket);
  const ranking = Array.from({ length: 8 }, (_, index) => ({
    model: `model-${index + 1}`,
    tokens: 100 - index * 10,
  }));
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(overviewResponse({ ranking }));
  vi.stubGlobal("fetch", request);
  const { container } = mountFixedApp();
  const main = container.querySelector(".main-panel")!;
  const initialMain = bounds(main);
  await page.getByRole("button", { name: /^Open workspace menu/ }).click();
  const opener = page.getByRole("button", { name: "Usage", exact: true });
  expect(request).not.toHaveBeenCalled();
  await opener.click();

  const dialog = page.getByRole("dialog", { name: "Usage dashboard" });
  await expect.element(dialog.getByRole("img", { name: "Token types by UTC day" })).toBeVisible();
  await expect.element(dialog.getByRole("list", { name: "Ranked model totals" })).toBeVisible();
  const usageViews = screen.getByRole("group", { name: "Usage views" });
  const quickFilters = document.querySelector(".usage-quick-filters")!;
  const viewBounds = bounds(usageViews);
  const quickBounds = bounds(quickFilters);
  expect(
    viewBounds.y < quickBounds.y ||
      (viewBounds.y === quickBounds.y && viewBounds.x < quickBounds.x),
  ).toBe(true);
  screen.getByRole("button", { name: "Overview" }).focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Records" }));
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Window (UTC)" }));
  const panel = screen.getByRole("dialog");
  const { left, top, right, bottom } = panel.getBoundingClientRect();
  expect(left).toBeGreaterThanOrEqual(0);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(right).toBeLessThanOrEqual(window.innerWidth);
  expect(bottom).toBeLessThanOrEqual(window.innerHeight);
  const charts = panel.querySelectorAll("svg");
  expect(charts).toHaveLength(2);
  expect(charts[1].querySelectorAll("rect")).toHaveLength(6);
  expect(panel.querySelectorAll(".usage-overview-ranking li")).toHaveLength(6);
  for (const chart of charts) {
    const box = bounds(chart);
    expect(box.width).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(right);
    expect(box.height).toBeLessThan(200);
  }
  expect(
    Number(charts[0].querySelector("g:last-child .usage-fill-cacheWrite")?.getAttribute("height")),
  ).toBeGreaterThan(0);
  await expect
    .element(
      dialog
        .getByRole("list", { name: "Token types by UTC day legend" })
        .getByText("Cache write", { exact: true }),
    )
    .toBeVisible();
  const label = panel.querySelector<HTMLSpanElement>(".usage-overview-ranking span[title]")!;
  label.scrollIntoView({ block: "center" });
  const labelBox = label.getBoundingClientRect();
  expect(document.elementFromPoint(labelBox.left + 2, labelBox.top + labelBox.height / 2)).toBe(
    label,
  );
  const benchmark = dialog.getByText(/The 98% benchmark/);
  const inferenceMeasure = dialog.getByText(/Inferences with ≥96% cache reads/);
  await expect.element(inferenceMeasure).not.toBeVisible();
  await expect.element(dialog.getByRole("heading", { name: "Usage records" })).toBeVisible();
  await expect.element(benchmark).not.toBeVisible();
  await dialog.getByText("Measurement details and benchmarks").click();
  await expect.element(benchmark).toBeVisible();
  await expect.element(inferenceMeasure).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
  expect(bounds(main)).toEqual(initialMain);
});

it("shares instant picks and Enter-applied fuzzy filters with responsive numbered Records", async () => {
  await page.viewport(390, 760);
  const request = vi.fn<typeof fetch>().mockImplementation((url) => {
    const { pathname, searchParams } = usageUrl(url);
    if (pathname.endsWith("/overview")) return Promise.resolve(overviewResponse());
    const page = Number(searchParams.get("page"));
    const hasFilter = searchParams.has("model") || searchParams.has("workspace");
    const rows =
      page === 2
        ? [{ ...observation, model: "second-model" }]
        : hasFilter
          ? [{ ...observation, unit: "turn" as const }]
          : [compaction];
    return Promise.resolve(journeyResponse(rows, { page, total: hasFilter ? 31 : 1 }));
  });
  vi.stubGlobal("fetch", request);
  render(
    <UsageDashboard
      onClose={vi.fn()}
      workspaces={[
        { id: "ws-123456789", name: "Design workspace" },
        { id: "ws-987654321", name: "Design workspace" },
      ]}
    />,
  );
  const dialog = page.getByRole("dialog");
  const params = () => Object.fromEntries(usageUrl(request.mock.lastCall![0]).searchParams);
  const applied = async (action: () => Promise<unknown>, expected: Record<string, unknown>) => {
    const before = request.mock.calls.length;
    await action();
    await expect.poll(() => request.mock.calls.length).toBeGreaterThan(before);
    await expect.poll(params).toMatchObject(expected);
  };
  const select = (name: string, value: string) => () =>
    dialog.getByRole("combobox", { name, exact: true }).selectOptions(value);
  await applied(select("Window (UTC)", "7d"), { range: "7d" });
  await applied(select("Reporting unit", "turn"), { unit: "turn" });
  const rank = dialog.getByRole("button", { name: "example-model, 104 tokens" });
  await applied(() => rank.click(), { model: "example-model" });
  await expect.element(rank).toHaveAttribute("aria-pressed", "true");
  await applied(() => rank.click(), {});
  await expect.element(rank).toHaveAttribute("aria-pressed", "false");
  expect(params().model).toBeUndefined();
  await dialog.getByText("Filters", { exact: true }).click();
  await expect.element(dialog.getByRole("textbox", { name: /turn/i })).not.toBeInTheDocument();
  await applied(select("Source", "pi"), { source: "pi" });
  const workspace = dialog.getByRole("combobox", { name: "Workspace", exact: true });
  await expect
    .element(workspace.getByRole("option", { name: "Design workspace · ws-12345" }))
    .toBeInTheDocument();
  await expect
    .element(workspace.getByRole("option", { name: "Design workspace · ws-98765" }))
    .toBeInTheDocument();
  await applied(() => workspace.selectOptions("ws-123456789"), { workspace: "ws-123456789" });
  await applied(select("Model", "example-model"), { model: "example-model" });
  const channel = dialog.getByRole("textbox", { name: "Channel contains" });
  await channel.fill("  a&b  ");
  const workspaceText = dialog.getByRole("textbox", { name: "Workspace contains" });
  await workspaceText.fill("Archived title");
  expect(params().workspace).toBe("ws-123456789");
  expect(params().channel).toBeUndefined();
  await dialog
    .getByRole("textbox", { name: "Session ID (Pi / ACP / Codex) contains" })
    .fill("PI-sess");
  await userEvent.keyboard("{Enter}");
  const filters = {
    range: "7d",
    unit: "turn",
    granularity: "day",
    model: "example-model",
    channel: "a&b",
    source: "pi",
    workspace: "Archived title",
    session: "PI-sess",
  };
  await expect.poll(params).toEqual(filters);
  await dialog.getByRole("button", { name: "Records" }).click();
  const rows = dialog.getByRole("list", { name: "Recorded observations and events" });
  await expect.element(rows.getByText("example-model", { exact: true })).toBeVisible();
  expect(params()).toEqual({ ...filters, page: "1" });
  await expect.element(rows.getByText("01 Jun 2026, 00:00 UTC", { exact: true })).toBeVisible();
  await expect.element(rows.getByText(/^\(.*UTC[+-].*\)$/)).toBeVisible();
  const receipt = rows.getByText("inference-receipt", { exact: true });
  await expect.element(receipt).not.toBeVisible();
  await rows.getByText("example-model", { exact: true }).click();
  await expect.element(receipt).toBeVisible();
  await expect.element(rows.getByText(/API-equivalent · \$0.125 USD/)).toBeVisible();
  const pages = dialog.getByRole("form", { name: "Record pages" });
  const next = pages.getByRole("button", { name: "Next" });
  const previous = pages.getByRole("button", { name: "Previous" });
  await expect.element(previous).toBeDisabled();
  await next.click();
  await expect.element(rows.getByText("second-model")).toBeVisible();
  expect(params()).toEqual({ ...filters, page: "2", until: String(recordsUntil) });
  await expect.element(next).toBeDisabled();
  const { left, right } = screen.getByRole("dialog").getBoundingClientRect();
  const footer = screen.getByRole("form", { name: "Record pages" });
  for (const control of footer.querySelectorAll("button, input")) {
    const box = control.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(left);
    expect(box.right).toBeLessThanOrEqual(right);
  }
  await workspaceText.fill("Unapplied draft");
  await dialog.getByRole("button", { name: "Clear filters" }).click();
  await expect.element(rows.getByText("Context compacted")).toBeVisible();
  await expect.element(workspaceText).toHaveValue("");
  await expect.element(channel).toHaveValue("");
  await expect.element(previous).toBeDisabled();
  await expect
    .element(dialog.getByRole("list", { name: "Active filters" }))
    .not.toBeInTheDocument();
  expect(params()).toEqual({ range: "7d", unit: "turn", granularity: "day", page: "1" });
});

it.each(["light", "dark"])(
  "keeps results, geometry, scroll and focus continuous through delayed reloads in %s",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(1000, 620);
    const refreshReply = deferred<Response>();
    const failedReply = deferred<Response>();
    const retryReply = deferred<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(overviewResponse())
      .mockReturnValueOnce(refreshReply.promise)
      .mockReturnValueOnce(failedReply.promise)
      .mockReturnValueOnce(retryReply.promise);
    vi.stubGlobal("fetch", request);
    render(<UsageDashboard onClose={vi.fn()} />);
    await screen.findByText("Inference records");
    await page.getByText("Measurement details and benchmarks").click();

    const dialog = screen.getByRole("dialog");
    await document.fonts.ready;
    for (const animation of dialog.getAnimations()) animation.finish();
    const body = dialog.querySelector<HTMLElement>(".usage-body")!;
    const refresh = screen.getByRole("button", { name: "Refresh" });
    const filterSummary = dialog.querySelector(".usage-filters > summary")!;
    const loadState = dialog.querySelector(".usage-load-state")!;
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    body.scrollTop = Math.min(120, body.scrollHeight - body.clientHeight);
    const scrollTop = body.scrollTop;
    expect(scrollTop).toBeGreaterThan(0);
    const snapshot = () => ({
      dialog: bounds(dialog),
      refresh: bounds(refresh),
      filterSummary: bounds(filterSummary),
      loadState: bounds(loadState),
    });
    const initial = snapshot();

    refresh.focus();
    fireEvent.click(refresh);
    await screen.findByText("Updating usage…");
    expectTextContained(loadState, `${theme} 1000px pending`);
    expect(snapshot()).toEqual(initial);
    expect(body.scrollTop).toBe(scrollTop);
    expect(body.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(refresh);
    expect(screen.getByText("Inference records")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
    refreshReply.resolve(overviewResponse());
    await expect.element(page.getByText("Updating usage…")).not.toBeInTheDocument();

    const unit = screen.getByRole<HTMLSelectElement>("combobox", { name: "Reporting unit" });
    const beforeFailure = snapshot();
    unit.focus();
    fireEvent.change(unit, { target: { value: "turn" } });
    await screen.findByText("Updating usage…");
    expectTextContained(loadState, `${theme} 1000px pending before failure`);
    expect(snapshot()).toEqual(beforeFailure);
    expect(body.scrollTop).toBe(scrollTop);
    expect(document.activeElement).toBe(unit);
    expect(screen.getByText("Inference records")).toBeTruthy();
    expect(screen.queryByText("Turn records")).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
    failedReply.resolve(new Response(null, { status: 503 }));
    await screen.findByText("Update failed · previous results");
    expectTextContained(loadState, `${theme} 1000px error`);
    expect(snapshot()).toEqual(beforeFailure);
    expect(body.scrollTop).toBe(scrollTop);
    expect(body.getAttribute("aria-busy")).toBe("false");
    expect(document.activeElement).toBe(unit);
    expect(screen.getByText("Inference records")).toBeTruthy();
    expect(screen.queryByText("Turn records")).toBeNull();

    refresh.focus();
    fireEvent.click(refresh);
    await screen.findByText("Updating usage…");
    expect(snapshot()).toEqual(beforeFailure);
    expect(body.scrollTop).toBe(scrollTop);
    expect(document.activeElement).toBe(refresh);
    expect(request).toHaveBeenCalledTimes(4);
    retryReply.resolve(overviewResponse());
    await screen.findByText("Turn records");
    expect(screen.queryByText("Inference records")).toBeNull();
    expect(screen.queryByText("Update failed · previous results")).toBeNull();
    expect(screen.queryByText("Updating usage…")).toBeNull();
  },
);

it("gates retained Records pagination while a new query is pending or failed", async () => {
  await page.viewport(1000, 700);
  const filterReply = deferred<Response>();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(overviewResponse())
    .mockResolvedValueOnce(journeyResponse([observation], { total: 91 }))
    .mockReturnValueOnce(filterReply.promise);
  vi.stubGlobal("fetch", request);
  render(<UsageDashboard onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Records" }));
  await screen.findByText("Page 1 of 4 · 91 records");
  const next = screen.getByRole<HTMLButtonElement>("button", { name: "Next" });
  expect(next.disabled).toBe(false);

  fireEvent.click(document.querySelector(".usage-filters > summary")!);
  fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
    target: { value: "pi" },
  });
  await screen.findByText("Updating usage…");
  expect(next.disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(3);
  fireEvent.click(next);
  expect(request).toHaveBeenCalledTimes(3);

  await act(async () => {
    filterReply.resolve(new Response(null, { status: 503 }));
    await Promise.resolve();
  });
  await screen.findByText("Update failed · previous results");
  expect(next.disabled).toBe(true);
  fireEvent.click(next);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["light", "dark"].flatMap((theme) => [280, 390].map((width) => ({ theme, width }))))(
  "keeps narrow heading status and long filter chips bounded in $theme at $width",
  async ({ theme, width }) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(width, 700);
    const longModel = "enterprise-model-with-a-long-name-and-a-quantized-variant";
    const ranking = [{ model: longModel, tokens: 104 }];
    const failedReply = deferred<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(overviewResponse({ ranking }))
      .mockResolvedValueOnce(overviewResponse({ ranking, count: 3, promptBearing: 3 }))
      .mockResolvedValueOnce(overviewResponse({ ranking, count: 4, promptBearing: 4 }))
      .mockReturnValueOnce(failedReply.promise);
    vi.stubGlobal("fetch", request);
    render(<UsageDashboard onClose={vi.fn()} />);
    const rank = await screen.findByRole("button", { name: `${longModel}, 104 tokens` });
    fireEvent.click(rank);
    await screen.findByText("3 of 3 records with prompt tokens");
    fireEvent.click(document.querySelector(".usage-filters > summary")!);
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
      target: { value: "pi" },
    });
    await screen.findByText("4 of 4 records with prompt tokens");

    const modelChip = screen.getByRole("button", { name: `Remove model filter: ${longModel}` });
    const sourceChip = screen.getByRole("button", { name: "Remove source filter: Pi" });
    expect(getComputedStyle(modelChip).minHeight).toBe("28px");
    expect(getComputedStyle(sourceChip).minHeight).toBe("28px");
    expect(getComputedStyle(modelChip).whiteSpace).toBe("normal");
    expect(bounds(modelChip).height).toBeGreaterThan(bounds(sourceChip).height);
    expect(modelChip.scrollWidth).toBeLessThanOrEqual(modelChip.clientWidth + 1);

    fireEvent.change(screen.getByRole("combobox", { name: "Reporting unit" }), {
      target: { value: "turn" },
    });
    await screen.findByText("Updating usage…");
    const dialog = screen.getByRole("dialog");
    const heading = dialog.querySelector(".ui-dialog-heading")!;
    const title = dialog.querySelector(".dialog-title")!;
    const status = dialog.querySelector(".usage-load-state")!;
    for (const animation of dialog.getAnimations()) animation.finish();
    const pendingStatus = bounds(status);
    const expectBoundedHeading = () => {
      const titleBox = bounds(title);
      const statusBox = bounds(status);
      const dialogBox = bounds(dialog);
      expect(statusBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
      for (const box of [titleBox, statusBox]) {
        expect(box.x).toBeGreaterThanOrEqual(dialogBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
      }
      expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(
        bounds(heading).y + bounds(heading).height,
      );
      expectTextContained(title, `${theme} ${width}px title`);
      expectTextContained(status, `${theme} ${width}px status`);
    };
    expectBoundedHeading();
    await act(async () => {
      failedReply.resolve(new Response(null, { status: 503 }));
      await Promise.resolve();
    });
    await screen.findByText("Update failed · previous results");
    expect(bounds(status)).toEqual(pendingStatus);
    expectBoundedHeading();
  },
);

function mountUsagePages() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        usageUrl(url).pathname.endsWith("/overview")
          ? overviewResponse()
          : journeyResponse([observation], { total: 91 }),
      ),
    ),
  );
  render(<UsageDashboard onClose={vi.fn()} />);
}

const surfaceCases = ["light", "dark"].flatMap((theme) => [
  { theme, width: 1000, height: 800 },
  { theme, width: 390, height: 760 },
]);

it.each(surfaceCases)(
  "inherits dialog fonts and keeps Usage colors readable and numerals aligned in $theme at $width",
  async ({ theme, width, height }) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(width, height);
    mountUsagePages();
    await screen.findByText("92.31%");
    await document.fonts.ready;
    const dialog = screen.getByRole("dialog");

    for (const selector of [
      ".usage-kpis .usage-card > strong",
      ".usage-prices dd",
      ".usage-method dd",
      ".usage-axis",
      ".usage-overview-rank-label strong",
    ]) {
      const elements = dialog.querySelectorAll(selector);
      expect(elements.length, selector).toBeGreaterThan(0);
      for (const element of elements) {
        expect(getComputedStyle(element).fontVariantNumeric, selector).toBe("tabular-nums");
      }
    }

    fireEvent.click(screen.getByRole("button", { name: "Records" }));
    await screen.findByText("Page 1 of 4 · 91 records");
    const pageInput = screen.getByRole("spinbutton", { name: "Page number" });
    const dialogInput = screen.getByRole("textbox", { name: "Channel contains" });
    const bodyFont = getComputedStyle(document.body).fontFamily;
    expect(getComputedStyle(pageInput).fontFamily).toBe(getComputedStyle(dialogInput).fontFamily);
    expect(getComputedStyle(pageInput).fontFamily).toBe(bodyFont);
    expect(bodyFont).toContain("Sarasa Mono SC");
    expect(getComputedStyle(pageInput).fontSize).toBe(
      getComputedStyle(document.querySelector(".usage-pages")!).fontSize,
    );
    for (const selector of [".usage-row-total", ".usage-pages > span", ".usage-pages input"]) {
      const elements = dialog.querySelectorAll(selector);
      expect(elements.length, selector).toBeGreaterThan(0);
      for (const element of elements) {
        expect(getComputedStyle(element).fontVariantNumeric, selector).toBe("tabular-nums");
      }
    }

    const summary = dialog.querySelector<HTMLElement>(".usage-row summary")!;
    const surface = getComputedStyle(dialog).backgroundColor;
    const disclosureColor = () => getComputedStyle(summary, "::after").color;
    const summaryBackground = () => getComputedStyle(summary).backgroundColor;
    const expectContrast = (state: string, foreground: string, ...background: string[]) =>
      expect(
        contrastRatio(foreground, ...background),
        `${theme} ${width}: ${state} contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    const closedDisclosure = disclosureColor();
    expectContrast("resting disclosure", closedDisclosure, surface);

    await page.elementLocator(summary).hover();
    expect(summary.matches(":hover")).toBe(true);
    expect(summaryBackground()).not.toBe("rgba(0, 0, 0, 0)");
    expectContrast("hovered disclosure", disclosureColor(), surface, summaryBackground());

    // Move the pointer away, then reach each target by keyboard so :focus-visible is real.
    await page.getByRole("button", { name: "Refresh", exact: true }).hover();
    screen.getByRole("button", { name: "Records" }).focus();
    const tabTo = async (element: HTMLElement) => {
      for (let count = 0; count < 20 && document.activeElement !== element; count++) {
        await userEvent.keyboard("{Tab}");
      }
      expect(document.activeElement).toBe(element);
      expect(element.matches(":focus-visible")).toBe(true);
    };
    await tabTo(summary);
    expectContrast("keyboard-focused disclosure", disclosureColor(), surface, summaryBackground());
    await userEvent.keyboard("{Enter}");
    await screen.findByText("inference-receipt");
    expect(disclosureColor()).toBe(closedDisclosure);
    expectContrast(
      "open keyboard-focused disclosure",
      disclosureColor(),
      surface,
      summaryBackground(),
    );

    const filterLink = dialog.querySelector<HTMLElement>(".usage-filter-link")!;
    const filterColor = () => getComputedStyle(filterLink).color;
    const filterBackground = () => getComputedStyle(filterLink).backgroundColor;
    expectContrast("resting filter link", filterColor(), surface, filterBackground());
    await tabTo(filterLink);
    expectContrast("keyboard-focused filter link", filterColor(), surface, filterBackground());
    await page.elementLocator(filterLink).hover();
    expect(filterLink.matches(":hover")).toBe(true);
    expectContrast("hovered filter link", filterColor(), surface, filterBackground());
  },
);

const responsiveCases = ["light", "dark"].flatMap((theme) =>
  [
    { width: 390, height: 760, stepped: true },
    { width: 680, height: 800, stepped: true },
    { width: 681, height: 800, stepped: true },
    { width: 768, height: 800, stepped: true },
    { width: 844, height: 390, stepped: true },
    { width: 1000, height: 800, stepped: false },
  ].map((viewport) => ({ theme, ...viewport })),
);

it.each(responsiveCases)(
  "steps Usage typography up without horizontal overflow in $theme at $width x $height",
  async ({ theme, width, height, stepped }) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(width, height);
    mountUsagePages();
    await screen.findByText("92.31%");
    await document.fonts.ready;
    const dialog = screen.getByRole("dialog");
    for (const animation of dialog.getAnimations()) animation.finish();
    expect(matchMedia("(max-width: 768px), (max-height: 500px)").matches).toBe(stepped);
    const expected = {
      name: stepped ? "14px" : "13px",
      text: stepped ? "13px" : "12px",
      meta: stepped ? "12px" : "11px",
    };
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue("--fs-name").trim()).toBe(expected.name);
    expect(root.getPropertyValue("--fs-text").trim()).toBe(expected.text);
    expect(root.getPropertyValue("--fs-meta").trim()).toBe(expected.meta);

    const checkTypography = (records: boolean) => {
      const typed: [string, string][] = [[".usage-dialog .dialog-title", expected.name]];
      if (records) {
        typed.push([".usage-row-type", expected.meta], [".usage-pages", expected.text]);
      } else {
        typed.push(
          [".usage-card h3", expected.text],
          [".usage-card p", expected.meta],
          [".usage-overview-ranking button", expected.meta],
        );
      }
      for (const [selector, fontSize] of typed) {
        const element = dialog.querySelector(selector);
        expect(element, selector).not.toBeNull();
        expect(getComputedStyle(element!).fontSize, `${width}x${height}: ${selector}`).toBe(
          fontSize,
        );
      }
      if (records) {
        expect(
          getComputedStyle(screen.getByRole("spinbutton", { name: "Page number" })).fontSize,
        ).toBe(expected.text);
      } else {
        const hero = dialog.querySelector(".usage-kpis .usage-card > strong")!;
        const heroSize = Number.parseFloat(getComputedStyle(hero).fontSize);
        expect(heroSize).toBeGreaterThanOrEqual(16);
        expect(heroSize).toBeLessThanOrEqual(25);
      }
      expectNoHorizontalOverflow(
        dialog,
        `${theme} ${records ? "Records" : "Overview"} ${width}x${height}`,
      );
    };

    checkTypography(false);
    fireEvent.click(screen.getByRole("button", { name: "Records" }));
    await screen.findByText("Page 1 of 4 · 91 records");
    fireEvent.click(document.querySelector(".usage-filters > summary")!);
    fireEvent.click(document.querySelector(".usage-row summary")!);
    await screen.findByText("inference-receipt");
    checkTypography(true);
  },
);

it("aligns ranked bar origins with long labels at browser zoom", async () => {
  await page.viewport(1000, 800);
  const longModel = "enterprise-very-long-model-name-with-a-version-and-a-quantized-variant";
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      overviewResponse({
        ranking: [
          { model: longModel, tokens: 100 },
          { model: "short", tokens: 50 },
        ],
      }),
    ),
  );
  render(<UsageDashboard onClose={vi.fn()} />);
  const chart = await screen.findByRole("img", { name: "Ranked model tokens chart" });
  const label = document.querySelector(".usage-overview-rank-label")!;
  const bar = chart.querySelector("rect")!;
  for (const zoom of ["100%", "175%"]) {
    document.body.style.zoom = zoom;
    await new Promise(requestAnimationFrame);
    const scale = Number.parseInt(zoom, 10) / 100;
    const divergence = Math.abs(bounds(bar).x - bounds(label).x) / scale;
    // SVG rasterization is subpixel; the old one-CSS-pixel inset gap remains a failure.
    expect(
      divergence,
      `${zoom}: ${JSON.stringify({ bar: bounds(bar), label: bounds(label) })}`,
    ).toBeLessThan(0.5);
  }
});
