import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import {
  FilesPanel,
  languageFor,
  type CodeQuote,
  type FileRoot,
  type FileView,
} from "../src/panels/FilesPanel";
import { INLINE_IMAGE_LIMIT } from "../src/panels/ImagePreview";
import { FilePreview } from "../src/project/NotesView";
import { fileRoots } from "../src/panels/scope";
import { autoPanelWidth } from "../src/panels/SidePanel";
import { FileOpenContext, linkFileRef, parseFileRef, splitFileRef } from "../src/chat/fileRef";
import { MdBlock } from "../src/chat/markdown";
import type { Workspace } from "../src/state/useServer";
import { deferred } from "./helpers/deferred";

function stubFileViews(
  find: (path: string) => FileView | { error: string; status: number } | undefined,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const path = new URLSearchParams(url.split("?")[1]).get("path")!;
      const view = find(path) ?? { error: "No such file or directory", status: 404 };
      const status = "status" in view ? view.status : 200;
      return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(view) });
    }),
  );
}

describe("parseFileRef", () => {
  it("reads paths with lines and ranges", () => {
    expect(parseFileRef("src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(parseFileRef("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseFileRef("src/a.ts:12-20")).toEqual({ path: "src/a.ts", line: 12, endLine: 20 });
    expect(parseFileRef("src/a.ts:12:5")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseFileRef("a.cpp#L3-L9")).toEqual({ path: "a.cpp", line: 3, endLine: 9 });
    expect(parseFileRef("/tmp/report")).toEqual({ path: "/tmp/report" });
    expect(parseFileRef("~/notes/")).toEqual({ path: "~/notes/" });
    expect(parseFileRef("README.md")).toEqual({ path: "README.md" });
  });

  it("reads Windows drive and relative backslash paths", () => {
    expect(parseFileRef("C:\\Users\\me\\Desktop\\a.ts")).toEqual({
      path: "C:\\Users\\me\\Desktop\\a.ts",
    });
    expect(parseFileRef("C:\\Users\\me\\Desktop\\a.ts:12")).toEqual({
      path: "C:\\Users\\me\\Desktop\\a.ts",
      line: 12,
    });
    expect(parseFileRef("C:/Users/me/Desktop/a.ts#L3-L9")).toEqual({
      path: "C:/Users/me/Desktop/a.ts",
      line: 3,
      endLine: 9,
    });
    expect(parseFileRef("src\\a.ts:12")).toEqual({ path: "src\\a.ts", line: 12 });
  });

  it("does not take code or prose for a file", () => {
    // An extension alone (".cpp") names a kind of file, not one.
    for (const s of [
      "ws.send",
      "true/false",
      "npm run build",
      "https://x.com/a.ts",
      "",
      ".cpp",
      ".cfg",
    ]) {
      expect(parseFileRef(s), s).toBeNull();
    }
  });

  it("does not take commands, routes, patterns, escapes, or sites for a file", () => {
    for (const s of [
      "/compact",
      "/model",
      "/\\d+/",
      "src/*.ts",
      "foo\\.ts",
      "\\a.ts",
      "foo\\",
      "example.com/index.html",
    ]) {
      expect(parseFileRef(s), s).toBeNull();
    }
  });

  it("knows files by name, line anchors without an L, and drops other anchors", () => {
    expect(parseFileRef(".gitignore")).toEqual({ path: ".gitignore" });
    expect(parseFileRef("Makefile:3")).toEqual({ path: "Makefile", line: 3 });
    expect(parseFileRef("docker/Dockerfile")).toEqual({ path: "docker/Dockerfile" });
    expect(parseFileRef("src/a.ts#12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseFileRef("docs/guide.md#setup")).toEqual({ path: "docs/guide.md" });
    expect(parseFileRef("/api/file")).toEqual({ path: "/api/file" });
  });

  it("splits line suffixes from Windows and spaced link targets", () => {
    expect(splitFileRef("C:/Users/John Doe/Desktop/report.md#L12-L20")).toEqual({
      path: "C:/Users/John Doe/Desktop/report.md",
      line: 12,
      endLine: 20,
    });
    expect(splitFileRef("C:\\Users\\John Doe\\Desktop\\report.md:42")).toEqual({
      path: "C:\\Users\\John Doe\\Desktop\\report.md",
      line: 42,
    });
    expect(splitFileRef("my file.md")).toEqual({ path: "my file.md" });
  });

  it("accepts Windows link hrefs and rejects unknown URL schemes", () => {
    expect(linkFileRef("C:/Users/me/Desktop/report.md")).toBe("C:/Users/me/Desktop/report.md");
    expect(linkFileRef("C:\\Users\\me\\Desktop\\report.md:12")).toBe(
      "C:\\Users\\me\\Desktop\\report.md:12",
    );
    expect(linkFileRef("file:///C:/Users/me/Desktop/report.md#L3")).toBe(
      "C:/Users/me/Desktop/report.md#L3",
    );
    expect(linkFileRef("file:///c%3A/Users/me/Desktop/report.md")).toBe(
      "c:/Users/me/Desktop/report.md",
    );
    expect(linkFileRef("file://C:/Users/me/Desktop/report.md")).toBe(
      "C:/Users/me/Desktop/report.md",
    );
    expect(linkFileRef("file://localhost/C:/Users/me/Desktop/report.md")).toBe(
      "C:/Users/me/Desktop/report.md",
    );
    expect(linkFileRef("/C:/Users/me/Desktop/report.md")).toBe("C:/Users/me/Desktop/report.md");
    expect(linkFileRef("javascript:alert(1)")).toBeNull();
    expect(linkFileRef("data:text/html,hi")).toBeNull();
    expect(linkFileRef("C:relative.txt")).toBeNull();
  });
});

describe("languageFor", () => {
  it("maps file names to highlighter languages", () => {
    expect(languageFor("/a/b.tsx")).toBe("typescript");
    expect(languageFor("C:\\Users\\me\\Makefile")).toBe("makefile");
    expect(languageFor("x/Makefile")).toBe("makefile");
    expect(languageFor("CMakeLists.txt")).toBeNull();
    expect(languageFor("notes.MD")).toBe("markdown");
  });
});

describe("FilesPanel", () => {
  let views: Record<string, FileView | { error: string; status: number }>;
  const requested: string[] = [];

  beforeEach(() => {
    requested.length = 0;
    stubFileViews((path) => {
      requested.push(path);
      return views[path];
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    // The tests set their own on the document, over its prototype's.
    Reflect.deleteProperty(document, "execCommand");
  });

  const open = (path: string, line?: number, endLine?: number, roots: FileRoot[] = []) =>
    render(<FilesPanel wsId="w1" target={{ path, line, endLine }} roots={roots} />);

  it("reads a note's paths as the board does: notes/, ./ from the note, the rest from the session", async () => {
    const note = (path: string, content: string, ref?: string): FileView => ({
      kind: "text",
      path,
      size: content.length,
      content,
      truncated: false,
      ...(ref && { ref }),
    });
    views = {
      "notes/plan.md": note(
        "/p/notes/plan.md",
        "See `notes/rules.md`, `./steps.md` and `service/src/http.ts`.",
        "notes/plan.md",
      ),
      "docs/guide.md": note("/w/docs/guide.md", "See `notes/rules.md`."),
    };
    const follow = async (file: string, i: number) => {
      const { container, unmount } = open(file);
      await waitFor(() =>
        expect(container.querySelector(".file-markdown .file-ref")).not.toBeNull(),
      );
      fireEvent.click(container.querySelectorAll(".file-markdown .file-ref")[i]);
      await waitFor(() => expect(requested.at(-1)).not.toBe(file));
      unmount();
      return requested.at(-1);
    };
    expect(await follow("notes/plan.md", 0)).toBe("/p/notes/rules.md");
    expect(await follow("notes/plan.md", 1)).toBe("/p/notes/steps.md");
    expect(await follow("notes/plan.md", 2)).toBe("service/src/http.ts");
    // In a file of the repository, notes/ is a folder beside it.
    expect(await follow("docs/guide.md", 0)).toBe("/w/docs/notes/rules.md");
  });

  it("quotes a note under its full path, which agents are told", async () => {
    views = {
      "notes/plan.md": {
        kind: "text",
        path: "/p/notes/plan.md",
        size: 3,
        content: "a\nb\n",
        truncated: false,
        ref: "notes/plan.md",
      },
    };
    const asked: CodeQuote[] = [];
    const { container, getByText } = render(
      <FilesPanel
        wsId="w1"
        target={{ path: "notes/plan.md" }}
        roots={[]}
        onAsk={(q) => asked.push(q)}
      />,
    );
    await waitFor(() => expect(container.querySelector(".file-markdown")).not.toBeNull());
    fireEvent.click(getByText("Source"));
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(container.querySelector(".code-text")!);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.click(container.querySelector(".fp-ask")!);
    expect(asked).toEqual([
      { path: "/p/notes/plan.md", lang: "markdown", from: 1, to: 2, text: "a\nb" },
    ]);
    document.getSelection()!.removeAllRanges();
  });

  describe("image previews", () => {
    const blob = new Blob(["image bytes"], { type: "image/png" });
    const raw = "api/file/raw?ws=w1&path=%2Fw%2Fa.png";
    beforeEach(() => {
      views = { "/w/a.png": { kind: "image", path: "/w/a.png", size: blob.size } };
    });

    const pngResponse = () => ({ ok: true, blob: () => Promise.resolve(blob) });
    class Item {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    }

    function rawResponse(respond: (signal: AbortSignal) => unknown) {
      const fetchMock = vi.mocked(fetch);
      const metadata = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url, init) =>
        typeof url === "string" && url.startsWith("api/file/raw?")
          ? (Promise.resolve(respond(init!.signal!)) as Promise<Response>)
          : metadata(url, init),
      );
      return fetchMock;
    }

    it("waits for one fetch and copies only the original PNG, with no HTML", async () => {
      const response = deferred<{ ok: boolean; blob: () => Promise<Blob> }>();
      const fetchMock = rawResponse(() => response.promise);
      const written = deferred<void>();
      const write = vi.fn((_items: Item[]) => written.promise);
      vi.stubGlobal("ClipboardItem", Item);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { write } });
      const { findByTitle, getByTitle, queryByRole, findByRole } = open("/w/a.png");
      const copy = (await findByTitle("Copy image")) as HTMLButtonElement;
      expect(copy.disabled).toBe(true);
      expect(queryByRole("img")).toBeNull();
      expect(getByTitle("Copy path").textContent).toBe("Copy path");
      response.resolve(pngResponse());
      const preview = await findByRole("img");
      expect(preview.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2UgYnl0ZXM=");
      fireEvent.click(copy);
      expect(write).toHaveBeenCalledTimes(1);
      const [item] = write.mock.calls[0][0];
      expect(Object.keys(item.data)).toEqual(["image/png"]);
      expect(await item.data["image/png"]).toBe(blob);
      expect(copy.textContent).toBe("Copy image");
      await act(() => {
        written.resolve();
        return written.promise;
      });
      expect(copy.textContent).toBe("Copied");
      expect(fetchMock.mock.calls.filter(([url]) => url === raw)).toHaveLength(1);
    });

    it("renders oversized images from the raw URL without a prefetch or unsupported copy control", async () => {
      views["/w/a.png"] = { kind: "image", path: "/w/a.png", size: INLINE_IMAGE_LIMIT + 1 };
      vi.stubGlobal("ClipboardItem", class {});
      vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
      const { findByRole, queryByTitle } = open("/w/a.png");
      expect((await findByRole("img")).getAttribute("src")).toBe(raw);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(queryByTitle("Copy image")).toBeNull();
    });

    it("fetches an oversized image only when the copy action needs its bytes", async () => {
      views["/w/a.png"] = { kind: "image", path: "/w/a.png", size: INLINE_IMAGE_LIMIT + 1 };
      const fetchMock = rawResponse(pngResponse);
      const write = vi.fn(async ([item]: Item[]) =>
        expect(await item.data["image/png"]).toBe(blob),
      );
      vi.stubGlobal("ClipboardItem", Item);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { write } });
      const { findByTitle, findByText } = open("/w/a.png");
      const button = await findByTitle("Copy image");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fireEvent.click(button);
      await findByText("Copied");
      expect(fetchMock.mock.calls.filter(([url]) => url === raw)).toHaveLength(1);
      expect(write).toHaveBeenCalledOnce();
    });

    it("aborts the FileReader when unmounted during data URL conversion", async () => {
      const started = vi.fn();
      const abort = vi.fn();
      class PendingReader {
        onabort?: () => void;
        onloadend?: () => void;
        readAsDataURL() {
          started();
        }
        abort() {
          abort();
          this.onabort?.();
          this.onloadend?.();
        }
      }
      vi.stubGlobal("FileReader", PendingReader);
      rawResponse(pngResponse);
      const { unmount } = open("/w/a.png");
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      unmount();
      expect(abort).toHaveBeenCalledOnce();
    });

    it("uses the raw URL with a JSON-only test response", async () => {
      const { findByRole } = open("/w/a.png");
      expect((await findByRole("img")).getAttribute("src")).toBe(raw);
    });

    it.each([
      ["HTTP 401", () => ({ ok: false, status: 401 })],
      [
        "not an image",
        () => ({ ok: true, blob: () => Promise.resolve(new Blob([], { type: "text/html" })) }),
      ],
      ["offline", () => Promise.reject(new Error("offline"))],
    ])("shows a readable error for %s without rendering the raw URL", async (error, respond) => {
      rawResponse(respond);
      const { findByText, queryByRole } = open("/w/a.png");
      await findByText(new RegExp(error));
      expect(queryByRole("img")).toBeNull();
    });

    it("aborts pending image fetches on navigation and unmount", async () => {
      views["/w"] = {
        kind: "dir",
        path: "/w",
        entries: [{ name: "a.png", dir: false, size: 11 }],
        truncated: false,
      };
      const signals: AbortSignal[] = [];
      const first = deferred<unknown>();
      rawResponse((signal) => {
        signals.push(signal);
        return signals.length === 1 ? first.promise : new Promise(() => {});
      });
      const { getByTitle, findByRole, queryByRole, unmount } = open("/w/a.png");
      await waitFor(() => expect(signals).toHaveLength(1));
      fireEvent.click(getByTitle("Parent folder"));
      const entry = await findByRole("button", { name: /a\.png/ });
      expect(signals[0].aborted).toBe(true);
      await act(() => {
        first.resolve(pngResponse());
        return first.promise;
      });
      expect(queryByRole("img")).toBeNull();
      fireEvent.click(entry);
      await waitFor(() => expect(signals).toHaveLength(2));
      expect(queryByRole("img")).toBeNull();
      unmount();
      expect(signals[1].aborted).toBe(true);
    });

    it("inlines images in the Notes preview too", async () => {
      const signals: AbortSignal[] = [];
      rawResponse((signal) => {
        signals.push(signal);
        return pngResponse();
      });
      const { findByRole } = render(
        <FilePreview
          project="p"
          file={{ path: "/w/a.png" }}
          onRef={vi.fn()}
          onResolve={vi.fn()}
          onClose={vi.fn()}
          editor={false}
        />,
      );
      expect((await findByRole("img", { name: "a.png" })).getAttribute("src")).toMatch(
        /^data:image\/png;/,
      );
      expect(fetch).toHaveBeenCalledWith("api/file/raw?project=p&path=%2Fw%2Fa.png", {
        signal: signals[0],
      });
    });
  });

  it("describes binary files without trying to render them as text or images", async () => {
    views = { "b.bin": { kind: "binary", path: "/w/b.bin", size: 3000 } };
    const { container, findByText, getByRole } = open("b.bin");
    expect(await findByText(/^Binary file · 2\.9 KB/)).toBeTruthy();
    expect(container.querySelector(".code-view, .file-image")).toBeNull();
    expect(getByRole("link", { name: "Raw" })).toBeTruthy();
  });

  it("switches between the project's folders, naming a path outside them", async () => {
    views = {
      "/repo": { kind: "dir", path: "/repo", truncated: false, entries: [] },
      "/repo/.worktrees/fix": {
        kind: "dir",
        path: "/repo/.worktrees/fix",
        truncated: false,
        entries: [],
      },
      "/tmp/x.log": { kind: "text", path: "/tmp/x.log", size: 2, content: "x\n", truncated: false },
    };
    const roots = [
      { label: "repo · main", path: "/repo" },
      { label: "fix · fix/crash", path: "/repo/.worktrees/fix" },
    ];
    const { container, getByLabelText } = open("/repo", undefined, undefined, roots);
    const select = getByLabelText("Folder") as HTMLSelectElement;
    await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
    expect(select.value).toBe("/repo");
    fireEvent.change(select, { target: { value: "/repo/.worktrees/fix" } });
    await waitFor(() => expect(requested.at(-1)).toBe("/repo/.worktrees/fix"));
    await waitFor(() => expect(select.value).toBe("/repo/.worktrees/fix"));
    const elsewhere = open("/tmp/x.log", undefined, undefined, roots);
    await waitFor(() => expect(elsewhere.container.querySelector(".code-view")).not.toBeNull());
    const other = elsewhere.getAllByLabelText("Folder").at(-1) as HTMLSelectElement;
    expect(other.value).toBe("");
    expect(other.selectedOptions[0].textContent).toBe("Elsewhere");
  });

  it("shows a markdown file opened at a line as source, with the line marked", async () => {
    views = {
      "docs/plan.md": {
        kind: "text",
        path: "/w/docs/plan.md",
        size: 20,
        content: "# Plan\n\n- one\n- two\n",
        truncated: false,
      },
    };
    const { container, getByText } = open("docs/plan.md", 3);
    await waitFor(() => expect(container.querySelector(".code-mark")).not.toBeNull());
    fireEvent.click(getByText("Preview"));
    expect(container.querySelector(".file-markdown h1")).not.toBeNull();
  });

  it("goes up from a path the server has not resolved, not to the root", async () => {
    views = {};
    const { container } = open(".");
    await waitFor(() => expect(container.querySelector(".file-error")).not.toBeNull());
    fireEvent.click(container.querySelector('[title="Parent folder"]')!);
    await waitFor(() => expect(requested.at(-1)).toBe(".."));
  });

  it("says Copied only when the path was copied", async () => {
    views = {};
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const { container, getByTitle } = open("x");
    await waitFor(() => expect(container.querySelector(".file-error")).not.toBeNull());
    const copy = vi.fn(() => false);
    document.execCommand = copy;
    await act(async () => {
      fireEvent.click(getByTitle("Copy path"));
      await Promise.resolve();
    });
    expect(copy).toHaveBeenCalledWith("copy");
    expect(getByTitle("Copy path").textContent).toBe("Copy");
  });

  it("copies the path over plain http, where the clipboard API is missing", async () => {
    views = {};
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    let copied = "";
    document.execCommand = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    const { container, getByTitle } = open("x");
    await waitFor(() => expect(container.querySelector(".file-error")).not.toBeNull());
    fireEvent.click(getByTitle("Copy path"));
    await waitFor(() => expect(getByTitle("Copy path").textContent).toBe("Copied"));
    expect(copied).toBe("x");
  });

  it("shows paths from the folder's own name, the full path on hover", async () => {
    views = {
      "src/a.ts": { kind: "text", path: "/w/src/a.ts", size: 2, content: "x\n", truncated: false },
    };
    const { container } = open("src/a.ts", undefined, undefined, [{ label: "w", path: "/w" }]);
    await waitFor(() => expect(container.querySelector(".code-view")).not.toBeNull());
    const shown = container.querySelector(".fp-path")!;
    expect(shown.textContent).toBe("w/src/a.ts");
    expect(shown.getAttribute("title")).toBe("/w/src/a.ts");
  });

  it("offers no folder choice for a single workspace", async () => {
    views = { ".": { kind: "dir", path: "/w", truncated: false, entries: [] } };
    const { container, queryByLabelText } = open(".", undefined, undefined, [
      { label: "w", path: "/w" },
    ]);
    await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
    expect(queryByLabelText("Folder")).toBeNull();
  });
});

describe("automatic panel widths", () => {
  it("give code more room than lists, and grow with the window within bounds", () => {
    expect([1000, 1440, 2560, 3840].map((w) => autoPanelWidth("list", w))).toEqual([
      380, 380, 560, 560,
    ]);
    expect([1000, 1440, 2560, 3840].map((w) => autoPanelWidth("wide", w))).toEqual([
      560, 605, 1075, 1100,
    ]);
  });
});

describe("fileRoots", () => {
  const ws = (id: string, cwd: string, over: Partial<Workspace> = {}): Workspace =>
    ({ id, name: id, cwd, agents: [], messages: [], createdAt: 0, ...over }) as Workspace;

  it("lists each live session's folder once, with its branch", () => {
    expect(
      fileRoots([
        ws("lead", "/repo", { git: { branch: "main" } as Workspace["git"] }),
        ws("w1", "/repo"),
        ws("w2", "/repo/.worktrees/fix", { git: { branch: "fix/crash" } as Workspace["git"] }),
        ws("old", "/repo/.worktrees/old", { archivedAt: 1 }),
      ]),
    ).toEqual([
      { label: "repo · main", path: "/repo" },
      { label: "fix · fix/crash", path: "/repo/.worktrees/fix" },
    ]);
  });
});

describe("file references in replies", () => {
  const md = (text: string, open?: (r: string) => void) =>
    render(
      <FileOpenContext.Provider value={open ?? null}>
        <MdBlock>{text}</MdBlock>
      </FileOpenContext.Provider>,
    );

  it("opens inline code that names a file but not a method", () => {
    const open = vi.fn();
    const { container } = md("Fixed in `service/src/index.ts:1182`. Call `ws.send`.", open);
    const refs = [...container.querySelectorAll(".file-ref")];
    expect(refs.map((r) => r.textContent)).toEqual(["service/src/index.ts:1182"]);
    fireEvent.click(refs[0]);
    expect(open.mock.calls).toEqual([["service/src/index.ts:1182"]]);
  });

  const refs = (text: string) => {
    const open = vi.fn();
    const { container, unmount } = md(text, open);
    for (const r of container.querySelectorAll(".file-ref")) fireEvent.click(r);
    const html = container.innerHTML;
    unmount();
    return { calls: open.mock.calls.map((c: unknown[]) => c[0]), html };
  };

  it("opens links whose target has a line, or a file:// scheme", () => {
    expect(refs("[a](a.ts:12) and [b](file:///home/me/b.ts)").calls).toEqual([
      "a.ts:12",
      "/home/me/b.ts",
    ]);
  });

  it("opens Windows desktop links and inline paths from Codex replies", () => {
    expect(
      refs(
        "[slash](C:/Users/me/Desktop/report.md) " +
          "[back](C:\\Users\\me\\Desktop\\report.md:12) " +
          "[uri](file:///C:/Users/me/Desktop/report.md#L3-L9) " +
          "[spaced](<C:\\Users\\John Doe\\Desktop\\报告.md#L5>) " +
          "`C:\\Users\\me\\Desktop\\a.ts:12`",
      ).calls,
    ).toEqual([
      "C:/Users/me/Desktop/report.md",
      "C:\\Users\\me\\Desktop\\report.md:12",
      "C:/Users/me/Desktop/report.md#L3-L9",
      "C:\\Users\\John Doe\\Desktop\\报告.md#L5",
      "C:\\Users\\me\\Desktop\\a.ts:12",
    ]);
  });

  it("opens link targets decoded, without a query or a section anchor", () => {
    expect(
      refs("[说明](docs/说明.md) [x](<my file.md>) [s](docs/setup.md#install) [q](a.ts?plain=1)")
        .calls,
    ).toEqual(["docs/说明.md", "my file.md", "docs/setup.md", "a.ts"]);
    expect(refs("[l](src/a.ts#L3)").calls).toEqual(["src/a.ts#L3"]);
  });

  it("leaves page anchors plain and mail links as links", () => {
    const { calls, html } = refs("[Install](#install) [mail](mailto:a@b.c)");
    expect(calls).toEqual([]);
    expect(html).toContain('href="mailto:a@b.c"');
  });

  it("opens code inside a link once, as the link", () => {
    expect(refs("[`src/a.ts`](https://github.com/o/r/blob/main/src/a.ts#L3)").calls).toEqual([]);
    expect(refs("[`src/a.ts`](src/a.ts:12)").calls).toEqual(["src/a.ts:12"]);
  });

  it("stays plain text where there is no workspace to open it in", () => {
    const { container } = md("Fixed in `service/src/index.ts:1182`.");
    expect(container.querySelector(".file-ref")).toBeNull();
  });
});

describe("the Files panel's bar and listing", () => {
  let views: Record<string, FileView>;
  beforeEach(() => stubFileViews((path) => views[path]));
  afterEach(() => vi.unstubAllGlobals());

  const repoRoots: FileRoot[] = [
    { label: "repo · main", path: "/repo" },
    { label: "fix · fix/crash", path: "/repo/.worktrees/fix" },
  ];
  const open = (path: string, roots: FileRoot[]) =>
    render(<FilesPanel wsId="w1" target={{ path }} roots={roots} />);
  const text = (path: string): FileView => ({
    kind: "text",
    path,
    size: 2,
    content: "x\n",
    truncated: false,
  });

  it("shows a path from the deepest folder holding it, '/' at a folder's top", async () => {
    views = {
      "/repo/.worktrees/fix/src/a.ts": text("/repo/.worktrees/fix/src/a.ts"),
      "/repo": { kind: "dir", path: "/repo", truncated: false, entries: [] },
      ".": { kind: "dir", path: "/w", truncated: false, entries: [] },
    };
    const inTree = open("/repo/.worktrees/fix/src/a.ts", repoRoots);
    await waitFor(() => expect(inTree.container.querySelector(".code-view")).not.toBeNull());
    expect(inTree.container.querySelector(".fp-path")!.textContent).toBe("src/a.ts");
    inTree.unmount();
    const top = open("/repo", repoRoots);
    await waitFor(() => expect(top.container.querySelector(".dir-view")).not.toBeNull());
    expect(top.container.querySelector(".fp-path")!.textContent).toBe("/");
    top.unmount();
    const single = open(".", [{ label: "w", path: "/w" }]);
    await waitFor(() => expect(single.container.querySelector(".dir-view")).not.toBeNull());
    expect(single.container.querySelector(".fp-path")!.textContent).toBe("w");
    expect(single.container.querySelector(".fp-path")!.getAttribute("title")).toBe("/w");
  });

  it("counts a path under the root folder '/' as in it", async () => {
    views = { "/etc/hosts": text("/etc/hosts") };
    const { container, getByLabelText } = open("/etc/hosts", [
      { label: "root", path: "/" },
      { label: "repo", path: "/repo" },
    ]);
    await waitFor(() => expect(container.querySelector(".code-view")).not.toBeNull());
    expect((getByLabelText("Folder") as HTMLSelectElement).value).toBe("/");
    expect(container.querySelector(".fp-path")!.textContent).toBe("etc/hosts");
  });

  it("navigates and labels Windows drive paths cleanly", async () => {
    const winRoot = "C:\\Users\\me\\yaat";
    const file = "C:\\Users\\me\\yaat\\src\\app.ts";
    const srcDir = "C:\\Users\\me\\yaat\\src";
    views = {
      [file]: text(file),
      [srcDir]: {
        kind: "dir",
        path: srcDir,
        truncated: false,
        entries: [{ name: "app.ts", dir: false, size: 2 }],
      },
    };
    const roots = fileRoots([
      { cwd: winRoot, git: { branch: "main" } } as unknown as Workspace,
      { cwd: "C:\\Users\\me\\other" } as unknown as Workspace,
    ]);
    expect(roots[0]).toEqual({ label: "yaat · main", path: winRoot });

    const { container, getByLabelText } = open(file, roots);
    await waitFor(() => expect(container.querySelector(".code-view")).not.toBeNull());
    expect((getByLabelText("Folder") as HTMLSelectElement).value).toBe(winRoot);
    expect(container.querySelector(".fp-path")!.textContent).toBe("src/app.ts");

    fireEvent.click(container.querySelector(".fp-up")!);
    await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
    expect(container.querySelector(".fp-path")!.textContent).toBe("src");

    fireEvent.click(container.querySelector(".dir-entry")!);
    await waitFor(() => expect(container.querySelector(".code-view")).not.toBeNull());
    expect(container.querySelector(".fp-path")!.textContent).toBe("src/app.ts");
  });
});
