import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import type { Message } from "../../src/state/useServer";
import { FakeSocket, initFrame } from "../fakeSocket";
import {
  mountFixedApp,
  nextPaint,
  rowOffset,
  scrollGap as gap,
  scrollTo as move,
} from "../helpers/browser";
import { agent as makeAgent, message, workspace } from "../helpers/fixtures";
import { healViewport, settleScroller } from "../../src/viewport/viewportHeal";
import "../../src/styles.css";

const agent = makeAgent("a");
const title = "A workspace with a title much too long for a phone to show on a single line";
const ws = workspace("w", { name: title, agents: [agent] });
const turn = (i: number, extra: Partial<Message> = {}) =>
  message(`m${i}`, {
    timestamp: 1000 + i,
    content: `Reply ${i}\n\n${"A paragraph of work in progress. ".repeat(4)}`,
    ...extra,
  });
const history = Array.from({ length: 18 }, (_, i) => turn(i));
const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const bottom = (el: HTMLElement) => expect.poll(() => gap(el)).toBeLessThanOrEqual(1);

function connect(sock: FakeSocket, workspaces = [ws]) {
  act(() => {
    sock.open();
    sock.receive(
      initFrame(workspaces, {
        config: {
          presets: [],
          models: [],
          commands: [
            {
              name: "compact",
              description: "Summarize the conversation before continuing",
              source: "extension",
            },
          ],
          hosts: {},
        },
      }),
    );
  });
}
async function mountTranscript(workspaces: (typeof ws)[], width: number, height = 760) {
  await page.viewport(width, height);
  localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  mountFixedApp();
  const sock = FakeSocket.instances.at(-1)!;
  connect(sock, workspaces);
  const receive = (frame: object) => {
    act(() => sock.receive({ workspaceId: "w", ...frame }));
  };
  return { scroll: get(".messages"), sock, receive };
}
async function boot(tail: Message[] = [], workspaces = [ws], hasMore = false, width = 390) {
  const { scroll, sock, receive } = await mountTranscript(workspaces, width);
  receive({ type: "workspace_messages", messages: [...history, ...tail], hasMore });
  expect(scroll.clientHeight).toBeGreaterThan(350);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  await bottom(scroll);
  await nextPaint();
  return { scroll, sock, receive };
}
function chooseWorkspace(name: string) {
  if (window.innerWidth < 768) fireEvent.click(get(".mobile-menu-btn"));
  const row = [...document.querySelectorAll(".task-item")].find((el) =>
    el.textContent?.includes(name),
  );
  fireEvent.click(row!);
}
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("delays only a cold in-flight 25-row mobile page and never holds ready content", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const second = { ...ws, id: "later", name: "Cold conversation" };
  const failed = { ...ws, id: "failed", name: "Unreadable history" };
  const next = { ...ws, id: "next", name: "Another cold conversation" };
  const { scroll, sock, receive } = await mountTranscript([ws, second, failed, next], 390, 844);
  const hint = () => scroll.querySelector(".history-loading");
  const tick = (ms: number) => {
    void act(() => vi.advanceTimersByTime(ms));
  };
  expect(sock.frames().at(-1)).toMatchObject({ type: "load_messages", limit: 25 });
  tick(119);
  expect(hint()).toBeNull();
  receive({ type: "workspace_messages", messages: [turn(0)] });
  tick(1);
  expect(hint()).toBeNull();
  expect(get("#msg-m0")).not.toBeNull();

  chooseWorkspace(second.name);
  expect(get("#msg-m0")).toBeNull();
  expect(hint()).toBeNull();
  tick(119);
  chooseWorkspace(ws.name);
  tick(1);
  expect(hint()).toBeNull();
  expect(get("#msg-m0")).not.toBeNull();
  chooseWorkspace(second.name);
  tick(119);
  expect(hint()).toBeNull();
  tick(1);
  expect(hint()?.classList.contains("history-cold-reveal")).toBe(true);
  receive({ type: "workspace_messages", workspaceId: second.id, messages: [] });
  expect(hint()).toBeNull();
  expect(scroll.querySelector(".empty-state")?.textContent).toBe(
    "Send a message to start working.",
  );

  chooseWorkspace(failed.name);
  using _log = vi.spyOn(console, "error").mockImplementation(() => {});
  receive({ type: "error", message: "History could not be read" });
  expect(hint()).not.toBeNull();
  chooseWorkspace(next.name);
  fireEvent.click(get(".error-toast"));
  expect(hint()).not.toBeNull();
});

it.each(["light", "dark"] as const)(
  "uses compact avatar rings in UI chrome and the full ring only in chat (%s)",
  async (theme) => {
    await boot(
      [],
      [{ ...ws, agents: [agent, { ...agent, id: "b", name: "Second", avatar: "B" }] }],
    );
    document.documentElement.dataset.theme = theme;
    const chatAvatar = get("#msg-m0 .message-gutter .agent-avatar");
    const chipAvatars = [...document.querySelectorAll<HTMLElement>(".agents-chip .agent-avatar")];
    expect(chipAvatars).toHaveLength(2);
    const compactShadow = getComputedStyle(chipAvatars[0]).boxShadow;
    const expectCompact = (avatar: HTMLElement) => {
      expect(avatar.classList.contains("agent-avatar-compact")).toBe(true);
      expect(getComputedStyle(avatar).boxShadow).toBe(compactShadow);
    };
    for (const avatar of chipAvatars) {
      expectCompact(avatar);
      expect(getComputedStyle(avatar).boxShadow).toContain("0px 0px 0px 1px");
    }
    expect(chipAvatars[1].getBoundingClientRect().left).toBeLessThan(
      chipAvatars[0].getBoundingClientRect().right,
    );

    fireEvent.click(get(".agents-chip"));
    expect(get(".agents-chip").getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(get(".agents-chip")).borderTopWidth).toBe("1px");
    expect(getComputedStyle(get(".ap-session")).borderTopWidth).toBe("1px");
    expectCompact(get(".agents-panel .ap-agent > .agent-avatar"));
    fireEvent.click(get(".side-panel-close"));

    const input = get<HTMLTextAreaElement>("textarea");
    fireEvent.change(input, { target: { value: "@", selectionStart: 1 } });
    expectCompact(get(".mention-popup .agent-avatar"));
    fireEvent.change(input, { target: { value: "", selectionStart: 0 } });
    fireEvent.click(get("#msg-m0 .btn-quote"));
    expectCompact(get(".quote-bar .agent-avatar"));

    expect(chatAvatar.classList.contains("agent-avatar-compact")).toBe(false);
    expect(getComputedStyle(chatAvatar).boxShadow).not.toBe(compactShadow);
  },
);

it("follows a growing tail only until the reader moves up, and resumes at the bottom", async () => {
  const live = turn(18, { status: "streaming", content: "Working" });
  const { scroll, receive } = await boot();
  receive({ type: "new_message", message: live });
  expect(gap(scroll)).toBeLessThanOrEqual(1);
  const row = get("#msg-m18");
  expect(scroll.getAnimations()).toEqual([]);
  expect(row.getAnimations()).toEqual([]);
  const content = row.querySelector(".message-content")!;
  expect(content.getAnimations({ subtree: true })).toEqual([]);
  async function grow() {
    const oldHeight = scroll.scrollHeight;
    receive({
      type: "stream_event",
      messageId: live.id,
      event: { kind: "text_delta", content: "\n\nAnother paragraph at the streaming tail." },
    });
    await expect.poll(() => scroll.scrollHeight).toBeGreaterThan(oldHeight);
    await nextPaint();
  }
  await grow();
  await bottom(scroll);
  expect(content.getAnimations({ subtree: true })).toEqual([]);
  // A coalesced native scroll has changed scrollTop but not notified App yet.
  scroll.scrollTop -= 3;
  const slightlyUp = scroll.scrollTop;
  receive({
    type: "stream_event",
    messageId: live.id,
    event: { kind: "text_delta", content: "." },
  });
  expect(scroll.scrollTop).toBe(slightlyUp);
  for (const top of [scroll.scrollTop - 40, 200]) {
    move(scroll, top);
    await grow();
    expect(scroll.scrollTop).toBe(top);
  }
  fireEvent.click(get(".jump-latest"));
  scroll.scrollTop -= 220;
  const beforeSend = scroll.scrollTop;
  receive({ type: "new_message", message: turn(99) });
  expect(get("#msg-m99")).toBeTruthy();
  expect(scroll.scrollTop).toBe(beforeSend);
  await nextPaint();
  expect(scroll.scrollTop).toBe(beforeSend);
  fireEvent.click(get(".jump-latest"));
  await grow();
  await bottom(scroll);
});

it("follows a delayed starting row without moving a reader who has scrolled up", async () => {
  const { scroll, receive } = await boot();
  const start = (i: number) => {
    const input = turn(i, {
      kind: "user",
      agentId: null,
      content: "Start the agent",
      status: "starting",
      queuedFor: agent.id,
    });
    receive({ type: "new_message", message: input });
    return input;
  };
  const reveal = (input: Message) =>
    receive({
      type: "message_done",
      messageId: input.id,
      status: "starting",
      content: input.content,
      queuedFor: agent.id,
      pendingDelivery: "starting",
    });
  const input = start(99);
  expect(scroll.querySelector(".message-starting")).toBeNull();
  reveal(input);
  expect(get(`#msg-${input.id} + .message-starting`)).not.toBeNull();
  await nextPaint();
  expect(gap(scroll)).toBeLessThanOrEqual(1);
  receive({
    type: "message_done",
    messageId: input.id,
    status: "error",
    content: input.content,
    queuedFor: null,
  });

  move(scroll, 200);
  const next = start(100);
  reveal(next);
  expect(get(`#msg-${next.id} + .message-starting`)).not.toBeNull();
  await nextPaint();
  expect(scroll.scrollTop).toBe(200);
});

function reply(i: number, messageId: string) {
  return turn(i, {
    kind: "user",
    forwardRef: {
      messageId,
      fromAgent: agent.name,
      fromAvatar: agent.avatar,
      preview: "Quoted reply",
    },
  });
}

function expectInView(scroll: HTMLElement, target: HTMLElement) {
  const viewport = scroll.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
  expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom);
}

it.each([
  { width: 390, theme: "dark", motion: "reduce" },
  { width: 1200, theme: "light", motion: "no-preference" },
])(
  "lands immediately for search and quotes without stealing search focus ($width, $theme, $motion)",
  async ({ width, theme, motion }) => {
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: motion }],
    });
    try {
      const { scroll, receive, sock } = await boot([reply(18, "m3")], [ws], false, width);
      document.documentElement.dataset.theme = theme;
      const search = get<HTMLInputElement>(".search-bar input");
      fireEvent.change(search, { target: { value: "keep the query" } });
      fireEvent.click(get("#msg-m18 .forward-ref-icon"));
      expect(document.activeElement).toBe(get("#msg-m3.message-highlight"));
      expectInView(scroll, get("#msg-m3"));
      expect(search.value).toBe("keep the query");
      expect(sock.frames().filter(({ type }) => type === "load_messages")).toHaveLength(1);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      void act(() => vi.advanceTimersByTime(1000));
      search.focus();
      fireEvent.change(search, { target: { value: "needle" } });
      receive({
        type: "search_results",
        query: "needle",
        hits: [
          {
            workspaceId: "w",
            workspaceName: title,
            messageId: "m7",
            timestamp: 1007,
            snippet: "needle",
          },
        ],
      });
      fireEvent.click(get(".search-result-item"));
      expect([...document.querySelectorAll(".message-highlight")]).toEqual([get("#msg-m7")]);
      expect(document.activeElement).not.toBe(get("#msg-m7"));
      expectInView(scroll, get("#msg-m7"));
      void act(() => vi.advanceTimersByTime(1000));
      expect(get("#msg-m7.message-highlight")).not.toBeNull();
      fireEvent.click(get(".jump-latest"));
      expect(gap(scroll)).toBeLessThanOrEqual(1);
      expect(document.querySelector(".message-highlight")).toBeNull();
    } finally {
      await cdp().send("Emulation.setEmulatedMedia", { features: [] });
    }
  },
);

it("pages back to a quote and recovers from a reference missing from history", async () => {
  const { scroll, sock, receive } = await boot(
    [reply(18, "m-2"), reply(19, "deleted"), reply(20, "m3")],
    [ws],
    true,
  );
  fireEvent.click(get("#msg-m18 .forward-ref"));
  const first = turn(-1);
  expect(sock.frames().at(-1)).toMatchObject({
    type: "load_messages",
    before: history[0].timestamp,
  });
  receive({
    type: "workspace_messages",
    before: history[0].timestamp,
    messages: [first],
    hasMore: true,
  });
  expect(sock.frames().at(-1)).toMatchObject({ type: "load_messages", before: first.timestamp });
  receive({
    type: "workspace_messages",
    before: first.timestamp,
    messages: [turn(-2)],
    hasMore: true,
  });
  await expect.poll(() => get("#msg-m-2").matches(".message-highlight")).toBe(true);
  await expect.poll(() => scroll.scrollTop).toBe(0);
  expectInView(scroll, get("#msg-m-2"));

  scroll.style.overflowAnchor = "none";
  move(scroll, 360);
  fireEvent.click(get("#msg-m19 .forward-ref"));
  move(scroll, 500);
  const anchor = get("#msg-m3");
  const top = anchor.getBoundingClientRect().top;
  receive({
    type: "workspace_messages",
    before: turn(-2).timestamp,
    messages: [turn(-3)],
    hasMore: false,
  });
  await nextPaint();
  expect(get("#msg-m-3")).toBeTruthy();
  expect(anchor.getBoundingClientRect().top).toBeCloseTo(top, 0);
  const sent = sock.frames().length;
  fireEvent.click(get("#msg-m19 .forward-ref"));
  expect(document.querySelector(".message-highlight")).toBeNull();
  expect(sock.frames()).toHaveLength(sent);
  expect(anchor.getBoundingClientRect().top).toBeCloseTo(top, 0);
  fireEvent.click(get("#msg-m20 .forward-ref"));
  await expect.poll(() => get("#msg-m3").matches(".message-highlight")).toBe(true);
});

it("does not take focus or seek when a paged quote arrives after new reader input", async () => {
  const { scroll, receive } = await boot([reply(18, "m-2")], [ws], true);
  move(scroll, 350);
  fireEvent.click(get("#msg-m18 .forward-ref"));
  fireEvent.wheel(scroll, { deltaY: -80 });
  move(scroll, 270);
  const anchor = get("#msg-m3").getBoundingClientRect().top;
  receive({
    type: "workspace_messages",
    before: history[0].timestamp,
    messages: [turn(-2)],
    hasMore: false,
  });
  expect(get("#msg-m-2")).toBeTruthy();
  expect(document.querySelector(".message-highlight")).toBeNull();
  expect(document.activeElement).not.toBe(get("#msg-m-2"));
  expect(get("#msg-m3").getBoundingClientRect().top).toBeCloseTo(anchor, 0);
});

it("keeps a quote from another workspace visible without paging unrelated history", async () => {
  const { sock, receive } = await boot([], [ws, { ...ws, id: "other", name: "Other workspace" }]);
  fireEvent.click(get("#msg-m3 .btn-quote"));
  expect(get("button.quote-bar-content")).toBeTruthy();
  chooseWorkspace("Other workspace");
  receive({
    type: "workspace_messages",
    workspaceId: "other",
    messages: [turn(100)],
    hasMore: true,
  });
  const sent = sock.frames().length;
  const preview = get("div.quote-bar-content");
  expect(preview.textContent).toContain("Reply 3");
  fireEvent.click(preview);
  expect(sock.frames()).toHaveLength(sent);
});

it("jumps from the composer preview and closes the quote without a second jump", async () => {
  const { scroll } = await boot();
  const target = get("#msg-m3");
  fireEvent.click(get("#msg-m3 .btn-quote"));
  const preview = get("button.quote-bar-content");
  const close = get("button.quote-bar-close");
  expect(preview.nextElementSibling).toBe(close);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  preview.focus();
  await userEvent.keyboard("{Enter}");
  expect(target.matches(".message-highlight")).toBe(true);
  expect(document.activeElement).toBe(target);
  expectInView(scroll, target);
  expect(get(".quote-bar-content")).toBe(preview);
  void act(() => vi.advanceTimersByTime(2000));
  expect(target.matches(".message-highlight")).toBe(false);

  move(scroll, scroll.scrollHeight);
  fireEvent.click(close);
  void act(() => vi.advanceTimersByTime(100));
  expect(document.querySelector(".quote-bar")).toBeNull();
  expect(target.matches(".message-highlight")).toBe(false);
  expect(gap(scroll)).toBeLessThanOrEqual(1);
});

it("fits the phone header and composer, and keeps the bottom in view while composing", async () => {
  const { scroll } = await boot();
  const header = get(".panel-header-top").getBoundingClientRect();
  const heading = get(".panel-title");
  const chip = get(".agents-chip").getBoundingClientRect();
  const label = heading.getBoundingClientRect();
  expect(heading.scrollWidth).toBeGreaterThan(heading.clientWidth);
  expect(getComputedStyle(heading).textOverflow).toBe("ellipsis");
  expect(label.right).toBeLessThanOrEqual(chip.left);
  expect(label.top).toBeLessThan(chip.bottom);
  expect(label.bottom).toBeGreaterThan(chip.top);
  expect(chip.right).toBeLessThanOrEqual(header.right);
  const input = get<HTMLTextAreaElement>("textarea");
  expect(input.placeholder).toBe("Message, or / for commands");
  fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
  const command = get(".command-item");
  expect(get(".command-desc").getBoundingClientRect().top).toBeGreaterThanOrEqual(
    command.querySelector(".command-name")!.getBoundingClientRect().bottom,
  );
  fireEvent.change(input, { target: { value: "" } });
  await nextPaint();
  const oldHeight = scroll.clientHeight;
  fireEvent.change(input, { target: { value: "A longer draft\n".repeat(10) } });
  await expect.poll(() => scroll.clientHeight).toBeLessThan(oldHeight);
  await bottom(scroll);
  fireEvent.change(input, { target: { value: "A shorter draft" } });
  await expect.poll(() => scroll.clientHeight).toBe(oldHeight);
  await bottom(scroll);
  await nextPaint();

  // Disable Chromium's native anchor correction to exercise the app's own
  // one-pixel settle guard, which is needed on WebKit.
  scroll.style.overflowAnchor = "none";
  await nextPaint();
  const before = scroll.scrollTop;
  input.style.height = `${parseFloat(getComputedStyle(input).height) + 1}px`;
  expect(scroll.clientHeight).toBe(oldHeight - 1);
  await nextPaint();
  expect(scroll.scrollTop).toBe(before);

  move(scroll, 200);
  fireEvent.change(input, { target: { value: "A longer draft\n".repeat(10) } });
  await expect.poll(() => scroll.clientHeight).toBeLessThan(oldHeight - 1);
  await nextPaint();
  expect(scroll.scrollTop).toBe(200);
});

it.each(["no-preference", "reduce"])(
  "opens the mobile drawer in place and shields a second tap (%s)",
  async (motion) => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: motion }],
    });
    try {
      const { scroll } = await boot([], [ws, { ...ws, id: "other", name: "Other workspace" }]);
      move(scroll, 220);
      const geometry = () => {
        const { x, y, width, height } = scroll.getBoundingClientRect();
        return [x, y, width, height, scroll.scrollTop];
      };
      const before = geometry();
      fireEvent.click(get(".mobile-menu-btn"));
      const sidebar = get(".sidebar-open");
      expect(sidebar.getBoundingClientRect().left).toBe(0);
      expect(getComputedStyle(sidebar).animationName).toBe(
        motion === "reduce" ? "none" : "chrome-reveal",
      );
      expect(geometry()).toEqual(before);
      await nextPaint();
      expect(geometry()).toEqual(before);
      const target = [...document.querySelectorAll<HTMLElement>(".task-item")].find((item) =>
        item.textContent?.includes("Other workspace"),
      )!;
      const { x, y, width, height } = target.getBoundingClientRect();
      fireEvent.click(target);
      expect(sidebar.getBoundingClientRect().right).toBe(0);
      const shield = get(".sidebar-overlay.closing");
      expect(document.elementFromPoint(x + width / 2, y + height / 2)).toBe(shield);
      fireEvent.click(shield);
      expect(document.querySelector(".sidebar-open")).toBeNull();
      await expect.poll(() => document.querySelector(".sidebar-overlay")).toBeNull();
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  },
);

it("anchors a prepend that crosses into the windowed range after an earlier quote jump", async () => {
  const { scroll, receive, sock } = await boot([turn(18), turn(19), reply(20, "m19")], [ws], true);
  scroll.style.overflowAnchor = "none";
  fireEvent.click(get("#msg-m20 .forward-ref"));
  expect(document.activeElement?.id).toBe("msg-m19");
  await nextPaint();
  move(scroll, 40);
  expect(sock.frames().at(-1)).toMatchObject({
    type: "load_messages",
    before: history[0].timestamp,
  });
  const offset = () =>
    get("#msg-m0").getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  const before = offset();
  receive({
    type: "new_message",
    message: turn(99, { content: "New content below\n\n".repeat(20) }),
  });
  await nextPaint();
  expect(offset()).toBe(before);
  const older = Array.from({ length: 50 }, (_, i) => turn(i - 50));
  older.at(-1)!.content = `\`\`\`ts\nconst long = '${"abcdef".repeat(90)}';\n\`\`\``;
  receive({
    type: "workspace_messages",
    before: history[0].timestamp,
    messages: older,
    hasMore: true,
  });
  await nextPaint();
  expect(Math.abs(offset() - before)).toBeLessThanOrEqual(3);
  const code = get("#msg-m-1 pre");
  code.scrollLeft = 100;
  expect(code.scrollLeft).toBe(100);
  const inner = get("#msg-m-1 pre code");
  inner.scrollLeft = 100;
  expect(inner.scrollLeft).toBe(0);
  expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  expect(get("#msg-m-1").getAnimations({ subtree: true })).toEqual([]);
});

it.each([
  { width: 1280, theme: "light" },
  { width: 390, theme: "dark" },
])(
  "keeps a paged 350+ row reading stream bounded across reader interactions ($width, $theme)",
  async ({ width, theme }) => {
    const other = { ...ws, id: "other", name: "Other workspace" };
    const { scroll, sock, receive } = await mountTranscript([ws, other], width, 844);
    document.documentElement.dataset.theme = theme;
    scroll.style.overflowAnchor = "none";
    const summary = {
      kind: "tool_use",
      toolName: "Bash",
      toolUseId: "test",
      content: "**Bash**",
      bodyLength: 2000,
      resultLength: 2000,
      contentOffset: 0,
    };
    let messages = Array.from({ length: 415 }, (_, index) => {
      const i = index - 50;
      return i === 364
        ? reply(i, "m160")
        : i === 160
          ? turn(i, { detail: "summary", events: [summary], content: "**Readable** detail anchor" })
          : turn(i, {
              content: `Reply ${i}\n\n${"Variable-height reading text. ".repeat((index % 12) + 1)}`,
            });
    });
    const newestLimit = width < 768 ? 25 : 50;
    async function servePage(socket: FakeSocket, before?: number, since = 0) {
      const request = () =>
        socket
          .frames()
          .slice(since)
          .reverse()
          .find((frame) => frame.type === "load_messages" && frame.workspaceId === ws.id);
      const limit = before === undefined ? newestLimit : 50;
      await expect.poll(() => request()?.limit).toBe(limit);
      expect(request()?.before).toBe(before);
      const end =
        before === undefined ? messages.length : messages.findIndex((m) => m.timestamp === before);
      const start = Math.max(0, end - limit);
      act(() =>
        socket.receive({
          type: "workspace_messages",
          workspaceId: ws.id,
          before: before ?? null,
          messages: messages.slice(start, before === undefined ? end : end + 1),
          hasMore: start > 0,
        }),
      );
      await nextPaint();
      return messages[start];
    }
    const bounded = () =>
      expect(scroll.querySelectorAll("[data-transcript-row]").length).toBeLessThanOrEqual(45);
    const loaded = () => Number(get(".messages-content").dataset.loadedMessages);
    const y = (id: string) => rowOffset(scroll, get(`#msg-${id}`));
    // Exercise a resize before any scroll notification saves a reading position.
    const deferScroll = (event: Event) => event.stopImmediatePropagation();
    if (width >= 768) scroll.addEventListener("scroll", deferScroll, true);
    let oldest = await servePage(sock);
    await bottom(scroll);
    expect(loaded()).toBe(newestLimit);
    const latest = async () => {
      fireEvent.click(get(".jump-latest"));
      await bottom(scroll);
      expect(get("#msg-m364")).not.toBeNull();
    };
    if (width >= 768) {
      await page.viewport(920, 844);
      await nextPaint();
      expect(gap(scroll)).toBeLessThanOrEqual(1);
      await page.viewport(width, 844);
      await bottom(scroll);
      scroll.removeEventListener("scroll", deferScroll, true);
    }
    async function prepend(socket: FakeSocket) {
      const since = socket.frames().length;
      move(scroll, 0);
      const before = y(oldest.id);
      const previous = oldest;
      oldest = await servePage(socket, oldest.timestamp, since);
      expect(Math.abs(y(previous.id) - before)).toBeLessThanOrEqual(3);
      bounded();
    }
    for (let i = 0; i < 7; i++) await prepend(sock);
    expect(loaded()).toBe(newestLimit + 350);
    await latest();
    expect(get("#msg-m160")).toBeNull();
    const quote = get("#msg-m364 .forward-ref");
    quote.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(get("#msg-m160"));
    expectInView(scroll, get("#msg-m160"));
    bounded();

    const anchor = "m162";
    move(scroll, scroll.scrollTop + y(anchor) + 9);
    await nextPaint();
    const anchored = y(anchor);
    const steps = () => get<HTMLButtonElement>("#msg-m160 .step-header button");
    fireEvent.click(steps());
    expect(sock.frames()).toContainEqual(
      expect.objectContaining({ type: "load_message_details", messageId: "m160" }),
    );
    const events = [
      {
        ...summary,
        content: "**Bash**\n```bash\n" + "echo sample\n".repeat(50) + "```",
        toolResult: "result",
      },
    ];
    receive({ type: "message_details", messageId: "m160", events });
    await nextPaint();
    const expectAnchored = () => expect(Math.abs(y(anchor) - anchored)).toBeLessThanOrEqual(3);
    expectAnchored();
    const input = get<HTMLTextAreaElement>("textarea");
    const height = scroll.clientHeight;
    const headerY = steps().getBoundingClientRect().top;
    fireEvent.change(input, { target: { value: "A longer draft\n".repeat(10) } });
    await expect.poll(() => scroll.clientHeight).toBeLessThan(height);
    expect(steps().getBoundingClientRect().top).toBeCloseTo(headerY, 0);
    fireEvent.change(input, { target: { value: "" } });
    input.focus();
    const paragraph = get("#msg-m160 .message-content p");
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(scroll.contains(document.activeElement)).toBe(false);
    move(scroll, scroll.scrollHeight);
    await expect.poll(() => get("#msg-m162")).toBeNull();
    expect(get("#msg-m364")).not.toBeNull();
    expect(get("#msg-m160 .message-content p")).toBe(paragraph);
    expect(selection.getRangeAt(0)).toBe(range);
    expect(selection.toString()).toBe("Readable detail anchor");
    const clipboardData = new DataTransfer();
    fireEvent(
      paragraph,
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
    );
    expect(clipboardData.getData("text/plain")).toBe("**Readable** detail anchor");
    selection.removeAllRanges();

    // Close the open trace only after its row has unmounted and remounted.
    move(scroll, scroll.scrollTop * 0.75);
    await expect.poll(() => get("#msg-m160")).toBeNull();
    await latest();
    fireEvent.click(get("#msg-m364 .forward-ref"));
    await expect.poll(() => steps()?.getAttribute("aria-expanded")).toBe("true");
    move(scroll, scroll.scrollTop + y(anchor) - anchored);
    await nextPaint();
    fireEvent.click(steps());
    await nextPaint();
    expectAnchored();

    receive({ type: "message_removed", messageId: "m160" });
    messages = messages.filter((message) => message.id !== "m160");
    await nextPaint();
    expect(get("#msg-m160")).toBeNull();
    expect(get("#msg-m162").textContent).toContain("Reply 162");
    expectAnchored();

    for (const nextWidth of [width === 390 ? 1280 : 390, width]) {
      const before = get(".messages-content").clientWidth;
      await page.viewport(nextWidth, 844);
      await nextPaint();
      expect(get(".messages-content").clientWidth).not.toBe(before);
      expectAnchored();
    }

    chooseWorkspace(other.name);
    receive({
      workspaceId: other.id,
      type: "workspace_messages",
      messages: [turn(600)],
      hasMore: false,
    });
    expect(get(".messages")).toBe(scroll);
    const switchRequest = sock.frames().length;
    chooseWorkspace(ws.name);
    await servePage(sock, undefined, switchRequest);
    expect(get(".messages")).toBe(scroll);
    expectAnchored();
    fireEvent.change(input, { target: { value: "half a thought" } });
    input.setSelectionRange(4, 4);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => sock.drop());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const next = FakeSocket.instances.at(-1)!;
    expect(next).not.toBe(sock);
    connect(next, [ws, other]);
    vi.useRealTimers();
    await servePage(next);
    expectAnchored();
    expect(get("textarea")).toBe(input);
    expect(input.value).toBe("half a thought");
    expect(input.selectionStart).toBe(4);

    await latest();
    await prepend(next);
    expect(loaded()).toBe(messages.length);
    const first = get("[data-window-first] .message");
    const firstIndex = messages.findIndex((message) => `msg-${message.id}` === first.id);
    expect(firstIndex).toBeGreaterThan(0);
    const neighbor = `msg-${messages[firstIndex - 1].id}`;
    expect(get(`#${neighbor}`)).toBeNull(); // Must actually cross an unmounted edge.
    const edge = first.querySelector<HTMLButtonElement>(".btn-quote")!;
    edge.focus({ preventScroll: true });
    expect(document.activeElement).toBe(edge);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement?.closest(".message")?.id).toBe(neighbor);
    bounded();
  },
);

it("heals the shell without moving a reader, then can settle the transcript at the end", async () => {
  const { scroll } = await boot();
  move(scroll, 120);
  healViewport(get(".app"), scroll);
  await nextPaint();
  expect(scroll.scrollTop).toBe(120);
  expect(get(".app").getBoundingClientRect().height).toBe(window.innerHeight);
  settleScroller(scroll, true);
  expect(gap(scroll)).toBe(1);
  await nextPaint();
  expect(gap(scroll)).toBe(0);
});
