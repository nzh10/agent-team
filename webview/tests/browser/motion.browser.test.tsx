import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { StepGroup, SubAgentItem } from "../../src/chat/messages";
import { TranscriptChoiceScope } from "../../src/chat/transcriptChoices";
import "../../src/styles.css";

afterEach(async () => {
  cleanup();
  delete document.documentElement.dataset.theme;
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

it("stops status loops and chrome motion without hiding status text in reduced motion", async () => {
  await page.viewport(1100, 800);
  const setMotion = (value: string) =>
    cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value }],
    });
  await setMotion("no-preference");
  const { container } = render(
    <>
      <span className="task-status running" />
      <span className="task-status waiting" />
      <span className="task-status waiting sleeping" />
      <span className="agent-status-dot agent-status-busy" />
      <span className="agent-status-dot agent-status-waiting" />
      <span className="agent-status-dot agent-status-sleeping" />
      <span className="pr-checks pr-checks-pending" />
      <span className="delivery-inline">
        <span className="streaming-dot" /> Streaming
      </span>
      <span className="banner banner-retry">
        <span className="banner-icon">!</span> Retrying
      </span>
      <span className="subagent-icon-running">◌</span>
      <span className="history-loading history-cold-reveal">
        <span className="spinner" /> Loading history
      </span>
      <button className="quota-refresh" disabled aria-label="Refreshing…">
        <svg className="icon" />
      </button>
      <span className="ap-dot ss-working" />
      <span className="ap-dot ss-waiting" />
      <span className="ap-dot ss-sleeping" />
      <div className="sidebar-debug-strip">Debug tools</div>
      <div className="quota-details">Quota details</div>
      <div className="stop-actions">Stop actions</div>
      <div className="dialog">New session</div>
      <div className="message-highlight">Jump target</div>
      <div className="code-block">
        <button className="copy-btn">Copy code</button>
      </div>
      <div className="event-summary-line">
        <button className="copy-btn">Copy path</button>
      </div>
      <div className="message-actions">
        <button className="copy-btn btn-copy-message">Copy message</button>
      </div>
      <button className="btn-primary">Create</button>
    </>,
  );
  // Inspect the authored effects, even if the runner is descheduled past 120 ms.
  for (const animation of container.getAnimations({ subtree: true })) animation.pause();
  const get = (selector: string) => container.querySelector(selector)!;
  const loopMarkers = [
    ".task-status.running",
    ".task-status.waiting:not(.sleeping)",
    ".agent-status-busy",
    ".agent-status-waiting",
    ".pr-checks-pending",
    ".streaming-dot",
    ".banner-icon",
    ".subagent-icon-running",
    ".spinner",
    ".ap-dot.ss-working",
    ".ap-dot.ss-waiting",
  ];
  const fades = [".sidebar-debug-strip", ".quota-details", ".stop-actions"];
  const statusTexts = [".delivery-inline", ".banner-retry", ".history-loading", ".quota-details"];
  const transitions = [
    ".code-block .copy-btn",
    ".event-summary-line .copy-btn",
    ".btn-copy-message",
    ".btn-primary",
  ];
  function properties(selector: string) {
    const [animation, ...rest] = get(selector).getAnimations();
    expect(rest).toEqual([]);
    const effect = animation.effect as KeyframeEffect;
    expect(effect.getTiming().duration).toBeLessThanOrEqual(150);
    const keys = new Set(effect.getKeyframes().flatMap(Object.keys));
    for (const key of ["offset", "computedOffset", "easing", "composite"]) keys.delete(key);
    return [...keys].sort();
  }
  for (const selector of loopMarkers) {
    expect(getComputedStyle(get(selector)).animationIterationCount.split(", "), selector).toContain(
      "infinite",
    );
  }
  for (const selector of [
    ".task-status.waiting.sleeping",
    ".agent-status-sleeping",
    ".ap-dot.ss-sleeping",
    ".quota-refresh .icon",
  ]) {
    expect(getComputedStyle(get(selector)).animationName, selector).toBe("none");
  }
  for (const selector of fades) expect(properties(selector), selector).toEqual(["opacity"]);
  expect(properties(".dialog")).toEqual(["opacity", "transform"]);
  const hint = get(".history-loading");
  const spinnerFade = hint
    .getAnimations({ subtree: true })
    .find((a) => (a as CSSAnimation).animationName === "chrome-reveal")!;
  expect(spinnerFade.effect?.getTiming().duration).toBe(120);
  expect(getComputedStyle(hint).opacity).toBe("1");
  for (const selector of transitions) {
    expect(getComputedStyle(get(selector)).transitionDuration, selector).not.toBe("0s");
  }

  await setMotion("reduce");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  for (const selector of [...loopMarkers, ...fades, ".dialog", ".message-highlight"]) {
    const element = get(selector);
    expect(getComputedStyle(element).animationName, selector).toBe("none");
    expect(getComputedStyle(element).opacity, selector).toBe("1");
    expect(getComputedStyle(element).visibility, selector).toBe("visible");
  }
  for (const selector of transitions) {
    expect(getComputedStyle(get(selector)).transitionDuration, selector).toBe("0s");
  }
  for (const selector of statusTexts) {
    expect(get(selector).textContent?.trim(), selector).toBeTruthy();
    expect(get(selector).getBoundingClientRect().height, selector).toBeGreaterThan(0);
  }
  const accent = getComputedStyle(get(".message-highlight"), "::before");
  expect(accent.animationName).toBe("none");
  expect(accent.opacity).toBe("1");
  expect(accent.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
});

it.each(["light", "dark"])(
  "keeps mobile jump emphasis and disclosure motion local (%s)",
  async (theme) => {
    await page.viewport(390, 844);
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
    document.documentElement.dataset.theme = theme;
    const choices = new Map();
    const view = render(<div className="messages" />);
    const setMotion = (value: string) =>
      cdp().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value }],
      });
    for (const mode of ["no-preference", "reduce"]) {
      await setMotion(mode);
      choices.clear();
      const chat = (open: boolean) => (
        <div className="messages">
          {open && (
            <TranscriptChoiceScope id="row" choices={choices}>
              <div className="message message-highlight" style={{ height: 60 }}>
                Jumped
              </div>
              <div className="message message-highlight" style={{ height: 1800 }}>
                Tall reply
              </div>
              <StepGroup group={{ step: 0, events: [{ kind: "thinking", content: "Thought" }] }} />
              <SubAgentItem
                ev={{
                  kind: "subagent_start",
                  content: "",
                  subagent: { taskId: "a", description: "Check", status: "completed" },
                }}
              />
            </TranscriptChoiceScope>
          )}
        </div>
      );
      view.rerender(chat(true));
      const rows = [...view.container.querySelectorAll(".message-highlight")];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const tint = getComputedStyle(row, "::before");
        const { width, height } = row.getBoundingClientRect();
        expect([tint.top, tint.right, tint.bottom, tint.left]).toEqual(Array(4).fill("0px"));
        expect([parseFloat(tint.width), parseFloat(tint.height)]).toEqual([width, height]);
        expect(tint.pointerEvents).toBe("none");
      }
      const [row] = rows;
      const tint = getComputedStyle(row, "::before");
      expect(getComputedStyle(row).opacity).toBe("1");
      expect(tint.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      if (mode === "no-preference") {
        const animation = row.getAnimations({ subtree: true })[0];
        const effect = animation.effect as KeyframeEffect;
        expect(effect.getTiming()).toMatchObject({ duration: 300, delay: 1000, fill: "forwards" });
        expect(effect.getKeyframes().map((frame) => frame.opacity)).toEqual(["1", "0"]);
        animation.pause();
        animation.currentTime = 999;
        expect(tint.opacity).toBe("1");
        animation.currentTime = 1300;
        expect(tint.opacity).toBe("0");
      } else expect(tint.animationName).toBe("none");
      const toggles = () => view.container.querySelectorAll(".trace-header-toggle");
      for (const button of toggles()) {
        const { width, height } = button.getBoundingClientRect();
        const caret = button.querySelector(".trace-caret")!;
        expect(getComputedStyle(caret).transform).toBe("none");
        fireEvent.click(button.closest(".step-header,.subagent-header")!);
        expect(button.getAttribute("aria-expanded")).toBe("true");
        expect(button.getBoundingClientRect()).toMatchObject({ width, height });
        expect(getComputedStyle(caret).transitionDuration).toBe(mode === "reduce" ? "0s" : "0.12s");
      }
      view.rerender(chat(false));
      view.rerender(chat(true));
      for (const caret of view.container.querySelectorAll(".trace-caret")) {
        expect(caret.getAnimations()).toHaveLength(0);
        expect(getComputedStyle(caret).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
      }
      const messages = view.container.querySelector(".messages")!;
      expect(getComputedStyle(messages, "::-webkit-scrollbar-thumb").minHeight).toBe("50px");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      view.rerender(chat(false));
    }
  },
);
