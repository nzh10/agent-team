import * as http from "http";
import type { AddressInfo } from "net";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { WebSocketServer, WebSocket } from "ws";
import {
  Workspace,
  WorkspaceCallbacks,
  type ProjectLink,
  type WorkspaceInfo,
} from "../workspace/workspace";
import {
  saveWorkspace,
  deleteWorkspaceState,
  saveIndex,
  loadAll,
  loadWorkspaceMessages,
  historyOf,
  historyFile,
  historyIndexFile,
  closeHistory,
  appendLog,
  isLoggedEvent,
} from "../workspace/state";
import { loadConfig, AppConfig } from "../config/config";
import { ModelSelectionError, type ModelDiscoveryIssue } from "../config/model-diagnostics";
import {
  MODEL_OPTIONS,
  availableModelOptions,
  backendForModel,
  effortLevelsForModel,
  isCodexCliAvailable,
  type ModelOption,
} from "../config/presets";
import { CommandInfo, StreamEvent, type PiAvailableModel } from "../session/types";
import { HostRegistry, LocalHost } from "../session/host";
import { codexProcessEnv, probeCodexAuth, type CodexAuthState } from "../session/codex";
import { completeDirs, resolveWorkspacePath } from "../repo/dirs";
import { GitScanner } from "../repo/scanner";
import { HistoryService, sidebarHits, type SearchHit } from "../workspace/history-service";
import { summarizeMessages, toWireMessage } from "../workspace/summary";
import { ProjectManager, type ProjectHost } from "../project/manager";
import { Auth } from "./auth";
import { mergeLocalCommands } from "./commands";
import {
  codexModelIssue,
  describeModelDiscovery,
  piSessionConfig,
  probePiCatalog,
  type ModelDiscoverySnapshot,
} from "./model-discovery";
import { HttpHandler } from "./http";
import { DeployControl, DEPLOY_RETRY, type DeployTarget } from "./deploy-control";
import { QuotaMonitor, type QuotaRefreshOptions } from "./quota";
import { inspectAcpRuntime, ACP_PREPARE_STEP } from "../session/acp-readiness";
import { CodexQuotaSource } from "./native-codex-quota";
import { QuotaAdapterRegistry } from "../session/quota/registry";
import { piAdapters } from "../session/quota/pi-adapters";
import {
  ACP,
  NATIVE_CODEX,
  providerId,
  unavailable,
  type PiQuotaReader,
  type QuotaReadOptions,
} from "../session/quota-schema";
import { SystemMonitor } from "./system";
import { serviceReport } from "../config/diagnostics";
import { applyRuntimeEnvironment } from "../config/runtime";

function stripEventsInnerEvents(events: StreamEvent[]): StreamEvent[] {
  return events.map((e) => {
    if (!e.subagent?.events?.length) return e;
    return {
      ...e,
      subagent: { ...e.subagent, eventCount: e.subagent.events.length, events: undefined },
    };
  });
}

const execFileAsync = promisify(execFile);

// Protocol-level ping cadence; a client that misses one round is dropped.
const HEARTBEAT_INTERVAL_MS = 30_000;

interface QuotaReadContext {
  reader: PiQuotaReader | undefined;
  acpReady: boolean;
}

export class Server {
  private httpServer: http.Server;
  // The port it listens on, once it does: the one the system chose for 0.
  readonly listening: Promise<number>;
  private wss: WebSocketServer;
  private workspaces = new Map<string, Workspace>();
  private uiClients = new Set<WebSocket>();
  private config: AppConfig;
  private baseDir: string;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private branchTimer: ReturnType<typeof setInterval> | null = null;
  private readonly commandsByAgent = new Map<string, Map<string, CommandInfo[]>>();
  private catalogModels: PiAvailableModel[] = [];
  private piCatalogIssue?: ModelDiscoveryIssue;
  private catalogRevision = 0;
  private codexAuth: CodexAuthState = initialCodexAuthState();
  private recheckingCodexAuth: Promise<CodexAuthState> | null = null;
  private models: ModelOption[] = availableModelOptions([], { codexAuthenticated: false });
  private staleLeadToolWorkspaces = new Set<string>();
  private readonly restoring: Promise<void>;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly deploy?: DeployControl;
  readonly controlReady: Promise<void>;
  private pendingWork = 0;
  private bootFence?: string;
  private restored = false;
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sendOrder = new Map<string, Promise<void>>();
  private uploadsDir: string;
  private hostRegistry: HostRegistry;
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private archiveTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Clients that answered the last protocol-level ping. Mobile browsers drop
  // sockets without a close frame (screen off, network switch); without this
  // the server keeps writing into a dead socket forever.
  private alive = new WeakSet<WebSocket>();
  private auth: Auth;
  private http: HttpHandler;
  private codexQuota = new CodexQuotaSource(
    () => this.codexAuth.authenticated && this.codexAuth.accountType === "chatgpt",
  );
  private acpQuotaReady?: boolean;
  private quota = new QuotaMonitor(
    (quota) => this.broadcastUI({ type: "quota_snapshot", quota: this.quotaState(quota) }),
    new QuotaAdapterRegistry<QuotaReadContext>(
      [
        this.codexQuota,
        ...piAdapters().ids.map((id) => ({
          id,
          isConfigured: ({ reader, acpReady }: QuotaReadContext) =>
            (id !== ACP || acpReady) && !!reader?.configured.includes(id),
          unconfiguredReason: ({ reader, acpReady }: QuotaReadContext) =>
            id === ACP && !acpReady && reader?.configured.includes(ACP)
              ? ("waiting for ACP setup" as const)
              : reader
                ? ("not configured" as const)
                : ("waiting for Pi session" as const),
          fetchQuota: (
            { reader }: QuotaReadContext,
            _signal: AbortSignal,
            options?: QuotaReadOptions,
          ) =>
            id === ACP && !inspectAcpRuntime().ready
              ? Promise.resolve({ ...unavailable(id), reason: "waiting for ACP setup" as const })
              : reader!.read(id, options),
        })),
      ],
      55_000,
    ),
    () => this.dispatchAllowed,
  );
  private system = new SystemMonitor();
  private git: GitScanner<Workspace>;
  private projects: ProjectManager;
  private history: HistoryService;

  constructor(
    port: number,
    baseDir: string,
    webDir: string,
    deployTarget?: DeployTarget,
    bootFence?: string,
  ) {
    this.baseDir = baseDir;
    this.bootFence = bootFence;
    this.history = new HistoryService(historyIndexFile(baseDir), historyFile(baseDir));
    this.uploadsDir = path.join(baseDir, "uploads");
    if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.config = loadConfig(baseDir);
    applyRuntimeEnvironment(this.config.server.proxy, this.config.pi?.acp?.binary);
    this.hostRegistry = this.initHosts();
    this.auth = new Auth(() => this.config.auth);
    this.git = new GitScanner(
      () => [...this.workspaces.values()].filter((w) => !w.isArchived),
      (w) =>
        this.broadcastUI({ type: "workspace_git_update", workspaceId: w.id, git: w.git, pr: w.pr }),
    );
    this.projects = new ProjectManager(baseDir, this.projectHost());
    if (deployTarget)
      this.deploy = new DeployControl(
        deployTarget,
        () => ({
          ...this.projects.deployBlockers(),
          bootstrap: this.restored ? 0 : 1,
          workspaces: [...this.workspaces.values()].filter((w) => w.deployBusy).length,
          requests: this.pendingWork + this.sendOrder.size,
          backendCleanup: this.hostRegistry
            .getAll()
            .reduce((n, host) => n + (host.pendingCleanup ?? 0), 0),
          probes: (this.recheckingCodexAuth ? 1 : 0) + (this.quota.inFlight ? 1 : 0),
          bootFence: this.bootFence ? 1 : 0,
          retries: this.retryTimers.size,
          shutdown: this.closing ? 1 : 0,
        }),
        async (signal) => {
          const results = await Promise.allSettled(
            [...this.workspaces.values()].map((w) => w.retireIdleProcesses(signal)),
          );
          if (results.some((result) => result.status === "rejected"))
            throw new Error("Backend retirement failed");
        },
        () => {
          if (!this.dispatchAllowed) return;
          this.projects.resumeDispatch();
          for (const w of this.workspaces.values())
            if (!w.isArchived) for (const id of w.agents.keys()) w.dequeueNext(id);
        },
      );
    this.watchConfig();

    this.http = new HttpHandler(
      this.auth,
      webDir,
      this.uploadsDir,
      baseDir,
      (id) => this.workspaces.get(id)?.cwd,
      (id) => this.workspaces.get(id)?.pr?.base,
      (id) => this.projects.paths(id),
      undefined,
      (id) => {
        const project = this.workspaces.get(id)?.projectLink?.projectId;
        return project && this.projects.paths(project)?.notesDir;
      },
      () => serviceReport(baseDir, this.config, this.modelDiscoverySnapshot()),
    );
    this.httpServer = http.createServer((req, res) => this.http.handle(req, res));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: (info: { req: http.IncomingMessage }) => this.auth.isAuthenticated(info.req),
      // History pages and stream events are highly repetitive JSON; deflate
      // cuts them several-fold, which matters most on mobile links.
      perMessageDeflate: { threshold: 1024 },
    });
    this.wss.on("connection", (ws) => this.onConnect(ws));
    this.heartbeatTimer = setInterval(() => this.sweepDeadClients(), HEARTBEAT_INTERVAL_MS);
    this.checkAcpQuotaReadiness();

    this.restoring = this.restoreState().finally(() => {
      this.restored = true;
    });
    // The search index catches up with the history in the background.
    this.history.changed();
    this.statusTimer = setInterval(() => {
      this.checkAcpQuotaReadiness();
      this.broadcastSystemStatus();
    }, 3000);
    this.branchTimer = setInterval(() => {
      void this.git.scan();
    }, 3000);
    void this.git.scan();
    this.sweepArchives();
    this.archiveTimer = setInterval(() => this.sweepArchives(), 3600_000);

    const host = process.env.AGENT_TEAM_HOST || "0.0.0.0";
    this.listening = this.restoring.then(
      () =>
        new Promise<number>((resolve) => {
          if (this.closing) {
            resolve(port);
            return;
          }
          this.httpServer.listen(port, host, () => {
            const bound = (this.httpServer.address() as AddressInfo).port;
            console.log(`Agent Team server listening on http://${host}:${bound}`);
            resolve(bound);
          });
        }),
    );
    this.controlReady = this.listening.then(() => this.deploy?.listen());
    if (bootFence) {
      const releaseFence = () => {
        if (this.closing || this.bootFence !== bootFence || fs.existsSync(bootFence)) return;
        fs.unwatchFile(bootFence, releaseFence);
        this.bootFence = undefined;
        void this.track(this.resumeRestoredWork()).catch((error: unknown) =>
          console.error("[restore]", error),
        );
      };
      fs.watchFile(bootFence, { interval: 250 }, releaseFence);
      void this.listening.then(releaseFence);
    }
  }

  private get dispatchAllowed(): boolean {
    return !this.closing && !this.bootFence && !this.deploy?.sealed;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pendingWork++;
    return work.finally(() => this.pendingWork--);
  }

  private initHosts(): HostRegistry {
    const registry = new HostRegistry();
    for (const [id, cfg] of Object.entries(this.config.hosts)) {
      registry.register(
        new LocalHost(id, cfg.label, {
          pi: (s) => {
            if (s.provider !== ACP || inspectAcpRuntime().ready) this.quota.accept(s);
          },
          piReaderReady: (providers) => this.refreshQuota({ newlyReadable: providers }),
          codex: (limits) => {
            if (this.codexQuota.isConfigured())
              this.quota.accept(this.codexQuota.snapshot(limits, Date.now(), true));
          },
        }),
      );
    }
    console.log(
      `Hosts: ${registry
        .getAll()
        .map((h) => `${h.id} (${h.type})`)
        .join(", ")}`,
    );
    return registry;
  }

  private quotaState(quota = this.quota.state()) {
    return { ...quota, acpPrepareStep: ACP_PREPARE_STEP };
  }

  private checkAcpQuotaReadiness(): void {
    if (this.closing) return;
    const ready = inspectAcpRuntime().ready;
    if (ready === this.acpQuotaReady) return;
    this.acpQuotaReady = ready;
    this.refreshQuota({ providers: [ACP], newlyReadable: ready ? [ACP] : [] });
  }

  private refreshQuota(options?: QuotaRefreshOptions): void {
    if (!this.closing)
      void this.quota.refresh(
        () => ({ reader: this.piQuotaReader(), acpReady: inspectAcpRuntime().ready }),
        options,
      );
  }

  private quotaProviderForModel(model: string): string | undefined {
    if (backendForModel(model) === "codex") return NATIVE_CODEX;
    const parsed = providerId.safeParse(model.split("/", 1)[0]);
    if (!parsed.success) return;
    return this.quota.state().rows.some((row) => row.provider === parsed.data)
      ? parsed.data
      : undefined;
  }

  private piQuotaReader(): PiQuotaReader | undefined {
    const readers = this.hostRegistry
      .getAll()
      .flatMap((host) => host.quotaReader?.() ?? [])
      .sort((a, b) => b.configured.length - a.configured.length);
    if (readers.length <= 1) return readers[0];
    const routes = new Map<string, PiQuotaReader>();
    for (const reader of readers) {
      for (const provider of reader.configured) {
        if (!routes.has(provider)) routes.set(provider, reader);
      }
    }
    return {
      configured: [...routes.keys()],
      read: (provider, options) => {
        const reader = routes.get(provider);
        if (!reader) return Promise.reject(new Error("Quota provider is not configured"));
        return reader.read(provider, options);
      },
    };
  }

  private getSystemStatus(): Record<string, unknown> {
    return { type: "system_status", ...this.system.snapshot() };
  }

  private broadcastSystemStatus(): void {
    if (this.uiClients.size === 0) return;
    this.broadcastUI(this.getSystemStatus());
  }

  private sendJson(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcastUI(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of this.uiClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private sweepDeadClients(): void {
    for (const ws of this.uiClients) {
      if (!this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }

  private onConnect(ws: WebSocket): void {
    this.uiClients.add(ws);
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    // ws emits 'error' for frames it cannot parse (invalid UTF-8, bad
    // opcode); unhandled, that is an uncaught exception that kills every turn.
    ws.on("error", () => ws.terminate());

    ws.on("message", (raw) => {
      try {
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw);
        const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
        this.handleMessage(ws, msg);
      } catch (e) {
        this.sendJson(ws, { type: "error", message: `Invalid message: ${String(e)}` });
      }
    });

    ws.on("close", () => {
      this.uiClients.delete(ws);
    });

    this.projects.showAllAwaiting();
    const commandsByAgent = Object.fromEntries(
      [...this.workspaces.values()].map((w) => [
        w.id,
        Object.fromEntries(
          (this.isProjectSealed(w) ? [] : [...w.agents.keys()]).map((id) => [
            id,
            this.commandsByAgent.get(w.id)?.get(id) ?? mergeLocalCommands([]),
          ]),
        ),
      ]),
    );
    const commands = mergeLocalCommands([]);
    this.sendJson(ws, {
      type: "init",
      sendReceipt: true,
      quota: this.quotaState(),
      // Identifies the served bundle; a client that reconnects and sees a
      // different id reloads itself (home-screen apps never reload on their own).
      buildId: this.http.buildId(),
      workspaces: [...this.workspaces.values()].map((w) => this.listInfo(w)),
      models: this.models,
      codexAuth: this.codexAuth,
      commands,
      commandsByAgent,
      extensionUi: [...this.workspaces.values()].flatMap((w) => w.getExtensionUi()),
      pendingDialogs: [...this.workspaces.values()].flatMap((w) => w.getPendingDialogs()),
      config: {
        presets: this.config.presets,
        user: this.config.user,
        models: this.models,
        codexAuth: this.codexAuth,
        commands,
        hosts: this.config.hosts,
        archiveAfterDays: this.config.workspace.archive_after_days,
      },
      hosts: this.hostRegistry.getAllInfo(),
      projects: this.projects.list(),
      issues: this.projects.issueSets(),
    });
    this.sendJson(ws, this.getSystemStatus());
    this.refreshQuota({ force: false });
  }

  private isProjectSealed(w: Workspace): boolean {
    return !!w.projectLink && this.projects.get(w.projectLink.projectId)?.status === "sealed";
  }

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    const workspace = this.workspaces.get(msg.workspaceId as string);
    const reject = (message: string, retryable = false) =>
      this.sendJson(ws, {
        type: "error",
        message,
        retryable,
        requestId: msg.requestId,
      });
    if (
      !this.dispatchAllowed &&
      ![
        "open_workspace",
        "load_messages",
        "load_message_details",
        "load_subagent_events",
        "search",
        "list_dirs",
        "ping",
        "mark_seen",
      ].includes(String(msg.type))
    ) {
      reject(DEPLOY_RETRY, true);
      return;
    }
    if (
      workspace &&
      this.isProjectSealed(workspace) &&
      [
        "send_message",
        "forward_message",
        "clear_context",
        "add_agent",
        "remove_agent",
        "set_reporting",
        "delete_workspace",
        "cancel_queued",
        "debug_rate_limit",
        "archive_workspace",
        "unarchive_workspace",
        "cancel_subagent",
        "abort",
        "interrupt",
        "cancel_wakeup",
      ].includes(String(msg.type))
    ) {
      reject("Project is sealed");
      return;
    }
    switch (msg.type) {
      case "refresh_quota": {
        let providers: string[] | undefined;
        if (msg.providers !== undefined) {
          if (!Array.isArray(msg.providers) || msg.providers.length > 32) {
            this.sendJson(ws, { type: "error", message: "Invalid quota providers" });
            return;
          }
          providers = [];
          for (const value of msg.providers) {
            const parsed = providerId.safeParse(value);
            if (!parsed.success) {
              this.sendJson(ws, { type: "error", message: "Invalid quota providers" });
              return;
            }
            if (!providers.includes(parsed.data)) providers.push(parsed.data);
          }
        }
        this.refreshQuota({ force: msg.force === true, providers });
        return;
      }
      case "recheck_codex_auth":
        void this.recheckCodexAuth(true);
        return;
      case "open_workspace":
      case "load_messages": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace && this.ensureLoaded(workspace)) {
          const before = (msg.before as number) ?? Infinity;
          const limit =
            typeof msg.limit === "number" && Number.isFinite(msg.limit)
              ? Math.min(200, Math.max(0, Math.trunc(msg.limit)))
              : 50;
          const all = workspace.getMessages();
          const older = before === Infinity ? all : all.filter((m) => m.timestamp < before);
          // A prompt and its reply often share a millisecond, and the client
          // only knows the oldest message it has, not which of its same-ms
          // neighbours it has: send all of them on top of the page (the client
          // drops duplicates by id).
          const tied = before === Infinity ? [] : all.filter((m) => m.timestamp === before);
          const page = limit === 0 ? [] : [...older.slice(-limit), ...tied];
          this.sendJson(ws, {
            type: "workspace_messages",
            workspaceId: workspace.id,
            messages: summarizeMessages(page),
            hasMore: older.length > limit,
            extensionUi: workspace.getExtensionUi(),
            pendingDialogs: workspace.getPendingDialogs(),
            // Echoed so the client can tell an older page from a resync of
            // the newest one (the latter replaces, the former prepends).
            before: before === Infinity ? null : before,
          });
        }
        return;
      }

      case "load_message_details": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (!workspace || !this.ensureLoaded(workspace)) return;
        const message = workspace.getMessages().find((m) => m.id === msg.messageId);
        if (!message) return;
        this.sendJson(ws, {
          type: "message_details",
          workspaceId: workspace.id,
          messageId: message.id,
          events: stripEventsInnerEvents(message.events ?? []),
        });
        return;
      }

      case "load_subagent_events": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace && this.ensureLoaded(workspace)) {
          const message = workspace.getMessages().find((m) => m.id === msg.messageId);
          const ev = message?.events?.find((e) => e.subagent?.taskId === msg.taskId);
          this.sendJson(ws, {
            type: "subagent_events",
            workspaceId: msg.workspaceId,
            messageId: msg.messageId,
            taskId: msg.taskId,
            events: ev?.subagent?.events ?? [],
          });
        }
        return;
      }

      case "create_workspace":
        this.createWorkspace(
          ws,
          msg.name as string,
          msg.path as string,
          msg.hostId as string | undefined,
          msg.projectName as string | undefined,
        );
        return;

      case "create_project":
        this.createProject(
          ws,
          msg.name as string,
          (msg.root === undefined ? msg.path : msg.root) as string | null,
          msg.model as string | undefined,
          msg.cwd as string | undefined,
        );
        return;

      case "seal_project":
        this.projectAction(ws, async () => {
          const id = msg.projectId as string;
          const sealing = this.projects.sealProject(id, msg.reason as string | undefined);
          await sealing;
          this.removeProjectRuntimeCaches(id);
        });
        return;

      case "ui_dialog_response": {
        const { agentId, processGeneration, requestId, value, confirmed, cancelled } = msg;
        if (
          typeof agentId !== "string" ||
          typeof processGeneration !== "number" ||
          typeof requestId !== "string"
        )
          return;
        workspace?.respondToUiDialog(agentId, processGeneration, requestId, {
          requestId,
          value: typeof value === "string" ? value : undefined,
          confirmed: typeof confirmed === "boolean" ? confirmed : undefined,
          cancelled: cancelled === true,
        });
        return;
      }

      case "rename_project":
        this.projectAction(ws, () =>
          this.projects.rename(msg.projectId as string, msg.name as string),
        );
        return;

      case "delete_project":
        this.projectAction(ws, () => this.projects.delete(msg.projectId as string));
        return;

      case "list_dirs":
        this.sendJson(ws, {
          type: "dirs",
          prefix: msg.prefix,
          dirs: completeDirs((msg.prefix as string) ?? ""),
        });
        return;

      case "search": {
        const query = (msg.query as string) ?? "";
        this.search(query)
          .catch((e: unknown) => {
            console.error("[search]", e);
            return [];
          })
          .then((hits) => this.sendJson(ws, { type: "search_results", query, hits }))
          .catch(() => {});
        return;
      }

      case "delete_workspace":
        this.deleteWorkspace(msg.workspaceId as string);
        return;

      case "add_agent":
        this.addAgent(
          ws,
          msg.workspaceId as string,
          msg.name as string,
          msg.model as string,
          msg.avatar as string,
          msg.color as string,
          msg.permissionMode as string | undefined,
          (msg.effort as string | undefined) || undefined,
        );
        return;

      case "remove_agent":
        this.removeAgent(msg.workspaceId as string, msg.agentId as string);
        return;

      case "send_message": {
        const quote = msg.quote as
          { messageId: string; agentId: string | null; content: string } | undefined;
        // send_receipt marks admission (persisted and broadcast into the transcript);
        // any later failure during dispatchPrompt is a delivery error, not a draft rejection.
        let receiptSent = false;
        let settleAdmission!: () => void;
        const admitted = new Promise<void>((resolve) => {
          settleAdmission = resolve;
        });
        const sendReceipt = () => {
          if (receiptSent) return;
          receiptSent = true;
          settleAdmission();
          if (typeof msg.requestId === "string")
            this.sendJson(ws, { type: "send_receipt", requestId: msg.requestId });
        };
        let images: Array<{ name: string; url: string; path: string }> | undefined;
        try {
          const rawImages = msg.images as Array<{ name: string; url: string }> | undefined;
          if (rawImages !== undefined && !Array.isArray(rawImages))
            throw new Error("Invalid images");
          images = rawImages?.map((img) => ({
            name: img.name,
            url: img.url,
            path: path.join(this.uploadsDir, path.basename(img.url)),
          }));
        } catch (error) {
          reject(error instanceof Error ? error.message : String(error));
          return;
        }
        const send = async () => {
          try {
            await this.sendMessage(
              msg.workspaceId as string,
              msg.content as string,
              msg.target as string | undefined,
              images,
              quote,
              sendReceipt,
            );
            sendReceipt();
          } catch (error) {
            settleAdmission();
            if (receiptSent) {
              this.sendJson(ws, {
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
            } else {
              reject(error instanceof Error ? error.message : String(error));
            }
          } finally {
            settleAdmission();
          }
        };
        // Sends keep their order even when one waits on an image download.
        const wsId = msg.workspaceId as string;
        const missing = images?.filter((img) => !fs.existsSync(img.path)) ?? [];
        const prev = this.sendOrder.get(wsId);
        if (!prev && missing.length === 0) {
          void this.track(send());
          return;
        }
        const next = (prev ?? Promise.resolve())
          .then(() => (missing.length ? this.fetchRemoteImages(missing) : undefined))
          .then(() => {
            void this.track(send());
            return admitted;
          })
          .catch((error: unknown) => {
            settleAdmission();
            reject(String(error));
          });
        this.sendOrder.set(wsId, next);
        void next.finally(() => {
          if (this.sendOrder.get(wsId) === next) this.sendOrder.delete(wsId);
        });
        return;
      }

      case "abort":
        this.abortAgent(msg.workspaceId as string, msg.agentId as string | undefined);
        return;

      // Stop the running turn only; background tasks and wake-ups go on.
      case "interrupt": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        const agentId = msg.agentId as string | undefined;
        if (!workspace) return;
        void this.track(
          agentId ? workspace.interruptAgent(agentId) : workspace.interruptAll(),
        ).catch((e: unknown) =>
          this.sendJson(ws, {
            type: "error",
            message: `Stop failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
        );
        return;
      }

      case "cancel_wakeup": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        const refused = workspace
          ? workspace.cancelWake(msg.agentId as string)
          : "No wake-up to cancel";
        if (refused) this.sendJson(ws, { type: "error", message: refused });
        return;
      }

      // A client showed the session: its messages are read on every device.
      case "mark_seen": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (!workspace) return;
        if (workspace.unseen) {
          workspace.unseen = 0;
          this.persistWorkspace(workspace.id);
        }
        this.broadcastUI({ type: "workspace_seen", workspaceId: workspace.id });
        return;
      }

      case "archive_workspace":
        this.archiveWorkspace(msg.workspaceId as string, false);
        return;

      case "unarchive_workspace": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (
          workspace &&
          this.unarchiveWorkspace(workspace) &&
          workspace.projectLink?.role === "lead"
        ) {
          this.projectAction(ws, () => this.projects.drainInbox(workspace.projectLink!.projectId));
        }
        return;
      }

      case "purge_archived": {
        // One project's archived sessions, those in no project (null), or
        // every one (no projectId). A project goes with its lead: only an
        // explicit delete does that.
        const scope = msg.projectId as string | null | undefined;
        for (const w of [...this.workspaces.values()]) {
          if (!w.isArchived) continue;
          const link = w.projectLink && this.projects.get(w.projectLink.projectId) && w.projectLink;
          if (scope === null && link) continue;
          if (scope && link?.projectId !== scope) continue;
          if (link?.role === "lead") continue;
          this.deleteWorkspace(w.id);
        }
        return;
      }

      case "archive_project":
        this.projectAction(ws, async () => {
          const id = msg.projectId as string;
          this.projects.setArchived(id, msg.archived !== false);
          if (msg.archived === false) await this.projects.drainInbox(id);
        });
        return;

      case "set_reporting":
        this.projectAction(ws, () =>
          this.projects.setReporting(msg.workspaceId as string, msg.reports === true),
        );
        return;

      case "cancel_queued": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (!workspace || !this.ensureLoaded(workspace)) return;
        if (workspace.cancelQueued(msg.messageId as string)) {
          this.persistWorkspaceNow(workspace.id);
          this.broadcastUI({
            type: "message_removed",
            workspaceId: workspace.id,
            messageId: msg.messageId,
          });
          this.flushPendingLeadTools(workspace);
        }
        return;
      }

      case "debug_rate_limit": {
        if (process.env.AGENT_TEAM_DEBUG !== "1") return;
        const workspace = this.workspaces.get(msg.workspaceId as string);
        const entry = workspace?.agents.get(msg.agentId as string);
        entry?.session.simulateRateLimit?.({
          rateLimitType: msg.rateLimitType as string | undefined,
          resetsAt: msg.resetsAt as number | undefined,
        });
        return;
      }

      case "cancel_subagent": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (!workspace) {
          this.sendJson(ws, { type: "error", message: "Workspace not found" });
          return;
        }
        try {
          void this.track(
            workspace.cancelSubagent(msg.agentId as string, msg.taskId as string),
          ).catch((e) => {
            this.sendJson(ws, {
              type: "error",
              message: `${e instanceof Error ? e.message : String(e)}`,
            });
          });
        } catch (e) {
          this.sendJson(ws, {
            type: "error",
            message: `${e instanceof Error ? e.message : String(e)}`,
          });
        }
        return;
      }

      case "clear_context": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace && workspace.clearContext(msg.agentId as string)) {
          this.persistWorkspaceNow(workspace.id);
          this.flushPendingLeadTools(workspace);
        }
        return;
      }

      case "forward_message":
        void this.track(
          this.forwardMessage(
            msg.workspaceId as string,
            msg.messageId as string,
            msg.targetAgentId as string,
          ),
        );
        return;

      case "restart_server":
        void this.restartServer();
        return;

      // Application-level liveness probe: browsers cannot see ws ping/pong
      // frames, so the client sends its own and expects a reply.
      case "ping":
        this.sendJson(ws, { type: "pong" });
        return;

      default:
        this.sendJson(ws, { type: "error", message: `Unknown message type: ${String(msg.type)}` });
    }
  }

  private createWorkspace(
    ws: WebSocket,
    name: string,
    pathInput: string,
    hostId?: string,
    projectName?: string,
  ): void {
    const cwd = resolveWorkspacePath(pathInput ?? "");
    if (!cwd) {
      this.sendJson(ws, { type: "error", message: `Not a directory: ${pathInput}` });
      return;
    }
    // A workspace is a session of its folder's project (made, with its lead,
    // if the folder has none yet).
    this.projectAction(ws, () => {
      const project = this.projects.ensureFor(cwd, projectName);
      this.makeWorkspace(name, cwd, hostId, {
        projectId: project.id,
        role: "worker",
        unreported: true,
      });
    });
  }

  private makeWorkspace(
    name: string,
    cwd: string,
    hostId?: string,
    projectLink?: ProjectLink,
  ): Workspace {
    const resolvedHostId = hostId || this.hostRegistry.getDefault()?.id || "local";
    const id = genId("ws");
    const workspace = new Workspace(
      id,
      name,
      path.basename(cwd),
      resolvedHostId,
      cwd,
      this.hostRegistry,
      this.makeCallbacks(id),
      { dataDir: this.baseDir, uploadsDir: this.uploadsDir },
    );

    // Same-folder workspaces share the scanner's cache; seed from it so the
    // header has branch/PR info from the first frame.
    const cached = this.git.cached(cwd);
    if (cached) {
      workspace.git = cached.git;
      workspace.pr = cached.pr;
    }
    workspace.projectLink = projectLink;
    this.workspaces.set(id, workspace);
    try {
      this.persistWorkspaceNow(id);
      this.persistIndex();
    } catch (e) {
      this.workspaces.delete(id);
      void workspace.dispose();
      throw e;
    }
    this.broadcastUI({ type: "workspace_created", workspace: workspace.getInfo() });
    return workspace;
  }

  // Deleting a project's lead deletes the project; a worker leaves its
  // objectives.
  private deleteWorkspace(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    const link = ws.projectLink;
    if (link?.role === "lead" && this.projects.get(link.projectId)) {
      this.projects.delete(link.projectId);
      return;
    }
    if (link && this.projects.get(link.projectId)?.status === "sealed")
      throw new Error("Project is sealed");
    void this.projects.forget(ws);
    this.removeWorkspace(workspaceId);
  }

  private removeWorkspace(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    this.cancelWorkspaceRetries(ws);
    void ws.dispose();
    const timer = this.persistTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    this.persistTimers.delete(workspaceId);
    this.workspaces.delete(workspaceId);
    this.staleLeadToolWorkspaces.delete(workspaceId);
    this.commandsByAgent.delete(workspaceId);
    this.refreshModels();
    deleteWorkspaceState(this.baseDir, workspaceId);
    this.history.changed();
    this.persistIndex();
    this.broadcastUI({ type: "workspace_deleted", workspaceId });
  }

  private addAgent(
    ws: WebSocket,
    workspaceId: string,
    name: string,
    model: string,
    avatar: string,
    color: string,
    permissionMode?: string,
    effort?: string,
  ): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      this.sendJson(ws, { type: "error", message: "Workspace not found" });
      return;
    }

    try {
      if (effort && effortLevelsForModel(model, this.models)?.includes(effort) === false) {
        this.sendJson(ws, { type: "error", message: `${model} has no effort ${effort}` });
        return;
      }
      this.addAgentTo(workspace, name, model, avatar, color, permissionMode, effort);
    } catch (e) {
      this.sendJson(ws, {
        type: "error",
        message: `${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  private addAgentTo(
    workspace: Workspace,
    name: string,
    model: string,
    avatar: string,
    color: string,
    permissionMode?: string,
    effort?: string,
  ): void {
    const preset = MODEL_OPTIONS.find((m) => m.id === model);
    const backend = backendForModel(model);
    const agent = workspace.addAgent(name, model, avatar, color, {
      backend,
      effort: effort ?? preset?.effort,
      permissionMode,
      providerEnv: this.resolveProviderEnv(model),
      ...(backend === "pi" && this.piConfig()),
    });
    const tools = this.projects.toolsFor(workspace);
    if (tools) workspace.agents.get(agent.id)?.session.setPanelTools?.(tools);
    this.persistWorkspaceNow(workspace.id);
    // With its runtime state (effort, the levels it takes), as agent_updated sends it.
    const entry = workspace.agents.get(agent.id);
    this.agentCommands(workspace.id, agent.id, []);
    this.broadcastUI({
      type: "agent_added",
      workspaceId: workspace.id,
      agent: entry ? workspace.agentInfo(entry) : agent,
    });
    this.projects.leadAgentsChanged(workspace);
  }

  private reapplyProviderEnv(): void {
    for (const ws of this.workspaces.values()) {
      for (const entry of ws.agents.values()) {
        entry.session.setProviderEnv?.(this.resolveProviderEnv(entry.info.model));
      }
    }
  }

  // Hot-reload provider settings (the port and auth cookie secret need a
  // restart). watchFile (polling) survives atomic rename-writes editors do.
  private watchConfig(): void {
    const configPath = path.join(this.baseDir, "config.toml");
    fs.watchFile(configPath, { interval: 2000 }, () => {
      const previousPresets = this.config.presets;
      try {
        const next = loadConfig(this.baseDir);
        // Service-level environment is fixed for the lifetime of this process.
        next.server.proxy = this.config.server.proxy;
        if (next.pi) next.pi.acp = this.config.pi?.acp;
        this.config = next;
      } catch {
        this.broadcastUI({
          type: "error",
          message:
            "config.toml reload failed; previous settings are still in use. Run --doctor to inspect the file.",
        });
        return;
      }
      const presets = this.config.presets;
      if (
        presets.length !== previousPresets.length ||
        presets.some(
          (preset, i) =>
            preset.name !== previousPresets[i].name ||
            preset.when_to_use !== previousPresets[i].when_to_use,
        )
      ) {
        for (const workspace of this.workspaces.values()) {
          if (workspace.projectLink?.role === "lead") this.refreshLeadTools(workspace);
        }
      }
      this.broadcastUI({ type: "identities_update", user: this.config.user, presets });
      this.reapplyProviderEnv();
      if (this.dispatchAllowed) void this.track(this.refreshPiCatalog());
      console.log("[config] reloaded config.toml");
    });
  }

  private resolveProviderEnv(model: string): Record<string, string> | undefined {
    for (const [name, cfg] of Object.entries(this.config.providers)) {
      if (model.startsWith(name)) {
        return {
          ANTHROPIC_BASE_URL: cfg.base_url,
          ANTHROPIC_AUTH_TOKEN: cfg.api_key,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        };
      }
    }
    return undefined;
  }

  private removeAgent(workspaceId: string, agentId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    const dropped = workspace.removeAgent(agentId);
    if (!dropped) return;
    this.persistWorkspaceNow(workspaceId);
    for (const messageId of dropped) {
      this.broadcastUI({ type: "message_removed", workspaceId, messageId });
    }
    this.broadcastUI({ type: "agent_removed", workspaceId, agentId });
    this.projects.leadAgentsChanged(workspace);
  }

  private async fetchRemoteImages(
    images: Array<{ name: string; url: string; path: string }>,
  ): Promise<void> {
    const remoteBase = this.config.server.remote_uploads_url;
    if (!remoteBase) return;
    await Promise.all(
      images.map(async (img) => {
        const filename = path.basename(img.url);
        if (!/^[\w.-]+$/.test(filename)) return;
        const url = `${remoteBase}/${filename}`;
        try {
          await execFileAsync(
            "curl",
            ["-sfL", "--connect-timeout", "10", "--max-time", "30", "-o", img.path, url],
            { timeout: 35000 },
          );
          console.log(`[fetchRemoteImages] ${url} → ${img.path}`);
        } catch (e) {
          console.error(`[fetchRemoteImages] failed to download ${url}:`, e);
        }
      }),
    );
  }

  private async sendMessage(
    workspaceId: string,
    content: string,
    target?: string,
    images?: Array<{ name: string; url: string; path: string }>,
    quote?: { messageId: string; agentId: string | null; content: string },
    onAccepted?: () => void,
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error("Workspace not found");
    if (!this.unarchiveWorkspace(workspace)) throw new Error("Workspace could not be loaded");
    await workspace.sendMessage(content, target, images, quote, onAccepted);
    this.persistWorkspace(workspaceId);
  }

  private async forwardMessage(
    workspaceId: string,
    messageId: string,
    targetAgentId: string,
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !this.unarchiveWorkspace(workspace)) return;
    try {
      await workspace.forwardMessage(messageId, targetAgentId);
    } catch (e) {
      this.broadcastUI({ type: "error", message: `${e instanceof Error ? e.message : String(e)}` });
    }
    this.persistWorkspace(workspaceId);
  }

  private abortAgent(workspaceId: string, agentId?: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    if (agentId) {
      workspace.abortAgent(agentId);
    } else {
      workspace.abortAll();
    }
  }

  private async restartServer(): Promise<void> {
    const command =
      this.config.server.restart_command ??
      (process.platform === "darwin"
        ? undefined
        : ["systemctl", "--user", "restart", "agent-team-server"]);
    if (!command?.length) {
      this.broadcastUI({
        type: "error",
        message: "Server restart is disabled: set server.restart_command in config.toml",
      });
      return;
    }

    console.log("[restart] Persisting all state before restart...");
    this.persistAll();
    this.broadcastUI({ type: "error", message: "Server is restarting..." });
    await this.close();
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore" });
    child.unref();
    console.log("[restart] Restart command launched after server shutdown...");
    setTimeout(() => process.exit(0), 500);
  }

  private persistWorkspace(workspaceId: string): void {
    if (this.persistTimers.has(workspaceId)) return;
    this.persistTimers.set(
      workspaceId,
      setTimeout(() => {
        this.persistTimers.delete(workspaceId);
        const ws = this.workspaces.get(workspaceId);
        if (!ws) return;
        try {
          this.save(ws);
        } catch (e) {
          // A full disk, another process holding the database: the changes
          // stay marked for the next try.
          console.error(`[state] ${workspaceId}: not saved, trying again`, e);
          setTimeout(() => this.persistWorkspace(workspaceId), 5000);
        }
      }, 500),
    );
  }

  private persistWorkspaceNow(workspaceId: string, all = false): void {
    const timer = this.persistTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(workspaceId);
    }
    const ws = this.workspaces.get(workspaceId);
    if (ws) this.save(ws, all);
  }

  // Writes the messages that changed; with `all`, compares every one, which
  // is done before a history leaves memory.
  private save(ws: Workspace, all = false): void {
    const changed = ws.takeChanged();
    try {
      if (saveWorkspace(this.baseDir, ws.getState(), all ? "all" : changed)) {
        this.history.changed();
      }
    } catch (e) {
      ws.touch(changed);
      throw e;
    }
  }

  private unload(ws: Workspace): void {
    this.persistWorkspaceNow(ws.id, true);
    ws.unloadMessages();
  }

  private persistIndex(): void {
    saveIndex(this.baseDir, [...this.workspaces.keys()]);
  }

  private persistAll(): void {
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    for (const ws of this.workspaces.values()) {
      // An unloaded workspace is persisted whenever it changes (archive,
      // unarchive); rewriting it here re-read and re-wrote hundreds of MB.
      if (!ws.messagesLoaded) continue;
      try {
        this.save(ws, true);
      } catch (e) {
        console.error(`[state] ${ws.id}: not saved`, e);
      }
    }
    this.persistIndex();
  }

  private async restoreState(): Promise<void> {
    const states = loadAll(this.baseDir);

    for (const wsState of states) {
      for (const agent of wsState.agents) {
        agent.session.config.providerEnv = this.resolveProviderEnv(agent.model);
        if (agent.session.config.backend === "pi") agent.session.config.piAcp = this.config.pi?.acp;
      }
      const workspace = Workspace.fromState(
        wsState,
        this.hostRegistry,
        this.makeCallbacks(wsState.id),
        { dataDir: this.baseDir, uploadsDir: this.uploadsDir },
      );
      if (workspace.isArchived) workspace.unloadMessages();
      this.workspaces.set(workspace.id, workspace);
      // Turns the stop cut short are written (and searchable) right away.
      if (workspace.hasChanges()) this.persistWorkspaceNow(workspace.id);
      const tools = this.projects.toolsFor(workspace);
      if (tools) for (const a of workspace.agents.values()) a.session.setPanelTools?.(tools);
    }
    for (const workspace of this.workspaces.values()) {
      if (!workspace.messagesLoaded && !historyOf(this.baseDir).hasUnfinishedDispatch(workspace.id))
        continue;
      if (this.ensureLoaded(workspace)) {
        workspace.settleStartingOnRestore();
        workspace.settlePlainDispatchingOnRestore();
      }
      if (workspace.isArchived) workspace.unloadMessages();
    }
    await Promise.all([this.refreshPiCatalog(), this.recheckCodexAuth(false)]);
    if (!this.bootFence) await this.resumeRestoredWork();
  }

  private async resumeRestoredWork(): Promise<void> {
    if (this.closing) return;
    try {
      this.projects.adoptAll();
    } catch (e) {
      console.error("[projects] workspaces from before projects stay on their own", e);
    }
    for (const project of this.projects.list()) {
      await this.projects.drainInbox(project.id, false);
      if (project.status === "sealed") {
        await this.projects.sealProject(project.id, project.sealedReason ?? undefined);
        this.removeProjectRuntimeCaches(project.id);
      }
    }
    if (this.closing) return;
    // Messages still queued when the server went down, and retries of turns
    // a rate limit paused; spaced out so a restart does not start many CLI
    // sessions at once.
    for (const workspace of this.workspaces.values()) {
      if (workspace.isArchived || this.isProjectSealed(workspace)) continue;
      for (const [agentId, entry] of workspace.agents) {
        if (entry.retryPending) {
          this.scheduleRetry(workspace.id, agentId, (entry.pausedUntil ?? 0) - Date.now());
        } else if (
          workspace.messages.some((m) => m.status === "queued" && m.queuedFor === agentId)
        ) {
          setTimeout(() => workspace.dequeueNext(agentId), this.projects.takeStartSlot(1000));
        }
      }
    }

    this.projects.archiveShelved();
    this.projects.recheckWorkers();
    const archived = [...this.workspaces.values()].filter((w) => w.isArchived).length;
    console.log(`Restored ${this.workspaces.size} workspace(s), ${archived} archived`);
  }

  // ---- Projects ---------------------------------------------------------

  private createProject(
    ws: WebSocket,
    name: string,
    pathInput: string | null,
    model?: string,
    cwdInput?: string,
  ): void {
    const root = pathInput === null ? null : resolveWorkspacePath(pathInput ?? "");
    const cwd = cwdInput === undefined ? undefined : resolveWorkspacePath(cwdInput);
    if ((pathInput !== null && !root) || (cwdInput !== undefined && !cwd)) {
      this.sendJson(ws, { type: "error", message: `Not a directory: ${pathInput}` });
      return;
    }
    this.projectAction(ws, () =>
      this.projects.create(
        name?.trim() || (root ? path.basename(root) : "Untitled project"),
        root ?? null,
        model,
        cwd ?? undefined,
      ),
    );
  }

  private projectAction(ws: WebSocket, action: () => unknown): void {
    const sendError = (error: unknown) =>
      this.sendJson(ws, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ModelSelectionError && { issue: error.issue }),
      });
    try {
      const result = action();
      if (result instanceof Promise) void this.track(result).catch(sendError);
    } catch (error) {
      sendError(error);
    }
  }

  // What was said, in every history.
  private search(query: string): Promise<SearchHit[]> {
    const sessions = [...this.workspaces.values()].map((w) => ({ id: w.id, name: w.name }));
    return sidebarHits(this.history, query, sessions, 50);
  }

  // A workspace as the list shows it: no history.
  private listInfo(w: Workspace): WorkspaceInfo {
    const info = w.getInfo(false);
    return this.projects.awaitsUser(w) ? { ...info, awaitsUser: true } : info;
  }

  private projectHost(): ProjectHost {
    return {
      dispatchAllowed: () => this.dispatchAllowed,
      workspaces: () => this.workspaces.values(),
      workspace: (id) => this.workspaces.get(id),
      createWorkspace: (name, cwd, link) => this.makeWorkspace(name, cwd, undefined, link),
      addAgent: (w, name, model, avatar, color, effort) =>
        this.addAgentTo(w, name, model, avatar, color, undefined, effort),
      agentPresets: () => this.config.presets,
      projectDefaults: () => ({
        ...this.config.projects,
        ...(!this.config.projects.model && {
          model: this.config.pi?.default_model,
          effort: this.config.pi?.default_effort,
        }),
      }),
      modelOptions: () => this.models,
      modelDiscoveryIssue: () =>
        (this.config.pi ? this.piCatalogIssue : undefined) ??
        codexModelIssue(this.codexAuth.status),
      isLeadOnline: (project) =>
        Boolean(project.lead && this.hostRegistry.get(project.lead.hostId)?.connected),
      removeWorkspace: (id) => this.removeWorkspace(id),
      archiveWorkspace: (w) => {
        if (!w.isIdle) return false;
        if (!w.isArchived) this.archive(w);
        return true;
      },
      restoreWorkspace: (w) => this.unarchiveWorkspace(w),
      loadWorkspace: (w) => this.ensureLoaded(w),
      history: this.history,
      persistWorkspace: (w) => this.persistWorkspace(w.id),
      saveWorkspaceNow: (w) => this.persistWorkspaceNow(w.id),
      cancelWorkspaceTimers: (w) => this.cancelWorkspaceRetries(w),
      workspaceChanged: (w) =>
        this.broadcastUI({ type: "workspace_updated", workspace: this.listInfo(w) }),
      broadcast: (msg) => this.broadcastUI(msg),
    };
  }

  // ---- Archiving -------------------------------------------------------
  // An archived workspace stays in the list but costs nothing: its history
  // is on disk only, its idle CLI child processes are gone, and the branch
  // scanner skips it. Any interaction that needs the history restores it.

  // False when the history on disk cannot be read; the workspace then stays
  // unloaded so nothing saves an empty history over it.
  private ensureLoaded(ws: Workspace): boolean {
    if (ws.messagesLoaded) return true;
    try {
      ws.setMessages(loadWorkspaceMessages(this.baseDir, ws.id));
      return true;
    } catch (e) {
      console.error(`[state] ${ws.id}: history unreadable`, e);
      this.broadcastUI({
        type: "error",
        message: `History of "${ws.name}" could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  }

  private archiveWorkspace(workspaceId: string, auto: boolean): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws || ws.isArchived) return;
    if (ws.projectLink?.role === "lead") {
      if (!auto) {
        this.broadcastUI({
          type: "error",
          message: "A lead goes with its project: archive the project",
        });
      }
      return;
    }
    if (!ws.isIdle) {
      if (!auto) this.broadcastUI({ type: "error", message: "Workspace is still busy" });
      return;
    }
    this.archive(ws);
  }

  private archive(ws: Workspace): void {
    ws.abortAll();
    ws.settleForArchive();
    ws.archivedAt = Date.now();
    this.unload(ws);
    this.broadcastUI({ type: "workspace_archived", workspaceId: ws.id, archivedAt: ws.archivedAt });
  }

  private unarchiveWorkspace(ws: Workspace): boolean {
    if (!this.ensureLoaded(ws)) return false;
    if (!ws.isArchived) return true;
    ws.archivedAt = null;
    this.persistWorkspaceNow(ws.id);
    this.broadcastUI({ type: "workspace_unarchived", workspaceId: ws.id });
    for (const entry of ws.agents.values()) {
      const agent = ws.agentInfo(entry);
      if (agent.canSwitchBackend)
        this.broadcastUI({ type: "agent_updated", workspaceId: ws.id, agent });
    }
    try {
      this.projects.restored(ws);
    } catch (e) {
      console.error(`[projects] ${ws.id} stays outside a project`, e);
    }
    this.projects.showAwaiting(ws);
    return true;
  }

  private sweepArchives(): void {
    if (!this.dispatchAllowed) return;
    const days = this.config.workspace.archive_after_days;
    if (!days) return;
    const cutoff = Date.now() - days * 86400_000;
    for (const ws of this.workspaces.values()) {
      if (ws.isArchived) {
        // Browsing an archived workspace loads its history; let it go again
        // once nothing is happening there.
        if (ws.messagesLoaded && ws.isIdle) this.unload(ws);
        continue;
      }
      if (ws.lastActivityAt > cutoff || ws.projectLink?.role === "lead") continue;
      this.archiveWorkspace(ws.id, true);
    }
  }

  // Rate-limit recovery policy:
  //  - five_hour: hold the agent's queue and auto-retry the failed prompt
  //    shortly after the window resets ("wait it out"); a turn the CLI
  //    started is no prompt of ours, the agent is told to carry on instead
  //  - weekly-type limits (seven_day / fable pools): fail over the DEFAULT
  //    account to another credential and retry immediately — agents pinned to
  //    an explicit account are left alone (switching under them would be
  //    surprising), they just get the error message.
  // Agents limited in the same window share its reset: their retries take
  // start slots like any start. The pause is saved with the agent, so a
  // restart schedules the retry again.
  private scheduleRetry(wsId: string, agentId: string, delay: number): void {
    const key = `${wsId}:${agentId}`;
    clearTimeout(this.retryTimers.get(key));
    this.retryTimers.set(
      key,
      setTimeout(
        () => {
          this.retryTimers.delete(key);
          const w = this.workspaces.get(wsId);
          if (!w || !w.agents.has(agentId) || w.isArchived) return;
          // A turn whose output could not be saved does not run; try later.
          if (!this.ensureLoaded(w)) {
            this.scheduleRetry(wsId, agentId, 60_000);
            return;
          }
          if (!w.retryLast(agentId)) w.dequeueNext(agentId);
          this.persistWorkspace(wsId);
          this.projects.workerIdle(w);
        },
        this.projects.takeStartSlot(Math.max(delay, 1000)),
      ),
    );
  }

  private handleRateLimit(
    wsId: string,
    agentId: string,
    info: { rateLimitType?: string; resetsAt?: number },
  ): void {
    const ws = this.workspaces.get(wsId);
    const entry = ws?.agents.get(agentId);
    if (!ws || !entry) return;
    const agentName = entry.info.name;
    if (!entry.currentMsg && !entry.openingPrompt && !entry.retryPending)
      entry.lastEnvelope = undefined;

    const now = Date.now();
    if (entry.retryPending && (entry.pausedUntil ?? 0) > now) return;
    const reset = info.resetsAt ? info.resetsAt * 1000 + 60_000 : 0;
    const retryAt = reset > now ? reset : now + 31 * 60_000;
    const cap = info.rateLimitType === "seven_day" ? 8 * 86400_000 : 6 * 3600_000;
    const delay = Math.min(Math.max(retryAt - now, 60_000), cap);
    ws.pauseAgent(agentId, now + delay, true);
    const at = new Date(now + delay).toLocaleTimeString();
    const limit = info.rateLimitType === "seven_day" ? "weekly" : "5-hour";
    ws.postSystemMessage(
      entry.lastEnvelope
        ? `⏳ **${agentName}** hit the ${limit} limit — auto-retrying at ${at}.`
        : `⏳ **${agentName}** hit the ${limit} limit — it will be told to carry on at ${at}.`,
    );
    this.persistWorkspace(wsId);
    this.scheduleRetry(wsId, agentId, delay);
  }

  private piConfig() {
    return piSessionConfig(this.config);
  }

  modelDiscoverySnapshot(): ModelDiscoverySnapshot {
    return describeModelDiscovery(
      this.config,
      this.models,
      this.piCatalogIssue,
      this.codexAuth.status,
    );
  }

  private async refreshPiCatalog(): Promise<void> {
    const revision = ++this.catalogRevision;
    if (this.closing) return;
    const { models, issue } = await probePiCatalog(
      this.config,
      this.baseDir,
      this.hostRegistry.getDefault(),
    );
    if (this.closing || revision !== this.catalogRevision) return;
    this.catalogModels = models;
    this.piCatalogIssue = issue;
    if (issue?.code === "pi_catalog_failed" || issue?.code === "pi_cli_missing") {
      console.error(`[models] ${issue.impact} ${issue.nextStep}`);
    }
    this.refreshModels();
  }

  private refreshLeadTools(workspace: Workspace): void {
    if (workspace.projectLink?.role !== "lead" || this.isProjectSealed(workspace)) {
      this.staleLeadToolWorkspaces.delete(workspace.id);
      return;
    }
    // Never mutate panel tools on an active/busy Lead mid-conversation so prompt cache is preserved.
    if (!workspace.isIdle) {
      this.staleLeadToolWorkspaces.add(workspace.id);
      return;
    }
    this.staleLeadToolWorkspaces.delete(workspace.id);
    const tools = this.projects.toolsFor(workspace);
    if (tools) {
      for (const agent of workspace.agents.values()) agent.session.setPanelTools?.(tools);
    }
  }

  private flushPendingLeadTools(workspace: Workspace): void {
    if (!this.staleLeadToolWorkspaces.has(workspace.id)) return;
    this.refreshLeadTools(workspace);
  }

  private notifyCodexRecheck = false;

  private recheckCodexAuth(notify = true): Promise<CodexAuthState> {
    if (notify) this.notifyCodexRecheck = true;
    if (!this.recheckingCodexAuth) {
      const pending = this.probeCodexAuthState().finally(() => {
        if (this.recheckingCodexAuth === pending) this.recheckingCodexAuth = null;
      });
      this.recheckingCodexAuth = pending;
    }
    return this.recheckingCodexAuth;
  }

  private async probeCodexAuthState(): Promise<CodexAuthState> {
    const wasQuotaConfigured = this.codexQuota.isConfigured();
    const prev = this.codexAuth;
    const state = await probeCodexAuth(codexProcessEnv());
    // The legacy Codex auth frame should not relay arbitrary account RPC errors either.
    const next = state.error ? { ...state, error: codexModelIssue(state.status)?.impact } : state;
    const notify = this.notifyCodexRecheck;
    this.notifyCodexRecheck = false;
    if (this.closing) return this.codexAuth;
    this.codexAuth = next;
    if (!this.codexQuota.isConfigured()) {
      const at = wasQuotaConfigured ? Date.now() : 0;
      this.quota.accept({ ...unavailable(NATIVE_CODEX, at), reason: "not configured" });
    } else if (notify) {
      this.refreshQuota({
        providers: [NATIVE_CODEX],
        newlyReadable: wasQuotaConfigured ? [] : [NATIVE_CODEX],
      });
    }
    this.refreshModels();
    const changed =
      prev.cliAvailable !== next.cliAvailable ||
      prev.authenticated !== next.authenticated ||
      prev.status !== next.status ||
      prev.accountType !== next.accountType ||
      prev.error !== next.error;
    if (notify || changed) {
      this.broadcastUI({ type: "codex_auth_update", codexAuth: this.codexAuth });
    }
    return this.codexAuth;
  }

  private refreshModels(): void {
    const models = availableModelOptions(
      [
        ...this.catalogModels,
        ...[...this.workspaces.values()].flatMap((w) =>
          w.projectLink && this.projects.get(w.projectLink.projectId)?.status === "sealed"
            ? []
            : [...w.agents.values()].flatMap((entry) => entry.session.getAvailableModels?.() ?? []),
        ),
      ],
      { codexAuthenticated: this.codexAuth.authenticated },
    );
    if (JSON.stringify(models) === JSON.stringify(this.models)) return;
    const previous = this.models;
    this.models = models;
    this.broadcastUI({ type: "models_update", models });
    for (const workspace of this.workspaces.values()) {
      for (const agent of workspace.agents.values()) {
        const id = agent.info.model;
        if (
          JSON.stringify(effortLevelsForModel(id, previous)) !==
          JSON.stringify(effortLevelsForModel(id, models))
        )
          this.broadcastUI({
            type: "agent_updated",
            workspaceId: workspace.id,
            agent: workspace.agentInfo(agent),
          });
      }
      if (workspace.projectLink?.role === "lead") this.refreshLeadTools(workspace);
    }
  }

  private agentCommands(wsId: string, agentId: string, list: CommandInfo[]): void {
    let workspace = this.commandsByAgent.get(wsId);
    const current = this.workspaces.get(wsId);
    if (!current?.agents.has(agentId)) {
      workspace?.delete(agentId);
      if (workspace?.size === 0) this.commandsByAgent.delete(wsId);
      if (current)
        this.broadcastUI({
          type: "agent_commands_update",
          workspaceId: wsId,
          agentId,
          commands: [],
        });
      this.refreshModels();
      return;
    }
    if (!workspace) this.commandsByAgent.set(wsId, (workspace = new Map<string, CommandInfo[]>()));
    const commands = mergeLocalCommands(list);
    workspace.set(agentId, commands);
    this.broadcastUI({ type: "agent_commands_update", workspaceId: wsId, agentId, commands });
  }

  private cancelWorkspaceRetries(workspace: Workspace): void {
    for (const agentId of workspace.agents.keys()) {
      const key = `${workspace.id}:${agentId}`;
      clearTimeout(this.retryTimers.get(key));
      this.retryTimers.delete(key);
    }
  }

  private removeProjectRuntimeCaches(projectId: string): void {
    for (const workspace of this.workspaces.values()) {
      if (workspace.projectLink?.projectId !== projectId) continue;
      this.commandsByAgent.delete(workspace.id);
      for (const agentId of workspace.agents.keys())
        this.broadcastUI({
          type: "agent_commands_update",
          workspaceId: workspace.id,
          agentId,
          commands: [],
        });
    }
    this.refreshModels();
  }

  private makeCallbacks(id: string): WorkspaceCallbacks {
    return {
      onNewMessage: (wsId, msg) => {
        this.broadcastUI({ type: "new_message", workspaceId: wsId, message: toWireMessage(msg) });
      },
      onStreamEvent: (wsId, agentMsg, event) => {
        if (isLoggedEvent(event)) {
          appendLog(this.baseDir, wsId, { timestamp: Date.now(), messageId: agentMsg.id, event });
        }
        this.broadcastUI({
          type: "stream_event",
          workspaceId: wsId,
          messageId: agentMsg.id,
          event,
        });
        // A finished message changed later (a background task's end): its
        // turn will not save it.
        if (agentMsg.status !== "streaming") this.persistWorkspace(wsId);
      },
      onMessageDone: (wsId, msgId, status, content, events, patch) => {
        this.broadcastUI({
          type: "message_done",
          workspaceId: wsId,
          messageId: msgId,
          status,
          content,
          events: events ? stripEventsInnerEvents(events) : undefined,
          ...patch,
        });
        this.persistWorkspace(wsId);
      },
      onAgentBusy: (wsId, agentId) => {
        this.broadcastUI({ type: "agent_busy", workspaceId: wsId, agentId });
      },
      onAgentIdle: (wsId, agentId) => {
        this.broadcastUI({ type: "agent_idle", workspaceId: wsId, agentId });
        // A finished turn is the moment a PR is likely to have appeared or
        // moved; refresh it on the next scan instead of waiting a minute.
        const ws = this.workspaces.get(wsId);
        if (ws) this.git.requestPrRefresh(ws.cwd);
        if (ws) this.projects.workerIdle(ws);
        if (ws) this.flushPendingLeadTools(ws);
        const agent = ws?.agents.get(agentId);
        const provider = agent && this.quotaProviderForModel(agent.info.model);
        if (provider && this.uiClients.size > 0)
          this.refreshQuota({ force: false, providers: [provider] });
      },
      onAgentState: (wsId, agentId, state) => {
        this.broadcastUI({ type: "agent_state", workspaceId: wsId, agentId, state });
        const ws = this.workspaces.get(wsId);
        if (ws && state === "idle") {
          this.projects.workerIdle(ws);
          this.flushPendingLeadTools(ws);
        }
      },
      onSaveNow: () => this.persistWorkspaceNow(id),
      canDequeue: () => this.restored,
      canDispatch: (w) => this.dispatchAllowed && !this.isProjectSealed(w),
      onDeployActivity: () => this.deploy?.observe(true),
      trackCleanup: (work) => this.track(work),
      ensureLoaded: (w) => this.ensureLoaded(w),
      onReportDeliveryState: (reportId, state, meta) => {
        const w = this.workspaces.get(id);
        if (w) this.projects.mirrorReportDelivery(w, reportId, state, meta);
      },
      onExtensionUi: (event) => this.broadcastUI({ type: "extension_ui", event }),
      onUiDialogRequest: (dialog) => {
        this.deploy?.observe(true);
        this.broadcastUI({ type: "ui_dialog_request", dialog });
        const w = this.workspaces.get(id);
        if (w) this.projects.showAwaiting(w);
      },
      onUiDialogResolved: (dialog) => {
        this.broadcastUI({ type: "ui_dialog_resolved", ...dialog });
        const w = this.workspaces.get(id);
        if (w) this.projects.showAwaiting(w);
      },
      onCommandsUpdate: (agentId, commands) => this.agentCommands(id, agentId, commands),
      onSessionCapabilities: (wsId, agentId) => {
        this.refreshModels();
        const w = this.workspaces.get(wsId);
        const agent = w?.agents.get(agentId);
        if (w && agent)
          this.broadcastUI({ type: "agent_updated", workspaceId: wsId, agent: w.agentInfo(agent) });
      },
      onRateLimit: (wsId, agentId, info) => this.handleRateLimit(wsId, agentId, info),
      onMessageRemoved: (wsId, messageId) =>
        this.broadcastUI({ type: "message_removed", workspaceId: wsId, messageId }),
      onAgentUpdated: (wsId, agent, transient) => {
        this.broadcastUI({ type: "agent_updated", workspaceId: wsId, agent });
        if (!transient) this.persistWorkspace(wsId);
      },
      onAgentActivity: (wsId, agentId, activity) => {
        this.broadcastUI({ type: "agent_activity", workspaceId: wsId, agentId, activity });
      },
      onUnhandled: (wsId, agentId, msg) => {
        appendLog(this.baseDir, wsId, { timestamp: Date.now(), agentId, unhandled: msg });
      },
      modelOptions: () => this.models,
      sessionEnv: (model) => this.resolveProviderEnv(model),
      piConfig: () => this.piConfig(),
      onSessionReplaced: (workspace, session) => {
        session.setPanelTools?.(this.projects.toolsFor(workspace));
      },
    };
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    if (this.bootFence) fs.unwatchFile(this.bootFence);
    this.quota.stop();
    const retiring = this.deploy?.close();
    if (retiring) await retiring;
    if (!this.restored) await this.restoring.catch(() => undefined);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.projects.close();
    fs.unwatchFile(path.join(this.baseDir, "config.toml"));
    for (const t of this.retryTimers.values()) clearTimeout(t);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.branchTimer) clearInterval(this.branchTimer);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    for (const ws of this.workspaces.values()) {
      try {
        ws.abortAll("restart");
      } catch (e) {
        console.error(`[close] ${ws.id}:`, e);
      }
    }
    this.persistAll();
    await Promise.allSettled([...this.workspaces.values()].map((ws) => ws.dispose()));
    const hosts = await Promise.allSettled(
      this.hostRegistry.getAll().map((host) => Promise.resolve(host.close?.())),
    );
    await this.history.close();
    closeHistory(this.baseDir);
    for (const ws of this.uiClients) ws.terminate();
    await Promise.all([
      new Promise<void>((resolve) => this.wss.close(() => resolve())),
      new Promise<void>((resolve) => this.httpServer.close(() => resolve())),
    ]);
    for (const result of hosts)
      if (result.status === "rejected")
        console.error("[close] host shutdown failed", result.reason);
  }
}

function initialCodexAuthState(): CodexAuthState {
  const cliAvailable = isCodexCliAvailable();
  return {
    cliAvailable,
    authenticated: false,
    status: cliAvailable ? "unauthenticated" : "unavailable",
    accountType: null,
    checkedAt: 0,
  };
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
