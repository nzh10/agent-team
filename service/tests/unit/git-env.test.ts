import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { applyNonInteractiveGitEnv } from "../../src/session/git-env";

const run = promisify(execFile);

it("fails fast without HTTP credentials and pushes with a configured helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-team-git-http-"));
  const remote = join(root, "remote.git");
  const local = join(root, "local");
  const env = applyNonInteractiveGitEnv({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  });
  const git = (args: string[], cwd = root) => run("git", args, { cwd, env, timeout: 4_000 });
  const user = "test-user";
  const password = "test-password";
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== authorization) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Git test"' }).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const backend = execFile(
      "git",
      ["http-backend"],
      {
        cwd: root,
        encoding: "buffer",
        timeout: 4_000,
        env: {
          ...env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: req.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers["content-type"],
          CONTENT_LENGTH: req.headers["content-length"],
          HTTP_CONTENT_ENCODING: req.headers["content-encoding"],
          REMOTE_USER: user,
        },
      },
      (err, stdout) => {
        const split = stdout.indexOf("\r\n\r\n");
        if (err || split < 0) {
          res.writeHead(500).end(err?.message ?? "Malformed Git CGI response");
          return;
        }
        for (const line of stdout.subarray(0, split).toString().split("\r\n")) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") res.statusCode = parseInt(value, 10);
          else res.setHeader(name, value);
        }
        res.end(stdout.subarray(split + 4));
      },
    );
    backend.stdin?.on("error", () => {}); // The backend may exit before reading the body.
    if (backend.stdin) req.pipe(backend.stdin);
  });

  try {
    await git(["init", "--bare", remote]);
    await git(["config", "http.receivepack", "true"], remote);
    await git(["init", local]);
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "test",
      ],
      local,
    );
    const { stdout: commit } = await git(["rev-parse", "HEAD"], local);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP test port");
    const push = ["push", `http://127.0.0.1:${address.port}/remote.git`, "HEAD:refs/heads/pushed"];

    // A timeout also rejects, but does not have Git's exit code and diagnostic.
    const denied = git(push, local);
    await expect(denied).rejects.toMatchObject({ code: 128, killed: false });
    await expect(denied).rejects.toHaveProperty(
      "stderr",
      expect.stringContaining("terminal prompts disabled"),
    );
    await expect(git(["rev-parse", "--verify", "refs/heads/pushed"], remote)).rejects.toMatchObject(
      {
        code: 128,
      },
    );

    await git(
      [
        "config",
        "--local",
        "credential.helper",
        `!f() { if test "$1" = get; then printf '%s\\n' 'username=${user}' 'password=${password}'; fi; }; f`,
      ],
      local,
    );
    await git(push, local);
    const { stdout: pushed } = await git(["rev-parse", "--verify", "refs/heads/pushed"], remote);
    expect(pushed.trim()).toBe(commit.trim());
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
