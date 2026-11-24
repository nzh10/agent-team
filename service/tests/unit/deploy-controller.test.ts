import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface Target {
  port: number;
  label: string;
  installedRepoDir: string;
  baseDir: string;
}
interface Options {
  root: string;
  job: string;
  id: string;
  target: Target;
  timeoutMs: number;
  manager: { restart(): Promise<void>; verify(pid: number): Promise<void> };
  stage(dir: string, signal: AbortSignal): Promise<void>;
  request(base: string, message: Record<string, unknown>): Promise<unknown>;
  probe(status: unknown, dir: string): Promise<void>;
  now(): number;
  pause: (ms: number) => Promise<void>;
}
let serviceManager: (
  label: string,
  repo: string,
  env: NodeJS.ProcessEnv,
) => Options["manager"] & { verifyLauncher(): Promise<void> };
let deploy: (options: Options) => Promise<void>;
let gcReleases: (options: {
  root: string;
  now: number;
  listProcesses: () => Promise<string>;
}) => Promise<{ releases: string[]; jobs: string[] }>;
beforeAll(async () => {
  // The coordinator runs as plain JavaScript in the pinned Node runtime.
  // @ts-expect-error The operational script has no declarations.
  const coordinator = (await import("../../../scripts/deploy-controller.mjs")) as {
    deploy: typeof deploy;
    gcReleases: typeof gcReleases;
    serviceManager: typeof serviceManager;
  };
  deploy = coordinator.deploy;
  gcReleases = coordinator.gcReleases;
  serviceManager = coordinator.serviceManager;
});
const files = [
  "server.js",
  "history-worker.js",
  "pi-panel-bridge.ts",
  "pi-quota.ts",
  "quota-schema.ts",
  "acp-readiness.ts",
  "quota/antigravity.ts",
  "quota/kimi-coding.ts",
  "quota/oauth.ts",
  "quota/openai-codex.ts",
  "quota/pi-adapters.ts",
  "quota/pi-context.ts",
  "quota/registry.ts",
  "webview/index.html",
  "webview/manifest.webmanifest",
];
let dir: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "yaat-job-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("release garbage collection", () => {
  it("keeps current, rollback, live processes and unfinished jobs", async () => {
    const root = path.join(dir, "releases");
    const jobs = path.join(root, "jobs");
    fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const register = (id: string, phase: string, prior = false) => {
      const job = path.join(jobs, id);
      fs.mkdirSync(job);
      const status = path.join(job, "status.json");
      fs.writeFileSync(status, JSON.stringify({ id, phase }));
      fs.utimesSync(status, 1, 1);
      fs.mkdirSync(path.join(root, `gen-${id}`));
      if (prior) fs.mkdirSync(path.join(root, `gen-${id}-prior`));
    };
    register("current", "succeeded");
    register("previous", "succeeded");
    register("live", "succeeded");
    register("building", "building", true);
    register("queued", "queued");
    register("failed", "failed", true);
    fs.symlinkSync("gen-current", path.join(root, "current"));
    fs.symlinkSync("gen-previous", path.join(root, "previous"));
    const alias = path.join(dir, "alias");
    fs.symlinkSync(root, alias);
    const options = {
      root: alias,
      now,
      listProcesses: () =>
        Promise.resolve(`1337 /usr/bin/node ${path.join(root, "gen-live", "server.js")}\n`),
    };
    expect(await gcReleases(options)).toEqual({
      releases: ["gen-failed", "gen-failed-prior"],
      jobs: ["failed"],
    });
    expect(fs.readlinkSync(path.join(root, "current"))).toBe("gen-current");
    expect(fs.readlinkSync(path.join(root, "previous"))).toBe("gen-previous");
    for (const id of ["current", "previous", "live", "building", "queued"]) {
      expect(fs.lstatSync(path.join(root, `gen-${id}`)).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(jobs, id)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(path.join(root, "gen-building-prior"))).toBe(true);
    expect(
      await gcReleases({
        ...options,
        listProcesses: () => Promise.resolve("7 node unrelated.js\n"),
      }),
    ).toEqual({ releases: ["gen-live"], jobs: ["live"] });
    expect(fs.existsSync(path.join(root, "gen-live"))).toBe(false);
    expect(fs.existsSync(path.join(jobs, "live"))).toBe(false);
  });

  it("keeps a verified fallback when rollback leaves both pointers on the same generation", async () => {
    const root = path.join(dir, "releases");
    const jobs = path.join(root, "jobs");
    fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    for (const [id, phase, mtime] of [
      ["healthy", "succeeded", 1],
      ["broken", "rolled_back", 2],
    ] as const) {
      const release = path.join(root, `gen-${id}`);
      fs.mkdirSync(release);
      fs.utimesSync(release, mtime, mtime);
      fs.mkdirSync(path.join(jobs, id));
      const status = path.join(jobs, id, "status.json");
      fs.writeFileSync(
        status,
        JSON.stringify({ id, phase, candidate: `gen-${id}`, prior: "gen-current" }),
      );
      fs.utimesSync(status, mtime, mtime);
    }
    fs.mkdirSync(path.join(root, "gen-current"));
    for (const pointer of ["current", "previous"])
      fs.symlinkSync("gen-current", path.join(root, pointer));
    expect(
      await gcReleases({
        root,
        now: Date.now(),
        listProcesses: () => Promise.resolve("100 node unrelated.js\n"),
      }),
    ).toEqual({ releases: ["gen-broken"], jobs: ["broken"] });
    expect(fs.existsSync(path.join(root, "gen-healthy"))).toBe(true);
  });
});

it("re-publishes backend extensions when watch-only source files change or disappear", async () => {
  const repo = path.resolve(__dirname, "../../..");
  const service = path.join(dir, "service");
  const out = path.join(dir, "dist");
  fs.mkdirSync(service);
  fs.cpSync(path.join(repo, "service/src"), path.join(service, "src"), { recursive: true });
  fs.cpSync(path.join(repo, "shared"), path.join(dir, "shared"), { recursive: true });
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"), "dir");
  const child = spawn(process.execPath, [path.join(repo, "service/esbuild.mjs"), "--watch"], {
    cwd: service,
    env: { ...process.env, YAAT_BUILD_OUT_DIR: out },
    stdio: "ignore",
  });
  const closed = once(child, "close");
  try {
    const bridge = "pi-panel-bridge.ts";
    const extra = "quota/watch-only.ts";
    const src = (name: string) => path.join(service, "src/session", name);
    const dst = (name: string) => path.join(out, name);
    const published = (name: string, marker: string) =>
      vi.waitFor(
        () => {
          expect(fs.readFileSync(dst(name), "utf8")).toContain(marker);
        },
        { timeout: 5_000 },
      );
    await published(bridge, "function piPanelBridge");
    fs.appendFileSync(src(bridge), "\n// test edit\n");
    await published(bridge, "// test edit");
    fs.writeFileSync(src(extra), "export const watched = true;\n");
    await published(extra, "watched = true");
    fs.unlinkSync(src(extra));
    await vi.waitFor(() => expect(fs.existsSync(dst(extra))).toBe(false), { timeout: 5_000 });
  } finally {
    child.kill();
    await closed;
  }
}, 20_000);

function fixture() {
  const root = path.join(dir, "releases");
  const job = path.join(root, "jobs/one");
  fs.mkdirSync(job, { recursive: true });
  fs.mkdirSync(path.join(root, "gen-old"));
  fs.symlinkSync("gen-old", path.join(root, "current"));
  const target = { port: 19991, label: "test", installedRepoDir: dir, baseDir: dir };
  let time = 1;
  const state = {
    ...target,
    pid: 771,
    bootId: "boot-1",
    releaseId: "gen-old",
    blockers: { workspaces: 0 },
    deployId: "",
    sealed: false,
    commitReady: false,
    committed: false,
    leaseRemainingMs: 20_000,
  };
  const manager = {
    verify: vi.fn(() => Promise.resolve()),
    restart: vi.fn(() => {
      state.pid++;
      state.bootId = `boot-${state.pid}`;
      state.releaseId = fs.readlinkSync(path.join(root, "current"));
      state.sealed = state.committed = state.commitReady = false;
      return Promise.resolve();
    }),
  };
  const stage = vi.fn((candidate: string) => {
    fs.mkdirSync(path.join(candidate, "webview"));
    fs.mkdirSync(path.join(candidate, "quota"));
    for (const file of files) fs.writeFileSync(path.join(candidate, file), "fixture");
    return Promise.resolve();
  });
  const rpc = vi.fn((_base: string, msg: Record<string, unknown>) => {
    if (msg.cmd === "seal") {
      state.sealed = state.commitReady = true;
      state.committed = msg.commit === true;
      state.deployId = String(msg.deployId);
    }
    if (msg.cmd === "unseal") state.sealed = false;
    return Promise.resolve({ ...state, blockers: { ...state.blockers } });
  });
  const options: Options = {
    root,
    job,
    id: "one",
    target,
    manager,
    stage,
    request: rpc,
    probe: () => Promise.resolve(),
    now: () => time,
    pause: (ms) => {
      time += ms;
      return Promise.resolve();
    },
    timeoutMs: 1000,
  };
  return {
    root,
    job,
    manager,
    stage,
    state,
    rpc,
    options,
    current: () => fs.readlinkSync(path.join(root, "current")),
    status: (): { phase: string } =>
      JSON.parse(fs.readFileSync(path.join(job, "status.json"), "utf8")) as { phase: string },
  };
}

describe("deferred cutover", () => {
  it("rejects a staged build missing a nested quota artifact before sealing", async () => {
    const f = fixture();
    f.options.stage = async (candidate) => {
      await f.stage(candidate);
      fs.unlinkSync(path.join(candidate, "quota/oauth.ts"));
    };
    await expect(deploy(f.options)).rejects.toThrow("Missing release artifact: quota/oauth.ts");
    expect(f.current()).toBe("gen-old");
    expect(f.manager.restart).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.every(([, request]) => request.cmd === "status")).toBe(true);
  });
  it("can stage over legacy dist without requiring new quota artifacts in its rollback snapshot", async () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.root, "current"));
    f.state.releaseId = "legacy";
    const legacy = path.join(f.options.target.installedRepoDir, "dist");
    for (const file of [
      "server.js",
      "history-worker.js",
      "webview/index.html",
      "webview/manifest.webmanifest",
    ]) {
      const target = path.join(legacy, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "legacy fixture");
    }
    await deploy(f.options);
    expect(f.status().phase).toBe("succeeded");
    expect(f.current()).toBe("gen-one");
    expect(fs.readlinkSync(path.join(f.root, "previous"))).toBe("gen-one-prior");
    expect(fs.readFileSync(path.join(f.root, "gen-one-prior/server.js"), "utf8")).toBe(
      "legacy fixture",
    );
  });

  it.each(["timed_out", "cancelled"])(
    "changes no live pointers or service on %s",
    async (phase) => {
      const f = fixture();
      f.state.blockers.workspaces = 1; // The turn that scheduled the deploy has not ended.
      const pause = f.options.pause;
      if (phase === "cancelled")
        f.options.pause = (ms) => {
          fs.writeFileSync(path.join(f.job, "decision"), "cancel\n", { flag: "wx" });
          return pause(ms);
        };
      await deploy(f.options);
      expect(f.status().phase).toBe(phase);
      expect(f.current()).toBe("gen-old");
      expect(fs.existsSync(path.join(f.root, "previous"))).toBe(false);
      expect(fs.existsSync(path.join(f.root, "transaction.json"))).toBe(false);
      expect(f.manager.restart).not.toHaveBeenCalled();
      expect(f.rpc.mock.calls.every(([, request]) => request.cmd === "status")).toBe(true);
    },
  );

  it.each(["label", "port", "baseDir", "installedRepoDir", "releaseId"] as const)(
    "fails closed for a wrong %s",
    async (key) => {
      const f = fixture();
      Object.assign(f.state, { [key]: "wrong" });
      await expect(deploy(f.options)).rejects.toThrow("identity mismatch");
      expect(f.current()).toBe("gen-old");
      expect(f.stage).not.toHaveBeenCalled();
      expect(f.manager.restart).not.toHaveBeenCalled();
    },
  );

  it("fails closed if the server is replaced while waiting", async () => {
    const f = fixture();
    f.state.blockers.workspaces = 1;
    f.options.pause = () => {
      f.state.bootId = "boot-replaced";
      return Promise.resolve();
    };
    await expect(deploy(f.options)).rejects.toThrow("identity mismatch");
    expect(f.current()).toBe("gen-old");
    expect(f.manager.restart).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "recovers a lost commit reply when unseal is verified (%s)",
    async (canUnseal) => {
      const f = fixture();
      f.options.request = async (base, msg) => {
        if (msg.cmd === "unseal" && !canUnseal) throw new Error("unseal timed out");
        const reply = await f.rpc(base, msg);
        if (msg.commit === true) throw new Error("commit reply timed out");
        return reply;
      };
      await expect(deploy(f.options)).rejects.toThrow("commit reply timed out");
      expect(f.status()).toMatchObject({ phase: "failed", recoveryRequired: !canUnseal });
      expect(fs.existsSync(path.join(f.root, "transaction.json"))).toBe(!canUnseal);
      expect(f.state.sealed).toBe(!canUnseal);
      expect(f.current()).toBe("gen-old");
      expect(f.manager.restart).not.toHaveBeenCalled();
    },
  );

  it("reports recovery required rather than a clean timeout if commit crossed the deadline and unseal failed", async () => {
    const f = fixture();
    f.options.request = async (base, msg) => {
      if (msg.cmd === "unseal") throw new Error("unseal timed out");
      const reply = await f.rpc(base, msg);
      if (msg.commit === true) await f.options.pause(2000);
      return reply;
    };
    await expect(deploy(f.options)).rejects.toThrow("unseal timed out");
    expect(f.status()).toMatchObject({ phase: "failed", recoveryRequired: true });
    expect(fs.existsSync(path.join(f.root, "transaction.json"))).toBe(true);
    expect(f.manager.restart).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "rolled_back"])(
    "checks the boot and release and leaves a %s job",
    async (outcome) => {
      const f = fixture();
      f.options.probe = (_status, release) => {
        expect(fs.existsSync(path.join(f.root, "transaction.json"))).toBe(true);
        if (outcome === "rolled_back" && path.basename(release) === "gen-one")
          return Promise.reject(new Error("bad static assets"));
        return Promise.resolve();
      };
      await deploy(f.options);
      expect(f.status().phase).toBe(outcome);
      expect(f.current()).toBe(outcome === "succeeded" ? "gen-one" : "gen-old");
      expect(fs.readlinkSync(path.join(f.root, "previous"))).toBe("gen-old");
      expect(f.manager.restart).toHaveBeenCalledTimes(outcome === "succeeded" ? 1 : 2);
      expect(fs.existsSync(path.join(f.root, "transaction.json"))).toBe(false);
    },
  );

  it("checks the launchd job's exact launcher and PID before targeting a restart", async () => {
    const bin = path.join(dir, "launchctl");
    const output = path.join(dir, "print");
    fs.writeFileSync(
      bin,
      `#!/bin/bash\n[ "$*" = 'print gui/17/test' ] && exec cat '${output}'\n[ "$*" = 'kickstart -k gui/17/test' ]`,
      { mode: 0o700 },
    );
    const manager = serviceManager("test", dir, {
      YAAT_SERVICE_OS: "Darwin",
      YAAT_LAUNCHCTL_BIN: bin,
      YAAT_UID: "17",
    });
    await expect(manager.verifyLauncher()).rejects.toThrow();
    const launcher = `${dir}/scripts/start-server.sh`;
    const printed = (program: string, args = "") =>
      fs.writeFileSync(output, `gui/17/test = {\n\tprogram = ${program}\n${args}\tpid = 52\n}\n`);
    printed(launcher);
    await manager.verify(52);
    const args = `\targuments = {\n\t\t/bin/bash\n\t\t${launcher}\n\t}\n`;
    printed("/bin/bash", args);
    await manager.verify(52);
    await expect(manager.verify(5)).rejects.toThrow("PID");
    printed("/bin/bash", args.replace(launcher, `-c\n\t\t${launcher}`));
    await expect(manager.verifyLauncher()).rejects.toThrow("launcher");
    printed("/wrong/bash", args);
    await expect(manager.verifyLauncher()).rejects.toThrow("launcher");
    await manager.restart();
  });

  it("rejects a concurrent controller at the repository lock", () => {
    const scripts = path.resolve(__dirname, "../../../scripts");
    const installed = path.join(dir, "scripts");
    fs.cpSync(scripts, installed, { recursive: true });
    const controller = path.join(installed, "deploy-controller.mjs");
    const prepared = spawnSync(process.execPath, [controller, "prepare", dir, "two"], {
      encoding: "utf8",
    });
    expect(prepared.stderr).toBe("");
    expect(prepared.status).toBe(0);
    const result = spawnSync(
      "bash",
      [
        "-c",
        'REPO_DIR=$1; source "$1/scripts/deploy-lock.sh"; deploy_lock || exit 9; "$1/scripts/deploy-deferred.sh" --when-idle --timeout 1 --job two; result=$?; exit "$result"',
        "bash",
        dir,
      ],
      {
        env: { ...process.env, AGENT_TEAM_BASE_DIR: dir, YAAT_NODE_BIN: process.execPath },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(
      fs.readFileSync(path.join(dir, ".agent-team/releases/jobs/two/status.json"), "utf8"),
    ).toContain("lock-failed");
  });
});
