import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PanelApi } from "../../src/project/tools";
import {
  leadToolset,
  workerToolset,
  type PanelTool,
  type PanelToolset,
} from "../../src/project/tools";
import type { Project } from "../../src/project/store";
import type { QuotaSnapshot } from "../../src/session/quota-schema";
import { localPiBinary } from "../local-pi";
import {
  discoverLocalPiPackages,
  prepareControlledPiAgentHome,
} from "../../src/session/pi-agent-home";
import {
  MAX_FRAME_BYTES,
  PiRpcClient,
  runBudgetedShutdown,
  type PiRpcSessionState,
} from "../../src/session/pi-rpc";
import {
  PanelHttpServer,
  type PanelReadyReport,
  type SessionCheckpoint,
} from "../../src/session/panel-http";
import {
  assertNoEmptyEnum,
  forGeminiSchema,
  jsonSchemaToTypeBox,
  zodShapeToRestrictedJsonSchema,
  type RestrictedJsonSchema,
} from "../../src/session/panel-schema";

const piRequire = createRequire(localPiBinary ?? __filename);
const subagents = localPiBinary && discoverLocalPiPackages().piSubagentsRoot;
const { Type } = piRequire("typebox") as typeof import("typebox");
const { Value } = piRequire("typebox/value") as typeof import("typebox/value");

const servers: PanelHttpServer[] = [];
const clients: PiRpcClient[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await runBudgetedShutdown({
      totalTimeoutMs: 5_000,
      child: client.child,
      stdin: client.stdin,
      pid: client.pid,
    });
  }
  for (const server of servers.splice(0)) await server.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createPanelServer(): Promise<{ server: PanelHttpServer; baseUrl: string }> {
  const instance = new PanelHttpServer();
  servers.push(instance);
  const { baseUrl } = await instance.listen();
  return { server: instance, baseUrl };
}

function request(
  baseUrl: string,
  key: string,
  endpoint: string,
  token: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(key)}/${endpoint}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body !== undefined && { "content-type": "application/json" }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    ...(options.signal && { signal: options.signal }),
  });
}

async function openControl(
  baseUrl: string,
  key: string,
  token: string,
  onMessage: (message: Record<string, unknown>) => void,
): Promise<() => void> {
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(key)}/control`, {
    headers: { authorization: `Bearer ${token}` },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    let data: string[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffered += decoder.decode(next.value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "" || line === "\r") {
            if (data.length > 0) onMessage(JSON.parse(data.join("\n")) as Record<string, unknown>);
            data = [];
          } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
      }
    } catch {
      // Abort is the normal test cleanup path.
    }
  })();
  return () => abort.abort();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sampleFor(schema: RestrictedJsonSchema): unknown {
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) {
    const nonNull = schema.anyOf.find((part) => part.type !== "null") ?? schema.anyOf[0];
    return sampleFor(nonNull);
  }
  if (Array.isArray(schema.type)) {
    const type = schema.type.find((part) => part !== "null") ?? schema.type[0];
    return sampleFor({ ...schema, type });
  }
  switch (schema.type) {
    case "object": {
      const result: Record<string, unknown> = {};
      for (const name of schema.required ?? []) {
        result[name] = sampleFor(schema.properties![name]);
      }
      return result;
    }
    case "array":
      return schema.items ? [sampleFor(schema.items)] : [];
    case "string":
      return "sample";
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      throw new Error(`Cannot sample schema ${JSON.stringify(schema)}`);
  }
}

describe("panel schema bridge", () => {
  it("preserves every real panel tool constraint through Gemini and Pi TypeBox", () => {
    const api = new Proxy({} as PanelApi, {
      get: () => () => {
        throw new Error("Schema tests must not invoke tool handlers");
      },
    });
    const project = { id: "project", name: "Project", root: "/tmp/project" } as Project;
    const toolsets = [
      leadToolset(api, project, "/tmp/notes", ["synthetic/model"]),
      workerToolset(api, "worker", project, "/tmp/notes", false, false),
      workerToolset(api, "unreported", project, "/tmp/notes", false, true),
      workerToolset(api, "isolated", project, "/tmp/notes", true, false),
    ];
    const tools = new Map<string, PanelTool>();
    for (const toolset of toolsets) {
      for (const tool of toolset.tools) tools.set(tool.name, tool);
    }
    expect(tools.size).toBe(28);

    for (const [name, tool] of tools) {
      const schema = zodShapeToRestrictedJsonSchema(tool.shape);
      expect(schema.additionalProperties).toBe(false);
      const sample = sampleFor(schema);
      const parameters = jsonSchemaToTypeBox(schema, Type);
      expect(
        Value.Check(parameters, sample),
        `${name}: TypeBox rejected ${JSON.stringify(sample)}`,
      ).toBe(true);
      const parsed = z.object(tool.shape).safeParse(sample);
      expect(
        parsed.success,
        `${name}: ${parsed.success ? "" : z.prettifyError(parsed.error)}`,
      ).toBe(true);

      const gemini = forGeminiSchema(schema);
      assertNoEmptyEnum(gemini);
      expect(Value.Check(jsonSchemaToTypeBox(gemini, Type), sample), name).toBe(true);
    }

    const evidence = zodShapeToRestrictedJsonSchema({
      evidence: z.enum(["R", "V", ""]).optional(),
    });
    expect(() => assertNoEmptyEnum(evidence)).toThrow(/empty-string/);
    const gemini = forGeminiSchema(evidence);
    assertNoEmptyEnum(gemini);
    expect(gemini.properties!.evidence.description).toContain('One of "R", "V", ""');
  });

  it("supports nullable, defaults, integer bounds, arrays, and strict nested objects", () => {
    const schema = zodShapeToRestrictedJsonSchema({
      count: z.number().int().min(2).max(4),
      note: z.string().nullable(),
      mode: z.enum(["a", "b"]).default("a"),
      rows: z.array(z.object({ id: z.string(), flag: z.boolean().optional() }).strict()),
    });
    const parameters = jsonSchemaToTypeBox(schema, Type);
    const valid = { count: 2, note: null, rows: [{ id: "r1" }] };
    expect(Value.Check(parameters, valid)).toBe(true);
    expect(z.object({ count: z.number().int().min(2).max(4) }).parse({ count: 2 })).toEqual({
      count: 2,
    });
    expect(Value.Check(parameters, { ...valid, count: 5 })).toBe(false);
    expect(Value.Check(parameters, { ...valid, rows: [{ id: "r1", extra: true }] })).toBe(false);
    expect(Value.Check(parameters, { ...valid, unknown: true })).toBe(false);
  });
});

interface RealPiFixture {
  report: PanelReadyReport;
  state: PiRpcSessionState;
  server: PanelHttpServer;
  client: PiRpcClient;
  key: string;
}

function userEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

function writeLargeSession(directory: string, reportId: string): string {
  const sessionId = "01900000-0000-7000-8000-000000000032";
  const file = path.join(directory, "large-session.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: directory,
  };
  const entries = [
    userEntry("root", null, "x".repeat(MAX_FRAME_BYTES + 1024)),
    userEntry("before", "root", "before dispatch"),
    // This entry exists in the file but is deliberately not on the active
    // branch, whose leaf is the final same-text entry below.
    userEntry("non-active-anchor", "root", "other branch"),
    {
      type: "compaction",
      id: "compact",
      parentId: "before",
      timestamp: new Date().toISOString(),
      summary: "Bounded synthetic compaction",
      firstKeptEntryId: "before",
      tokensBefore: 1_000_000,
    },
    userEntry("report", "compact", `report body\n[agent-team:report:${reportId}]`),
    userEntry("same-text-without-marker", "report", "report body"),
  ];
  const output = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  fs.writeFileSync(file, output);
  expect(fs.statSync(file).size).toBeGreaterThan(MAX_FRAME_BYTES);
  return file;
}

async function startRealPi(options: {
  sessionFile?: string;
  expectedAnchorId?: string;
  getToolset?: () => PanelToolset | null;
  additionalExtension?: string;
  onQuota?: (snapshot: QuotaSnapshot) => void;
  extraEnv?: Record<string, string>;
}): Promise<RealPiFixture> {
  const { server, baseUrl } = await createPanelServer();
  const key = `real-${clients.length + 1}`;
  const toolset: PanelToolset = {
    instructions: "Panel handshake instructions",
    tools: [
      {
        name: "panel_probe",
        description: "Probe the live panel HTTP path",
        shape: { value: z.string().optional() },
        handler: () => Promise.resolve("ok"),
      },
    ],
  };
  const token = server.registerSession({
    sessionKey: key,
    getToolset: options.getToolset ?? (() => toolset),
    onQuota: options.onQuota,
    restoreExpectation: { expectedAnchorId: options.expectedAnchorId ?? null },
  });
  const home = prepareControlledPiAgentHome({
    mode: "test-synthetic",
    packages: subagents ? [subagents] : [],
  });
  temporaryDirectories.push(home.piAgentDir, home.geminiHome!, home.env.PI_SUBAGENTS_TEMP_ROOT);
  const cwd = options.sessionFile
    ? path.dirname(options.sessionFile)
    : temporaryDirectory("panel-pi-cwd-");
  const bridge = path.resolve(__dirname, "../../src/session/pi-panel-bridge.ts");
  const cleanEnv = { ...process.env };
  delete cleanEnv.PI_SUBAGENT_PARENT_SESSION;
  delete cleanEnv.PI_SUBAGENT_CHILD;
  delete cleanEnv.PI_SUBAGENT_RUNNER_PID;
  const client = PiRpcClient.spawn({
    binary: localPiBinary,
    args: [
      "--mode",
      "rpc",
      "-e",
      bridge,
      "-e",
      path.join(path.dirname(bridge), "pi-quota.ts"),
      ...(options.additionalExtension ? ["-e", options.additionalExtension] : []),
      ...(options.sessionFile ? ["--session", options.sessionFile] : []),
    ],
    cwd,
    env: {
      ...cleanEnv,
      ...home.env,
      YAAT_PANEL_URL: baseUrl,
      YAAT_PANEL_KEY: key,
      YAAT_PANEL_TOKEN: token,
      ...(options.expectedAnchorId && {
        YAAT_PANEL_EXPECTED_ANCHOR: options.expectedAnchorId,
      }),
      YAAT_PI_SUBAGENTS_ROOT: home.resolvedPackages.piSubagentsRoot,
      YAAT_PI_ANTIGRAVITY_ENTRY: home.resolvedPackages.piAntigravityEntryPath,
      ...options.extraEnv,
    },
    requestTimeoutMs: 15_000,
  });
  clients.push(client);
  const extensionErrors: unknown[] = [];
  client.on("event", (event: unknown) => {
    if ((event as { type?: string })?.type === "extension_error") extensionErrors.push(event);
  });
  const report = await server.waitForReady(key, 20_000);
  expect(extensionErrors).toEqual([]);
  expect(report.requiredExtensionsRegistered).toBe(
    Boolean(home.resolvedPackages.piSubagentsRoot && home.resolvedPackages.piAntigravityEntryPath),
  );
  await waitUntil(() => server.isControlConnected(key), 10_000);
  if (subagents && !report.subagentsRpcReady) {
    const diagnostic = await server.sendSubagentsRpc(key, "ping");
    throw new Error(
      `Initial subagents ping was not ready; later ping: ${JSON.stringify(diagnostic)}`,
    );
  }
  expect(report.subagentsRpcReady).toBe(Boolean(subagents));
  if (subagents) expect(report.subagentsSessionId).toBe(report.sessionProof.sessionId);
  expect(report.sessionProof.sessionId).toBeTruthy();
  expect(JSON.stringify(report).length).toBeLessThan(2_000);
  const state = await client.getState();
  expect(state.sessionId).toBe(report.sessionProof.sessionId);
  return { report, state, server, client, key };
}

function writeSyntheticProviderObserver(directory: string): string {
  const file = path.join(directory, "synthetic-provider-observer.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function observe(pi) {
  pi.registerProvider("panel-test", {
    baseUrl: "http://127.0.0.1",
    apiKey: "synthetic",
    api: "panel-test-api",
    models: [{ id: "synthetic", name: "Synthetic", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: "assistant", content: [{ type: "text", text: "ok" }],
          api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("before_agent_start", (event) => {
    fs.writeFileSync(process.env.YAAT_TEST_BEFORE_SNAPSHOT, JSON.stringify({
      selectedTools: event.systemPromptOptions.selectedTools,
      activeTools: pi.getActiveTools(),
      toolSnippets: event.systemPromptOptions.toolSnippets,
      section: event.systemPromptOptions.sections.agent_team_panel,
      panelTools: Object.fromEntries(pi.getAllTools().filter((tool) => tool.name.startsWith("panel_")).map((tool) => [tool.name, tool.description])),
    }));
  });
}
`,
  );
  return file;
}

describe.skipIf(!localPiBinary)("real Pi panel bridge gate", () => {
  it.skipIf(!subagents)(
    "starts without notInitialized, completes post-session_start ping, and serves bounded controls",
    async () => {
      const fixture = await startRealPi({});
      expect(fixture.report.sessionProof.entryCount).toBeGreaterThanOrEqual(0);
      expect(fixture.report.sessionProof.sessionFile).toBe(fixture.state.sessionFile ?? null);
      const checkpoint = await fixture.server.requestSessionCheckpoint(fixture.key);
      expect(checkpoint.sessionId).toBe(fixture.state.sessionId);
      expect(checkpoint.entryCount).toBe(fixture.report.sessionProof.entryCount);
      const pong = (await fixture.server.sendSubagentsRpc(fixture.key, "ping")) as {
        session?: { sessionId?: string };
      };
      expect(pong.session?.sessionId).toBe(fixture.state.sessionId);
    },
    30_000,
  );

  it("handles /quota without a turn and posts its snapshot through the real bridge", async () => {
    const directory = temporaryDirectory("panel-pi-quota-");
    const beforeTurn = path.join(directory, "before-turn.json");
    const snapshots: QuotaSnapshot[] = [];
    const fixture = await startRealPi({
      additionalExtension: writeSyntheticProviderObserver(directory),
      extraEnv: { YAAT_TEST_BEFORE_SNAPSHOT: beforeTurn },
      onQuota: (s) => snapshots.push(s),
    });
    await fixture.client.setModel("panel-test", "synthetic");
    await expect(fixture.client.prompt("/quota")).resolves.toMatchObject({
      disposition: "handled",
    });
    await waitUntil(() => snapshots.some((s) => s.provider === "panel-test"));
    expect(snapshots.find((s) => s.provider === "panel-test")).toMatchObject({
      provider: "panel-test",
      availability: "unsupported",
      groups: [],
    });
    expect(fs.existsSync(beforeTurn)).toBe(false);
  }, 30_000);

  it("updates real Pi tool descriptions, selected tools, and snippets on toolset changes", async () => {
    const directory = temporaryDirectory("panel-pi-dynamic-tools-");
    const snapshot = path.join(directory, "before-agent-start.json");
    const observer = writeSyntheticProviderObserver(directory);
    const stable: PanelTool = {
      name: "panel_stable",
      description: 'Presets: "One".',
      shape: {},
      handler: () => Promise.resolve("stable"),
    };
    let toolset: PanelToolset = {
      instructions: "first instructions",
      tools: [
        {
          name: "panel_alpha",
          description: "Alpha",
          shape: {},
          handler: () => Promise.resolve("alpha"),
          ...{ promptSnippet: "Use panel_alpha for alpha." },
        },
        stable,
      ],
    };
    const fixture = await startRealPi({
      getToolset: () => toolset,
      additionalExtension: observer,
      extraEnv: { YAAT_TEST_BEFORE_SNAPSHOT: snapshot },
    });
    await fixture.client.setModel("panel-test", "synthetic");
    toolset = {
      instructions: "expanded instructions",
      tools: [
        {
          name: "panel_beta",
          description: "Beta",
          shape: { value: z.string() },
          handler: () => Promise.resolve("beta"),
          ...{ promptSnippet: "Use panel_beta for beta." },
        },
        { ...stable, description: 'Presets: "Two".' },
      ],
    };
    fixture.server.notifyToolsetChanged(fixture.key);
    await expect(fixture.client.prompt("trigger before_agent_start")).resolves.toMatchObject({
      disposition: "started",
    });
    await waitUntil(() => fs.existsSync(snapshot));
    const observed = JSON.parse(fs.readFileSync(snapshot, "utf8")) as {
      selectedTools: string[];
      activeTools: string[];
      toolSnippets: Record<string, string>;
      section: string;
      panelTools: Record<string, string>;
    };
    expect(observed.selectedTools).toContain("panel_beta");
    expect(observed.selectedTools).not.toContain("panel_alpha");
    expect(observed.activeTools).toContain("panel_beta");
    expect(observed.activeTools).not.toContain("panel_alpha");
    expect(observed.toolSnippets.panel_beta).toBe("Use panel_beta for beta.");
    expect(observed.toolSnippets.panel_alpha).toBeUndefined();
    expect(observed.section).toBe("expanded instructions");
    expect(observed.panelTools).toMatchObject({
      panel_alpha: "Alpha",
      panel_beta: "Beta",
      panel_stable: 'Presets: "Two".',
    });
  }, 30_000);

  it("restores >32 MiB compacted Pi v3 history and probes only exact report markers", async () => {
    const directory = temporaryDirectory("panel-pi-large-history-");
    const reportId = "00000000-0000-4000-8000-000000000001";
    const sessionFile = writeLargeSession(directory, reportId);
    const fixture = await startRealPi({
      sessionFile,
      expectedAnchorId: "non-active-anchor",
    });
    expect(fixture.report.sessionProof.entryCount).toBeGreaterThanOrEqual(6);
    expect(fixture.report.sessionProof.leafId).toBeTruthy();
    expect(fixture.report.sessionProof.anchorOnActiveBranch).toBe(false);
    expect(fixture.report.sessionProof.anchorExistsInFile).toBe(true);
    expect(fixture.report.sessionProof.sessionFile).toBe(sessionFile);

    const checkpoint = await fixture.server.requestSessionCheckpoint(fixture.key);
    expect(checkpoint).toMatchObject({
      leafId: fixture.report.sessionProof.leafId,
      entryCount: fixture.report.sessionProof.entryCount,
      sessionFile,
    });
    await expect(
      fixture.server.probeDispatchedReport(fixture.key, "before", reportId),
    ).resolves.toEqual({ found: true, anchorMissing: false, matchedEntryId: "report" });
    await expect(
      fixture.server.probeDispatchedReport(
        fixture.key,
        "before",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).resolves.toEqual({ found: false, anchorMissing: false });
    // The next user entry has the same ordinary text but no unique marker.
    await expect(
      fixture.server.probeDispatchedReport(fixture.key, "report", reportId),
    ).resolves.toEqual({ found: false, anchorMissing: false });
    await expect(
      fixture.server.probeDispatchedReport(fixture.key, "missing-anchor", reportId),
    ).resolves.toEqual({ found: false, anchorMissing: true });
    if (subagents) {
      const pong = (await fixture.server.sendSubagentsRpc(fixture.key, "ping")) as {
        session?: { sessionId?: string };
      };
      expect(pong.session?.sessionId).toBe(fixture.state.sessionId);
    }
  }, 40_000);
});

describe("PanelHttpServer", () => {
  it("accepts only bounded quota snapshots on the authenticated route and targets one of two connected sessions", async () => {
    const { server, baseUrl } = await createPanelServer();
    const samples: unknown[] = [];
    const calls: string[] = [];
    const controls: Record<string, unknown>[] = [];
    const sample = {
      provider: "antigravity-acp",
      observedAt: Date.now(),
      availability: "available",
      groups: [{ name: "Gemini", windows: [{ label: "weekly", usedPct: 31 }] }],
    };
    const proof = {
      sessionId: "id",
      sessionFile: null,
      cwd: "/tmp",
      headerCwd: null,
      entryCount: 0,
      leafId: null,
      anchorOnActiveBranch: true,
      anchorExistsInFile: true,
    };
    const secondSample = { ...sample, provider: "kimi-coding" };
    for (const [key, reply] of [
      ["p1", sample],
      ["p2", secondSample],
    ] as const) {
      const token = server.registerSession({
        sessionKey: key,
        getToolset: () => null,
        onQuota: (s) => samples.push(s),
      });
      const post = (body: unknown, auth = token) =>
        request(baseUrl, key, "quota", auth, { method: "POST", body });
      expect((await post(sample, "wrong")).status).toBe(401);
      for (const invalid of [
        { ...sample, headers: "secret" },
        { ...sample, provider: "native-codex" },
        { ...sample, groups: Array(33).fill(sample.groups[0]) },
        {
          ...sample,
          groups: [{ name: "g", windows: Array(17).fill(sample.groups[0].windows[0]) }],
        },
        { ...sample, groups: [{ name: "g".repeat(101), windows: sample.groups[0].windows }] },
      ])
        expect((await post(invalid)).status).toBe(400);
      expect((await post(sample)).status).toBe(200);
      await request(baseUrl, key, "ready", token, {
        method: "POST",
        body: {
          sessionProof: proof,
          ownerToolNames: [],
          quotaProviders: [reply.provider],
          requiredExtensionsRegistered: false,
          subagentsRpcReady: false,
          subagentsSessionId: null,
        },
      });
      await openControl(baseUrl, key, token, (msg) => {
        calls.push(key);
        controls.push(msg);
        void request(baseUrl, key, "control-reply", token, {
          method: "POST",
          body: { controlId: msg.controlId, result: reply },
        });
      });
    }
    const reader = server.quotaReader();
    expect(reader?.configured).toEqual([sample.provider, secondSample.provider]);
    expect(await reader?.read(sample.provider)).toEqual(sample);
    expect(await reader?.read(secondSample.provider)).toEqual(secondSample);
    expect(controls).toMatchObject([
      { type: "refresh_quota", provider: sample.provider, force: false },
      { type: "refresh_quota", provider: secondSample.provider, force: false },
    ]);
    expect(await reader?.read(sample.provider, { force: true })).toEqual(sample);
    expect(controls.at(-1)).toMatchObject({
      type: "refresh_quota",
      provider: sample.provider,
      force: true,
    });
    expect(calls).toEqual(["p1", "p2", "p1"]);
    expect(samples).toEqual([sample, sample]);
  });
  it("enforces bearer auth, live expansion/revocation, and control replies", async () => {
    const { server, baseUrl } = await createPanelServer();
    let toolset: PanelToolset | null = {
      instructions: "first",
      tools: [
        {
          name: "alpha",
          description: "Alpha",
          shape: { value: z.string() },
          handler: (args) => Promise.resolve(`alpha:${String(args.value)}`),
        },
      ],
    };
    const key = "workspace/agent";
    const token = server.registerSession({ sessionKey: key, getToolset: () => toolset });

    const unauthorized = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(key)}/toolset`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(unauthorized.status).toBe(401);
    const first = await request(baseUrl, key, "toolset", token);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ version: 0, instructions: "first" });
    expect(
      await (
        await request(baseUrl, key, "call", token, {
          method: "POST",
          body: { name: "alpha", params: { value: "one" } },
        })
      ).json(),
    ).toEqual({ text: "alpha:one", isError: false });

    const messages: Record<string, unknown>[] = [];
    const closeControl = await openControl(baseUrl, key, token, (message) => {
      messages.push(message);
      if (message.type === "session_checkpoint") {
        const result: SessionCheckpoint = {
          leafId: "leaf",
          entryCount: 3,
          sessionId: "session",
          sessionFile: "/tmp/session.jsonl",
        };
        void request(baseUrl, key, "control-reply", token, {
          method: "POST",
          body: { controlId: message.controlId, result },
        });
      } else if (message.type === "subagents_rpc") {
        void request(baseUrl, key, "control-reply", token, {
          method: "POST",
          body: { controlId: message.controlId, result: { pong: true } },
        });
      }
    });
    await waitUntil(() => server.isControlConnected(key));
    server.notifyToolsetChanged(key);
    await waitUntil(() => messages.some((message) => message.type === "toolset_changed"));
    await expect(server.requestSessionCheckpoint(key)).resolves.toEqual({
      leafId: "leaf",
      entryCount: 3,
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
    });
    await expect(server.sendSubagentsRpc(key, "ping")).resolves.toEqual({ pong: true });

    toolset = {
      instructions: "second",
      tools: [
        {
          name: "beta",
          description: "Beta",
          shape: {},
          handler: () => Promise.resolve("beta"),
        },
      ],
    };
    server.notifyToolsetChanged(key);
    const expanded = (await (await request(baseUrl, key, "toolset", token)).json()) as {
      tools: Array<{ name: string }>;
      version: number;
      instructions: string;
    };
    expect(expanded).toMatchObject({ version: 2, instructions: "second" });
    expect(expanded.tools.map((tool: { name: string }) => tool.name)).toEqual(["beta"]);
    const revoked = await request(baseUrl, key, "call", token, {
      method: "POST",
      body: { name: "alpha", params: { value: "two" } },
    });
    expect(revoked.status).toBe(403);
    toolset = null;
    const betaRevoked = await request(baseUrl, key, "call", token, {
      method: "POST",
      body: { name: "beta", params: {} },
    });
    expect(betaRevoked.status).toBe(403);

    closeControl();
    server.unregisterSession(key);
    const unregistered = await request(baseUrl, key, "toolset", token);
    expect(unregistered.status).toBe(403);
  });

  it("propagates an aborted HTTP tool call to its handler signal", async () => {
    const { server, baseUrl } = await createPanelServer();
    let handlerSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const tool: PanelTool = {
      name: "slow",
      description: "Slow",
      shape: {},
      handler: async (_args: Record<string, unknown>, signal?: AbortSignal) => {
        handlerSignal = signal;
        markStarted();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("Panel tool call aborted"),
              ),
            { once: true },
          );
        });
        return "unreachable";
      },
    };
    const token = server.registerSession({
      sessionKey: "abort",
      getToolset: () => ({ instructions: "", tools: [tool] }),
    });
    const abort = new AbortController();
    const pending = request(baseUrl, "abort", "call", token, {
      method: "POST",
      body: { name: "slow", params: {} },
      signal: abort.signal,
    });
    await started;
    abort.abort();
    await expect(pending).rejects.toThrow();
    await waitUntil(() => handlerSignal?.aborted === true);
  });
});
