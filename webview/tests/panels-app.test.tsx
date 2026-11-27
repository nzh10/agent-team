// Side panels in the app: how wide, docked or floating, maximised, and the
// chat header beside them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, act } from "@testing-library/react";
import type { Workspace } from "../src/state/useServer";
import { agent } from "./helpers/fixtures";
import { bootProjectApp, cliceProject, repoSession, stubAppSocket } from "./helpers/projectApp";

const NOW = Date.now();
const ws = (id: string, over: Partial<Workspace> = {}) =>
  repoSession(id, NOW, {
    project: "clice",
    agents: [agent(`${id}-a`, { name: "A", model: "m", color: "#fff" })],
    ...over,
  });
const project = cliceProject(NOW, { createdAt: 0 });
const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo/clice",
  projectLink: { projectId: "p1", role: "lead" },
});
const worker = ws("w1", { name: "modules", projectLink: { projectId: "p1", role: "worker" } });

beforeEach(() => {
  stubAppSocket();
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ kind: "dir", path: "/repo/clice", truncated: false, entries: [] }),
      }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

const boot = (active: string, workspaces = [lead, worker]) =>
  bootProjectApp(workspaces, [project], active);
const rail = (label: string) =>
  fireEvent.click(document.querySelector(`.side-rail [aria-label="${label}"]`)!);
const panel = () => document.querySelector(".side-panel") as HTMLElement;
const resize = (width: number) =>
  act(() => {
    vi.stubGlobal("innerWidth", width);
    window.dispatchEvent(new Event("resize"));
  });

describe("the chat header's title", () => {
  it("names the folder unless the session's name already starts with it as a word", () => {
    const first = boot("lead");
    expect(document.querySelector(".panel-title")!.textContent).toBe("clice · lead");
    first.unmount();
    const second = boot("w1");
    expect(document.querySelector(".panel-title")!.textContent).toBe("modules — clice");
    second.unmount();
    boot("x", [ws("x", { name: "clicer perf" })]);
    expect(document.querySelector(".panel-title")!.textContent).toBe("clicer perf — clice");
  });
});

describe("panel widths", () => {
  it("give the Files panel its own automatic and saved width, apart from the lists", () => {
    vi.stubGlobal("innerWidth", 2560);
    boot("lead");
    rail("Files");
    expect(panel().getAttribute("aria-label")).toBe("Files");
    expect(panel().style.width).toBe("1075px");
    const edge = document.querySelector(".side-panel-resize")!;
    fireEvent.pointerDown(edge, { clientX: 1500, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 1400, pointerId: 1 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(panel().style.width).toBe("1175px");
    expect(localStorage.getItem("filesPanelWidth")).toBe("1175");
    rail("Agents and sessions");
    expect(panel().style.width).toBe("560px");
    expect(localStorage.getItem("listPanelWidth")).toBeNull();
  });

  it("leave the chat its room when the window narrows", () => {
    vi.stubGlobal("innerWidth", 1440);
    boot("lead");
    rail("Files");
    expect(panel().style.width).toBe("605px");
    resize(960);
    // 960 - 260 (sidebar) - 44 (rail) - 360 (the chat's least), or the panel's least.
    expect(panel().style.width).toBe("300px");
  });
});

describe("docked or floating", () => {
  it("docks unless floating was chosen, and saves a change", () => {
    localStorage.setItem("panelDock", "0");
    const first = boot("lead");
    rail("Agents and sessions");
    expect(panel().className).toContain("floating");
    first.unmount();
    localStorage.removeItem("panelDock");
    boot("lead");
    rail("Agents and sessions");
    expect(panel().className).toContain("docked");
    fireEvent.click(document.querySelector(".side-panel-pin")!);
    expect(panel().className).toContain("floating");
    expect(localStorage.getItem("panelDock")).toBe("0");
  });

  it("floats a pinned panel over a chat too narrow to use, and docks it again", () => {
    vi.stubGlobal("innerWidth", 1440);
    boot("lead");
    rail("Files");
    expect(panel().className).toContain("docked");
    // 900 - 260 (sidebar) - 44 (rail) - 300 (the panel) leaves the chat 296px:
    // narrow, but Send is in view.
    resize(900);
    expect(panel().className).toContain("docked");
    // 800 leaves it 196px: the panel floats, and cannot be pinned there.
    resize(800);
    expect(panel().className).toContain("floating");
    const pin = document.querySelector(".side-panel-pin") as HTMLButtonElement;
    expect([pin.disabled, pin.getAttribute("aria-pressed")]).toEqual([true, "false"]);
    resize(1440);
    expect(panel().className).toContain("docked");
    expect(localStorage.getItem("panelDock")).toBeNull();
  });
});

describe("a maximised panel", () => {
  it("steps back when another panel opens", () => {
    boot("lead");
    rail("Agents and sessions");
    fireEvent.click(document.querySelector(".side-panel-max")!);
    expect(panel().className).toContain("maximized");
    rail("Files");
    expect(panel().className).not.toContain("maximized");
    expect(document.querySelector(".side-panel-pin")).not.toBeNull();
  });
});

describe("panel chrome", () => {
  it("titles every panel over the same second line, and keeps the pin's label", () => {
    boot("lead");
    rail("Files");
    expect(document.querySelector(".side-panel-sub")!.textContent).toBe("clice");
    const pin = () => document.querySelector(".side-panel-pin")!;
    const [label, pressed] = [pin().getAttribute("title"), pin().getAttribute("aria-pressed")];
    fireEvent.click(pin());
    expect(pin().getAttribute("title")).toBe(label);
    expect(pin().getAttribute("aria-pressed")).not.toBe(pressed);
  });

  it("sets the board apart in the rail, and cuts the folder path at its front", () => {
    boot("lead");
    expect(document.querySelector(".side-rail .rail-page")!.getAttribute("aria-label")).toBe(
      "Objectives of clice",
    );
    expect(document.querySelector(".ws-info-path")!.textContent).toBe("/repo/clice");
    rail("Objectives of clice");
    expect(document.querySelector(".bp-head .bp-close svg")).not.toBeNull();
  });
});
