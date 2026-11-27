import { fork, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { entryHint, rerunCommand, useNativeReporter } from "./test-reporter.mjs";

const [workspace, tier, ...args] = process.argv.slice(2);
const script = fileURLToPath(import.meta.url);
const repo = dirname(dirname(script));

function runAsync(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function timed(label, run) {
  const start = performance.now();
  const status = await run();
  console.log(`[${label}] ${((performance.now() - start) / 1000).toFixed(2)}s`);
  return status;
}

async function runRoot() {
  const workspaceRun = (workspace, tier, flags = []) =>
    runWorkspace(workspace, tier, flags, join(repo, workspace));
  const parallel = async (...runs) => (await Promise.all(runs)).find(Boolean) ?? 0;
  const workers = Math.max(1, Math.min(4, Math.ceil(availableParallelism() / 3)));
  const workerFlag = `--maxWorkers=${workers}`;
  const tooling = () => runAsync(["--test", "scripts/capture-tooling.test.ts"], repo);
  const browser = () => workspaceRun("webview", "browser", ["--from-suite", workerFlag]);
  const browserE2e = (files) =>
    workspaceRun("service", "e2e", [
      "--from-suite",
      "--fileParallelism",
      `--maxWorkers=${Math.min(2, workers)}`,
      ...files,
    ]);
  switch (tier) {
    case "unit":
      return (
        (await workspaceRun("service", tier, args)) ||
        (await workspaceRun("webview", tier, args)) ||
        (args.length ? 0 : tooling())
      );
    case "fast": {
      // Preserve CLI behavior (including native reporter stdout) for explicit arguments.
      if (args.length)
        return (await workspaceRun("service", tier, args)) || workspaceRun("webview", tier, args);
      return timed("fast", () =>
        parallel(workspaceRun("service", tier), workspaceRun("webview", tier)),
      );
    }
    case "browser":
      return workspaceRun("webview", tier, args);
    case "e2e":
      return workspaceRun("service", tier, args);
    case "slow": {
      const npm = process.env.npm_execpath;
      if (!npm || args.length) throw new Error("Use npm run test:slow without filters.");
      const stabilityE2e = async () =>
        // Build once before either worker can read dist/webview.
        (await runAsync(
          [npm, "run", "--silent", "build", "-w", "webview", "--", "--logLevel", "error"],
          repo,
        )) ||
        browserE2e([
          "demo-browser.test.ts",
          "journey-markdown-images.test.ts",
          "journey-pilot-subagent.test.ts",
        ]);
      return timed("slow", () =>
        parallel(
          runAsync([npm, "run", "check"], repo),
          workspaceRun("service", "unit", [
            workerFlag,
            "--exclude",
            "**/{deployment-scripts,deterministic-process-exit,export-anon-corpus,git-env,test-output-governance}.test.*",
          ]),
          workspaceRun("webview", "unit", [
            workerFlag,
            "--exclude",
            "**/{queue-journey,telemetry,pwa,browser-server,events,format,textKeys}.test.*",
          ]),
          browser(),
          stabilityE2e(),
          tooling(),
        ),
      );
    }
    case "ci": {
      const npm = process.env.npm_execpath;
      if (!npm || args.length) throw new Error("Use npm run test:ci without filters.");
      return timed("ci", async () => {
        const build = await runAsync([npm, "run", "build"], repo);
        if (build) return build;
        const units = parallel(
          workspaceRun("service", "unit", [workerFlag, "--tagsFilter=!shutdown-stress"]),
          workspaceRun("webview", "unit", [workerFlag]),
        );
        const browserReliability = async () =>
          (await browser()) ||
          (await browserE2e(["demo-browser.test.ts", "journey-", "telemetry-browser.test.ts"]));
        const common = await parallel(units, browserReliability(), tooling());
        if (common || process.platform !== "linux") return common;
        // Pi takes a host-level port baseline. Run it after all other test listeners close.
        return workspaceRun("service", "e2e", [
          "--from-suite",
          "pi-deterministic.test.ts",
          "pi-recovery-context.test.ts",
        ]);
      });
    }
  }
  throw new Error(`Unknown test tier: ${tier}`);
}

async function runWorkspace(workspace, tier, input, cwd = process.cwd()) {
  const args = [...input];
  const require = createRequire(join(cwd, "package.json"));
  const vitest = dirname(require.resolve("vitest/package.json"));
  const cli = join(vitest, "vitest.mjs");
  const config = {
    fast: "vitest.fast.config.mjs",
    browser: "vitest.browser.config.ts",
    e2e: "vitest.e2e.config.mjs",
  }[tier];
  const fromSuite = args[0] === "--from-suite";
  if (fromSuite) args.shift();
  const flags = [...(config ? ["--config", config] : []), ...args];
  if (flags.some((arg) => ["-h", "--help", "-v", "--version"].includes(arg))) {
    return runAsync([cli, "run", ...flags], cwd);
  }
  const { filter, options } = args.length
    ? (await import(pathToFileURL(require.resolve("vitest/node")).href)).parseCLI([
        "vitest",
        "run",
        ...flags,
      ])
    : { filter: [], options: {} };
  const hint = entryHint(tier, filter, options, process.env, fromSuite);
  // Keep machine-readable native stdout intact.
  if (hint) (options.reporter ? console.error : console.log)(hint);
  const delimiter = flags.indexOf("--");
  const insert = (extra) => flags.splice(delimiter < 0 ? flags.length : delimiter, 0, ...extra);
  if (
    useNativeReporter(options, process.env) ||
    options.watch ||
    options.ui ||
    options.standalone
  ) {
    if (!options.reporter && process.env.VERBOSE === "1") insert(["--reporter=verbose"]);
    return runAsync([cli, "run", ...flags], cwd);
  }

  // Run the real CLI, not startVitest directly: the CLI validates arguments and normalizes options.
  insert([
    "--no-color",
    "--includeTaskLocation",
    "--silent=passed-only",
    `--reporter=${join(repo, "scripts/test-reporter.mjs").replaceAll("\\", "/")}`,
  ]);
  const child = fork(cli, ["run", ...flags], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      YAAT_TEST_REPORTER_CONTEXT: JSON.stringify({ workspace, tier, args, cwd }),
    },
  });
  let reported = false;
  child.on("message", (message) => {
    if (message === "yaat:test-run-reported") reported = true;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code && !reported) console.error(`Rerun: ${rerunCommand(workspace, tier, args)}`);
      resolve(code ?? 1);
    });
  });
}

process.exitCode = await (workspace === "root" ? runRoot() : runWorkspace(workspace, tier, args));
