import type { PiQuotaReader, QuotaSnapshot } from "./quota-schema";
import type { RateLimitSnapshot } from "./codex-rpc";
import { EventEmitter } from "events";
import type {
  BackgroundTask,
  CommandInfo,
  DispatchedReportProbeResult,
  PiAvailableModel,
  UiDialogRequest,
  UiDialogResponse,
  PromptEnvelope,
  RunState,
  SendHooks,
  SendReceipt,
  SessionConfig,
  SessionState,
  UsageStats,
} from "./types";
import { CodexSession } from "./codex";
import { ReadOnlyLegacySession } from "./legacy";
import { PanelHttpServer } from "./panel-http";
import { PiSession } from "./pi";
import type { PanelToolset } from "../project/tools";

export interface BoundarySteer {
  envelope: PromptEnvelope;
  claim(): boolean;
  finish(outcome: "read" | "handled" | "rejected" | "outcome_unknown"): void;
}

export interface HostSessionHandle extends EventEmitter {
  sessionId: string | null;
  usage: UsageStats;
  readonly isRunning: boolean;
  readonly runState?: RunState;
  readonly effectiveEffort?: string | null;
  readonly backgroundTaskList?: BackgroundTask[];
  readonly nextTurnOptions?: { model?: string; effort?: string; fast?: boolean };
  readonly optionsPending?: boolean;
  send(input: string | PromptEnvelope, hooks?: SendHooks): Promise<SendReceipt | void>;
  steer?(message: string, inputId: string): Promise<boolean>;
  readonly canSteer?: boolean;
  setBoundarySteerSource?(source: () => BoundarySteer | undefined): void;
  abort(): void;
  resetContext?(): void;
  dispose?(): Promise<void>;
  deployBusy?: boolean;
  retireIdleProcess?(signal: AbortSignal): Promise<void>;
  setEffort?(level: string): void;
  setFastMode?(on: boolean): void;
  setModel?(model: string, effort: string | undefined, fast: boolean): void;
  setGoal?(goal: string | null): void;
  interrupt?(): Promise<boolean>;
  readonly interruptPending?: boolean;
  cancelWake?(): string | null;
  readonly wake?: { at: number; reason: string } | null;
  readonly wakeDue?: boolean;
  takeWake?(): { prompt: string; reason: string } | null;
  setPanelTools?(tools: PanelToolset | null): void;
  stopTask?(taskId: string): Promise<void>;
  simulateRateLimit?(info: { rateLimitType?: string; resetsAt?: number }): void;
  getState(): SessionState;
  getContextUsage?(): Promise<Record<string, unknown> | null>;
  getUsageInfo?(): Promise<Record<string, unknown> | null>;
  readonly pendingUiDialogs?: UiDialogRequest[];
  respondToUiDialog?(requestId: string, response: UiDialogResponse): void;
  probeDispatchedReport?(
    beforeLeafId: string | null,
    reportId: string,
    timeoutMs?: number,
  ): Promise<DispatchedReportProbeResult>;
  getAvailableModels?(): PiAvailableModel[];
  getAvailableThinkingLevels?(model: string): string[] | undefined;
  getCommands?(): CommandInfo[];
  reconcileAsyncRuns?(): Promise<void>;
}

export interface HostInfo {
  id: string;
  label: string;
  type: "local" | "remote";
  connected: boolean;
}

export interface Host {
  readonly id: string;
  readonly label: string;
  readonly type: "local" | "remote";
  readonly connected: boolean;
  getInfo(): HostInfo;
  createSession(agentId: string, config: SessionConfig): HostSessionHandle;
  replaceSession?(agentId: string, config: SessionConfig): HostSessionHandle;
  destroySession(agentId: string): Promise<void>;
  restoreSession(agentId: string, state: SessionState): HostSessionHandle;
  quotaReader?(): PiQuotaReader | undefined;
  readonly pendingCleanup?: number;
  discoverPiModels?(config: SessionConfig): Promise<PiAvailableModel[]>;
  close?(): Promise<void>;
}

export class LocalHost implements Host {
  readonly id: string;
  readonly label: string;
  readonly type = "local" as const;
  readonly connected = true;
  private sessions = new Map<string, HostSessionHandle>();
  private panelHttp?: PanelHttpServer;
  private closing?: Promise<void>;
  private readonly retiring = new Set<Promise<void>>();

  get pendingCleanup(): number {
    return this.retiring.size;
  }

  constructor(
    id: string,
    label: string,
    private readonly quota?: {
      pi: (snapshot: QuotaSnapshot) => void;
      piReaderReady: (providers: string[]) => void;
      codex: (limits: RateLimitSnapshot) => void;
    },
  ) {
    this.id = id;
    this.label = label;
  }

  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }

  quotaReader() {
    return this.panelHttp?.quotaReader();
  }

  private getPanelHttp(): PanelHttpServer {
    return (this.panelHttp ??= new PanelHttpServer(this.quota?.piReaderReady));
  }

  private track(agentId: string, session: HostSessionHandle) {
    if (this.quota && session instanceof CodexSession)
      session.on("quota", (_local: RateLimitSnapshot, update: RateLimitSnapshot) =>
        this.quota!.codex(update),
      );
    if (this.quota && session instanceof PiSession) session.on("piQuota", this.quota.pi);
    this.sessions.set(agentId, session);
    return session;
  }

  createSession(agentId: string, config: SessionConfig): HostSessionHandle {
    if (this.closing) throw new Error("LocalHost is closing");
    let session: HostSessionHandle;
    if (config.backend === "codex") {
      session = new CodexSession(config);
    } else if (config.backend === "pi") {
      session = new PiSession({ ...config, agentId }, { panelHttp: this.getPanelHttp() });
    } else {
      throw new Error(`Backend "${config.backend ?? "unknown"}" cannot create new sessions`);
    }
    return this.track(agentId, session);
  }

  replaceSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const old = this.sessions.get(agentId);
    const session = this.createSession(agentId, config);
    if (old) {
      old.removeAllListeners();
      const retirement = this.disposeSession(old);
      this.retiring.add(retirement);
      void retirement
        .finally(() => this.retiring.delete(retirement))
        .catch((error) => {
          console.error(`[host] Could not dispose replaced session ${agentId}:`, error);
        });
    }
    return session;
  }

  async destroySession(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    this.sessions.delete(agentId);
    await this.disposeSession(session);
  }

  private async disposeSession(session: HostSessionHandle): Promise<void> {
    if (session.dispose) await session.dispose();
    else session.abort();
  }

  restoreSession(agentId: string, state: SessionState): HostSessionHandle {
    if (this.closing) throw new Error("LocalHost is closing");
    let session: HostSessionHandle;
    if (state.config.backend === "codex") {
      session = CodexSession.fromState(state);
    } else if (state.config.backend === "pi") {
      session = PiSession.fromState(
        { ...state, config: { ...state.config, agentId } },
        { panelHttp: this.getPanelHttp() },
      );
    } else {
      session = new ReadOnlyLegacySession(state);
    }
    return this.track(agentId, session);
  }

  async discoverPiModels(config: SessionConfig): Promise<PiAvailableModel[]> {
    if (this.closing) return [];
    const agentId = `model-catalog-${Math.random().toString(36).slice(2)}`;
    const session = new PiSession(
      { ...config, agentId },
      { catalogOnly: true, panelHttp: this.getPanelHttp() },
    );
    this.sessions.set(agentId, session);
    try {
      await session.ensureStarted();
      return session.getAvailableModels();
    } finally {
      await this.destroySession(agentId);
    }
  }

  close(): Promise<void> {
    this.closing ??= Promise.allSettled([
      ...this.retiring,
      ...[...this.sessions.keys()].map((id) => this.destroySession(id)),
    ]).then(async (results) => {
      await this.panelHttp?.close();
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length) throw new AggregateError(errors, "LocalHost failed to close sessions");
    });
    return this.closing;
  }
}

export class HostRegistry {
  private hosts = new Map<string, Host>();

  register(host: Host): void {
    this.hosts.set(host.id, host);
  }

  get(id: string): Host | undefined {
    return this.hosts.get(id);
  }

  getDefault(): Host | undefined {
    for (const host of this.hosts.values()) {
      if (host.type === "local") return host;
    }
    return this.hosts.values().next().value;
  }

  getAll(): Host[] {
    return [...this.hosts.values()];
  }

  getAllInfo(): HostInfo[] {
    return this.getAll().map((h) => h.getInfo());
  }
}
