import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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
beforeAll(async () => {
  // The coordinator runs as plain JavaScript in the pinned Node runtime.
  // @ts-expect-error The operational script has no declarations.
  const coordinator = (await import("../../../scripts/deploy-controller.mjs")) as {
    deploy: typeof deploy;
    serviceManager: typeof serviceManager;
  };
  deploy = coordinator.deploy;
  serviceManager = coordinator.serviceManager;
});
const files = [
  "server.js",
  "history-worker.js",
  "pi-panel-bridge.ts",
  "pi-quota.ts",
  "quota-schema.ts",
  "acp-readiness.ts",
  "webview/index.html",
  "webview/manifest.webmanifest",
];
let dir: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "yaat-job-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
