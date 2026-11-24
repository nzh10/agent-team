import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
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
              lastTool: "hidden-tool",
              events: [{ kind: "text", content: "hidden-trace" }],
            },
          }}
        />
      </div>,
    );
    const header = get(container, ".subagent-header");
    expect(header.textContent).toBe(`▸✓Reviewer${model}high3s`);
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

it.each([
  [320, "step"],
  [320, "subagent"],
  [1200, "step"],
  [1200, "subagent"],
] as const)(
  "collapsing the %ipx %s trace from the bottom restores its off-screen header",
  async (width, trace) => {
    await page.viewport(width, 720);
    const { container, getByRole } = render(
      <div className="messages" style={{ height: 360, overflowAnchor: "none" }}>
        <div style={{ flex: "none", height: 210 }} />
        {trace === "step" ? (
          <StepGroup
            group={{
              step: 0,
              events: Array.from({ length: 50 }, () => ({
                kind: "thinking" as const,
                content: "Thinking about the next step.",
              })),
            }}
          />
        ) : (
          <SubAgentItem
            ev={{
              kind: "subagent_start",
              content: "",
              subagent: {
                taskId: "trace",
                description: "Reviewer",
                status: "completed",
                summary: "A paragraph of trace details.\n\n".repeat(50),
              },
            }}
          />
        )}
        <div style={{ flex: "none", height: 2000 }} />
      </div>,
    );
    const scroller = get(container, ".messages");
    const header = get(container, `.${trace}-header`);
    const toggle = get(header, "button");
    fireEvent.click(toggle);
    const footer = getByRole("button", { name: `Collapse ${trace} trace` });
    expect(rect(footer).height).toBeGreaterThanOrEqual(width === 320 ? 44 : 26);
    if (width === 1200) expect(rect(footer).height).toBeLessThan(44);
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

it("restores keyboard focus and keeps the last collapsed card in view with normal scroll anchoring", async () => {
  await page.viewport(320, 720);
  const { container } = render(
    <div className="messages" style={{ height: 340 }}>
      <div style={{ flex: "none", height: 500 }} />
      <SubAgentItem
        ev={{
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "last",
            description: "Reviewer",
            status: "completed",
            summary: "A long trace paragraph.\n\n".repeat(50),
          },
        }}
      />
    </div>,
  );
  const scroller = get(container, ".messages");
  const header = get(container, ".subagent-header");
  const toggle = get(header, "button");
  await page.getByRole("button", { name: "Expand subagent: Reviewer" }).click();
  const footer = get(container, ".trace-collapse");
  footer.focus();
  expect(rect(header).bottom).toBeLessThan(rect(scroller).top);
  await userEvent.keyboard("{Enter}");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle);
  expect(rect(header).top).toBeGreaterThanOrEqual(rect(scroller).top - 1);
  expect(rect(header).bottom).toBeLessThanOrEqual(rect(scroller).bottom + 1);
});

it("wraps shell commands and tool paths without letting a long name displace controls", async () => {
  await page.viewport(320, 820);
  const command = `npm run build && ${"node scripts/check.ts --all ".repeat(20)}`;
  const { container } = render(
    <div className="messages">
      <SubAgentItem
        ev={{
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "b",
            description: long,
            taskType: "local_bash",
            status: "running",
            prompt: `\`\`\`bash\n${command}\n\`\`\``,
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
  fireEvent.click(header);
  const desc = get(header, ".subagent-desc");
  expect(desc.scrollWidth).toBeGreaterThan(desc.clientWidth);
  expect(getComputedStyle(desc).textOverflow).toBe("ellipsis");
  for (const selector of [
    ".subagent-prompt pre",
    ".event-content pre",
    ".event-summary-line code",
  ]) {
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
  } finally {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
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
  const quote = get(container, ".btn-quote");
  const header = get(container, ".message-header");
  expect(rect(quote).bottom).toBeLessThanOrEqual(rect(get(container, ".message-content")).top);
  expect(rect(quote).right).toBeCloseTo(rect(header).right, 0);
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

it("offers real queue cancellation but no cancel action before or during a write", () => {
  const cancelled: string[] = [];
  const input: Message = {
    ...message,
    id: "input",
    kind: "user",
    agentId: null,
    content: "Please start",
    queuedFor: agent.id,
  };
  const view = (status: Message["status"], replies: Message[] = []) => (
    <div className="messages">
      <MessageItem
        msg={{ ...input, status }}
        agents={[agent]}
        onCancelQueued={(id) => cancelled.push(id)}
      />
      {replies.map((reply) => (
        <MessageItem key={reply.id} msg={reply} agents={[agent]} />
      ))}
    </div>
  );
  const { container, getByRole, rerender } = render(view("starting"));
  expect(getByRole("status").textContent).toContain("Starting the agent");
  expect(container.querySelector(".queued-badge")).toBeNull();
  expect(container.querySelectorAll(".message-agent")).toHaveLength(0);

  rerender(view("dispatching"));
  expect(getByRole("status").textContent).toContain("Sending to the agent");
  expect(container.querySelector(".queued-cancel")).toBeNull();
  expect(container.querySelectorAll(".message-agent")).toHaveLength(0);

  rerender(view("done", [{ ...message, status: "streaming" }]));
  expect(container.querySelectorAll(".message-agent")).toHaveLength(1);

  const first = { ...message, status: "done" as const };
  rerender(view("queued", [first]));
  fireEvent.click(get(container, ".queued-cancel"));
  expect(cancelled).toEqual([input.id]);
  rerender(view("starting", [first]));
  expect(getByRole("status").textContent).toContain("Starting the agent");
  expect(container.querySelector(".queued-cancel")).toBeNull();
  expect(container.querySelectorAll(".message-agent")).toHaveLength(1);
});

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

it("keeps every text gray readable on each theme background", () => {
  const { container } = render(<span />);
  const sample = get(container, "span");
  const luminance = (name: string) => {
    sample.style.color = `var(--${name})`;
    const rgb = getComputedStyle(sample).color.match(/\d+/g)!.map(Number);
    return rgb
      .map((value) => value / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const backgrounds = ["primary", "secondary", "tertiary", "elevated"].map((name) =>
    luminance(`bg-${name}`),
  );
  for (const [name, minimum] of [
    ["strong", 9],
    ["primary", 6],
    ["secondary", 4.5],
    ["muted", 3],
  ] as const) {
    for (const bg of backgrounds)
      expect((luminance(`text-${name}`) + 0.05) / (bg + 0.05), name).toBeGreaterThanOrEqual(
        minimum,
      );
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
  fireEvent.click(get(container, ".subagent-header"));
  const error = getComputedStyle(get(container, ".banner-error .banner-label")).color;
  expect(
    getComputedStyle(get(container, ".subagent-failed .subagent-summary")).borderLeftColor,
  ).toBe(error);
  expect(getComputedStyle(get(container, ".banner-wakeup .banner-label")).color).not.toBe(error);
});
