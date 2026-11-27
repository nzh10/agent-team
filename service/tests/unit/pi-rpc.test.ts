import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { piFrame } from "../snap/pi-wire";
import { waitForState } from "../e2e/pilot-assertions";
import * as os from "node:os";
import * as path from "node:path";
import type { WritableOptions } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverLocalPiPackages,
  inspectPiAcpProfile,
  prepareControlledPiAgentHome,
  type PiPackageEntry,
  type PrepareControlledPiAgentHomeOptions,
} from "../../src/session/pi-agent-home";
import {
  LfJsonLineDecoder,
  MAX_FRAME_BYTES,
  PiRpcClient,
  PiRpcFrameError,
  runBudgetedShutdown,
  verifyPidCommand,
} from "../../src/session/pi-rpc";
import { createPiWireTransport } from "./helpers/pi-wire-harness";

function frameError(run: () => unknown): PiRpcFrameError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PiRpcFrameError);
    return error as PiRpcFrameError;
  }
  throw new Error("expected a frame error");
}

function recordingClient() {
  const writes: Buffer[] = [];
  const { stdin, stdout, emit } = createPiWireTransport({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk as Uint8Array));
      callback();
    },
  });
  const client = new PiRpcClient({ stdin, stdout }, { requestTimeoutMs: 2_000 });
  return { client, stdout, emit, writes };
}

function capturedResponse(command: "get_session_stats" | "prompt" | "steer", id: string) {
  return { ...piFrame("response", { command }), id };
}

const pngImages = () => [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }];

function backpressuredClient(write: WritableOptions["write"]) {
  const { stdin, stdout } = createPiWireTransport({ highWaterMark: 1, write });
  const client = new PiRpcClient({ stdin, stdout }, { requestTimeoutMs: 5_000 });
  return { stdin, stdout, client };
}

async function flushWrites(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("LfJsonLineDecoder", () => {
  it("frames LF and CRLF, strips only the adjacent CR, and skips blank lines", () => {
    const decoder = new LfJsonLineDecoder();
    expect(decoder.push('{"a":1}\r\n\n{"b":"x\\r"}\n')).toEqual([{ a: 1 }, { b: "x\r" }]);
    expect(decoder.end()).toEqual([]);
  });

  it("does not split U+2028 or U+2029 and decodes UTF-8 across chunks", () => {
    const decoder = new LfJsonLineDecoder();
    const input = Buffer.from('{"text":"前\u2028中\u2029後🙂"}\n');
    const messages: unknown[] = [];
    for (const byte of input) messages.push(...decoder.push(Buffer.from([byte])));
    expect(messages).toEqual([{ text: "前\u2028中\u2029後🙂" }]);
    expect(decoder.end()).toEqual([]);
  });

  it("rejects an oversized default-limit frame and permanently stops decoding", () => {
    const decoder = new LfJsonLineDecoder();
    const error = frameError(() => decoder.push(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x20)));
    expect(error.code).toBe("frame_too_large");
    expect(() => decoder.push("\n")).toThrow(error);
  });

  it("enforces a custom byte limit before accepting a delimiter", () => {
    const decoder = new LfJsonLineDecoder(4);
    expect(decoder.push("1234\n")).toEqual([1234]);
    expect(frameError(() => decoder.push("12345\n")).code).toBe("frame_too_large");
    expect(frameError(() => new LfJsonLineDecoder(2).push("🙂")).code).toBe("frame_too_large");
  });

  it("reports a non-whitespace incomplete tail frame at EOF", () => {
    const decoder = new LfJsonLineDecoder();
    decoder.push('{"id":1}');
    expect(frameError(() => decoder.end()).code).toBe("incomplete_tail_frame");
    expect(new LfJsonLineDecoder().end()).toEqual([]);
    const whitespaceOnly = new LfJsonLineDecoder();
    expect(whitespaceOnly.push("  \r")).toEqual([]);
    expect(whitespaceOnly.end()).toEqual([]);
  });
});

describe("PiRpcClient", () => {
  it("matches out-of-order responses and drains concurrent stdout messages synchronously", async () => {
    const { client, stdout, emit, writes } = recordingClient();
    const first = client.prompt("one");
    const second = client.getSessionStats();
    await flushWrites();
    const commands = writes.map(
      (bytes) => JSON.parse(bytes.toString()) as { id: string; type: string },
    );
    expect(commands.map((command) => command.id)).toEqual(["req-1", "req-2"]);

    let firstSettled = false;
    void first.finally(() => {
      firstSettled = true;
    });
    const stats = capturedResponse("get_session_stats", "req-2");
    emit(stats);
    await expect(second).resolves.toEqual(stats.data);
    expect(firstSettled).toBe(false);

    const prompt = capturedResponse("prompt", "req-1");
    const settled = piFrame("agent_settled");
    const events: unknown[] = [];
    client.on("event", (e) => events.push(e));
    emit(prompt, settled);
    expect(events).toEqual([settled]);
    await expect(first).resolves.toEqual(prompt.data);
    stdout.end();
  });

  it("writes a steer with image blocks, returning acceptance rather than delivery", async () => {
    const { client, stdout, emit, writes } = recordingClient();
    const result = client.steer("follow", { images: pngImages() });
    await flushWrites();
    expect(JSON.parse(writes[0].toString())).toEqual({
      type: "steer",
      id: "req-1",
      message: "follow",
      images: pngImages(),
    });
    emit(capturedResponse("steer", "req-1"));
    await expect(result).resolves.toEqual({ disposition: "queued" });
    stdout.end();
  });

  it("runs onBeforeWrite synchronously immediately before prompt bytes and preserves images", async () => {
    const order: string[] = [];
    let resolveWrite: (() => void) | undefined;
    const { stdin, stdout, emit } = createPiWireTransport({
      write(chunk, _encoding, callback) {
        const command = JSON.parse(Buffer.from(chunk).toString()) as {
          id: string;
          message: string;
          images?: unknown[];
        };
        order.push("write");
        expect(command.message).toBe("hello");
        expect(command.images).toEqual(pngImages());
        emit(capturedResponse("prompt", command.id));
        callback();
        resolveWrite?.();
      },
    });
    const client = new PiRpcClient({ stdin, stdout });
    const written = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const result = client.prompt("hello", {
      images: pngImages(),
      onBeforeWrite: () => order.push("before"),
    });
    await written;
    expect(order).toEqual(["before", "write"]);
    await expect(result).resolves.toEqual({ disposition: "started" });
    stdout.end();
  });

  it("rejects both a backpressured request and queued writes on stdin error", async () => {
    let finishWrite: (() => void) | undefined;
    const { stdin, stdout, client } = backpressuredClient((_chunk, _encoding, callback) => {
      finishWrite = () => callback();
    });
    const pending = client.getState();
    await flushWrites();
    const queued = client.sendExtensionUIResponse({
      type: "extension_ui_response",
      id: "dialog-1",
      cancelled: true,
    });
    stdin.destroy(new Error("stdin failed"));
    await expect(pending).rejects.toThrow("stdin failed");
    await expect(queued).rejects.toThrow("stdin failed");
    expect(finishWrite).toBeDefined();
    stdout.end();
  });

  it("wakes pending requests and drain waiters on a clean stdin close", async () => {
    const { stdin, stdout, client } = backpressuredClient(() => {
      // Keep the write unfinished so the client is waiting for drain.
    });
    const pending = client.getCommands();
    await flushWrites();
    stdin.destroy();
    await expect(pending).rejects.toThrow("stdin closed");
    stdout.end();
  });
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("runBudgetedShutdown", () => {
  it.skipIf(process.platform === "win32")(
    "reaps a real detached grandchild in another process group after its parent exits",
    { tags: ["shutdown-stress"], timeout: 15_000 },
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-pgid-test-"));
      temporaryDirectories.push(directory);
      const pidFile = path.join(directory, "grandchild.pid");
      const token = `pi-rpc-detached-${process.pid}-${Date.now()}`;
      const parentSource = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); // ${token}"], {
        detached: true,
        stdio: "ignore",
      });
      fs.writeFileSync(process.argv[1], String(child.pid));
      process.stdin.on("end", () => process.exit(0));
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `;
      const parent = spawn(process.execPath, ["-e", parentSource, pidFile], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      let grandchildPid = 0;
      try {
        grandchildPid = await waitForState(
          "detached grandchild PID is published",
          () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0),
          (pid) => Number.isSafeInteger(pid) && pid > 0,
        );
        const parentPgid = Number(
          execFileSync("ps", ["-o", "pgid=", "-p", String(parent.pid)], { encoding: "utf8" }),
        );
        const childPgid = Number(
          execFileSync("ps", ["-o", "pgid=", "-p", String(grandchildPid)], { encoding: "utf8" }),
        );
        expect(childPgid).toBe(grandchildPid);
        expect(parentPgid).not.toBe(childPgid);
        await expect(verifyPidCommand(grandchildPid, [token])).resolves.toBe(true);

        await runBudgetedShutdown({
          totalTimeoutMs: 10_000,
          child: parent,
          stdin: parent.stdin,
          stopDetachedChildren: () => Promise.resolve([{ pid: grandchildPid, matchers: [token] }]),
        });
        expect(parent.exitCode).toBe(0);
        await expect(verifyPidCommand(grandchildPid, [token])).resolves.toBe(false);
      } finally {
        if (parent.exitCode === null && parent.signalCode === null && parent.pid) {
          try {
            process.kill(-parent.pid, "SIGKILL");
          } catch {
            // The graceful path already exited.
          }
        }
        if (grandchildPid > 0) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // The shutdown helper already reaped it.
          }
        }
      }
    },
  );
});

describe("prepareControlledPiAgentHome", () => {
  const providerSource = "npm:pi-antigravity-acp-provider";
  const subagentsSource = "npm:pi-subagents";
  const subagents = { agentOverridesByProvider: { test: { reviewer: { model: "test/model" } } } };

  function packageRoot(sourceAgentDir: string, source: string): string {
    return path.join(sourceAgentDir, "npm", "node_modules", source.slice(4));
  }

  function writeExtension(root: string, relative: string): string {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export {};\n");
    return fs.realpathSync.native(file);
  }

  function writePackages(sourceAgentDir: string, ...packages: PiPackageEntry[]): void {
    fs.writeFileSync(path.join(sourceAgentDir, "settings.json"), JSON.stringify({ packages }));
  }

  function writeExtensionManifest(root: string, extensions: string[]): void {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ pi: { extensions } }));
  }

  function makeSource({ subagentsExtension = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-source-test-"));
    temporaryDirectories.push(root);
    const sourceAgentDir = path.join(root, "agent");
    const sourceGeminiDir = path.join(root, "gemini");
    fs.mkdirSync(path.join(sourceAgentDir, "npm", "node_modules"), { recursive: true });
    fs.mkdirSync(sourceGeminiDir, { recursive: true });
    fs.mkdirSync(path.join(sourceAgentDir, "agents"));
    const localPackages = ["nzh10-skills", "nzh10-skills/packages/pi-skillful"];
    for (const relative of localPackages) {
      fs.mkdirSync(path.join(sourceAgentDir, relative), { recursive: true });
    }
    const npmPackages = [
      "pi-subagents",
      "pi-antigravity-acp-provider",
      "pi-btw",
      "pi-intercom",
      "pi-autoresearch",
    ];
    for (const name of npmPackages) {
      fs.mkdirSync(path.join(sourceAgentDir, "npm", "node_modules", name), { recursive: true });
    }
    writeExtension(packageRoot(sourceAgentDir, providerSource), "extensions/index.ts");
    if (subagentsExtension) {
      const root = packageRoot(sourceAgentDir, subagentsSource);
      writeExtension(root, "bundle/index.js");
      writeExtensionManifest(root, ["./bundle/index.js"]);
    }
    fs.writeFileSync(path.join(sourceAgentDir, "auth.json"), '{"token":"secret"}\n', {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(sourceGeminiDir, "oauth_creds.json"), '{"access":"secret"}\n');
    fs.writeFileSync(path.join(sourceGeminiDir, "google_accounts.json"), '{"account":"test"}\n');
    fs.writeFileSync(
      path.join(sourceAgentDir, "settings.json"),
      JSON.stringify({
        packages: [
          path.join(sourceAgentDir, "nzh10-skills"),
          "npm:pi-antigravity-acp-provider",
          "npm:pi-subagents",
          "npm:pi-intercom",
          "npm:pi-btw",
          "npm:pi-autoresearch",
          path.join(sourceAgentDir, "nzh10-skills/packages/pi-skillful"),
        ],
        subagents,
        enabledModels: ["test/model"],
        defaultProvider: "test",
        defaultModel: "model",
      }),
    );
    const dataDir = path.join(root, "data");
    const runtime = (
      options?: Omit<PrepareControlledPiAgentHomeOptions, "mode" | "sourceAgentDir" | "dataDir">,
    ) => prepareControlledPiAgentHome({ mode: "runtime", sourceAgentDir, dataDir, ...options });
    return { sourceAgentDir, sourceGeminiDir, dataDir, runtime };
  }

  function readRuntimeSettings(home: { settingsPath: string }) {
    return JSON.parse(fs.readFileSync(home.settingsPath, "utf8")) as {
      defaultProjectTrust?: string;
      packages: PiPackageEntry[];
      enabledModels?: string[];
      defaultProvider?: string;
      defaultModel?: string;
    };
  }

  function expectNoSymlinks(directory: string): void {
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        expect(entry.isSymbolicLink(), entryPath).toBe(false);
        if (entry.isDirectory()) walk(entryPath);
      }
    };
    walk(directory);
  }

  function expectControlledSettings(settingsPath: string): void {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      defaultProjectTrust: string;
      packages: string[];
      enabledModels: string[];
      defaultProvider: string;
      defaultModel: string;
    };
    expect(settings.defaultProjectTrust).toBe("always");
    expect(settings.enabledModels).toEqual(["test/model"]);
    expect(settings.defaultProvider).toBe("test");
    expect(settings.defaultModel).toBe("model");
    expect(settings.packages.every(path.isAbsolute)).toBe(true);
    expect(settings.packages.some((entry) => entry.startsWith("npm:"))).toBe(false);
    expect(settings.packages.map((entry) => path.basename(entry))).toEqual([
      "nzh10-skills",
      "pi-intercom",
      "pi-btw",
      "pi-autoresearch",
      "pi-skillful",
      "pi-subagents",
      "pi-antigravity-acp-provider",
    ]);
    expect(
      settings.packages.indexOf(
        settings.packages.find((entry) => path.basename(entry) === "pi-subagents")!,
      ),
    ).toBeLessThan(
      settings.packages.indexOf(
        settings.packages.find((entry) => path.basename(entry) === "pi-antigravity-acp-provider")!,
      ),
    );
  }

  function expectIsolatedRouting(home: { settingsPath: string; piAgentDir: string }): void {
    expect(readRuntimeSettings(home)).not.toHaveProperty("subagents");
    expect(fs.readdirSync(home.piAgentDir)).not.toContain("agents");
  }

  it("reflects host routing and agent definitions in the persistent runtime home", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const home = runtime();
    expect(readRuntimeSettings(home)).toHaveProperty("subagents", subagents);
    const agents = path.join(sourceAgentDir, "agents");
    expect(fs.readlinkSync(path.join(home.piAgentDir, "agents"))).toBe(agents);

    fs.rmdirSync(agents);
    fs.unlinkSync(path.join(sourceAgentDir, "settings.json"));
    expectIsolatedRouting(runtime());
  });

  const networkSettings = {
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 250, extra: { values: [1, 2] } },
    transport: "sse",
    httpProxy: "http://proxy.example.invalid:8080",
    httpIdleTimeoutMs: 30_000,
    websocketConnectTimeoutMs: 12_000,
  };

  it("forwards runtime retry and network settings and drops them when removed from the source", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const sourcePath = path.join(sourceAgentDir, "settings.json");
    fs.writeFileSync(sourcePath, JSON.stringify({ ...networkSettings, subagents, theme: "dark" }));
    const home = runtime();
    const managedDefaults = { defaultProjectTrust: "always", packages: [] };
    expect(readRuntimeSettings(home)).toEqual({
      ...managedDefaults,
      ...networkSettings,
      subagents,
    });

    fs.writeFileSync(sourcePath, JSON.stringify({ subagents }));
    runtime();
    expect(readRuntimeSettings(home)).toEqual({
      ...managedDefaults,
      subagents,
    });
  });

  it.each(["test-copied-creds", "test-synthetic"] as const)(
    "does not forward host retry or network settings in %s mode",
    (mode) => {
      const { sourceAgentDir } = makeSource();
      fs.writeFileSync(path.join(sourceAgentDir, "settings.json"), JSON.stringify(networkSettings));
      const home = prepareControlledPiAgentHome({ mode, sourceAgentDir });
      temporaryDirectories.push(home.piAgentDir, home.env.PI_SUBAGENTS_TEMP_ROOT);
      if (home.geminiHome) temporaryDirectories.push(home.geminiHome);
      expect(readRuntimeSettings(home)).toEqual({
        defaultProjectTrust: "always",
        packages: [],
      });
    },
  );

  it("links the user model catalog but only seeds the managed model cache once", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const catalog = path.join(sourceAgentDir, "models.json");
    const hostCache = path.join(sourceAgentDir, "models-store.json");
    fs.writeFileSync(catalog, "{}\n");
    fs.writeFileSync(hostCache, '{"source":true}');
    const { piAgentDir } = runtime();
    const managed = path.join(piAgentDir, "models-store.json");
    const link = path.join(piAgentDir, "models.json");
    expect(fs.readlinkSync(link)).toBe(catalog);
    const inode = fs.lstatSync(link).ino;
    expect(fs.lstatSync(managed).isFile()).toBe(true);
    expect(fs.readFileSync(managed, "utf8")).toBe('{"source":true}');
    fs.writeFileSync(managed, '{"managed":true}');
    runtime();
    expect(fs.readFileSync(managed, "utf8")).toBe('{"managed":true}');
    expect(fs.readFileSync(hostCache, "utf8")).toBe('{"source":true}');
    expect(fs.lstatSync(link).ino).toBe(inode);
    fs.unlinkSync(catalog);
    runtime();
    expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("maps the first host ACP login and sees a subsequent relogin without preparing a new release", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const providerDir = "antigravity-acp-provider";
    const tokenPath = "gemini/antigravity-acp/acp_token.json";
    const host = path.join(sourceAgentDir, providerDir);
    const initial = runtime();
    const managed = path.join(initial.piAgentDir, providerDir);
    expect(fs.existsSync(path.join(managed, "gemini"))).toBe(false);
    fs.mkdirSync(path.join(managed, "gemini")); // Legacy empty store can be replaced safely.
    fs.mkdirSync(path.dirname(path.join(host, tokenPath)), { recursive: true });
    fs.writeFileSync(path.join(host, tokenPath), '{"refresh_token":"fake-first"}');
    fs.writeFileSync(path.join(host, "sessions.json"), "host sessions");
    fs.writeFileSync(path.join(host, "config.json"), "host config");
    fs.writeFileSync(path.join(sourceAgentDir, "unowned.json"), "private host file");
    fs.writeFileSync(path.join(managed, "sessions.json"), "managed sessions");

    const next = runtime();
    expect(next.piAcpAuthError).toBeUndefined();
    expect(next.resolvedPackages.piAntigravityEntryPath).toBe(
      initial.resolvedPackages.piAntigravityEntryPath,
    );
    expect(fs.realpathSync(path.join(managed, "gemini"))).toBe(
      fs.realpathSync(path.join(host, "gemini")),
    );
    expect(fs.readFileSync(path.join(managed, tokenPath), "utf8")).toBe(
      '{"refresh_token":"fake-first"}',
    );
    expect(fs.readFileSync(path.join(managed, "sessions.json"), "utf8")).toBe("managed sessions");
    expect(fs.lstatSync(path.join(managed, "config.json")).isFile()).toBe(true);
    expect(fs.lstatSync(next.settingsPath).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(host, "config.json"), "utf8")).toBe("host config");
    expect(fs.existsSync(path.join(next.piAgentDir, "unowned.json"))).toBe(false);

    const link = fs.lstatSync(path.join(managed, "gemini"));
    fs.writeFileSync(path.join(host, tokenPath + ".new"), '{"refresh_token":"fake-next"}');
    fs.renameSync(path.join(host, tokenPath + ".new"), path.join(host, tokenPath));
    const latest = runtime();
    expect(latest.piAcpAuthError).toBeUndefined();
    expect(fs.lstatSync(path.join(managed, "gemini")).ino).toBe(link.ino);
    expect(fs.readFileSync(path.join(managed, tokenPath), "utf8")).toBe(
      '{"refresh_token":"fake-next"}',
    );
  });

  it.each(["different credentials", "identical credentials", "runtime subdirectories"])(
    "leaves a separate nonempty managed ACP store intact with %s",
    (contents) => {
      const { sourceAgentDir, dataDir, runtime } = makeSource();
      const relative = "antigravity-acp-provider/gemini/antigravity-acp";
      const host = path.join(sourceAgentDir, relative);
      const managed = path.join(dataDir, "pi-agent-home", relative);
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(managed, { recursive: true });
      const file = "acp_token.json";
      const hostToken = '{"refresh_token":"fake-host"}';
      const managedToken =
        contents === "identical credentials" ? hostToken : '{"refresh_token":"fake-managed"}';
      fs.writeFileSync(path.join(host, file), hostToken);
      if (contents === "runtime subdirectories") fs.mkdirSync(path.join(managed, "conversations"));
      else fs.writeFileSync(path.join(managed, file), managedToken);

      const home = runtime();
      expect(home.piAcpAuthError).toContain("separate");
      expect(home.piAcpAuthError).toContain("move the managed gemini directory");
      expect(home.resolvedPackages.piAntigravityEntryPath).toBeUndefined();
      expect(home.resolvedPackages.piSubagentsRoot).toBeDefined();
      expect(fs.readFileSync(home.settingsPath, "utf8")).not.toContain(
        "pi-antigravity-acp-provider",
      );
      expect(fs.lstatSync(path.dirname(managed)).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(host, file), "utf8")).toBe(hostToken);
      if (contents === "runtime subdirectories")
        expect(fs.readdirSync(managed)).toEqual(["conversations"]);
      else expect(fs.readFileSync(path.join(managed, file), "utf8")).toBe(managedToken);
    },
  );

  it.each(["test-synthetic", "test-copied-creds"] as const)(
    "never maps host ACP login in %s",
    (mode) => {
      const { sourceAgentDir, sourceGeminiDir } = makeSource();
      fs.mkdirSync(path.join(sourceAgentDir, "antigravity-acp-provider/gemini"), {
        recursive: true,
      });
      const home = prepareControlledPiAgentHome({
        mode,
        sourceAgentDir,
        sourceGeminiDir,
        isolateGeminiHome: true,
        packages: [providerSource],
      });
      temporaryDirectories.push(home.piAgentDir, home.geminiHome!, home.env.PI_SUBAGENTS_TEMP_ROOT);
      expect(home.resolvedPackages.piAntigravityEntryPath).toBeDefined();
      expect(fs.existsSync(path.join(home.piAgentDir, "antigravity-acp-provider/gemini"))).toBe(
        false,
      );
    },
  );

  it("preserves existing runtime agent definitions when switching to host agents", () => {
    const { sourceAgentDir, dataDir, runtime } = makeSource();
    const piAgentDir = path.join(dataDir, "pi-agent-home");
    const agents = path.join(piAgentDir, "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "local.md"), "local definition");
    runtime();
    runtime();
    expect(fs.readlinkSync(agents)).toBe(path.join(sourceAgentDir, "agents"));
    const backups = fs.readdirSync(piAgentDir).filter((name) => name.startsWith("agents-backup-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(piAgentDir, backups[0], "agents/local.md"), "utf8")).toBe(
      "local definition",
    );
  });

  it("builds a synthetic home without host credentials, settings or models", () => {
    const { sourceAgentDir } = makeSource();
    for (const file of ["models.json", "models-store.json", "settings.json"])
      fs.writeFileSync(path.join(sourceAgentDir, file), "not JSON; must not be read");
    const home = prepareControlledPiAgentHome({ mode: "test-synthetic", sourceAgentDir });
    temporaryDirectories.push(home.piAgentDir, home.geminiHome!, home.env.PI_SUBAGENTS_TEMP_ROOT);
    expect(JSON.parse(fs.readFileSync(path.join(home.piAgentDir, "auth.json"), "utf8"))).toEqual(
      {},
    );
    expect(home.env.PI_CODING_AGENT_DIR).toBe(home.piAgentDir);
    expect(home.env.PI_OFFLINE).toBe("1");
    expect(home.env.GEMINI_HOME).toBe(home.geminiHome);
    expectIsolatedRouting(home);
    expectNoSymlinks(home.piAgentDir);
    expectNoSymlinks(home.geminiHome!);
    expect(readRuntimeSettings(home)).toEqual({
      defaultProjectTrust: "always",
      packages: [],
    });
    expect(fs.existsSync(path.join(home.piAgentDir, "models.json"))).toBe(false);
    expect(fs.existsSync(path.join(home.piAgentDir, "models-store.json"))).toBe(false);
    expect(fs.existsSync(path.join(home.geminiHome!, "antigravity-acp-provider"))).toBe(false);
  });

  it("atomically applies the managed ACP profile without changing unrelated or standalone settings", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const standalone = path.join(sourceAgentDir, "antigravity-acp-provider", "config.json");
    fs.mkdirSync(path.dirname(standalone), { recursive: true });
    fs.writeFileSync(standalone, '{"runtimeUpdates":"automatic"}');
    const home = runtime();
    const profile = path.join(home.piAgentDir, "antigravity-acp-provider", "config.json");
    fs.writeFileSync(profile, '{"toolActivity":"full","nested":{"sample":true}}');
    const configured = {
      piAcp: { permissions: "auto_edit", runtime_updates: "notify" },
    } as const;
    runtime(configured);
    expect(JSON.parse(fs.readFileSync(profile, "utf8"))).toEqual({
      toolActivity: "full",
      nested: { sample: true },
      permissions: "auto_edit",
      runtimeUpdates: "notify",
    });
    expect(fs.readdirSync(path.dirname(profile))).toEqual(["config.json"]);
    const previous = fs.statSync(profile);
    runtime(configured);
    expect(fs.statSync(profile).mtimeMs).toBe(previous.mtimeMs);
    expect(fs.statSync(profile).ino).toBe(previous.ino);
    expect(fs.readFileSync(standalone, "utf8")).toBe('{"runtimeUpdates":"automatic"}');
  });

  it.skipIf(process.platform === "win32")("does not follow a managed ACP profile symlink", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const home = runtime();
    const profile = path.join(home.piAgentDir, "antigravity-acp-provider", "config.json");
    const standalone = path.join(sourceAgentDir, "config.json");
    fs.writeFileSync(standalone, "{}");
    fs.unlinkSync(profile);
    fs.symlinkSync(standalone, profile);
    expect(runtime().resolvedPackages.piAntigravityEntryPath).toBeUndefined();
    expect(inspectPiAcpProfile(home.piAgentDir)).toEqual({
      path: profile,
      status: "invalid",
      reason: "not a regular file",
    });
    expect(fs.readFileSync(standalone, "utf8")).toBe("{}");
    expect(fs.lstatSync(profile).isSymbolicLink()).toBe(true);
  });

  it.each([
    { contents: '{"permissions":"default",', reason: "invalid JSON" },
    { contents: '{"permissions":"unexpected"}', reason: "invalid permissions mode" },
    { contents: "[]", reason: "expected a JSON object" },
  ])("quarantines only ACP when the managed profile has $reason", ({ contents, reason }) => {
    const { dataDir, runtime } = makeSource();
    const agentDir = path.join(dataDir, "pi-agent-home");
    const profile = path.join(agentDir, "antigravity-acp-provider", "config.json");
    expect(inspectPiAcpProfile(agentDir)).toEqual({ path: profile, status: "missing" });
    expect(fs.existsSync(agentDir)).toBe(false);
    const initial = runtime();
    expect(inspectPiAcpProfile(agentDir)).toEqual({ path: profile, status: "valid" });
    fs.writeFileSync(profile, contents);
    expect(inspectPiAcpProfile(agentDir)).toEqual({ path: profile, status: "invalid", reason });

    const broken = runtime();
    expect(broken.piAcpProfileError).toContain(profile);
    expect(broken.resolvedPackages.piAntigravityEntryPath).toBeUndefined();
    expect(broken.resolvedPackages.piSubagentsRoot).toBe(initial.resolvedPackages.piSubagentsRoot);
    expect(fs.readFileSync(broken.settingsPath, "utf8")).not.toContain(
      "pi-antigravity-acp-provider",
    );
    expect(fs.readFileSync(profile, "utf8")).toBe(contents);

    fs.writeFileSync(profile, '{"permissions":"default","runtimeUpdates":"manual"}');
    const repaired = runtime({
      piAcp: { permissions: "default" },
    });
    expect(repaired.piAcpProfileError).toBeUndefined();
    expect(repaired.resolvedPackages.piAntigravityEntryPath).toBe(
      initial.resolvedPackages.piAntigravityEntryPath,
    );
    expect(fs.readFileSync(profile, "utf8")).toBe(
      '{"permissions":"default","runtimeUpdates":"manual"}',
    );
  });

  it("identifies a renamed ACP checkout by its manifest before starting Pi", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const alias = path.join(sourceAgentDir, "google-acp");
    fs.renameSync(packageRoot(sourceAgentDir, providerSource), alias);
    fs.writeFileSync(
      path.join(alias, "package.json"),
      JSON.stringify({
        name: "pi-antigravity-acp-provider",
        pi: { extensions: ["./extensions/index.ts"] },
      }),
    );
    const options = {
      packages: [alias],
      offline: false,
    } as const;
    const home = runtime(options);
    expect(home.resolvedPackages.piAntigravityEntryPath).toBe(
      fs.realpathSync(path.join(alias, "extensions/index.ts")),
    );
    expect(inspectPiAcpProfile(home.piAgentDir).status).toBe("valid");
    const excluded = runtime({
      ...options,
      excludePackages: ["pi-antigravity-acp-provider"],
    });
    expect(readRuntimeSettings(excluded)).toMatchObject({
      packages: [],
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "checks directory access only when staging a managed profile is necessary",
    () => {
      const { runtime } = makeSource();
      const home = runtime();
      const profile = inspectPiAcpProfile(home.piAgentDir);
      const dir = path.dirname(profile.path);
      fs.chmodSync(dir, 0o500);
      try {
        expect(inspectPiAcpProfile(home.piAgentDir).status).toBe("valid");
        const policy = { permissions: "default" } as const;
        expect(inspectPiAcpProfile(home.piAgentDir, policy).status).toBe("invalid");
        expect(runtime({ piAcp: policy }).piAcpProfileError).toBeDefined();
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      fs.unlinkSync(profile.path);
      fs.chmodSync(dir, 0o500);
      try {
        expect(inspectPiAcpProfile(home.piAgentDir).status).toBe("invalid");
      } finally {
        fs.chmodSync(dir, 0o700);
      }
    },
  );

  it("ignores a malformed profile when the ACP package is excluded", () => {
    const { runtime } = makeSource();
    const options = { excludePackages: [providerSource] };
    const home = runtime(options);
    const { path: profile } = inspectPiAcpProfile(home.piAgentDir);
    expect(fs.existsSync(path.dirname(profile))).toBe(false);
    fs.mkdirSync(path.dirname(profile));
    fs.writeFileSync(profile, "{");
    expect(runtime(options).piAcpProfileError).toBeUndefined();
    expect(fs.readFileSync(profile, "utf8")).toBe("{");
  });

  it("discovers local packages when packages is empty", () => {
    const { runtime } = makeSource();
    const home = runtime({
      packages: [],
    });
    expectControlledSettings(home.settingsPath);
    expect(home.resolvedPackages.piSubagentsRoot).toBeDefined();
    expect(home.resolvedPackages.piAntigravityEntryPath).toBeDefined();
  });

  it.each(["auto-discovered", "explicit", "explicit object-form"])(
    "excludes %s packages by package name",
    (selection) => {
      const { sourceAgentDir, runtime } = makeSource();
      const packageSources = [
        "./nzh10-skills",
        "./nzh10-skills/packages/pi-skillful",
        "npm:pi-subagents",
        "npm:pi-antigravity-acp-provider",
        "npm:pi-btw",
      ];
      const home = runtime({
        packages:
          selection === "auto-discovered"
            ? undefined
            : packageSources.map((source) =>
                selection === "explicit object-form" ? { source, skills: ["foo"] } : source,
              ),
        excludePackages: [
          "pi-subagents",
          "npm:pi-antigravity-acp-provider",
          "pi-btw",
          "pi-intercom",
          "pi-autoresearch",
        ],
      });
      const settings = readRuntimeSettings(home);
      const retainedSources = packageSources
        .slice(0, 2)
        .map((source) => fs.realpathSync.native(path.resolve(sourceAgentDir, source)));
      expect(settings.packages).toEqual(
        selection === "explicit object-form"
          ? retainedSources.map((source) => ({ source, skills: ["foo"] }))
          : retainedSources,
      );
      expect(home.resolvedPackages.piSubagentsRoot).toBeUndefined();
      expect(home.resolvedPackages.piAntigravityEntryPath).toBeUndefined();
    },
  );

  it("sets PI_OFFLINE by default but omits it when offline is false", () => {
    const { runtime } = makeSource();
    expect(runtime().env.PI_OFFLINE).toBe("1");
    expect(runtime({ offline: false }).env).not.toHaveProperty("PI_OFFLINE");
  });

  it("handles minimal fresh-machine Pi homes without source settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-pi-fresh-home-"));
    temporaryDirectories.push(root);
    const sourceAgentDir = path.join(root, "source-agent");
    const dataDir = path.join(root, "data");
    const subagentsDir = path.join(sourceAgentDir, "npm", "node_modules", "pi-subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });

    // A package not listed in settings.json isn't enabled just because it is installed.
    const noSettingsHome = prepareControlledPiAgentHome({
      mode: "runtime",
      sourceAgentDir,
      dataDir,
    });
    expect(noSettingsHome.resolvedPackages.piSubagentsRoot).toBeUndefined();
    expect(noSettingsHome.resolvedPackages.piAntigravityEntryPath).toBeUndefined();
  });

  it("preserves object-form filters and deduplicates by resolved package source", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const provider = { source: "npm:pi-antigravity-acp-provider", extensions: [] };
    const subagents = { source: "npm:pi-subagents", skills: ["foo"], prompts: ["bar"] };
    const providerDir = "npm/node_modules/pi-antigravity-acp-provider";
    writePackages(sourceAgentDir, provider, subagents, `./${providerDir}`, "./nzh10-skills");

    const home = runtime();
    const realSource = (relative: string) =>
      fs.realpathSync.native(path.join(sourceAgentDir, relative));
    const settings = readRuntimeSettings(home);
    expect(settings.packages).toEqual([
      realSource("nzh10-skills"),
      { ...subagents, source: realSource("npm/node_modules/pi-subagents") },
      { ...provider, source: realSource(providerDir) },
    ]);
    expect(home.resolvedPackages.piSubagentsRoot).toBe(realSource("npm/node_modules/pi-subagents"));
    expect(home.resolvedPackages.piAntigravityEntryPath).toBeUndefined();
  });

  it("omits piSubagentsRoot when object-form settings disable extensions", () => {
    const { sourceAgentDir, runtime } = makeSource();
    writePackages(sourceAgentDir, { source: subagentsSource, extensions: [] });
    const home = runtime();
    expect(home.resolvedPackages.piSubagentsRoot).toBeUndefined();
  });

  it("evaluates non-empty extension filter globs for piAntigravityEntryPath", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const providerDir = "npm/node_modules/pi-antigravity-acp-provider";
    const expectedEntry = fs.realpathSync.native(
      path.join(sourceAgentDir, providerDir, "extensions", "index.ts"),
    );

    for (const { extensions, expected, assertRetainedFilter } of [
      {
        extensions: ["extensions/*.ts", "!extensions/index.ts"],
        expected: undefined,
        assertRetainedFilter: true,
      },
      { extensions: ["extensions/other.ts"], expected: undefined },
      { extensions: ["extensions/*.ts"], expected: expectedEntry },
    ]) {
      const provider = { source: providerSource, extensions };
      writePackages(sourceAgentDir, provider);
      const home = runtime();
      expect(home.resolvedPackages.piAntigravityEntryPath).toBe(expected);
      if (assertRetainedFilter) {
        const settings = readRuntimeSettings(home);
        expect(settings.packages).toEqual([
          { ...provider, source: fs.realpathSync.native(path.join(sourceAgentDir, providerDir)) },
        ]);
      }
    }
  });

  function discoverProvider(sourceAgentDir: string, entry: PiPackageEntry = providerSource) {
    writePackages(sourceAgentDir, entry);
    return discoverLocalPiPackages(sourceAgentDir).piAntigravityEntryPath;
  }

  it("applies basename exclusions to the provider entrypoint", () => {
    const { sourceAgentDir } = makeSource();
    expect(
      discoverProvider(sourceAgentDir, { source: providerSource, extensions: ["!index.ts"] }),
    ).toBeUndefined();
  });

  it("does not treat a bare directory filter as an extension path prefix", () => {
    const { sourceAgentDir } = makeSource({ subagentsExtension: false });
    const root = packageRoot(sourceAgentDir, subagentsSource);
    writeExtension(root, "extensions/worker/index.ts");
    writePackages(sourceAgentDir, { source: subagentsSource, extensions: ["extensions/worker"] });
    expect(discoverLocalPiPackages(sourceAgentDir).piSubagentsRoot).toBeUndefined();
    writePackages(sourceAgentDir, {
      source: subagentsSource,
      extensions: ["extensions/worker/**"],
    });
    expect(discoverLocalPiPackages(sourceAgentDir).piSubagentsRoot).toBe(
      fs.realpathSync.native(root),
    );
  });

  it("applies exact force-includes after exclusions and exact force-excludes last", () => {
    const { sourceAgentDir } = makeSource();
    const root = packageRoot(sourceAgentDir, providerSource);
    const entry = fs.realpathSync.native(path.join(root, "extensions", "index.ts"));
    const resolve = (...extensions: string[]) =>
      discoverProvider(sourceAgentDir, { source: providerSource, extensions });
    expect(resolve("!index.ts", "+index.ts", "+extensions/*.ts")).toBeUndefined();
    expect(resolve("!index.ts", "+./extensions/index.ts")).toBe(entry);
    expect(resolve(`-${entry}`, "+extensions/index.ts", "!index.ts")).toBeUndefined();
    expect(resolve(entry)).toBe(entry);
  });

  it("applies autoload:false rules as ordered deltas without enabling unmatched entries", () => {
    const { sourceAgentDir } = makeSource();
    const root = packageRoot(sourceAgentDir, providerSource);
    const entry = fs.realpathSync.native(path.join(root, "extensions", "index.ts"));
    const resolve = (extensions?: string[]) =>
      discoverProvider(sourceAgentDir, { source: providerSource, autoload: false, extensions });
    expect(resolve()).toBeUndefined();
    expect(resolve(["!other.ts"])).toBeUndefined();
    expect(resolve(["+extensions/index.ts", "!index.ts"])).toBeUndefined();
    expect(resolve(["-extensions/index.ts", "index.ts"])).toBe(entry);
  });

  it("resolves manifest source globs and directories before applying manifest and user overrides", () => {
    const { sourceAgentDir } = makeSource();
    const root = packageRoot(sourceAgentDir, providerSource);
    const first = writeExtension(root, "entry/nested/entry-a1.ts");
    const direct = writeExtension(root, "entry/entry-b2.ts");
    writeExtension(root, "entry/entry-z1.ts");
    writeExtension(root, "entry/.hidden/entry-a3.ts");
    fs.symlinkSync("..", path.join(root, "entry", "nested", "loop"));
    const literal = writeExtension(root, "literal/worker/index.js");
    writeExtensionManifest(root, [
      "./entry/**/entry-[ab]?.ts",
      "./literal",
      "!entry-*.ts",
      "+./entry/nested/entry-a1.ts",
      "+./entry/entry-b2.ts",
      "+./entry/entry-z1.ts",
      "-./entry/entry-b2.ts",
    ]);

    expect(discoverProvider(sourceAgentDir)).toBe(first);
    const filtered = (...extensions: string[]) =>
      discoverProvider(sourceAgentDir, { source: providerSource, extensions });
    expect(filtered("worker/**", "index.js")).toBe(literal);
    expect(filtered("+entry/entry-b2.ts", "+entry/entry-z1.ts", "entry-a3.ts")).toBeUndefined();

    writeExtensionManifest(root, ["./entry/**/entry-[ab]?.ts", "./extensions/index.ts"]);
    expect(filtered("entry-b2.ts")).toBe(direct);
    expect(discoverProvider(sourceAgentDir)).toBe(
      fs.realpathSync.native(path.join(root, "extensions", "index.ts")),
    );
  });

  it("prefers explicit convention-directory entries over adjacent extensions", () => {
    const { sourceAgentDir } = makeSource({ subagentsExtension: false });
    const root = packageRoot(sourceAgentDir, subagentsSource);
    const convention = path.join(root, "extensions");
    writeExtension(convention, "index.ts");
    writeExtension(convention, "index.js");
    writeExtension(convention, "worker/custom.js");
    writeExtensionManifest(convention, ["./worker/custom.js"]);
    const resolve = (...extensions: string[]) => {
      writePackages(sourceAgentDir, { source: subagentsSource, extensions });
      return discoverLocalPiPackages(sourceAgentDir).piSubagentsRoot;
    };
    expect(resolve("index.ts")).toBeUndefined();
    expect(resolve("custom.js")).toBe(fs.realpathSync.native(root));
    fs.unlinkSync(path.join(convention, "package.json"));
    expect(resolve("index.js", "custom.js")).toBeUndefined();
    expect(resolve("index.ts")).toBe(fs.realpathSync.native(root));
  });

  it("scans only eligible convention children and honors ignore rules", () => {
    const { sourceAgentDir } = makeSource({ subagentsExtension: false });
    const root = packageRoot(sourceAgentDir, subagentsSource);
    const convention = path.join(root, "extensions");
    writeExtension(convention, "ignore.ts");
    writeExtension(convention, "ignore.mjs");
    writeExtension(convention, "worker/custom.js");
    writeExtensionManifest(path.join(convention, "worker"), ["./custom.js"]);
    writeExtension(convention, "deep/inside/index.js");
    writeExtension(convention, ".hidden/index.js");
    writeExtension(convention, "node_modules/index.js");
    fs.writeFileSync(path.join(convention, ".gitignore"), "**/IGNORE.[jt]s\nworker/\n");
    writePackages(sourceAgentDir, subagentsSource);
    expect(discoverLocalPiPackages(sourceAgentDir).piSubagentsRoot).toBeUndefined();
    fs.writeFileSync(path.join(convention, ".ignore"), "!worker/\n");
    expect(discoverLocalPiPackages(sourceAgentDir).piSubagentsRoot).toBe(
      fs.realpathSync.native(root),
    );
  });

  it("uses Pi's distinct bare, object-default, and explicit-filter manifest fallbacks", () => {
    const { sourceAgentDir } = makeSource();
    const root = packageRoot(sourceAgentDir, providerSource);
    const entry = fs.realpathSync.native(path.join(root, "extensions", "index.ts"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ pi: { skills: [] } }));
    expect(discoverProvider(sourceAgentDir)).toBeUndefined();
    expect(discoverProvider(sourceAgentDir, { source: providerSource })).toBe(entry);
    writeExtensionManifest(root, []);
    expect(discoverLocalPiPackages(sourceAgentDir).piAntigravityEntryPath).toBeUndefined();
    expect(
      discoverProvider(sourceAgentDir, { source: providerSource, extensions: ["index.ts"] }),
    ).toBe(entry);
    writeExtensionManifest(root, ["./missing.ts"]);
    expect(discoverLocalPiPackages(sourceAgentDir).piAntigravityEntryPath).toBeUndefined();
  });

  it.each(["user filter", "manifest glob"])("rejects a non-matching repeated-star %s", (mode) => {
    const { sourceAgentDir } = makeSource({ subagentsExtension: false });
    const root = packageRoot(sourceAgentDir, subagentsSource);
    writeExtension(root, `extensions/${"a".repeat(32)}.ts`);
    const pattern = `extensions/${"*a".repeat(16)}Z.ts`;
    if (mode === "user filter") {
      writePackages(sourceAgentDir, { source: subagentsSource, extensions: [pattern] });
    } else {
      writeExtensionManifest(root, [pattern]);
      writePackages(sourceAgentDir, subagentsSource);
    }

    expect(discoverLocalPiPackages(sourceAgentDir).piSubagentsRoot).toBeUndefined();
  });

  it("prefers a filtered object over an earlier bare string for duplicate package sources", () => {
    const { sourceAgentDir, runtime } = makeSource();
    const providerDir = "npm/node_modules/pi-antigravity-acp-provider";
    const filteredProvider = {
      source: "npm:pi-antigravity-acp-provider",
      extensions: ["!extensions/index.ts"],
    };
    writePackages(sourceAgentDir, "./nzh10-skills", `./${providerDir}`, filteredProvider);

    const home = runtime();
    const realSource = (relative: string) =>
      fs.realpathSync.native(path.join(sourceAgentDir, relative));
    const settings = readRuntimeSettings(home);
    expect(settings.packages).toEqual([
      realSource("nzh10-skills"),
      { ...filteredProvider, source: realSource(providerDir) },
    ]);
    expect(home.resolvedPackages.piAntigravityEntryPath).toBeUndefined();
  });

  it("copies Pi and optional Gemini credentials with mode 0600 and no symlinks", () => {
    const { sourceAgentDir, sourceGeminiDir } = makeSource();
    const home = prepareControlledPiAgentHome({
      mode: "test-copied-creds",
      sourceAgentDir,
      sourceGeminiDir,
      isolateGeminiHome: true,
    });
    temporaryDirectories.push(home.piAgentDir, home.geminiHome!, home.env.PI_SUBAGENTS_TEMP_ROOT);
    expect(JSON.parse(fs.readFileSync(path.join(home.piAgentDir, "auth.json"), "utf8"))).toEqual({
      token: "secret",
    });
    expectIsolatedRouting(home);
    if (process.platform !== "win32")
      expect(fs.lstatSync(path.join(home.piAgentDir, "auth.json")).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(fs.readFileSync(path.join(home.geminiHome!, "oauth_creds.json"), "utf8")),
    ).toEqual({
      access: "secret",
    });
    if (process.platform !== "win32")
      expect(fs.lstatSync(path.join(home.geminiHome!, "oauth_creds.json")).mode & 0o777).toBe(
        0o600,
      );
    expect(home.env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    expectNoSymlinks(home.piAgentDir);
    expectNoSymlinks(home.geminiHome!);
    expectControlledSettings(home.settingsPath);
  });
});
