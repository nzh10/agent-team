import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { loadMath } from "../../src/chat/markdown";
import { MessageItem } from "../../src/chat/messages";
import { buildFrames, DEMO_WS_ID, frameDelay, LAYOUT_TURN_ID } from "../../src/dev/replayFixture";
import { applyEventsToMessage, withoutLiveTiming } from "../../src/state/stream";
import type { Message, StreamEvent, Workspace } from "../../src/state/useServer";
import { nextPaint, themedViewport } from "../helpers/browser";
import { agent as makeAgent, message } from "../helpers/fixtures";
import "../../src/fonts/sarasa-mono-sc/regular/result.css";
import "../../src/fonts/sarasa-mono-sc/bold/result.css";
import "../../src/styles.css";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rect = (el: Element) => el.getBoundingClientRect();
const agent = makeAgent("a1", { name: "Alice", color: "#528bff", model: "test" });
const streaming = (id: string, timestamp: number, fields: Partial<Message> = {}) =>
  message(id, { agentId: agent.id, timestamp, status: "streaming", ...fields });
const inTranscript = (msg: Message) => (
  <div className="messages">
    <MessageItem msg={msg} agents={[agent]} />
  </div>
);

it.each([390, 520, 600, 960])("keeps the folded streaming turn stable at %ipx", async (width) => {
  await page.viewport(width, 800);
  expect(window.innerWidth).toBe(width);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const frames = buildFrames();
  const workspace = frames.find(
    (f) => f.type === "workspace_created" && (f.workspace as Workspace).id === DEMO_WS_ID,
  )!.workspace as Workspace;
  const announce = frames.findIndex(
    (f) => f.type === "new_message" && (f.message as Message).id === LAYOUT_TURN_ID,
  );
  let msg = frames[announce].message as Message;
  let agents = workspace.agents;
  const tail = frames.slice(announce + 1);
  const think = tail.findIndex(
    (f) => (f.event as StreamEvent | undefined)?.kind === "thinking_delta",
  );
  msg = applyEventsToMessage(
    msg,
    tail.slice(0, think).map((f) => f.event as StreamEvent),
  );
  const quietSince = msg.waitingSince!;
  vi.setSystemTime(quietSince);

  const view = () => (
    <div className="messages">
      <MessageItem msg={msg} agents={agents} />
    </div>
  );
  const { container, rerender } = render(view());
  await document.fonts.ready;
  const query = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  const turn = query(".message");
  const header = query(".step-header");
  const strip = query(".step-tools");
  const initialHeaderHeight = rect(header).height;
  const initialTurnHeight = rect(turn).height;

  function checkPhase(opts: { headerThinking?: string; footerLabel?: string } = {}) {
    const footer = container.querySelector<HTMLElement>(".turn-footer");
    const chip = header.querySelector<HTMLElement>(".chip-live");
    if (opts.headerThinking) {
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toBe(opts.headerThinking);
      expect(rect(chip!).right).toBeLessThanOrEqual(rect(header).right + 0.5);
      expect(chip!.scrollWidth).toBeLessThanOrEqual(chip!.clientWidth);
    } else {
      expect(chip).toBeNull();
    }
    if (opts.footerLabel) {
      expect(footer).not.toBeNull();
      expect(footer).toBe(query(".message-body").lastElementChild);
      expect(footer!.textContent).toBe(opts.footerLabel);
      expect(rect(footer!).height).toBe(20);
    } else {
      expect(footer).toBeNull();
      expect(rect(turn).height, opts.headerThinking ?? "quiet").toBe(initialTurnHeight);
    }
    expect(rect(header).height, opts.headerThinking ?? opts.footerLabel ?? "quiet").toBe(
      initialHeaderHeight,
    );
    expect(container.querySelector(".events-list")).toBeNull();

    const summary = query(".step-summary");
    const text = document.createRange();
    text.selectNodeContents(summary);
    expect(text.getClientRects()).toHaveLength(1);
    expect(rect(summary).right).toBeLessThanOrEqual(rect(header).right);
    expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth);
    expect(getComputedStyle(summary).textOverflow).not.toBe("ellipsis");
    if (chip) {
      expect(rect(summary).right).toBeLessThanOrEqual(rect(chip).left);
      expect(rect(summary).top).toBeLessThan(rect(chip).bottom);
      expect(rect(summary).bottom).toBeGreaterThan(rect(chip).top);
    }
    const chips = [...strip.querySelectorAll<HTMLElement>(".event-chip")];
    expect(chips.length).toBeGreaterThanOrEqual(4);
    expect(chips.some((c) => rect(c).width > 220)).toBe(true);
    for (const [i, c] of chips.entries()) {
      expect(rect(c).top).toBe(rect(chips[0]).top);
      if (i > 0) expect(rect(chips[i - 1]).right).toBeLessThanOrEqual(rect(c).left);
      expect(c.scrollWidth).toBeLessThanOrEqual(c.clientWidth);
      expect(getComputedStyle(c).textOverflow).not.toBe("ellipsis");
    }
    if (width <= 520) {
      expect(rect(summary).bottom).toBeLessThanOrEqual(rect(chips[0]).top);
      if (chip) expect(rect(chip).bottom).toBeLessThanOrEqual(rect(chips[0]).top);
    } else {
      expect(rect(chip ?? summary).right).toBeLessThanOrEqual(rect(strip).left);
      expect(rect(summary).top).toBeLessThan(rect(chips[0]).bottom);
      expect(rect(summary).bottom).toBeGreaterThan(rect(chips[0]).top);
    }
  }

  function advanceTo(at: number) {
    void act(() => {
      vi.advanceTimersByTime(at - Date.now());
    });
  }
  let replayAt = quietSince + frameDelay(tail[think - 1]);
  let nextIndex = think;
  function replayNext() {
    advanceTo(replayAt);
    const frame = tail[nextIndex++];
    if (frame.type === "stream_event") {
      msg = applyEventsToMessage(msg, [frame.event as StreamEvent]);
    } else if (frame.type === "agent_activity") {
      agents = agents.map((agent) =>
        agent.id === frame.agentId
          ? { ...agent, activity: frame.activity as string | null }
          : agent,
      );
    } else if (frame.type === "message_done") {
      msg = { ...withoutLiveTiming(msg), status: "done", content: frame.content as string };
    }
    rerender(view());
    replayAt += frameDelay(frame);
  }

  checkPhase();
  advanceTo(quietSince + 4_999);
  checkPhase();
  advanceTo(quietSince + 5_000);
  checkPhase();
  replayNext(); // thinking_start
  checkPhase({ headerThinking: "Thinking · 0s" });
  expect(query(".step-summary").textContent).toBe("4 tool calls");
  advanceTo(replayAt - 1);
  checkPhase({ headerThinking: "Thinking · 5s" });
  replayNext(); // first reasoning text, still folded
  checkPhase({ headerThinking: "Thinking · 6s" });
  replayNext(); // thinking_end marker
  checkPhase();
  expect(query(".step-summary").textContent).toBe("4 tool calls");
  replayNext(); // persisted thinking block
  checkPhase();
  expect(query(".step-summary").textContent).toBe("1 thinking · 4 tool calls");
  const toolStartedAt = replayAt;
  replayNext();
  expect(query(".step-summary").textContent).toBe("1 thinking · 5 tool calls");
  advanceTo(toolStartedAt + 2_999);
  checkPhase();
  advanceTo(toolStartedAt + 3_000);
  checkPhase({ footerLabel: "RunTests · 3s" });
  replayNext(); // server activity takes precedence
  checkPhase({ footerLabel: "Checking layout · 3s" });

  // Let the strip's ResizeObserver publish its measurements before checking the fades.
  await nextPaint();
  if (width <= 600) {
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    expect(strip.hasAttribute("data-fade-end")).toBe(true);
    expect(strip.hasAttribute("data-fade-start")).toBe(false);
    strip.scrollLeft = strip.scrollWidth;
    fireEvent.scroll(strip);
    expect(strip.hasAttribute("data-fade-start")).toBe(true);
    expect(strip.hasAttribute("data-fade-end")).toBe(false);
  } else {
    expect(strip.scrollWidth).toBe(strip.clientWidth);
    expect(strip.hasAttribute("data-fade-start")).toBe(false);
    expect(strip.hasAttribute("data-fade-end")).toBe(false);
  }
  while (nextIndex < tail.length) replayNext();
  expect(container.querySelector(".turn-footer")).toBeNull();
});

it.each([390, 520, 600, 960])("keeps standalone thinking stable at %ipx", async (width) => {
  await page.viewport(width, 800);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const now = 1_800_000_000_000;
  vi.setSystemTime(now);
  let msg = streaming("first", now);
  const view = () => <MessageItem msg={msg} agents={[agent]} />;
  const { container, rerender } = render(view());
  await document.fonts.ready;
  const query = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  expect(container.querySelector(".turn-footer")).toBeNull();
  const flush = (event: StreamEvent) => {
    msg = applyEventsToMessage(msg, [event]);
    rerender(view());
  };

  const content = "Let me see.\n\n<details><summary>Notes</summary>\n\n- Evidence\n\n</details>";
  flush({ kind: "thinking_delta", content, startedAt: now });
  const box = query(".step-group");
  const header = query(".step-header");
  const toggle = query(".events-toggle");
  const headerHeight = rect(header).height;
  const collapsedHeight = rect(box).height;
  expect(header.textContent).toBe("▸Thinking · 0s");
  expect(container.querySelector(".turn-footer")).toBeNull();
  expect(container.querySelectorAll(".chip-live")).toHaveLength(1);
  expect(container.querySelector(".live-thinking")).toBeNull();
  fireEvent.click(toggle);
  const liveEvent = query(".live-thinking");
  const liveBody = query(".live-thinking > .event-content");
  expect(liveEvent.querySelector(".event-row")).toBeNull();
  // No artificial 18px empty row above the streaming body (only .event's 3px top padding).
  expect(rect(liveBody).top - rect(liveEvent).top).toBeLessThanOrEqual(4);
  const details = query(".live-thinking details") as HTMLDetailsElement;
  fireEvent.click(query(".live-thinking summary"));
  expect(details.open).toBe(true);
  void act(() => vi.advanceTimersByTime(1_000));
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(header.textContent).toContain("Thinking · 1s");
  expect(container.querySelectorAll(".chip-live")).toHaveLength(1);
  expect(container.querySelector(".turn-footer")).toBeNull();
  expect(rect(header).height).toBe(headerHeight);
  const expandedHeight = rect(box).height;

  flush({ kind: "thinking_delta", content: "", durationMs: 1_000, thinkingFollows: true });
  expect(query(".step-group")).toBe(box);
  expect(query(".step-header")).toBe(header);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(query(".live-thinking details")).toBe(details);
  expect(details.open).toBe(true);
  expect(header.querySelector(".chip-live")).toBeNull();
  expect(container.querySelector(".turn-footer")).toBeNull();
  expect(rect(header).height).toBe(headerHeight);
  expect(rect(box).height).toBe(expandedHeight);

  flush({ kind: "thinking", content, durationMs: 1_000, waitingSince: Date.now() });
  expect(query(".step-group")).toBe(box);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(header.querySelector(".step-summary")?.textContent).toBe("1 thinking");
  expect(query(".event-thinking details")).toBe(details);
  expect(details.open).toBe(true);
  expect(query(".event-thinking > .event-row .chip-thinking").textContent).toBe("Thought for 1s");
  expect(rect(header).height).toBe(headerHeight);
  expect(container.querySelector(".turn-footer")).toBeNull();
  fireEvent.click(toggle);
  expect(header.textContent).toBe("▸1 thinking");
  expect(rect(box).height).toBe(collapsedHeight);
  void act(() => vi.advanceTimersByTime(15_000));
  const waitFooter = query(".turn-footer");
  expect(waitFooter.textContent).toBe("No new events for 15s");
  expect(rect(waitFooter).height).toBe(20);
  flush({ kind: "tool_use", content: "**Read**", toolName: "Read", startedAt: Date.now() });
  expect(container.querySelector(".turn-footer")).toBeNull();
  void act(() => vi.advanceTimersByTime(3_000));
  const toolFooter = query(".turn-footer");
  expect(toolFooter.textContent).toBe("Read · 3s");
  expect(rect(toolFooter).height).toBe(20);
});

it.each([
  [390, "dark"],
  [960, "light"],
] as const)(
  "reads the same thinking while streaming and after reopen at %ipx (%s)",
  async (width, theme) => {
    await page.viewport(width, 800);
    await loadMath();
    document.documentElement.dataset.theme = theme;
    try {
      const now = Date.now();
      const initial = streaming("sample", now);
      const command = String.raw`find . \( -name '*.ts' \)`;
      const argument = "/tmp/_test_/*.ts";
      const tail = String.raw` and ${argument}, $O(n \log n)$, then *read this*.`;
      const view = (msg: Message) => <MessageItem msg={msg} agents={[]} />;
      let msg = applyEventsToMessage(initial, [
        { kind: "thinking_delta", content: command, startedAt: now },
      ]);
      const live = render(view(msg));
      const expand = (dom: ReturnType<typeof render>) =>
        fireEvent.click(dom.getByRole("button", { name: "Expand steps" }));
      expand(live);
      msg = applyEventsToMessage(msg, [{ kind: "thinking_delta", content: tail, startedAt: now }]);
      live.rerender(view(msg));
      const read = (container: HTMLElement) => {
        const body = container.querySelector<HTMLElement>(".event-thinking .event-content")!;
        expect(body.innerText).toContain(`${command} and ${argument}`);
        expect(body.querySelector("em")?.textContent).toBe("read this");
        expect(body.querySelectorAll(".katex")).toHaveLength(1);
        expect(body.querySelector(".katex-display, .katex-error, pre, code")).toBeNull();
        expect(rect(body).height).toBeGreaterThan(0);
        return body.innerHTML;
      };
      const visible = read(live.container);
      const done = applyEventsToMessage(msg, [
        { kind: "thinking", content: command + tail, durationMs: 1 },
      ]);
      live.unmount();
      const reopened = render(view({ ...withoutLiveTiming(done), status: "done" }));
      expand(reopened);
      expect(read(reopened.container)).toBe(visible);
    } finally {
      delete document.documentElement.dataset.theme;
    }
  },
);

it.each([
  ["dark", 390],
  ["light", 390],
  ["dark", 960],
  ["light", 960],
] as const)(
  "keeps live thinking unified in .step-header across placements in %s mode at %ipx",
  async (theme, width) => {
    await themedViewport(width, 800, theme);
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = 1_800_000_000_000;
    vi.setSystemTime(now);
    const cases: Array<{ name: string; events: StreamEvent[]; expectSummary?: string }> = [
      { name: "standalone", events: [] },
      {
        name: "after prior steps",
        events: [
          { kind: "thinking", content: "Initial plan.", durationMs: 2_000, contentOffset: 0 },
          {
            kind: "tool_use",
            toolName: "Read",
            toolUseId: "t1",
            content: "**Read** `src/index.ts`",
            toolResult: "ok",
            contentOffset: 0,
          },
        ],
        expectSummary: "1 thinking · 1 tool call",
      },
      {
        name: "after subagent",
        events: [
          {
            kind: "subagent_start",
            content: "",
            contentOffset: 0,
            subagent: { taskId: "sa1", description: "Audit code", status: "completed" },
          },
        ],
      },
      {
        name: "after banner",
        events: [
          {
            kind: "notice",
            level: "info",
            content: "Context checkpoint saved",
            contentOffset: 0,
          },
        ],
      },
    ];

    try {
      for (const scenario of cases) {
        const msg = streaming(`m-${scenario.name.replace(/\s+/g, "-")}`, now - 10_000, {
          events: scenario.events,
          liveThinking: "Evaluating next step.",
          liveThinkingSince: now - 4_000,
        });
        const { container, unmount } = render(inTranscript(msg));
        await document.fonts.ready;

        const header = container.querySelector<HTMLElement>(".step-header")!;
        const chip = header.querySelector<HTMLElement>(".chip-live")!;
        expect(chip, scenario.name).not.toBeNull();
        expect(chip.textContent, scenario.name).toBe("Thinking · 4s");
        expect(container.querySelector(".turn-footer"), scenario.name).toBeNull();
        expect(rect(chip).right, scenario.name).toBeLessThanOrEqual(rect(header).right + 0.5);
        expect(document.documentElement.scrollWidth, scenario.name).toBeLessThanOrEqual(width);

        if (scenario.expectSummary) {
          const summary = header.querySelector<HTMLElement>(".step-summary")!;
          expect(summary.textContent, scenario.name).toBe(scenario.expectSummary);
          expect(rect(summary).right, scenario.name).toBeLessThanOrEqual(rect(chip).left);
        }

        // Expanding live thinking sits directly under .events-list without an 18px empty .event-row gap.
        fireEvent.click(header);
        const liveEvent = container.querySelector<HTMLElement>(".live-thinking")!;
        const liveBody = container.querySelector<HTMLElement>(".live-thinking > .event-content")!;
        expect(liveEvent.querySelector(".event-row"), scenario.name).toBeNull();
        expect(rect(liveBody).top - rect(liveEvent).top, scenario.name).toBeLessThanOrEqual(4);
        expect(container.querySelector(".turn-footer"), scenario.name).toBeNull();

        unmount();
      }
    } finally {
      delete document.documentElement.dataset.theme;
    }
  },
);

it("keeps a long step summary and live timer inside the header at 320px", async () => {
  await page.viewport(320, 800);
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = 1_800_000_000_000;
  vi.setSystemTime(now);
  const events: StreamEvent[] = [
    ...Array.from({ length: 100 }, (): StreamEvent => ({
      kind: "thinking",
      content: "step",
      contentOffset: 0,
    })),
    ...Array.from({ length: 100 }, (_, i): StreamEvent => ({
      kind: "tool_use",
      toolName: "Read",
      toolUseId: `t-${i}`,
      content: "**Read** `a`",
      toolResult: "ok",
      contentOffset: 0,
    })),
    ...Array.from({ length: 100 }, (): StreamEvent => ({
      kind: "tool_result",
      content: "orphan",
      contentOffset: 0,
    })),
  ];
  const msg = streaming("narrow-long", now - 15_000, {
    events,
    liveThinking: "Still checking.",
    liveThinkingSince: now - 12_000,
  });
  const { container } = render(inTranscript(msg));
  await document.fonts.ready;

  const header = container.querySelector<HTMLElement>(".step-header")!;
  const summary = header.querySelector<HTMLElement>(".step-summary")!;
  const chip = header.querySelector<HTMLElement>(".chip-live")!;
  expect(summary.textContent).toBe("100 thinking · 100 tool calls · 100 results");
  expect(chip.textContent).toBe("Thinking · 12s");
  expect(container.querySelector(".turn-footer")).toBeNull();
  expect(rect(summary).right).toBeLessThanOrEqual(rect(header).right + 0.5);
  expect(rect(chip).left).toBeGreaterThanOrEqual(rect(header).left - 0.5);
  expect(rect(chip).right).toBeLessThanOrEqual(rect(header).right + 0.5);
  expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
});

it.each([390, 960])(
  "matches live stream and timestamp-only reconnect snapshot geometry at %ipx",
  async (width) => {
    await page.viewport(width, 800);
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = 1_800_000_000_000;
    vi.setSystemTime(now);
    const base = streaming("equiv", now - 10_000, { events: [] });
    const renderView = inTranscript;
    const measure = (root: HTMLElement) => {
      const header = root.querySelector<HTMLElement>(".step-header")!;
      const chip = header.querySelector<HTMLElement>(".chip-live")!;
      return {
        headerHeight: rect(header).height,
        chipText: chip.textContent,
        chipLeft: rect(chip).left,
        turnHeight: rect(root.querySelector<HTMLElement>(".message")!).height,
        footer: root.querySelector(".turn-footer"),
      };
    };

    // 1. After prior steps: a timestamp-only server snapshot (no client-only liveThinking)
    // matches the continuous stream's step-header chip, height, and absent footer immediately.
    let streamed = base;
    const liveView = render(renderView(streamed));
    for (const ev of [
      {
        kind: "tool_use",
        toolName: "Read",
        toolUseId: "t1",
        content: "**Read** `src/app.ts`",
        contentOffset: 0,
      },
      { kind: "tool_result", toolUseId: "t1", content: "ok" },
      { kind: "thinking_delta", startedAt: now - 5_000, content: "Checking state." },
    ] satisfies StreamEvent[]) {
      streamed = applyEventsToMessage(streamed, [ev]);
      liveView.rerender(renderView(streamed));
    }
    await document.fonts.ready;
    const fromStream = measure(liveView.container);
    liveView.unmount();

    const snapshot: Message = {
      ...base,
      events: streamed.events,
      liveThinkingSince: now - 5_000,
    };
    const snapView = render(renderView(snapshot));
    await document.fonts.ready;
    const fromSnapshot = measure(snapView.container);
    expect(fromStream.footer).toBeNull();
    expect(fromStream.chipText).toBe("Thinking · 5s");
    expect(fromSnapshot).toEqual(fromStream);
    snapView.unmount();

    // 2. Standalone timestamp-only snapshot: timer renders in .step-header with no footer,
    // and the next thinking_delta restores the expand affordance without a 18px empty row.
    let standaloneSnap: Message = { ...base, liveThinkingSince: now - 5_000 };
    const standaloneView = render(renderView(standaloneSnap));
    await document.fonts.ready;
    const beforeDelta = measure(standaloneView.container);
    expect(beforeDelta.footer).toBeNull();
    expect(beforeDelta.chipText).toBe("Thinking · 5s");
    expect(standaloneView.container.querySelector(".trace-header-toggle")).toBeNull();

    standaloneSnap = applyEventsToMessage(standaloneSnap, [
      { kind: "thinking_delta", startedAt: now - 5_000, content: "Resumed reasoning." },
    ]);
    standaloneView.rerender(renderView(standaloneSnap));
    const afterDelta = measure(standaloneView.container);
    expect(afterDelta).toEqual(beforeDelta);
    fireEvent.click(standaloneView.container.querySelector(".trace-header-toggle")!);
    const liveEvent = standaloneView.container.querySelector<HTMLElement>(".live-thinking")!;
    const liveBody = standaloneView.container.querySelector<HTMLElement>(
      ".live-thinking > .event-content",
    )!;
    expect(liveEvent.querySelector(".event-row")).toBeNull();
    expect(rect(liveBody).top - rect(liveEvent).top).toBeLessThanOrEqual(4);
    expect(liveBody.textContent).toBe("Resumed reasoning.");
  },
);
