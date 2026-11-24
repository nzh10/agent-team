import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { SubAgentItem, StepGroup, MessageItem, CreateWorkspaceDialog } from "../src/App";
import { HostInfo } from "../src/state/useServer";
import { StreamEvent, Message, AgentInfo } from "../src/state/useServer";
import { applyEventsToMessage } from "../src/state/stream";

const sa = (over: Partial<NonNullable<StreamEvent["subagent"]>> = {}): StreamEvent => ({
  kind: "subagent_start",
  content: "",
  subagent: { taskId: "task-1", description: "explore the repo", agentType: "Explore", ...over },
});

describe("SubAgentItem", () => {
  it("shows only the execution summary and closes a nonempty trace from its footer", () => {
    const { container, getByRole, queryByRole } = render(
      <SubAgentItem
        ev={sa({
          status: "completed",
          model: "provider/resolved",
          effort: "high",
          durationMs: 3000,
          lastTool: "PrivateTool",
          events: [{ kind: "text", content: "trace" }],
        })}
      />,
    );
    const header = container.querySelector(".subagent-header")!;
    expect(header.textContent).toBe("▸✓explore the repoprovider/resolvedhigh3s");
    expect(queryByRole("button", { name: "Collapse subagent trace" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Expand subagent: explore the repo" }));
    fireEvent.click(getByRole("button", { name: "Collapse subagent trace" }));
    expect(container.querySelector(".subagent-body")).toBeNull();
    expect(document.activeElement).toBe(
      getByRole("button", { name: "Expand subagent: explore the repo" }),
    );
  });

  it("does not show a bottom collapse control on an empty subagent", () => {
    const { getByRole, queryByRole } = render(<SubAgentItem ev={sa()} />);
    fireEvent.click(getByRole("button", { name: "Expand subagent: explore the repo" }));
    expect(queryByRole("button", { name: "Collapse subagent trace" })).toBeNull();
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

  it("hides the cancel button once the subagent is done", () => {
    const { container } = render(
      <SubAgentItem ev={sa({ status: "completed" })} onCancel={() => {}} />,
    );
    expect(container.querySelector(".btn-cancel-subagent")).toBeNull();
    expect(container.querySelector(".subagent-item")!.className).toContain("subagent-completed");
  });

  it("renders a stopped subagent with its own status style", () => {
    const { container } = render(<SubAgentItem ev={sa({ status: "stopped" })} />);
    expect(container.querySelector(".subagent-item")!.className).toContain("subagent-stopped");
  });

  it("renders nested subagents as nested SubAgentItems with merged lifecycle", () => {
    const nestedEvents: StreamEvent[] = [
      { kind: "tool_use", content: "Read /a", toolUseId: "t1" },
      {
        kind: "subagent_start",
        content: "",
        subagent: { taskId: "nested-1", description: "inner search", agentType: "Explore" },
      },
      {
        kind: "subagent_done",
        content: "",
        subagent: { taskId: "nested-1", description: "", status: "completed" },
      },
    ];
    const { container, getByText } = render(
      <SubAgentItem ev={sa({ status: "running", events: nestedEvents })} />,
    );
    fireEvent.click(container.querySelector(".subagent-header")!);

    const items = container.querySelectorAll(".subagent-item");
    expect(items).toHaveLength(2); // parent + one nested (start/done folded)
    expect(items[1].className).toContain("subagent-completed");
    expect(getByText("inner search")).toBeTruthy();
    // The nested lifecycle events must not leak into the regular event list.
    expect(container.querySelectorAll(".event-subagent_start")).toHaveLength(0);
  });
});

describe("StepGroup", () => {
  it("returns an expanded step to its collapsed header from the footer", () => {
    const { getByRole, queryByRole } = render(
      <StepGroup group={{ step: 0, events: [{ kind: "thinking", content: "step" }] }} />,
    );
    expect(queryByRole("button", { name: "Collapse step trace" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Expand steps" }));
    fireEvent.click(getByRole("button", { name: "Collapse step trace" }));
    expect(queryByRole("button", { name: "Collapse step trace" })).toBeNull();
    expect(document.activeElement).toBe(getByRole("button", { name: "Expand steps" }));
  });
  it("omits the step box entirely when a segment only contains a subagent", () => {
    const { container } = render(<StepGroup group={{ step: 0, events: [sa()] }} />);
    expect(container.querySelector(".step-group")).toBeNull();
    expect(container.querySelector(".subagent-item")).toBeTruthy();
  });
});

describe("MessageItem", () => {
  const agents: AgentInfo[] = [
    {
      id: "a1",
      name: "Alice",
      model: "claude-fable-5",
      avatar: "🤖",
      color: "#888",
      isDefault: true,
    },
  ];
  const msg = (over: Partial<Message>): Message => ({
    id: "m1",
    kind: "agent",
    agentId: "a1",
    content: "",
    timestamp: 0,
    status: "done",
    ...over,
  });

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

  it("segments delayed thinking before text using the preserved offset", () => {
    const streamed = applyEventsToMessage(msg({ status: "streaming" }), [
      { kind: "text_delta", content: "Answer" },
      { kind: "thinking", content: "plan", contentOffset: 0, durationMs: 1_000 },
    ]);
    expect(streamed.events?.map((event) => [event.kind, event.contentOffset])).toEqual([
      ["thinking", 0],
    ]);
    const { container } = render(
      <MessageItem msg={{ ...streamed, status: "done" }} agents={agents} />,
    );
    const segments = container.querySelectorAll(".message-content > div");
    expect(segments).toHaveLength(2);
    expect(segments[0].querySelector(".step-summary")?.textContent).toBe("1 thinking");
    expect(segments[1].textContent).toBe("Answer");
  });

  it("renders delayed thinking before text and an interleaved tool in client aggregation", () => {
    const streamed = applyEventsToMessage(msg({ status: "streaming" }), [
      { kind: "text_delta", content: "Answer" },
      {
        kind: "tool_use",
        content: "**Read** `a.ts`",
        toolName: "Read",
        toolUseId: "call-1",
        contentOffset: 6,
      },
      { kind: "thinking", content: "plan", contentOffset: 0, durationMs: 1_000 },
    ]);
    expect(streamed.events?.map((event) => [event.kind, event.contentOffset])).toEqual([
      ["tool_use", 6],
      ["thinking", 0],
    ]);
    const { container } = render(
      <MessageItem msg={{ ...streamed, status: "done" }} agents={agents} />,
    );
    const segments = container.querySelectorAll(".message-content > div");
    expect(segments).toHaveLength(2);
    expect(segments[0].querySelector(".step-summary")?.textContent).toBe("1 thinking");
    expect(segments[1].textContent).toContain("Answer");
    expect(segments[1].querySelector(".step-summary")?.textContent).toBe("1 tool call");
    expect(segments[1].textContent.indexOf("Answer")).toBeLessThan(
      segments[1].textContent.indexOf("1 tool call"),
    );
  });

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
    const utils = render(
      <CreateWorkspaceDialog
        hosts={hosts}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={onListDirs}
        dirSuggestions={dirSuggestions}
      />,
    );
    const pathInput = utils.getByPlaceholderText("~/workspace/...") as HTMLInputElement;
    return { ...utils, onCreate, onListDirs, pathInput };
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
    const { pathInput, getByText, rerender, onCreate, onListDirs } = setup();
    fireEvent.change(pathInput, { target: { value: "/home/ex" } });
    rerender(
      <CreateWorkspaceDialog
        hosts={hosts}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={onListDirs}
        dirSuggestions={{ prefix: "/home/ex", dirs: ["/home/example/"] }}
      />,
    );
    fireEvent.mouseDown(getByText("/home/example/"));
    expect(pathInput.value).toBe("/home/example/");
  });

  it("ignores stale suggestions for older input", () => {
    const { pathInput, container, onCreate, onListDirs, rerender } = setup();
    fireEvent.change(pathInput, { target: { value: "/tmp/x" } });
    rerender(
      <CreateWorkspaceDialog
        hosts={hosts}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={onListDirs}
        dirSuggestions={{ prefix: "/home/ex", dirs: ["/home/example/"] }}
      />,
    );
    expect(container.querySelector(".dir-suggest")).toBeNull();
  });

  it("submits name + path, defaulting the name to the folder basename", () => {
    const { pathInput, onCreate, getByText } = setup();
    fireEvent.change(pathInput, { target: { value: "/home/example/clice" } });
    fireEvent.click(getByText("Create"));
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
    fireEvent.click(getByText("Create"));
    expect(onCreate).toHaveBeenCalledWith("clice2", "/repo/clice2", "local", "Clice Two");
  });

  it("closes the suggestion list when the path input loses focus (mobile has no Esc)", () => {
    vi.useFakeTimers();
    try {
      const { pathInput, container, onCreate, onListDirs, rerender } = setup();
      fireEvent.change(pathInput, { target: { value: "/home/ex" } });
      rerender(
        <CreateWorkspaceDialog
          hosts={hosts}
          onClose={() => {}}
          onCreate={onCreate}
          onListDirs={onListDirs}
          dirSuggestions={{ prefix: "/home/ex", dirs: ["/home/example/"] }}
        />,
      );
      expect(container.querySelector(".dir-suggest")).not.toBeNull();

      fireEvent.blur(pathInput);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(container.querySelector(".dir-suggest")).toBeNull();

      // Refocusing brings it back before the user types anything.
      fireEvent.focus(pathInput);
      expect(container.querySelector(".dir-suggest")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the list open across a quick blur/focus (tapping a suggestion)", () => {
    vi.useFakeTimers();
    try {
      const { pathInput, container, onCreate, onListDirs, rerender } = setup();
      fireEvent.change(pathInput, { target: { value: "/home/ex" } });
      rerender(
        <CreateWorkspaceDialog
          hosts={hosts}
          onClose={() => {}}
          onCreate={onCreate}
          onListDirs={onListDirs}
          dirSuggestions={{ prefix: "/home/ex", dirs: ["/home/example/"] }}
        />,
      );
      fireEvent.blur(pathInput);
      fireEvent.focus(pathInput); // cancels the pending close
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(container.querySelector(".dir-suggest")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MessageItem queued state", () => {
  const agents: AgentInfo[] = [
    { id: "a1", name: "Alice", model: "m", avatar: "A", color: "#888", isDefault: true },
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

  it("renders a queued badge, dims the message, and cancels via the badge", () => {
    const onCancelQueued = vi.fn();
    const { container, getByTitle, getByText } = render(
      <MessageItem msg={queuedMsg} agents={agents} onCancelQueued={onCancelQueued} />,
    );
    expect(getByText("queued")).toBeTruthy();
    expect(container.querySelector(".message")!.className).toContain("message-queued");
    fireEvent.click(getByTitle("Remove from queue"));
    expect(onCancelQueued).toHaveBeenCalledWith("mq");
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
