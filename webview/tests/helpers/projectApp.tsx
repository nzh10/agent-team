import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../../src/App";
import type { Project, Workspace } from "../../src/state/useServer";
import { FakeSocket, initFrame } from "../fakeSocket";
import { project, workspace } from "./fixtures";

export const repoSession = (id: string, now: number, fields: Partial<Workspace> = {}) =>
  workspace(id, {
    cwd: `/repo/${id}`,
    git: null,
    pr: null,
    createdAt: now - 5000,
    lastMessageAt: now - 5000,
    ...fields,
  });

export const cliceProject = (now: number, fields: Partial<Project> = {}) =>
  project("p1", { name: "clice", root: "/repo/clice", createdAt: now - 10_000, ...fields });

export function bootProjectApp(
  workspaces: Workspace[],
  projects: Project[],
  active: string,
  fields: Record<string, unknown> = {},
) {
  localStorage.setItem("activeWsId", active);
  const view = render(<App />);
  const sock = FakeSocket.instances.at(-1)!;
  const recv = (frame: unknown) => act(() => sock.receive(frame));
  act(() => sock.open());
  recv(initFrame(workspaces, { projects, ...fields }));
  return { ...view, sock, recv };
}

export function stubAppSocket() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  Element.prototype.scrollIntoView = vi.fn();
}

export function setupProjectApp() {
  vi.useFakeTimers();
  stubAppSocket();
}

export function resetProjectApp() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
}

export const frame = () => {
  act(() => {
    vi.advanceTimersByTime(20);
  });
};
