import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventItem, MessageItem, SubAgentItem } from "../src/chat/messages";
import { auditChatRedundancy } from "../src/dev/auditChatRedundancy";
import { buildFrames, DEMO_WS_ID, frameDelay, LAYOUT_TURN_ID } from "../src/dev/replayFixture";
import { collectSnapshot } from "../src/dev/debugSnapshot";
import { applyEventsToMessage, withoutLiveTiming } from "../src/state/stream";
import type { AgentInfo, Message, StreamEvent, Workspace } from "../src/state/useServer";

const now = 1_800_000_000_000;
const turn: Message = {
  id: "audit",
  kind: "agent",
  agentId: null,
  content: "",
  timestamp: now,
  status: "streaming",
};
const read: StreamEvent = {
  kind: "tool_use",
  content: "**Read** `src/file.ts`\n\nLines 1–20",
  toolUseId: "read",
  toolResult: "text",
};
const edit: StreamEvent = {
  kind: "tool_use",
  content: "**Edit** `src/file.ts`\n\n```diff\n-old\n+new\n```",
};
const heading: StreamEvent = { kind: "tool_use", content: "**Bash**\n\n```sh\necho ok\n```" };
const orphan: StreamEvent = { kind: "tool_result", content: "text" };

function audit(root: ParentNode | string) {
  expect(auditChatRedundancy(root)).toEqual([]);
}

function click(root: ParentNode, selector: string) {
  const button = root.querySelector(selector);
  expect(button, selector).not.toBeNull();
  fireEvent.click(button!);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each(["detail", "summary"])("EventItem %s matrix", (mode) => {
  const load = () => (mode === "summary" ? vi.fn() : undefined);

  it.each([orphan, read])(
    "$kind keeps one result action when closed, open, and reclosed",
    (event) => {
      const onLoadDetails = load();
      const standalone = event.kind === "tool_result";
      const ev =
        mode === "detail"
          ? event
          : standalone
            ? { ...event, content: "", contentLength: 511 }
            : { ...event, toolResult: undefined, resultLength: 511 };
      const { container } = render(<EventItem ev={ev} onLoadDetails={onLoadDetails} />);
      const button = container.querySelector(".btn-diff")!;
      const size = mode === "summary" ? 511 : 4;
      expect(button.textContent).toBe(`${standalone ? "Show" : "Result"} · ${size} chars`);
      expect(
        [...container.querySelectorAll(".event-row .event-chip")].map((chip) => chip.textContent),
      ).toEqual([standalone ? "Result" : "Read"]);
      audit(container);
      fireEvent.click(button);
      expect(button.textContent).toBe(`${standalone ? "Hide" : "Hide result"} · ${size} chars`);
      expect(container.querySelectorAll(".event-result")).toHaveLength(mode === "detail" ? 1 : 0);
      if (onLoadDetails) expect(onLoadDetails).toHaveBeenCalledOnce();
      audit(container);
      fireEvent.click(button);
      expect(container.querySelector(".event-result")).toBeNull();
      audit(container);
    },
  );

  it.each([
    [read, "Lines 1–20"],
    [edit, "-old"],
    [heading, "echo ok"],
  ] as const)("$content keeps the useful body without repeating the summary", (ev, body) => {
    const { container } = render(<EventItem ev={ev} onLoadDetails={load()} />);
    expect(container.querySelector(".event-content")?.textContent).toContain(body);
    expect(container.querySelector(".event-content")?.textContent).not.toMatch(
      /Read|Edit|Bash|src\/file\.ts/,
    );
    audit(container);
  });

  it.each(["thinking", "text", "notice", "compact", "retry", "error"])(
    "%s renders without a result toggle",
    (kind) => {
      const { container } = render(
        <EventItem ev={{ kind, content: "Finished this step." }} onLoadDetails={load()} />,
      );
      expect(container.textContent).toContain("Finished this step.");
      expect(container.querySelector(".btn-diff")).toBeNull();
      audit(container);
    },
  );
});

describe("StepBox + TurnFooter phase matrix", () => {
  it.each(["standalone", "alongside steps", "closing", "settled", "running tool"])(
    "%s: scopes indicators in folded and expanded states",
    (phase) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const msg: Message = { ...turn };
      if (phase === "standalone" || phase === "alongside steps") {
        msg.liveThinkingSince = now;
        msg.liveThinking = "Working it out.";
      }
      if (phase === "alongside steps") msg.events = [read];
      if (phase === "closing") msg.closingThinking = "Almost there.";
      if (phase === "settled") {
        msg.status = "done";
        msg.events = [{ kind: "thinking", content: "Solved." }];
      }
      if (phase === "running tool")
        msg.events = [{ ...read, toolResult: undefined, startedAt: now - 4_000 }];
      const { container } = render(<MessageItem msg={msg} agents={[]} />);
      const toggle = ".step-header > .trace-header-toggle";
      for (const open of [false, true]) {
        if (open) click(container, toggle);
        expect(container.querySelectorAll(".events-list")).toHaveLength(open ? 1 : 0);
        const footer = container.querySelector(".turn-footer");
        expect(container.querySelectorAll(".chip-live")).toHaveLength(
          msg.liveThinkingSince == null ? 0 : 1,
        );
        expect(container.querySelectorAll(".step-header .chip-live")).toHaveLength(
          phase === "standalone" ? 1 : 0,
        );
        expect(footer?.textContent).toBe(
          phase === "settled"
            ? undefined
            : phase === "alongside steps"
              ? "Thinking · 0s"
              : phase === "running tool"
                ? "Read · 4s"
                : "",
        );
        if (open && msg.liveThinkingSince != null)
          expect(container.querySelector(".live-thinking")?.textContent).toContain(
            msg.liveThinking,
          );
        if (open && phase === "running tool")
          expect(container.querySelector(".event-time-live")?.textContent).toBe("4s");
        audit(container);
      }
    },
  );
});

describe("SubAgentItem state matrix", () => {
  it.each([
    { status: "running", expected: undefined },
    { status: "running", durationMs: 4_000, expected: "4s" },
    { status: "completed", expected: "18s" },
    { status: "completed", durationMs: 4_000, expected: "4s" },
    { status: "failed", durationMs: 4_000, expected: "4s" },
    { status: "stopped", durationMs: 4_000, expected: "4s" },
  ] as const)(
    "$status (header: $expected) displays at most one elapsed time",
    ({ status, expected, ...fields }) => {
      const ev: StreamEvent = {
        kind: status === "running" ? "subagent_start" : "subagent_done",
        content: "",
        subagent: {
          taskId: "child",
          description: "Investigate",
          status,
          ...fields,
          usage: { totalTokens: 4_000, toolUses: 2, durationMs: 18_000 },
          events: [orphan],
        },
      };
      const { container } = render(<SubAgentItem ev={ev} />);
      for (const open of [false, true]) {
        if (open) click(container, ".subagent-header > .trace-header-toggle");
        expect(
          [...container.querySelectorAll(".subagent-header .subagent-time")].map(
            (e) => e.textContent,
          ),
        ).toEqual(expected ? [expected] : []);
        expect(container.querySelector(".subagent-usage")?.textContent).toBe(
          open ? "4k tokens · 2 tools" : undefined,
        );
        audit(container);
      }
    },
  );
});

it("audits folded and expanded turns across replayFixture", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const frames = buildFrames();
  let agents = (
    frames.find((f) => (f.workspace as Workspace | undefined)?.id === DEMO_WS_ID)!
      .workspace as Workspace
  ).agents;
  const messages = new Map<string, Message>();
  const completed = new Set<string>();
  const livePhases = new Set<string>();
  let at = now;
  for (const frame of frames) {
    vi.setSystemTime(at);
    at += frameDelay(frame);
    const id = frame.messageId as string;
    if (frame.type === "new_message") {
      const msg = frame.message as Message;
      messages.set(msg.id, msg);
    } else if (frame.type === "stream_event") {
      const ev = frame.event as StreamEvent;
      const previous = messages.get(id)!;
      if (
        id === LAYOUT_TURN_ID &&
        ev.kind === "thinking_delta" &&
        ev.startedAt != null &&
        previous.waitingSince != null
      ) {
        const clock = Date.now();
        vi.setSystemTime(previous.waitingSince + 5_000);
        auditTurn(previous, agents, { footer: "Waiting for the model · 5s" });
        vi.setSystemTime(clock);
        livePhases.add("waiting");
      }
      const msg = applyEventsToMessage(previous, [ev]);
      messages.set(id, msg);
      if (ev.kind === "thinking_delta") auditTurn(msg, agents);
    } else if (frame.type === "agent_activity") {
      const msg = messages.get(LAYOUT_TURN_ID);
      if (msg && frame.activity === "Checking layout · 3s") {
        auditTurn(msg, agents, { footer: "RunTests · 3s", runningTool: "3s" });
        livePhases.add("running tool");
      }
      agents = agents.map((agent) =>
        agent.id === frame.agentId
          ? { ...agent, activity: frame.activity as string | null }
          : agent,
      );
      if (msg && frame.activity === "Checking layout · 3s") {
        auditTurn(msg, agents, { footer: frame.activity, runningTool: "3s" });
        livePhases.add("activity");
      }
    } else if (frame.type === "message_done") {
      const msg: Message = {
        ...withoutLiveTiming(messages.get(id)!),
        status: frame.status as Message["status"],
        content: frame.content as string,
      };
      messages.set(id, msg);
      auditTurn(msg, agents);
      completed.add(id);
    }
  }
  expect(completed.size).toBeGreaterThan(1);
  expect([...livePhases]).toEqual(["waiting", "running tool", "activity"]);
});

function auditTurn(
  msg: Message,
  agents: AgentInfo[],
  phase?: { footer: string; runningTool?: string },
) {
  const view = render(<MessageItem msg={msg} agents={agents} />);
  try {
    audit(view.container);
    let toggle: Element | null;
    while ((toggle = view.container.querySelector('.trace-header-toggle[aria-expanded="false"]'))) {
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    }
    audit(view.container);
    if (phase) {
      expect(view.container.querySelector(".turn-footer")?.textContent).toBe(phase.footer);
      if (phase.runningTool)
        expect(view.container.querySelector(".event-time-live")?.textContent).toBe(
          phase.runningTool,
        );
    }
  } finally {
    view.unmount();
  }
}

it("finds duplicate live thinking in actual message DOM and exported snapshot HTML", () => {
  const { container } = render(
    <div className="messages">
      <MessageItem
        msg={{ ...turn, liveThinking: "Thinking now", liveThinkingSince: Date.now() }}
        agents={[]}
      />
    </div>,
  );
  audit(container);
  container
    .querySelector(".turn-footer")!
    .append(container.querySelector(".step-header .chip-live")!.cloneNode(true));
  const findings = auditChatRedundancy(container);
  expect(findings.map((f) => f.rule)).toEqual(["live-thinking"]);
  expect(auditChatRedundancy(collectSnapshot().html)).toEqual(findings);
});

it("records duplicate tool summaries in exported snapshots without exposing tool payloads", () => {
  const { container } = render(
    <div className="messages">
      <MessageItem msg={{ ...turn, status: "done", events: [edit, heading] }} agents={[]} />
    </div>,
  );
  click(container, ".step-header > .trace-header-toggle");
  audit(container);
  const [editBody, bashBody] = container.querySelectorAll(".event-tool_use .event-content");
  editBody.insertAdjacentHTML(
    "afterbegin",
    "<p><strong>Edit</strong> <code>src/file.ts</code></p>",
  );
  bashBody.insertAdjacentHTML("afterbegin", "<p><strong>Bash</strong></p>");
  const findings = auditChatRedundancy(container);
  expect(findings.map((f) => f.rule)).toEqual(["tool-summary", "tool-summary"]);
  const { html } = collectSnapshot();
  expect(html).not.toMatch(/src\/file\.ts|echo ok/);
  const snapshotFindings = auditChatRedundancy(html);
  expect(snapshotFindings).toEqual(findings);
  expect(auditChatRedundancy(container)).toEqual(findings); // The live DOM is untouched.
});

it("diagnoses historic duplicates in captured HTML, without scanning message prose", () => {
  const html = `<div class="message message-agent" id="msg-capture"><div class="message-body">
    <div class="message-content">
      <p>Result Result · 511 chars. Thinking Thinking. Read Read.</p>
      <div><div class="step-group"><div class="step-header"><span class="chip-live">Thinking · 1s</span></div></div></div>
      <div class="event-tool_result"><div class="event-row"><span class="event-chip">Result</span><button class="btn-diff">Result · 511 chars</button></div></div>
      <div class="event-tool_use"><div class="event-row"><span class="event-chip">Edit</span></div><div class="event-summary-line"><code>src/file.ts</code></div><div class="event-content"><p><strong>Edit</strong> <code>src/file.ts</code></p></div></div>
      <div class="event-tool_use"><div class="event-row"><span class="event-chip">Bash</span></div><div class="event-content"><p><strong>Bash</strong></p><div class="code-block"><pre>echo ok</pre></div></div></div>
      <div class="subagent-item"><div class="subagent-header"><span class="subagent-time">4s</span></div><div class="subagent-body"><div class="subagent-usage">4k tokens · 2 tools · 18s</div></div></div>
    </div><div class="turn-footer"><span class="chip-live">Thinking · 1s</span></div>
  </div></div>`;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const findings = auditChatRedundancy(html);
  expect(findings).toEqual(auditChatRedundancy(doc));
  expect(findings.map((f) => f.rule)).toEqual([
    "result-label",
    "live-thinking",
    "tool-summary",
    "tool-summary",
    "subagent-duration",
  ]);
  expect(findings.every((f) => f.messageId === "msg-capture")).toBe(true);
  audit(doc.querySelector("p")!);
});
