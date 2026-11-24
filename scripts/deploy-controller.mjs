import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const keys = ["pid", "bootId", "installedRepoDir", "label", "port", "baseDir", "releaseId"];
const generation = /^gen-[a-zA-Z0-9-]+$/;
const jobId = /^[a-zA-Z0-9-]{1,80}$/;
const baselineArtifacts = [
  "server.js",
  "history-worker.js",
  "webview/index.html",
  "webview/manifest.webmanifest",
];
const artifacts = [
  ...baselineArtifacts,
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
];

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function ownerOnly(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)
    throw new Error("Invalid deployment directory: " + dir);
}

export function controlRequest(baseDir, msg, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const socket = path.join(baseDir, "deploy-control/control.sock");
    const parent = fs.lstatSync(path.dirname(socket));
    const stat = fs.lstatSync(socket);
    if (
      !parent.isDirectory() ||
      parent.uid !== process.getuid() ||
      (parent.mode & 0o777) !== 0o700 ||
      !stat.isSocket() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error("Invalid deploy control socket permissions");
    const client = net.createConnection(socket, () => client.write(JSON.stringify(msg) + "\n"));
    const timer = setTimeout(() => client.destroy(new Error("Deploy control timed out")), timeout);
    let body = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) client.destroy(new Error("Invalid deploy control response"));
    });
    client.on("close", () => clearTimeout(timer));
    client.on("error", reject);
    client.on("end", () => {
      try {
        const value = JSON.parse(body);
        if (value.error) throw new Error(value.error);
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function identity(state) {
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

function verifyIdentity(state, expected) {
  if (
    !state ||
    !Number.isInteger(state.pid) ||
    state.pid <= 1 ||
    typeof state.bootId !== "string" ||
    !state.bootId ||
    typeof state.sealed !== "boolean" ||
    !state.blockers ||
    typeof state.blockers !== "object" ||
    Array.isArray(state.blockers) ||
    Object.values(state.blockers).some((n) => !Number.isInteger(n) || n < 0) ||
    Object.entries(expected).some(([k, v]) => state[k] !== v)
  )
    throw new Error("Deploy target identity mismatch or unsupported control protocol");
}

function pointer(root, name, release) {
  if (!generation.test(release)) throw new Error("Invalid release ID");
  const temporary = path.join(root, `.${name}.${process.pid}`);
  fs.symlinkSync(release, temporary);
  fs.renameSync(temporary, path.join(root, name));
}

function readPointer(root, name) {
  const file = path.join(root, name);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null;
  const release = fs.readlinkSync(file);
  if (!generation.test(release) || !fs.lstatSync(path.join(root, release)).isDirectory())
    throw new Error(`Invalid ${name} release pointer`);
  return release;
}

function current(root) {
  return readPointer(root, "current") ?? "legacy";
}

// Run under the same checkout lock as stage/cutover. A job is deletable only
// with explicit terminal status; absence or an unreadable status never proves
// completion. The grace period leaves its diagnostics available for a day.
export async function gcReleases({
  root,
  now = Date.now(),
  listProcesses = async () => {
    const { stdout } = await exec("/bin/ps", ["-ww", "-axo", "pid=,command="], {
      maxBuffer: 32 * 1024 * 1024,
    });
    if (!stdout.trim()) throw new Error("Could not enumerate live release processes");
    return stdout;
  },
}) {
  root = fs.realpathSync(root);
  ownerOnly(root);
  if (fs.lstatSync(path.join(root, "transaction.json"), { throwIfNoEntry: false }))
    throw new Error("Unresolved cutover: do not prune until recovery is complete");
  const currentRelease = readPointer(root, "current");
  const previous = readPointer(root, "previous");
  const protectedReleases = new Set([currentRelease, previous]);
  const verified = new Map();
  const jobs = path.join(root, "jobs");
  ownerOnly(jobs);
  const finished = new Map();
  for (const item of fs.readdirSync(jobs, { withFileTypes: true })) {
    const { name } = item;
    if (!item.isDirectory() || !jobId.test(name)) continue;
    const file = path.join(jobs, name, "status.json");
    const ownReleases = [`gen-${name}`, `gen-${name}-prior`];
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile()) throw new Error("invalid job status");
      const status = JSON.parse(fs.readFileSync(file, "utf8"));
      if (status.id !== name || status.recoveryRequired) throw new Error("job not proven finished");
      const healthy =
        status.phase === "succeeded"
          ? [status.candidate, status.prior]
          : status.phase === "rolled_back"
            ? [status.prior]
            : [];
      for (const release of healthy) {
        if (
          typeof release === "string" &&
          generation.test(release) &&
          release !== currentRelease &&
          fs.lstatSync(path.join(root, release), { throwIfNoEntry: false })?.isDirectory()
        ) {
          verified.set(release, Math.max(info.mtimeMs, verified.get(release) ?? 0));
        }
      }
      if (
        ["succeeded", "rolled_back", "failed", "cancelled", "timed_out"].includes(status.phase) &&
        now - info.mtimeMs >= 86_400_000
      ) {
        finished.set(name, ownReleases);
        continue;
      }
    } catch {
      /* Not proven finished. */
    }
    for (const release of ownReleases) protectedReleases.add(release);
  }
  // After a rollback both pointers can name the same generation. Retain a
  // known-good fallback, never a newer build that failed verification.
  if (!previous || previous === currentRelease) {
    const newestVerified = [...verified].sort((a, b) => b[1] - a[1])[0];
    if (newestVerified) protectedReleases.add(newestVerified[0]);
  }
  // start-server execs the absolute physical release path. Read the full
  // command line, on both launchd and systemd, without relying on a manager's
  // single MainPID (an old or independently launched process can outlive it).
  const processes = await listProcesses();
  const removed = { releases: [], jobs: [] };
  for (const [id, releases] of finished) {
    for (const release of releases) {
      if (
        protectedReleases.has(release) ||
        processes.includes(`${path.join(root, release)}${path.sep}`)
      )
        continue;
      const dir = path.join(root, release);
      if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      fs.rmSync(dir, { recursive: true });
      removed.releases.push(release);
    }
    // Keep ownership records while any associated generation may become
    // collectible later. Jobs with no staged directory can be removed now.
    if (
      releases.some((release) => fs.lstatSync(path.join(root, release), { throwIfNoEntry: false }))
    )
      continue;
    fs.rmSync(path.join(jobs, id), { recursive: true });
    removed.jobs.push(id);
  }
  return removed;
}

function validateArtifacts(dir, manifest = artifacts) {
  for (const file of manifest)
    if (!fs.lstatSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile())
      throw new Error(`Missing release artifact: ${file}`);
}

async function health(state, releaseDir) {
  const origin = `http://127.0.0.1:${state.port}`;
  const manifest = fs.readFileSync(path.join(releaseDir, "webview/manifest.webmanifest"));
  const icon = JSON.parse(manifest.toString()).icons?.find(({ src }) =>
    /^(?:\.\/|\/)?icons\/[\w.-]+$/.test(src),
  );
  if (!icon) throw new Error("Release has no public icon to verify");
  const iconPath = `/icons/${path.basename(icon.src)}`;
  for (const [url, expected] of [
    ["/manifest.webmanifest", manifest],
    [iconPath, fs.readFileSync(path.join(releaseDir, "webview", iconPath))],
  ]) {
    const response = await fetch(origin + url, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(expected))
      throw new Error("Release static health check failed");
  }
}

export function serviceManager(label, repo, env = process.env) {
  switch ((env.YAAT_SERVICE_OS || process.platform).toLowerCase()) {
    case "linux":
      return linuxManager(label, repo, env.YAAT_SYSTEMCTL_BIN || "systemctl");
    case "darwin":
      return darwinManager(
        label,
        repo,
        env.YAAT_LAUNCHCTL_BIN || "launchctl",
        env.YAAT_UID || process.getuid(),
      );
    default:
      throw new Error("Unsupported service manager");
  }
}

function darwinManager(label, repo, bin, uid) {
  const target = `gui/${uid}/${label}`;
  const launcher = path.join(repo, "scripts/start-server.sh");
  const inspect = async () => {
    const { stdout } = await exec(bin, ["print", target], { timeout: 1500 });
    // launchctl indents nested dictionaries with additional tabs. Only trust
    // top-level fields, never a matching substring inside the environment.
    const fields = (key) =>
      [...stdout.matchAll(new RegExp(`^\\t${key} = (.*)$`, "gm"))].map((m) => m[1]);
    const programs = fields("program");
    if (
      !stdout.startsWith(`${target} = {\n`) ||
      programs.length !== 1 ||
      !(
        programs[0] === launcher ||
        (programs[0] === "/bin/bash" &&
          fields("arguments").length === 1 &&
          stdout.includes(`\n\targuments = {\n\t\t/bin/bash\n\t\t${launcher}\n\t}\n`))
      )
    )
      throw new Error("Service manager launcher does not match the installed checkout");
    return fields("pid");
  };
  return {
    verifyLauncher: inspect,
    async verify(pid) {
      const pids = await inspect();
      if (pids.length !== 1 || !/^[1-9][0-9]*$/.test(pids[0]) || pids[0] !== String(pid))
        throw new Error("Service manager PID does not match the running server");
    },
    restart: () => exec(bin, ["kickstart", "-k", target], { timeout: 30_000 }),
  };
}

function linuxManager(label, repo, bin) {
  const unit = `${label}.service`;
  const show = async (prop) =>
    (
      await exec(bin, ["--user", "show", "--value", "-p", prop, unit], { timeout: 1500 })
    ).stdout.trim();
  const verifyLauncher = async () => {
    const launcher = await show("ExecStart");
    if (!launcher.startsWith(`{ path=${repo}/scripts/start-server.sh ;`))
      throw new Error("Service manager launcher does not match the installed checkout");
  };
  return {
    verifyLauncher,
    async verify(pid) {
      await verifyLauncher();
      if ((await show("MainPID")) !== String(pid))
        throw new Error("Service manager PID does not match the running server");
    },
    restart: () => exec(bin, ["--user", "restart", unit], { timeout: 30_000 }),
  };
}

function build(repo, dir, npm, abort) {
  const run = (workspace, extra) =>
    new Promise((resolve, reject) => {
      const child = spawn(npm, ["run", "build", "-w", workspace, ...extra], {
        cwd: repo,
        env: { ...process.env, YAAT_BUILD_OUT_DIR: dir },
        stdio: "inherit",
        signal: abort,
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Build failed: ${workspace}`)),
      );
    });
  return run("webview", ["--", "--outDir", path.join(dir, "webview")]).then(() =>
    run("service", []),
  );
}

// No operation before the decision file changes either live release pointer or
// the service. Cancellation competes for that file with the cutover, not with
// a poll in another process. The external controller owns post-commit recovery.
export async function deploy({
  root,
  job,
  id,
  target,
  timeoutMs,
  manager,
  stage,
  request = controlRequest,
  probe = health,
  now = () => performance.now(),
  pause = sleep,
}) {
  const deadline = now() + timeoutMs;
  const journal = path.join(root, "transaction.json");
  const decision = path.join(job, "decision");
  const write = (phase, fields = {}) =>
    atomicJson(path.join(job, "status.json"), { id, phase, ...fields });
  const stopping = () => {
    try {
      if (fs.readFileSync(decision, "utf8") === "cancel\n") return "cancelled";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return now() >= deadline ? "timed_out" : null;
  };
  let old,
    prior,
    candidate,
    attemptedSeal = false,
    journalWritten = false,
    committed = false,
    handoff = false,
    released = false;
  const stopped = () => (now() >= deadline ? "timed_out" : null);
  const rpc = (message, timeout) => request(target.baseDir, message, timeout);
  async function releaseBeforeHandoff() {
    const status = await rpc({ cmd: "unseal", ...identity(old), deployId: id });
    verifyIdentity(status, identity(old));
    if (status.sealed) throw new Error("Deployment admission is still sealed");
    released = true;
    if (journalWritten) {
      fs.unlinkSync(journal);
      journalWritten = false;
    }
  }
  try {
    if (fs.existsSync(journal))
      throw new Error("Unresolved cutover: inspect transaction.json before deploying");
    const before = current(root);
    old = await rpc({ cmd: "status" });
    verifyIdentity(old, { ...target, releaseId: before });
    await manager.verify(old.pid);
    if (stopping()) return write(stopping());
    candidate = `gen-${id}`;
    prior = before === "legacy" ? `gen-${id}-prior` : before;
    write("building", { candidate });
    const abort = new AbortController();
    const poll = setInterval(() => {
      if (stopping()) abort.abort();
    }, 100);
    try {
      const directory = path.join(root, candidate);
      fs.mkdirSync(directory, { mode: 0o700 });
      await stage(directory, abort.signal);
      validateArtifacts(directory);
      if (before === "legacy" && !stopping()) {
        const source = path.join(target.installedRepoDir, "dist");
        validateArtifacts(source, baselineArtifacts);
        fs.cpSync(source, path.join(root, prior), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
    } finally {
      clearInterval(poll);
    }

    while (!stopping()) {
      const status = await rpc({ cmd: "status" });
      verifyIdentity(status, identity(old));
      write("waiting", { candidate, blockers: status.blockers });
      if (!status.sealed && !Object.values(status.blockers).some(Boolean)) {
        attemptedSeal = true;
        const sealed = await rpc(
          { cmd: "seal", ...identity(old), deployId: id },
          Math.max(1, Math.min(10_000, deadline - now())),
        );
        verifyIdentity(sealed, identity(old));
        if (sealed.deployId === id && sealed.commitReady && !stopping()) {
          await manager.verify(old.pid);
          const check = await rpc({ cmd: "status" });
          verifyIdentity(check, identity(old));
          if (
            check.deployId === id &&
            check.commitReady &&
            check.leaseRemainingMs > 3000 &&
            current(root) === before &&
            !stopping()
          ) {
            // Claim the decision before asking the server to consume the lease.
            // No live pointer changes until it confirms the handoff.
            try {
              fs.writeFileSync(decision, "commit\n", { flag: "wx", mode: 0o600 });
            } catch (error) {
              if (error.code === "EEXIST") break;
              throw error;
            }
            atomicJson(journal, { id, candidate, prior, before: identity(old) });
            journalWritten = true;
            if (stopped()) {
              await releaseBeforeHandoff();
              return write("timed_out");
            }
            const commit = await rpc(
              { cmd: "seal", ...identity(old), deployId: id, commit: true },
              Math.max(1, Math.min(1000, deadline - now())),
            );
            verifyIdentity(commit, identity(old));
            if (!commit.committed || commit.deployId !== id || stopped()) {
              await releaseBeforeHandoff();
              if (stopped()) return write("timed_out");
              fs.unlinkSync(decision);
              released = false;
              continue;
            }
            committed = true;
            break;
          }
          await rpc({ cmd: "unseal", ...identity(old), deployId: id });
        }
      }
      if (!stopping()) await pause(Math.min(500, Math.max(1, deadline - now())));
    }
    if (!committed) return write(stopping() ?? "cancelled");

    write("restarting", { candidate, prior });
    pointer(root, "previous", prior);
    pointer(root, "current", candidate);
    handoff = true;

    let candidateIdentity;
    async function verify(release) {
      const until = now() + 15_000;
      let last;
      do {
        try {
          const status = await rpc({ cmd: "status" });
          verifyIdentity(status, { ...target, releaseId: release });
          if (
            status.pid === old.pid ||
            status.bootId === old.bootId ||
            (release === prior &&
              (status.pid === candidateIdentity?.pid ||
                status.bootId === candidateIdentity?.bootId))
          )
            throw new Error("Server has not changed boot");
          await manager.verify(status.pid);
          if (release === candidate) candidateIdentity = identity(status);
          await probe(status, path.join(root, release));
          return;
        } catch (error) {
          last = error;
        }
        await pause(250);
      } while (now() < until);
      throw last;
    }

    let failure;
    try {
      await manager.restart();
      write("verifying", { candidate, prior });
      await verify(candidate);
    } catch (error) {
      failure = error;
      write("rolling_back", { candidate, prior, error: error.message });
      await manager.verifyLauncher?.();
      if (current(root) !== candidate)
        throw new Error("Current release changed during cutover; manual recovery required");
      pointer(root, "current", prior);
      await manager.restart();
      await verify(prior);
    }
    fs.unlinkSync(journal);
    journalWritten = false;
    write(failure ? "rolled_back" : "succeeded", { candidate, prior, error: failure?.message });
  } catch (error) {
    let recoveryError;
    if (journalWritten && !handoff) {
      try {
        await releaseBeforeHandoff();
      } catch (failure) {
        recoveryError = failure;
      }
    }
    const stoppedPhase = !committed && !recoveryError && stopping();
    write(stoppedPhase || "failed", {
      candidate,
      prior,
      error: recoveryError
        ? `${error.message}; could not verify unseal: ${recoveryError.message}`
        : error.message,
      recoveryRequired: journalWritten,
    });
    if (!stoppedPhase) throw error;
  } finally {
    if (attemptedSeal && old && !handoff && !released && !journalWritten)
      await rpc({ cmd: "unseal", ...identity(old), deployId: id }).catch(() => {});
  }
}

async function main() {
  const [cmd, repoArg, id, seconds] = process.argv.slice(2);
  if (cmd !== "gc" && !jobId.test(id ?? "")) throw new Error("Invalid deploy ID");
  const repo = fs.realpathSync(repoArg);
  const control = path.join(repo, ".agent-team");
  fs.mkdirSync(control, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(control).isDirectory()) throw new Error("Invalid release parent");
  const root = path.join(control, "releases");
  ownerOnly(root);
  const jobs = path.join(root, "jobs");
  ownerOnly(jobs);
  if (cmd === "gc") return console.log(JSON.stringify(await gcReleases({ root })));
  const job = path.join(jobs, id);
  if (cmd === "prepare") {
    fs.mkdirSync(job, { mode: 0o700 });
    atomicJson(path.join(job, "status.json"), { id, phase: "queued" });
    return;
  }
  if (!fs.lstatSync(job).isDirectory()) throw new Error("Invalid deployment job");
  if (cmd === "status")
    return console.log(fs.readFileSync(path.join(job, "status.json"), "utf8").trim());
  if (cmd === "cancel") {
    const state = JSON.parse(fs.readFileSync(path.join(job, "status.json")));
    if (!["queued", "building", "waiting"].includes(state.phase))
      throw new Error(`Cannot cancel a ${state.phase} job`);
    fs.writeFileSync(path.join(job, "decision"), "cancel\n", { flag: "wx", mode: 0o600 });
    return console.log(`Cancellation requested: ${id}`);
  }
  // The launchd wrapper also catches failures before deploy() starts. Never
  // overwrite a controller's diagnostics or its post-cutover recovery state.
  if (
    cmd === "controller-failed" &&
    JSON.parse(fs.readFileSync(path.join(job, "status.json"))).phase !== "queued"
  )
    return;
  if (cmd === "lock-failed" || cmd === "launch-failed" || cmd === "controller-failed")
    return atomicJson(path.join(job, "status.json"), { id, phase: "failed", error: cmd });
  if (cmd !== "run" || !/^[1-9][0-9]*$/.test(seconds) || Number(seconds) > 86400)
    throw new Error("Invalid deploy command or timeout");
  const {
    AGENT_TEAM_BASE_DIR: base,
    AGENT_TEAM_PORT: port,
    YAAT_SERVICE_LABEL: label,
    YAAT_NPM_BIN: npm,
  } = process.env;
  if (
    !base ||
    !label ||
    !npm ||
    !/^[0-9]+$/.test(port ?? "") ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw new Error("Missing deployment target or pinned build tools");
  const target = {
    installedRepoDir: repo,
    baseDir: fs.realpathSync(base),
    port: Number(port),
    label,
  };
  await deploy({
    root,
    job,
    id,
    target,
    timeoutMs: Number(seconds) * 1000,
    manager: serviceManager(label, repo),
    stage: (dir, signal) => build(repo, dir, npm, signal),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
