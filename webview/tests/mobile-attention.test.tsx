import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { MobileMenuButton } from "../src/sidebar/MobileMenuButton";
import type { Project, Workspace } from "../src/state/useServer";
import { FakeSocket, initFrame } from "./fakeSocket";
import { project as makeProject, workspace } from "./helpers/fixtures";
import { resetProjectApp, setupProjectApp } from "./helpers/projectApp";

const NOW = Date.now();
const ws = (id: string, over: Partial<Workspace> = {}) =>
  workspace(id, { cwd: `/repo/${id}`, createdAt: NOW - 5000, lastMessageAt: NOW, ...over });
const project = makeProject("p1", { root: "/repo/project", createdAt: NOW - 10_000 });
const lead = ws("lead", {
  cwd: "/repo/project",
  projectLink: { projectId: "p1", role: "lead" },
});
const waiting = ws("waiting", {
  projectLink: { projectId: "p1", role: "worker" },
  awaitsUser: true,
});
const unread = ws("unread", {
  projectLink: { projectId: "p1", role: "worker" },
  unread: 8,
});

function boot(workspaces: Workspace[], activeWsId: string | null, projects: Project[] = []) {
  if (activeWsId) localStorage.setItem("activeWsId", activeWsId);
  render(<App />);
  const sock = FakeSocket.instances.at(-1)!;
  act(() => {
    sock.open();
    sock.receive(initFrame(workspaces, { projects }));
  });
  return (frame: unknown) => act(() => sock.receive(frame));
}

beforeEach(() => {
  setupProjectApp();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(resetProjectApp);

describe("MobileMenuButton", () => {
  it("renders a quiet session count, amber your-turn state, and an accessible status", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <MobileMenuButton
        attention={{ count: 2, unread: 2, yourTurn: 0, failed: 0 }}
        onClick={onClick}
      />,
    );
    const button = () => document.querySelector<HTMLButtonElement>(".mobile-menu-btn")!;
    const badge = () => button().querySelector(".attention-badge");
    expect(button().getAttribute("aria-label")).toBe(
      "Open workspace menu: 2 background sessions need attention",
    );
    expect(badge()!.textContent).toBe("2");
    expect(badge()!.classList).not.toContain("attention-badge-your-turn");

    rerender(
      <MobileMenuButton
        attention={{ count: 2, unread: 1, yourTurn: 1, failed: 0 }}
        onClick={onClick}
      />,
    );
    expect(button().getAttribute("aria-label")).toBe(
      "Open workspace menu: 2 background sessions need attention, 1 your turn",
    );
    expect(badge()!.classList).toContain("attention-badge-your-turn");
    fireEvent.click(button());
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <MobileMenuButton
        attention={{ count: 0, unread: 0, yourTurn: 0, failed: 0 }}
        onClick={onClick}
      />,
    );
    expect(badge()).toBeNull();
    expect(button().getAttribute("aria-label")).toBe(
      "Open workspace menu: no background sessions need attention",
    );
  });
});

describe("App mobile attention badge", () => {
  it("counts background sessions rather than unread messages and follows state updates", () => {
    const receive = boot([ws("active"), lead, waiting, unread], "active", [project]);
    const button = () =>
      document.querySelector<HTMLButtonElement>(".panel-header .mobile-menu-btn")!;
    const badge = () => button().querySelector(".attention-badge");
    expect(badge()!.textContent).toBe("2");
    expect(badge()!.classList).toContain("attention-badge-your-turn");
    expect(button().getAttribute("aria-label")).toContain(
      "2 background sessions need attention, 1 your turn",
    );

    receive({ type: "workspace_seen", workspaceId: "unread" });
    expect(badge()!.textContent).toBe("1");
    expect(badge()!.classList).toContain("attention-badge-your-turn");

    receive({ type: "workspace_updated", workspace: { ...waiting, awaitsUser: false } });
    expect(badge()).toBeNull();
    expect(button().getAttribute("aria-label")).toBe(
      "Open workspace menu: no background sessions need attention",
    );
  });

  it("gives the empty-state menu the same accessible status and hides a zero badge", () => {
    boot([], null);
    const button = document.querySelector<HTMLButtonElement>(".empty-header .mobile-menu-btn")!;
    expect(button.getAttribute("aria-label")).toBe(
      "Open workspace menu: no background sessions need attention",
    );
    expect(button.querySelector(".attention-badge")).toBeNull();
  });
});
