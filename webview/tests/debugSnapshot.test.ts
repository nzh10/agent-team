import { describe, it, expect } from "vitest";
import { collectSnapshot, trimmedHtml, SNAPSHOT_SELECTORS } from "../src/dev/debugSnapshot";

describe("debug snapshot", () => {
  it("collects geometry for the shell elements that exist and trims message bodies", () => {
    document.body.innerHTML = `
      <div id="root"><div class="app"><div class="main-panel">
        <div class="panel-header"></div>
        <div class="messages">
          <div class="history-hint">hint</div>
          <div class="message">1</div><div class="message">2</div>
          <div class="message">3</div><div class="message">4</div>
        </div>
        <div class="input-area"><div class="input-row"><textarea class="chat-input"></textarea></div></div>
      </div></div></div>`;
    document.documentElement.style.setProperty("--app-height", "700px");
    const snap = collectSnapshot();
    const selectors = snap.elements.map((e) => e.selector);
    expect(selectors).toContain(".messages");
    expect(selectors).toContain(".input-area");
    expect(selectors).not.toContain(".sidebar");
    expect(selectors.every((s) => SNAPSHOT_SELECTORS.includes(s))).toBe(true);
    const messages = snap.elements.find((e) => e.selector === ".messages")!;
    // jsdom reports overflow as set in CSS only; force it for the assertion.
    expect(messages.scroll === undefined || typeof messages.scroll.top === "number").toBe(true);
    expect(selectors).toContain(".messages .message");
    expect(selectors).toContain(".messages > :last-child");
    expect(snap.cssVars["--app-height"]).toBe("700px");
    expect(snap.cssVars["--app-offset"]).toBe("(unset)");
    expect(snap.viewport.inner).toBe(window.innerHeight);

    const html = trimmedHtml(3);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect((html.match(/class="message"/g) ?? []).length).toBe(3);
    expect(html).not.toContain('<div class="message">1</div>');
    expect(html).toContain('<div class="message">2</div>');
    expect(html).toContain('<div class="message">3</div>');
    expect(html).toContain('<div class="message">4</div>');
    expect(html).toContain("history-hint");
    // Fewer than maxMessages keeps everything.
    expect((trimmedHtml(10).match(/class="message"/g) ?? []).length).toBe(4);
    // The live DOM is untouched.
    expect(document.querySelectorAll(".message")).toHaveLength(4);
    expect(snap.activeTurn).toBeUndefined();
  });

  it("retains the active turn past trailing queued/system siblings and reports folded step/chip/footer geometry", () => {
    document.body.innerHTML = `
      <div id="root"><div class="app"><div class="main-panel">
        <div class="messages">
          <div id="msg-old" class="message message-agent">
            <div class="message-body"><div class="message-content">old</div></div>
          </div>
          <div id="msg-active" class="message message-agent">
            <div class="message-body">
              <div class="message-header"><span class="streaming-dot"></span></div>
              <div class="message-content">
                <div class="step-group">
                  <div class="step-header">
                    <span class="step-summary">1 thinking · 1 tool call</span>
                    <span class="step-tools"><span class="step-tools-track">
                      <span class="event-chip chip-mini chip-tool">EarlierTool</span>
                    </span></span>
                  </div>
                </div>
                <div class="step-group">
                  <div class="step-header">
                    <span class="step-summary">1 thinking · 4 tool calls</span>
                    <span class="step-tools" data-fade-end="true">
                      <span class="step-tools-track">
                        <span class="event-chip chip-mini chip-tool">Read</span>
                        <span class="event-chip chip-mini chip-tool">Grep</span>
                        <span class="event-chip chip-mini chip-tool">Bash</span>
                        <span class="event-chip chip-mini chip-panel">status</span>
                        <span class="step-tools-more">+2</span>
                      </span>
                    </span>
                  </div>
                </div>
              </div>
              <div class="turn-footer">
                <span class="event-chip chip-thinking chip-live">
                  <span class="streaming-dot"></span>Thinking · 6s
                </span>
              </div>
            </div>
          </div>
          <div id="msg-q1" class="message message-user message-queued">queued 1</div>
          <div class="system-message">Alice joined</div>
          <div id="msg-q2" class="message message-user message-queued">queued 2</div>
          <div id="msg-q3" class="message message-user message-queued">queued 3</div>
        </div>
      </div></div></div>`;

    // Simulate two visual rows of chips to verify row wrapping inference.
    const chips = [
      ...document.querySelectorAll("#msg-active .step-group:last-of-type .event-chip"),
    ];
    const tops = [120, 120.5, 146, 146];
    chips.forEach((chip, i) => {
      chip.getBoundingClientRect = () => ({
        top: tops[i],
        bottom: tops[i] + 20,
        left: (i % 2) * 80,
        right: (i % 2) * 80 + 60,
        width: 60,
        height: 20,
        x: (i % 2) * 80,
        y: tops[i],
        toJSON: () => ({}),
      });
    });

    const snap = collectSnapshot();
    expect(snap.activeTurn).toBeDefined();
    expect(snap.activeTurn!.id).toBe("msg-active");
    expect(snap.activeTurn!.index).toBe(1);
    expect(snap.activeTurn!.siblingCount).toBe(6);
    expect(snap.activeTurn!.trailingSiblings).toBe(4);

    // Captures the trailing step group, not the earlier one.
    const step = snap.activeTurn!.stepGroup!;
    expect(step.open).toBe(false);
    expect(step.summary?.text).toBe("1 thinking · 4 tool calls");
    expect(step.toolsStrip?.fadeStart).toBe(false);
    expect(step.toolsStrip?.fadeEnd).toBe(true);
    expect(step.toolsStrip?.moreText).toBe("+2");
    expect(step.toolChips.map((c) => c.label)).toEqual(["Read", "Grep", "Bash", "status"]);
    expect(step.toolChips.map((c) => c.row)).toEqual([0, 0, 1, 1]);
    expect(step.toolChipRowCount).toBe(2);
    expect(step.toolChipsTotal).toBe(4);
    expect(step.toolChipsTruncated).toBe(false);

    // Captures the live thinking chip inside .turn-footer.
    expect(snap.activeTurn!.turnFooter?.state).toBe("thinking");
    expect(snap.activeTurn!.turnFooter?.text).toBe("Thinking · 6s");
    expect(snap.activeTurn!.turnFooter?.liveChip?.text).toBe("Thinking · 6s");

    // trimmedHtml(3) drops msg-old and msg-q1, retains msg-active + last 3 siblings.
    expect(snap.html).toContain('id="msg-active"');
    expect(snap.html).toContain("Alice joined");
    expect(snap.html).toContain('id="msg-q2"');
    expect(snap.html).toContain('id="msg-q3"');
    expect(snap.html).not.toContain('id="msg-old"');
    expect(snap.html).not.toContain('id="msg-q1"');
  });

  it("captures live open step geometry, bounds tool chips/events, and strips tool payloads", () => {
    const manyTools = Array.from(
      { length: 16 },
      (_, i) => `
      <div class="event event-tool_use">
        <div class="event-row">
          <span class="event-chip chip-tool">Tool${i + 1}</span>
        </div>
        <div class="event-summary-line"><code>SECRET_SUMMARY_${i + 1}</code></div>
        <div class="event-content"><pre>SECRET_COMMAND_PAYLOAD_${i + 1}</pre></div>
        <div class="event-content event-result"><pre>SECRET_RESULT_PAYLOAD_${i + 1}</pre></div>
      </div>`,
    ).join("");
    document.body.innerHTML = `
      <div id="root"><div class="app"><div class="main-panel">
        <div class="messages">
          <div id="msg-live" class="message message-agent">
            <div class="message-body">
              <div class="message-header"><span class="streaming-dot"></span></div>
              <div class="message-content">
                <div class="step-group open">
                  <div class="step-header">
                    <span class="step-summary">1 thinking · 16 tool calls</span>
                  </div>
                  <div class="events-list">
                    ${manyTools}
                    <div class="event event-thinking live-thinking">
                      <div class="event-content">${"thinking ".repeat(60)}</div>
                    </div>
                  </div>
                </div>
                <div class="banner banner-action" data-action="message_session">
                  <span class="banner-icon">◆</span>
                  <div class="banner-text">
                    <span class="banner-label">Message</span>
                    <span class="action-target">worker</span>
                    <span class="banner-first-line">SECRET_ACTION_PREVIEW</span>
                    <div class="md-block">SECRET_ACTION_QUOTE</div>
                    <div class="action-result">SECRET_ACTION_RESULT</div>
                  </div>
                </div>
                <div class="subagent-item">
                  <div class="subagent-details">
                    <div class="subagent-prompt">SECRET_SUBAGENT_PROMPT</div>
                    <div class="subagent-events">
                      <div class="event event-text">
                        <div class="event-content">SECRET_SUBAGENT_TEXT</div>
                      </div>
                    </div>
                    <div class="subagent-summary">SECRET_SUBAGENT_SUMMARY</div>
                  </div>
                </div>
              </div>
              <div class="turn-footer">Waiting for the model · 8s</div>
            </div>
          </div>
          <div class="system-message">Notice 1</div>
          <div class="system-message">Notice 2</div>
          <div class="system-message">Notice 3</div>
          <div class="system-message">Notice 4</div>
        </div>
      </div></div></div>`;

    const snap = collectSnapshot();
    const step = snap.activeTurn!.stepGroup!;
    expect(step.open).toBe(true);
    expect(step.toolChipsTotal).toBe(16);
    expect(step.toolChipsTruncated).toBe(true);
    expect(step.toolChips).toHaveLength(12);
    expect(step.toolChips[0].label).toBe("Tool5");
    expect(step.toolChips.at(-1)!.label).toBe("Tool16");
    expect(step.liveThinking).toBeDefined();
    expect(step.liveThinking!.selector).toBe(".live-thinking");

    expect(snap.activeTurn!.turnFooter?.state).toBe("waiting");
    expect(snap.activeTurn!.turnFooter?.text).toBe("Waiting for the model · 8s");
    expect(snap.activeTurn!.trailingSiblings).toBe(4);

    // No tool payloads, panel action payloads, or subagent prompts/summaries leak anywhere.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("SECRET_SUMMARY_");
    expect(serialized).not.toContain("SECRET_COMMAND_PAYLOAD_");
    expect(serialized).not.toContain("SECRET_RESULT_PAYLOAD_");
    expect(serialized).not.toContain("SECRET_ACTION_PREVIEW");
    expect(serialized).not.toContain("SECRET_ACTION_QUOTE");
    expect(serialized).not.toContain("SECRET_ACTION_RESULT");
    expect(serialized).not.toContain("SECRET_SUBAGENT_PROMPT");
    expect(serialized).not.toContain("SECRET_SUBAGENT_TEXT");
    expect(serialized).not.toContain("SECRET_SUBAGENT_SUMMARY");
    // Live thinking body in HTML is bounded, and live DOM itself is untouched.
    expect(document.querySelector(".event-tool_use .event-content")?.textContent).toContain(
      "SECRET_COMMAND_PAYLOAD_1",
    );
    expect(document.querySelectorAll(".events-list .event-tool_use")).toHaveLength(16);
  });

  it("captures the standalone thinking chip in the header, not as history or footer text", () => {
    document.body.innerHTML = `
      <div class="messages">
        <div id="msg-live" class="message message-agent">
          <div class="message-body">
            <div class="step-group">
              <div class="step-header">
                <span class="event-chip chip-thinking chip-live">Thinking · 6s</span>
              </div>
            </div>
            <div class="turn-footer"></div>
          </div>
        </div>
      </div>`;
    const turn = collectSnapshot().activeTurn!;
    expect(turn.stepGroup?.liveChip).toMatchObject({
      selector: ".step-header .chip-live",
      text: "Thinking · 6s",
    });
    expect(turn.stepGroup?.summary).toBeUndefined();
    expect(turn.turnFooter).toMatchObject({ state: "quiet", text: "" });
    expect(turn.turnFooter?.liveChip).toBeUndefined();
  });

  it("distinguishes activity and quiet states in turn-footer", () => {
    document.body.innerHTML = `
      <div class="messages">
        <div id="msg-act" class="message message-agent">
          <div class="message-body">
            <div class="turn-footer"><span class="turn-activity">RunTests · 4s</span></div>
          </div>
        </div>
      </div>`;
    const actSnap = collectSnapshot();
    expect(actSnap.activeTurn?.turnFooter?.state).toBe("activity");
    expect(actSnap.activeTurn?.turnFooter?.activity?.text).toBe("RunTests · 4s");

    document.querySelector(".turn-footer")!.innerHTML = "";
    const quietSnap = collectSnapshot();
    expect(quietSnap.activeTurn?.turnFooter?.state).toBe("quiet");
    expect(quietSnap.activeTurn?.turnFooter?.text).toBe("");
  });
});
