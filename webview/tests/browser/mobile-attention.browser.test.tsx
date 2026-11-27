import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import type { Workspace } from "../../src/state/useServer";
import { FakeSocket, initFrame } from "../fakeSocket";
import { mountFixedApp } from "../helpers/browser";
import { project as makeProject, workspace } from "../helpers/fixtures";
import "../../src/styles.css";

const NOW = Date.now();
const ws = (id: string, over: Partial<Workspace> = {}) =>
  workspace(id, { cwd: `/repo/${id}`, createdAt: NOW - 5000, lastMessageAt: NOW, ...over });
const active = ws("A");
const lead = ws("lead", {
  cwd: "/repo/project",
  projectLink: { projectId: "p1", role: "lead" },
});
const waiting = ws("B", {
  projectLink: { projectId: "p1", role: "worker" },
  awaitsUser: true,
});
const unread = ws("C", {
  projectLink: { projectId: "p1", role: "worker" },
  unread: 8,
});
const project = makeProject("p1", { root: "/repo/project", createdAt: NOW - 10_000 });

let session: ReturnType<typeof cdp> | null = null;
let stopErrorCapture: (() => void) | null = null;
afterEach(async () => {
  stopErrorCapture?.();
  stopErrorCapture = null;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  if (session) {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    session = null;
  }
});

it("keeps the mobile attention count through reading, peeking and resolving at 390×844", async () => {
  session = cdp();
  const consoleError = vi.spyOn(console, "error");
  const pageErrors: string[] = [];
  const onError = (event: ErrorEvent) => {
    pageErrors.push(
      event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message,
    );
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    pageErrors.push(String(event.reason));
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  stopErrorCapture = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    consoleError.mockRestore();
  };
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.viewport(390, 844);

  localStorage.clear();
  localStorage.setItem("activeWsId", "A");
  localStorage.setItem("wsGroupOverrides", JSON.stringify({ "project:p1": false }));
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  mountFixedApp();
  const sock = FakeSocket.instances.at(-1)!;
  act(() => {
    sock.open();
    sock.receive(initFrame([active, lead, waiting, unread], { projects: [project] }));
  });
  const receive = (frame: unknown) => act(() => sock.receive(frame));
  const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)!;
  const menuButton = () => get<HTMLButtonElement>(".panel-header .mobile-menu-btn");
  const badge = () => menuButton().querySelector<HTMLElement>(".attention-badge");
  const row = (name: string) =>
    [...document.querySelectorAll<HTMLElement>(".task-item")].find(
      (item) => item.querySelector(".clip")?.textContent === name,
    )!;
  const tap = async (el: HTMLElement) => {
    await expect.element(page.elementLocator(el)).toBeVisible();
    const { x, y, width, height } = el.getBoundingClientRect();
    const point = { x: x + width / 2, y: y + height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    expect(hit === el || el.contains(hit)).toBe(true);
    // The runner scales the test iframe to fit; CDP uses the outer viewport.
    const frame = window.frameElement!.getBoundingClientRect();
    const touchPoint = {
      x: frame.x + (point.x * frame.width) / innerWidth,
      y: frame.y + (point.y * frame.height) / innerHeight,
    };
    await session!.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint],
    });
    await session!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const openMenu = async () => {
    // A just-selected session leaves a closing shield for 400 ms. Wait for a
    // real tap to reach the button rather than synthesizing through it.
    await expect.poll(() => document.querySelector(".sidebar-overlay")).toBeNull();
    await tap(menuButton());
    await expect.poll(() => document.querySelector(".sidebar-open") !== null).toBe(true);
    await expect.poll(() => Math.round(get(".sidebar").getBoundingClientRect().left)).toBe(0);
  };
  const expectBadge = (count: number | null, yourTurn = false) => {
    if (count === null) {
      expect(badge()).toBeNull();
      expect(menuButton().getAttribute("aria-label")).toBe(
        "Open workspace menu: no background sessions need attention",
      );
      return;
    }
    expect(badge()!.textContent).toBe(String(count));
    expect(badge()!.classList.contains("attention-badge-your-turn")).toBe(yourTurn);
    if (yourTurn) {
      const badgeStyle = getComputedStyle(badge()!);
      const context = document.createElement("canvas").getContext("2d")!;
      context.fillStyle = badgeStyle.getPropertyValue("--warning").trim();
      const hex = context.fillStyle;
      context.fillStyle = badgeStyle.color;
      expect(context.fillStyle).toBe(hex);
    }
  };
  const expectNoOverflow = () => {
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(390);
    const main = get(".main-panel");
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
    if (document.querySelector(".sidebar-open")) {
      const sidebar = get(".sidebar");
      expect(sidebar.scrollWidth).toBeLessThanOrEqual(sidebar.clientWidth);
    }
  };

  // A is active; B is your turn and C has eight unread messages: two sessions.
  expectBadge(2, true);
  expect(menuButton().getAttribute("aria-label")).toBe(
    "Open workspace menu: 2 background sessions need attention, 1 your turn",
  );
  expectNoOverflow();

  // Merely opening the drawer changes neither count nor the collapsed group.
  await openMenu();
  expectBadge(2, true);
  const projectHeader = get(".ws-group-project");
  expect(projectHeader.querySelector(".ws-group-toggle")!.getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(projectHeader.parentElement!.querySelector(".ws-group-items")).toBeNull();
  const projectAttention = projectHeader.querySelector<HTMLElement>(".ws-group-attention")!;
  expect(projectAttention.textContent).toBe("1 need you · 1 unread");
  expect(projectAttention.getAttribute("aria-label")).toBe("Project: 1 need you · 1 unread");
  expectNoOverflow();

  // Unfold explicitly, then read C. The server echo clears C's eight messages,
  // leaving only B's your-turn session.
  await tap(projectHeader.querySelector<HTMLElement>(".ws-group-toggle")!);
  await expect
    .poll(() => projectHeader.querySelector(".ws-group-toggle")!.getAttribute("aria-expanded"))
    .toBe("true");
  await tap(row("C"));
  receive({ type: "workspace_messages", workspaceId: "C", messages: [], hasMore: false });
  await expect
    .poll(() =>
      sock.frames().some((frame) => frame.type === "mark_seen" && frame.workspaceId === "C"),
    )
    .toBe(true);
  receive({ type: "workspace_seen", workspaceId: "C" });
  expectBadge(1, true);
  expectNoOverflow();

  // Peeking at B temporarily excludes the active session, but switching back
  // without resolving it restores the same single amber count.
  await openMenu();
  await tap(row("B"));
  await expect.poll(() => badge()).toBeNull();
  expectBadge(null);
  await openMenu();
  await tap(row("A"));
  await expect.poll(() => badge()?.textContent).toBe("1");
  expectBadge(1, true);
  expectNoOverflow();

  receive({ type: "workspace_updated", workspace: { ...waiting, awaitsUser: false } });
  expectBadge(null);
  expectNoOverflow();
  // Drain renderer work and asynchronous page events before reading the logs.
  await session.send("Runtime.evaluate", { expression: "undefined" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(consoleError.mock.calls).toEqual([]);
  expect(pageErrors).toEqual([]);
  stopErrorCapture?.();
  stopErrorCapture = null;
});
