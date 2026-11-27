import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MdBlock } from "../src/chat/markdown";
import { DiagramCache } from "../src/chat/diagramCache";

const renderDiagram = vi.hoisted(() => vi.fn());
vi.mock("../src/chat/diagramRender", () => ({ renderDiagram }));

const SAFE_SVG = '<svg viewBox="0 0 100 40"><text x="4" y="20">Safe</text></svg>';

afterEach(() => {
  cleanup();
  renderDiagram.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

it("coalesces an off-window render, rejects stale work and charges UTF-16 bytes", async () => {
  const cache = new DiagramCache();
  const spec = { language: "mermaid", theme: "light", source: "A" } as const;
  let finish!: (svg: string) => void;
  renderDiagram.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
  const offscreen = vi.fn();
  cache.request("row", spec, offscreen)();
  const answer = new Promise((resolve) => cache.request("row", spec, resolve));
  finish(SAFE_SVG);
  expect(await answer).toEqual({ svg: SAFE_SVG });
  expect(renderDiagram).toHaveBeenCalledTimes(1);
  expect(offscreen).not.toHaveBeenCalled();

  const request = (key: string) => new Promise((resolve) => cache.request(key, spec, resolve));
  const jobs = ["a", "b", "c", "d"].map(request);
  expect(await request("overflow")).toHaveProperty("error");
  await Promise.all(jobs);
  renderDiagram.mockResolvedValue("界".repeat(32_650));
  for (const key of ["one", "two", "three"]) await request(key);
  expect(cache.peek("one")).toBeUndefined();
  expect(cache.peek("two")).toHaveLength(32_650);
  renderDiagram.mockResolvedValue("界".repeat(32_768));
  await request("oversized");
  expect(cache.peek("oversized")).toBeUndefined();
  cache.request("stale", spec, offscreen);
  cache.clear();
  await request("oversized");
  expect(cache.peek("stale")).toBeUndefined();
  expect(offscreen).not.toHaveBeenCalled();
});

describe("diagram preview controls", () => {
  it("offers an icon-only toggle only for diagram fences, case-insensitively", () => {
    const { container, getAllByRole } = render(
      <>
        <MdBlock>{"```MeRmAiD\nflowchart LR; A-->B\n```"}</MdBlock>
        <MdBlock>{"```DOT\ndigraph { a -> b }\n```"}</MdBlock>
        <MdBlock>{"```graphviz\ndigraph { b -> c }\n```"}</MdBlock>
        <MdBlock>{"```ts\nconst diagram = true;\n```"}</MdBlock>
      </>,
    );
    const toggles = getAllByRole("button", { name: "Preview diagram" });
    expect(toggles).toHaveLength(3);
    expect(container.querySelectorAll(".code-block")).toHaveLength(4);
    for (const toggle of toggles) {
      expect(toggle.textContent).toBe("");
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      expect(toggle.getAttribute("title")).toBe("Preview diagram");
      expect(toggle.querySelector("svg.icon")).not.toBeNull();
    }
    expect(renderDiagram).not.toHaveBeenCalled();
  });

  it("previews in place, toggles back, and always copies the original source", async () => {
    renderDiagram.mockResolvedValue(SAFE_SVG);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const source = "flowchart LR\nA --> B";
    const { container, getByRole } = render(
      <MdBlock>{`\`\`\`mermaid\n${source}\n\`\`\``}</MdBlock>,
    );
    const pre = container.querySelector("pre")!;
    const toggle = getByRole("button", { name: "Preview diagram" });
    expect(pre.hidden).toBe(false);
    expect(renderDiagram).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    await waitFor(() => expect(pre.hidden).toBe(true));
    expect(container.querySelector(".code-block > .diagram-preview > svg")).not.toBeNull();
    expect(getByRole("button", { name: "Show code" }).getAttribute("aria-pressed")).toBe("true");
    expect(renderDiagram).toHaveBeenCalledWith(source, "mermaid", "light");

    fireEvent.click(getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
    fireEvent.click(getByRole("button", { name: "Show code" }));
    await waitFor(() => expect(pre.hidden).toBe(false));
    expect(container.querySelector(".diagram-preview")).toBeNull();
    expect(getByRole("button", { name: "Preview diagram" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("maps dot to Graphviz without loading Mermaid", async () => {
    renderDiagram.mockResolvedValue(SAFE_SVG);
    const { container, getByRole } = render(<MdBlock>{"```dot\ndigraph { a -> b }\n```"}</MdBlock>);
    fireEvent.click(getByRole("button", { name: "Preview diagram" }));
    await waitFor(() =>
      expect(container.querySelector(".diagram-preview--graphviz")).not.toBeNull(),
    );
    expect(renderDiagram).toHaveBeenCalledWith("digraph { a -> b }", "graphviz", "light");
  });

  it("keeps source visible with a concise error and lets the user dismiss it", async () => {
    renderDiagram.mockRejectedValue(new Error("Syntax error on line 2\nverbose parser details"));
    const { container, getByRole, queryByRole } = render(
      <MdBlock>{"```mermaid\nflowchart TD\nA -->\n```"}</MdBlock>,
    );
    const pre = container.querySelector("pre")!;
    fireEvent.click(getByRole("button", { name: "Preview diagram" }));
    const alert = await waitFor(() => {
      const node = queryByRole("alert");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(alert.textContent).toBe("Diagram preview failed: Syntax error on line 2");
    expect(pre.hidden).toBe(false);
    expect(pre.textContent).toContain("flowchart TD");
    expect(container.querySelector(".diagram-preview")).toBeNull();

    fireEvent.click(getByRole("button", { name: "Show code" }));
    expect(queryByRole("alert")).toBeNull();
    expect(pre.hidden).toBe(false);
  });

  it("returns to the updated source when an open fence changes", async () => {
    renderDiagram.mockResolvedValue(SAFE_SVG);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const initial = "flowchart LR\nA --> B";
    const updated = `${initial}\nB --> C`;
    const view = render(<MdBlock>{`\`\`\`mermaid\n${initial}\n\`\`\``}</MdBlock>);
    const pre = view.container.querySelector("pre")!;
    fireEvent.click(view.getByRole("button", { name: "Preview diagram" }));
    await waitFor(() => expect(pre.hidden).toBe(true));

    view.rerender(<MdBlock>{`\`\`\`mermaid\n${updated}\n\`\`\``}</MdBlock>);
    await waitFor(() => expect(pre.hidden).toBe(false));
    expect(view.container.querySelector(".diagram-preview")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(updated));
    expect(renderDiagram).toHaveBeenCalledTimes(1);
  });

  it("ignores a late renderer result after the user returns to code", async () => {
    let finish!: (svg: string) => void;
    renderDiagram.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
    const { container, getByRole } = render(
      <MdBlock>{"```mermaid\nflowchart LR; A-->B\n```"}</MdBlock>,
    );
    const pre = container.querySelector("pre")!;
    fireEvent.click(getByRole("button", { name: "Preview diagram" }));
    fireEvent.click(getByRole("button", { name: "Show code" }));
    await act(async () => {
      finish(SAFE_SVG);
      await Promise.resolve();
    });
    expect(pre.hidden).toBe(false);
    expect(container.querySelector(".diagram-preview")).toBeNull();
    expect(getByRole("button", { name: "Preview diagram" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("re-renders an open preview when the theme changes", async () => {
    renderDiagram.mockResolvedValue(SAFE_SVG);
    const { container, getByRole } = render(
      <MdBlock>{"```mermaid\nflowchart LR; A-->B\n```"}</MdBlock>,
    );
    fireEvent.click(getByRole("button", { name: "Preview diagram" }));
    await waitFor(() => expect(container.querySelector(".diagram-preview")).not.toBeNull());
    let finish!: (svg: string) => void;
    renderDiagram.mockReturnValueOnce(new Promise<string>((resolve) => (finish = resolve)));
    document.documentElement.dataset.theme = "dark";
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(2));
    expect(container.querySelector(".diagram-preview")?.getAttribute("data-theme")).toBe("light");
    expect(container.querySelector("pre")!.hidden).toBe(true);
    await act(async () => {
      finish(SAFE_SVG);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(container.querySelector(".diagram-preview")?.getAttribute("data-theme")).toBe("dark"),
    );
    expect(renderDiagram).toHaveBeenLastCalledWith("flowchart LR; A-->B", "mermaid", "dark");
  });
});
