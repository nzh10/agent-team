import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";
import { SessionStats } from "../../src/panels/SessionStats";
import { SidePanel } from "../../src/panels/SidePanel";
import { UsageDashboard } from "../../src/usage/UsageDashboard";
import { CreateProjectDialog } from "../../src/workspace/dialogs";
import { UiDialogModal } from "../../src/workspace/UiDialogModal";
import { overviewResponse, usageUrl } from "../usageFixtures";
import "../../src/styles.css";

function paint(control: Locator) {
  const { backgroundColor, borderTopColor, color, opacity } = getComputedStyle(control.element());
  return { backgroundColor, borderTopColor, color, opacity };
}

type Paint = ReturnType<typeof paint>;

async function expectEnabledPaint(control: Locator, away: Locator, hoverChanges: boolean) {
  await expect.element(control).toBeEnabled();
  await away.hover();
  const rest = paint(control);
  await control.hover();
  expect(control.element().matches(":hover")).toBe(true);
  if (hoverChanges) {
    await expect.poll(() => paint(control)).not.toEqual(rest);
  } else {
    expect(paint(control)).toEqual(rest);
  }
  await away.hover();
  await expect.poll(() => paint(control)).toEqual(rest);
  return rest;
}

async function expectDisabledPaint(control: Locator, away: Locator, enabled: Paint) {
  await expect.element(control).toBeDisabled();
  await away.hover();
  const rest = paint(control);
  expect(rest).not.toEqual(enabled);
  expect(getComputedStyle(control.element()).cursor).toBe("not-allowed");
  await control.hover();
  expect(control.element().matches(":hover")).toBe(true);
  // A shared button may transition its background; compare after any hover transition.
  await Promise.all(
    control
      .element()
      .getAnimations()
      .map((animation) => animation.finished),
  );
  expect(paint(control)).toEqual(rest);
}

async function tabFrom(before: Locator, next: Locator) {
  (before.element() as HTMLElement).focus();
  await userEvent.tab();
  await expect.element(next).toHaveFocus();
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe.each(["light", "dark"])("shared disabled controls in %s", (theme) => {
  async function setTheme() {
    document.documentElement.dataset.theme = theme;
    await page.viewport(1000, 800);
  }

  it("SidePanel Pin loses hover and activation when narrowing prevents docking", async () => {
    await setTheme();
    const pin = vi.fn();
    render(
      <SidePanel
        title="Files"
        pinned={false}
        maximized={false}
        inset={230}
        width={null}
        onPin={pin}
        onMaximize={vi.fn()}
        onClose={vi.fn()}
        onWidth={vi.fn()}
      >
        Repository files
      </SidePanel>,
    );
    const maximize = page.getByRole("button", { name: "Maximise over the chat" });
    const close = page.getByRole("button", { name: "Close Files" });
    const enabledPin = page.getByRole("button", { name: "Pin beside the chat", exact: true });
    const enabled = await expectEnabledPaint(enabledPin, maximize, true);
    await tabFrom(maximize, enabledPin);
    await userEvent.keyboard("{Enter}");
    expect(pin).toHaveBeenCalledOnce();

    // Remain above the layout breakpoint that hides Pin entirely.
    await page.viewport(840, 800);
    const disabledPin = page.getByRole("button", { name: "Too narrow to pin beside the chat" });
    await expectDisabledPaint(disabledPin, maximize, enabled);
    await tabFrom(maximize, close);
    await disabledPin.click({ force: true });
    expect(pin).toHaveBeenCalledOnce();
  });

  it("SessionStats excludes Load older turns while the next page is loading", async () => {
    await setTheme();
    const fetchStats = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          turns: [{ turnId: "newest", trigger: "manual", steps: [] }],
          total: 2,
          offset: 0,
          limit: 20,
        }),
      )
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchStats);
    render(
      <>
        <SessionStats workspaceId="w1" connected agents={[]} />
        <button type="button">After stats</button>
      </>,
    );
    const summary = page.getByText("Turn 2 · manual · 0 steps");
    const more = page.getByRole("button", { name: "Load older turns" });
    const enabled = await expectEnabledPaint(more, summary, true);
    await tabFrom(summary, more);
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Loading session stats…")).toBeVisible();
    expect(fetchStats).toHaveBeenNthCalledWith(
      2,
      "api/workspaces/w1/stats?offset=1&limit=20",
      expect.any(Object),
    );

    await expectDisabledPaint(more, summary, enabled);
    await tabFrom(summary, page.getByRole("button", { name: "After stats" }));
    await more.click({ force: true });
    expect(fetchStats).toHaveBeenCalledTimes(2);
  });

  it("UiDialogModal disables its options and Cancel after responding", async () => {
    await setTheme();
    // A failed send lets us exercise Cancel while enabled before accepting a choice.
    const respond = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const dialog = {
      requestId: "request-1",
      workspaceId: "w1",
      agentId: "a1",
      processGeneration: 3,
      method: "select" as const,
      title: "Permission needed",
      options: ["Allow", "Deny"],
      timeoutMs: 60_000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    render(<UiDialogModal dialog={dialog} onRespond={respond} />);
    const frame = page.getByRole("dialog", { name: dialog.title });
    const heading = frame.getByText(dialog.title, { exact: true });
    const allow = frame.getByRole("button", { name: "Allow" });
    const deny = frame.getByRole("button", { name: "Deny" });
    const cancel = frame.getByRole("button", { name: "Cancel" });
    // The initially focused option already has the hover paint; move focus to the frame.
    (frame.element() as HTMLElement).focus();
    const enabledAllow = await expectEnabledPaint(allow, heading, true);
    const enabledDeny = await expectEnabledPaint(deny, heading, true);
    const enabledCancel = await expectEnabledPaint(cancel, heading, true);
    await tabFrom(allow, deny);
    await userEvent.tab();
    await expect.element(cancel).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(respond).toHaveBeenNthCalledWith(1, dialog, { cancelled: true });
    await tabFrom(allow, deny);
    await userEvent.keyboard("{Enter}");
    expect(respond).toHaveBeenNthCalledWith(2, dialog, { value: "Deny" });

    for (const [control, enabled] of [
      [allow, enabledAllow],
      [deny, enabledDeny],
      [cancel, enabledCancel],
    ] as const) {
      await expectDisabledPaint(control, heading, enabled);
      await control.click({ force: true });
    }
    await tabFrom(frame, frame);
    await userEvent.keyboard("{Enter}");
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("CreateProjectDialog skips and does not edit the repository path in Gitless mode", async () => {
    await setTheme();
    const list = vi.fn();
    render(<CreateProjectDialog onClose={vi.fn()} onCreate={vi.fn()} onListDirs={list} />);
    const name = page.getByRole("textbox", { name: "Name" });
    const path = page.getByRole("combobox", { name: "Repository path" });
    const gitless = page.getByRole("checkbox", { name: "Create without a Git repository" });
    const enabled = await expectEnabledPaint(path, gitless, false);
    await tabFrom(name, path);
    expect(paint(path).borderTopColor).not.toBe(enabled.borderTopColor);
    // One input event: this tests disabling the field, not typing faster than its debounce.
    await path.fill("/repo");
    await expect.element(path).toHaveValue("/repo");
    await expect.poll(() => list.mock.calls).toEqual([["/repo"]]);

    await gitless.click();
    await expectDisabledPaint(path, gitless, enabled);
    await tabFrom(name, gitless);
    await path.click({ force: true });
    await userEvent.keyboard("ignored");
    await expect.element(path).toHaveValue("/repo");
    expect(list).toHaveBeenCalledOnce();
  });

  it("UsageDashboard excludes Granularity from long-window interaction", async () => {
    await setTheme();
    const fetchUsage = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(overviewResponse()));
    vi.stubGlobal("fetch", fetchUsage);
    render(<UsageDashboard onClose={vi.fn()} />);
    const window = page.getByRole("combobox", { name: "Window (UTC)" });
    const granularity = page.getByRole("combobox", { name: "Granularity" });
    const unit = page.getByRole("combobox", { name: "Reporting unit" });
    await window.selectOptions("7d");
    const enabled = await expectEnabledPaint(granularity, unit, false);
    await tabFrom(window, granularity);
    expect(paint(granularity).borderTopColor).not.toBe(enabled.borderTopColor);
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(granularity).toHaveValue("hour");
    expect(usageUrl(fetchUsage.mock.lastCall![0]).searchParams.get("granularity")).toBe("hour");

    await window.selectOptions("30d");
    const requestCount = fetchUsage.mock.calls.length;
    await expectDisabledPaint(granularity, unit, enabled);
    await tabFrom(window, unit);
    await granularity.click({ force: true });
    await expect.element(granularity).not.toHaveFocus();
    await expect.element(granularity).toHaveValue("day");
    expect(fetchUsage).toHaveBeenCalledTimes(requestCount);
  });
});
