import { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { expect } from "vitest";
import { PiRpcClient, type PiRpcSpawnOptions } from "../../src/session/pi-rpc";
import type { PanelReadyReport } from "../../src/session/panel-http";
import type { PiFrame } from "./fixture";
import { piReply } from "./pi-wire";

// A real PiRpcClient reads LF-delimited stdout and writes to a controlled stdin.
// Only startup replies are supplied by the player; turn traffic is tape-ordered.
// This does not launch Pi or verify extension registration in a real process.
export class PiRpcPlayer {
  readonly sent: PiFrame[] = [];
  readonly connections: Array<{ restored: boolean }> = [];
  private readonly written: PiFrame[] = [];
  private readonly awaiting = new Map<string, string>();
  private readonly anchors = new Map<string, PiFrame>();
  private readonly streams: PassThrough[] = [];
  private readonly ready: Promise<unknown>[] = [];
  private route?: { url: string; token: string };
  private stdout?: PassThrough;
  private exit?: (code: number) => void;
  private readonly entries: Array<Record<string, unknown>> = [];
  image?: Buffer;

  constructor(
    private readonly dir: string,
    private readonly model: string,
    private readonly contextWindow: number,
  ) {}

  connect = (opts: PiRpcSpawnOptions): PiRpcClient => {
    const arg = (name: string) => {
      const i = opts.args!.indexOf(name);
      return i < 0 ? undefined : opts.args![i + 1];
    };
    const saved = arg("--session");
    const sessionFile = path.join(this.dir, "session.jsonl");
    if (saved)
      expect(saved === sessionFile, "restore reopens the synthetic session file").toBe(true);
    const sessionId = saved
      ? (JSON.parse(fs.readFileSync(saved, "utf8").split("\n")[0]) as { id: string }).id
      : arg("--session-id")!;
    if (!saved)
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: opts.cwd }) + "\n",
      );
    this.connections.push({ restored: Boolean(saved) });
    this.route = {
      url: `${opts.env!.YAAT_PANEL_URL}/v1/sessions/${encodeURIComponent(opts.env!.YAAT_PANEL_KEY!)}`,
      token: opts.env!.YAAT_PANEL_TOKEN!,
    };
    const ready: PanelReadyReport = {
      sessionProof: {
        sessionId,
        sessionFile,
        cwd: opts.cwd!,
        headerCwd: opts.cwd!,
        entryCount: this.entries.length,
        leafId: (this.entries.at(-1)?.id as string | undefined) ?? null,
        anchorOnActiveBranch: true,
        anchorExistsInFile: true,
      },
      ownerToolNames: [],
      requiredExtensionsRegistered: true,
      subagentsRpcReady: true,
      subagentsSessionId: sessionId,
    };
    const bridge = this.post("ready", ready);
    void bridge.catch(() => undefined);
    this.ready.push(bridge);
    const stdout = new PassThrough();
    this.stdout = stdout;
    this.streams.push(stdout);
    const [provider, id] = this.model.split("/");
    const model = { provider, id, contextWindow: this.contextWindow };
    const startup = [
      ["get_state", { model, sessionId, sessionFile, thinkingLevel: "low" }],
      ["get_available_models", { models: [model] }],
      ["get_commands", { commands: [] }],
      ["get_available_thinking_levels", { levels: ["low"] }],
    ] as const;
    let next = 0;
    const stdin = new Writable({
      write: (chunk: Buffer, _, done) => {
        const command = JSON.parse(chunk.toString()) as PiFrame;
        const boot = startup[next];
        if (boot && boot[0] === command.type) {
          next++;
          const reply = piReply(command.type);
          this.play({ ...reply, id: command.id, data: { ...(reply.data as object), ...boot[1] } });
        } else {
          this.sent.push(command);
          this.written.push(command);
          if (command.type === "prompt") this.persistPrompt(command);
        }
        done();
      },
    });
    // Replay Node's child lifecycle without launching a process.
    const child = new ChildProcess();
    const exit = (code: number) => {
      if (child.exitCode !== null) return;
      Object.assign(child, { exitCode: code });
      child.emit("exit", code, null);
      stdout.once("end", () => child.emit("close", code, null));
      stdout.end();
    };
    this.exit = exit;
    stdin.on("finish", () => exit(0));
    return new PiRpcClient({ stdin, stdout, child }, { requestTimeoutMs: 1500 });
  };

  private persistPrompt(command: PiFrame): void {
    const id = `entry-${this.entries.length + 1}`;
    const entry = {
      type: "message",
      id,
      parentId: (this.entries.at(-1)?.id as string | undefined) ?? null,
      message: { role: "user", content: String(command.message) },
    };
    this.entries.push(entry);
    fs.appendFileSync(path.join(this.dir, "session.jsonl"), JSON.stringify(entry) + "\n");
  }

  private async post(endpoint: string, body: unknown): Promise<unknown> {
    const { url, token } = this.route!;
    const response = await fetch(`${url}/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    expect(response.status, `Panel HTTP ${endpoint}`).toBe(200);
    return response.json();
  }

  async expect(expected: PiFrame): Promise<void> {
    await expect
      .poll(() => this.written.length, {
        timeout: 1000,
        interval: 5,
        message: `waiting for Pi ${expected.type} ${typeof expected.message === "string" ? expected.message : ""}`,
      })
      .toBeGreaterThan(0);
    const { id, ...frame } = this.written.shift()!;
    if (frame.type === "extension_ui_response") frame.id = id;
    else {
      expect(typeof id).toBe("string");
      expect(this.awaiting.has(frame.type)).toBe(false);
      this.awaiting.set(frame.type, id as string);
    }
    if (frame.images && this.image) {
      const images = frame.images as Array<{ type?: string; mimeType?: string; data?: string }>;
      expect(images).toHaveLength(1);
      expect(images.map(({ type, mimeType }) => ({ type, mimeType }))).toEqual([
        { type: "image", mimeType: "image/png" },
      ]);
      expect(
        images[0].data === this.image.toString("base64"),
        "Pi sends the exact seeded image bytes",
      ).toBe(true);
      frame.images = [{ type: "image", mimeType: "image/png", data: "generated-png" }];
    }
    expect(frame).toEqual(expected);
  }

  play(frame: PiFrame): void {
    if (frame.type === "response" && frame.id === undefined) {
      const command = String(frame.command);
      const id = this.awaiting.get(command);
      expect(id, `request before response to ${command}`).toBeDefined();
      this.awaiting.delete(command);
      frame = { success: true, ...frame, id };
    }
    if (frame.type === "tool_execution_start") this.anchors.set(String(frame.toolCallId), frame);
    if (frame.type === "tool_execution_end") this.anchors.delete(String(frame.toolCallId));
    this.stdout!.write(JSON.stringify(frame) + "\n");
  }

  async panelCall(callId: string): Promise<void> {
    const call = this.anchors.get(callId);
    expect(call, "open Pi tool call before Panel HTTP dispatch").toBeDefined();
    const { text, isError } = (await this.post("call", {
      name: call!.toolName,
      params: call!.args,
      callId,
    })) as { text: string; isError: boolean };
    expect(isError, `Panel tool ${JSON.stringify(call!.toolName)} failed`).toBe(false);
    this.play({
      type: "tool_execution_end",
      toolName: call!.toolName,
      toolCallId: callId,
      result: { content: [{ type: "text", text }] },
      isError,
    });
  }

  crash(): void {
    this.finishWrites();
    this.awaiting.clear(); // a process can die with a request outstanding
    this.anchors.clear();
    this.exit!(1);
  }

  private finishWrites(): void {
    expect(
      this.written.map((m) => m.type),
      "unrecorded Pi writes",
    ).toEqual([]);
  }

  async finish(): Promise<void> {
    await Promise.all(this.ready);
    this.finishWrites();
    expect([...this.awaiting.keys()], "unanswered Pi requests").toEqual([]);
  }

  close(): void {
    for (const stream of this.streams) stream.destroy();
  }
}
