import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { App } from "../../src/App";
import { loadMath, MdBlock } from "../../src/chat/markdown";
import { MessageItem } from "../../src/chat/messages";
import type { AgentInfo, Message } from "../../src/state/useServer";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

const agent: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "A",
  color: "#528bff",
  isDefault: true,
};

function luminance(channels: Uint8ClampedArray): number {
  const [r, g, b] = Array.from(channels.slice(0, 3), (byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastOf(foreground: string, backgrounds: string[]): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const paint = (layers: string[]) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const color of layers) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
    }
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    expect(pixel[3], layers.join(" + ")).toBe(255);
    return luminance(pixel);
  };
  const bg = paint(backgrounds);
  const fg = paint([...backgrounds, foreground]);
  return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
}

function resolveColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

function resolveShadow(value: string): string {
  const probe = document.createElement("div");
  probe.style.boxShadow = value;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).boxShadow;
  probe.remove();
  return resolved;
}

const painted = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  FakeSocket.instances = [];
  delete document.documentElement.dataset.theme;
});

it.each(["light", "dark"])(
  "renders malformed KaTeX math with theme error color above 4.5:1 contrast (%s)",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(900, 600);
    await loadMath();
    const { container } = render(
      <div className="messages">
        <div className="message">
          <div className="message-body">
            <div className="message-content">
              <MdBlock>{"$$\\invalidcmd{$$"}</MdBlock>
            </div>
          </div>
        </div>
      </div>,
    );
    const err = await waitFor(() => {
      const node = container.querySelector<HTMLElement>(".katex-error");
      expect(node).not.toBeNull();
      return node!;
    });
    const fg = getComputedStyle(err).color;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-primary").trim();
    expect(fg).toBe(resolveColor("var(--error)"));
    expect(contrastOf(fg, [bg])).toBeGreaterThanOrEqual(4.5);
  },
);

it("uses <pre> as the single horizontal scroll container for highlighted code and keeps Copy reachable", async () => {
  await page.viewport(360, 640);
  const longCode = `\`\`\`ts\nconst longLine = "${"segment_".repeat(45)}";\n\`\`\``;
  const { container } = render(
    <div className="messages" style={{ width: 340 }}>
      <div className="message">
        <div className="message-body">
          <div className="message-content">
            <MdBlock>{longCode}</MdBlock>
          </div>
        </div>
      </div>
    </div>,
  );
  const pre = container.querySelector<HTMLElement>("pre")!;
  const code = container.querySelector<HTMLElement>("pre code.hljs")!;
  const copy = container.querySelector<HTMLElement>(".code-block .copy-btn")!;

  expect(getComputedStyle(pre).overflowX).toBe("auto");
  expect(getComputedStyle(code).overflowX).toBe("visible");
  expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth + 100);

  pre.scrollLeft = 140;
  expect(pre.scrollLeft).toBe(140);
  code.scrollLeft = 140;
  expect(code.scrollLeft).toBe(0);

  await page.elementLocator(container.querySelector(".code-block")!).hover();
  const copyRect = copy.getBoundingClientRect();
  const preRect = pre.getBoundingClientRect();
  expect(copyRect.right).toBeLessThanOrEqual(preRect.right);
  expect(copyRect.top).toBeGreaterThanOrEqual(preRect.top);
  expect(
    document.elementFromPoint(
      copyRect.left + copyRect.width / 2,
      copyRect.top + copyRect.height / 2,
    ),
  ).toBe(copy);
});

it("keeps leading @mention inline, stacks multi-block system messages, and scrolls long system code fences on narrow viewports", async () => {
  await page.viewport(390, 600);
  const mentionMsg: Message = {
    id: "u1",
    kind: "user",
    agentId: null,
    content: "@Alice please check this paragraph\n\nSecond paragraph below.",
    timestamp: 1,
    status: "done",
  };
  const mentionBlockMsg: Message = {
    id: "u2",
    kind: "user",
    agentId: null,
    content: "@Alice\n```ts\nconst x = 1;\n```",
    timestamp: 2,
    status: "done",
  };
  const longSystemCode = `const systemDiagnostic = "${"segment_".repeat(24)}";`;
  const systemMsg: Message = {
    id: "s1",
    kind: "system",
    agentId: null,
    content: `avatars/alice.png **Alice** updated the plan.\n\nSecond system paragraph.\n\n\`\`\`ts\n${longSystemCode}\n\`\`\`\n\n- First item\n- Second item`,
    timestamp: 3,
    status: "done",
  };
  const { container } = render(
    <div className="messages">
      <MessageItem msg={mentionMsg} agents={[agent]} />
      <MessageItem msg={mentionBlockMsg} agents={[agent]} />
      <MessageItem msg={systemMsg} agents={[agent]} />
    </div>,
  );

  // Leading @mention shares line 1 with opening paragraph; second paragraph stacks below.
  const u1 = container.querySelector<HTMLElement>("#msg-u1")!;
  const pill = u1.querySelector<HTMLElement>(".mention-pill")!;
  const [p1, p2] = [...u1.querySelectorAll<HTMLElement>(".message-content p")];
  const p1Range = document.createRange();
  p1Range.selectNodeContents(p1);
  const p1FirstLine = p1Range.getClientRects()[0];
  expect(Math.abs(pill.getBoundingClientRect().top - p1FirstLine.top)).toBeLessThanOrEqual(4);
  expect(p1FirstLine.left).toBeGreaterThanOrEqual(pill.getBoundingClientRect().right);
  expect(p2.getBoundingClientRect().top).toBeGreaterThanOrEqual(p1FirstLine.bottom);

  // @mention followed by a code block sits cleanly above the code block.
  const u2 = container.querySelector<HTMLElement>("#msg-u2")!;
  const u2Pill = u2.querySelector<HTMLElement>(".mention-pill")!;
  const u2Pre = u2.querySelector<HTMLElement>("pre")!;
  expect(u2Pre.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    u2Pill.getBoundingClientRect().bottom,
  );

  // Avatar-prefixed multi-block system message stacks vertically and scrolls long code inside <pre>.
  const sys = container.querySelector<HTMLElement>(".system-message")!;
  const sysAvatar = sys.querySelector<HTMLElement>(".system-avatar")!;
  const sysBody = sys.querySelector<HTMLElement>(".system-message-body")!;
  const [sp1, sp2] = [...sysBody.querySelectorAll<HTMLElement>("p")];
  const sysPre = sysBody.querySelector<HTMLElement>("pre")!;
  const sysCode = sysPre.querySelector<HTMLElement>("code")!;
  const list = sysBody.querySelector<HTMLElement>("ul")!;

  expect(sysAvatar).toBeTruthy();
  expect(sysBody.getBoundingClientRect().left).toBeGreaterThanOrEqual(
    sysAvatar.getBoundingClientRect().right,
  );
  expect(sp2.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    sp1.getBoundingClientRect().bottom,
  );
  expect(sysPre.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    sp2.getBoundingClientRect().bottom,
  );
  expect(list.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    sysPre.getBoundingClientRect().bottom,
  );
  expect(sys.scrollWidth).toBeLessThanOrEqual(sys.clientWidth + 1);
  expect(sysPre.getBoundingClientRect().right).toBeLessThanOrEqual(390);
  expect(getComputedStyle(sysPre).overflowX).toBe("auto");
  expect(getComputedStyle(sysCode).overflowX).toBe("visible");
  expect(sysPre.scrollWidth).toBeGreaterThan(sysPre.clientWidth);
  sysPre.scrollLeft = 80;
  expect(sysPre.scrollLeft).toBeGreaterThan(0);
  sysCode.scrollLeft = 80;
  expect(sysCode.scrollLeft).toBe(0);
});

it.each(["light", "dark"])(
  "renders .avatar-from without .avatar-user ring and styles .delivery-outcome-unknown with consistent warning contrast (%s)",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    for (const width of [1280, 390]) {
      await page.viewport(width, 720);
      const { container, unmount } = render(
        <div className="messages">
          <MessageItem
            msg={{
              id: "from-msg",
              kind: "user",
              agentId: null,
              from: { workspaceId: "lead", role: "lead", name: "Lead" },
              content: "Start the task.",
              timestamp: 1,
              status: "done",
            }}
            agents={[agent]}
          />
          <MessageItem
            msg={{
              id: "unknown-msg",
              kind: "user",
              agentId: null,
              content: "Retry carefully.",
              timestamp: 2,
              status: "outcome_unknown",
            }}
            agents={[agent]}
          />
        </div>,
      );

      // .avatar-from does not inherit .avatar-user's accent ring, keeps 14px glyph, and resizes on mobile.
      const avatarFrom = container.querySelector<HTMLElement>(".avatar-from")!;
      expect(avatarFrom.classList.contains("avatar-user")).toBe(false);
      expect(getComputedStyle(avatarFrom).boxShadow).toBe("none");
      expect(getComputedStyle(avatarFrom).borderTopWidth).toBe("1px");
      expect(getComputedStyle(avatarFrom).fontSize).toBe("14px");
      const expectedSize = width === 390 ? 28 : 32;
      expect(avatarFrom.getBoundingClientRect().width).toBe(expectedSize);
      expect(avatarFrom.getBoundingClientRect().height).toBe(expectedSize);

      // .delivery-outcome-unknown uses consistent warning emphasis (not mixed warning + error) with >=4.5:1 contrast.
      const alert = container.querySelector<HTMLElement>(".delivery-outcome-unknown")!;
      const strong = alert.querySelector<HTMLElement>("strong")!;
      const alertStyle = getComputedStyle(alert);
      const strongStyle = getComputedStyle(strong);
      const bgPrimary = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-primary")
        .trim();
      expect(strongStyle.color).toBe(resolveColor("var(--warning)"));
      expect(strongStyle.color).not.toBe(resolveColor("var(--error)"));
      expect(alertStyle.color).toBe(resolveColor("var(--text-body)"));
      expect(
        contrastOf(strongStyle.color, [bgPrimary, alertStyle.backgroundColor]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastOf(alertStyle.color, [bgPrimary, alertStyle.backgroundColor]),
      ).toBeGreaterThanOrEqual(4.5);
      unmount();
    }
  },
);

it.each(["light", "dark"])(
  "renders .jump-latest with themed shadow, distinct hover/focus contrast, and scroll-away/incoming activation (%s)",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(1280, 620);
    vi.stubGlobal("WebSocket", FakeSocket);
    localStorage.setItem("activeWsId", "w");
    const root = document.createElement("div");
    root.id = "root";
    root.style.cssText = "position:fixed; inset:0; height:100dvh";
    document.body.append(root);
    const view = render(<App />, { container: root });
    const sock = FakeSocket.instances.at(-1)!;
    const history: Message[] = Array.from({ length: 24 }, (_, i) => ({
      id: `m-${i}`,
      kind: "agent",
      agentId: agent.id,
      status: "done",
      timestamp: i + 1,
      content: `Message ${i}\n\n${"Transcript body line for scrolling. ".repeat(8)}`,
    }));
    act(() => {
      sock.open();
      sock.receive({
        type: "init",
        workspaces: [
          {
            id: "w",
            name: "Chat",
            project: "repo",
            cwd: "/repo",
            hostId: "local",
            agents: [agent],
            messages: [],
            createdAt: 1,
          },
        ],
        config: { presets: [], models: [], commands: [], hosts: {} },
        hosts: [],
      });
      sock.receive({
        type: "workspace_messages",
        workspaceId: "w",
        before: null,
        hasMore: false,
        messages: history,
      });
    });
    await painted();

    const scroller = root.querySelector<HTMLElement>(".messages")!;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await painted();

    const jumpBtn = view.getByRole("button", { name: /Jump to latest/ });
    const restStyle = getComputedStyle(jumpBtn);
    const restBg = restStyle.backgroundColor;
    const restBorder = restStyle.borderTopColor;
    expect(restStyle.boxShadow).toBe(resolveShadow("var(--shadow-small)"));
    expect(restStyle.boxShadow).not.toContain(resolveColor("var(--border-strong)"));
    expect(contrastOf(restStyle.color, [restBg])).toBeGreaterThanOrEqual(4.5);

    // Hover changes surface/border/color while maintaining WCAG >=4.5:1 contrast.
    await page.elementLocator(jumpBtn).hover();
    await expect
      .poll(() => getComputedStyle(jumpBtn).borderTopColor)
      .toBe(resolveColor("var(--accent)"));
    await expect
      .poll(() => getComputedStyle(jumpBtn).color)
      .toBe(resolveColor("var(--accent-text)"));
    await expect.poll(() => getComputedStyle(jumpBtn).backgroundColor).not.toBe(restBg);
    const hoverStyle = getComputedStyle(jumpBtn);
    const hoverBg = hoverStyle.backgroundColor;
    expect(hoverStyle.borderTopColor).not.toBe(restBorder);
    expect(contrastOf(hoverStyle.color, [hoverBg])).toBeGreaterThanOrEqual(4.5);

    // Pressed (:active) state deepens the surface separately from hover while keeping >=4.5:1 contrast.
    const btnRect = jumpBtn.getBoundingClientRect();
    const cx = btnRect.left + btnRect.width / 2;
    const cy = btnRect.top + btnRect.height / 2;
    const session = cdp();
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: cx,
      y: cy,
      button: "left",
      clickCount: 1,
    });
    await expect.poll(() => getComputedStyle(jumpBtn).backgroundColor).not.toBe(hoverBg);
    const activeStyle = getComputedStyle(jumpBtn);
    expect(activeStyle.backgroundColor).not.toBe(restBg);
    expect(contrastOf(activeStyle.color, [activeStyle.backgroundColor])).toBeGreaterThanOrEqual(
      4.5,
    );
    // Release pointer away from the button so hover clears and activation has not happened yet.
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 10,
      y: 10,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 10,
      y: 10,
      button: "left",
      clickCount: 1,
    });
    await expect.poll(() => getComputedStyle(jumpBtn).backgroundColor).toBe(restBg);
    await expect.poll(() => getComputedStyle(jumpBtn).borderTopColor).toBe(restBorder);

    // Incoming message while scrolled away keeps Jump to latest visible.
    act(() => {
      sock.receive({
        type: "new_message",
        workspaceId: "w",
        message: {
          id: "m-24",
          kind: "agent",
          agentId: agent.id,
          status: "done",
          timestamp: 25,
          content: "Fresh incoming reply at the bottom.",
        },
      });
    });
    await painted();
    expect(view.getByRole("button", { name: /Jump to latest/ })).toBeTruthy();

    // Reach Jump to latest by keyboard with pointer away and assert visible :focus-visible outline.
    const composer = root.querySelector<HTMLElement>(".input-row textarea, .input-row button")!;
    composer.focus();
    for (let i = 0; i < 6 && document.activeElement !== jumpBtn; i++) {
      await userEvent.tab({ shift: true });
    }
    expect(document.activeElement).toBe(jumpBtn);
    expect(jumpBtn.matches(":focus-visible")).toBe(true);
    await expect
      .poll(() => getComputedStyle(jumpBtn).borderTopColor)
      .toBe(resolveColor("var(--focus-ring)"));
    const focusStyle = getComputedStyle(jumpBtn);
    expect(focusStyle.outlineStyle).toBe("solid");
    expect(focusStyle.outlineWidth).toBe("2px");
    expect(focusStyle.outlineColor).toBe(resolveColor("var(--focus-ring)"));

    // Keyboard Enter activates Jump to latest, removes the pill, and reveals the newly arrived message.
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => view.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
    await painted();
    const incomingEl = root.querySelector<HTMLElement>("#msg-m-24")!;
    const scrollerRect = scroller.getBoundingClientRect();
    const incomingRect = incomingEl.getBoundingClientRect();
    expect(incomingRect.top).toBeGreaterThanOrEqual(scrollerRect.top - 1);
    expect(incomingRect.bottom).toBeLessThanOrEqual(scrollerRect.bottom + 1);
  },
);
