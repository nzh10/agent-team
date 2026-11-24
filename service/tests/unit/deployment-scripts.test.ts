import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scripts = resolve(__dirname, "../../../scripts");
const scriptNames = [
  "runtime-paths",
  "setup-prereqs",
  "start-server",
  "yaat-service",
  "deploy-deferred",
  "deploy-lock",
];
const tools = [
  "basename",
  "cat",
  "chmod",
  "date",
  "dirname",
  "env",
  ...(process.platform === "linux" ? ["flock"] : []),
  "grep",
  "id",
  "mkdir",
  "mktemp",
  "mv",
  "printenv",
  "readlink",
  "rm",
  "sed",
  "sleep",
  "uname",
];
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function executable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  return path;
}

function runtime(dir: string, version: string, name: string) {
  mkdirSync(dir, { recursive: true });
  const node = executable(
    dir,
    "node",
    `if [[ \${1:-} = --version ]]; then echo ${version}; exit 0; fi
exec ${shellQuote(process.execPath)} "$@"`,
  );
  const npm = executable(
    dir,
    "npm",
    `printf '%s\\n' '${name}-npm' "$@" "$(command -v node)" "$YAAT_PI_BIN" >> "$TRACE"`,
  );
  const pi = executable(dir, "pi", `printf '%s\\n' '${name}-pi' "$@" >> "$TRACE"`);
  return { node, npm, pi };
}

let root: string;
let home: string;
let bin: string;
let base: string;
let trace: string;
let env: NodeJS.ProcessEnv;
let nvm: ReturnType<typeof runtime>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "yaat deployment ")));
  home = join(root, "home");
  bin = join(root, "bin");
  base = join(home, "service base");
  trace = join(root, "trace");
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  for (const name of scriptNames) {
    cpSync(join(scripts, `${name}.sh`), join(root, "scripts", `${name}.sh`));
  }
  cpSync(join(scripts, "deploy-controller.mjs"), join(root, "scripts/deploy-controller.mjs"));
  for (const tool of ["bash", ...tools]) {
    const source = ["/bin", "/usr/bin"].map((dir) => join(dir, tool)).find(existsSync);
    if (!source) throw new Error(`test requires ${tool}`);
    symlinkSync(source, join(bin, tool));
  }
  executable(bin, "git", "exit 0");
  executable(bin, "curl", 'echo 200; printf "%s\\n" curl >> "$TRACE"');
  nvm = runtime(join(home, ".nvm", "versions", "node", "v26.13.1", "bin"), "v26.13.1", "nvm");
  env = {
    PATH: bin,
    HOME: home,
    TRACE: trace,
    AGENT_TEAM_BASE_DIR: base,
    YAAT_NO_DEFAULT_PATH: "1",
    YAAT_SETUP_OS: "Darwin",
    YAAT_SETUP_ARCH: "arm64",
    YAAT_SERVICE_OS: "Linux",
    YAAT_UID: "1000",
    YAAT_UNIT_DIR: join(root, "units"),
    YAAT_PLIST_DIR: join(root, "plists"),
    YAAT_DEPLOY_LOG: join(root, "deploy.log"),
    // Forbid accidental calls to the host's managers even where the fake PATH is bypassed.
    YAAT_SYSTEMCTL_BIN: join(bin, "systemctl"),
    YAAT_SYSTEMD_RUN_BIN: join(bin, "systemd-run"),
    YAAT_LAUNCHCTL_BIN: join(bin, "launchctl"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(script: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, cwd = root) {
  const result = spawnSync("/bin/bash", [join(root, "scripts", `${script}.sh`), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    timeout: 10000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ok(script: string, args: string[], extraEnv?: NodeJS.ProcessEnv, cwd?: string): string {
  const result = run(script, args, extraEnv, cwd);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

it.each([true, false])(
  "schedules a separate launchd controller (bootstrap succeeds: %s)",
  (success) => {
    const darwin = { YAAT_SERVICE_OS: "Darwin" };
    const args = ["deploy-deferred", "--when-idle", "--timeout", "600"];
    ok("yaat-service", [...args, "--dry-run"], darwin);
    const jobs = join(root, ".agent-team/releases/jobs");
    expect(existsSync(jobs)).toBe(false);
    executable(bin, "launchctl", `printf '%s\\n' "$@" > "$TRACE"; exit ${success ? 0 : 1}`);
    const result = run("yaat-service", args, darwin);
    expect(result.status, result.stderr).toBe(success ? 0 : 1);
    const [id] = readdirSync(jobs);
    const job = join(jobs, id);
    expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
      "bootstrap",
      "gui/1000",
      join(job, "controller.plist"),
    ]);
    const plist = readFileSync(join(job, "controller.plist"), "utf8");
    for (const field of [
      `com.yaat.deploy.${id}`,
      join(job, "controller.log"),
      join(bin, "launchctl"),
      "--when-idle",
      base,
    ])
      expect(plist).toContain(field);
    expect(statSync(join(job, "controller.log")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(job, "status.json"), "utf8")).toContain(
      success ? "queued" : "launch-failed",
    );
  },
);

it.skipIf(process.platform !== "darwin")(
  "records an early controller failure before unloading the LaunchAgent",
  () => {
    executable(bin, "launchctl", `printf '%s\\n' "$@" >> ${shellQuote(trace)}`);
    ok("yaat-service", ["deploy-deferred", "--when-idle", "--timeout", "10"], {
      YAAT_SERVICE_OS: "Darwin",
    });
    const jobs = join(root, ".agent-team/releases/jobs");
    const [id] = readdirSync(jobs);
    const job = join(jobs, id);
    const plist = spawnSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", join(job, "controller.plist")],
      { encoding: "utf8" },
    );
    const {
      ProgramArguments: [cmd, ...args],
      EnvironmentVariables,
    } = JSON.parse(plist.stdout) as {
      ProgramArguments: [string, ...string[]];
      EnvironmentVariables: Record<string, string>;
    };
    expect(existsSync(base)).toBe(false);
    const result = spawnSync(cmd, args, {
      env: { HOME: home, ...EnvironmentVariables },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(trace, "utf8");
    expect(calls).toContain(`bootout\ngui/1000/com.yaat.deploy.${id}`);
    expect(calls).not.toContain("kickstart");
    expect(JSON.parse(readFileSync(join(job, "status.json"), "utf8"))).toMatchObject({
      phase: "failed",
      error: "controller-failed",
    });
  },
);

function install(os = "Linux") {
  ok("yaat-service", ["install", "--no-start", "--no-build", "--no-auth"], { YAAT_SERVICE_OS: os });
}

function stubBundle() {
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "dist", "server.js"),
    `console.log(JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      node: process.env.YAAT_NODE_BIN,
      pi: process.env.YAAT_PI_BIN,
      pins: process.env.YAAT_RUNTIME_PINS,
    }));`,
  );
}

function traces() {
  return readFileSync(trace, "utf8");
}

describe("setup-prereqs.sh", () => {
  it("finds nvm in a minimal env without running npm, Pi, or installer commands during --check", () => {
    executable(bin, "node", "echo v24.1.0");
    const agentDir = join(home, ".pi", "agent");
    const auth = '{"test":{"token":"dummy-auth-token"}}';
    for (const extension of ["pi-subagents", "pi-antigravity-acp-provider"]) {
      mkdirSync(join(agentDir, "npm", "node_modules", extension), { recursive: true });
    }
    writeFileSync(join(agentDir, "auth.json"), auth);
    const output = ok("setup-prereqs", ["--check", "--strict"]);
    for (const name of ["brew", "openssl", "python3", "pip3"]) {
      expect(output).toMatch(new RegExp(`\\[warn\\] ${name} .*\\(optional\\)`));
    }
    expect(output).toContain(nvm.node);
    expect(output).toContain(nvm.npm);
    expect(output).toContain(nvm.pi);
    expect(output).not.toContain("dummy-auth-token");
    expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toBe(auth);
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(base)).toBe(false);
  });

  it("fails for missing required tools and only requires Pi auth and extensions in strict mode", () => {
    expect(ok("setup-prereqs", ["--check"])).toContain("auth.json not verified");
    expect(run("setup-prereqs", ["--strict"]).status).toBe(1);
    for (const [exe, diagnostic] of [
      [nvm.npm, "npm"],
      [nvm.pi, "pi"],
      [join(bin, "curl"), "curl"],
    ]) {
      rmSync(exe);
      const result = run("setup-prereqs", ["--check"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`[missing] ${diagnostic}`);
    }
    expect(existsSync(trace)).toBe(false);
  });

  it("does not install optional tooling when required macOS tools are available", () => {
    const output = ok("setup-prereqs", ["--install", "--dry-run"]);
    expect(output).not.toMatch(/brew|openssl|python/i);
    expect(output).toContain("npm:pi-subagents");
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(base)).toBe(false);
  });
});

describe("yaat-service.sh and start-server.sh", () => {
  it.each(["Linux", "Darwin"])(
    "pins the verified runtime for %s without starting a service",
    (os) => {
      install(os);
      expect(traces()).toBe("nvm-pi\n--version\n");
      const pins = join(base, ".yaat-runtime-paths");
      expect(readFileSync(pins, "utf8")).toBe(`${nvm.node}\n${nvm.npm}\n${nvm.pi}\n`);
      expect(readdirSync(base)).not.toContainEqual(
        expect.stringMatching(/^\.yaat-runtime-paths\./),
      );
      const service =
        os === "Linux" ? "units/agent-team-server.service" : "plists/com.yaat.server.plist";
      expect(readFileSync(join(root, service), "utf8")).toContain(base);
      expect(readFileSync(join(root, service), "utf8")).toContain("scripts/start-server.sh");

      const other = runtime(join(root, "other"), "v28.0.0", "other");
      const unrelated = { PATH: `${join(root, "other")}:${bin}`, YAAT_PI_BIN: other.pi };
      expect(ok("setup-prereqs", ["--check"], unrelated)).toContain(nvm.pi);
      stubBundle();
      expect(JSON.parse(ok("start-server", [], unrelated))).toEqual({
        args: [],
        cwd: root,
        node: nvm.node,
        pi: nvm.pi,
        pins,
      });
      install(os);
      expect(readFileSync(pins, "utf8")).toBe(`${nvm.node}\n${nvm.npm}\n${nvm.pi}\n`);
      ok("yaat-service", ["install", "--no-start", "--no-build"], {
        ...unrelated,
        YAAT_SERVICE_OS: os,
      });
      expect(readFileSync(pins, "utf8")).toBe(`${other.node}\n${other.npm}\n${other.pi}\n`);
    },
  );

  it("does not run Pi or write pins in a service install dry-run", () => {
    const output = ok("yaat-service", ["install", "--dry-run", "--no-start"]);
    expect(output).toContain("pin runtime");
    expect(output).toContain(nvm.node);
    expect(output).toContain("run build");
    expect(existsSync(base)).toBe(false);
    expect(existsSync(trace)).toBe(false);
  });

  it("generates credentials using verified Node without openssl", () => {
    ok("yaat-service", ["init-config"]);
    const config = readFileSync(join(base, "config.toml"), "utf8");
    expect(config).toMatch(/password = "[a-f0-9]{24}"/);
    expect(config).toMatch(/session_secret = "[a-f0-9]{64}"/);
  });

  it("forwards --doctor --json even if config and Pi are missing and does not write", () => {
    const brokenBundle = run("start-server", ["--doctor"]);
    expect(brokenBundle.status).toBe(1);
    expect(brokenBundle.stderr).toContain("dist/server.js not found");
    rmSync(nvm.pi);
    stubBundle();
    const diagnostic: unknown = JSON.parse(ok("start-server", ["--doctor", "--json"]));
    expect(diagnostic).toEqual({ args: ["--doctor", "--json"], cwd: root, node: nvm.node });
    const regular = run("start-server", []);
    expect(regular.status).toBe(1);
    expect(regular.stderr).toContain("config.toml not found");
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(base)).toBe(false);
  });

  it("does not fall back to unrelated Pi or Node if a service pin disappears", () => {
    install();
    stubBundle();
    const other = runtime(join(root, "other"), "v28.0.0", "other");
    const unrelated = { PATH: `${join(root, "other")}:${bin}` };
    rmSync(nvm.pi);
    const expected = { pi: nvm.pi, pins: join(base, ".yaat-runtime-paths") };
    expect(JSON.parse(ok("start-server", [], unrelated))).toMatchObject(expected);
    expect(JSON.parse(ok("start-server", ["--doctor"], unrelated))).toMatchObject(expected);
    expect(run("setup-prereqs", ["--check"], unrelated).status).toBe(1);
    rmSync(nvm.node);
    expect(run("start-server", ["--doctor"], unrelated).stderr).toContain(
      `executable: ${nvm.node}`,
    );
    expect(existsSync(other.node)).toBe(true);
  });

  it("rejects malformed pins without evaluating their contents", () => {
    install();
    const pins = join(base, ".yaat-runtime-paths");
    writeFileSync(pins, `printf 'evaluated' >> "$TRACE"\n${nvm.npm}\n${nvm.pi}\n`);
    const previousTrace = traces();
    const result = run("start-server", ["--doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`invalid runtime pins in ${pins}`);
    expect(traces()).toBe(previousTrace);
  });
});

describe("runtime-paths.sh version managers", () => {
  const installArgs = ["install", "--no-start", "--no-build", "--no-auth"];

  it.each(["directory", "files"])(
    "pins fnm's version bin instead of multishell %s links",
    (links) => {
      const installation = join(home, ".local/share/fnm/node-versions/v26.3.0/installation");
      const fnm = runtime(join(installation, "bin"), "v26.3.0", "fnm");
      const multishell = join(root, "fnm_multishells", "transient");
      const shellBin = join(multishell, "bin");
      mkdirSync(join(root, "fnm_multishells"));
      if (links === "directory") {
        symlinkSync(installation, multishell);
      } else {
        mkdirSync(shellBin, { recursive: true });
        for (const [name, target] of Object.entries(fnm)) symlinkSync(target, join(shellBin, name));
      }

      const active = { PATH: `${shellBin}:${bin}`, FNM_MULTISHELL_PATH: multishell };
      ok(
        "yaat-service",
        installArgs,
        links === "files" ? { ...active, YAAT_NODE_BIN: join(shellBin, "node") } : active,
      );
      const pins = readFileSync(join(base, ".yaat-runtime-paths"), "utf8");
      expect(pins).toBe(`${fnm.node}\n${fnm.npm}\n${fnm.pi}\n`);
      rmSync(multishell, { recursive: true });
      stubBundle();
      const actual: unknown = JSON.parse(ok("start-server", [], undefined, home));
      expect(actual).toMatchObject({ node: fnm.node, pi: fnm.pi });
    },
  );

  it("resolves only discovered mise shims in the install repo and pins their physical bins", () => {
    const data = join(home, "custom mise data");
    const shims = join(data, "shims");
    mkdirSync(shims, { recursive: true });
    const mise = runtime(join(data, "installs/node/26.3.0/bin"), "v26.3.0", "mise");
    rmSync(mise.npm);
    rmSync(mise.pi);
    const npmDir = join(data, "npm", "bin");
    const piDir = join(data, "pi", "bin");
    mkdirSync(npmDir, { recursive: true });
    mkdirSync(piDir, { recursive: true });
    executable(npmDir, "npm-cli.js", 'printf "%s\\n" "$PWD" "$(command -v node)" "$@" >> "$TRACE"');
    const npm = join(npmDir, "npm");
    symlinkSync("npm-cli.js", npm);
    const pi = executable(piDir, "pi", 'printf "%s\\n" "$@" >> "$TRACE"');
    const nodeAlias = join(data, "installs/node/latest");
    symlinkSync("26.3.0", nodeAlias);
    for (const name of ["node", "npm", "pi"]) {
      executable(shims, name, 'printf "%s\\n" shim >> "$TRACE"; exit 1');
    }
    executable(
      bin,
      "mise",
      `[[ $1 = which ]]
printf '%s\\n' "$PWD:$2" >> "$TRACE"
case "$2" in
  node) echo ${shellQuote(join(nodeAlias, "bin/node"))} ;;
  npm) echo ${shellQuote(npm)} ;;
  pi) echo ${shellQuote(pi)} ;;
esac`,
    );
    const active = { PATH: `${shims}:${bin}`, MISE_DATA_DIR: data };
    const checked = ok("setup-prereqs", ["--check"], active, home);
    for (const binary of [mise.node, npm, pi]) expect(checked).toContain(binary);
    expect(traces()).toBe(`${root}:node\n${root}:npm\n${root}:pi\n`);
    writeFileSync(trace, "");

    ok("yaat-service", ["install-deps"], active, home);
    expect(traces().trimEnd().split("\n")).toEqual([
      `${root}:node`,
      `${root}:npm`,
      root,
      mise.node,
      "install",
      "--global=false",
      "--location=project",
      "--prefix",
      root,
    ]);
    expect(existsSync(base)).toBe(false);
    expect(existsSync(join(root, "units"))).toBe(false);
    expect(existsSync(join(root, "plists"))).toBe(false);
    writeFileSync(trace, "");

    ok("yaat-service", installArgs, active, home);
    expect(readFileSync(join(base, ".yaat-runtime-paths"), "utf8")).toBe(
      `${mise.node}\n${npm}\n${pi}\n`,
    );
    const installTrace = `${root}:node\n${root}:npm\n${root}:pi\n--version\n`;
    expect(traces()).toBe(installTrace);
    stubBundle();
    const actual: unknown = JSON.parse(ok("start-server", [], active, home));
    expect(actual).toMatchObject({ node: mise.node, pi });
    expect(traces()).toBe(installTrace);
  });

  it("does not pin a mise response that still points to a shim", () => {
    const shims = join(home, ".local/share/mise/shims");
    mkdirSync(shims, { recursive: true });
    const shim = executable(shims, "node", 'printf "%s\\n" shim >> "$TRACE"; echo v26.9.0');
    executable(bin, "mise", `echo ${shellQuote(shim)}`);
    ok("yaat-service", installArgs, { PATH: `${shims}:${bin}` });
    expect(readFileSync(join(base, ".yaat-runtime-paths"), "utf8")).toBe(
      `${nvm.node}\n${nvm.npm}\n${nvm.pi}\n`,
    );
    expect(traces()).not.toContain("shim");
  });

  it.each([
    ["fnm", ".local/share/fnm/node-versions/v26.3.0/installation/bin"],
    ["mise", ".local/share/mise/installs/node/26.3.0/bin"],
  ])("finds a standard %s installation with no activated manager", (manager, dir) => {
    rmSync(join(home, ".nvm"), { recursive: true });
    const installed = runtime(join(home, dir), "v26.3.0", manager);
    expect(ok("setup-prereqs", ["--check"])).toContain(installed.node);
    expect(existsSync(trace)).toBe(false);
    ok("yaat-service", installArgs);
    expect(readFileSync(join(base, ".yaat-runtime-paths"), "utf8")).toBe(
      `${installed.node}\n${installed.npm}\n${installed.pi}\n`,
    );
  });
});

describe("yaat-service.sh install-deps", () => {
  it("uses the requested instance pins instead of the caller's runtime without changing the instance", () => {
    const instance = join(home, "installed instance");
    ok("yaat-service", [
      "install",
      "--no-start",
      "--no-build",
      "--no-auth",
      "--base-dir",
      instance,
    ]);
    const pinsPath = join(instance, ".yaat-runtime-paths");
    const configPath = join(instance, "config.toml");
    const pins = readFileSync(pinsPath, "utf8");
    const config = readFileSync(configPath, "utf8");
    const other = join(root, "other");
    const otherRuntime = runtime(other, "v28.0.0", "other");
    rmSync(nvm.pi);
    writeFileSync(trace, "");

    ok(
      "yaat-service",
      ["install-deps", "--base-dir", instance],
      {
        PATH: `${other}:${bin}`,
        YAAT_NODE_BIN: otherRuntime.node,
        YAAT_NPM_BIN: otherRuntime.npm,
      },
      home,
    );
    expect(traces().trimEnd().split("\n")).toEqual([
      "nvm-npm",
      "install",
      "--global=false",
      "--location=project",
      "--prefix",
      root,
      nvm.node,
      nvm.pi,
    ]);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(readFileSync(pinsPath, "utf8")).toBe(pins);
    expect(existsSync(base)).toBe(false);
  });

  it("prints the local install command without invoking npm or creating instance files in dry-run", () => {
    const output = ok("yaat-service", ["install-deps", "--dry-run"], undefined, home);
    expect(output).toContain("[dry-run]");
    expect(output.replaceAll("\\ ", " ")).toContain(nvm.npm);
    expect(output).toContain("install --global=false --location=project --prefix");
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(base)).toBe(false);
    expect(existsSync(join(root, "units"))).toBe(false);
  });
});

describe("deploy-deferred.sh", () => {
  it("uses the installed runtime for deploys from a different PATH", () => {
    install();
    const otherDir = join(root, "other");
    runtime(otherDir, "v28.0.0", "other");
    const unrelated = { PATH: `${otherDir}:${bin}` };
    executable(bin, "systemctl", 'printf "%s\\n" "systemctl $*" >> "$TRACE"');
    executable(bin, "systemd-run", 'printf "%s\\n" "$@" >> "$TRACE"');
    ok("yaat-service", ["deploy", "--verify", "--wait", "0"], unrelated);
    expect(traces()).toContain(`nvm-npm\nrun\ncheck\n${nvm.node}\n${nvm.pi}\n`);
    expect(traces()).toContain("systemctl --user restart agent-team-server.service");
    rmSync(nvm.pi);
    ok("yaat-service", ["deploy-deferred", "0"], unrelated);
    expect(traces()).toContain("--setenv=AGENT_TEAM_BASE_DIR");
    expect(traces()).toContain("--setenv=YAAT_NODE_BIN");
    expect(traces()).toContain("--setenv=YAAT_PI_BIN");
    expect(traces()).toContain(join(root, "scripts", "deploy-deferred.sh"));

    writeFileSync(trace, "");
    ok("deploy-deferred", ["0"], {
      ...unrelated,
      YAAT_DEPLOY_RESTART_CMD: 'printf "%s\\n" "fake restart" >> "$TRACE"',
    });
    expect(traces()).toBe(`nvm-npm\nrun\nbuild\n${nvm.node}\n${nvm.pi}\nfake restart\ncurl\n`);
    expect(readFileSync(env.YAAT_DEPLOY_LOG!, "utf8")).toContain("health check ok");
  });
});
