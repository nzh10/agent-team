import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import type { ReactNode } from "react";
import { MdBlock } from "../../src/chat/markdown";
import { sanitizeDiagramSvg } from "../../src/chat/diagramRender";
import { DiagramCache, DiagramCacheContext, DiagramCacheScope } from "../../src/chat/diagramCache";
import { TranscriptChoiceScope } from "../../src/chat/transcriptChoices";
import "../../src/styles.css";

function Chat({ children, width }: { children: ReactNode; width?: number }) {
  return (
    <div className="messages" style={width ? { width } : undefined}>
      <div className="message">
        <div className="message-body">
          <div className="message-content">{children}</div>
        </div>
      </div>
    </div>
  );
}

function fence(language: string, source: string): string {
  return `\`\`\`${language}\n${source}\n\`\`\``;
}

async function preview(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(
    () => {
      const node = container.querySelector<HTMLElement>(".diagram-preview");
      expect(node).not.toBeNull();
      return node!;
    },
    { timeout: 15_000 },
  );
}

function luminance(channels: Uint8ClampedArray): number {
  const [r, g, b] = Array.from(channels.slice(0, 3), (byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastOf(foreground: string, background: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const paint = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    // Invalid assignments leave fillStyle unchanged. Start transparent so
    // invalid, missing, and non-opaque paints cannot yield a contrast ratio.
    context.fillStyle = "transparent";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    if (pixel[3] !== 255) throw new Error(`Expected opaque paint: ${color}`);
    return luminance(pixel);
  };
  const bg = paint(background);
  const fg = paint(foreground);
  return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  delete (window as Window & { __diagramXss?: number }).__diagramXss;
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
});

describe("diagram previews", () => {
  it.each(["none", "transparent", "", "not-a-color"])(
    "rejects non-paintable contrast input %j",
    (color) => {
      expect(() => contrastOf(color, "white")).toThrow("Expected opaque paint");
    },
  );

  it.each([
    { language: "mermaid", theme: "light", width: 1100, source: "flowchart LR\nA --> B" },
    { language: "graphviz", theme: "light", width: 1100, source: "digraph { a -> b; }" },
    { language: "mermaid", theme: "dark", width: 390, source: "flowchart LR; A --> B" },
    { language: "graphviz", theme: "dark", width: 390, source: "digraph { a -> b; }" },
  ])(
    "keeps a cold $language preview still while loading ($theme, $width px)",
    { timeout: 20_000 },
    async ({ language, theme, width, source }) => {
      await page.viewport(width, 844);
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: width === 390 });
      document.documentElement.dataset.theme = theme;
      const cache = new DiagramCache();
      const request = cache.request.bind(cache);
      let release!: () => void;
      let received!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const rendered = new Promise<void>((resolve) => (received = resolve));
      vi.spyOn(cache, "request").mockImplementation((key, spec, receive) =>
        request(key, spec, (answer) => {
          received();
          void gate.then(() => receive(answer));
        }),
      );
      const { container, getByRole, getByText } = render(
        <DiagramCacheContext.Provider value={cache}>
          <Chat>
            <MdBlock>{`Before.\n\n${fence(language, source)}\n\nAfter.`}</MdBlock>
          </Chat>
        </DiagramCacheContext.Provider>,
      );
      await document.fonts.ready;
      const pre = container.querySelector("pre")!;
      const block = pre.parentElement!;
      const actions = block.querySelector(".code-block-actions")!;
      const buttons = Array.from(actions.querySelectorAll("button"));
      expect(buttons).toHaveLength(2);
      const after = getByText("After.");
      const bounds = (el: Element) => {
        const { top, right, bottom, left } = el.getBoundingClientRect();
        return { top, right, bottom, left };
      };
      const watched = [pre, block, actions, ...buttons, after];
      const before = watched.map(bounds);
      const gap = bounds(after).top - bounds(pre).bottom;
      try {
        fireEvent.click(getByRole("button", { name: "Preview diagram" }));
        const status = getByRole("status");
        expect(status.textContent).toBe("Rendering diagram…");
        expect(pre.hidden).toBe(false);
        expect(pre.textContent).toContain(source);
        expect(watched.map(bounds)).toEqual(before);

        await rendered;
        expect(watched.map(bounds)).toEqual(before);
        const label = status.getBoundingClientRect();
        for (const button of buttons) {
          expect(label.right).toBeLessThanOrEqual(button.getBoundingClientRect().left);
        }
        expect(label.width).toBeGreaterThan(0);
        expect(label.height).toBeGreaterThan(0);
        expect(status.scrollWidth).toBe(status.clientWidth);
        const paint = getComputedStyle(status);
        expect(paint.visibility).toBe("visible");
        expect(contrastOf(paint.color, paint.backgroundColor)).toBeGreaterThanOrEqual(4.5);

        await act(() => {
          release();
          return gate;
        });
        const diagram = await preview(container);
        expect(diagram.querySelector("svg")).not.toBeNull();
        expect(pre.hidden).toBe(true);
        expect(status.textContent).toBe("");
        expect(bounds(diagram).top).toBe(before[0].top);
        expect(bounds(after).top - bounds(diagram).bottom).toBe(gap);
        expect([actions, ...buttons].map(bounds)).toEqual(before.slice(2, -1));
      } finally {
        release();
      }
    },
  );

  it("measures Mermaid SVGs without extending the body's scroll range", async () => {
    const { renderMermaid } = await import("../../src/chat/mermaidRenderer");
    const body = document.body;
    const filler = document.createElement("div");
    filler.style.height = `${body.clientHeight}px`;
    body.append(filler);
    const scrollGeometry = () => [
      body.scrollWidth,
      body.scrollHeight,
      body.scrollLeft,
      body.scrollTop,
      document.documentElement.scrollWidth,
      document.documentElement.scrollHeight,
      window.scrollX,
      window.scrollY,
    ];
    const before = scrollGeometry();
    const samples: number[][] = [];
    let host: Element | undefined;
    const observer = new MutationObserver(() => {
      const measured = Array.from(body.children).find((node) =>
        node.querySelector('svg[id^="diagram-preview-"]'),
      );
      if (!measured) return;
      host = measured;
      samples.push(scrollGeometry());
    });
    observer.observe(body, { childList: true, subtree: true });
    try {
      const raw = await renderMermaid("flowchart TD\nA[Start] --> B[Finish]", "light");
      const svg = new DOMParser().parseFromString(raw, "image/svg+xml").documentElement;
      const [, , width, height] = svg.getAttribute("viewBox")!.split(/\s+/).map(Number);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples).toEqual(samples.map(() => before));
      expect(host?.isConnected).toBe(false);
      expect(scrollGeometry()).toEqual(before);
    } finally {
      observer.disconnect();
      filler.remove();
    }
  });

  it(
    "accepts the graphviz alias and toggles back to code",

    { timeout: 20_000 },
    async () => {
      const source = 'digraph G { a [label="Alpha"]; a -> b [label="next"]; }';
      const { container, getByRole } = render(
        <Chat>{<MdBlock>{fence("graphviz", source)}</MdBlock>}</Chat>,
      );
      fireEvent.click(getByRole("button", { name: "Preview diagram" }));
      const rendered = await preview(container);
      expect(rendered.classList.contains("diagram-preview--graphviz")).toBe(true);
      expect(rendered.querySelector("svg")?.textContent).toContain("Alpha");
      expect(container.querySelector("pre")!.hidden).toBe(true);
      fireEvent.click(getByRole("button", { name: "Show code" }));
      expect(container.querySelector("pre")!.hidden).toBe(false);
      expect(container.querySelector("pre")?.textContent).toContain(source);
    },
  );

  it(
    "preserves explicit Graphviz label and fill colors in dark mode",
    { timeout: 20_000 },
    async () => {
      document.documentElement.dataset.theme = "dark";
      const source =
        'digraph G { a [style=filled, fillcolor=white, fontcolor=black, label="Explicit"]; }';
      const { container, getByRole } = render(
        <Chat>{<MdBlock>{fence("dot", source)}</MdBlock>}</Chat>,
      );
      fireEvent.click(getByRole("button", { name: "Preview diagram" }));
      const rendered = await preview(container);
      const text = rendered.querySelector("g.node text")!;
      const shape = rendered.querySelector("g.node ellipse, g.node polygon")!;
      expect(
        contrastOf(getComputedStyle(text).fill, getComputedStyle(shape).fill),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it(
    "keeps invalid Mermaid source visible and reports the parser reason",
    { timeout: 20_000 },
    async () => {
      const source = "flowchart TD\nA -->";
      const { container, getByRole } = render(
        <Chat>{<MdBlock>{fence("mermaid", source)}</MdBlock>}</Chat>,
      );
      fireEvent.click(getByRole("button", { name: "Preview diagram" }));
      const alert = await waitFor(
        () => {
          const node = container.querySelector<HTMLElement>(".diagram-preview-error");
          expect(node).not.toBeNull();
          return node!;
        },
        { timeout: 15_000 },
      );
      expect(alert.textContent).toMatch(/Diagram preview failed: .+/);
      expect(alert.textContent?.length).toBeLessThan(220);
      expect(container.querySelector("pre")!.hidden).toBe(false);
      expect(container.querySelector("pre")?.textContent).toContain(source);
      expect(container.querySelector(".diagram-preview")).toBeNull();
    },
  );

  it(
    "removes active and external payloads without execution or network requests in Chromium",
    { timeout: 25_000 },
    async () => {
      const session = cdp();
      await session.send("Network.enable");
      const requests: string[] = [];
      const onRequest = (event: { request: { url: string } }) => requests.push(event.request.url);
      session.on("Network.requestWillBeSent", onRequest);
      const probe = window as Window & { __diagramXss?: number };
      probe.__diagramXss = 0;
      try {
        const source = [
          "flowchart TD",
          "A[\"<script>window.__diagramXss=1</script><img src='https://example.test/diagram-pwn.svg' onerror='window.__diagramXss=1'>Safe\"] --> B",
          'click A "javascript:window.__diagramXss=1"',
        ].join("\n");
        const { container, getByRole } = render(
          <Chat>{<MdBlock>{fence("mermaid", source)}</MdBlock>}</Chat>,
        );
        fireEvent.click(getByRole("button", { name: "Preview diagram" }));
        const rendered = await preview(container);
        expect(rendered.querySelector("svg")?.textContent).toContain("Safe");
        expect(rendered.querySelector("script, foreignObject, image, use, a")).toBeNull();
        for (const style of rendered.querySelectorAll("style")) {
          expect(style.textContent).not.toMatch(/@import|url\s*\(|javascript:|https?:/i);
        }
        for (const element of rendered.querySelectorAll("*")) {
          for (const attribute of element.attributes) {
            expect(attribute.name.toLowerCase()).not.toMatch(/^on/);
            expect(attribute.value).not.toMatch(/javascript:/i);
          }
        }

        const clean = sanitizeDiagramSvg(
          '<svg viewBox="0 0 20 20"><script>window.__diagramXss=1</script><image href="https://example.test/direct-pwn.svg" onerror="window.__diagramXss=1"/><text onclick="window.__diagramXss=1" x="1" y="10">Safe</text></svg>',
        );
        const direct = document.createElement("div");
        direct.innerHTML = clean;
        document.body.append(direct);
        direct.querySelector("text")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        direct.querySelector("svg")!.dispatchEvent(new Event("load"));
        direct.remove();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        expect(probe.__diagramXss).toBe(0);
        expect(requests.filter((url) => /example\.test|diagram-pwn|direct-pwn/.test(url))).toEqual(
          [],
        );
      } finally {
        session.off("Network.requestWillBeSent", onRequest);
      }
    },
  );

  it(
    "rejects Mermaid image nodes before the renderer can request their URL",
    { timeout: 20_000 },
    async () => {
      const session = cdp();
      await session.send("Fetch.enable", { patterns: [{ urlPattern: "*diagram-pwn.svg" }] });
      const requests: string[] = [];
      const onPaused = (event: { requestId: string; request: { url: string } }) => {
        requests.push(event.request.url);
        void session.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Aborted",
        });
      };
      session.on("Fetch.requestPaused", onPaused);
      try {
        const source =
          'flowchart TD\nA@{img: "http://127.0.0.1:9/diagram-pwn.svg", label: "External"}';
        const { container, getByRole } = render(
          <Chat>{<MdBlock>{fence("mermaid", source)}</MdBlock>}</Chat>,
        );
        fireEvent.click(getByRole("button", { name: "Preview diagram" }));
        const alert = await waitFor(
          () => {
            const node = container.querySelector<HTMLElement>(".diagram-preview-error");
            expect(node).not.toBeNull();
            return node!;
          },
          { timeout: 15_000 },
        );
        expect(requests).toEqual([]);
        expect(alert.textContent).toContain("Image nodes are disabled");
        expect(container.querySelector("pre")!.hidden).toBe(false);
      } finally {
        session.off("Fetch.requestPaused", onPaused);
        await session.send("Fetch.disable");
      }
    },
  );

  it(
    "keeps text and lines legible in both themes and re-renders open diagrams",
    { timeout: 30_000 },
    async () => {
      await page.viewport(1100, 760);
      document.documentElement.dataset.theme = "light";
      const { container, getAllByRole } = render(
        <Chat>
          <MdBlock>
            {fence(
              "mermaid",
              `flowchart LR
  User["User Input"] --> WS["Workspace Queue"]
  WS -->|"starting → streaming"| Session["Pi / Codex Session"]
  Session -->|"stream_event"| Server["YAAT WS Hub"]
  Server --> UI["Webview Transcript"]
  UI -.->|"Jump to latest"| UI`,
            )}
          </MdBlock>
          <MdBlock>{fence("dot", "digraph G { a -> b; }")}</MdBlock>
        </Chat>,
      );
      for (const toggle of getAllByRole("button", { name: "Preview diagram" })) {
        fireEvent.click(toggle);
      }
      await waitFor(() => expect(container.querySelectorAll(".diagram-preview")).toHaveLength(2), {
        timeout: 20_000,
      });

      for (const theme of ["light", "dark"]) {
        document.documentElement.dataset.theme = theme;
        await waitFor(
          () => {
            const nodes = container.querySelectorAll(".diagram-preview");
            expect(nodes).toHaveLength(2);
            for (const node of nodes) {
              expect(node.getAttribute("data-theme")).toBe(theme);
            }
          },
          { timeout: 20_000 },
        );
        const nodes = container.querySelectorAll<HTMLElement>(".diagram-preview");
        expect(nodes).toHaveLength(2);
        for (const rendered of nodes) {
          const text = rendered.querySelector("svg text")!;
          const background = getComputedStyle(rendered).backgroundColor;
          expect(contrastOf(getComputedStyle(text).fill, background)).toBeGreaterThanOrEqual(4.5);
          if (rendered.matches(".diagram-preview--mermaid")) {
            expect(rendered.querySelector("svg style")).not.toBeNull();
            const rects = rendered.querySelectorAll(".node > rect");
            expect(rects).toHaveLength(5);
            for (const rect of rects) {
              const paint = getComputedStyle(rect);
              expect(paint.fill).toBe(theme === "dark" ? "rgb(46, 46, 51)" : "rgb(255, 255, 255)");
              expect(paint.filter).toBe("none");
              expect(
                contrastOf(
                  getComputedStyle(rect.parentElement!.querySelector("text")!).fill,
                  paint.fill,
                ),
              ).toBeGreaterThanOrEqual(4.5);
            }
            const links = rendered.querySelectorAll(".flowchart-link");
            expect(links).toHaveLength(5);
            for (const link of links) {
              expect(getComputedStyle(link).fill).toBe("none");
              expect(contrastOf(getComputedStyle(link).stroke, background)).toBeGreaterThanOrEqual(
                3,
              );
            }
            const loop = rendered.querySelector('[data-id="L_UI_UI_0"]')!;
            expect(getComputedStyle(loop).strokeDasharray).not.toBe("none");
            const labels = Array.from(rendered.querySelectorAll(".edgeLabel text"));
            expect(labels.map((label) => label.textContent)).toEqual(
              expect.arrayContaining(["starting → streaming", "stream_event", "Jump to latest"]),
            );
            for (const label of labels) {
              const backing = label.closest(".edgeLabel")!.querySelector("rect.background")!;
              expect(getComputedStyle(backing).fill).toBe(background);
              expect(getComputedStyle(backing).opacity).toBe("1");
              expect(contrastOf(getComputedStyle(label).fill, background)).toBeGreaterThanOrEqual(
                4.5,
              );
            }
            continue;
          }
          const line = rendered.querySelector("ellipse[stroke]")!;
          const stroke = getComputedStyle(line).stroke;
          expect(
            contrastOf(stroke, background),
            `${theme} ${rendered.className}: ${stroke} on ${background}; ${line.outerHTML}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );

  it("uses separate SVG identities and reserves intrinsic size after cache eviction", async () => {
    await page.viewport(390, 844);
    const choices = new Map();
    const source = fence("mermaid", "flowchart LR\nA[Start] --> B[Finish]");
    const chat = (ids: string[], width = 350) => (
      <DiagramCacheScope workspaceId="w">
        <Chat width={width}>
          {ids.map((id) => (
            <TranscriptChoiceScope key={id} id={id} choices={choices}>
              <MdBlock>{source}</MdBlock>
            </TranscriptChoiceScope>
          ))}
        </Chat>
      </DiagramCacheScope>
    );
    const view = render(chat(["a", "b"]));
    const previews = () => [
      ...view.container.querySelectorAll<HTMLElement>(".diagram-preview:has(svg)"),
    ];
    for (const button of view.getAllByRole("button", { name: "Preview diagram" }))
      fireEvent.click(button);
    await expect.poll(() => previews().length).toBe(2);
    const ids = (element: HTMLElement) => [...element.querySelectorAll("[id]")].map((el) => el.id);
    const firstIds = new Set(ids(previews()[0]));
    expect(previews()[0].querySelector("marker[id]")).not.toBeNull();
    expect(ids(previews()[1]).filter((id) => firstIds.has(id))).toEqual([]);
    const height = previews()[0].offsetHeight;
    for (const id of ["c", "d", "e", "f"]) {
      view.rerender(chat([id]));
      fireEvent.click(view.getByRole("button", { name: "Preview diagram" }));
      await preview(view.container);
    }
    view.rerender(chat(["a"], 300));
    expect(view.container.querySelector<HTMLElement>(".diagram-reservation")?.offsetHeight).toBe(
      height,
    );
    expect(view.container.querySelector("pre")?.hidden).toBe(true);
    await expect.poll(() => previews()[0]?.offsetHeight).toBe(height);
  });

  it.each(["light", "dark"])(
    "keeps wide previews inside a 390px touch viewport and scrolls them locally (%s)",
    { timeout: 25_000 },
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await page.viewport(390, 844);
      expect(matchMedia("(hover: none)").matches).toBe(true);
      const source = `flowchart LR\n${Array.from({ length: 9 }, (_, i) => `N${i}[Node ${i}]`).join(" --> ")}`;
      const choices = new Map();
      const chat = (mounted: boolean, width = 350, workspaceId = "w") => (
        <DiagramCacheScope workspaceId={workspaceId}>
          <Chat width={width}>
            {mounted && (
              <TranscriptChoiceScope id="row" choices={choices}>
                <MdBlock>{fence("mermaid", source)}</MdBlock>
              </TranscriptChoiceScope>
            )}
          </Chat>
        </DiagramCacheScope>
      );
      const { container, getByRole, rerender } = render(chat(true));
      const toggle = getByRole("button", { name: "Preview diagram" });
      const copy = getByRole("button", { name: "Copy" });
      expect(getComputedStyle(toggle).opacity).toBe("1");
      expect(getComputedStyle(copy).opacity).toBe("1");
      expect(toggle.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
      expect(toggle.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
      expect(toggle.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        copy.getBoundingClientRect().right - 1,
      );
      fireEvent.click(toggle);
      const rendered = await preview(container);
      const block = container.querySelector<HTMLElement>(".code-block")!;
      expect(block.getBoundingClientRect().right).toBeLessThanOrEqual(390);
      expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth + 1);
      expect(rendered.getBoundingClientRect().right).toBeLessThanOrEqual(
        block.getBoundingClientRect().right + 1,
      );
      expect(rendered.scrollWidth).toBeGreaterThan(rendered.clientWidth);
      const text = rendered.querySelector("svg text")!;
      expect(
        contrastOf(getComputedStyle(text).fill, getComputedStyle(rendered).backgroundColor),
      ).toBeGreaterThanOrEqual(4.5);
      rendered.scrollLeft = 100;
      expect(rendered.scrollLeft).toBeGreaterThan(0);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      const svg = rendered.innerHTML;
      rerender(chat(false, 300));
      expect(container.querySelector("svg")).toBeNull();
      rerender(chat(true, 300));
      expect(container.querySelector(".diagram-preview")?.innerHTML).toBe(svg);
      expect(container.querySelector("pre")?.hidden).toBe(true);
      expect(container.querySelector(".diagram-preview-status")?.textContent).toBe("");
      rerender(chat(false, 300, "other"));
      rerender(chat(true));
      expect(container.querySelector(".diagram-preview svg")).toBeNull();
      expect(container.querySelector("pre")?.hidden).toBe(false);
      await preview(container);
    },
  );
});
