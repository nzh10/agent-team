import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { EventItem, BannerItem, StepGroup, MessageItem } from "../src/chat/messages";
import { Sidebar, SidebarProps, SystemStatusPanel } from "../src/sidebar/Sidebar";
import { ConfirmDialog } from "../src/workspace/dialogs";
import { StreamEvent, Message, AgentInfo, Workspace, SystemStatus } from "../src/state/useServer";
import { formatPiToolUse } from "../../service/src/session/pi-tool-format";
import { applyEventsToMessage } from "../src/state/stream";

const ev = (kind: string, over: Partial<StreamEvent> = {}): StreamEvent => ({
  kind,
  content: "",
  ...over,
});

const agent: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-fable-5-1",
  avatar: "🤖",
  color: "#888",
  isDefault: true,
};

describe("EventItem", () => {
  it("renders a tool chip with a one-line summary for single-line tools", () => {
    const { container, queryByText } = render(
      <EventItem ev={ev("tool_use", { toolName: "Read", content: "**Read** `src/a.ts`" })} />,
    );
    expect(container.querySelector(".event-chip")!.textContent).toBe("Read");
    expect(container.querySelector(".event-row")!.textContent).toBe("Read");
    expect(container.querySelector(".event-summary-line code")!.textContent).toBe("src/a.ts");
    const line = container.querySelector(".event-summary-line")!;
    expect([...line.children].map((e) => e.className || e.tagName)).toEqual(["copy-btn", "CODE"]);
    // Nothing else to show: the body is the summary.
    expect(container.querySelector(".event-content")).toBeNull();
    expect(queryByText("Details")).toBeNull();
  });

  it.each([
    [{}, ""],
    [{ offset: 4 }, " · offset 4"],
    [{ limit: 20 }, " · limit 20"],
    [{ offset: 4, limit: 20 }, " · offset 4 · limit 20"],
  ])("keeps formatted Pi read %j compact in live and history rows", (options, suffix) => {
    const event = {
      kind: "tool_use" as const,
      ...formatPiToolUse("read", { path: "src/a.ts", ...options }),
      toolResult: "file body",
    };
    const onLoadDetails = vi.fn();
    const { container, queryByRole, rerender } = render(<EventItem ev={event} />);
    const history = {
      ...event,
      content: event.content.split("\n")[0],
      bodyLength: event.content.length,
      toolResult: undefined,
      resultLength: event.toolResult.length,
    };
    for (const row of [event, history]) {
      rerender(<EventItem ev={row} onLoadDetails={row === event ? undefined : onLoadDetails} />);
      expect(container.querySelector(".event-summary-line code")?.textContent).toBe(
        `src/a.ts${suffix}`,
      );
      expect(container.querySelector(".event-content")).toBeNull();
      expect(queryByRole("button", { name: "Details" })).toBeNull();
      expect(queryByRole("button", { name: /^Result/ })).not.toBeNull();
    }
    expect(onLoadDetails).not.toHaveBeenCalled();
  });

  it.each([[undefined], [30]])(
    "shows Pi Bash with timeout %s without a second title",
    (timeout) => {
      const event = ev("tool_use", formatPiToolUse("bash", { command: "npm test", timeout }));
      const history = {
        ...event,
        content: event.content.split("\n")[0],
        bodyLength: event.content.length,
      };
      const onLoadDetails = vi.fn();
      const { container, getByText, rerender } = render(
        <EventItem ev={history} onLoadDetails={onLoadDetails} />,
      );
      expect(container.querySelector(".event-content pre")).toBeNull();
      fireEvent.click(getByText(/Load details/));
      expect(onLoadDetails).toHaveBeenCalledTimes(1);
      rerender(<EventItem ev={event} />);
      expect(container.querySelector(".event-chip")?.textContent).toBe("bash");
      expect(container.querySelector(".event-summary-line code")?.textContent).toBe(
        timeout === undefined ? undefined : "timeout 30s",
      );
      expect(container.querySelector(".event-content strong")).toBeNull();
      expect(container.querySelector(".event-content pre code.language-bash")?.textContent).toBe(
        "npm test\n",
      );
      expect(container.querySelector(".event-content pre code.language-json")).toBeNull();
    },
  );

  it.each([
    [[{ oldText: "old", newText: "new" }], "- old\n+ new\n"],
    [
      [
        { oldText: "old", newText: "new" },
        { oldText: "second", newText: "changed" },
      ],
      "- old\n+ new\n\n- second\n+ changed\n",
    ],
  ])("shows formatted Pi Edit %j as a diff below its path", (edits, diff) => {
    const event = ev("tool_use", formatPiToolUse("edit", { path: "a.ts", edits }));
    const { container } = render(<EventItem ev={event} />);
    expect(container.querySelector(".event-summary-line code")?.textContent).toBe("a.ts");
    expect(container.querySelector(".event-content pre code.language-diff")?.textContent).toBe(
      diff,
    );
    expect(container.querySelector(".event-content pre code.language-json")).toBeNull();
  });

  it("renders a path-only Pi Edit without an empty diff or a separate heading", () => {
    const event = ev("tool_use", formatPiToolUse("edit", { path: "a.ts", edits: [] }));
    const { container } = render(<EventItem ev={event} />);
    expect(container.querySelector(".event-summary-line code")?.textContent).toBe("a.ts");
    expect(container.querySelector(".event-content")).toBeNull();
  });

  it("keeps the content of a Pi Write even when it contains Markdown fences", () => {
    const content = "# Hello\n```sh\necho hello\n```";
    const event = ev("tool_use", formatPiToolUse("write", { path: "notes.md", content }));
    const { container } = render(<EventItem ev={event} />);
    expect(container.querySelector(".event-summary-line code")?.textContent).toBe("notes.md");
    expect(container.querySelector(".event-content pre code")?.textContent).toBe(`${content}\n`);
  });

  it("keeps the literal backticks in a Pi Grep glob", () => {
    const glob = "src/`draft`.ts";
    const event = ev("tool_use", formatPiToolUse("grep", { pattern: "needle", glob }));
    const { container } = render(<EventItem ev={event} />);
    expect(container.textContent).toContain(glob);
  });

  it("distinguishes literal line breaks from backslash-n in Pi Grep paths", () => {
    const multiline = ev(
      "tool_use",
      formatPiToolUse("grep", { pattern: "needle", path: "src\nlog" }),
    );
    const literal = ev(
      "tool_use",
      formatPiToolUse("grep", { pattern: "needle", path: "src\\nlog" }),
    );
    const { container, rerender } = render(<EventItem ev={multiline} />);
    expect(container.querySelector(".event-content code.language-json")?.textContent).toContain(
      `"path": ${JSON.stringify("src\nlog")}`,
    );
    rerender(<EventItem ev={literal} />);
    expect(container.querySelector(".event-summary-line code")?.textContent).toBe(
      "needle in src\\nlog",
    );
    expect(container.querySelector(".event-content")).toBeNull();
  });

  it("keeps an indented code block even when its first line matches the tool chip", () => {
    const event = ev("tool_use", { toolName: "bash", content: "    **Bash**\n    echo hello" });
    const { container } = render(<EventItem ev={event} />);
    expect(container.querySelector(".event-summary-line")).toBeNull();
    expect(container.querySelector(".event-content pre code")?.textContent).toBe(
      "**Bash**\necho hello\n",
    );
  });

  it("keeps a Markdown Setext heading even when its text matches the tool chip", () => {
    const event = ev("tool_use", { toolName: "Bash", content: "**Bash**\n===\n\nCommand notes" });
    const { container } = render(<EventItem ev={event} />);
    expect(container.querySelector(".event-content h1")?.textContent).toBe("Bash");
    expect(container.querySelector(".event-content p")?.textContent).toBe("Command notes");
  });

  it("keeps a tool heading above a line that only resembles a backtick fence", () => {
    const event = ev("tool_use", { toolName: "Bash", content: "**Bash**\n```not a `fence`" });
    const { container } = render(<EventItem ev={event} />);
    expect(container.querySelector(".event-content strong")?.textContent).toBe("Bash");
    expect(container.querySelector(".event-content pre")).toBeNull();
  });

  it("keeps a distinct MCP name and its arguments when shown under an aliased chip", () => {
    const event = ev("tool_use", formatPiToolUse("mcp__docs__search", { query: "pi" }));
    const { container } = render(<EventItem ev={event} />);
    expect(container.querySelector(".event-chip")?.textContent).toBe("docs · search");
    expect(container.querySelector(".event-content strong")?.textContent).toBe("mcp__docs__search");
    expect(container.querySelector(".event-content pre code.language-json")?.textContent).toContain(
      '"query": "pi"',
    );
  });

  it("shows the body of historical or Codex Bash calls without a duplicate heading", () => {
    const { container } = render(
      <EventItem ev={ev("tool_use", { content: "**Bash**\n```bash\nnpm test\n```" })} />,
    );
    expect(container.querySelector(".event-chip")!.textContent).toBe("Bash");
    expect(container.querySelector(".event-content")!.textContent).toContain("npm test");
    expect(container.querySelector(".event-content strong")).toBeNull();
  });

  it("labels thinking with its own chip", () => {
    const { container } = render(<EventItem ev={ev("thinking", { content: "hmm" })} />);
    expect(container.querySelector(".chip-thinking")!.textContent).toBe("Thinking");
  });

  it("shows how long a finished thinking block took", () => {
    const { container } = render(
      <EventItem ev={ev("thinking", { content: "hmm", durationMs: 13_700 })} />,
    );
    expect(container.querySelector(".chip-thinking")!.textContent).toBe("Thought for 13.7s");
  });

  it("adds the block's tokens once they are known", () => {
    const { container } = render(
      <EventItem ev={ev("thinking", { content: "hmm", durationMs: 13_700, tokens: 1234 })} />,
    );
    expect(container.querySelector(".chip-thinking")!.textContent).toBe(
      "Thought for 13.7s · 1.2k tokens",
    );
  });
});

describe("BannerItem folding", () => {
  const long =
    "Wake up in 25m (01:23 AM) — codex migration run takes tens of minutes\n\n> Check on the background codex migration run: tail the log, check the report, and git log for new commits.";

  it("folds wake-up, schedule and skill prompts to their first line until opened", () => {
    const { container, getByText } = render(
      <BannerItem ev={ev("notice", { level: "schedule", content: long })} />,
    );
    expect(container.querySelector(".banner-label")!.textContent).toBe("Scheduled");
    expect(container.querySelector(".banner-first-line")!.textContent).toBe(
      "Wake up in 25m (01:23 AM) — codex migration run takes tens of minutes",
    );
    expect(container.textContent).not.toContain("tail the log");
    fireEvent.click(getByText("more"));
    expect(container.textContent).toContain("tail the log");
    expect(container.querySelector("blockquote")).not.toBeNull();
    fireEvent.click(getByText("less"));
    expect(container.textContent).not.toContain("tail the log");
  });

  it("labels a skill expansion and leaves short banners unfolded", () => {
    const { container } = render(
      <BannerItem
        ev={ev("notice", { level: "skill", content: "Base directory for this skill: /x\n# Docs" })}
      />,
    );
    expect(container.querySelector(".banner-label")!.textContent).toBe("Skill");
    expect(container.querySelector(".banner-toggle")).not.toBeNull();
    const { container: short } = render(
      <BannerItem ev={ev("notice", { level: "wakeup", content: "Scheduled wake-up fired." })} />,
    );
    expect(short.querySelector(".banner-toggle")).toBeNull();
    expect(short.textContent).toContain("Scheduled wake-up fired.");
  });
});

describe("BannerItem", () => {
  it("renders notices with their level and markdown content", () => {
    const { container } = render(
      <BannerItem ev={ev("notice", { level: "warning", content: "**Plan**\n- [ ] step" })} />,
    );
    const el = container.querySelector(".banner")!;
    expect(el.className).toContain("banner-warning");
    expect(el.querySelector("strong")!.textContent).toBe("Plan");
  });

  it("renders retries and compaction with kind-specific styling", () => {
    const { container } = render(
      <>
        <BannerItem ev={ev("retry", { content: "API retry 2/10" })} />
        <BannerItem ev={ev("compact", { content: "compacted" })} />
      </>,
    );
    const banners = container.querySelectorAll(".banner");
    expect(banners[0].className).toContain("banner-retry");
    expect(banners[1].className).toContain("banner-compact");
  });
});

describe("MessageItem retry recovery", () => {
  it.each([false, true])(
    "updates and clears the streaming retry banner (compact=%s)",
    (compact) => {
      const streaming: Message = {
        id: "m1",
        kind: "agent",
        agentId: agent.id,
        content: "",
        timestamp: 0,
        status: "streaming",
        events: [ev("retry", { content: "Retrying (1/3 in 2s): 529 overloaded" })],
      };
      const view = (msg: Message) => <MessageItem msg={msg} agents={[agent]} compact={compact} />;
      const { container, rerender } = render(view(streaming));
      const updated = applyEventsToMessage(streaming, [
        ev("retry", { content: "Retrying (2/3 in 4s): 529 overloaded" }),
      ]);
      rerender(view(updated));
      expect(container.querySelectorAll('[data-kind="retry"]')).toHaveLength(1);
      expect(container.textContent).toContain("Retrying (2/3 in 4s)");

      rerender(view(applyEventsToMessage(updated, [ev("retry")])));
      expect(container.querySelector('[data-kind="retry"]')).toBeNull();
      const recovered = applyEventsToMessage(updated, [
        ev("text_delta", { content: "Recovered reply." }),
      ]);
      rerender(view(recovered));
      expect(container.querySelector('[data-kind="retry"]')).toBeNull();
      expect(container.textContent).toContain("Recovered reply.");

      rerender(view(applyEventsToMessage(streaming, [ev("error", { content: "final failure" })])));
      expect(container.querySelector('[data-kind="retry"]')).toBeNull();
      expect(container.querySelectorAll('[data-kind="error"]')).toHaveLength(1);
    },
  );
});

describe("StepGroup", () => {
  it("shows tool chips in the collapsed header and banners as siblings", () => {
    const events = [
      ev("tool_use", { content: "**Read** `a`" }),
      ev("tool_use", { content: "**Grep** `foo`" }),
      ev("tool_use", { content: "**Read** `b`" }),
      ev("notice", { level: "notice", content: "note" }),
    ];
    const { container } = render(<StepGroup group={{ step: 0, events }} />);
    const chips = [...container.querySelectorAll(".step-tools .event-chip")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["Read", "Grep"]);
    expect(container.querySelector(".step-summary")!.textContent).toBe("3 tool calls");
    const banner = container.querySelector(".banner")!;
    expect(banner.closest(".step-group")).toBeNull();
    fireEvent.click(container.querySelector(".step-header")!);
    expect(container.querySelectorAll(".events-list .event")).toHaveLength(3);
    expect(container.querySelector(".step-tools")).toBeNull();
  });
});

describe("streaming turn footer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const msg = (over: Partial<Message> = {}): Message => ({
    id: "m1",
    kind: "agent",
    agentId: "a1",
    content: "",
    timestamp: 0,
    status: "streaming",
    events: [],
    ...over,
  });
  const read = ev("tool_use", { toolName: "Read", content: "**Read** `a`", contentOffset: 0 });
  const footer = (c: HTMLElement) => c.querySelector(".turn-footer");
  const tick = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it.each(["done", "error"] as const)(
    "mounts the footer only when a turn status is active and clears it when %s",
    (status) => {
      const view = (over: Partial<Message> = {}) => (
        <MessageItem msg={msg(over)} agents={[agent]} />
      );
      const { container, rerender } = render(view({ waitingSince: Date.now() }));
      expect(footer(container)).toBeNull();
      tick(14_999);
      expect(footer(container)).toBeNull();
      tick(1);
      const node = footer(container)!;
      expect(node).toBe(container.querySelector(".message-body")!.lastElementChild);
      expect(node.textContent).toBe("No new events for 15s");
      rerender(view({ content: "So", waitingSince: Date.now() }));
      expect(footer(container)).toBeNull();
      rerender(view({ content: "So", status }));
      expect(footer(container)).toBeNull();
    },
  );

  it.each([false, true])("shows only the highest priority status (compact: %s)", (compact) => {
    const since = Date.now() - 45_000;
    const view = (over: Partial<Message>, activity?: string) => (
      <MessageItem msg={msg(over)} agents={[{ ...agent, activity }]} compact={compact} />
    );
    const { container, rerender } = render(view({ waitingSince: since }));
    expect(footer(container)!.textContent).toBe("No new events for 45s");

    // Standalone live thinking yields to explicit server activity without leaving an empty step box,
    // and resumes in .step-header once activity clears.
    const standaloneThinking = { liveThinkingSince: since, waitingSince: since };
    rerender(view(standaloneThinking, "compacting context"));
    expect(footer(container)!.textContent).toBe("compacting context");
    expect(container.querySelector(".step-group")).toBeNull();
    expect(container.textContent).not.toContain("Thinking ·");
    rerender(view(standaloneThinking));
    expect(footer(container)).toBeNull();
    expect(container.querySelector(".step-header .chip-live")!.textContent).toBe("Thinking · 45s");

    const thinking = {
      events: [{ ...read, toolResult: "ok" }],
      liveThinkingSince: since,
      waitingSince: since,
    };
    rerender(view(thinking));
    expect(footer(container)).toBeNull();
    expect(container.querySelector(".step-header .chip-live")!.textContent).toBe("Thinking · 45s");
    expect(container.textContent.match(/Thinking · 45s/g)).toHaveLength(1);
    rerender(view(thinking, "compacting context"));
    expect(footer(container)!.textContent).toBe("compacting context");
    expect(container.textContent.match(/compacting context/g)).toHaveLength(1);
    expect(container.querySelector(".step-header .chip-live")).toBeNull();
    expect(container.textContent).not.toContain("Thinking ·");
  });

  it("uses exact phase deadlines and does not hide an older qualifying parallel call", () => {
    vi.setSystemTime(10_000);
    const view = (over: Partial<Message> = {}) => <MessageItem msg={msg(over)} agents={[agent]} />;
    const { container, rerender } = render(view({ waitingSince: 10_000 }));
    expect(footer(container)).toBeNull();
    tick(250);
    const first = { ...read, toolUseId: "read", startedAt: Date.now() };
    rerender(view({ events: [first] }));
    tick(2_999);
    expect(footer(container)).toBeNull();
    tick(1);
    expect(footer(container)!.textContent).toBe("Read · 3s");

    tick(250);
    const second = ev("tool_use", { toolName: "Bash", toolUseId: "bash", startedAt: Date.now() });
    rerender(view({ events: [first, second] }));
    expect(footer(container)!.textContent).toBe("Read · 3s");
    tick(3_000);
    expect(footer(container)!.textContent).toBe("Bash · 3s");

    tick(250);
    rerender(view({ waitingSince: Date.now() }));
    tick(14_999);
    expect(footer(container)).toBeNull();
    tick(1);
    expect(footer(container)!.textContent).toBe("No new events for 15s");
  });

  it("rechecks a wait deadline if the wall clock moved backward", () => {
    vi.setSystemTime(10_000);
    const clock = vi.spyOn(Date, "now");
    try {
      const { container } = render(
        <MessageItem msg={msg({ waitingSince: 10_000 })} agents={[agent]} />,
      );
      clock.mockImplementation(() => new Date().getTime() - 1_000);
      tick(15_000);
      expect(footer(container)).toBeNull();
      tick(1_000);
      expect(footer(container)?.textContent).toBe("No new events for 15s");
    } finally {
      clock.mockRestore();
    }
  });

  it("does not say Waiting during work, even before a tool can report activity", () => {
    const waitingSince = Date.now() - 45_000;
    const view = (over: Partial<Message>) => <MessageItem msg={msg(over)} agents={[agent]} />;
    const { container, rerender } = render(view({ waitingSince }));
    expect(footer(container)!.textContent).toBe("No new events for 45s");
    const call = { ...read, startedAt: Date.now() };
    rerender(view({ waitingSince, events: [call] }));
    expect(footer(container)).toBeNull();
    tick(2_999);
    expect(footer(container)).toBeNull();
    tick(1);
    expect(footer(container)!.textContent).toBe("Read · 3s");
    const running = ev("subagent_start", {
      subagent: { taskId: "child", description: "Working", status: "running" },
    });
    rerender(view({ waitingSince, events: [running] }));
    expect(footer(container)).toBeNull();
    tick(6_000);
    expect(footer(container)).toBeNull();
  });
});

describe("Sidebar archived section", () => {
  const NOW = 1_800_000_000_000;
  const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
    id,
    name: id,
    project: "proj",
    hostId: "local",
    cwd: "/repo",
    git: null,
    pr: null,
    agents: [],
    messages: [],
    createdAt: NOW - 1000,
    lastMessageAt: NOW - 1000,
    ...over,
  });
  const base = (over: Partial<SidebarProps> = {}): SidebarProps => ({
    workspaces: [
      ws("live"),
      ws("dusty", { archivedAt: NOW - 86_400_000, lastMessageAt: NOW - 20 * 86_400_000 }),
    ],
    activeWsId: "live",
    connected: true,
    groupOverrides: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: null,
    now: NOW,
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onToggleGroup: vi.fn(),
    onSearchChange: vi.fn(),
    onJump: vi.fn(),
    onCreate: vi.fn(),
    onCreateIn: vi.fn(),
    onReplayDemo: vi.fn(),
    onDebugSnapshot: vi.fn(),
    onPurgeArchived: vi.fn(),
    ...over,
  });

  it("folds archived workspaces into a collapsed section, its count and Clear inside", () => {
    const props = base();
    const { container, getByTitle } = render(<Sidebar {...props} />);
    const header = container.querySelector(".ws-archived-header")!;
    expect(header.querySelector(".ws-group-count")).toBeNull();
    expect(header.querySelector(".ws-archived-purge")).toBeNull();
    expect(container.querySelector(".task-item-archived")).toBeNull();
    // The live group does not list the archived one.
    expect(
      [...container.querySelectorAll(".ws-group-items .task-name-text")].map((e) => e.textContent),
    ).toEqual(["live"]);

    fireEvent.click(header);
    expect(header.querySelector(".ws-group-count")!.textContent).toBe("1");
    const item = container.querySelector(".task-item-archived")!;
    expect(item.textContent).toContain("dusty");
    expect(item.textContent).toContain("20d ago");
    fireEvent.click(item);
    expect(props.onSelect).toHaveBeenCalledWith("dusty");

    fireEvent.click(getByTitle("Delete the archived workspaces that belong to no project"));
    expect(props.onPurgeArchived).toHaveBeenCalledWith(null);
    // Clicking Clear must not toggle the section.
    expect(container.querySelector(".task-item-archived")).toBeTruthy();
  });

  it("keeps the section open while an archived workspace is active", () => {
    const { container } = render(<Sidebar {...base({ activeWsId: "dusty" })} />);
    expect(container.querySelector(".task-item-archived.active")).toBeTruthy();
  });

  it("omits the section when nothing is archived", () => {
    const { container } = render(<Sidebar {...base({ workspaces: [ws("live")] })} />);
    expect(container.querySelector(".ws-archived")).toBeNull();
  });

  it("marks a busy session by its dot alone, without a line of what its agents are doing", () => {
    const busy = ws("live", {
      agents: [{ ...agent, busy: true, activity: "Bash · 12s" }],
    });
    const { container } = render(<Sidebar {...base({ workspaces: [busy] })} />);
    expect(container.querySelector(".task-item .task-status")!.className).toContain("running");
    expect(container.querySelector(".task-item")!.textContent).not.toContain("Bash");
    expect(container.querySelector(".task-item")!.textContent).not.toContain("Alice");
  });
});

describe("ConfirmDialog", () => {
  it("confirms then closes, and cancels without confirming", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { getByText } = render(
      <ConfirmDialog
        title="T"
        body="B"
        confirmLabel="Do it"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByText("Do it"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText("Cancel"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ConfirmDialog title="T" body="B" onConfirm={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves focus alone when the parent re-renders with a new onClose", () => {
    // App passes a fresh closure on every render (each stream frame, the
    // 3 s status tick); focus must not jump back to the destructive button.
    const dialog = (onClose: () => void) => (
      <ConfirmDialog
        title="T"
        body="B"
        confirmLabel="Delete all"
        danger
        onConfirm={() => {}}
        onClose={onClose}
      />
    );
    const { getByText, rerender } = render(dialog(() => {}));
    expect(document.activeElement).toBe(getByText("Cancel"));
    getByText("Delete all").focus();
    const onClose = vi.fn();
    rerender(dialog(onClose));
    expect(document.activeElement).toBe(getByText("Delete all"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("StepGroup timeline", () => {
  it("renders a subagent card between the tool calls that surround it", () => {
    const events = [
      ev("tool_use", { toolName: "Read", content: "**Read** `a`" }),
      ev("tool_use", { toolName: "Read", content: "**Read** `b`" }),
      ev("subagent_start", {
        subagent: { taskId: "t", description: "review", agentType: "shell", status: "running" },
      }),
      ev("tool_use", { toolName: "Bash", content: "**Bash** ls" }),
    ];
    const { container } = render(<StepGroup group={{ step: 0, events }} />);
    const kids = [...container.children].map((el) => el.className.split(" ")[0]);
    expect(kids).toEqual(["step-group", "subagent-item", "step-group"]);
    const summaries = [...container.querySelectorAll(".step-summary")].map((e) => e.textContent);
    expect(summaries).toEqual(["2 tool calls", "1 tool call"]);
    expect(container.querySelector(".subagent-desc")!.textContent).toBe("review");
  });
});

describe("StepGroup summary", () => {
  it("counts only what is inside the box; errors are banners outside it", () => {
    const events = [
      ev("thinking", { content: "hmm" }),
      ev("error", { content: "boom" }),
      ev("notice", { level: "notice", content: "banner outside" }),
    ];
    const { container } = render(<StepGroup group={{ step: 0, events }} />);
    expect(container.querySelector(".step-summary")!.textContent).toBe("1 thinking");
    const error = container.querySelector(".banner-error")!;
    expect(error.querySelector(".banner-label")!.textContent).toBe("Error");
    expect(error.textContent).toContain("boom");
    const { container: c2 } = render(
      <StepGroup group={{ step: 0, events: [ev("tool_result", { content: "x" })] }} />,
    );
    expect(c2.querySelector(".step-summary")!.textContent).toBe("1 result");
  });
});

describe("Sidebar group quick-create", () => {
  it("offers a + on each folder group that creates in that folder without toggling it", () => {
    const NOW = 1_800_000_000_000;
    const props: SidebarProps = {
      workspaces: [
        {
          id: "w",
          name: "w",
          project: "repo",
          hostId: "local",
          cwd: "/home/me/repo",
          git: null,
          pr: null,
          agents: [],
          messages: [],
          createdAt: NOW - 1000,
          lastMessageAt: NOW - 1000,
        },
      ],
      activeWsId: "w",
      connected: true,
      groupOverrides: {},
      searchQuery: "",
      searchHits: null,
      systemStatus: null,
      now: NOW,
      onSelect: vi.fn(),
      onDelete: vi.fn(),
      onToggleGroup: vi.fn(),
      onSearchChange: vi.fn(),
      onJump: vi.fn(),
      onCreate: vi.fn(),
      onCreateIn: vi.fn(),
      onReplayDemo: vi.fn(),
      onDebugSnapshot: vi.fn(),
      onPurgeArchived: vi.fn(),
    };
    const { getByTitle } = render(<Sidebar {...props} />);
    fireEvent.click(getByTitle("New workspace in /home/me/repo"));
    expect(props.onCreateIn).toHaveBeenCalledWith("/home/me/repo");
    expect(props.onToggleGroup).not.toHaveBeenCalled();
  });
});

describe("CreateWorkspaceDialog initial path", () => {
  it("pre-fills the path and derives the default name from it", async () => {
    const { CreateWorkspaceDialog } = await import("../src/workspace/dialogs");
    const onCreate = vi.fn();
    const { getByPlaceholderText, getByDisplayValue, getByText } = render(
      <CreateWorkspaceDialog
        hosts={[]}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "", dirs: [] }}
        initialPath="/home/me/repo"
        projectFolders={["/home/me/repo"]}
      />,
    );
    expect(getByDisplayValue("/home/me/repo")).toBeTruthy();
    expect(getByPlaceholderText("repo")).toBeTruthy();
    fireEvent.click(getByText("Create session"));
    expect(onCreate).toHaveBeenCalledWith("repo", "/home/me/repo", "local", undefined);
  });
});

describe("message status row and timestamps", () => {
  const base: Message = {
    id: "m",
    kind: "agent",
    agentId: "a1",
    content: "done",
    timestamp: Date.UTC(2026, 0, 1, 10, 30),
    status: "done",
    events: [],
  };

  it("shows effort and context occupancy under the header, colored by pressure", () => {
    const { container, rerender } = render(
      <MessageItem
        msg={{ ...base, effort: "high", context: { tokens: 84000, window: 200000 } }}
        agents={[agent]}
      />,
    );
    const row = container.querySelector(".message-status")!;
    expect(row.textContent).toContain("effort high");
    expect(row.textContent).toContain("ctx 84k / 200k · 42%");
    expect(row.querySelector(".ctx-chip")!.className).not.toContain("ctx-warn");
    rerender(
      <MessageItem
        msg={{ ...base, context: { tokens: 185000, window: 200000 } }}
        agents={[agent]}
      />,
    );
    expect(container.querySelector(".ctx-chip")!.className).toContain("ctx-high");
    expect(container.querySelector(".message-status")!.textContent).not.toContain("effort");
  });

  it("labels a context estimate and clears it on an explicit unknown boundary", () => {
    const { container, rerender } = render(
      <MessageItem
        msg={{ ...base, context: { tokens: 449, window: 272000, estimated: true } }}
        agents={[agent]}
      />,
    );
    const chip = container.querySelector(".ctx-chip")!;
    expect(chip.getAttribute("title")).toBe("Context estimate: 449 / 272,000 tokens");
    expect(chip.textContent).toBe("ctx 449 / 272k · 0%");
    expect(chip.textContent).not.toContain("~");
    rerender(<MessageItem msg={{ ...base, context: null }} agents={[agent]} />);
    expect(container.querySelector(".ctx-chip")?.textContent).toBe("ctx unknown");
    expect(container.querySelector(".ctx-bar")).toBeNull();
  });

  it("keeps thinking time and tokens out of the header", () => {
    const { container } = render(
      <MessageItem
        msg={{ ...base, thinking: { tokens: 1234, durationMs: 45_000 } }}
        agents={[agent]}
      />,
    );
    expect(container.querySelector(".message-status")).toBeNull();
  });

  it("marks turns that ran in fast mode", () => {
    const { container } = render(<MessageItem msg={{ ...base, fast: true }} agents={[agent]} />);
    const chip = container.querySelector(".fast-chip")!;
    expect(chip.textContent).toContain("fast");
    expect(container.querySelector(".message-status")!.textContent).not.toContain("effort");
  });

  it("renders nothing for messages without effort or context, and never for user messages", () => {
    const { container, rerender } = render(<MessageItem msg={base} agents={[agent]} />);
    expect(container.querySelector(".message-status")).toBeNull();
    rerender(
      <MessageItem
        msg={{ ...base, kind: "user", agentId: null, effort: "high" }}
        agents={[agent]}
      />,
    );
    expect(container.querySelector(".message-status")).toBeNull();
  });

  it("keeps a timestamp on compact continuation messages", () => {
    const { container } = render(<MessageItem msg={base} agents={[agent]} compact />);
    expect(container.querySelector(".message-header")).toBeNull();
    expect(container.querySelector(".compact-header .message-time")!.textContent).toMatch(/\d/);
  });
});

describe("scheduled wake-ups", () => {
  it("gives ScheduleWakeup calls a schedule chip with a readable summary", () => {
    const { container } = render(
      <EventItem
        ev={ev("tool_use", {
          toolName: "ScheduleWakeup",
          content: "**ScheduleWakeup** in 8m — watching CI\n\n> check CI",
        })}
      />,
    );
    const chip = container.querySelector(".event-chip")!;
    expect(chip.className).toContain("chip-schedule");
    expect(chip.textContent).toBe("⏰ Wake-up");
    expect(container.querySelector(".event-content")!.textContent).toContain("check CI");
  });

  it("renders the fired wake-up as its own banner", () => {
    const { container } = render(
      <BannerItem ev={ev("notice", { level: "wakeup", content: "Scheduled wake-up: check CI" })} />,
    );
    const el = container.querySelector(".banner")!;
    expect(el.className).toContain("banner-wakeup");
    expect(el.querySelector(".banner-label")!.textContent).toBe("Woke up");
    expect(el.textContent).toContain("check CI");
  });
});

describe("scheduled banner", () => {
  it("renders the schedule with its label and the planned prompt", () => {
    const { container } = render(
      <BannerItem
        ev={ev("notice", {
          level: "schedule",
          content: "Wake up in 8m (02:10) — watching CI\n\n> check CI",
        })}
      />,
    );
    const el = container.querySelector(".banner")!;
    expect(el.className).toContain("banner-schedule");
    expect(el.querySelector(".banner-label")!.textContent).toBe("Scheduled");
    expect(el.textContent).toContain("Wake up in 8m");
    // The planned prompt is behind the fold.
    expect(el.querySelector("blockquote")).toBeNull();
    fireEvent.click(el.querySelector(".banner-toggle")!);
    expect(el.querySelector("blockquote")!.textContent).toContain("check CI");
  });
});

describe("GitBar", () => {
  it("shows branch with dirty/ahead/behind badges and a PR card with state and checks", async () => {
    const { GitBar } = await import("../src/workspace/GitBar");
    const { container } = render(
      <GitBar
        git={{ branch: "feat/x", dirty: 3, ahead: 1, behind: 0 }}
        pr={{
          number: 243,
          url: "https://x/pull/243",
          title: "Fix it",
          state: "open",
          draft: false,
          checks: "pending",
        }}
      />,
    );
    expect(container.querySelector(".ws-branch-name")!.textContent).toBe("feat/x");
    expect([...container.querySelectorAll(".git-badge")].map((b) => b.textContent)).toEqual([
      "●3",
      "↑1",
    ]);
    const pr = container.querySelector(".pr-card")!;
    expect(pr.className).toContain("pr-open");
    expect(pr.textContent).toContain("#243");
    expect(pr.textContent).toContain("Fix it");
    expect(pr.querySelector(".pr-state")!.textContent).toBe("open");
    expect(pr.querySelector(".pr-checks")!.className).toContain("pr-checks-pending");
  });

  it("renders merged/draft states and nothing when there is no git info", async () => {
    const { GitBar } = await import("../src/workspace/GitBar");
    const { container, rerender } = render(
      <GitBar
        git={{ branch: "b", dirty: 0, ahead: 0, behind: 0 }}
        pr={{ number: 1, url: "u", title: "", state: "merged", draft: true, checks: null }}
      />,
    );
    expect(container.querySelector(".pr-state")!.textContent).toBe("merged");
    expect(container.querySelector(".git-badge")).toBeNull();
    rerender(<GitBar git={null} pr={null} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("summary pages and lazy details", () => {
  it("renders a summarised thinking event as a placeholder that requests details", () => {
    const onLoad = vi.fn();
    const { container, getByText } = render(
      <EventItem
        ev={ev("thinking", { content: "", contentLength: 4200 })}
        onLoadDetails={onLoad}
      />,
    );
    expect(container.querySelector(".event-placeholder")!.textContent).toContain("4.2k chars");
    fireEvent.click(getByText(/Load details/));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("shows the result size from the summary and loads on toggle", () => {
    const onLoad = vi.fn();
    const { getByText, container } = render(
      <EventItem
        ev={ev("tool_use", { toolName: "Read", content: "**Read** `a`", resultLength: 12000 })}
        onLoadDetails={onLoad}
      />,
    );
    fireEvent.click(getByText(/^Result · 12k chars/));
    expect(onLoad).toHaveBeenCalledTimes(1);
    // Nothing to show yet; no empty result box.
    expect(container.querySelector(".event-result")).toBeNull();
  });

  it("requests details when a step group of a summarised message is opened", () => {
    const onLoadDetails = vi.fn();
    const msg: Message = {
      id: "m1",
      kind: "agent",
      agentId: "a1",
      content: "",
      timestamp: 0,
      status: "done",
      detail: "summary",
      events: [ev("thinking", { content: "", contentLength: 10 })],
    };
    const { container } = render(
      <MessageItem msg={msg} agents={[agent]} onLoadDetails={onLoadDetails} />,
    );
    fireEvent.click(container.querySelector(".step-header")!);
    expect(onLoadDetails).toHaveBeenCalledWith("m1");
  });

  it("does not request details once the message is full", () => {
    const onLoadDetails = vi.fn();
    const msg: Message = {
      id: "m1",
      kind: "agent",
      agentId: "a1",
      content: "",
      timestamp: 0,
      status: "done",
      events: [ev("thinking", { content: "body" })],
    };
    const { container } = render(
      <MessageItem msg={msg} agents={[agent]} onLoadDetails={onLoadDetails} />,
    );
    fireEvent.click(container.querySelector(".step-header")!);
    expect(onLoadDetails).not.toHaveBeenCalled();
    expect(container.querySelector(".event-content")!.textContent).toContain("body");
  });
});

describe("HistoryHint", () => {
  it("distinguishes initial loading, paging in flight, and empty history", async () => {
    const { HistoryHint } = await import("../src/chat/HistoryHint");
    const { container, rerender } = render(
      <HistoryHint hasMore={false} loading={false} loaded={false} count={0} />,
    );
    expect(container.textContent).toContain("Loading conversation");
    rerender(<HistoryHint hasMore loading loaded count={5} />);
    expect(container.textContent).toContain("Loading older messages");
    expect(container.querySelector(".spinner")).toBeTruthy();
    rerender(<HistoryHint hasMore={false} loading={false} loaded count={0} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("live thinking", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const live = (over: Partial<Message> = {}): Message => ({
    id: "m",
    kind: "agent",
    agentId: "a1",
    content: "",
    timestamp: 0,
    status: "streaming",
    events: [],
    ...over,
  });

  it.each(["", "\n  "])(
    "does not offer controls or an empty body for %j live thinking",
    (liveThinking) => {
      vi.setSystemTime(10_000);
      const { container, queryByRole } = render(
        <MessageItem msg={live({ liveThinking, liveThinkingSince: 10_000 })} agents={[agent]} />,
      );
      const header = container.querySelector<HTMLElement>(".step-header")!;
      expect(header.textContent).toBe("Thinking · 0s");
      expect(header.classList.contains("step-header-static")).toBe(true);
      expect(queryByRole("button", { name: "Expand steps" })).toBeNull();
      expect(container.querySelector(".events-list")).toBeNull();
      expect(container.querySelector(".trace-collapse")).toBeNull();
      fireEvent.click(header);
      expect(container.querySelector(".events-list")).toBeNull();
    },
  );

  it("turns the same empty thinking box into an expandable trace when text arrives", () => {
    vi.setSystemTime(10_000);
    const view = (liveThinking: string) => (
      <MessageItem msg={live({ liveThinking, liveThinkingSince: 10_000 })} agents={[agent]} />
    );
    const { container, rerender, getByRole } = render(view(""));
    const box = container.querySelector(".step-group")!;
    const header = container.querySelector(".step-header")!;

    rerender(view("Weighing the options."));
    expect(container.querySelector(".step-group")).toBe(box);
    expect(container.querySelector(".step-header")).toBe(header);
    const toggle = getByRole("button", { name: "Expand steps" });
    fireEvent.click(toggle);
    expect(container.querySelector(".trace-collapse")?.textContent).toBe("▴ Collapse steps");
    expect(container.querySelector(".live-thinking")!.textContent).toContain(
      "Weighing the options.",
    );

    rerender(view("Weighing the options. Still thinking."));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".live-thinking")!.textContent).toContain("Still thinking.");
  });

  it("streams the whole block as an item of an open step box, with a ticking timer in its header", () => {
    vi.setSystemTime(10_000);
    const events = [
      ev("tool_use", { toolName: "Read", content: "**Read** `a`", contentOffset: 0 }),
    ];
    const view = (liveThinking: string) =>
      live({ events, liveThinking, liveThinkingSince: 10_000 });
    const { container, rerender } = render(<MessageItem msg={view("")} agents={[agent]} />);
    const panel = () => container.querySelector(".live-thinking");
    const boxes = () => container.querySelectorAll(".step-group");
    const header = boxes()[0].querySelector(".step-header")!;
    expect(boxes()).toHaveLength(1);
    expect(header.querySelector(".step-summary")!.textContent).toBe("1 tool call");
    expect(header.querySelector(".chip-live")!.textContent).toBe("Thinking · 0s");
    expect(container.querySelector(".turn-footer")).toBeNull();
    expect(panel()).toBeNull();

    fireEvent.click(header);
    expect(boxes()[0].classList.contains("open")).toBe(true);
    expect(panel()!.querySelector(".event-row")).toBeNull();
    expect(panel()!.querySelector(".event-content")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(header.querySelector(".chip-live")!.textContent).toBe("Thinking · 3s");
    expect(container.querySelector(".turn-footer")).toBeNull();
    expect(container.textContent.match(/Thinking · 3s/g)).toHaveLength(1);

    // Each fragment adds to what is shown; nothing scrolls away or is cut.
    const first = "First I check the **states**.";
    rerender(<MessageItem msg={view(first)} agents={[agent]} />);
    const long = first + "\n\n" + "x".repeat(2000) + " the tail";
    rerender(<MessageItem msg={view(long)} agents={[agent]} />);
    expect(panel()!.querySelector(".event-row")).toBeNull();
    const body = panel()!.querySelector(".event-content")!;
    expect(body.querySelector("strong")!.textContent).toBe("states");
    expect(body.textContent.endsWith("the tail")).toBe(true);

    // Finished thinking replaces the live item without closing the box.
    rerender(
      <MessageItem
        msg={live({
          events: [
            ...events,
            ev("thinking", { content: long, contentOffset: 0, durationMs: 5_000 }),
          ],
        })}
        agents={[agent]}
      />,
    );
    expect(panel()).toBeNull();
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0].classList.contains("open")).toBe(true);
    expect(boxes()[0].querySelector(".step-header .chip-live")).toBeNull();
    expect(boxes()[0].querySelector(".step-summary")!.textContent).toBe("1 thinking · 1 tool call");
    expect(boxes()[0].querySelector(".event-thinking .event-row .chip-thinking")!.textContent).toBe(
      "Thought for 5s",
    );
    expect(boxes()[0].querySelector(".event-thinking .event-content")!.textContent).toContain(
      "the tail",
    );
  });

  it("gives a first-thing thinking block a folded box of its own", () => {
    const { container, rerender } = render(
      <MessageItem
        msg={live({ liveThinking: "Let me see.", liveThinkingSince: Date.now() })}
        agents={[agent]}
      />,
    );
    const box = () => container.querySelector(".step-group")!;
    const original = box();
    expect(box().querySelector(".live-thinking")).toBeNull();
    const header = box().querySelector(".step-header")!;
    expect(header.textContent).toBe("▸Thinking · 0s");
    expect(container.querySelector(".turn-footer")).toBeNull();
    fireEvent.click(header);
    expect(box().querySelector(".live-thinking > .event-row")).toBeNull();
    expect(box().querySelector(".live-thinking")!.textContent).toBe("Let me see.");
    void act(() => vi.advanceTimersByTime(1_000));
    expect(header.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(header.textContent).toContain("Thinking · 1s");
    expect(container.textContent.match(/Thinking · 1s/g)).toHaveLength(1);
    expect(container.querySelector(".turn-footer")).toBeNull();
    fireEvent.click(box().querySelector(".step-header")!);
    expect(box().querySelector(".live-thinking")).toBeNull();
    rerender(
      <MessageItem
        msg={live({ liveThinking: "Let me see. More.", liveThinkingSince: Date.now() })}
        agents={[agent]}
      />,
    );
    expect(box().className).not.toContain("open");
    // Finished, the block lands in that same box.
    rerender(
      <MessageItem
        msg={live({ events: [ev("thinking", { content: "Let me see. More.", contentOffset: 0 })] })}
        agents={[agent]}
      />,
    );
    expect(container.querySelectorAll(".step-group")).toHaveLength(1);
    expect(box()).toBe(original);
    expect(box().querySelector(".step-header")!.textContent).toBe("▸1 thinking");
    expect(container.querySelector(".turn-footer")).toBeNull();
  });

  it.each([false, true])(
    "keeps the first-thinking box across the closing flush (open: %s)",
    (open) => {
      const view = (msg: Message) => <MessageItem msg={msg} agents={[agent]} />;
      const { container, rerender } = render(view(live()));
      let msg = applyEventsToMessage(live(), [
        ev("thinking_delta", { startedAt: Date.now(), content: "Reasoned." }),
      ]);
      rerender(view(msg));
      const box = container.querySelector(".step-group")!;
      const toggle = box.querySelector("button")!;
      if (open) fireEvent.click(toggle);

      msg = applyEventsToMessage(msg, [
        ev("thinking_delta", { durationMs: 6_000, thinkingFollows: true }),
      ]);
      rerender(view(msg));
      expect(container.querySelector(".step-group")).toBe(box);
      expect(box.querySelector("button")).toBe(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe(String(open));
      expect(box.querySelector(".chip-live, .step-summary")).toBeNull();
      expect(box.querySelector(".live-thinking")?.textContent).toBe(open ? "Reasoned." : undefined);
      expect(container.querySelector(".turn-footer")).toBeNull();
      msg = applyEventsToMessage(msg, [
        ev("thinking", { content: "Reasoned.", durationMs: 6_000 }),
      ]);
      rerender(view(msg));
      expect(container.querySelector(".step-group")).toBe(box);
      expect(toggle.getAttribute("aria-expanded")).toBe(String(open));
      expect(box.querySelector(".step-summary")!.textContent).toBe("1 thinking");
      expect(box.querySelector(".event-content")?.textContent).toBe(open ? "Reasoned." : undefined);
    },
  );

  it("drops the open draft when a duration-only close has no persisted thinking", () => {
    const initial = applyEventsToMessage(live(), [
      ev("thinking_delta", { startedAt: Date.now(), content: "Discarded draft." }),
    ]);
    const view = (msg: Message) => <MessageItem msg={msg} agents={[agent]} />;
    const { container, rerender } = render(view(initial));
    fireEvent.click(container.querySelector(".step-header")!);
    expect(container.querySelector(".live-thinking")?.textContent).toBe("Discarded draft.");
    rerender(view(applyEventsToMessage(initial, [ev("thinking_delta", { durationMs: 1_000 })])));
    expect(container.querySelector(".step-group")).toBeNull();
    expect(container.textContent).not.toContain("Discarded draft.");
  });

  it("keeps the folded box that follows text when its thinking ends", () => {
    const events = [
      ev("tool_use", { toolName: "Read", content: "**Read** `a`", contentOffset: 0 }),
    ];
    const { container, rerender } = render(
      <MessageItem
        msg={live({ events, content: "Found it.", liveThinking: "Now", liveThinkingSince: 0 })}
        agents={[agent]}
      />,
    );
    const items = () => [...container.querySelectorAll(".message-content p, .step-group")];
    const before = items();
    expect(before.map((e) => e.tagName)).toEqual(["DIV", "P", "DIV"]);
    expect(before[1].textContent).toBe("Found it.");
    expect(before[2].textContent).toMatch(/^▸Thinking · \d+s$/);
    expect(container.querySelector(".turn-footer")).toBeNull();
    rerender(
      <MessageItem
        msg={live({
          events: [...events, ev("thinking", { content: "Now", contentOffset: 9 })],
          content: "Found it.",
        })}
        agents={[agent]}
      />,
    );
    expect(items()).toHaveLength(3);
    expect(items()[2]).toBe(before[2]);
    expect(items()[2].textContent).toBe("▸1 thinking");
  });

  it.each([
    [
      "subagent",
      ev("subagent_start", {
        contentOffset: 0,
        subagent: { taskId: "sa1", description: "Explore repo", status: "completed" },
      }),
    ],
    [
      "banner",
      ev("notice", { level: "warning", content: "Rate limited briefly", contentOffset: 0 }),
    ],
  ])("hosts live thinking in a trailing step header after a %s without a footer", (_kind, prev) => {
    vi.setSystemTime(20_000);
    const { container, rerender } = render(
      <MessageItem
        msg={live({
          events: [prev],
          liveThinking: "Reviewing result.",
          liveThinkingSince: 16_000,
        })}
        agents={[agent]}
      />,
    );
    const box = container.querySelector(".step-group")!;
    expect(box.querySelector(".step-header .chip-live")!.textContent).toBe("Thinking · 4s");
    expect(container.querySelector(".turn-footer")).toBeNull();
    fireEvent.click(box.querySelector(".step-header")!);
    expect(box.querySelector(".live-thinking > .event-row")).toBeNull();
    expect(box.querySelector(".live-thinking .event-content")!.textContent).toBe(
      "Reviewing result.",
    );

    rerender(
      <MessageItem
        msg={live({
          events: [
            prev,
            ev("thinking", { content: "Reviewing result.", durationMs: 5_000, contentOffset: 0 }),
          ],
        })}
        agents={[agent]}
      />,
    );
    expect(container.querySelector(".step-group")).toBe(box);
    expect(box.querySelector(".step-header .chip-live")).toBeNull();
    expect(box.querySelector(".step-summary")!.textContent).toBe("1 thinking");
    expect(box.querySelector(".event-thinking .chip-thinking")!.textContent).toBe("Thought for 5s");
    expect(container.querySelector(".turn-footer")).toBeNull();
  });

  it("matches a continuous stream and a timestamp-only reconnect snapshot during live thinking", () => {
    vi.setSystemTime(30_000);
    let streamed = live();
    streamed = applyEventsToMessage(streamed, [
      ev("tool_use", {
        toolName: "Read",
        toolUseId: "t1",
        content: "**Read** `a`",
        contentOffset: 0,
      }),
      ev("tool_result", { toolUseId: "t1", content: "ok" }),
      ev("thinking_delta", { startedAt: 26_000, content: "Weighing options." }),
    ]);
    // Server snapshots carry liveThinkingSince without client-only liveThinking text.
    const snapshot = live({
      events: streamed.events,
      liveThinkingSince: 26_000,
    });

    const a = render(<MessageItem msg={streamed} agents={[agent]} />);
    const b = render(<MessageItem msg={snapshot} agents={[agent]} />);
    for (const view of [a, b]) {
      expect(view.container.querySelector(".step-summary")!.textContent).toBe("1 tool call");
      expect(view.container.querySelector(".step-header .chip-live")!.textContent).toBe(
        "Thinking · 4s",
      );
      expect(view.container.querySelector(".turn-footer")).toBeNull();
    }
    expect(b.container.querySelector(".step-header")!.innerHTML).toBe(
      a.container.querySelector(".step-header")!.innerHTML,
    );

    // Replaying the next thinking_delta onto the timestamp-only snapshot exposes the live body cleanly.
    const resumed = applyEventsToMessage(snapshot, [
      ev("thinking_delta", { startedAt: 26_000, content: "Next check." }),
    ]);
    b.rerender(<MessageItem msg={resumed} agents={[agent]} />);
    fireEvent.click(b.container.querySelector(".step-header")!);
    expect(b.container.querySelector(".live-thinking > .event-row")).toBeNull();
    expect(b.container.querySelector(".live-thinking .event-content")!.textContent).toBe(
      "Next check.",
    );
  });
});

describe("SystemStatusPanel", () => {
  it("shows CPU and memory without account or quota controls", () => {
    const status = {
      osName: "macOS",
      osArch: "arm64",
      cpuModel: "Test CPU",
      cpuCores: 8,
      cpuUsage: 10,
      memUsed: 1,
      memTotal: 4,
      uptime: 1,
      hostname: "test",
    } satisfies SystemStatus;
    const { container } = render(<SystemStatusPanel status={status} />);
    expect([...container.querySelectorAll(".status-label")].map((e) => e.textContent)).toEqual([
      "CPU",
      "Mem",
    ]);
    expect(container.querySelector("select")).toBeNull();
  });
});
