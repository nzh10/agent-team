import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { MessageItem } from "../../src/chat/messages";
import { buildFrames, DEMO_WS_ID, frameDelay, LAYOUT_TURN_ID } from "../../src/dev/replayFixture";
import { applyEventsToMessage, withoutLiveTiming } from "../../src/state/stream";
import type { AgentInfo, Message, StreamEvent, Workspace } from "../../src/state/useServer";
import "../../src/fonts/sarasa-mono-sc/regular/result.css";
import "../../src/fonts/sarasa-mono-sc/bold/result.css";
import "../../src/styles.css";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rect = (el: Element) => el.getBoundingClientRect();

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
      <style>{"* { animation: none !important; transition: none !important; }"}</style>
      <MessageItem msg={msg} agents={agents} />
    </div>
  );
  const { container, rerender } = render(view());
  await document.fonts.ready;
  const query = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  const turn = query(".message");
  const footer = query(".turn-footer");
  const header = query(".step-header");
  const strip = query(".step-tools");
  const measure = () => [rect(turn).height, rect(header).height, rect(footer).height];
  const initial = measure();
  expect(initial[2]).toBeGreaterThan(0);

  function checkPhase(label: string) {
    expect([...container.querySelectorAll(".turn-footer")]).toEqual([footer]);
    expect(footer).toBe(query(".message-body").lastElementChild);
    expect(footer.textContent).toBe(label);
    expect(measure(), label || "quiet placeholder").toEqual(initial);
    expect(container.querySelector(".events-list")).toBeNull();

    const summary = query(".step-summary");
    const text = document.createRange();
    text.selectNodeContents(summary);
    expect(text.getClientRects()).toHaveLength(1);
    expect(rect(summary).right).toBeLessThanOrEqual(rect(header).right);
    expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth);
    expect(getComputedStyle(summary).textOverflow).not.toBe("ellipsis");
    const chips = [...strip.querySelectorAll<HTMLElement>(".event-chip")];
    expect(chips.length).toBeGreaterThanOrEqual(4);
    expect(chips.some((chip) => rect(chip).width > 220)).toBe(true);
    for (const [i, chip] of chips.entries()) {
      expect(rect(chip).top).toBe(rect(chips[0]).top);
      if (i > 0) expect(rect(chips[i - 1]).right).toBeLessThanOrEqual(rect(chip).left);
      expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
      expect(getComputedStyle(chip).textOverflow).not.toBe("ellipsis");
    }
    if (width <= 520) {
      expect(rect(summary).bottom).toBeLessThanOrEqual(rect(chips[0]).top);
    } else {
      expect(rect(summary).right).toBeLessThanOrEqual(rect(strip).left);
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

  checkPhase("");
  advanceTo(quietSince + 4_999);
  checkPhase("");
  advanceTo(quietSince + 5_000);
  checkPhase("Waiting for the model · 5s");
  replayNext(); // thinking_start
  checkPhase("Thinking · 0s");
  expect(query(".step-summary").textContent).toBe("4 tool calls");
  expect(header.querySelector(".chip-live")).toBeNull();
  advanceTo(replayAt - 1);
  checkPhase("Thinking · 5s");
  replayNext(); // first reasoning text, still folded
  checkPhase("Thinking · 6s");
  replayNext(); // thinking_end marker
  checkPhase("");
  expect(query(".step-summary").textContent).toBe("4 tool calls");
  replayNext(); // persisted thinking block
  checkPhase("");
  expect(query(".step-summary").textContent).toBe("1 thinking · 4 tool calls");
  const toolStartedAt = replayAt;
  replayNext();
  expect(query(".step-summary").textContent).toBe("1 thinking · 5 tool calls");
  advanceTo(toolStartedAt + 2_999);
  checkPhase("");
  advanceTo(toolStartedAt + 3_000);
  checkPhase("RunTests · 3s");
  replayNext(); // server activity takes precedence
  checkPhase("Checking layout · 3s");

  // Let the strip's ResizeObserver publish its measurements before checking the fades.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
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
  const agent: AgentInfo = {
    id: "a1",
    name: "Alice",
    color: "#528bff",
    model: "test",
    avatar: "A",
    isDefault: true,
  };
  let msg: Message = {
    id: "first",
    kind: "agent",
    agentId: agent.id,
    content: "",
    timestamp: now,
    status: "streaming",
  };
  const view = () => <MessageItem msg={msg} agents={[agent]} />;
  const { container, rerender } = render(view());
  await document.fonts.ready;
  const query = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  const footer = query(".turn-footer");
  const footerHeight = rect(footer).height;
  expect(footerHeight).toBeGreaterThan(0);
  const flush = (event: StreamEvent) => {
    msg = applyEventsToMessage(msg, [event]);
    rerender(view());
    expect(query(".turn-footer")).toBe(footer);
    expect(rect(footer).height).toBe(footerHeight);
  };

  const content = "Let me see.\n\n<details><summary>Notes</summary>\n\n- Evidence\n\n</details>";
  flush({ kind: "thinking_delta", content, startedAt: now });
  const box = query(".step-group");
  const header = query(".step-header");
  const toggle = query(".events-toggle");
  const headerHeight = rect(header).height;
  const collapsedHeight = rect(box).height;
  expect(header.textContent).toBe("▸Thinking · 0s");
  expect(footer.textContent).toBe("");
  expect(container.querySelectorAll(".chip-live")).toHaveLength(1);
  expect(container.querySelector(".live-thinking")).toBeNull();
  fireEvent.click(toggle);
  const details = query(".live-thinking details") as HTMLDetailsElement;
  fireEvent.click(query(".live-thinking summary"));
  expect(details.open).toBe(true);
  void act(() => vi.advanceTimersByTime(1_000));
  expect(header.textContent).toBe("▾Thinking · 1s");
  expect(container.querySelectorAll(".chip-live")).toHaveLength(1);
  expect(footer.textContent).toBe("");
  expect(rect(header).height).toBe(headerHeight);
  const expandedHeight = rect(box).height;

  flush({ kind: "thinking_delta", content: "", durationMs: 1_000, thinkingFollows: true });
  expect(query(".step-group")).toBe(box);
  expect(query(".step-header")).toBe(header);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(query(".live-thinking details")).toBe(details);
  expect(details.open).toBe(true);
  expect(header.textContent).toBe("▾");
  expect(footer.textContent).toBe("");
  expect(rect(header).height).toBe(headerHeight);
  expect(rect(box).height).toBe(expandedHeight);

  flush({ kind: "thinking", content, durationMs: 1_000, waitingSince: Date.now() });
  expect(query(".step-group")).toBe(box);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(header.textContent).toBe("▾1 thinking");
  expect(query(".event-thinking details")).toBe(details);
  expect(details.open).toBe(true);
  expect(rect(header).height).toBe(headerHeight);
  expect(rect(box).height).toBe(expandedHeight);
  fireEvent.click(toggle);
  expect(header.textContent).toBe("▸1 thinking");
  expect(rect(box).height).toBe(collapsedHeight);
  void act(() => vi.advanceTimersByTime(5_000));
  expect(footer.textContent).toBe("Waiting for the model · 5s");
  expect(rect(footer).height).toBe(footerHeight);
  flush({ kind: "tool_use", content: "**Read**", toolName: "Read", startedAt: Date.now() });
  expect(footer.textContent).toBe("");
  void act(() => vi.advanceTimersByTime(3_000));
  expect(footer.textContent).toBe("Read · 3s");
  expect(rect(footer).height).toBe(footerHeight);
});
