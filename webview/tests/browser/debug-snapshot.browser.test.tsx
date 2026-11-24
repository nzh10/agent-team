import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { MessageItem } from "../../src/chat/messages";
import { collectSnapshot } from "../../src/dev/debugSnapshot";
import type { AgentInfo, Message } from "../../src/state/useServer";
import "../../src/styles.css";

const NOW = 1_800_000_000_000;

const agent: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-4-6",
  color: "#528bff",
  avatar: "A",
  isDefault: true,
};

const activeContent = "Working through the layout diagnostics.";

const activeTurn: Message = {
  id: "turn-live",
  kind: "agent",
  agentId: "a1",
  status: "streaming",
  timestamp: NOW - 12_000,
  content: activeContent,
  liveThinkingSince: NOW - 6_000,
  liveThinking: "Inspecting the trailing step header and live footer.",
  events: [
    {
      kind: "tool_use",
      toolName: "Read",
      content: "**Read** `/repo/secret-file.ts`\nSECRET_READ_ARG_PAYLOAD",
      toolResult: "SECRET_READ_RESULT_PAYLOAD",
      contentOffset: activeContent.length,
    },
    {
      kind: "tool_use",
      toolName: "Bash",
      content: "**Bash**\n```bash\necho SECRET_BASH_PAYLOAD\n```",
      toolResult: "SECRET_BASH_OUTPUT_PAYLOAD",
      contentOffset: activeContent.length,
    },
    {
      kind: "tool_use",
      toolName: "mcp__panel__list_workspace_sessions",
      content: "**mcp__panel__list_workspace_sessions**\nSECRET_PANEL_PAYLOAD",
      toolResult: "ok",
      contentOffset: activeContent.length,
    },
    {
      kind: "tool_use",
      toolName: "mcp__server__very_long_diagnostic_tool_name",
      content: "**mcp__server__very_long_diagnostic_tool_name**\nSECRET_LONG_PAYLOAD",
      toolResult: "ok",
      contentOffset: activeContent.length,
    },
  ],
};

const trailingMessages: Message[] = [
  {
    id: "q1",
    kind: "user",
    agentId: null,
    status: "queued",
    timestamp: NOW - 4_000,
    content: "Queued follow-up 1",
  },
  {
    id: "sys1",
    kind: "system",
    agentId: null,
    status: "done",
    timestamp: NOW - 3_000,
    content: "Bob joined the team",
  },
  {
    id: "q2",
    kind: "user",
    agentId: null,
    status: "queued",
    timestamp: NOW - 2_000,
    content: "Queued follow-up 2",
  },
  {
    id: "q3",
    kind: "user",
    agentId: null,
    status: "queued",
    timestamp: NOW - 1_000,
    content: "Queued follow-up 3",
  },
];

const nextPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("captures real Chromium active-turn layout geometry in folded and live open states despite trailing siblings", async () => {
  await page.viewport(390, 800);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  const view = render(
    <div id="root">
      <div className="app">
        <div className="main-panel">
          <div className="messages">
            <MessageItem
              msg={{
                id: "old",
                kind: "agent",
                agentId: "a1",
                status: "done",
                timestamp: NOW - 60_000,
                content: "Earlier finished turn",
              }}
              agents={[agent]}
            />
            <MessageItem msg={activeTurn} agents={[agent]} />
            {trailingMessages.map((m) => (
              <MessageItem key={m.id} msg={m} agents={[agent]} />
            ))}
          </div>
        </div>
      </div>
    </div>,
  );
  await nextPaint();

  // Folded state: active turn is retained past 4 trailing siblings and reports single-row chip geometry.
  const folded = collectSnapshot();
  expect(folded.activeTurn).toBeDefined();
  expect(folded.activeTurn!.id).toBe("msg-turn-live");
  expect(folded.activeTurn!.trailingSiblings).toBe(4);
  expect(folded.html).toContain('id="msg-turn-live"');
  expect(folded.html).not.toContain('id="msg-old"');

  const foldedStep = folded.activeTurn!.stepGroup!;
  expect(foldedStep.open).toBe(false);
  expect(foldedStep.header!.rect.height).toBeGreaterThan(0);
  expect(foldedStep.summary).toMatchObject({ text: "4 tool calls", lineCount: 1 });
  expect(foldedStep.liveChip).toBeUndefined();
  expect(foldedStep.toolsStrip?.scrollWidth).toBeGreaterThan(foldedStep.toolsStrip!.clientWidth);
  expect(foldedStep.toolChips).toHaveLength(4);
  expect(foldedStep.toolChipRowCount).toBe(1);
  expect(foldedStep.toolChips.every((c) => c.row === 0 && c.rect.width > 0)).toBe(true);

  expect(folded.activeTurn!.turnFooter?.state).toBe("thinking");
  expect(folded.activeTurn!.turnFooter?.liveChip?.text).toBe("Thinking · 6s");
  expect(folded.activeTurn!.turnFooter?.liveChip?.rect.height).toBeGreaterThan(0);

  // Open the trailing step group so tool events and live thinking are visible in the DOM.
  fireEvent.click(view.container.querySelector("#msg-turn-live .step-header")!);
  await nextPaint();

  const opened = collectSnapshot();
  expect(opened.activeTurn!.stepGroup!.open).toBe(true);
  expect(opened.activeTurn!.stepGroup!.toolChips).toHaveLength(4);
  expect(opened.activeTurn!.stepGroup!.toolChipRowCount).toBe(4);
  expect(opened.activeTurn!.stepGroup!.liveThinking).toBeDefined();
  expect(opened.activeTurn!.stepGroup!.liveThinking!.rect.height).toBeGreaterThan(0);
  expect(opened.activeTurn!.turnFooter?.state).toBe("thinking");

  // Neither folded nor open snapshots leak tool payloads.
  for (const snap of [folded, opened]) {
    const json = JSON.stringify(snap);
    expect(json).not.toContain("SECRET_READ_ARG_PAYLOAD");
    expect(json).not.toContain("SECRET_READ_RESULT_PAYLOAD");
    expect(json).not.toContain("SECRET_BASH_PAYLOAD");
    expect(json).not.toContain("SECRET_BASH_OUTPUT_PAYLOAD");
    expect(json).not.toContain("SECRET_PANEL_PAYLOAD");
    expect(json).not.toContain("SECRET_LONG_PAYLOAD");
  }
});

it("reports standalone thinking in the step header and a quiet footer of the same height", async () => {
  await page.viewport(390, 800);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const view = (msg: Message) => (
    <div className="messages">
      <MessageItem msg={msg} agents={[agent]} />
    </div>
  );
  const { rerender } = render(view(activeTurn));
  const initial = collectSnapshot().activeTurn!;
  rerender(view({ ...activeTurn, content: "", events: [] }));
  const standalone = collectSnapshot().activeTurn!;
  expect(standalone.stepGroup?.summary).toBeUndefined();
  expect(standalone.stepGroup?.liveChip).toMatchObject({
    selector: ".step-header .chip-live",
    text: "Thinking · 6s",
  });
  expect(standalone.stepGroup!.liveChip!.rect.height).toBeGreaterThan(0);
  expect(standalone.turnFooter).toMatchObject({ state: "quiet", text: "" });
  expect(standalone.turnFooter?.rect.height).toBe(initial.turnFooter?.rect.height);
});
