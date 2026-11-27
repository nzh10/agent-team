import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { EventItem, MessageItem } from "../src/chat/messages";
import { MdBlock } from "../src/chat/markdown";
import { FileOpenContext } from "../src/chat/fileRef";
import type { Message, StreamEvent } from "../src/state/useServer";
import { agent, message as makeMessage } from "./helpers/fixtures";

const agents = [agent("a1", { name: "Alice", model: "m", avatar: "🤖" })];

const reply = [
  "## Done",
  "",
  "See `service/src/history_db/a_b.ts` and foo_bar/baz.cpp, or C:\\Users\\ykiko\\x_y.txt.",
  "",
  "- item one",
  "",
  "```bash",
  "cd /tmp/foo_bar && ls *.cpp",
  "echo [x]",
  "```",
].join("\n");

const message = (over: Partial<Message> = {}) =>
  makeMessage("m1", {
    agentId: "a1",
    content: reply,
    timestamp: 0,
    events: [],
    ...over,
  });

function select(range: Range) {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function rangeOver(start: Node, startOffset: number, end: Node, endOffset: number): Range {
  const r = document.createRange();
  r.setStart(start, startOffset);
  r.setEnd(end, endOffset);
  return r;
}

// What a copy from the selection puts on the clipboard as text, or null
// when the handler leaves it to the browser.
function copied(target: Element): string | null {
  let text: string | null = null;
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { setData: (_type: string, value: string) => (text = value) },
  });
  target.dispatchEvent(ev);
  return text;
}

function textNodeOf(el: Element): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
  Reflect.deleteProperty(document, "execCommand");
});

describe("copying a selection from a reply", () => {
  const renderReply = (fields?: Partial<Message>) =>
    render(<MessageItem msg={message(fields)} agents={agents} />).container;

  it("copies paths in prose as they read, without markdown escapes", () => {
    const c = renderReply();
    const p = [...c.querySelectorAll(".message-content p")].find((e) =>
      e.textContent.startsWith("See"),
    )!;
    const r = document.createRange();
    r.selectNodeContents(p);
    select(r);
    expect(copied(p)).toBe(
      "See `service/src/history_db/a_b.ts` and foo_bar/baz.cpp, or C:\\Users\\ykiko\\x_y.txt.",
    );
  });

  it("copies part of a path in inline code as plain text", () => {
    const c = renderReply();
    const code = c.querySelector(".message-content p code")!;
    const text = textNodeOf(code);
    select(rangeOver(text, 8, text, text.length));
    expect(copied(code)).toBe("src/history_db/a_b.ts");
  });

  it("copies a whole inline code as its text, without backticks", () => {
    const c = renderReply();
    const code = c.querySelector(".message-content p code")!;
    const r = document.createRange();
    r.selectNode(code);
    select(r);
    expect(copied(code)).toBe("service/src/history_db/a_b.ts");
  });

  it("copies lines selected in a code block as they are, but the last line break", () => {
    const c = renderReply();
    const code = c.querySelector(".message-content pre code")!;
    select(rangeOver(code, 0, code, code.childNodes.length));
    expect(copied(code)).toBe("cd /tmp/foo_bar && ls *.cpp\necho [x]");
  });

  it("still copies a whole reply as markdown: heading, list and fence", () => {
    const c = renderReply();
    const content = c.querySelector(".message-content")!;
    // Give the icon-only button a marker so omitting UI chrome is observable.
    content.querySelector(".copy-btn")!.append("Copy");
    const r = document.createRange();
    r.selectNodeContents(content);
    select(r);
    const md = copied(content)!;
    expect(md).toContain("## Done");
    expect(md).toMatch(/^[-*] +item one$/m);
    expect(md).toContain("```bash\ncd /tmp/foo_bar && ls *.cpp\necho [x]\n```");
    expect(md).not.toContain("Copy");
  });

  it("omits message actions from a selection across replies", () => {
    const { container } = render(
      <>
        <MessageItem msg={message({ content: "first" })} agents={agents} onQuote={vi.fn()} />
        <MessageItem
          msg={message({ id: "m2", content: "second" })}
          agents={agents}
          onQuote={vi.fn()}
        />
      </>,
    );
    const [first, last] = [...container.querySelectorAll(".message-content p")].map(textNodeOf);
    select(rangeOver(first, 0, last, last.length));
    const md = copied(first.parentElement!);
    expect(md).toMatch(/^first[\s\S]*second$/);
    expect(md).not.toContain("↩");
  });

  it("copies a code block selected whole as its code", () => {
    const c = renderReply();
    const pre = c.querySelector(".message-content pre")!;
    const r = document.createRange();
    r.setStartBefore(pre);
    r.setEndAfter(pre);
    select(r);
    expect(copied(pre)).toBe("cd /tmp/foo_bar && ls *.cpp\necho [x]");
  });

  it("copies a code block's line taken by a triple click without its fence", () => {
    const c = renderReply({ content: "```bash\nnpm test\n```\n\nafter" });
    const code = c.querySelector(".message-content pre code")!;
    const after = [...c.querySelectorAll(".message-content p")].at(-1)!;
    select(rangeOver(textNodeOf(code), 0, after, 0));
    expect(copied(code)).toBe("npm test");
  });

  it("copies a path taken by a triple click as the path, the next one starting with code", () => {
    const c = renderReply({ content: "`src/a_b.ts`\n\n`next.ts` follows" });
    const [first, next] = c.querySelectorAll(".message-content p code");
    select(rangeOver(textNodeOf(first), 0, textNodeOf(next), 0));
    expect(copied(first)).toBe("src/a_b.ts");
  });

  it("copies a code block's last line taken by a triple click, a tool step after it", () => {
    const content = "```bash\nnpm test\n```\n\nafter";
    const read: StreamEvent = {
      kind: "tool_use",
      toolName: "Read",
      content: "**Read** `a.ts`",
      contentOffset: content.indexOf("after"),
    };
    const c = renderReply({ content, events: [read] });
    const code = c.querySelector(".message-content pre code")!;
    const after = [...c.querySelectorAll(".message-content p")].at(-1)!;
    expect(c.querySelector(".step-header")).not.toBeNull();
    select(rangeOver(textNodeOf(code), 0, textNodeOf(after), 0));
    expect(copied(code)).toBe("npm test");
  });

  it("copies a path in a link as the path", () => {
    const c = renderReply({ content: "[`src/a_b.ts`](src/a_b.ts)" });
    const p = c.querySelector(".message-content p")!;
    const r = document.createRange();
    r.selectNodeContents(p);
    select(r);
    expect(copied(p)).toBe("src/a_b.ts");
  });

  it("leaves table cells Firefox selected one by one to the browser", () => {
    const c = renderReply({ content: "| a | b |\n|---|---|\n| x_y | 2 |" });
    const cells = [...c.querySelectorAll(".message-content td")].map((td) => {
      const r = document.createRange();
      r.selectNode(td);
      return r;
    });
    vi.stubGlobal("getSelection", () => ({
      isCollapsed: false,
      rangeCount: cells.length,
      getRangeAt: (i: number) => cells[i],
    }));
    expect(copied(c.querySelector("td")!)).toBeNull();
  });

  it("fences a code block holding a fence of its own with a longer one", () => {
    const c = renderReply({ content: "Write:\n\n````md\n```ts\nx\n```\n````" });
    const content = c.querySelector(".message-content")!;
    const r = document.createRange();
    r.selectNodeContents(content);
    select(r);
    expect(copied(content)).toBe("Write:\n\n````md\n```ts\nx\n```\n````");
  });

  it("copies all of a selection Firefox splits around a Copy button", () => {
    const c = renderReply({ content: "intro\n\n```\nls\n```\n\noutro" });
    const content = c.querySelector(".message-content")!;
    // Split around the button, the code block's first child.
    const block = content.querySelector(".code-block")!;
    const before = rangeOver(content, 0, block, 0);
    const after = document.createRange();
    after.setStart(block, 1);
    after.setEndAfter(content.lastChild!);
    vi.stubGlobal("getSelection", () => ({
      isCollapsed: false,
      rangeCount: 2,
      getRangeAt: (i: number) => [before, after][i],
    }));
    expect(copied(content)).toBe("intro\n\n```\nls\n```\n\noutro");
  });

  it("copies a command selected in a tool call as it is", () => {
    const bash: StreamEvent = {
      kind: "tool_use",
      toolName: "Bash",
      content: "**Bash**\n```bash\nrm -rf build_dir/*\nnpm test -- --filter=a_b\n```",
      contentOffset: reply.length,
    };
    const c = renderReply({ events: [bash] });
    fireEvent.click(c.querySelector(".step-header")!);
    const code = c.querySelector(".event-content pre code")!;
    select(rangeOver(code, 0, code, code.childNodes.length));
    expect(copied(code)).toBe("rm -rf build_dir/*\nnpm test -- --filter=a_b");
  });

  it("copies a tool's path selected in its block as the path", () => {
    const read: StreamEvent = {
      kind: "tool_use",
      toolName: "Read",
      content: "**Read** `/home/u/snap_test/a_b.ts`",
      contentOffset: reply.length,
    };
    const c = renderReply({ events: [read] });
    fireEvent.click(c.querySelector(".step-header")!);
    const line = c.querySelector(".event-summary-line")!;
    const r = document.createRange();
    r.selectNodeContents(line);
    select(r);
    expect(copied(line)).toBe("/home/u/snap_test/a_b.ts");
  });
});

describe("selecting a file reference", () => {
  const renderRef = (open: (ref: string) => void) =>
    render(
      <FileOpenContext.Provider value={open}>
        <MdBlock>{"See `src/a_b.ts`."}</MdBlock>
      </FileOpenContext.Provider>,
    ).container.querySelector("code.file-ref")!;

  // A drag from x = 0 to x = 40, the selection made on the way.
  function drag(ref: Element, makeSelection: () => void) {
    fireEvent.mouseDown(ref, { clientX: 0, clientY: 0 });
    makeSelection();
    fireEvent.click(ref, { clientX: 40, clientY: 0 });
  }

  it("does not open the file when a drag selecting the path ends in a click", () => {
    const open = vi.fn();
    const ref = renderRef(open);
    const text = textNodeOf(ref);
    drag(ref, () => select(rangeOver(text, 4, text, text.length)));
    // Again, over a part of what is selected.
    drag(ref, () => select(rangeOver(text, 0, text, 4)));
    // Backwards, past its start.
    const before = textNodeOf(ref.parentElement!);
    drag(ref, () => select(rangeOver(before, 2, text, text.length)));
    expect(open).not.toHaveBeenCalled();
  });

  it("opens it on a click, a selected path too", () => {
    const open = vi.fn();
    const ref = renderRef(open);
    fireEvent.mouseDown(ref, { clientX: 5, clientY: 5 });
    fireEvent.click(ref, { clientX: 5, clientY: 5 });
    expect(open).toHaveBeenCalledTimes(1);
    // The browser clears the selection only after the click.
    const text = textNodeOf(ref);
    select(rangeOver(text, 4, text, text.length));
    fireEvent.mouseDown(ref, { clientX: 5, clientY: 5 });
    fireEvent.click(ref, { clientX: 6, clientY: 5 });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith("src/a_b.ts");
  });
});

// Over plain http (a phone on the LAN) navigator.clipboard does not exist;
// in VS Code's browser it may refuse to write.
describe("Copy buttons", () => {
  // execCommand("copy") copies what is selected in the focused field.
  function stubExecCommand() {
    const copiedTexts: string[] = [];
    const exec = vi.fn((cmd: string) => {
      const el = document.activeElement;
      if (cmd !== "copy" || !(el instanceof HTMLTextAreaElement)) return false;
      copiedTexts.push(el.value.slice(el.selectionStart, el.selectionEnd));
      return true;
    });
    document.execCommand = exec;
    return copiedTexts;
  }

  async function click(button: Element) {
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
  }

  it.each<Partial<Message>>([
    { status: "streaming" },
    { kind: "user", status: "queued" },
    { kind: "user", status: "starting" },
    { kind: "user", status: "dispatching" },
    { content: " \n" },
    { kind: "system" },
  ])("does not offer message copy for %j", (props) => {
    const { queryByRole } = render(<MessageItem msg={message(props)} agents={agents} />);
    expect(queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  it.each(["agent", "user"] as const)("copies raw text from a compact %s message", async (kind) => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { getByRole } = render(<MessageItem msg={message({ kind })} agents={agents} compact />);
    await click(getByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenCalledWith(reply);
    expect(getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("copies a code block without the clipboard API and clears feedback on unmount", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const texts = stubExecCommand();
    const { container, unmount } = render(<MdBlock>{"```sh\nls foo_bar/\n```"}</MdBlock>);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const button = container.querySelector(".copy-btn")!;
    expect(button.parentElement!.className).toBe("code-block");
    expect(button.nextElementSibling!.tagName).toBe("PRE");
    expect(container.querySelector("pre .copy-btn")).toBeNull();
    await click(button);
    expect(texts).toEqual(["ls foo_bar/"]);
    expect(button.getAttribute("aria-label")).toBe("Copied");
    expect(document.querySelector("textarea")).toBeNull();
    const feedback = timer.mock.results[timer.mock.calls.findIndex(([, delay]) => delay === 1500)];
    const clear = vi.spyOn(globalThis, "clearTimeout");
    unmount();
    expect(clear).toHaveBeenCalledWith(feedback.value);
  });

  it("falls back when the clipboard API refuses", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: () => Promise.reject(new Error("not allowed")) },
    });
    const texts = stubExecCommand();
    const { container } = render(<MdBlock>{"```\nx\n```"}</MdBlock>);
    await click(container.querySelector(".copy-btn")!);
    expect(texts).toEqual(["x"]);
  });

  it("says nothing was copied when neither way works", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    document.execCommand = vi.fn(() => false);
    const { container } = render(<MdBlock>{"```\nx\n```"}</MdBlock>);
    const button = container.querySelector(".copy-btn")!;
    await click(button);
    expect(button.getAttribute("aria-label")).toBe("Copy");
  });

  it("puts the focus back where it was", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    stubExecCommand();
    const { container } = render(
      <>
        <textarea defaultValue="draft" />
        <MdBlock>{"```\nx\n```"}</MdBlock>
      </>,
    );
    const draft = container.querySelector("textarea")!;
    draft.focus();
    await click(container.querySelector(".copy-btn")!);
    expect(document.activeElement).toBe(draft);
  });

  it("copies a tool's path or pattern from its block, as the block shows it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container } = render(
      <>
        <EventItem
          ev={{ kind: "tool_use", toolName: "Read", content: "**Read** `/home/u/a_b.ts`" }}
        />
        <EventItem
          ev={{ kind: "tool_use", toolName: "Grep", content: "**Grep** `foo_bar` in `src/`" }}
        />
      </>,
    );
    const [read, grep] = container.querySelectorAll(".event-summary-line .copy-btn");
    await click(read);
    expect(writeText).toHaveBeenLastCalledWith("/home/u/a_b.ts");
    expect(read.getAttribute("aria-label")).toBe("Copied");
    await click(grep);
    expect(writeText).toHaveBeenLastCalledWith("foo_bar in src/");
  });

  it("offers a copy of a path a summary page kept whole", () => {
    const { container } = render(
      <EventItem
        ev={{ kind: "tool_use", toolName: "Read", content: "**Read** `/a/b.ts`", bodyLength: 18 }}
        onLoadDetails={() => {}}
      />,
    );
    expect(container.querySelector(".event-summary-line .copy-btn")).not.toBeNull();
  });

  it("offers no copy of a path a summary page cut short", () => {
    const cut = "**Read** `/" + "a".repeat(190) + "…";
    const { container } = render(
      <EventItem
        ev={{ kind: "tool_use", toolName: "Read", content: cut, bodyLength: 260 }}
        onLoadDetails={() => {}}
      />,
    );
    expect(container.querySelector(".event-summary-line code")).not.toBeNull();
    expect(container.querySelector(".event-summary-line .copy-btn")).toBeNull();
  });

  it("copies a result that came on its own", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container, getByRole } = render(
      <EventItem ev={{ kind: "tool_result", content: "a_b.ts\r\n" }} />,
    );
    fireEvent.click(getByRole("button", { name: "Show · 8 chars" }));
    await click(container.querySelector(".event-result .copy-btn")!);
    expect(writeText).toHaveBeenCalledWith("a_b.ts");
  });
});
