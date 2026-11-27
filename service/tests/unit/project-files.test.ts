// A project's board reads and opens files of its notes and repository only:
// the path rules, api/file with a project, api/open, and VS Code's CLI found
// and pointed at a live window.
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { Auth } from "../../src/server/auth";
import { HttpHandler, type ProjectPaths } from "../../src/server/http";
import { execFileSync } from "child_process";
import { boardRef, findBySuffix, resolveProjectPath } from "../../src/project/paths";
import { openInVSCode, VSCodeUnavailable } from "../../src/repo/vscode";

let base: string;
let root: string;
let notes: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-pfiles-")));
  root = path.join(base, "repo");
  notes = path.join(base, "data", "notes");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(notes, "rules"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.cpp"), "int a;\n");
  fs.writeFileSync(path.join(notes, "rules", "cli.md"), "# CLI\n");
  for (const d of ["a", "b"]) {
    fs.mkdirSync(path.join(notes, "rules", d));
    fs.writeFileSync(path.join(notes, "rules", d, "dup.md"), "");
  }
  fs.writeFileSync(path.join(base, "secret.txt"), "no");
  fs.symlinkSync(base, path.join(root, "out"));
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("board paths", () => {
  it("lead notes/ to the notes, the rest into the repository, and nowhere else", () => {
    const r = (p: string) => resolveProjectPath(p, root, notes);
    expect(r("notes/rules/cli.md")).toBe(path.join(notes, "rules", "cli.md"));
    expect(r("notes")).toBe(notes);
    expect(r("src/a.cpp")).toBe(path.join(root, "src", "a.cpp"));
    expect(r("./src/a.cpp")).toBe(path.join(root, "src", "a.cpp"));
    expect(r(path.join(root, "src", "a.cpp"))).toBe(path.join(root, "src", "a.cpp"));
    expect(r("src/missing.cpp")).toBe(path.join(root, "src", "missing.cpp"));
    expect(r("../secret.txt")).toBeNull();
    expect(r("notes/../../secret.txt")).toBeNull();
    expect(r(path.join(base, "secret.txt"))).toBeNull();
    // A symlink in the repository does not lead out of it, to a file there or not.
    expect(r("out/secret.txt")).toBeNull();
    expect(r("out/new.txt")).toBeNull();
    expect(r("..foo")).toBe(path.join(root, "..foo"));
    // A root reached through a symlink, the path written as it really is.
    const link = path.join(base, "repo-link");
    if (!fs.existsSync(link)) fs.symlinkSync(root, link);
    expect(resolveProjectPath(path.join(root, "src", "a.cpp"), link, notes)).toBe(
      path.join(root, "src", "a.cpp"),
    );
    // A link to nowhere may come to point anywhere.
    const dangling = path.join(root, "dangling");
    if (!fs.existsSync(dangling)) fs.symlinkSync(path.join(base, "nowhere"), dangling);
    expect(r("dangling/x.cpp")).toBeNull();
    // ./notes/ is the repository's own notes folder.
    expect(r("./notes/a.md")).toBe(path.join(root, "notes", "a.md"));
  });

  it("are written back as the board writes them", () => {
    const ref = (abs: string) => boardRef(abs, root, notes);
    expect(ref(path.join(notes, "rules", "cli.md"))).toBe("notes/rules/cli.md");
    expect(ref(notes)).toBe("notes");
    expect(ref(path.join(root, "src", "a.cpp"))).toBe("src/a.cpp");
    expect(ref(path.join(root, "notes", "a.md"))).toBe("./notes/a.md");
    expect(ref(root)).toBe(".");
  });

  it("refuse a path too long to be one, at once", () => {
    const t = Date.now();
    expect(resolveProjectPath("a/".repeat(32_000), root, notes)).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("a path missing from the repository", () => {
  it("is the one file or folder whose path ends with it, if there is one", async () => {
    const repo = path.join(base, "suffix");
    for (const f of ["src/sched/batch.cpp", "docs/en/cli/format.md", "docs/zh/cli/format.md"]) {
      fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      fs.writeFileSync(path.join(repo, f), "");
    }
    fs.writeFileSync(path.join(repo, "untracked.cpp"), "");
    fs.mkdirSync(path.join(repo, "notes", "guide"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs", "guide"), { recursive: true });
    fs.writeFileSync(path.join(repo, "notes", "guide", "a.md"), "");
    fs.writeFileSync(path.join(repo, "docs", "guide", "a.md"), "");
    fs.writeFileSync(path.join(repo, "src", "gone.cpp"), "");
    fs.writeFileSync(path.join(repo, "ignored.cpp"), "");
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.cpp\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "src", "docs", "notes"], { cwd: repo });
    fs.rmSync(path.join(repo, "src", "gone.cpp"));
    const find = async (p: string) => (await findBySuffix(p, repo, notes)).map((f) => f.ref);
    expect(await findBySuffix("sched/batch.cpp", repo, notes)).toEqual([
      { ref: "src/sched/batch.cpp", abs: path.join(repo, "src/sched/batch.cpp") },
    ]);
    expect(await find("batch.cpp")).toEqual(["src/sched/batch.cpp"]);
    expect(await find("untracked.cpp")).toEqual(["untracked.cpp"]);
    expect(await find("sched/")).toEqual(["src/sched"]);
    expect(await find("rules/cli.md")).toEqual(["notes/rules/cli.md"]);
    expect(await find("cli/format.md")).toEqual(["docs/en/cli/format.md", "docs/zh/cli/format.md"]);
    expect(await find("./sched/batch.cpp")).toEqual(["src/sched/batch.cpp"]);
    // Each as the board reads it back, the repository's notes/ too.
    const guide = await findBySuffix("guide/a.md", repo, notes);
    expect(guide.map((f) => f.ref)).toEqual(["./notes/guide/a.md", "docs/guide/a.md"]);
    for (const f of guide) expect(resolveProjectPath(f.ref, repo, notes)).toBe(f.abs);
    // Tracked but deleted.
    expect(await find("gone.cpp")).toEqual([]);
    // Part of a name, or a path the board reads as it is.
    expect(await find("ched/batch.cpp")).toEqual([]);
    expect(await find("ignored.cpp")).toEqual([]);
    expect(await find("notes/cli.md")).toEqual([]);
    expect(await find("../batch.cpp")).toEqual([]);
  });
});

async function serveProjectFiles({
  cwdOf,
  projectOf,
  openFile,
  notesOf,
}: {
  cwdOf?: (workspaceId: string) => string | undefined;
  projectOf?: (projectId: string) => ProjectPaths | undefined;
  openFile?: (file: string, line: number | undefined) => Promise<void>;
  notesOf?: (workspaceId: string) => string | undefined;
}) {
  const handler = new HttpHandler(
    new Auth(() => null),
    base,
    base,
    base,
    cwdOf,
    undefined,
    projectOf,
    openFile,
    notesOf,
  );
  const server = http.createServer((req, res) => handler.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const json = async (route: string, init?: RequestInit) => {
    const response = await fetch(url + route, init);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    url,
    get: (query: string) => json(`/api/file?${query}`),
    open: (body: unknown, type = "application/json") =>
      json("/api/open", {
        method: "POST",
        headers: { "Content-Type": type },
        body: JSON.stringify(body),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("api/file and api/open for a project", () => {
  let files: Awaited<ReturnType<typeof serveProjectFiles>>;
  const opened: Array<[string, number | undefined]> = [];
  let fail: Error | null = null;

  beforeAll(async () => {
    files = await serveProjectFiles({
      projectOf: (id) => (id === "p1" ? { root, notesDir: notes } : undefined),
      openFile: (file, line) => {
        if (fail) return Promise.reject(fail);
        opened.push([file, line]);
        return Promise.resolve();
      },
    });
  });
  afterAll(() => files.close());

  it("read a note, list the notes, and refuse what lies outside", async () => {
    const { get, url } = files;
    const note = await get("project=p1&path=notes/rules/cli.md");
    expect(note).toMatchObject({
      status: 200,
      body: { kind: "text", content: "# CLI\n", ref: "notes/rules/cli.md" },
    });
    const dir = await get("project=p1&path=notes");
    expect(dir.body.kind).toBe("dir");
    expect((dir.body.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(["rules"]);
    expect((await get("project=p1&path=src/a.cpp")).body.content).toBe("int a;\n");
    expect((await get("project=p1&path=cli.md")).body).toMatchObject({
      path: path.join(notes, "rules/cli.md"),
      ref: "notes/rules/cli.md",
    });
    expect(await get("project=p1&path=dup.md")).toMatchObject({
      status: 404,
      body: { candidates: ["notes/rules/a/dup.md", "notes/rules/b/dup.md"] },
    });
    expect((await get("project=p1&path=../secret.txt")).status).toBe(403);
    expect((await get(`project=p1&path=${encodeURIComponent(base)}/secret.txt`)).status).toBe(403);
    expect((await get("project=nope&path=notes")).status).toBe(404);
    expect((await get(`project=p1&path=${"a/".repeat(3000)}`)).status).toBe(400);
    const raw = await fetch(`${url}/api/file/raw?project=p1&path=../secret.txt`);
    expect(raw.status).toBe(403);
  });

  it("open a file of the project in VS Code, and say when it cannot", async () => {
    const { open } = files;
    expect(await open({ project: "p1", path: "src/a.cpp", line: 3 })).toEqual({
      status: 200,
      body: { opened: path.join(root, "src", "a.cpp") },
    });
    expect(opened).toEqual([[path.join(root, "src", "a.cpp"), 3]]);
    expect((await open({ project: "p1", path: "../secret.txt" })).status).toBe(403);
    expect((await open({ project: "p1", path: "src/a.cpp" }, "text/plain")).status).toBe(415);
    expect((await open({ path: "src/a.cpp" })).status).toBe(400);
    // Neither null nor a folder (VS Code would open a window for it) nor a flood.
    expect((await open(null)).status).toBe(400);
    expect((await open({ project: "p1", path: "src" })).status).toBe(400);
    expect((await open({ project: "p1", path: "src/nope.cpp" })).status).toBe(404);
    expect((await open({ project: "p1", path: "x".repeat(70_000) })).status).toBe(413);
    fail = new VSCodeUnavailable("No VS Code window is connected");
    expect(await open({ project: "p1", path: "notes/rules/cli.md" })).toEqual({
      status: 503,
      body: { error: "No VS Code window is connected" },
    });
    fail = null;
    expect(opened).toHaveLength(1);
  });
});

describe("api/file for a project whose folder is gone", () => {
  it("answers, and the server stays up", async () => {
    const file = path.join(base, "not-a-dir");
    fs.writeFileSync(file, "");
    const files = await serveProjectFiles({
      projectOf: () => ({ root: file, notesDir: path.join(file, "notes") }),
    });
    try {
      const res = await fetch(`${files.url}/api/file?project=p&path=x.cpp`, {
        signal: AbortSignal.timeout(3000),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await files.close();
    }
  });
});

function vscodeCLI(
  script: (paths: { dir: string; log: string }) => string,
  ...runtimeNames: string[]
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-vsc-"));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const serverDir = path.join(dir, "server");
  const cli = path.join(serverDir, "bin", "abc", "bin", "remote-cli", "code");
  const log = path.join(dir, "log");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `#!/bin/sh\n${script({ dir, log })}`, { mode: 0o755 });
  const runtimeDirs = runtimeNames.map((name) => path.join(dir, name));
  for (const runtime of runtimeDirs) fs.mkdirSync(runtime);
  return { dir, log, env: { serverDir, runtimeDirs } };
}

async function listenUnixSocket(file: string, onConnection?: (socket: net.Socket) => void) {
  const server = net.createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(file, resolve));
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("VS Code's CLI", () => {
  it.skipIf(process.platform === "win32")(
    "is called with the hook of a live window, the newest live socket first",
    async () => {
      const { log, env } = vscodeCLI(
        ({ log }) => `echo "$VSCODE_IPC_HOOK_CLI $*" > ${log}\n`,
        "run",
      );
      const [run] = env.runtimeDirs;

      await expect(openInVSCode("/repo/a.cpp", 3, env)).rejects.toBeInstanceOf(VSCodeUnavailable);

      const live = path.join(run, "vscode-ipc-live.sock");
      const closeWindow = await listenUnixSocket(live, (socket) => socket.end());
      // Left behind by a closed window, and newer.
      const dead = path.join(run, "vscode-ipc-dead.sock");
      const closeGoneWindow = await listenUnixSocket(dead);
      await closeGoneWindow();
      fs.writeFileSync(dead, "");
      fs.utimesSync(live, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

      await openInVSCode("/repo/a.cpp", 3, env);
      expect(fs.readFileSync(log, "utf-8").trim()).toBe(`${live} --goto /repo/a.cpp:3`);
      await closeWindow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "finds a window's socket in any of the runtime dirs",
    async () => {
      const { log, env } = vscodeCLI(
        ({ log }) => `echo "$VSCODE_IPC_HOOK_CLI" > ${log}\n`,
        "run",
        "tmp",
      );
      const [, tmp] = env.runtimeDirs;
      const live = path.join(tmp, "vscode-ipc-live.sock");
      const closeWindow = await listenUnixSocket(live, (socket) => socket.end());
      // The hook the server was started with, of a window closed since.
      await openInVSCode("/repo/a.cpp", undefined, { ...env, hook: "/gone" });
      expect(fs.readFileSync(log, "utf-8").trim()).toBe(live);
      await closeWindow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "moves on from a window that does not answer, leaving nothing behind",
    async () => {
      const hungSocket = (dir: string) => path.join(dir, "run", "vscode-ipc-hung.sock");
      const pidFile = (dir: string) => path.join(dir, "pid");
      const { dir, log, env } = vscodeCLI(
        ({ dir, log }) =>
          `if [ "$VSCODE_IPC_HOOK_CLI" = "${hungSocket(dir)}" ]; then sleep 30 & echo $! > ${pidFile(dir)}; wait; fi\necho "$VSCODE_IPC_HOOK_CLI" > ${log}\n`,
        "run",
      );
      const hung = hungSocket(dir);
      const live = path.join(env.runtimeDirs[0], "vscode-ipc-live.sock");
      const closeWindows = await Promise.all(
        [hung, live].map((file) => listenUnixSocket(file, () => {})),
      );
      fs.utimesSync(live, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

      await openInVSCode("/repo/a.cpp", undefined, { ...env, timeoutMs: 300 });
      expect(fs.readFileSync(log, "utf-8").trim()).toBe(live);
      const sleeper = Number(fs.readFileSync(pidFile(dir), "utf-8"));
      await vi.waitFor(() => expect(() => process.kill(sleeper, 0)).toThrow(), {
        timeout: 1000,
        interval: 10,
      });
      await Promise.all(closeWindows.map((close) => close()));
    },
  );

  it.skipIf(process.platform === "win32")(
    "is run once when it fails by itself, and without --goto for no line",
    async () => {
      const { log, env } = vscodeCLI(
        ({ log }) => `echo "$*" >> ${log}\n[ "$1" = "--goto" ] || exit 0\nexit 1\n`,
        "run",
      );
      const [run] = env.runtimeDirs;
      const socks = ["a", "b", "c"].map((n) => path.join(run, `vscode-ipc-${n}.sock`));
      const closeWindows = await Promise.all(
        socks.map((file) => listenUnixSocket(file, (socket) => socket.end())),
      );

      await expect(openInVSCode("/repo/a.cpp", 3, env)).rejects.toThrow();
      expect(fs.readFileSync(log, "utf-8").trim().split("\n")).toEqual(["--goto /repo/a.cpp:3"]);
      fs.rmSync(log);
      await openInVSCode("/repo/a:3", undefined, env);
      expect(fs.readFileSync(log, "utf-8").trim()).toBe("/repo/a:3");
      await Promise.all(closeWindows.map((close) => close()));
    },
  );

  it("is reported missing when no VS Code server is installed", async () => {
    await expect(
      openInVSCode("/a", undefined, { serverDir: "/nonexistent", runtimeDirs: [] }),
    ).rejects.toThrow(/not installed/);
  });
});

describe("api/file for a session of a project", () => {
  let files: Awaited<ReturnType<typeof serveProjectFiles>>;
  let worktree: string;

  beforeAll(async () => {
    worktree = path.join(base, "worktree");
    fs.mkdirSync(path.join(worktree, "own", "notes"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "own", "notes", "todo.md"), "mine\n");
    files = await serveProjectFiles({
      cwdOf: (id) => ({ w1: worktree, w2: path.join(worktree, "own") })[id],
      notesOf: (id) => (id === "w1" || id === "w2" ? notes : undefined),
    });
  });
  afterAll(() => files.close());

  it("read notes/... from the project's notes, unless the workspace has that file itself", async () => {
    expect((await files.get("ws=w1&path=notes/rules/cli.md")).body).toMatchObject({
      kind: "text",
      content: "# CLI\n",
      path: path.join(notes, "rules", "cli.md"),
      ref: "notes/rules/cli.md",
    });
    expect((await files.get("ws=w1&path=notes")).body).toMatchObject({
      kind: "dir",
      path: notes,
      ref: "notes",
    });
    // A note opened by its full path still says which note it is.
    expect(
      (await files.get(`ws=w1&path=${encodeURIComponent(path.join(notes, "rules"))}`)).body,
    ).toMatchObject({ kind: "dir", ref: "notes/rules" });
    const own = (await files.get("ws=w2&path=notes/todo.md")).body;
    expect(own).toMatchObject({ content: "mine\n" });
    expect(own.ref).toBeUndefined();
    expect((await files.get("ws=w2&path=notes/rules/cli.md")).body).toMatchObject({
      ref: "notes/rules/cli.md",
    });
    expect((await files.get("ws=w1&path=notes/nope.md")).body).toMatchObject({
      error: "No such file or directory",
      path: path.join(notes, "nope.md"),
    });
    expect((await files.get("ws=w1&path=./notes/rules/cli.md")).status).toBe(404);
  });
});
