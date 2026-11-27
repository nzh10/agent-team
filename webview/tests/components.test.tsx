import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { SubAgentItem, StepGroup, MessageItem, CreateWorkspaceDialog } from "../src/App";
import { HostInfo } from "../src/state/useServer";
import { StreamEvent, Message, AgentInfo } from "../src/state/useServer";
import { applyEventsToMessage } from "../src/state/stream";
import { readTracePage } from "../../shared/subagent-trace";
import { MessageBoundary } from "../src/chat/messages";
import { SubagentTraceContext } from "../src/chat/subagentTrace";
import { TranscriptChoiceScope } from "../src/chat/transcriptChoices";
import { agent, message } from "./helpers/fixtures";

const sa = (over: Partial<NonNullable<StreamEvent["subagent"]>> = {}): StreamEvent => ({
  kind: "subagent_start",
  content: "",
  subagent: { taskId: "task-1", description: "explore the repo", agentType: "Explore", ...over },
});

describe("SubAgentItem", () => {
  it("toggles the inline body and keeps the collapsed card to its header", () => {
    const { container, getByRole } = render(
      <SubAgentItem
        ev={sa({
          status: "completed",
          model: "provider/resolved",
          effort: "high",
          durationMs: 3000,
          lastTool: "Read",
          summary: "Finished",
          eventCount: 1000,
        })}
      />,
    );
    const button = getByRole("button", { name: "Expand subagent: explore the repo" });
    expect(container.querySelector(".subagent-details")).toBeNull();
    expect(container.textContent).not.toContain("Finished");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".subagent-item > .subagent-details")?.textContent).toContain(
      "Trace is unavailable.",
    );
    fireEvent.click(getByRole("button", { name: "Collapse subagent" }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".subagent-details")).toBeNull();
  });

  it("does not copy a positional action's expanded state to an earlier trace page", () => {
    const events = ["Earlier", "Latest"].map((name) => ({
      kind: "tool_use",
      toolName: "mcp__panel__report_progress",
      content: `Progress: ${name}`,
      toolResult: `${name} result`,
    }));
    const ev = sa({ status: "completed" });
    const trace = [{ ...ev, subagent: { ...ev.subagent!, events } }];
    const scope: NonNullable<React.ContextType<typeof SubagentTraceContext>> = {
      workspaceId: "ws",
      epoch: 1,
      requestPage: ({ taskId }, window, receive) => {
        receive(readTracePage(1, trace, taskId, { ...window, limit: 1 }));
        return () => {};
      },
    };
    const view = render(
      <TranscriptChoiceScope id="reply" choices={new Map()}>
        <SubagentTraceContext value={scope}>
          <SubAgentItem ev={ev} messageId="reply" />
        </SubagentTraceContext>
      </TranscriptChoiceScope>,
    );
    const click = (name: string | RegExp) => fireEvent.click(view.getByRole("button", { name }));
    click(/Expand subagent/);
    click("more");
    expect(view.getByText("Latest result")).toBeTruthy();
    click("Earlier");
    expect(view.queryByText("Latest result")).toBeNull();
    expect(view.queryByText("Earlier result")).toBeNull();
    expect(view.getByRole("button", { name: "more" })).toBeTruthy();
  });

  it("shows a cancel button while running and reports the taskId", () => {
    const onCancel = vi.fn();
    const { container, getByTitle } = render(
      <SubAgentItem ev={sa({ status: "running" })} onCancel={onCancel} />,
    );

    fireEvent.click(getByTitle("Cancel this subagent"));
    expect(onCancel).toHaveBeenCalledWith("task-1");
    // Clicking cancel must not toggle the details open.
    expect(container.querySelector(".subagent-details")).toBeNull();
  });

  it("hides the cancel button when the running subagent is not cancellable", () => {
    const { container } = render(
      <SubAgentItem ev={sa({ status: "running", cancellable: false })} onCancel={() => {}} />,
    );
    expect(container.querySelector(".btn-cancel-subagent")).toBeNull();
  });
});

it("lets a failed transcript row receive programmatic jump focus", () => {
  using _log = vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never {
    throw new Error("failed transcript row");
  }
  render(
    <MessageBoundary messageId="broken">
      <Broken />
    </MessageBoundary>,
  );
  document.getElementById("msg-broken")!.focus();
  expect(document.activeElement?.id).toBe("msg-broken");
});

describe("StepGroup", () => {
  it.each(["", "\n  "])(
    "keeps %j persisted thinking static even when steps default open",
    (content) => {
      const { container, queryByRole } = render(
        <StepGroup
          defaultOpen
          group={{
            step: 0,
            events: [{ kind: "thinking", content, contentLength: 0 }],
          }}
        />,
      );
      const header = container.querySelector<HTMLElement>(".step-header")!;
      expect(header.textContent).toBe("1 thinking");
      expect(header.classList.contains("step-header-static")).toBe(true);
      expect(queryByRole("button", { name: "Expand steps" })).toBeNull();
      expect(container.querySelector(".events-list")).toBeNull();
      expect(container.querySelector(".trace-collapse")).toBeNull();
      fireEvent.click(header);
      expect(container.querySelector(".events-list")).toBeNull();
    },
  );

  it("omits the step box entirely when a segment only contains a subagent", () => {
    const { container } = render(<StepGroup group={{ step: 0, events: [sa()] }} />);
    expect(container.querySelector(".step-group")).toBeNull();
    expect(container.querySelector(".subagent-item")).toBeTruthy();
  });
});

describe("MessageItem", () => {
  const agents = [agent("a1", { name: "Alice", model: "claude-fable-5", avatar: "🤖" })];
  const msg = (over: Partial<Message>) => message("m1", { agentId: "a1", timestamp: 0, ...over });

  it("renders the user's name and image or text avatar", () => {
    const message = msg({ kind: "user", content: "Hello" });
    const d = render(<MessageItem msg={message} agents={[]} />);
    expect(d.getByAltText("You").getAttribute("src")).toBe("avatars/header.jpg");
    expect(d.getByText("You")).toBeTruthy();
    d.rerender(
      <MessageItem msg={message} agents={[]} user={{ name: "Ada", avatar: "avatars/ada.png" }} />,
    );
    expect(d.getByAltText("Ada").getAttribute("src")).toBe("avatars/ada.png");
    d.rerender(<MessageItem msg={message} agents={[]} user={{ name: "Ada", avatar: "⭐" }} />);
    expect(d.getByText("Ada")).toBeTruthy();
    expect(d.getByText("⭐")).toBeTruthy();
    expect(d.queryByRole("img")).toBeNull();
  });

  it("interleaves text segments and event groups by contentOffset", () => {
    const part1 = "Let me read the file first.";
    const part2 = "Done — the bug is in the parser.";
    const events: StreamEvent[] = [
      {
        kind: "tool_use",
        content: "Read /a",
        toolUseId: "t1",
        contentOffset: part1.length,
      },
      { ...sa({ status: "completed" }), contentOffset: part1.length },
    ];
    const { container, getByText } = render(
      <MessageItem msg={msg({ content: part1 + part2, events })} agents={agents} />,
    );

    // Both text segments render, split around the event group.
    expect(getByText(part1)).toBeTruthy();
    expect(getByText(part2)).toBeTruthy();
    // The subagent renders as a standalone block outside the step box.
    const item = container.querySelector(".subagent-item")!;
    expect(item).toBeTruthy();
    expect(item.closest(".step-group")).toBeNull();
    expect(container.querySelector(".step-group")).toBeTruthy();
  });

  it.each([false, true])(
    "renders delayed thinking before the answer (interleaved tool: %s)",
    (tool) => {
      const read = {
        kind: "tool_use",
        content: "**Read** `a.ts`",
        toolName: "Read",
        toolUseId: "call-1",
        contentOffset: 6,
      };
      const streamed = applyEventsToMessage(msg({ status: "streaming" }), [
        { kind: "text_delta", content: "Answer" },
        ...(tool ? [read] : []),
        { kind: "thinking", content: "plan", contentOffset: 0, durationMs: 1_000 },
      ]);
      expect(streamed.events?.map((event) => [event.kind, event.contentOffset])).toEqual(
        tool
          ? [
              ["tool_use", 6],
              ["thinking", 0],
            ]
          : [["thinking", 0]],
      );
      const { container } = render(
        <MessageItem msg={{ ...streamed, status: "done" }} agents={agents} />,
      );
      const segments = container.querySelectorAll(".message-content > div");
      expect(segments).toHaveLength(2);
      expect(segments[0].querySelector(".step-summary")?.textContent).toBe("1 thinking");
      if (!tool) {
        expect(segments[1].textContent).toBe("Answer");
      } else {
        const text = segments[1].textContent;
        expect(text).toContain("Answer");
        expect(segments[1].querySelector(".step-summary")?.textContent).toBe("1 tool call");
        expect(text.indexOf("Answer")).toBeLessThan(text.indexOf("1 tool call"));
      }
    },
  );

  it("keeps an opened step box open when the first text of the reply arrives", () => {
    const events: StreamEvent[] = [
      { kind: "thinking", content: "plan", contentOffset: 0 },
      { kind: "tool_use", toolName: "Read", content: "**Read** `a.ts`", contentOffset: 0 },
    ];
    const live = msg({ events, status: "streaming" });
    const { container, rerender } = render(<MessageItem msg={live} agents={agents} />);
    fireEvent.click(container.querySelector(".step-header")!);
    expect(container.querySelector(".step-group.open")).not.toBeNull();
    rerender(<MessageItem msg={{ ...live, content: "Found it" }} agents={agents} />);
    expect(container.querySelector(".step-group.open")).not.toBeNull();
    expect(container.textContent).toContain("Found it");
  });

  it("shows a forwarded message's agent avatar as an image", () => {
    const { container } = render(
      <MessageItem
        msg={msg({
          kind: "user",
          agentId: null,
          content: "look at this",
          forwardRef: {
            messageId: "x",
            fromAgent: "Alice",
            fromAvatar: "avatars/Alice.jpg",
            preview: "the answer",
          },
        })}
        agents={agents}
      />,
    );
    const who = container.querySelector(".forward-ref-agent")!;
    expect(who.textContent).toBe("Alice");
    expect(who.querySelector("img")!.getAttribute("src")).toBe("avatars/Alice.jpg");
  });

  it("jumps from the reference button, its arrow, and its preview", () => {
    const onJumpToMessage = vi.fn();
    const reply = msg({
      kind: "user",
      forwardRef: {
        messageId: "original",
        fromAgent: "Alice",
        fromAvatar: "A",
        preview: "the answer",
      },
    });
    const { getByRole, getByText } = render(
      <MessageItem msg={reply} agents={agents} onJumpToMessage={onJumpToMessage} />,
    );
    const ref = getByRole("button", { name: "Jump to quoted message from Alice: the answer" });
    expect(ref.getAttribute("type")).toBe("button");
    fireEvent.click(ref);
    fireEvent.click(getByText("↩"));
    fireEvent.click(getByText("the answer"));
    expect(onJumpToMessage.mock.calls).toEqual([["original"], ["original"], ["original"]]);
  });

  it.each([
    ["missing handler", "original", undefined],
    ["empty ID", "", vi.fn()],
  ])("keeps a static preview with %s", (_, messageId, onJumpToMessage) => {
    const reply = msg({
      kind: "user",
      forwardRef: { messageId, fromAgent: "Alice", fromAvatar: "A", preview: "the answer" },
    });
    const { container, queryByRole } = render(
      <MessageItem msg={reply} agents={agents} onJumpToMessage={onJumpToMessage} />,
    );
    const ref = container.querySelector("div.forward-ref")!;
    expect(ref.textContent).toContain("the answer");
    expect(queryByRole("button", { name: /jump to quoted message/i })).toBeNull();
    fireEvent.click(ref);
    if (onJumpToMessage) expect(onJumpToMessage).not.toHaveBeenCalled();
  });

  it("wires cancel through to the owning agent", () => {
    const onCancelSubagent = vi.fn();
    const events: StreamEvent[] = [sa({ status: "running" })];
    const { getByTitle } = render(
      <MessageItem
        msg={msg({ events, status: "streaming" })}
        agents={agents}
        onCancelSubagent={onCancelSubagent}
      />,
    );
    fireEvent.click(getByTitle("Cancel this subagent"));
    expect(onCancelSubagent).toHaveBeenCalledWith("a1", "task-1");
  });
});

describe("CreateWorkspaceDialog", () => {
  const hosts: HostInfo[] = [{ id: "local", label: "Local", type: "local", connected: true }];

  function setup(dirSuggestions = { prefix: "", dirs: [] as string[] }) {
    const onCreate = vi.fn();
    const onListDirs = vi.fn();
    const dialog = (suggestions: typeof dirSuggestions) => (
      <CreateWorkspaceDialog
        hosts={hosts}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={onListDirs}
        dirSuggestions={suggestions}
      />
    );
    const utils = render(dialog(dirSuggestions));
    const pathInput = utils.getByPlaceholderText("~/workspace/...") as HTMLInputElement;
    const suggest = (prefix: string, ...dirs: string[]) => utils.rerender(dialog({ prefix, dirs }));
    return { ...utils, onCreate, onListDirs, pathInput, suggest };
  }

  it("requests directory completion while typing (debounced)", () => {
    vi.useFakeTimers();
    try {
      const { onListDirs, pathInput } = setup();
      fireEvent.change(pathInput, { target: { value: "/home/e" } });
      fireEvent.change(pathInput, { target: { value: "/home/ex" } });
      expect(onListDirs).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      // Only the final value survives the debounce.
      expect(onListDirs).toHaveBeenCalledTimes(1);
      expect(onListDirs).toHaveBeenCalledWith("/home/ex");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows suggestions matching the current input and completes on click", () => {
    const { pathInput, getByText, suggest } = setup();
    fireEvent.change(pathInput, { target: { value: "/home/ex" } });
    suggest("/home/ex", "/home/example/");
    fireEvent.mouseDown(getByText("/home/example/"));
    expect(pathInput.value).toBe("/home/example/");
  });

  it("ignores stale suggestions for older input", () => {
    const { pathInput, baseElement, suggest } = setup();
    fireEvent.change(pathInput, { target: { value: "/tmp/x" } });
    suggest("/home/ex", "/home/example/");
    expect(baseElement.querySelector(".dir-suggest")).toBeNull();
  });

  it("submits name + path, defaulting the name to the folder basename", () => {
    const { pathInput, onCreate, getByText } = setup();
    fireEvent.change(pathInput, { target: { value: "/home/example/clice" } });
    fireEvent.click(getByText("Create session"));
    expect(onCreate).toHaveBeenCalledWith("clice", "/home/example/clice", "local", undefined);
  });

  it("names the project a folder outside every project starts, and only that", () => {
    const onCreate = vi.fn();
    const { getByPlaceholderText, queryByLabelText, getByLabelText, getByText } = render(
      <CreateWorkspaceDialog
        hosts={hosts}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "", dirs: [] }}
        projectFolders={["/repo/clice", "/wt/clice-x"]}
      />,
    );
    const pathInput = getByPlaceholderText("~/workspace/...");
    for (const known of ["/repo/clice", "/repo/clice/src/", "/wt/clice-x"]) {
      fireEvent.change(pathInput, { target: { value: known } });
      expect(queryByLabelText("Project")).toBeNull();
    }
    fireEvent.change(pathInput, { target: { value: "/repo/clice2" } });
    expect((getByLabelText("Project") as HTMLInputElement).placeholder).toBe("clice2");
    fireEvent.change(getByLabelText("Project"), { target: { value: " Clice Two " } });
    fireEvent.click(getByText("Create session"));
    expect(onCreate).toHaveBeenCalledWith("clice2", "/repo/clice2", "local", "Clice Two");
  });

  it("closes the suggestion list when the path input loses focus (mobile has no Esc)", () => {
    vi.useFakeTimers();
    try {
      const { pathInput, baseElement, suggest } = setup();
      fireEvent.change(pathInput, { target: { value: "/home/ex" } });
      suggest("/home/ex", "/home/example/");
      expect(baseElement.querySelector(".dir-suggest")).not.toBeNull();

      fireEvent.blur(pathInput);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(baseElement.querySelector(".dir-suggest")).toBeNull();

      // Refocusing brings it back before the user types anything.
      fireEvent.focus(pathInput);
      expect(baseElement.querySelector(".dir-suggest")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the list open across a quick blur/focus (tapping a suggestion)", () => {
    vi.useFakeTimers();
    try {
      const { pathInput, baseElement, suggest } = setup();
      fireEvent.change(pathInput, { target: { value: "/home/ex" } });
      suggest("/home/ex", "/home/example/");
      fireEvent.blur(pathInput);
      fireEvent.focus(pathInput); // cancels the pending close
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(baseElement.querySelector(".dir-suggest")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MessageItem delivery state", () => {
  const agents: AgentInfo[] = [
    {
      id: "a1",
      name: "Alice",
      model: "m",
      avatar: "A",
      color: "#888",
      isDefault: true,
      effort: "high",
      fast: true,
    },
  ];
  const queuedMsg: Message = {
    id: "mq",
    kind: "user",
    agentId: null,
    content: "do this next",
    timestamp: 0,
    status: "queued",
    queuedFor: "a1",
  };

  const view = (
    status: Message["status"],
    queuedFor = "a1",
    pendingDelivery?: Message["pendingDelivery"],
    hasReply = false,
  ) => (
    <MessageItem
      msg={{ ...queuedMsg, status, queuedFor, pendingDelivery }}
      agents={agents}
      hasReply={hasReply}
    />
  );

  it.each([
    ["starting", "done"],
    ["dispatching", "done"],
    ["dispatching", "error"],
  ] as const)("does not flash a status when %s settles quickly to %s", (pending, settled) => {
    const { container, rerender } = render(view(pending));
    const status = () => container.querySelector('[role="status"], [role="alert"], .queued-badge');
    expect(status()).toBeNull();
    rerender(view(settled));
    expect(status()).toBeNull();
  });

  it.each([
    ["a1", "Alice", "A"],
    ["missing", "Agent", "?"],
    ["", "Agent", "?"],
  ])(
    "keeps the starting row for target %s throughout dispatch until a reply appears",
    (id, name, avatar) => {
      const { container, getByRole, queryByRole, rerender } = render(view("starting", id));
      expect(queryByRole("status")).toBeNull();
      expect(container.querySelector(".message-starting")).toBeNull();
      rerender(view("starting", id, "starting"));
      const input = container.querySelector(".message-user")!;
      const row = input.nextElementSibling!;
      expect(row.matches(".message-agent.message-starting")).toBe(true);
      expect(row.querySelector(".message-author")?.textContent).toBe(name);
      expect(row.querySelector(".message-gutter")?.textContent).toBe(avatar);
      expect(row.contains(getByRole("status"))).toBe(true);
      expect(getByRole("status").textContent?.trim()).toBe("Starting…");
      expect(input.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector(".queued-badge, .queued-cancel, .delivery-status")).toBeNull();

      if (id === "a1") {
        expect(row.querySelector(".message-model")?.textContent).toBe("m");
        expect(row.querySelector(".message-status")?.textContent).toBe("effort high⚡ fast");
      }
      rerender(view("dispatching", id, "starting"));
      expect(input.nextElementSibling).toBe(row);
      expect(getByRole("status").closest(".message-starting")).toBe(row);
      expect(getByRole("status").textContent).toBe("Starting…");
      expect(container.querySelector(".queued-badge, .queued-cancel, .delivery-status")).toBeNull();
      rerender(view("dispatching", id, "starting", true));
      expect(queryByRole("status")).toBeNull();
      rerender(view("done"));
      expect(queryByRole("status")).toBeNull();
    },
  );

  it("shows the revealed warm status inline and hides it when the reply appears", () => {
    const { getByRole, queryByRole, rerender } = render(view("dispatching"));
    expect(queryByRole("status")).toBeNull();
    rerender(view("dispatching", "a1", "sending"));
    const inline = getByRole("status");
    expect(inline.closest(".message-user .message-header")).not.toBeNull();
    expect(inline.textContent?.trim()).toBe("Sending…");
    rerender(view("dispatching", "a1", "sending", true));
    expect(queryByRole("status")).toBeNull();
  });

  it("shows the outcome-unknown alert immediately instead of a pending indicator", () => {
    const { getByRole, queryByRole, rerender } = render(view("dispatching"));
    rerender(view("outcome_unknown"));
    const alert = getByRole("alert");
    expect(alert.matches(".delivery-status.delivery-outcome-unknown")).toBe(true);
    expect(alert.textContent).toContain("Delivery outcome unknown.");
    expect(queryByRole("status")).toBeNull();
  });

  it("offers no cancel for a message handed to the running turn", () => {
    const { container, queryByTitle } = render(
      <MessageItem
        msg={{ ...queuedMsg, steering: true }}
        agents={agents}
        onCancelQueued={vi.fn()}
      />,
    );
    expect(container.querySelector(".queued-badge")!.textContent).toBe("queued");
    expect(queryByTitle("Remove from queue")).toBeNull();
  });

  it("renders normally once the message leaves the queue", () => {
    const { container } = render(
      <MessageItem msg={{ ...queuedMsg, status: "done", queuedFor: undefined }} agents={agents} />,
    );
    expect(container.querySelector(".queued-badge")).toBeNull();
    expect(container.querySelector(".message")!.className).not.toContain("message-queued");
  });
});

describe("MessageItem events without contentOffset", () => {
  it("renders them after the text instead of dropping them", () => {
    const agents: AgentInfo[] = [
      { id: "a1", name: "A", model: "m", avatar: "x", color: "#fff", isDefault: true },
    ];
    const events: StreamEvent[] = [
      { kind: "tool_use", content: "**Read** `a`", contentOffset: 0 },
      { kind: "notice", level: "warning", content: "late banner" },
      { kind: "error", content: "boom" },
    ];
    const msg: Message = {
      id: "m",
      kind: "agent",
      agentId: "a1",
      content: "Some text.",
      timestamp: 0,
      status: "done",
      events,
    };
    const { container } = render(<MessageItem msg={msg} agents={agents} />);
    expect(container.querySelector(".banner")!.textContent).toContain("late banner");
    // The tool call is the only boxed event; notice and error are banners.
    const stepGroups = container.querySelectorAll(".step-group");
    expect(stepGroups).toHaveLength(1);
    // The text sits between the leading tool call and the trailing events.
    const body = container.querySelector(".message-content")!;
    const order = [...body.querySelectorAll(".step-group, p, .banner")]
      .filter((el) => el.tagName !== "P" || !el.closest(".banner"))
      .map((el) =>
        el.className.includes("banner") ? "banner" : el.tagName === "P" ? "text" : "step",
      );
    // Offset-less events sit with the event before them (the tool call at
    // offset 0), in their own order, and the text follows.
    expect(order).toEqual(["step", "banner", "banner", "text"]);
  });
});

describe("MessageItem subagent lifecycle placement", () => {
  it("keeps progress/done events with their start even without an offset", () => {
    const agents: AgentInfo[] = [
      { id: "a1", name: "A", model: "m", avatar: "x", color: "#fff", isDefault: true },
    ];
    const events: StreamEvent[] = [
      {
        kind: "subagent_start",
        content: "",
        contentOffset: 0,
        subagent: { taskId: "t", description: "search", agentType: "Explore", status: "running" },
      },
      {
        kind: "subagent_done",
        content: "",
        subagent: { taskId: "t", description: "", status: "completed" },
      },
    ];
    const msg: Message = {
      id: "m",
      kind: "agent",
      agentId: "a1",
      content: "Delegating.",
      timestamp: 0,
      status: "done",
      events,
    };
    const { container } = render(<MessageItem msg={msg} agents={agents} />);
    const items = container.querySelectorAll(".subagent-item");
    expect(items).toHaveLength(1);
    expect(items[0].className).toContain("subagent-completed");
    expect(items[0].querySelector(".subagent-desc")!.textContent).toBe("search");
  });
});

describe("legacy messages without any contentOffset", () => {
  it("renders the work before the answer, as it happened", () => {
    const agents: AgentInfo[] = [
      { id: "a1", name: "A", model: "m", avatar: "x", color: "#fff", isDefault: true },
    ];
    const msg: Message = {
      id: "m",
      kind: "agent",
      agentId: "a1",
      content: "The answer.",
      timestamp: 0,
      status: "done",
      events: [
        { kind: "thinking", content: "hmm" },
        { kind: "tool_use", content: "**Read** `a`" },
      ],
    };
    const { container } = render(<MessageItem msg={msg} agents={agents} />);
    const body = container.querySelector(".message-content")!;
    const order = [...body.querySelectorAll(".step-group, p")].map((el) =>
      el.classList.contains("step-group") ? "step" : "text",
    );
    expect(order).toEqual(["step", "text"]);
  });
});

describe("system messages", () => {
  const system = (content: string): Message => ({
    id: "s",
    kind: "system",
    agentId: null,
    content,
    timestamp: 1,
    status: "done",
  });

  it("show an image avatar as the image, not its path", () => {
    const { container } = render(
      <MessageItem msg={system("avatars/Alice.jpg **Alice** joined the team")} agents={[]} />,
    );
    expect(container.querySelector(".system-avatar")!.getAttribute("src")).toBe(
      "avatars/Alice.jpg",
    );
    expect(container.textContent).toBe("Alice joined the team");
  });

  it("leave an emoji avatar, and other text, as written", () => {
    const { container } = render(
      <MessageItem msg={system("🤖 **Bot** context cleared")} agents={[]} />,
    );
    expect(container.querySelector(".system-avatar")).toBeNull();
    expect(container.textContent).toBe("🤖 Bot context cleared");
  });
});

describe("the model in a reply's header", () => {
  it("is the one the turn ran on, not the agent's model now", () => {
    const agents: AgentInfo[] = [
      {
        id: "a",
        name: "A",
        model: "claude-fable-5-1",
        avatar: "A",
        color: "#fff",
        isDefault: true,
      },
    ];
    const reply = (model?: string): Message => ({
      id: "r",
      kind: "agent",
      agentId: "a",
      content: "done",
      timestamp: 1,
      status: "done",
      ...(model && { model }),
    });
    const before = render(<MessageItem msg={reply("claude-opus-5-5")} agents={agents} />);
    expect(before.container.querySelector(".message-model")!.textContent).toBe("opus 5.5");
    before.unmount();
    const old = render(<MessageItem msg={reply()} agents={agents} />);
    expect(old.container.querySelector(".message-model")!.textContent).toBe("fable 5.1");
  });
});
