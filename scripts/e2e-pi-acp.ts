import { execFileSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ACP_PREPARE_STEP, inspectAcpRuntime } from "../service/src/session/acp-readiness";
import {
  discoverLocalPiPackages,
  packageSource,
  prepareControlledPiAgentHome,
} from "../service/src/session/pi-agent-home";
import { PiRpcClient } from "../service/src/session/pi-rpc";
import { PiSession } from "../service/src/session/pi";
import type { StreamEvent, UiDialogRequest } from "../service/src/session/types";

function processSnapshot() {
  return execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8",
    maxBuffer: 16 << 20,
    timeout: 1000,
  })
    .split("\n")
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
      return row
        ? [{ pid: Number(row[1]), parent: Number(row[2]), identity: row[3], command: row[4] }]
        : [];
    });
}

export function trackAcceptanceProcesses(markers: string[]) {
  const baseline = new Map(processSnapshot().map((row) => [row.pid, row.identity]));
  const owned = new Map<number, string>();
  function capture() {
    const rows = processSnapshot();
    const live = new Map(rows.map(({ pid, identity }) => [pid, identity]));
    let size: number;
    do {
      size = owned.size;
      for (const { pid, parent, identity, command } of rows) {
        if (
          pid === process.pid ||
          baseline.get(pid) === identity ||
          /(?:^|\/)ps -ww -axo /.test(command)
        )
          continue;
        if (
          parent === process.pid ||
          (live.has(parent) && owned.get(parent) === live.get(parent)) ||
          markers.some((marker) => command.includes(marker))
        )
          owned.set(pid, identity);
      }
    } while (size !== owned.size);
    return rows.filter(({ pid, identity }) => owned.get(pid) === identity).map(({ pid }) => pid);
  }
  let samplingError: unknown;
  const timer = setInterval(() => {
    try {
      capture();
    } catch (error) {
      samplingError = error;
    }
  }, 150);
  timer.unref();
  return {
    capture,
    observed: () => [...owned.keys()],
    async release(deadline: number) {
      clearInterval(timer);
      let remaining = capture();
      while (remaining.length && Date.now() < deadline) {
        await sleep(50);
        remaining = capture();
      }
      // Record the leak before emergency cleanup; it must never count as a pass.
      for (const pid of remaining) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (samplingError)
        throw new Error("Could not sample the acceptance process tree", { cause: samplingError });
      return remaining;
    },
  };
}

interface RunReport {
  status: "PASS" | "BLOCKED";
  reason?: string;
  elapsedMs: number;
  shutdownMs?: number;
  residualPids?: number[];
  observedPids?: number[];
  tempDirectoriesRemoved?: boolean;
  copiedGeminiFiles?: string[];
  stderr?: string;
  models: string[];
  model?: string;
  extensions: Array<{ name: string; version: string }>;
  dialogs: Array<{ method: string; response: string }>;
  child?: { taskId: string; status: string; reply: string };
}

function textEvents(events: StreamEvent[]) {
  return events
    .filter((event) => event.kind === "text")
    .map((event) => event.content)
    .join("");
}

async function turn(session: PiSession, prompt: string, events: StreamEvent[]) {
  const offset = events.length;
  const controller = new AbortController();
  try {
    const terminal = once(session, "done", { signal: controller.signal }).then(
      ([event]) => event as StreamEvent,
    );
    // A turn can fail before send() has returned its receipt.
    void terminal.catch(() => undefined);
    const receipt = await session.send(prompt);
    if (receipt.disposition === "rejected") throw new Error(receipt.error);
    const ended = await Promise.race([
      terminal,
      sleep(90_000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("ACP turn timed out");
      }),
    ]);
    if (ended.kind === "error") throw new Error(ended.content);
    return events.slice(offset);
  } finally {
    controller.abort();
  }
}

async function verifyRun(): Promise<RunReport> {
  const start = Date.now();
  const report: RunReport = {
    status: "BLOCKED",
    elapsedMs: 0,
    models: [],
    extensions: [],
    dialogs: [],
  };
  let root: string | undefined;
  let home: ReturnType<typeof prepareControlledPiAgentHome> | undefined;
  let session: PiSession | undefined;
  let tracker: ReturnType<typeof trackAcceptanceProcesses> | undefined;
  let phase = "preflight";
  let stderr = "";
  try {
    const hostHome = os.homedir();
    const sourceAgentDir = path.join(hostHome, ".pi", "agent");
    const sourceGeminiDir = path.join(hostHome, ".gemini");
    if (!fs.existsSync(path.join(sourceAgentDir, "auth.json")))
      throw new Error("Missing ~/.pi/agent/auth.json");
    const stateFiles = [
      "oauth_creds.json",
      "google_accounts.json",
      "antigravity-acp/acp_token.json",
      "antigravity-acp/settings.json",
    ];
    const presentState = stateFiles.filter((name) =>
      fs.existsSync(path.join(sourceGeminiDir, name)),
    );
    if (
      !presentState.some((name) => name === "oauth_creds.json" || name.endsWith("/acp_token.json"))
    )
      throw new Error(
        "Missing Gemini credentials: neither ~/.gemini/oauth_creds.json nor ~/.gemini/antigravity-acp/acp_token.json exists",
      );
    const dependencies = discoverLocalPiPackages(sourceAgentDir).packages.filter((entry) =>
      ["pi-subagents", "pi-antigravity-acp-provider"].includes(path.basename(packageSource(entry))),
    );
    if (dependencies.length !== 2)
      throw new Error("pi-subagents and pi-antigravity-acp-provider must be installed locally");
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yaat-acp-e2e-")));
    // Keep even partially initialized credential copies inside the cleanup root.
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      home = prepareControlledPiAgentHome({
        mode: "test-copied-creds",
        isolateGeminiHome: true,
        sourceAgentDir,
        sourceGeminiDir,
        packages: dependencies,
        piAcp: { permissions: "default", runtime_updates: "manual" },
      });
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
    }
    // The shared helper copies legacy Gemini OAuth files; agy also has a separate
    // file-backed store. Copy only the two known files, never the rest of that tree.
    for (const name of presentState.filter((name) => name.startsWith("antigravity-acp/"))) {
      const target = path.join(home.geminiHome!, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(sourceGeminiDir, name), target);
      fs.chmodSync(target, 0o600);
    }
    report.copiedGeminiFiles = presentState;
    const subagentsConfig = path.join(home.piAgentDir, "extensions", "subagent");
    fs.mkdirSync(subagentsConfig, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsConfig, "config.json"),
      JSON.stringify({ toolActivation: "eager" }),
    );
    const env = {
      ...home.env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_DATA_HOME: path.join(root, "share"),
      XDG_STATE_HOME: path.join(root, "state"),
      TMPDIR: root,
      AGY_ACP_BIN: "",
    };
    const { ready, value: installedRuntime } = inspectAcpRuntime();
    if (!ready) throw new Error(ACP_PREPARE_STEP);
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime);
    // Dereference any source link; the copied executable and its sibling are private to the run.
    for (const file of [
      installedRuntime,
      path.join(path.dirname(installedRuntime), "localharness_external"),
    ]) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(runtime, path.basename(file)));
    }
    env.AGY_ACP_BIN = path.join(runtime, path.basename(installedRuntime));
    const agentsDir = path.join(home.piAgentDir, "agents");
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(
      path.join(agentsDir, "acp-e2e-check.md"),
      "---\nname: acp-e2e-check\ndescription: Return the requested acceptance marker without using tools\nextensions: []\ntools: read\n---\nReturn only the requested marker. Do not use tools.\n",
    );
    const inventory = path.join(root, "extensions.json");
    const observer = path.join(root, "inventory.mjs");
    const childCall = path.join(root, "subagent-call.json");
    fs.writeFileSync(
      observer,
      `import fs from "node:fs";
export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "subagent") fs.writeFileSync(${JSON.stringify(childCall)}, JSON.stringify(event.input));
  });
  pi.on("session_start", async () => {
    fs.writeFileSync(${JSON.stringify(inventory)}, JSON.stringify(pi.getCommands().filter((command) => command.source === "extension")));
  });
}
`,
    );
    tracker = trackAcceptanceProcesses([root, home.piAgentDir, home.env.PI_SUBAGENTS_TEMP_ROOT]);
    phase = "Pi startup and ACP discovery";
    session = new PiSession(
      {
        backend: "pi",
        cwd: root,
        dataDir: root,
        piAgentDir: home.piAgentDir,
        piArgs: ["-e", observer],
      },
      {
        env,
        reconcileIntervalMs: 500,
        readyTimeoutMs: 20_000,
        rpcFactory: (options) => {
          const rpc = PiRpcClient.spawn(options);
          rpc.on("stderr", (chunk: string) => {
            stderr = (stderr + chunk).slice(-4000);
          });
          return rpc;
        },
      },
    );
    const events: StreamEvent[] = [];
    session.on("event", (event: StreamEvent) => events.push(event));
    session.on("error", () => undefined);
    session.on("ui_dialog_request", (dialog: UiDialogRequest) => {
      // No acceptance step requires granting tool, file or shell permissions.
      report.dialogs.push({ method: dialog.method, response: "cancelled" });
      session?.respondToUiDialog(dialog.requestId, {
        requestId: dialog.requestId,
        cancelled: true,
      });
    });
    await session.ensureStarted();
    const commands = fs.existsSync(inventory) ? fs.readFileSync(inventory, "utf8") : "";
    const extensionCommands = session
      .getCommands()
      .map(({ name }) => name)
      .join(" ");
    // Catalog readiness proves that the bridge registered the required ACP child extension.
    report.models = session
      .getAvailableModels()
      .map(({ provider, modelId }) => `${provider}/${modelId}`)
      .filter((id) => id.startsWith("antigravity-acp/"));
    if (!report.models.length) throw new Error("Pi did not discover any antigravity-acp/* models");
    report.extensions = dependencies.map((entry) => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(packageSource(entry), "package.json"), "utf8"),
      ) as { name: string; version: string };
      return { name: pkg.name, version: pkg.version };
    });
    if (!commands && !extensionCommands) throw new Error("Pi did not report extension commands");
    report.model =
      report.models.find((id) => /\/gemini-4-(hydrogen|neon)$/.test(id)) ?? report.models[0];
    console.error(
      `ACP models: ${report.models.join(", ")}; packages: ${report.extensions.map(({ name, version }) => `${name}@${version}`).join(", ")}; bridge: pi-panel-bridge.ts; commands: ${extensionCommands}`,
    );
    session.setModel(report.model);
    phase = "parent ACP turn";
    const answer = await turn(
      session,
      "Reply with only PI_ACP_PARENT_OK. Do not use tools.",
      events,
    );
    if (!textEvents(answer).includes("PI_ACP_PARENT_OK"))
      throw new Error("ACP parent response did not contain the acceptance marker");
    phase = "strict async ACP child";
    const offset = events.length;
    const childArgs = {
      agent: "acp-e2e-check",
      async: true,
      model: report.model,
      task: "Reply with only PI_ACP_CHILD_OK. Do not use tools.",
    };
    const launch = await turn(
      session,
      `Call the subagent tool exactly once with these arguments: ${JSON.stringify(childArgs)}. Do not answer on behalf of the child.`,
      events,
    );
    const childStart = launch.find(({ kind }) => kind === "subagent_start")?.subagent;
    const call = fs.existsSync(childCall)
      ? (JSON.parse(fs.readFileSync(childCall, "utf8")) as typeof childArgs)
      : undefined;
    if (
      !childStart ||
      call?.async !== true ||
      call.model !== report.model ||
      call.agent !== childArgs.agent
    )
      throw new Error("ACP parent did not make the requested explicit async child call");
    const deadline = Date.now() + 90_000;
    let child;
    do {
      child = events
        .slice(offset)
        .find(
          ({ kind, subagent }) =>
            kind === "subagent_done" && subagent?.taskId === childStart.taskId,
        )?.subagent;
      if (child) break;
      await sleep(200);
    } while (Date.now() < deadline);
    if (!child) throw new Error("Async ACP child did not reach terminal state");
    const reply = textEvents(child.events ?? []);
    report.child = {
      taskId: child.taskId,
      status: child.status ?? "unknown",
      reply: reply.includes("PI_ACP_CHILD_OK") ? "PI_ACP_CHILD_OK" : "marker absent",
    };
    if (child.status !== "completed" || !reply.includes("PI_ACP_CHILD_OK"))
      throw new Error(
        `Async ACP child ${child.status}: ${child.summary || "missing acceptance marker"}`,
      );
    report.status = "PASS";
  } catch (error) {
    report.reason = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    const closing = Date.now();
    const failures: string[] = [];
    try {
      tracker?.capture();
    } catch (error) {
      failures.push(String(error));
    }
    try {
      await session?.dispose(10_000);
    } catch (error) {
      failures.push(String(error));
    }
    try {
      report.residualPids = (await tracker?.release(closing + 10_000)) ?? [];
    } catch (error) {
      failures.push(String(error));
    }
    report.shutdownMs = Date.now() - closing;
    report.observedPids = tracker?.observed() ?? [];
    const directories = [
      root,
      home?.piAgentDir,
      home?.geminiHome,
      home?.env.PI_SUBAGENTS_TEMP_ROOT,
    ].filter((dir): dir is string => !!dir);
    for (const dir of directories) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        failures.push(String(error));
      }
    }
    report.tempDirectoriesRemoved = directories.every((dir) => !fs.existsSync(dir));
    if (!report.tempDirectoriesRemoved) failures.push("temporary directories remain");
    const redact = (text: string) =>
      text
        .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
        .replace(
          /((?:access_token|refresh_token|api[_-]?key)"?\s*[:=]\s*"?)[^\s"',}]+/gi,
          "$1[redacted]",
        );
    if (stderr.trim()) report.stderr = redact(stderr.trim());
    if (report.reason) report.reason = redact(report.reason);
    if (report.residualPids?.length)
      failures.push(`residual PIDs: ${report.residualPids.join(", ")}`);
    if (report.shutdownMs > 10_000) failures.push(`shutdown exceeded 10s: ${report.shutdownMs}ms`);
    if (failures.length) {
      report.status = "BLOCKED";
      report.reason = [report.reason, ...failures].filter(Boolean).join("; ");
    }
    report.elapsedMs = Date.now() - start;
  }
  return report;
}

async function main(args: string[]) {
  let runs = 1;
  let allowBlocked = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-blocked") allowBlocked = true;
    else if (args[i] === "--runs" && /^[1-9]\d*$/.test(args[i + 1] ?? "")) runs = Number(args[++i]);
    else throw new Error("Usage: npx tsx scripts/e2e-pi-acp.ts [--runs N] [--allow-blocked]");
  }
  if (!Number.isSafeInteger(runs)) throw new Error("--runs must be a positive safe integer");
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await verifyRun());
  const status = results.every((run) => run.status === "PASS") ? "PASS" : "BLOCKED";
  console.log(JSON.stringify({ status, runs: results }, null, 2));
  console.log(
    `\n## Pi ACP acceptance — STATUS: ${status}\n${results.map((run, i) => `- Run ${i + 1}: ${run.status} (${run.elapsedMs}ms) — ${run.reason ?? run.model}`).join("\n")}`,
  );
  if (status === "BLOCKED" && !allowBlocked) process.exitCode = 1;
}

if (path.basename(process.argv[1] ?? "") === "e2e-pi-acp.ts")
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
