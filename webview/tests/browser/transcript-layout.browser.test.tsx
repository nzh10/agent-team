import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, cdp, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import {
  BannerItem,
  EventItem,
  MessageItem,
  StepGroup,
  SubAgentItem,
} from "../../src/chat/messages";
import { CreateWorkspaceDialog } from "../../src/workspace/dialogs";
import { FileOpenContext } from "../../src/chat/fileRef";
import { BoardPage } from "../../src/project/BoardPage";
import { GitBar } from "../../src/workspace/GitBar";
import "../../src/fonts/sarasa-mono-sc/regular/result.css";
import "../../src/fonts/sarasa-mono-sc/bold/result.css";
import "../../src/fonts/sarasa-mono-sc/italic/result.css";
import "../../src/fonts/sarasa-mono-sc/bold-italic/result.css";
import type { AgentInfo, Message, Objective, Project } from "../../src/state/useServer";
import "../../src/styles.css";

afterEach(cleanup);
const get = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector)!;
const rect = (el: Element) => el.getBoundingClientRect();
const long = "A very long title that has to share a row with the other controls ".repeat(10).trim();
const path = `/repo/${"very-long-directory/".repeat(20)}module.ts`;
const no = () => {};
const agent: AgentInfo = {
  id: "a",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "A",
  color: "#888",
  isDefault: true,
};
const message: Message = {
  id: "m",
  kind: "agent",
  agentId: "a",
  content: "The tests passed.",
  timestamp: 1,
  status: "done",
};

function lines(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  return new Set([...range.getClientRects()].map((r) => r.top)).size;
}

it.each([320, 1200])(
  "fits subagent execution fields at %ipx without exposing trace details",
  async (width) => {
    await page.viewport(width, 720);
    const model = "provider/" + "long-model-identifier-".repeat(12);
    const { container } = render(
      <div className="messages">
        <SubAgentItem
          ev={{
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "obs",
              description: "Reviewer",
              model,
              effort: "high",
              status: "completed",
              durationMs: 3000,
              lastTool: "Read",
              eventCount: 100,
            },
          }}
        />
      </div>,
    );
    const header = get(container, ".subagent-header");
    const compactModel = "long model identifier ".repeat(12);
    expect(header.textContent).toBe(`▸✓Reviewer${compactModel}high3s`);
    for (const selector of [
      ".subagent-desc",
      ".subagent-model",
      ".subagent-effort",
      ".subagent-time",
      ".subagent-status-icon",
    ]) {
      const field = get(header, selector);
      expect(rect(field).width).toBeGreaterThan(0);
      expect(rect(field).right).toBeLessThanOrEqual(rect(header).right + 0.5);
    }
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
    const modelField = get(header, ".subagent-model");
    expect(modelField.scrollWidth).toBeGreaterThan(modelField.clientWidth);
    expect(modelField.title).toBe(model);
  },
);

it("keeps the native toggle leading and Cancel trailing in a running subagent header", async () => {
  await page.viewport(1200, 720);
  const { container } = render(
    <SubAgentItem
      ev={{
        kind: "subagent_start",
        content: "",
        subagent: { taskId: "running", description: "Reviewer", status: "running" },
      }}
      onCancel={no}
    />,
  );
  const header = get(container, ".subagent-header");
  const cancel = get(header, ".btn-cancel-subagent");
  const toggle = get(header, ".trace-header-toggle");
  expect(rect(toggle).left).toBeCloseTo(rect(header).left);
  expect(rect(toggle).right).toBeLessThan(rect(get(header, ".subagent-status-icon")).left);
  expect(rect(cancel).right).toBeCloseTo(rect(header).right);
});

it.each([390, 1200])(
  "collapsing the %ipx step trace from the bottom restores its off-screen header",
  async (width) => {
    await page.viewport(width, width === 390 ? 844 : 720);
    const { container, getByRole } = render(
      <div className="messages" style={{ height: 360, overflowAnchor: "none" }}>
        <div style={{ flex: "none", height: 210 }} />
        <StepGroup
          group={{
            step: 0,
            events: Array.from({ length: 50 }, () => ({
              kind: "thinking",
              content: "Thinking about the next step.",
            })),
          }}
        />
        <div style={{ flex: "none", height: 2000 }} />
      </div>,
    );
    const scroller = get(container, ".messages");
    const header = get(container, ".step-header");
    const toggle = get(header, "button");
    fireEvent.click(toggle);
    const footer = getByRole("button", { name: "Collapse step trace" });
    expect(rect(footer).height).toBeGreaterThanOrEqual(width === 390 ? 44 : 26);
    if (width === 1200) expect(rect(footer).height).toBeLessThan(44);
    expect(rect(footer).width).toBeCloseTo(rect(footer.parentElement!).width, 1);
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);
    scroller.scrollTop += rect(footer).bottom - rect(scroller).bottom + 16;
    expect(rect(footer).top).toBeGreaterThan(rect(scroller).top);
    expect(rect(footer).bottom).toBeLessThan(rect(scroller).bottom);
    expect(rect(header).bottom).toBeLessThan(rect(scroller).top);
    fireEvent.click(footer);
    expect(footer.isConnected).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rect(header).top).toBeGreaterThanOrEqual(rect(scroller).top - 1);
    expect(rect(header).bottom).toBeLessThan(rect(scroller).bottom);
  },
);

it.each([
  [390, 844],
  [1200, 800],
])(
  "keeps empty thinking static and the expanded footer proportional at %ipx",
  async (width, height) => {
    await page.viewport(width, height);
    const since = Date.now();
    const view = (liveThinking: string) => (
      <div className="messages">
        <MessageItem
          msg={{
            ...message,
            content: "",
            events: [],
            status: "streaming",
            liveThinking,
            liveThinkingSince: since,
          }}
          agents={[agent]}
        />
      </div>
    );
    const { container, rerender } = render(view(""));
    await document.fonts.ready;
    const box = get(container, ".step-group");
    const header = get(container, ".step-header");
    const status = get(header, ".chip-live");
    const headerHeight = rect(header).height;
    const statusLeft = rect(status).left;
    expect(container.querySelector(".trace-header-toggle")).toBeNull();
    expect(container.querySelector(".events-list")).toBeNull();
    expect(container.querySelector(".trace-collapse")).toBeNull();

    rerender(view("Reasoning through the trace layout."));
    expect(get(container, ".step-group")).toBe(box);
    expect(get(container, ".step-header")).toBe(header);
    expect(rect(header).height).toBe(headerHeight);
    expect(rect(get(header, ".chip-live")).left).toBeCloseTo(statusLeft, 1);
    fireEvent.click(get(header, ".trace-header-toggle"));

    const footer = get(container, ".trace-collapse");
    const footerBar = get(container, ".trace-collapse-footer");
    const events = get(container, ".events-list");
    expect(rect(footer).height).toBeGreaterThanOrEqual(width === 390 ? 44 : 26);
    if (width === 1200) expect(rect(footer).height).toBeLessThan(44);
    expect(Number.parseFloat(getComputedStyle(footer).fontSize)).toBe(width === 390 ? 12 : 11);
    const reference = document.createElement("span");
    container.append(reference);
    reference.style.color = "var(--text-secondary)";
    expect(getComputedStyle(footer).color).toBe(getComputedStyle(reference).color);
    if (width === 1200) {
      await page.elementLocator(footer).hover();
      reference.style.color = "var(--text-primary)";
      expect(getComputedStyle(footer).color).toBe(getComputedStyle(reference).color);
    }
    expect(rect(footerBar).width).toBeCloseTo(rect(events).width, 1);
    expect(rect(footer).width).toBeCloseTo(rect(footerBar).width, 1);
    expect(rect(footer).left).toBeGreaterThanOrEqual(rect(footerBar).left - 0.5);
    expect(rect(footer).right).toBeLessThanOrEqual(rect(footerBar).right + 0.5);
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

it("restores keyboard focus and keeps the last collapsed card in view with normal scroll anchoring", async () => {
  await page.viewport(320, 720);
  const { container } = render(
    <div className="messages" style={{ height: 340 }}>
      <div style={{ flex: "none", height: 500 }} />
      <StepGroup
        group={{
          step: 0,
          events: Array.from({ length: 24 }, () => ({
            kind: "thinking",
            content: "A long trace paragraph.",
          })),
        }}
      />
    </div>,
  );
  const scroller = get(container, ".messages");
  const header = get(container, ".step-header");
  const toggle = get(header, "button");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Expand steps" }).click();
    const footer = get(container, ".trace-collapse");
    footer.focus();
    expect(rect(header).bottom).toBeLessThan(rect(scroller).top);
    await userEvent.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(rect(header).top).toBeGreaterThanOrEqual(rect(scroller).top - 1);
    expect(rect(header).bottom).toBeLessThanOrEqual(rect(scroller).bottom + 1);
  }
});

it.each([390, 1200])(
  "returns focus to the tool result toggle on successive bottom collapses at %ipx",
  async (width) => {
    await page.viewport(width, 720);
    const { container, getByRole } = render(
      <div className="messages" style={{ height: 340, overflowAnchor: "none" }}>
        <div style={{ flex: "none", height: 500 }} />
        <EventItem
          ev={{ kind: "tool_result", content: "Trace paragraph.\n\n".repeat(90), isMarkdown: true }}
        />
        <div style={{ flex: "none", height: 600 }} />
      </div>,
    );
    const scroller = get(container, ".messages");
    const toggle = get(container, ".btn-diff");
    for (let i = 0; i < 2; i++) {
      fireEvent.click(toggle);
      const footer = getByRole("button", { name: "Collapse tool result" });
      footer.focus();
      expect(rect(toggle).bottom).toBeLessThan(rect(scroller).top);
      fireEvent.click(footer);
      expect(document.activeElement).toBe(toggle);
      expect(footer.isConnected).toBe(false);
      expect(rect(toggle).top).toBeGreaterThanOrEqual(rect(scroller).top - 1);
      expect(rect(toggle).bottom).toBeLessThanOrEqual(rect(scroller).bottom);
    }
  },
);

it("returns focus to Details rather than Result when both tool folds are open", () => {
  const { getByRole } = render(
    <EventItem
      ev={{ kind: "tool_use", content: "**SomeLongToolName** reading", toolResult: "completed" }}
    />,
  );
  const details = getByRole("button", { name: "Details" });
  const result = getByRole("button", { name: /^Result/ });
  fireEvent.click(result);
  for (let i = 0; i < 2; i++) {
    fireEvent.click(details);
    const footer = getByRole("button", { name: "Collapse tool details" });
    footer.focus();
    fireEvent.click(footer);
    expect(document.activeElement).toBe(details);
    expect(result.getAttribute("aria-expanded")).toBe("true");
  }
});

it("opens a ViewImage path by mouse and keyboard with visible file-link affordance", async () => {
  await page.viewport(800, 600);
  const open = vi.fn();
  const imagePath = "C:\\captures\\one.png";
  const { container } = render(
    <FileOpenContext.Provider value={open}>
      <div className="messages">
        <EventItem
          ev={{
            kind: "tool_use",
            toolName: "ViewImage",
            toolUseId: "image-1",
            content: `**ViewImage** \`${imagePath}\``,
            toolResult: "done",
          }}
        />
      </div>
    </FileOpenContext.Provider>,
  );
  const ref = get(container, ".event-summary-line code");
  expect(ref.getAttribute("role")).toBe("button");
  expect(getComputedStyle(ref).cursor).toBe("pointer");
  expect(container.querySelector(".btn-diff")).toBeNull();
  await page.elementLocator(ref).click();
  expect(open).toHaveBeenCalledExactlyOnceWith(imagePath, { literalPath: true });
  ref.focus();
  expect(document.activeElement).toBe(ref);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard(" ");
  expect(open).toHaveBeenCalledTimes(3);
  expect(open).toHaveBeenLastCalledWith(imagePath, { literalPath: true });
});

it("keeps the quote control out of the text and truncates a long sender on one line", async () => {
  await page.viewport(320, 820);
  const { container } = render(
    <div className="messages">
      <MessageItem msg={message} agents={[agent]} onQuote={no} />
      <MessageItem
        msg={{
          ...message,
          id: "m2",
          kind: "user",
          agentId: null,
          from: { workspaceId: "w", role: "worker", name: long },
        }}
        agents={[agent]}
      />
    </div>,
  );
  const header = get(container, ".message-header");
  const actions = get(header, ".message-actions");
  expect(rect(actions).bottom).toBeLessThanOrEqual(rect(get(container, ".message-content")).top);
  expect(rect(actions).right).toBeCloseTo(rect(header).right, 0);
  expect(get(actions, ".btn-quote").nextElementSibling).toBe(get(actions, ".btn-copy-message"));
  const phoneBodySize = getComputedStyle(document.documentElement)
    .getPropertyValue("--fs-text")
    .trim();
  expect(getComputedStyle(get(container, ".message-content")).fontSize).toBe(phoneBodySize);
  const sender = get(container, ".from-author");
  expect(sender.scrollWidth).toBeGreaterThan(sender.clientWidth);
  expect(lines(sender)).toBe(1);
  expect(getComputedStyle(sender).textOverflow).toBe("ellipsis");
  expect(getComputedStyle(sender).textAlign).toBe("left");
});

it("keeps a cross-year timestamp and quote button inside a narrow desktop header", async () => {
  await page.viewport(900, 600);
  const prevYear = new Date(new Date().getFullYear() - 1, 11, 31, 23, 55, 0).getTime();
  const { container } = render(
    <div className="messages" style={{ width: 300 }}>
      <MessageItem
        msg={{
          ...message,
          model: "provider/long-model-identifier-for-narrow-header[1m]",
          timestamp: prevYear,
        }}
        agents={[agent]}
        onQuote={no}
      />
    </div>,
  );
  await document.fonts.ready;
  const header = get(container, ".message-header");
  const model = get(header, ".message-model");
  const time = get(header, ".message-time");
  const actions = get(header, ".message-actions");
  expect(lines(time)).toBe(1);
  expect(rect(time).right).toBeLessThanOrEqual(rect(actions).left);
  expect(rect(actions).right).toBeLessThanOrEqual(rect(header).right + 0.5);
  expect(model.scrollWidth).toBeGreaterThan(model.clientWidth);
  expect(getComputedStyle(model).textOverflow).toBe("ellipsis");
  expect(model.title).toBe(model.textContent);
});

it("keeps attached images unstretched and gives queue cancellation a larger target than its glyph", async () => {
  await page.viewport(390, 760);
  const image = (width: number, height: number) => ({
    name: `${width}x${height}`,
    url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`)}`,
  });
  const { container } = render(
    <div className="messages">
      <MessageItem
        agents={[agent]}
        onCancelQueued={no}
        msg={{
          ...message,
          kind: "user",
          agentId: null,
          status: "queued",
          images: [image(80, 60), image(48, 96)],
        }}
      />
    </div>,
  );
  const images = [...container.querySelectorAll(".msg-images img")];
  await Promise.all(images.map((img) => (img as HTMLImageElement).decode()));
  const [wide, tall] = images.map(rect);
  expect(wide.top).toBe(tall.top);
  expect([wide.width, wide.height, tall.width, tall.height]).toEqual([80, 60, 48, 96]);
  const cancel = get(container, ".queued-cancel");
  const glyph = document.createRange();
  glyph.selectNodeContents(cancel);
  expect(rect(cancel).width - glyph.getBoundingClientRect().width).toBeGreaterThanOrEqual(10);
});

it("replaces the delayed starting row with a real reply or removes it on failure", () => {
  const cancelled: string[] = [];
  const input: Message = {
    ...message,
    id: "input",
    kind: "user",
    agentId: null,
    content: "Please start",
    queuedFor: agent.id,
  };
  const view = (
    status: Message["status"],
    pendingDelivery?: "starting",
    replies: Message[] = [],
  ) => (
    <div className="messages">
      <MessageItem
        msg={{ ...input, status, pendingDelivery }}
        agents={[agent]}
        onCancelQueued={(id) => cancelled.push(id)}
      />
      {replies.map((reply) => (
        <MessageItem key={reply.id} msg={reply} agents={[agent]} />
      ))}
    </div>
  );
  const { container, queryByRole, rerender } = render(view("starting"));
  expect(queryByRole("status")).toBeNull();
  expect(container.querySelector(".queued-badge")).toBeNull();
  expect(container.querySelectorAll(".message-agent")).toHaveLength(0);

  rerender(view("dispatching"));
  expect(queryByRole("status")).toBeNull();
  expect(container.querySelector(".queued-cancel")).toBeNull();
  expect(container.querySelectorAll(".message-agent")).toHaveLength(0);

  rerender(view("starting", "starting"));
  expect(queryByRole("status")?.textContent).toBe("Starting…");
  const row = get(container, ".message-starting");
  expect(get(container, "#msg-input").nextElementSibling).toBe(row);
  expect(get(row, ".message-author").textContent).toBe(agent.name);
  expect(get(row, ".agent-avatar").textContent).toBe(agent.avatar);
  expect(get(container, "#msg-input .message-header").textContent).not.toContain("Starting");

  rerender(view("done", undefined, [{ ...message, status: "streaming" }]));
  expect(container.querySelectorAll(".message-agent")).toHaveLength(1);
  expect(container.querySelector(".message-starting")).toBeNull();
  expect(get(container, "#msg-input").nextElementSibling?.id).toBe("msg-m");

  const first = { ...message, status: "done" as const };
  rerender(view("queued", undefined, [first]));
  fireEvent.click(get(container, ".queued-cancel"));
  expect(cancelled).toEqual([input.id]);
  rerender(view("starting", "starting", [first]));
  expect(container.querySelector(".queued-cancel")).toBeNull();
  expect(queryByRole("status")?.textContent).toBe("Starting…");
  rerender(view("error", undefined, [first]));
  expect(container.querySelector(".message-starting")).toBeNull();
  expect(container.querySelectorAll(".message-agent")).toHaveLength(1);
});

it.each([320, 1200])("shows Sending… inline with zero layout shift at %ipx", async (width) => {
  await page.viewport(width, 720);
  const target = { ...agent, name: long };
  const view = (status: Message["status"], pendingDelivery?: "sending") => (
    <div className="messages">
      <MessageItem
        msg={{
          ...message,
          id: "input",
          kind: "user",
          agentId: null,
          status,
          queuedFor: target.id,
          pendingDelivery,
        }}
        agents={[target]}
        user={{ name: width === 320 ? long.replaceAll(" ", "") : long, avatar: "A" }}
      />
      <MessageItem msg={message} agents={[agent]} onQuote={no} />
    </div>
  );
  const { container, queryByRole, rerender } = render(view("done"));
  await document.fonts.ready;
  const header = get(container, "#msg-input .message-header");
  const author = get(header, ".message-author");
  const time = get(header, ".message-time");
  if (width === 320) {
    // Without reserved status space, only 4px remain after the timestamp.
    const gap = parseFloat(getComputedStyle(header).columnGap);
    author.style.width = `${rect(header).width - rect(time).width - gap - 4}px`;
  }
  const content = get(container, "#msg-input .message-content");
  // Quote is only available on agent replies, not user messages.
  const quote = get(container, "#msg-m .btn-quote");
  const layout = () => ({
    contentY: rect(content).y,
    headerHeight: rect(header).height,
    authorX: rect(author).x,
    authorWidth: rect(author).width,
    timeX: rect(time).x,
    quoteX: rect(quote).x,
    quoteY: rect(quote).y,
  });
  const before = layout();
  rerender(view("dispatching"));
  expect(queryByRole("status")).toBeNull();
  expect(layout()).toEqual(before);

  rerender(view("dispatching", "sending"));
  const inline = get(container, '[role="status"]');
  expect(inline.textContent?.trim()).toBe("Sending…");
  expect(inline.closest(".message-header")).toBe(header);
  expect(time.nextElementSibling?.contains(inline)).toBe(true);
  expect(layout()).toEqual(before);
  expect(inline.scrollWidth).toBeLessThanOrEqual(inline.clientWidth);
  expect(rect(inline).width).toBeGreaterThanOrEqual(75);
  expect(lines(author)).toBe(1);
  expect(author.scrollWidth).toBeGreaterThan(author.clientWidth);
  expect(author.title).toBe(author.textContent);
  expect(rect(inline).right).toBeLessThanOrEqual(rect(header).right);

  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    expect(getComputedStyle(get(inline, ".streaming-dot")).animationName).toBe("none");
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
  rerender(view("done"));
  expect(queryByRole("status")).toBeNull();
  expect(layout()).toEqual(before);
});

it.each([320, 390, 1200])(
  "keeps the cold reply slot still at %ipx in both themes",
  async (width) => {
    await page.viewport(width, 720);
    const target = {
      ...agent,
      name: long,
      model: "provider/" + "long-model-identifier-".repeat(6),
      effort: null,
      effectiveEffort: "medium",
      fast: true,
    };
    const input: Message = {
      ...message,
      id: "input",
      kind: "user",
      agentId: null,
      content: "Start the agent",
      queuedFor: target.id,
      timestamp: Date.now(),
      status: "starting",
    };
    const reply: Message = {
      ...message,
      content: "",
      events: [],
      timestamp: input.timestamp + 1_000,
      replyTo: input.id,
      status: "streaming",
      model: target.model,
      effort: target.effectiveEffort,
      fast: target.fast,
    };
    const view = (input: Message, hasReply = false) => (
      <div className="messages">
        <MessageItem msg={input} agents={[target]} hasReply={hasReply} />
        {hasReply && <MessageItem msg={reply} agents={[target]} />}
        <div data-tail />
      </div>
    );
    const root = document.documentElement;
    const themeBefore = root.getAttribute("data-theme");
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      for (const theme of ["light", "dark"]) {
        root.setAttribute("data-theme", theme);
        const { container, queryByRole, rerender, unmount } = render(view(input));
        await document.fonts.ready;
        expect(queryByRole("status")).toBeNull();
        expect(container.querySelector(".message-agent")).toBeNull();
        // The Workspace publishes the reveal after the 350ms startup delay.
        const opened = { ...input, pendingDelivery: "starting" } as const;
        rerender(view(opened));
        const row = get(container, ".message-starting");
        expect(queryByRole("status")?.textContent).toBe("Starting…");
        expect(get(container, "#msg-input").nextElementSibling).toBe(row);
        const cold = { ...opened, status: "dispatching" } as const;
        // Compare element boxes, plus the visible author/model/chip text line positions and colors.
        const selectors = [
          ".message-gutter .agent-avatar",
          ".message-header",
          ".message-author",
          ".message-model",
          ".message-time",
          ".streaming-dot",
          ".message-status",
          ".status-chip:not(.fast-chip)",
          ".fast-chip",
        ];
        const measure = (row: HTMLElement) => ({
          boxes: [row, ...selectors.map((selector) => get(row, selector))].map((el) => {
            const { x, y, width, height } = rect(el);
            return { x, y, width, height };
          }),
          text: [
            ".message-author",
            ".message-model",
            ".status-chip:not(.fast-chip)",
            ".fast-chip",
          ].map((selector) => {
            const el = get(row, selector);
            const range = document.createRange();
            range.selectNodeContents(el);
            const { x, y, height } = range.getBoundingClientRect();
            return { x, y, height, color: getComputedStyle(el).color, text: el.textContent };
          }),
          tailY: rect(get(container, "[data-tail]")).y,
        });
        const before = measure(row);
        expect(getComputedStyle(get(row, ".streaming-dot")).animationName).toBe("none");
        for (const selector of [".message-author", ".message-model", ".message-time"]) {
          const mark = get(row, selector);
          expect(lines(mark)).toBe(1);
          expect(rect(mark).width).toBeGreaterThan(0);
          expect(rect(mark).right).toBeLessThanOrEqual(rect(get(row, ".message-header")).right);
        }
        rerender(view(cold));
        expect(get(container, ".message-starting")).toBe(row);
        expect(queryByRole("status")?.textContent).toBe("Starting…");
        expect(measure(row)).toEqual(before);

        // An individually delivered new_message takes over before the input's message_done.
        rerender(view(cold, true));
        const actual = get(container, "#msg-m");
        expect(container.querySelectorAll(".message-agent")).toHaveLength(1);
        expect(get(container, "#msg-input").nextElementSibling).toBe(actual);
        expect(queryByRole("status")).toBeNull();
        expect(measure(actual)).toEqual(before);
        rerender(view({ ...input, status: "done", queuedFor: undefined }, true));
        expect(get(container, "#msg-m")).toBe(actual);
        expect(measure(actual)).toEqual(before);
        expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
        unmount();
      }
    } finally {
      if (themeBefore === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", themeBefore);
      await cdp().send("Emulation.setEmulatedMedia", { features: [] });
    }
  },
);

it("fits a workspace dialog and board detail on a narrow phone", async () => {
  await page.viewport(320, 820);
  const { container, rerender } = render(
    <CreateWorkspaceDialog
      hosts={[]}
      onClose={no}
      onCreate={no}
      onListDirs={no}
      dirSuggestions={{ prefix: "", dirs: [] }}
    />,
  );
  const dialog = document.querySelector(".dialog")!;
  expect(rect(dialog).left).toBeGreaterThanOrEqual(0);
  expect(rect(dialog).right).toBeLessThanOrEqual(320);
  const objective: Objective = {
    id: "web/layout",
    area: "web",
    title: "Layout",
    goal: path,
    context: "First paragraph.\n\nSecond paragraph.",
    status: "active",
    priority: "normal",
    dependsOn: [],
    tasks: [],
    decisions: [],
    sessions: [],
    updatedAt: 1,
  };
  const project: Project = {
    id: "p",
    name: "repo",
    root: "/repo",
    leadWorkspaceId: "lead",
    createdAt: 1,
    objectives: [objective],
  };
  rerender(
    <BoardPage
      project={project}
      sessions={new Map()}
      onClose={no}
      onOpenSession={no}
      onAskLead={no}
      onRename={no}
      onDelete={no}
    />,
  );
  fireEvent.click(get(container, ".bp-card"));
  const detail = get(container, ".bp-detail");
  const goal = get(detail, ".bp-goal");
  const notes = get(detail, ".bp-md");
  expect(lines(goal)).toBeGreaterThan(1);
  expect(goal.scrollWidth).toBeLessThanOrEqual(goal.clientWidth);
  expect(getComputedStyle(notes).lineHeight).toBe(getComputedStyle(goal).lineHeight);
  expect(parseFloat(getComputedStyle(get(notes, "p")).marginBottom)).toBeGreaterThan(4);
  expect(getComputedStyle(get(detail, ".bp-detail-close")).display).toBe("none");
  expect(rect(get(container, ".bp-close")).width).toBeGreaterThan(0);
});

it("uses the space under board warnings and keeps Archive on a short desktop", async () => {
  await page.viewport(1100, 460);
  const objective: Objective = {
    id: "core/index",
    area: "core",
    title: "Index",
    goal: "Build the index",
    status: "active",
    priority: "normal",
    dependsOn: [],
    tasks: [],
    decisions: [],
    sessions: [],
    updatedAt: 1,
  };
  const project: Project = {
    id: "p",
    name: "repo",
    root: "/repo",
    leadWorkspaceId: "lead",
    createdAt: 1,
    objectives: [objective, { id: "core/broken", error: "Invalid objective" }],
  };
  const { container, getByRole } = render(
    <BoardPage
      project={project}
      sessions={new Map()}
      onClose={no}
      onOpenSession={no}
      onAskLead={no}
      onRename={no}
      onDelete={no}
      onArchive={no}
    />,
  );
  expect(rect(getByRole("button", { name: "Archive project" })).width).toBeGreaterThan(0);
  fireEvent.click(getByRole("button", { name: "Dependencies" }));
  const main = get(container, ".bp-main");
  const graph = get(main, ".bp-graph");
  const warning = get(main, ".bp-broken");
  expect(rect(graph).top).toBeGreaterThanOrEqual(rect(warning).bottom);
  expect(rect(graph).bottom).toBeCloseTo(
    rect(main).bottom - parseFloat(getComputedStyle(main).paddingBottom),
    0,
  );
});

it("keeps the branch and PR number visible on a narrow phone", async () => {
  await page.viewport(320, 820);
  const { container } = render(
    <div className="workspace-info-bar">
      <span className="ws-info-item">/repo</span>
      <GitBar
        git={{
          branch: "feat/really-long-topic-branch-name-for-this-change",
          dirty: 0,
          ahead: 0,
          behind: 0,
        }}
        pr={{
          number: 243,
          url: "https://example.test/pull/243",
          title: long,
          state: "open",
          draft: false,
          checks: null,
        }}
      />
    </div>,
  );
  const branch = get(container, ".ws-info-branch");
  const pr = get(container, ".pr-number");
  expect(rect(branch).width).toBeGreaterThan(60);
  expect(rect(branch).right).toBeLessThanOrEqual(rect(pr).left);
  expect(rect(pr).right).toBeLessThanOrEqual(320);
  expect(pr.textContent).toBe("#243");
  expect(getComputedStyle(pr).color).toBe(getComputedStyle(branch).color);
  for (const selector of [".pr-title", ".pr-state"])
    expect(rect(get(container, selector)).width).toBe(0);
});

it("loads all four real Sarasa faces for Latin and CJK text", async () => {
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");
  expect(family.trim().split(",")[0]).toBe('"Sarasa Mono SC"');
  for (const face of ["400", "700", "italic 400", "italic 700"]) {
    const loaded = await document.fonts.load(`${face} 14px \"Sarasa Mono SC\"`, "Read 中");
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((font) => font.status === "loaded")).toBe(true);
  }
});

it("distinguishes error labels from normal text", () => {
  const { container } = render(
    <>
      <SubAgentItem
        ev={{
          kind: "subagent_done",
          content: "",
          subagent: {
            taskId: "b",
            description: "Run checks",
            taskType: "local_agent",
            status: "failed",
            summary: "Checks failed",
          },
        }}
      />
      <BannerItem ev={{ kind: "error", content: "Checks failed" }} />
      <BannerItem ev={{ kind: "notice", level: "wakeup", content: "Checks complete" }} />
    </>,
  );
  const error = getComputedStyle(get(container, ".banner-error .banner-label")).color;
  expect(getComputedStyle(get(container, ".subagent-failed .subagent-status-icon")).color).toBe(
    error,
  );
  expect(getComputedStyle(get(container, ".banner-wakeup .banner-label")).color).not.toBe(error);
});

// Headless Chromium may keep hover disabled after touch emulation is turned off.
it("wraps shell commands and tool paths without letting a long name displace controls", async () => {
  await page.viewport(320, 820);
  const command = `npm run build && ${"node scripts/check.ts --all ".repeat(20)}`;
  const { container } = render(
    <div className="messages">
      <MessageItem msg={message} agents={[agent]} onQuote={no} />
      <SubAgentItem
        ev={{
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "b",
            description: long,
            taskType: "local_bash",
            status: "running",
          },
        }}
        onCancel={no}
      />
      <EventItem
        ev={{
          kind: "tool_use",
          toolName: "Bash",
          content: `**Bash**\n\`\`\`bash\n${command}\n\`\`\``,
        }}
      />
      <EventItem
        ev={{
          kind: "tool_use",
          toolName: `Read${"Long".repeat(40)}`,
          content: `**Read** \`${path}\``,
          durationMs: 4200,
          toolResult: "ok",
        }}
      />
    </div>,
  );
  const header = get(container, ".subagent-header");
  const desc = get(header, ".subagent-desc");
  expect(desc.scrollWidth).toBeGreaterThan(desc.clientWidth);
  expect(getComputedStyle(desc).textOverflow).toBe("ellipsis");
  for (const selector of [".event-content pre", ".event-summary-line code"]) {
    const text = get(container, selector);
    expect(lines(text)).toBeGreaterThan(1);
    expect(rect(text).right).toBeLessThanOrEqual(320);
  }
  const cancel = get(header, ".btn-cancel-subagent");
  expect(rect(cancel).right).toBeLessThanOrEqual(rect(header).right);
  const row = get(container, ".event-row:has(.btn-diff)");
  expect(rect(get(row, ".btn-diff")).right).toBeLessThanOrEqual(rect(row).right);
  expect(rect(get(row, ".event-time")).right).toBeLessThanOrEqual(rect(row).right);
  const pre = get(container, ".event-content pre");
  const copy = get(pre.parentElement!, ".copy-btn");
  expect(rect(copy).right).toBeLessThanOrEqual(rect(pre).right);
  expect(rect(copy).top).toBeGreaterThanOrEqual(rect(pre).top);
  const code = get(pre, "code");
  const wrapped = lines(code);
  copy.style.display = "none";
  expect(lines(code)).toBe(wrapped);
  copy.style.removeProperty("display");
  copy.scrollIntoView({ block: "center" });
  const hitbox = rect(copy);
  expect(
    document.elementFromPoint(hitbox.left + hitbox.width / 2, hitbox.top + hitbox.height / 2),
  ).toBe(copy);

  const pathCopy = get(container, ".event-summary-line .copy-btn");
  const pathRange = document.createRange();
  pathRange.selectNodeContents(get(container, ".event-summary-line code"));
  const firstLine = pathRange.getClientRects()[0];
  expect(firstLine.right).toBeLessThanOrEqual(rect(pathCopy).left);
  expect(firstLine.top).toBeLessThan(rect(pathCopy).bottom);
  await page.elementLocator(get(container, ".event-summary-line")).hover();
  await expect.poll(() => getComputedStyle(pathCopy).opacity).toBe("1");
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
  try {
    expect(matchMedia("(hover: none)").matches).toBe(true);
    await expect.poll(() => getComputedStyle(copy).opacity).toBe("1");
    expect(rect(copy).height).toBeGreaterThan(20);
    expect(rect(pathCopy).height).toBeGreaterThan(20);
    const quote = get(container, ".btn-quote");
    await expect.poll(() => getComputedStyle(quote).opacity).toBe("1");
  } finally {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
});
