import { randomUUID } from "node:crypto";
import { LeadRecovery } from "./lead-recovery";
import { ProjectCommitLock } from "./commit-lock";
import { ProjectNotesStore } from "./notes";
import {
  ReportJournalStore,
  buildReportEnvelope,
  reportLeadMessageId,
  deliveryStateRank,
  reconcileReportDeliveryState,
  type FrozenReportPlan,
  type ReportLeadDelivery,
} from "./report-journal";
import * as fs from "fs";
import * as os from "os";
import type { ProjectsConfig } from "../config/config";
import {
  invalidExplicitModel,
  ModelSelectionError,
  noModelsAvailable,
  selectDefaultModel,
  type ModelDiscoveryIssue,
} from "../config/model-diagnostics";
import * as path from "path";
import {
  AGENT_PRESETS,
  type AgentPreset,
  MODEL_OPTIONS,
  type ModelOption,
  effortLevelsForModel,
} from "../config/presets";
import { resolveWorkspacePath } from "../repo/dirs";
import { gitCommitsSince, gitHead, gitStatus, gitWorktrees, repositoryRoot } from "../repo/git";
import type { EntryInfo, EntryKind, SessionRow, SqlValue } from "../workspace/history-index";
import type { HistoryService } from "../workspace/history-service";
import {
  originLabel,
  type Message,
  type MessageOrigin,
  type ProjectLink,
  type Workspace,
} from "../workspace/workspace";
import { ProjectStore, type Project } from "./store";
import {
  LIMITS,
  OBJECTIVE_STATUSES,
  ObjectiveStore,
  checkId,
  checkLength,
  checkTask,
  dependencies,
  cycleThrough,
  isTombstone,
  type BrokenObjective,
  type Objective,
  type Stamp,
  type Task,
} from "./objectives";
import { IssueStore, locate, type IssueModule, type ModuleEntry } from "./issues";
import { IssueBoard } from "./issue-board";
import {
  selectablePresetNames,
  leadToolset,
  workerToolset,
  type FinishPatch,
  type ItemPatch,
  type ObjectivePatch,
  type PanelApi,
  type HistorySearch,
  type PanelToolset,
  type StartSessionArgs,
} from "./tools";

// Of the history tools' output: characters per line and in all of
// read_entry, per cell of query_history; rows of query_history; entries per
// message of read_session.
const LINE_CAP = 4000;
const OUTPUT_CAP = 60_000;
const CELL_CAP = 1000;
const SQL_ROWS = 200;
const ENTRIES_SHOWN = 60;
// Open issues read_objective lists, and current_task.
const ISSUES_SHOWN = 30;
const TASK_ISSUES_SHOWN = 10;
// Commits whose distance from HEAD one read counts; past them a text shows
// its commit only.
const AGES_COUNTED = 40;

// Model for seeded demo sessions, not a runtime fallback.
export const LEAD_MODEL = "gpt-6-astra";

// A lead asked to start everything at once must not spawn a burst of CLI
// sessions on the user's account: worker tasks go out this far apart.
export const START_SPACING_MS = 15_000;

// A worker has had nothing to run for this long before the lead is told it
// went idle without reporting: a finished background task starts the turn
// that reads its output a second or two after the task is gone.
export const SETTLE_MS = 15_000;

// Two leads can keep answering each other with nobody watching; past this
// many messages between two projects within the window, message_project is
// refused until it calms down.
const PEER_LIMIT = 6;
const PEER_WINDOW_MS = 10 * 60_000;

// What the manager needs from the server that owns the workspaces.
export interface ProjectHost {
  dispatchAllowed?(): boolean;
  recoveryReady?(): boolean;
  workspaces(): Iterable<Workspace>;
  workspace(id: string): Workspace | undefined;
  createWorkspace(name: string, cwd: string, link: ProjectLink): Workspace;
  addAgent(
    workspace: Workspace,
    name: string,
    model: string,
    avatar: string,
    color: string,
    effort?: string,
  ): void;
  // config.toml's [projects]: the model and effort leads default to.
  isLeadOnline?(project: Project): boolean;
  modelOptions?(): ModelOption[];
  modelDiscoveryIssue?(): ModelDiscoveryIssue | undefined;
  projectDefaults?(): ProjectsConfig;
  agentPresets?(): AgentPreset[];
  userLanguage?(): string | undefined;
  // Deletes a workspace without the project bookkeeping of a user delete.
  removeWorkspace(id: string): void;
  // False when the workspace is still busy.
  archiveWorkspace(workspace: Workspace): boolean;
  // Unarchives and loads the history; false when it cannot be read.
  restoreWorkspace(workspace: Workspace): boolean;
  loadWorkspace(workspace: Workspace): boolean;
  history: HistoryService;
  persistWorkspace(workspace: Workspace): void;
  // Right away: a shutdown drops pending debounced saves of unloaded
  // (archived) workspaces.
  saveWorkspaceNow(workspace: Workspace): void;
  cancelWorkspaceTimers?(workspace: Workspace): void;
  // Its name or project link changed.
  workspaceChanged(workspace: Workspace): void;
  onWorkerWaiting?(workspace: Workspace): void;
  onRecoveryExhausted?(workspace: Workspace): void;
  onRecoveredReply?(
    w: Workspace,
    agentId: string,
    reply: Message,
    direct: boolean,
    inputIds: string[],
  ): void;
  onWorkersSettling?(lead: Workspace): void;
  broadcast(msg: unknown): void;
}

export type ProjectInfo = Project & { objectives: Array<Objective | BrokenObjective> };

// Projects: a lead workspace per repository that starts worker sessions
// through the panel tools, keeps the objectives, and talks to other
// projects' leads. Every message between sessions goes through the normal
// send path, shown with its sender (Message.from).
export class ProjectManager {
  private store: ProjectStore;
  private readonly commitLock = new ProjectCommitLock();
  private readonly deferredInboxes = new Set<string>();
  private draining = 0;

  deployBlockers(): Record<string, number> {
    return {
      projectCommits: this.commitLock.pending,
      inboxRecovery: this.draining,
      projectTimers: this.timers.size,
    };
  }

  resumeDispatch(): void {
    for (const id of this.deferredInboxes) {
      this.deferredInboxes.delete(id);
      if (this.store.get(id))
        void this.drainInbox(id).catch((error) =>
          console.error("[projects] inbox resume failed", error),
        );
    }
  }

  private assertDispatchAllowed(): void {
    if (this.host.dispatchAllowed?.() === false)
      throw new Error("Deployment is sealing this server. Retry shortly.");
  }
  private readonly journals = new Map<string, ReportJournalStore>();
  // Times handed out by takeStartSlot that are not long past.
  private slots: number[] = [];
  private peerLog = new Map<string, number[]>();
  private timers = new Map<ReturnType<typeof setTimeout>, string>();
  private boards = new Map<string, ObjectiveStore>();
  private issueStores = new Map<string, IssueStore>();
  private settling = new Map<string, ReturnType<typeof setTimeout>>();
  private carrying = new Set<string>();
  private closed = false;
  readonly recovery = new LeadRecovery({
    journal: (w) => this.journal(w.projectLink!.projectId),
    save: (w) => this.host.saveWorkspaceNow(w),
    availability: (w) => {
      const project = w.projectLink && this.store.get(w.projectLink.projectId);
      if (!project || this.host.workspace(w.id) !== w) return "gone";
      if (w.isArchived || project.archivedAt || project.status !== "active") return "unavailable";
      if (this.host.dispatchAllowed?.() === false || this.host.recoveryReady?.() === false)
        return "blocked";
      return "ready";
    },
    slot: (delay) => this.takeStartSlot(delay),
    drain: (w) => this.leadAgentsChanged(w),
    exhausted: (w) => this.host.onRecoveryExhausted?.(w),
    recovered: (w, agentId, reply, originId, reports) => {
      const origin = originId && w.findMessage(originId);
      this.host.onRecoveredReply?.(
        w,
        agentId,
        reply,
        !!origin && origin.kind === "user" && !origin.from,
        [...(originId ? [originId] : []), ...reports.map(reportLeadMessageId)],
      );
    },
  });

  constructor(
    private readonly baseDir: string,
    private host: ProjectHost,
  ) {
    this.store = new ProjectStore(baseDir);
  }

  get(id: string): Project | undefined {
    return this.store.get(id);
  }

  // Where its board's paths lead: the repository and the notes.
  paths(id: string): { root: string | null; notesDir: string } | undefined {
    const p = this.store.get(id);
    return p && { root: p.root, notesDir: this.store.notesDir(id) };
  }

  close(): void {
    this.closed = true;
    this.recovery.close();
    for (const t of this.timers.keys()) clearTimeout(t);
    this.timers.clear();
    this.settling.clear();
    for (const b of this.boards.values()) b.close();
    this.boards.clear();
    for (const s of this.issueStores.values()) s.close();
    this.issueStores.clear();
  }

  list(): ProjectInfo[] {
    return this.store.list().map((p) => ({ ...p, objectives: this.board(p.id).list() }));
  }

  // Each project's issues, for a client that connects; those with none are
  // left out.
  issueSets(): Record<string, ModuleEntry[]> {
    const out: Record<string, ModuleEntry[]> = {};
    for (const p of this.store.list()) {
      // A connect must never fail over one project's files.
      try {
        const modules = this.issues(p.id).list();
        if (modules.length) out[p.id] = modules;
      } catch (e) {
        console.error(`[projects] ${p.id}: issues not read`, e);
      }
    }
    return out;
  }

  // The model leads, and workers started without one, run on: the
  // configured one where a lead may run on it, its effort where it has it.
  private panelModels(): string[] {
    return (this.host.modelOptions?.() ?? MODEL_OPTIONS).map((model) => model.id);
  }

  private defaultModel(models: string[]): { model?: string; effort?: string } {
    const { model: configured, effort } = this.host.projectDefaults?.() ?? {};
    const model = selectDefaultModel(models, configured);
    return {
      model,
      ...(model &&
        model === configured &&
        effort &&
        effortLevelsForModel(model, this.host.modelOptions?.())?.includes(effort) !== false && {
          effort,
        }),
    };
  }

  private missingDefaultModel(): ModelSelectionError {
    const issue = this.host.modelDiscoveryIssue?.();
    return issue ? new ModelSelectionError(issue) : noModelsAvailable();
  }

  private agentPresets(): AgentPreset[] {
    return this.host.agentPresets?.() ?? AGENT_PRESETS;
  }

  create(name: string, root: string | null, model?: string, cwd?: string): Project {
    const models = this.panelModels();
    const defaults = this.defaultModel(models);
    if (model !== undefined && !models.includes(model)) throw invalidExplicitModel("request.model");
    model ??= defaults.model;
    if (model === undefined) throw this.missingDefaultModel();
    const taken = root !== null && this.store.list().find((p) => sameRoot(p.root, root));
    if (taken) throw new Error(`${root} is already the project "${taken.name}"`);
    const project = this.store.create(name, root);
    let lead: Workspace | undefined;
    try {
      lead = this.host.createWorkspace(`${name} · lead`, root ?? cwd ?? this.baseDir, {
        projectId: project.id,
        role: "lead",
      });
      project.lead = { hostId: lead.hostId, workspaceId: lead.id };
      this.store.save(project);
      this.issues(project.id);
      const preset = this.agentPresets()[0];
      const identity = this.host.projectDefaults?.();
      const effort = model === defaults.model ? defaults.effort : undefined;
      this.host.addAgent(
        lead,
        identity?.lead_name ?? "Lead",
        model,
        identity?.lead_avatar ?? preset.avatar,
        identity?.lead_color ?? preset.color,
        effort,
      );
    } catch (e) {
      if (lead) this.host.removeWorkspace(lead.id);
      this.store.remove(project.id);
      throw e;
    }
    this.changed(project.id);
    return project;
  }

  // Every folder is part of a project, the one of its repository (a git
  // worktree's is the checkout it was added to); the first workspace there
  // brings the project and its lead into being, named `name` or after the
  // folder. The lead runs nothing until it is written to.
  ensureFor(cwd: string, name?: string): Project {
    const root = repositoryRoot(cwd);
    const existing = this.store.list().find((p) => sameRoot(p.root, root));
    if (existing?.status === "sealed") throw new Error("Project is sealed");
    const project = existing ?? this.create(name?.trim() || path.basename(root) || root, root);
    // Work there again brings an archived project back.
    if (project.archivedAt && project.status === "active") this.setArchived(project.id, false);
    return project;
  }

  // Every workspace is a session of its folder's project: those from before
  // projects join theirs (made for them if need be) as archived or live
  // sessions, as they are. A project made only for archived ones starts
  // archived itself.
  adoptAll(): void {
    for (const project of this.store.list()) {
      const lead = this.leadOf(project.id);
      if (lead && project.lead?.hostId !== lead.hostId) {
        // v1 named a workspace but did not record its host.
        this.store.save({ ...project, lead: { hostId: lead.hostId, workspaceId: lead.id } });
      }
    }
    const byRoot = new Map<string, Workspace[]>();
    const roots = new Map<string, string>();
    for (const w of this.host.workspaces()) {
      if (w.projectLink) continue;
      let root = roots.get(w.cwd);
      if (root === undefined) roots.set(w.cwd, (root = repositoryRoot(w.cwd)));
      byRoot.set(root, [...(byRoot.get(root) ?? []), w]);
    }
    for (const [root, list] of byRoot) {
      const existing = this.store.list().find((p) => sameRoot(p.root, root));
      if (existing?.status === "sealed") continue;
      let project = existing;
      if (!project) {
        project = this.create(path.basename(root) || root, root);
        if (list.every((w) => w.isArchived)) this.setArchived(project.id, true);
      }
      for (const w of list) this.adoptWorker(w, project.id);
      this.changed(project.id);
    }
  }

  // A project is archived with its sessions, none of which may be busy, and
  // comes back with its lead; its workers stay archived until opened.
  setArchived(id: string, archived: boolean): void {
    const project = this.requireActive(id);
    const live = this.members(id).filter((w) => !w.isArchived);
    const busy = live.filter((w) => !w.isIdle);
    if (archived && busy.length) {
      throw new Error(`Still busy: ${busy.map((w) => `"${w.name}"`).join(", ")}; stop them first`);
    }
    project.archivedAt = archived ? Date.now() : null;
    this.store.save(project);
    const lead = this.leadOf(id);
    if (archived && lead) this.recovery.stop(lead);
    if (archived) for (const w of live) this.host.archiveWorkspace(w);
    else if (lead?.isArchived) this.host.restoreWorkspace(lead);
    this.changed(id);
    for (const w of this.members(id)) this.showAwaiting(w);
  }

  // At startup: an archived project keeps none of its idle sessions live.
  archiveShelved(): void {
    for (const project of this.store.list()) {
      if (!project.archivedAt) continue;
      for (const w of this.members(project.id)) {
        if (!w.isArchived) this.host.archiveWorkspace(w);
      }
    }
  }

  // An unarchived session: one of an archived project brings the project
  // back; a workspace from before projects joins its folder's.
  restored(w: Workspace): void {
    if (w.projectLink) {
      const id = w.projectLink.projectId;
      const project = this.store.get(id);
      if (project?.status === "active" && project.archivedAt) this.setArchived(id, false);
      return;
    }
    this.adoptWorker(w, this.ensureFor(w.cwd).id);
    this.host.workspaceChanged(w);
  }

  private adoptWorker(w: Workspace, projectId: string): void {
    w.projectLink = { projectId, role: "worker", unreported: true };
    this.refreshPanelTools(w);
    this.host.saveWorkspaceNow(w);
  }

  rename(id: string, name: string): void {
    const project = this.requireActive(id);
    const trimmed = name.trim();
    if (!trimmed) throw new Error("A project needs a name");
    project.name = trimmed;
    this.store.save(project);
    const lead = this.leadOf(id);
    if (lead) {
      lead.name = `${trimmed} · lead`;
      this.host.saveWorkspaceNow(lead);
      this.host.workspaceChanged(lead);
    }
    // The tools' instructions carry the name.
    for (const w of this.members(id)) this.refreshPanelTools(w);
    this.changed(id);
  }

  // Deletes the project with its lead and its memory (objectives, notes).
  // Its worker sessions stay, as plain workspaces.
  delete(id: string): void {
    this.requireActive(id);
    for (const w of this.members(id)) {
      if (w.projectLink?.role === "lead") {
        this.recovery.cancel(w);
        this.host.removeWorkspace(w.id);
        continue;
      }
      w.projectLink = undefined;
      for (const a of w.agents.values()) a.session.setPanelTools?.(null);
      this.dropQueuedFromLead(w);
      this.host.saveWorkspaceNow(w);
      this.host.workspaceChanged(w);
    }
    this.boards.get(id)?.close();
    this.boards.delete(id);
    this.issueStores.get(id)?.close();
    this.issueStores.delete(id);
    this.store.remove(id);
    this.host.broadcast({ type: "project_deleted", projectId: id });
  }

  // A worker session is being deleted: the objectives stop pointing at it,
  // and what it was doing goes back to todo. Never fails the delete itself.
  async forget(workspace: Workspace): Promise<void> {
    const id = workspace.projectLink?.projectId;
    if (!id || this.store.get(id)?.status !== "active") return;
    await this.commitLock
      .run(id, () => {
        const project = this.store.get(id);
        if (!project || project.status !== "active" || !this.leadOnline(project)) return;
        this.rewrite(
          id,
          (o) =>
            o.sessions.includes(workspace.id) || o.tasks.some((t) => t.session === workspace.id),
          (o) => ({
            ...o,
            sessions: o.sessions.filter((s) => s !== workspace.id),
            tasks: o.tasks.map((t) =>
              t.session === workspace.id
                ? {
                    ...t,
                    session: undefined,
                    state: t.state === "doing" ? ("todo" as const) : t.state,
                  }
                : t,
            ),
          }),
        );
      })
      .catch((error) => console.error("[projects] forget", error));
  }

  // Applies `change` to every objective on the board `match` picks, each
  // read fresh from disk right before it is written; one that fails is
  // logged and skipped. Returns the ids written.
  private rewrite(
    projectId: string,
    match: (o: Objective) => boolean,
    change: (o: Objective) => Objective,
  ): string[] {
    const board = this.board(projectId);
    const written: string[] = [];
    for (const listed of this.objectives(projectId)) {
      if (listed.archived || !match(listed)) continue;
      try {
        const fresh = board.get(listed.id);
        if (!fresh || fresh.archived || !match(fresh)) continue;
        board.write({ ...change(fresh), updatedAt: Date.now() });
        written.push(fresh.id);
      } catch (e) {
        console.error(`[projects] ${listed.id}: not updated`, e);
      }
    }
    if (written.length) this.changed(projectId);
    return written;
  }

  // The project's objectives, watched so hand edits reach the board too.
  private board(id: string): ObjectiveStore {
    let board = this.boards.get(id);
    if (!board) {
      if (this.closed) throw new Error("The server is shutting down");
      // A tool that awaited while its project was deleted must not bring
      // the project's folder back.
      this.require(id);
      board = new ObjectiveStore(this.store.objectivesDir(id));
      board.watch(() => this.changed(id));
      this.boards.set(id, board);
    }
    return board;
  }

  // The project's issues, watched like its objectives; they go to the
  // clients in messages of their own.
  private issues(id: string): IssueStore {
    let issues = this.issueStores.get(id);
    if (!issues) {
      if (this.closed) throw new Error("The server is shutting down");
      this.require(id);
      issues = new IssueStore(this.store.issuesDir(id));
      issues.watch(() => this.issuesChanged(id));
      this.issueStores.set(id, issues);
    }
    return issues;
  }

  private issueBoard(id: string): IssueBoard {
    this.require(id);
    return new IssueBoard(this.issues(id), () => this.objectives(id));
  }

  // When a text is written, and the commit of its writer's folder: a
  // worker's, or the repository for the lead.
  private async stamp(projectId: string, sessionId?: string): Promise<Stamp> {
    const root = this.require(projectId).root;
    const commit =
      root && (await gitHead((sessionId && this.host.workspace(sessionId)?.cwd) || root));
    return { at: Date.now(), ...(commit && { commit }) };
  }

  // How old texts are, "" for one that does not say: how long ago it was
  // written, and how many commits the repository's checkout has had since
  // its commit (`commits`: the ones to be shown).
  private async ages(
    projectId: string,
    commits: Array<string | undefined>,
  ): Promise<(at?: number, commit?: string) => string> {
    const root = this.require(projectId).root;
    const since = new Map<string, number | undefined>();
    const wanted = [...new Set(commits.filter((c): c is string => !!c))].slice(0, AGES_COUNTED);
    if (root)
      await Promise.all(wanted.map(async (c) => since.set(c, await gitCommitsSince(root, c))));
    const day = (t: number) => Math.floor(t / 86_400_000);
    const today = day(Date.now());
    return (at, commit) => {
      if (at === undefined) return "";
      const days = today - day(at);
      const ago = days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
      const when = `${ago} (${new Date(at).toISOString().slice(0, 10)}, UTC)`;
      if (!commit) return when;
      const n = since.get(commit);
      if (n === undefined) return `${when} at ${commit}`;
      return `${when} at ${commit}, ${n} commit${n === 1 ? "" : "s"} since`;
    };
  }

  // The clients hear of it even when a write failed halfway.
  private changingIssues(id: string, change: (board: IssueBoard) => string): string {
    const board = this.issueBoard(id);
    try {
      return change(board);
    } finally {
      this.issuesChanged(id);
    }
  }

  private issuesChanged(id: string): void {
    if (!this.store.get(id)) return;
    this.host.broadcast({ type: "project_issues", projectId: id, modules: this.issues(id).list() });
  }

  private objectives(id: string): Objective[] {
    return this.board(id)
      .list()
      .filter((o): o is Objective => !("error" in o));
  }

  private objective(projectId: string, id: string): Objective {
    checkId(id);
    const o = this.board(projectId).get(id);
    if (!o) throw new Error(`No objective ${id}`);
    return o;
  }

  // The archive is read and deleted, never written.
  private saveObjective(projectId: string, o: Objective): void {
    if (o.archived) throw new Error(`${o.id} is in the archive: read-only`);
    this.board(projectId).write({ ...o, updatedAt: Math.max(Date.now(), o.updatedAt + 1) });
    this.changed(projectId);
  }

  // What a lead may start workers on, its default first.
  private workerModels(): string[] {
    const models = this.panelModels();
    const first = this.defaultModel(models).model;
    return first ? [first, ...models.filter((m) => m !== first)] : models;
  }

  // The tools a project workspace's agents get: the lead's or a worker's.
  toolsFor(workspace: Workspace): PanelToolset | null {
    const link = workspace.projectLink;
    const project = link && this.store.get(link.projectId);
    if (!link || !project) return null;
    return link.role === "lead"
      ? leadToolset(
          this.api,
          project,
          this.store.notesDir(project.id),
          this.workerModels(),
          this.agentPresets(),
          this.host.userLanguage?.(),
        )
      : workerToolset(
          this.api,
          workspace.id,
          project,
          this.store.notesDir(project.id),
          link.isolated === true,
          link.unreported === true,
          this.host.userLanguage?.(),
        );
  }

  private refreshPanelTools(w: Workspace): void {
    const tools = this.toolsFor(w);
    for (const a of w.agents.values()) a.session.setPanelTools?.(tools);
  }

  // The user switches whether a worker session reports to the lead. One
  // that stops loses what the lead had queued for it.
  setReporting(workspaceId: string, reports: boolean): void {
    const w = this.host.workspace(workspaceId);
    const link = w?.projectLink;
    if (!w || link?.role !== "worker")
      throw new Error("Only a project's sessions report to its lead");
    this.requireActive(link.projectId);
    if (!reports === (link.unreported === true)) return;
    const { unreported: _, ...rest } = link;
    w.projectLink = reports ? rest : { ...rest, unreported: true };
    // What a running turn already took stays: the switch stops nothing.
    // The board no longer says it works on the lead's tasks.
    if (!reports) {
      this.dropQueuedFromLead(w, false);
      w.dropLeadRetries();
      this.markAnswered(w);
      void this.forget(w);
    }
    this.refreshPanelTools(w);
    this.host.saveWorkspaceNow(w);
    this.host.workspaceChanged(w);
    this.changed(link.projectId);
  }

  // A worker's turn ended or its agent went idle: the check waits until it
  // has stayed so for SETTLE_MS.
  workerIdle(w: Workspace): void {
    if (
      w.projectLink?.role !== "worker" ||
      this.store.get(w.projectLink.projectId)?.status !== "active"
    )
      return;
    this.showAwaiting(w, true);
    const lead = this.leadOf(w.projectLink.projectId);
    if (lead) this.host.onWorkersSettling?.(lead);
    this.settleAfter(w, SETTLE_MS);
  }

  // Only an edge into waiting counts, not each snapshot or later idle check.
  showAwaiting(w: Workspace, live = false): void {
    const waiting = this.awaitsUser(w);
    if (waiting === w.projectedAwaitsUser) return;
    w.projectedAwaitsUser = waiting;
    if (waiting) {
      w.unseen++;
      if (live) this.host.onWorkerWaiting?.(w);
    }
    this.host.persistWorkspace(w);
    this.host.workspaceChanged(w);
  }

  // Before a client that connects gets the list: the others are told first
  // what changed unseen (a stop, an archive), so all hold the same.
  showAllAwaiting(): void {
    for (const w of this.host.workspaces()) this.showAwaiting(w);
  }

  awaitsUser(w: Workspace): boolean {
    const link = w.projectLink;
    return (
      w.hasPendingDialogs ||
      (!!link && !this.store.get(link.projectId)?.archivedAt && awaitsUser(w))
    );
  }

  // After a restart: workers that still owe their lead a word (a turn the
  // restart cut off, a notice that was still waiting) are checked again,
  // spaced out like starts so the leads do not all wake at once.
  recheckWorkers(): void {
    let delay = SETTLE_MS;
    for (const w of this.host.workspaces()) {
      const link = w.projectLink;
      if (link?.role !== "worker" || link.unreported || w.isArchived) continue;
      const lead = this.leadOf(link.projectId);
      const messages = w.getMessages();
      const owed = w
        .lastDelivered()
        .some((d) => fromLead(asked(messages, d.input), lead) && !d.answered);
      if (!owed && !w.pendingTurnFailures().length) continue;
      this.settleAfter(w, delay);
      delay += START_SPACING_MS;
    }
  }

  // The first time `earliest` ms from now or later that is START_SPACING_MS
  // clear of every other start: worker tasks, the lead's messages that wake
  // a worker, rate-limit retries and a restart's queued messages each take
  // one, so no two sessions start together. Returns its delay.
  takeStartSlot(earliest = 0): number {
    const now = Date.now();
    this.slots = this.slots.filter((t) => t > now - START_SPACING_MS).sort((a, b) => a - b);
    let at = now + earliest;
    for (const t of this.slots) {
      if (at <= t - START_SPACING_MS) break;
      if (at < t + START_SPACING_MS) at = t + START_SPACING_MS;
    }
    this.slots.push(at);
    return at - now;
  }

  private settleAfter(w: Workspace, ms: number): void {
    const pending = this.settling.get(w.id);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(pending);
    }
    const t = this.later(w.projectLink!.projectId, ms, () => {
      this.settling.delete(w.id);
      void this.tellIfSilent(w.id).catch((error) => console.error("[projects]", error));
      this.showAwaiting(w);
    });
    if (t) this.settling.set(w.id, t);
  }

  // A worker that went quiet may owe a report even if another lead input
  // has already replaced the failed turn's input in lastDelivered().
  private async tellIfSilent(workspaceId: string): Promise<void> {
    const w = this.host.workspace(workspaceId);
    const link = w?.projectLink;
    if (!w || link?.role !== "worker" || link.unreported || w.isArchived) return;
    if (!w.messagesLoaded || !w.isQuiet) return;
    const id = link.projectId;
    if (w.pendingTurnFailures().length) {
      const shouldDrain = await this.commitLock.run(id, () => {
        const project = this.store.get(id);
        if (
          this.closed ||
          this.host.workspace(workspaceId) !== w ||
          w.projectLink !== link ||
          w.isArchived ||
          !w.messagesLoaded ||
          !w.isQuiet ||
          project?.status !== "active" ||
          project.archivedAt ||
          !project.leadWorkspaceId
        )
          return false;
        const messages = w.getMessages();
        const userOwned = this.isUserTakenOver(w);
        let committed = false;
        for (const { inputId, replyId } of w.pendingTurnFailures()) {
          const got = w.findMessage(inputId);
          const reply = w.findMessage(replyId);
          const input = got && (got.from?.role === "panel" ? asked(messages, got) : got);
          if (
            !userOwned &&
            input?.from?.role === "lead" &&
            input.from.workspaceId === project.leadWorkspaceId &&
            reply?.status === "error"
          ) {
            this.journal(id).append({
              reportId: randomUUID(),
              callId: `turn-failure:${w.id}:${replyId}`,
              kind: "failure",
              workerWsId: w.id,
              workerName: w.name,
              payload: { text: failedTurnNotice(input, reply) },
              frozenPlan: null,
              boardState: "not_applicable",
              leadDelivery: { state: "pending" },
              createdAt: reply.timestamp,
            });
            w.markAnswered(inputId);
            committed = true;
          }
          w.clearTurnFailure(replyId);
        }
        this.host.saveWorkspaceNow(w);
        return committed && this.leadOnline(project);
      });
      if (shouldDrain) await this.drainInbox(id);
    }

    const lead = this.leadOf(id);
    if (
      this.closed ||
      this.host.workspace(workspaceId) !== w ||
      w.projectLink !== link ||
      w.isArchived ||
      !w.messagesLoaded ||
      !w.isQuiet ||
      this.store.get(id)?.status !== "active" ||
      this.store.get(id)?.archivedAt ||
      !lead ||
      lead.isArchived
    )
      return;
    const messages = w.getMessages();
    const task = taskOf(messages);
    for (const { input: got, replies, stopped, answered, since } of w.lastDelivered()) {
      const input = asked(messages, got);
      if (!fromLead(input, lead) || answered) continue;
      if (
        since ||
        stopped === "user" ||
        (input.id === task?.id && !stopped) ||
        (replies.at(-1)?.status === "error" && !stopped)
      ) {
        w.markAnswered(got.id);
        this.host.persistWorkspace(w);
        continue;
      }
      // Carried on once already: someone has to look at what keeps cutting it.
      if (stopped === "restart" && got.from?.role !== "panel") {
        this.carryOn(w, got);
        continue;
      }
      const text = replies.map(replyText).filter(Boolean).pop();
      const how =
        stopped === "restart"
          ? "a server restart cut it off again after it carried on"
          : "its turn ended";
      const body = silentTurnNotice(input, how, text);
      this.deliver(
        lead,
        body,
        { workspaceId: w.id, name: w.name, role: "panel" },
        `${silentNoticeHeader(w.name, w.id)}\n\n${body}`,
      );
      w.markAnswered(got.id);
      this.host.persistWorkspace(w);
    }
  }

  // A turn on what the lead sent that a server restart cut off goes on
  // without the lead, in a start slot of its own; what comes of it counts as
  // the answer to that. Not if the user wrote to the worker meanwhile.
  private carryOn(w: Workspace, cut: { id: string }): void {
    if (this.carrying.has(w.id)) return;
    const delay = this.takeStartSlot();
    if (delay === 0) return this.carryOnNow(w, cut);
    this.carrying.add(w.id);
    const t = this.later(w.projectLink!.projectId, delay, () => {
      this.carrying.delete(w.id);
      this.carryOnNow(w, cut);
    });
    if (!t) this.carrying.delete(w.id);
  }

  private carryOnNow(w: Workspace, cut: { id: string }): void {
    this.assertDispatchAllowed();
    if (this.host.workspace(w.id) !== w || w.isArchived || !w.isQuiet) return;
    const d = w.lastDelivered().find((x) => x.input.id === cut.id);
    if (!d || d.since || d.answered) return;
    w.markAnswered(cut.id);
    const text = "A server restart cut your turn off. Carry on where you left off.";
    this.deliver(
      w,
      text,
      { workspaceId: w.id, name: w.name, role: "panel" },
      `[From the panel] ${text}`,
    );
  }

  private markAnswered(w: Workspace): void {
    for (const { input } of w.lastDelivered()) {
      if (input.from?.role === "lead" || input.from?.role === "panel") w.markAnswered(input.id);
    }
    this.host.persistWorkspace(w);
  }

  // What the lead said that has not run yet (a task still waiting for its
  // start slot, follow-ups queued behind a turn or steered into it unread),
  // and the panel's word to carry on.
  private dropQueuedFromLead(w: Workspace, evenSteered = true): void {
    const queued = w.messages.filter(
      (m) => m.status === "queued" && (m.from?.role === "lead" || m.from?.role === "panel"),
    );
    for (const m of queued) {
      if (w.cancelQueued(m.id, evenSteered)) {
        this.host.broadcast({
          type: "message_removed",
          workspaceId: w.id,
          messageId: m.id,
          queued: w.hasQueuedInput,
        });
      }
    }
  }

  // A throw in a timer would take the server down.
  private later(
    projectId: string,
    ms: number,
    fn: () => void,
  ): ReturnType<typeof setTimeout> | undefined {
    if (this.closed || this.store.get(projectId)?.status !== "active") return undefined;
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        if (this.store.get(projectId)?.status === "active") fn();
      } catch (e) {
        console.error("[projects]", e);
      }
    }, ms);
    this.timers.set(t, projectId);
    return t;
  }

  private changed(id: string): void {
    const project = this.store.get(id);
    if (!project) return;
    this.host.broadcast({
      type: "project_updated",
      project: { ...project, objectives: this.board(id).list() },
    });
  }

  private require(id: string): Project {
    const project = this.store.get(id);
    if (!project) throw new Error(`No project ${id}`);
    return project;
  }

  private requireActive(id: string): Project {
    const project = this.require(id);
    if (project.status === "sealed") throw new Error(`Project "${project.name}" is sealed`);
    return project;
  }

  private leadOnline(project: Project): boolean {
    return Boolean(this.leadOf(project.id)) && this.host.isLeadOnline?.(project) !== false;
  }

  private commitBoard<T>(id: string, commit: () => T | Promise<T>): Promise<T> {
    return this.commitLock.run(id, async () => {
      const project = this.requireActive(id);
      if (!this.leadOnline(project))
        throw new Error("Project lead is offline; its board and notes are read-only");
      return await commit();
    });
  }

  async sealProject(id: string, reason?: string): Promise<void> {
    await this.commitLock.run(id, async () => {
      const project = this.require(id);
      if (project.status === "active")
        this.store.save({
          ...project,
          status: "sealed",
          sealedAt: Date.now(),
          sealedReason: reason ?? null,
        });
      for (const [timer, projectId] of this.timers) {
        if (projectId !== id) continue;
        clearTimeout(timer);
        this.timers.delete(timer);
      }
      const members = this.members(id);
      for (const w of members) {
        this.settling.delete(w.id);
        this.carrying.delete(w.id);
        this.host.cancelWorkspaceTimers?.(w);
        this.host.loadWorkspace(w);
        if (w.projectLink?.role === "lead") this.recovery.stop(w);
      }
      await Promise.all(members.map((w) => w.seal()));
      this.changed(id);
    });
  }

  private journal(id: string): ReportJournalStore {
    let journal = this.journals.get(id);
    if (!journal) {
      journal = new ReportJournalStore();
      journal.load(this.store.projectDir(id));
      journal.compact();
      this.journals.set(id, journal);
    }
    return journal;
  }

  mirrorReportDelivery(
    workspace: Workspace,
    reportId: string,
    state: ReportLeadDelivery["state"],
    meta?: Omit<ReportLeadDelivery, "state">,
  ): void {
    const id = workspace.projectLink?.projectId;
    if (!id) return;
    if (this.recovery.receipt(workspace, reportId, state, meta?.errorMessage)) return;
    const journal = this.journal(id);
    const current = journal.getByReportId(reportId)?.leadDelivery.state;
    if (
      !current ||
      (deliveryStateRank(state) <= deliveryStateRank(current) &&
        !(current === "dispatching" && state === "enqueued")) ||
      (state === "settled" && current !== "sent_to_pi")
    )
      return;
    journal.updateLeadDelivery(reportId, { ...meta, state });
  }

  private members(id: string): Workspace[] {
    return [...this.host.workspaces()].filter((w) => w.projectLink?.projectId === id);
  }

  private workers(id: string): Workspace[] {
    return this.members(id).filter((w) => w.projectLink?.role === "worker");
  }

  private leadOf(id: string): Workspace | undefined {
    const leadId = this.store.get(id)?.leadWorkspaceId;
    return leadId ? this.host.workspace(leadId) : undefined;
  }

  private session(projectId: string, sessionId: string): Workspace {
    const w = this.host.workspace(sessionId);
    if (!w || w.projectLink?.projectId !== projectId || w.projectLink.role !== "worker") {
      throw new Error(`No session ${sessionId} in this project`);
    }
    return w;
  }

  private checkReporting(w: Workspace | undefined): void {
    if (w?.projectLink?.unreported) {
      throw new Error(
        "This session does not report to the lead: the user switched that off. Tell the user here instead.",
      );
    }
  }

  // A session the lead may send work to, stop or archive.
  private managed(projectId: string, sessionId: string): Workspace {
    this.requireActive(projectId);
    const w = this.session(projectId, sessionId);
    if (w.projectLink?.unreported) {
      throw new Error(
        `"${w.name}" does not report to the lead: it is the user's own session, not yours to message, stop or archive`,
      );
    }
    return w;
  }

  // Whether the lead is barred from messaging this worker right now. Enforced
  // server-side on message_session and shown in project_status so routing does
  // not rely on prompt discipline alone.
  private isUserTakenOver(w: Workspace): boolean {
    if (!w.messagesLoaded) return w.persistedOwnershipBlocker() === "taken_over";
    const messages = w.getMessages();
    const lastFinish = lastFinishIndex(messages);
    // Local commands bypass the queue. A queued user turn is still pending,
    // even if another agent reported after the user queued it.
    const hasQueuedUser = messages.some(
      (m) => m.kind === "user" && !m.from && m.status === "queued",
    );
    return (
      hasQueuedUser ||
      w.lastDelivered().some((d) => {
        if (!d.since) return false;
        const lastUser = lastDirectUserIndex(messages);
        return lastUser < 0 || lastUser > lastFinish;
      })
    );
  }

  private leadDispatchBlocker(w: Workspace): {
    code: "unreported" | "taken_over" | "user_stopped" | "awaiting_user";
    short: string;
    error: string;
  } | null {
    if (w.projectLink?.unreported) {
      return {
        code: "unreported",
        short: "user's own",
        error: `"${w.name}" does not report to the lead: it is the user's own session, not yours to message, stop or archive`,
      };
    }
    if (this.isUserTakenOver(w)) {
      return {
        code: "taken_over",
        short: "user took over",
        error: `"${w.name}" was taken over by the user: do not message it until the user finishes with it`,
      };
    }
    if (!w.messagesLoaded) {
      if (w.persistedOwnershipBlocker() === "user_stopped") {
        return {
          code: "user_stopped",
          short: "stopped by user",
          error: `"${w.name}" was stopped by the user: leave it to the user`,
        };
      }
      if (w.hasPendingDialogs) {
        return {
          code: "awaiting_user",
          short: "waiting for user",
          error: `"${w.name}" is waiting for the user in its own session: do not message it for them`,
        };
      }
      return null;
    }
    const messages = w.getMessages();
    const lastFinish = lastFinishIndex(messages);
    const turnStoppedByUser = (t: {
      input: Message;
      replies: Message[];
      stopped?: "user" | "restart" | "lead";
      finished?: boolean;
    }) => {
      if (t.stopped !== "user") return false;
      // Handoff clears earlier stops. On restore a later stop can be stored
      // on the delivered Lead input even if the user stopped a different turn.
      if (t.finished) return true;
      const end = t.replies[t.replies.length - 1] ?? t.input;
      const idx = messages.indexOf(end);
      return idx < 0 || idx >= lastFinish;
    };
    if (w.lastDelivered().some(turnStoppedByUser) || w.lastTurns().some(turnStoppedByUser)) {
      return {
        code: "user_stopped",
        short: "stopped by user",
        error: `"${w.name}" was stopped by the user: leave it to the user`,
      };
    }
    if (w.hasPendingDialogs || awaitsUser(w)) {
      return {
        code: "awaiting_user",
        short: "waiting for user",
        error: `"${w.name}" is waiting for the user in its own session: do not message it for them`,
      };
    }
    return null;
  }

  private sessionWork(projectId: string): Map<string, string[]> {
    const bySession = new Map<string, string[]>();
    const add = (sessionId: string, item: string) => {
      const list = bySession.get(sessionId);
      if (list) list.push(item);
      else bySession.set(sessionId, [item]);
    };
    for (const o of this.objectives(projectId)) {
      if (o.archived || isTombstone(o)) continue;
      const tasksBySession = new Map<string, Task[]>();
      for (const t of o.tasks) {
        if (!t.session) continue;
        const list = tasksBySession.get(t.session);
        if (list) list.push(t);
        else tasksBySession.set(t.session, [t]);
      }
      const ids = new Set([...o.sessions, ...tasksBySession.keys()]);
      for (const sid of ids) {
        const tasks = tasksBySession.get(sid);
        add(
          sid,
          tasks?.length ? `${o.id} (${tasks.map((t) => `${t.id} [${t.state}]`).join(", ")})` : o.id,
        );
      }
    }
    return bySession;
  }

  // `text` is what the panel shows, `prompt` what the model reads. Throws
  // when the target cannot take it, so the tool reports the failure.
  private deliver(
    target: Workspace,
    text: string,
    from: MessageOrigin,
    prompt: string,
  ): "sent" | "queued" | "steered" {
    this.assertDispatchAllowed();
    if (target.agents.size === 0) throw new Error(`"${target.name}" has no agent`);
    if (!this.host.restoreWorkspace(target)) throw new Error(`"${target.name}" cannot be loaded`);
    const outcome = target.deliver(text, from, prompt);
    this.host.persistWorkspace(target);
    return outcome;
  }

  private fromLead(projectId: string, text: string): [MessageOrigin, string] {
    const origin: MessageOrigin = {
      workspaceId: this.leadOf(projectId)?.id ?? "",
      name: "lead",
      role: "lead",
    };
    return [origin, `[From the project lead]\n\n${text}`];
  }

  private async status(projectId: string): Promise<string> {
    const project = this.require(projectId);
    const out = [
      `# ${project.name}`,
      project.root ? `Repository: ${project.root}` : "No Git repository.",
      `Notes: ${this.store.notesDir(projectId)}`,
      "",
      "## Worktrees",
    ];
    const sessions = this.workers(projectId);
    for (const wt of project.root ? await gitWorktrees(project.root) : []) {
      const git = await gitStatus(wt);
      // Which live sessions work there: a worktree no one uses can be reused.
      const users = this.members(projectId).filter((w) => !w.isArchived && sameRoot(w.cwd, wt));
      const use = users.length
        ? `in use by ${users
            .map(
              (w) =>
                `${w.id} (${sessionState(w)}${w.projectLink?.unreported ? ", the user's own: not yours to reuse" : ""})`,
            )
            .join(", ")}`
        : "free";
      out.push(
        git
          ? `- ${wt} — ${git.branch ?? "detached"}, ${git.dirty} uncommitted, ahead ${git.ahead}, behind ${git.behind}; ${use}`
          : `- ${wt}; ${use}`,
      );
    }
    out.push("", "## Sessions");
    if (sessions.length === 0) out.push("(none)");
    const workBySession = this.sessionWork(projectId);
    for (const w of sessions) {
      const last = w.messagesLoaded
        ? [...w.getMessages()].reverse().find((m) => m.kind === "agent")
        : undefined;
      const cut = last && (last.status === "error" || last.content.endsWith(INTERRUPTED));
      const blocker = this.leadDispatchBlocker(w);
      const dispatch = blocker
        ? `not lead-dispatchable (${blocker.short})`
        : w.isArchived && !w.messagesLoaded
          ? "dispatchability unknown (archived; checked on load)"
          : "lead-dispatchable";
      const state = `${sessionState(w)}${cut ? ", its last turn did not finish" : ""}; ${dispatch}`;
      const tasks = workBySession.get(w.id);
      const linked = tasks?.length ? ` — tasks: ${tasks.join(", ")}` : "";
      const excerpt = last ? ` — last reply: ${oneLine(last.content, 160)}` : "";
      const own = w.projectLink?.unreported ? " (the user's own: does not report to you)" : "";
      out.push(`- ${w.id} "${w.name}"${own} in ${w.cwd} — ${state}${linked}${excerpt}`);
    }
    out.push("", "## Active objectives", this.listObjectives(projectId, { status: "active" }));
    out.push("", "## Issues", this.issueBoard(projectId).summary());
    out.push("", "## Size", await this.size(projectId));
    return out.join("\n");
  }

  // How much the board and the notes hold: what every agent reading them
  // reads.
  private async size(projectId: string): Promise<string> {
    const { board, archive } = this.board(projectId).sizes();
    const issues = this.issues(projectId).size();
    const notes = await folderSize(this.store.notesDir(projectId));
    const kb = (n: number) => `${Math.ceil(n / 1024)} KB`;
    const files = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    return [
      `- objectives: ${files(board.files, "file")}, ${kb(board.bytes)}` +
        (archive.files ? `; archive: ${files(archive.files, "file")}, ${kb(archive.bytes)}` : ""),
      `- issues: ${files(issues.files, "module")}, ${kb(issues.bytes)}`,
      `- notes: ${files(notes.files, "file")}, ${kb(notes.bytes)}`,
    ].join("\n");
  }

  private workerPreset(
    projectId: string,
    presets: AgentPreset[],
    model: string,
    effort?: string,
  ): AgentPreset {
    const modelMatches = presets.filter((p) => p.model === model);
    let candidates = effort === undefined ? [] : modelMatches.filter((p) => p.effort === effort);
    if (!candidates.length) candidates = modelMatches;
    if (!candidates.length) candidates = presets.filter((p) => !p.model);
    if (!candidates.length) candidates = AGENT_PRESETS;
    if (candidates.length === 1) return candidates[0];

    const identities = this.workers(projectId).map((w) => w.resolveAgent()?.info);
    let picked = candidates[0];
    let fewest = Infinity;
    for (const candidate of candidates) {
      const count = identities.filter(
        (info) => info?.name === candidate.name && info.avatar === candidate.avatar,
      ).length;
      if (count < fewest) {
        picked = candidate;
        fewest = count;
      }
    }
    return picked;
  }

  private startSession(projectId: string, a: StartSessionArgs): string {
    this.assertDispatchAllowed();
    const project = this.require(projectId);
    const input =
      a.cwd === "~" || a.cwd.startsWith("~/") ? path.join(os.homedir(), a.cwd.slice(1)) : a.cwd;
    const cwd = resolveWorkspacePath(
      path.resolve(project.root ?? this.leadOf(projectId)?.cwd ?? this.baseDir, input),
    );
    if (!cwd) {
      throw new Error(
        `Not a directory: ${a.cwd}. Create it first${project.root ? ` (a worktree: git -C ${project.root} worktree add <path> -b <branch>)` : ""}.`,
      );
    }
    const presets = this.agentPresets();
    let chosen: AgentPreset | undefined;
    if (a.preset !== undefined) {
      const matches = presets.filter((p) => p.name === a.preset);
      const name = JSON.stringify(a.preset);
      if (!matches.length) {
        const names = selectablePresetNames(presets.map((p) => p.name));
        throw new Error(`Unknown preset ${name}; one of: ${names || "(none)"}`);
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous preset ${name}; ${matches.length} presets have this name`);
      }
      chosen = matches[0];
    }
    const models = this.panelModels();
    const defaults = this.defaultModel(models);
    const explicit = a.model ?? chosen?.model;
    if (explicit !== undefined && !models.includes(explicit)) {
      throw invalidExplicitModel(a.model !== undefined ? "request.model" : "agent_presets.model");
    }
    const model = explicit ?? defaults.model;
    if (model === undefined) throw this.missingDefaultModel();
    const levels = effortLevelsForModel(model, this.host.modelOptions?.());
    if (a.effort && levels && !levels.includes(a.effort)) {
      throw new Error(
        levels.length
          ? `${model} has no effort ${a.effort}; one of: ${levels.join(", ")}`
          : `${model} takes no effort level`,
      );
    }
    const objective = a.objectiveId ? this.objective(projectId, a.objectiveId) : undefined;
    if (objective?.archived) throw new Error(`${objective.id} is in the archive: read-only`);
    if (objective?.status === "dropped") {
      throw new Error(`${objective.id} is dropped: make it active first`);
    }
    if (a.taskId && !objective) throw new Error("task_id needs objective_id");
    if (a.taskId && !objective!.tasks.some((t) => t.id === a.taskId)) {
      throw new Error(`No task ${a.taskId} in ${objective!.id}`);
    }

    const defaultEffort = model === defaults.model ? defaults.effort : undefined;
    let effort = a.effort ?? defaultEffort;
    if (chosen && a.effort === undefined) {
      effort = a.model === undefined ? defaultEffort : undefined;
      if (chosen.effort !== undefined) {
        effort = levels?.includes(chosen.effort) ? chosen.effort : undefined;
      }
    }
    const preset = chosen ?? this.workerPreset(projectId, presets, model, effort);
    const w = this.host.createWorkspace(a.title, cwd, {
      projectId,
      role: "worker",
      ...(a.isolated && { isolated: true }),
    });
    try {
      this.host.addAgent(w, preset.name, model, preset.avatar, preset.color, effort);
    } catch (e) {
      this.host.removeWorkspace(w.id);
      throw e;
    }
    if (objective) {
      this.saveObjective(projectId, {
        ...objective,
        sessions: [...objective.sessions, w.id],
        tasks: objective.tasks.map((t) =>
          t.id === a.taskId
            ? { ...t, session: w.id, state: t.state === "todo" ? ("doing" as const) : t.state }
            : t,
        ),
      });
    }
    const delay = this.spaceStart(w);
    this.deliver(w, a.task, ...this.fromLead(projectId, a.task));
    const started = `Started session ${w.id} ("${a.title}") in ${cwd} on ${model}.`;
    return delay === 0
      ? started
      : `${started} Its task goes out in ${Math.ceil(delay / 1000)} s: starts are spaced out.`;
  }

  // A lead's message that starts a worker's turn goes out spaced from the
  // others: it waits as a queued message (saved, shown, ahead of any
  // follow-up) behind a pause on the worker's agent; after a restart the
  // server's spaced dequeue sends it. Returns the wait.
  private spaceStart(w: Workspace): number {
    const agent = w.resolveAgent();
    const now = Date.now();
    const waits =
      !agent ||
      agent.session.isRunning ||
      agent.retryPending ||
      (agent.pausedUntil !== undefined && now < agent.pausedUntil) ||
      w.messages.some(
        (m) =>
          (m.status === "queued" || m.status === "starting" || m.status === "dispatching") &&
          m.queuedFor === agent.info.id,
      );
    if (waits) return 0;
    const delay = this.takeStartSlot();
    if (delay > 0) {
      const agentId = agent.info.id;
      w.pauseAgent(agentId, now + delay);
      this.later(w.projectLink!.projectId, delay, () => {
        if (this.host.workspace(w.id) === w) w.endPause(agentId);
      });
    }
    return delay;
  }

  // Any session, by its id: one is only known from a search or a message.
  private readable(sessionId: string): Workspace {
    const w = this.host.workspace(sessionId);
    if (!w) throw new Error(`No session ${sessionId}`);
    return w;
  }

  // Archived sessions that belong to no project, in the project's folders
  // (the repository, folders in it, its worktrees).
  private async history(projectId: string): Promise<Workspace[]> {
    const root = this.require(projectId).root;
    if (!root) return [];
    const roots = await gitWorktrees(root);
    const inside = (cwd: string) => {
      const canonical = canonicalPath(cwd);
      return roots.some((r) => {
        const root = canonicalPath(r);
        return (
          canonical === root ||
          canonical.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
        );
      });
    };
    return [...this.host.workspaces()].filter(
      (w) => w.isArchived && !w.projectLink && inside(w.cwd),
    );
  }

  // The project a history tool reads: its own, another by name or id, or
  // none for every session ("*").
  private target(projectId: string, project?: string): Project | null {
    if (project === undefined) return this.require(projectId);
    if (project === "*") return null;
    const all = this.store.list();
    const byId = all.find((p) => p.id === project);
    if (byId) return byId;
    const named = all.filter((p) => p.name.toLowerCase() === project.toLowerCase());
    if (named.length === 1) return named[0];
    const list = all.map((p) => `${p.id} "${p.name}"`).join(", ");
    throw new Error(
      named.length
        ? `"${project}" names ${named.length} projects; give the id: ${list}`
        : `No project "${project}": ${list}`,
    );
  }

  // What the history tools reach: a project's sessions, its lead's included,
  // and the archived ones of no project in its folders; or every session.
  private async scope(projectId: string, project?: string, session?: string) {
    if (session) return [this.readable(session)];
    const target = this.target(projectId, project);
    const sessions = target
      ? [...new Set([...this.members(target.id), ...(await this.history(target.id))])]
      : [...this.host.workspaces()];
    return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  private async searchHistory(projectId: string, a: HistorySearch): Promise<string> {
    const base = this.target(projectId, a.project) ?? this.require(projectId);
    const folder =
      a.folder && path.resolve(base.root ?? this.leadOf(base.id)?.cwd ?? this.baseDir, a.folder);
    const sessions = (await this.scope(projectId, a.project, a.session)).filter(
      (w) =>
        !folder ||
        w.cwd === folder ||
        w.cwd.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`),
    );
    const names = new Map(sessions.map((w) => [w.id, w.name]));
    const kinds: EntryKind[] =
      a.in ?? (a.call ? ["tool_output"] : a.tool ? ["tool_call", "tool_output"] : ["said"]);
    const terms = queryTerms(a.query ?? "");
    const result = await this.host.history.search({
      terms,
      regex: a.regex,
      caseSensitive: a.caseSensitive,
      kinds,
      tool: a.tool,
      call: a.call,
      sessions: sessions.map((w) => w.id),
      message: a.message,
      since: a.since,
      until: a.until,
      depth: a.depth,
      limit: a.limit,
      offset: a.offset,
      lines: a.lines,
      context: a.context,
    });
    const listed = terms.length === 0 && !a.regex;
    const out = result.hits.map((h) => {
      const lines: string[] = [];
      let last = -1;
      for (const l of h.lines) {
        if (a.context && last >= 0 && l.n > last + 1) lines.push("  --");
        lines.push(`  ${l.n}${l.match || listed ? ":" : "-"} ${l.text}`);
        last = l.n;
      }
      const call = h.call ? ` · output of #${h.call.entry}: ${oneLine(h.call.head, 100)}` : "";
      const more = h.moreLines
        ? [`  (+${h.moreLines} more ${listed ? "lines" : "matching lines"})`]
        : [];
      return [`- ${entryHeader(h, names.get(h.session))}${call}`, ...lines, ...more].join("\n");
    });
    if (result.more) out.push(`(more: offset ${a.offset + a.limit})`);
    if (out.length === 0) {
      out.push(`(nothing matches in ${kinds.join(", ")})`);
      const elsewhere = Object.entries(result.elsewhere ?? {});
      if (elsewhere.length) {
        out.push(
          `(it does in ${elsewhere.map(([k, n]) => `${n} ${k}`).join(", ")} entries: ask with in)`,
        );
      }
      if (result.tools) {
        out.push(`(the tools used there: ${result.tools.join(", ") || "none"})`);
      }
    }
    if (result.pending) {
      out.push(`(the index is catching up: ${result.pending} messages are not searchable yet)`);
    }
    return out.join("\n");
  }

  private async readEntry(
    projectId: string,
    entry: number,
    from: number,
    count: number,
    fromChar: number,
  ): Promise<string> {
    const e = await this.host.history.read(entry, from, count, fromChar);
    if (!e) throw new Error(`No entry #${entry}`);
    const w = this.readable(e.session);
    if (e.lines.length === 0) return `#${e.entry} has ${e.lineCount} lines`;
    const out: string[] = [];
    let size = 0;
    let n = e.from;
    for (const [i, line] of e.lines.entries()) {
      const offset = i === 0 ? fromChar : 0;
      const piece =
        line.length > LINE_CAP
          ? `${line.slice(0, LINE_CAP)}…(the line goes on: from_line ${n} from_char ${offset + LINE_CAP})`
          : line;
      if (out.length && size + piece.length > OUTPUT_CAP) break;
      out.push(`${n}: ${piece}`);
      size += piece.length;
      n++;
    }
    const last = n - 1;
    return [
      `${entryHeader(e, w.name)} — lines ${e.from}–${last} of ${e.lineCount}`,
      ...out,
      ...(last < e.lineCount ? [`(more: from_line ${last + 1})`] : []),
    ].join("\n");
  }

  private async readSession(
    projectId: string,
    sessionId: string,
    count: number,
    around?: string,
    tools = false,
    start = false,
  ): Promise<string> {
    const w = this.readable(sessionId);
    if (!this.host.loadWorkspace(w)) throw new Error(`"${w.name}" cannot be loaded`);
    const agents = new Map([...w.agents.values()].map((a) => [a.info.id, a.info.name]));
    const messages = w.getMessages().filter((x) => x.kind !== "system");
    const at = around ? messages.findIndex((m) => m.id === around) : -1;
    if (around && at < 0) throw new Error(`No message ${around} in "${w.name}"`);
    const shown =
      at >= 0
        ? messages.slice(Math.max(0, at - 5), at + 6)
        : start
          ? messages.slice(0, count)
          : messages.slice(-count);
    const out = [
      `Session ${w.id} "${w.name}" in ${w.cwd} — ${w.isArchived ? "archived" : sessionState(w)} · ${messages.length} messages`,
    ];
    const entries = new Map<string, Array<EntryInfo & { head: string }>>();
    for (const e of await this.host.history.entries(
      w.id,
      shown.map((m) => m.id),
    )) {
      const list = entries.get(e.message) ?? [];
      list.push(e);
      entries.set(e.message, list);
    }
    for (const m of shown) {
      const who = m.from
        ? originLabel(m.from)
        : m.kind === "user"
          ? "user"
          : (agents.get(m.agentId ?? "") ?? "agent");
      const calls = (m.events ?? []).filter((e) => e.kind === "tool_use").length;
      const list = entries.get(m.id);
      const said = list?.find((e) => e.kind === "said" && e.depth === 0);
      out.push(
        "",
        `--- ${who} · ${new Date(m.timestamp).toISOString()} · ${m.status}${calls ? ` · ${calls} tool calls` : ""} · ${m.id}`,
        m.content.length > 3000
          ? `${m.content.slice(0, 3000)} …(truncated${said ? `: read_entry #${said.entry}` : ""})`
          : m.content,
      );
      if (!tools) continue;
      const others = list?.filter((e) => e !== said) ?? [];
      if (!list && m.events?.length) {
        out.push("  (not indexed yet)");
        continue;
      }
      for (const e of others.slice(0, ENTRIES_SHOWN)) {
        out.push(
          `  #${e.entry} ${entryLabel(e)} · ${e.lineCount} lines${e.head ? ` · ${oneLine(e.head, 120)}` : ""}`,
        );
      }
      if (others.length > ENTRIES_SHOWN) {
        out.push(
          `  (+${others.length - ENTRIES_SHOWN} more: search_history with session ${w.id} and message ${m.id})`,
        );
      }
    }
    return out.join("\n");
  }

  // One read-only SQL statement over the histories search_history reaches.
  private async queryHistory(projectId: string, query: string, project?: string): Promise<string> {
    const sessions: SessionRow[] = (await this.scope(projectId, project)).map((w) => ({
      id: w.id,
      name: w.name,
      cwd: w.cwd,
      project: w.projectLink ? (this.store.get(w.projectLink.projectId)?.name ?? null) : null,
      role: w.projectLink?.role ?? null,
      created_at: w.createdAt,
      last_active: w.lastActivityAt,
      archived_at: w.archivedAt,
    }));
    const r = await this.host.history.sql(query, sessions, SQL_ROWS);
    if (r.rows.length === 0) return "(no rows)";
    const cell = (v: SqlValue): string => {
      if (v == null) return "NULL";
      const t = String(v).replace(/\t/g, "  ").replace(/\n/g, "\\n");
      return t.length > CELL_CAP ? `${t.slice(0, CELL_CAP)}…(${t.length - CELL_CAP} more)` : t;
    };
    return [
      r.columns.join("\t"),
      ...r.rows.map((row) => r.columns.map((c) => cell(row[c])).join("\t")),
      `(${r.rows.length} rows${r.truncated ? `, stopped at ${SQL_ROWS}: narrow it or page with limit/offset` : ""})`,
    ].join("\n");
  }

  private listProjects(projectId: string): string {
    const others = this.store.list().filter((p) => p.id !== projectId);
    if (others.length === 0) return "(no other projects)";
    return others
      .map((p) => {
        const lead = this.leadOf(p.id);
        return `- ${p.id} "${p.name}" — ${p.root ?? "no Git repository"} — lead ${lead ? sessionState(lead) : "missing"}${p.archivedAt ? " — archived" : ""}`;
      })
      .join("\n");
  }

  private messageProject(projectId: string, targetId: string, text: string): string {
    this.assertDispatchAllowed();
    if (targetId === projectId) throw new Error("That is this project; use message_session");
    const self = this.requireActive(projectId);
    const other = this.requireActive(targetId);
    const lead = this.leadOf(targetId);
    if (!lead) throw new Error(`Project "${other.name}" has no lead`);
    const pair = [projectId, targetId].sort().join(" ");
    const now = Date.now();
    const recent = (this.peerLog.get(pair) ?? []).filter((t) => now - t < PEER_WINDOW_MS);
    if (recent.length >= PEER_LIMIT) {
      throw new Error(
        `${recent.length} messages with "${other.name}" in the last ${PEER_WINDOW_MS / 60_000} minutes; stop here and tell the user`,
      );
    }
    this.deliver(
      lead,
      text,
      { workspaceId: this.leadOf(projectId)?.id ?? "", name: self.name, role: "peer", projectId },
      `[From the lead of project "${self.name}" (${projectId}). If they ask for something, answer with message_project; otherwise no reply is needed.]\n\n${text}`,
    );
    this.peerLog.set(pair, [...recent, now]);
    return `Sent to the lead of "${other.name}". An answer, if any, arrives later as a message from that project.`;
  }

  private listObjectives(
    projectId: string,
    filter: { area?: string; status?: string; archived?: boolean },
  ): string {
    const all = this.board(projectId).list();
    const objectives = all.filter((o): o is Objective => !("error" in o));
    const deps = dependencies(objectives);
    const inView = objectives.filter((o) => !!o.archived === !!filter.archived);
    const shown = inView.filter(
      (o) =>
        (!filter.area || o.area === filter.area) && (!filter.status || o.status === filter.status),
    );
    const broken = all.filter((o): o is BrokenObjective => "error" in o);
    const issues = this.issueBoard(projectId).linked();
    const out: string[] = [];
    let area = "";
    for (const o of shown) {
      if (o.area !== area) {
        area = o.area;
        out.push(`${out.length ? "\n" : ""}## ${area}`);
      }
      const live = o.tasks.filter((t) => t.state !== "dropped");
      const done = live.filter((t) => t.state === "done").length;
      const open = o.decisions.filter((d) => !d.outcome).length;
      const { blockedBy, dropped } = deps.get(o.id)!;
      const bugs = issues.get(o.id)?.open.length ?? 0;
      out.push(
        `- ${o.id} [${o.status}, ${o.priority}] ${o.title} — tasks ${done}/${live.length}` +
          (open ? `, ${open} open decision${open === 1 ? "" : "s"}` : "") +
          (bugs ? `, ${bugs} open issue${bugs === 1 ? "" : "s"}` : "") +
          (blockedBy.length ? `; blocked by ${blockedBy.join(", ")}` : "") +
          (dropped.length ? `; prerequisite dropped: ${dropped.join(", ")}` : ""),
      );
    }
    for (const b of broken) out.push(`- ${b.id} UNREADABLE: ${b.error}`);
    if (shown.length === 0) {
      // Say what there is, so an empty filter is not taken for an empty board.
      const counts = OBJECTIVE_STATUSES.map(
        (st) => [st, inView.filter((o) => o.status === st).length] as const,
      )
        .filter(([, n]) => n)
        .map(([st, n]) => `${n} ${st}`);
      const archived = objectives.filter((o) => o.archived).length;
      if (!filter.archived && archived) counts.push(`${archived} archived`);
      out.unshift(
        `No ${filter.status ?? ""} objectives here${counts.length ? ` (${counts.join(", ")})` : ""}.`.replace(
          "  ",
          " ",
        ),
      );
    }
    return out.join("\n");
  }

  private async readObjective(projectId: string, id: string): Promise<string> {
    const age = await this.ages(projectId, [this.objective(projectId, id).contextCommit]);
    return this.describeObjective(projectId, id, age, false);
  }

  // One objective in full, read in one go; `forTask` (a worker's
  // current_task) leaves out what is not its work: who needs it, its
  // sessions, more than a few issues.
  private describeObjective(
    projectId: string,
    id: string,
    age: (at?: number, commit?: string) => string,
    forTask: boolean,
  ): string {
    const o = this.objective(projectId, id);
    if (isTombstone(o)) {
      return [
        `${o.id} — ${o.title}`,
        `status: dropped${o.archived ? " (archived)" : ""} — ${o.reason ?? ""}`,
      ].join("\n");
    }
    const objectives = this.objectives(projectId);
    const byId = new Map(objectives.map((x) => [x.id, x]));
    const info = dependencies(objectives).get(o.id)!;
    const ref = (x: string) => {
      const target = byId.get(x);
      if (!target) return `${x} (missing)`;
      const flags = [
        target.status,
        info.blockedBy.includes(x) && "blocking",
        target.archived && "archived",
      ];
      return `${x} (${flags.filter(Boolean).join(", ")})`;
    };
    const live = o.sessions.flatMap((sid) => {
      const w = this.host.workspace(sid);
      return w && !w.isArchived ? [`${sid} "${w.name}" (${sessionState(w)})`] : [];
    });
    const gone = o.sessions.length - live.length;
    const out = [
      `${o.id} — ${o.title}`,
      `status: ${o.status}${o.archived ? " (archived)" : ""}, priority: ${o.priority}${o.reason ? ` — ${o.reason}` : ""}`,
    ];
    if (o.goal) out.push(`goal: ${o.goal}`);
    out.push(`depends on: ${o.dependsOn.map(ref).join(", ") || "nothing"}`);
    if (!forTask) {
      out.push(
        `needed by: ${info.unblocks.join(", ") || "nothing"}`,
        `sessions: ${[...live, ...(gone ? [`${gone} archived or deleted`] : [])].join(", ") || "none"}`,
      );
    }
    out.push(`updated: ${new Date(o.updatedAt).toISOString()}`);
    if (o.context) {
      const written = age(o.contextWritten, o.contextCommit);
      out.push("", `context (${written ? `written ${written}` : "undated"}):`, o.context);
    }
    out.push("", "tasks:");
    for (const t of o.tasks) {
      out.push(`${taskLine(t)}${t.session ? ` (session ${t.session})` : ""}`);
    }
    if (o.tasks.length === 0) out.push("(none)");
    out.push("", "decisions:");
    for (const d of o.decisions) {
      out.push(
        d.outcome
          ? `- ${d.id} settled: ${d.question} → ${d.outcome}`
          : `- ${d.id} open: ${d.question}`,
      );
    }
    if (o.decisions.length === 0) out.push("(none)");
    const issues = this.issueBoard(projectId).linked().get(o.id);
    if (issues) {
      const shown = forTask ? TASK_ISSUES_SHOWN : ISSUES_SHOWN;
      out.push("", "issues:");
      for (const { issue: x } of issues.open.slice(0, shown)) {
        const flags = [x.state !== "open" && x.state, x.evidence].filter(Boolean).join(", ");
        out.push(`- ${x.id}${flags ? ` [${flags}]` : ""} ${oneLine(x.text, 140)}`);
      }
      const more = issues.open.length - shown;
      if (more > 0) out.push(`(${more} more: list_issues with objective ${o.id})`);
      if (issues.accepted) out.push(`(${issues.accepted} accepted: list_issues with states)`);
    }
    if (o.notes) out.push("", "links:", o.notes);
    return out.join("\n");
  }

  // A worker's new objective names its session, as start_session's would.
  // Done is not a status to write: a done objective is deleted. Dropped
  // shrinks it to its title and the reason.
  private async writeObjective(
    projectId: string,
    patch: ObjectivePatch,
    sessionId?: string,
  ): Promise<string> {
    checkId(patch.id);
    if (patch.status === "done") {
      throw new Error(
        sessionId
          ? "An objective whose work is done is deleted, by the lead: report your part with finish_task"
          : "An objective whose work is done is deleted, not marked done: delete_objective; the history keeps it",
      );
    }
    // Text sent back as it is is not new: neither refused nor dated anew.
    const before = this.board(projectId).get(patch.id);
    if (patch.context !== before?.context)
      checkLength("The context", patch.context, LIMITS.context);
    if (patch.notes !== before?.notes) {
      checkLength("notes", patch.notes, LIMITS.notes, "links to design docs, not their content");
    }
    const stamp =
      patch.context && patch.context !== before?.context
        ? await this.stamp(projectId, sessionId)
        : undefined;
    const board = this.board(projectId);
    const current = board.get(patch.id);
    if (current?.archived) {
      throw new Error(`${patch.id} is in the archive: read-only`);
    }
    if (!current && (!patch.title || (!patch.goal && patch.status !== "dropped"))) {
      throw new Error(`${patch.id} does not exist yet: give it a title and a goal`);
    }
    if (patch.title === "" || patch.goal === "") throw new Error("title and goal cannot be empty");
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as ObjectivePatch;
    let next: Objective = {
      ...(current ?? {
        id: patch.id,
        area: patch.id.split("/")[0],
        title: "",
        goal: "",
        status: "active",
        priority: "normal",
        dependsOn: [],
        tasks: [],
        decisions: [],
        sessions: sessionId ? [sessionId] : [],
        updatedAt: 0,
      }),
      ...defined,
    };
    if (stamp && next.context !== current?.context) {
      next.contextWritten = stamp.at;
      if (stamp.commit) next.contextCommit = stamp.commit;
      else delete next.contextCommit;
    }
    // A reason explains the status or priority it was given with; a
    // dropped one's, the drop.
    const moved =
      current &&
      ((patch.status && patch.status !== current.status) ||
        (patch.priority && patch.priority !== current.priority && next.status !== "dropped"));
    if (moved && patch.reason === undefined) delete next.reason;
    for (const key of ["reason", "context", "notes"] as const)
      if (next[key] === "") delete next[key];
    if (!next.context) {
      delete next.contextWritten;
      delete next.contextCommit;
    }
    if (next.status === "dropped") {
      if (!next.reason) throw new Error(`Say why ${next.id} is dropped (reason)`);
      next = {
        id: next.id,
        area: next.area,
        title: next.title,
        goal: "",
        status: "dropped",
        priority: "normal",
        reason: next.reason,
        dependsOn: [],
        tasks: [],
        decisions: [],
        sessions: [],
        updatedAt: next.updatedAt,
      };
    } else if (!next.goal) {
      throw new Error(`${next.id} was dropped and kept only its title: give it a goal`);
    }
    next.dependsOn = [...new Set(next.dependsOn)].filter((d) => d !== next.id);
    for (const d of next.dependsOn) checkId(d);
    const others = this.objectives(projectId).filter((o) => o.id !== next.id);
    const cycle = cycleThrough([...others, next], next.id);
    if (cycle) throw new Error(`That makes a dependency cycle: ${cycle.join(" → ")}`);
    this.saveObjective(projectId, next);
    const known = new Set(others.map((o) => o.id));
    const missing = next.dependsOn.filter((d) => !known.has(d));
    const deps =
      patch.dependsOn !== undefined
        ? ` Depends on: ${next.dependsOn.join(", ") || "nothing"}.`
        : "";
    const warn = missing.length ? ` Not objectives (yet): ${missing.join(", ")}.` : "";
    const kept = next.status === "dropped" ? " Kept as its title and the reason." : "";
    return `${current ? "Updated" : "Created"} ${next.id} [${next.status}, ${next.priority}].${kept}${deps}${warn}`;
  }

  // A worker that takes up a task nobody carries out is its session.
  private updateItem(
    projectId: string,
    oid: string,
    itemId: string,
    patch: ItemPatch,
    sessionId?: string,
  ): string {
    const o = this.objective(projectId, oid);
    // Clearing out what a dropped one still holds is fine; adding to it not.
    if (o.status === "dropped" && !patch.remove) {
      throw new Error(`${o.id} is dropped: make it active first`);
    }
    if (patch.remove) {
      if (![...o.tasks, ...o.decisions].some((x) => x.id === itemId)) {
        throw new Error(`No item ${itemId} in ${o.id}`);
      }
      this.saveObjective(projectId, {
        ...o,
        tasks: o.tasks.filter((t) => t.id !== itemId),
        decisions: o.decisions.filter((d) => d.id !== itemId),
      });
      return `Removed ${o.id} ${itemId}.`;
    }
    const task = o.tasks.find((t) => t.id === itemId);
    if (task) {
      if (patch.outcome !== undefined)
        throw new Error(`${itemId} is a task; outcome is for decisions`);
      if (patch.text !== task.text) checkTask(patch.text);
      this.saveObjective(projectId, {
        ...o,
        tasks: o.tasks.map((t) =>
          t.id === itemId
            ? {
                ...t,
                ...(patch.text && { text: patch.text }),
                ...(patch.state && { state: patch.state }),
                ...(sessionId && patch.state === "doing" && !t.session && { session: sessionId }),
              }
            : t,
        ),
      });
      return `Updated ${o.id} ${itemId}.`;
    }
    const d = o.decisions.find((x) => x.id === itemId);
    if (d) {
      if (patch.state) throw new Error(`${itemId} is a decision; settle it with an outcome`);
      if (patch.text !== d.question) {
        checkLength("The question", patch.text, LIMITS.decision, "the question alone");
      }
      checkLength(
        "The outcome",
        patch.outcome === d.outcome ? undefined : patch.outcome,
        LIMITS.decision,
        "what was decided, not the discussion",
      );
      this.saveObjective(projectId, {
        ...o,
        decisions: o.decisions.map((d) => {
          if (d.id !== itemId) return d;
          const next = { ...d, ...(patch.text && { question: patch.text }) };
          if (patch.outcome === "") delete next.outcome;
          else if (patch.outcome !== undefined) next.outcome = patch.outcome;
          return next;
        }),
      });
      return `Updated ${o.id} ${itemId}.`;
    }
    throw new Error(`No item ${itemId} in ${o.id}`);
  }

  // What a worker session is on, for when its own context no longer holds
  // it: the task as the lead gave it, the lead's later messages, and its
  // objectives on the board as they are now (an isolated worker's own tasks
  // in them only).
  private async currentTask(workspaceId: string, objectiveId?: string): Promise<string> {
    const w = this.host.workspace(workspaceId);
    const projectId = w?.projectLink?.projectId;
    if (!w || !projectId) throw new Error("This session belongs to no project");
    if (objectiveId) {
      if (w.projectLink?.isolated) throw new Error("An isolated session reads only its own task");
      return this.readObjective(projectId, objectiveId);
    }
    if (!this.host.loadWorkspace(w)) throw new Error(`"${w.name}" cannot be loaded`);
    // Keep only delivered lead messages; queued/undelivered ones were not
    // received by this turn and may still drive a later turn.
    const fromLead = w.getMessages().filter((m) => m.from?.role === "lead" && m.status === "done");
    const when = (t: number) => new Date(t).toISOString();
    const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …(cut)` : s);
    const out = [`You are session ${w.id} "${w.name}" in ${w.cwd}.`, ""];
    const [task, ...later] = fromLead;
    out.push(
      task
        ? `The task, as the lead gave it (${when(task.timestamp)}):\n\n${cap(task.content, 6000)}`
        : "(no task from the lead in this session)",
    );
    for (const m of later.slice(-5)) {
      out.push("", `Later from the lead (${when(m.timestamp)}):\n\n${cap(m.content, 2000)}`);
    }
    const mine = this.objectivesOf(projectId, w.id);
    if (w.projectLink?.isolated) {
      for (const o of mine) out.push("", "---", "", ownTasks(o, w.id));
    } else {
      const age = await this.ages(
        projectId,
        mine.map((o) => o.contextCommit),
      );
      for (const o of mine)
        out.push("", "---", "", this.describeObjective(projectId, o.id, age, true));
    }
    if (mine.length === 0) out.push("", "(no objective on the board names this session)");
    return out.join("\n");
  }

  // The objective a worker's finished context goes to: the one named, or
  // the one it works on.
  private contextTarget(projectId: string, sessionId: string, named?: string): Objective {
    let id = named;
    if (!id) {
      const mine = this.objectivesOf(projectId, sessionId).filter((o) => !o.archived);
      if (mine.length !== 1) {
        throw new Error(
          mine.length
            ? `you work on ${mine.map((o) => o.id).join(", ")}; objective_id says which`
            : "no objective on the board names this session",
        );
      }
      id = mine[0].id;
    }
    const o = this.objective(projectId, id);
    if (o.archived || o.status === "dropped") {
      throw new Error(`${o.id} is ${o.archived ? "in the archive" : "dropped"}`);
    }
    return o;
  }

  // The objectives a worker session works on.
  private objectivesOf(projectId: string, sessionId: string): Objective[] {
    return this.objectives(projectId).filter(
      (o) => o.sessions.includes(sessionId) || o.tasks.some((t) => t.session === sessionId),
    );
  }

  private async workerReport(
    workspaceId: string,
    text: string,
    final: boolean,
    finish: FinishPatch = {},
    callId: string = randomUUID(),
  ): Promise<string> {
    const w = this.host.workspace(workspaceId);
    const id = w?.projectLink?.role === "worker" ? w.projectLink.projectId : undefined;
    if (!w || !id) throw new Error("This session has no project lead");
    const receivedAt = Date.now();
    const stamp = final && finish.context ? await this.stamp(id, w.id) : undefined;
    const { ack, online } = await this.commitLock.run(id, () => {
      const project = this.requireActive(id);
      this.checkReporting(w);
      const journal = this.journal(id);
      const online = this.leadOnline(project);
      const waiting = online && !this.leadOf(id)?.resolveAgent();
      const saved = waiting
        ? "Report saved and awaiting a Lead agent."
        : "Report saved for the offline lead.";
      const duplicate = journal.findByCallId(callId);
      if (duplicate)
        return {
          ack:
            duplicate.leadDelivery.state === "pending" && (!online || waiting)
              ? saved
              : final
                ? "Reported to the lead."
                : "Sent to the lead.",
          online,
        };
      let frozenPlan: FrozenReportPlan | null = null;
      let unwritten = "";
      if (final) {
        let contextWrite: FrozenReportPlan["contextWrite"] = null;
        if (finish.context && !w.projectLink?.isolated) {
          let target: Objective | undefined;
          try {
            target = this.contextTarget(id, w.id, finish.objectiveId);
          } catch (error) {
            unwritten = ` The context was not written: ${error instanceof Error ? error.message : String(error)}.`;
          }
          if (finish.context !== target?.context) {
            checkLength("The context", finish.context, LIMITS.context);
            if (target)
              contextWrite = {
                objectiveId: target.id,
                expectedPrevUpdatedAt: target.updatedAt,
                context: finish.context,
                stamp: { at: receivedAt, commit: stamp?.commit },
              };
          }
        }
        frozenPlan = {
          answeredInputIds: w
            .lastDelivered()
            .filter(({ input }) => input.from?.role === "lead" || input.from?.role === "panel")
            .map(({ input }) => input.id),
          finishedInputIds: w.currentInputIds(),
          contextWrite,
          taskTransitions: this.objectives(id)
            .filter((o) => !o.archived)
            .flatMap((o) =>
              o.tasks
                .filter((t) => t.session === w.id && t.state === "doing")
                .map((t) => ({ objectiveId: o.id, taskId: t.id, expectedSession: w.id })),
            ),
        };
      }
      journal.append({
        reportId: randomUUID(),
        callId,
        kind: final ? "final" : "progress",
        workerWsId: w.id,
        workerName: w.name,
        payload: { text, ...finish },
        frozenPlan,
        boardState: final ? "pending" : "not_applicable",
        leadDelivery: { state: "pending" },
        createdAt: receivedAt,
      });
      if (final) {
        w.markFinished(frozenPlan?.finishedInputIds ?? []);
        this.host.saveWorkspaceNow(w);
      }
      return {
        ack:
          online && !waiting
            ? final
              ? `Reported to the lead.${unwritten}`
              : "Sent to the lead."
            : `${saved}${unwritten}`,
        online,
      };
    });
    if (online)
      await this.drainInbox(id).catch((error) =>
        console.error(`[projects] ${id}: report saved; drain failed`, error),
      );
    return ack;
  }

  private applyFrozenReport(
    id: string,
    workerId: string,
    plan: FrozenReportPlan,
    receivedAt: number,
  ): void {
    const worker = this.host.workspace(workerId);
    if (worker) {
      for (const inputId of plan.answeredInputIds) worker.markAnswered(inputId);
      if (plan.finishedInputIds?.length) worker.markFinished(plan.finishedInputIds);
      this.host.saveWorkspaceNow(worker);
    }
    const board = this.board(id);
    const ids = new Set(plan.taskTransitions.map((t) => t.objectiveId));
    if (plan.contextWrite) ids.add(plan.contextWrite.objectiveId);
    for (const objectiveId of ids) {
      const current = board.get(objectiveId);
      if (!current || current.archived || current.status === "dropped") continue;
      let next = current;
      const context = plan.contextWrite;
      if (
        context?.objectiveId === objectiveId &&
        current.updatedAt === context.expectedPrevUpdatedAt
      ) {
        next = {
          ...next,
          context: context.context,
          contextWritten: context.stamp?.at ?? receivedAt,
          contextCommit: context.stamp?.commit,
        };
      }
      const tasks = current.tasks.map((task) =>
        task.state === "doing" &&
        plan.taskTransitions.some(
          (t) =>
            t.objectiveId === objectiveId &&
            t.taskId === task.id &&
            t.expectedSession === task.session,
        )
          ? { ...task, state: "review" as const }
          : task,
      );
      if (tasks.some((task, i) => task !== current.tasks[i])) next = { ...next, tasks };
      if (next !== current) this.saveObjective(id, next);
    }
  }

  // A reply to a progress report or an older final in a batch is not the Lead's wrap-up.
  finalReportState(w: Workspace, ids: string[]): "none" | "busy" | "ready" {
    const id = w.projectLink!.projectId;
    const latest = this.journal(id)
      .list()
      .reverse()
      .find((row) => row.kind === "final");
    if (!latest || !ids.includes(latest.leadMessageId)) return "none";
    return this.workers(id).every((worker) => worker.isArchived || worker.isQuiet)
      ? "ready"
      : "busy";
  }

  leadAgentsChanged(workspace: Workspace): void {
    const link = workspace.projectLink;
    if (link?.role !== "lead" || !this.store.get(link.projectId)) return;
    void this.drainInbox(link.projectId).catch((error) =>
      console.error(`[projects] ${link.projectId}: report drain failed`, error),
    );
  }

  async drainInbox(id: string, dispatch = true): Promise<void> {
    if (this.host.dispatchAllowed?.() === false) {
      this.deferredInboxes.add(id);
      return;
    }
    this.deferredInboxes.delete(id);
    this.draining++;
    try {
      await this.drainInboxNow(id, dispatch);
    } finally {
      this.draining--;
    }
  }

  private async drainInboxNow(id: string, dispatch: boolean): Promise<void> {
    const recoveries: Promise<void>[] = [];
    let lead: Workspace | undefined;
    await this.commitLock.run(id, () => {
      const project = this.require(id);
      const online = this.leadOnline(project);
      const active = project.status === "active";
      lead = this.leadOf(id);
      const journal = this.journal(id);
      const entries = journal.list();
      if (!entries.length) return;
      if (active && online) {
        for (const report of entries) {
          if (report.kind !== "final" || report.boardState !== "pending" || !report.frozenPlan)
            continue;
          this.applyFrozenReport(id, report.workerWsId, report.frozenPlan, report.createdAt);
          journal.updateBoardState(report.reportId, "applied");
        }
      }
      if (!lead || lead.leadOutage || !this.host.loadWorkspace(lead)) return;
      const target = lead;
      // Flush any dirty Lead history before reconciling in-memory rows against inbox.json.
      this.host.saveWorkspaceNow(target);
      const outcomes = entries.map((report) => {
        const msg = target.findMessage(report.leadMessageId);
        // The row is flushed first on explicit rejection, so this also
        // covers a crash before the journal has recorded that rollback.
        const unsent = msg?.status === "queued" && !msg.dispatchAttempt;
        const state = report.leadDelivery.state;
        if (unsent && state === "dispatching")
          journal.updateLeadDelivery(report.reportId, { state: "enqueued" });
        const reconciliation = reconcileReportDeliveryState(
          unsent && state === "dispatching" ? "enqueued" : state,
          msg?.status ?? null,
        );
        if (reconciliation.journalNeedsUpdate)
          journal.updateLeadDelivery(report.reportId, { state: reconciliation.targetState });
        return { report, msg, reconciliation };
      });
      for (const { report, msg, reconciliation } of outcomes) {
        if (reconciliation.shouldProbeDispatching && msg?.status === "dispatching") {
          // A probe holds the agent queue, not the project lock. Its result re-enters the lock.
          recoveries.push(
            target.recoverDispatchingReport(
              msg,
              (settle) => this.commitLock.run(id, settle),
              active && online,
            ),
          );
        } else if (
          active &&
          online &&
          (reconciliation.shouldEnqueue ||
            (!reconciliation.isTerminal && msg?.status === "queued" && !msg.queuedFor))
        ) {
          const agent = target.resolveAgent();
          if (!agent || (target.isArchived && !this.host.restoreWorkspace(target))) continue;
          const failure = report.kind === "failure";
          const body = failure
            ? (report.payload.text ?? "")
            : `${report.kind === "final" ? "Finished" : "Progress"}:\n\n${report.payload.text}`;
          const header = failure
            ? silentNoticeHeader(report.workerName, report.workerWsId)
            : `[From session "${report.workerName}" (${report.workerWsId})]`;
          target.ensureReportQueued(
            report.leadMessageId,
            agent.info.id,
            buildReportEnvelope(report, `${header}\n\n${body}`),
            {
              workspaceId: report.workerWsId,
              name: report.workerName,
              role: failure ? "panel" : "worker",
            },
            body,
          );
          journal.updateLeadDelivery(report.reportId, { state: "enqueued" });
        }
      }
    });
    await Promise.all(recoveries);
    const target = lead;
    if (
      dispatch &&
      target &&
      this.store.get(id)?.status === "active" &&
      this.leadOnline(this.require(id)) &&
      !target.isArchived &&
      !target.leadOutage &&
      target.messagesLoaded
    ) {
      for (const agentId of target.agents.keys()) target.dequeueNext(agentId);
    }
  }

  private api: PanelApi = {
    projectStatus: (pid) => this.status(pid),
    startSession: (pid, a) => this.commitBoard(pid, () => this.startSession(pid, a)),
    readSession: (pid, sid, count, around, tools, start) =>
      this.readSession(pid, sid, count, around, tools, start),
    searchHistory: (pid, a) => this.searchHistory(pid, a),
    readEntry: (pid, entry, from, count, fromChar) =>
      this.readEntry(pid, entry, from, count, fromChar),
    queryHistory: (pid, query, project) => this.queryHistory(pid, query, project),
    messageSession: (pid, sid, text) => {
      this.assertDispatchAllowed();
      const w = this.managed(pid, sid);
      if (!w.messagesLoaded && !this.host.loadWorkspace(w)) {
        throw new Error(`"${w.name}" cannot be loaded`);
      }
      const blocked = this.leadDispatchBlocker(w);
      if (blocked) throw new Error(blocked.error);
      const delay = this.spaceStart(w);
      const outcome = this.deliver(w, text, ...this.fromLead(pid, text));
      if (delay > 0) {
        return `Sent to "${w.name}"; it goes out in ${Math.ceil(delay / 1000)} s: starts are spaced out.`;
      }
      const note =
        outcome === "queued"
          ? " (queued: it is busy)"
          : outcome === "steered"
            ? " (it is working: the message goes into its running turn)"
            : "";
      return `Sent to "${w.name}"${note}.`;
    },
    stopSession: (pid, sid) => {
      const w = this.managed(pid, sid);
      if (!w.messagesLoaded) this.host.loadWorkspace(w);
      if (this.isUserTakenOver(w)) {
        throw new Error(
          `"${w.name}" was taken over by the user: do not stop it until the user finishes with it`,
        );
      }
      this.dropQueuedFromLead(w);
      this.markAnswered(w);
      w.abortAll("lead");
      this.host.persistWorkspace(w);
      return `Stopped "${w.name}".`;
    },
    archiveSession: (pid, sid) => {
      const w = this.managed(pid, sid);
      if (w.isArchived) return `"${w.name}" is already archived.`;
      if (!this.host.archiveWorkspace(w)) {
        throw new Error(`"${w.name}" is still working or has queued messages; stop it first`);
      }
      return `Archived "${w.name}".`;
    },
    listObjectives: (pid, filter) => {
      this.require(pid);
      return this.listObjectives(pid, filter);
    },
    readObjective: (pid, id) => {
      this.require(pid);
      return this.readObjective(pid, id);
    },
    currentTask: (wid, oid) => this.currentTask(wid, oid),
    writeObjective: (pid, patch, sid) =>
      this.commitBoard(pid, () => this.writeObjective(pid, patch, sid)),
    addItems: (pid, oid, tasks, decisions) =>
      this.commitBoard(pid, () => {
        for (const t of tasks) checkTask(t);
        for (const d of decisions)
          checkLength("A question", d, LIMITS.decision, "the question alone");
        const o = this.objective(pid, oid);
        if (o.status === "dropped") throw new Error(`${o.id} is dropped: make it active first`);
        const next = (prefix: string, ids: string[]) => {
          const n = Math.max(0, ...ids.map((x) => Number(x.slice(1)) || 0));
          return (i: number) => `${prefix}${n + i + 1}`;
        };
        const taskId = next(
          "t",
          o.tasks.map((t) => t.id),
        );
        const decisionId = next(
          "d",
          o.decisions.map((d) => d.id),
        );
        const added = {
          tasks: tasks.map((text, i) => ({ id: taskId(i), text, state: "todo" as const })),
          decisions: decisions.map((question, i) => ({ id: decisionId(i), question })),
        };
        this.saveObjective(pid, {
          ...o,
          tasks: [...o.tasks, ...added.tasks],
          decisions: [...o.decisions, ...added.decisions],
        });
        const ids = [...added.tasks, ...added.decisions].map((x) => x.id);
        return ids.length ? `Added ${ids.join(", ")} to ${o.id}.` : "Nothing to add.";
      }),
    updateItem: (pid, oid, itemId, patch, sid) =>
      this.commitBoard(pid, () => {
        return this.updateItem(pid, oid, itemId, patch, sid);
      }),
    // What depended on it no longer does: done or a mistake, it is not
    // waited for.
    // What it said goes back in the result, so the call keeps it findable in
    // the history.
    deleteObjective: (pid, id) =>
      this.commitBoard(pid, () => {
        const o = this.objective(pid, id);
        const said = this.describeObjective(pid, o.id, () => "", false);
        this.board(pid).remove(o.id);
        const dependents = this.rewrite(
          pid,
          (x) => x.dependsOn.includes(o.id),
          (x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== o.id) }),
        );
        this.changed(pid);
        let links = 0;
        try {
          this.changingIssues(pid, (b) => String((links = b.unlink(o.id))));
        } catch (e) {
          console.error(`[projects] issues still link ${o.id}`, e);
        }
        return (
          [
            `Deleted ${o.id}.`,
            ...(dependents.length
              ? [`Taken out of the depends_on of ${dependents.join(", ")}.`]
              : []),
            ...(links ? [`Taken out of ${links} issue link${links === 1 ? "" : "s"}.`] : []),
          ].join(" ") + `\n\n${said}`
        );
      }),
    listIssues: (pid, filter) => this.issueBoard(pid).list(filter),
    readIssue: async (pid, t) => {
      // The commits of the issues the read shows, counted first.
      const modules = this.issues(pid)
        .list()
        .filter((m): m is IssueModule => !("error" in m));
      const shown = t.id
        ? [locate(modules).byId.get(t.id)?.issue]
        : modules
            .filter((m) => m.id === t.module)
            .flatMap((m) =>
              t.group === undefined
                ? [...m.issues, ...m.groups.flatMap((g) => g.issues)]
                : (m.groups.find((g) => g.id === t.group)?.issues ?? []),
            );
      const age = await this.ages(
        pid,
        shown.map((x) => x?.commit),
      );
      return this.issueBoard(pid).read(t.id, t.module, t.group, (x) => age(x.written, x.commit));
    },
    writeIssues: (pid, patches, sid) =>
      this.commitBoard(pid, async () => {
        const stamp = await this.stamp(pid, sid);
        return this.changingIssues(pid, (b) => b.write(patches, stamp));
      }),
    writeIssueGroup: (pid, patch) =>
      this.commitBoard(pid, () => this.changingIssues(pid, (b) => b.writeGroup(patch))),
    closeIssues: (pid, ids, fixedBy) =>
      this.commitBoard(pid, () => this.changingIssues(pid, (b) => b.close(ids, fixedBy))),
    listProjects: (pid) => {
      this.require(pid);
      return this.listProjects(pid);
    },
    messageProject: (pid, target, text) => this.messageProject(pid, target, text),
    listNotes: (id) => {
      this.require(id);
      return new ProjectNotesStore(this.store.notesDir(id)).listNotes();
    },
    readNote: (id, slug) => {
      this.require(id);
      return new ProjectNotesStore(this.store.notesDir(id)).readNote(slug);
    },
    writeNote: (id, slug, content, expected) =>
      this.commitBoard(id, () =>
        new ProjectNotesStore(this.store.notesDir(id)).writeNote(slug, content, expected),
      ),
    workerReport: (wsId, text, final, finish, callId) =>
      this.workerReport(wsId, text, final, finish, callId),
    checkReporting: (wsId) => this.checkReporting(this.host.workspace(wsId)),
  };
}

// How the workspace marks a turn cut off (a stop, a restart).
const INTERRUPTED = "*\\[interrupted\\]*";

// A worker the lead started that stopped on the user: an agent's last turn, on
// the task or on what the user wrote since, ended without calling finish_task
// and was not superseded by a later successful finish_task in the workspace.
// Not what it answered the lead later, nor a turn that failed or was cut off.
export function awaitsUser(w: Workspace): boolean {
  if (w.hasPendingDialogs) return true;
  const link = w.projectLink;
  if (link?.role !== "worker" || link.unreported) return false;
  if (w.isArchived || !w.messagesLoaded || !w.isQuiet) return false;
  const messages = w.getMessages();
  const task = taskOf(messages);
  if (!task) return false;
  const lastFinish = lastFinishIndex(messages);
  return w.lastTurns().some(({ input, replies, stopped, finished }) => {
    const from = asked(messages, input);
    if (from.from && from.id !== task.id) return false;
    const last = replies[replies.length - 1];
    if (stopped || finished || last?.status !== "done" || last.content.endsWith(INTERRUPTED))
      return false;
    if (lastFinish >= 0 && messages.indexOf(last) <= lastFinish) return false;
    return !replies.some(finishedTask);
  });
}

function lastFinishIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (finishedTask(messages[i])) return i;
  }
  return -1;
}

function lastDirectUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "user" && !m.from && m.status !== "queued" && !messages[i + 1]?.localCommand) {
      return i;
    }
  }
  return -1;
}

// A refused finish_task (a context too long, say) reported nothing.
function finishedTask(m: Message): boolean {
  return (
    m.kind === "agent" &&
    !!m.events?.some(
      (e) =>
        e.kind === "tool_use" && e.toolName === "mcp__panel__finish_task" && !e.toolResultIsError,
    )
  );
}

// The task a worker was started with: its first message, from the lead (a
// session the user started has none).
function taskOf(messages: Message[]): Message | undefined {
  const first = messages.find((m) => m.kind !== "system");
  return first?.from?.role === "lead" ? first : undefined;
}

// What a message to a worker answers to. The panel's word to carry on stands
// for the message whose turn it carries on (the last one from another
// session: what the user typed meanwhile was a command the panel answered,
// or for another agent); the lead's word right after a turn that failed or
// was cut off (a retry), for the message that turn was on.
function asked(messages: Message[], input: Message): Message {
  let m = input;
  let i = messages.indexOf(input);
  while (i > 0) {
    let j = i - 1;
    if (m.from?.role === "panel") {
      while (j >= 0 && !(messages[j].kind === "user" && messages[j].from)) j--;
    } else if (m.from?.role === "lead") {
      while (j >= 0 && messages[j].kind !== "user") j--;
      const last = messages
        .slice(j + 1, i)
        .filter((x) => x.kind === "agent")
        .pop();
      const cut = last?.status === "error" || !!last?.content.endsWith(INTERRUPTED);
      if (!cut || !messages[j]?.from) break;
    } else {
      break;
    }
    if (j < 0) break;
    m = messages[j];
    i = j;
  }
  return m;
}

// A message the project's current lead sent (not one from before the project
// was deleted and the worker adopted again).
function fromLead(m: { from?: MessageOrigin }, lead: Workspace | undefined): boolean {
  return m.from?.role === "lead" && !!lead && m.from.workspaceId === lead.id;
}

function taskLine(t: Task): string {
  return `- ${t.id} [${t.state}] ${t.text}`;
}

// An objective as an isolated worker sees it: what it is for, and the
// worker's own tasks in it.
function ownTasks(o: Objective, sessionId: string): string {
  const tasks = o.tasks.filter((t) => t.session === sessionId);
  return [
    `${o.id} — ${o.title}`,
    ...(o.status !== "active" ? [`status: ${o.status}${o.reason ? ` — ${o.reason}` : ""}`] : []),
    ...(o.goal ? [`goal: ${o.goal}`] : []),
    "",
    "your tasks:",
    ...(tasks.length ? tasks.map(taskLine) : ["(none)"]),
  ].join("\n");
}

function canonicalPath(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function sameRoot(a: string | null, b: string): boolean {
  return a !== null && canonicalPath(a) === canonicalPath(b);
}

function sessionState(w: Workspace): "archived" | "working" | "waiting to start" | "idle" {
  if (w.isArchived) return "archived";
  if ([...w.agents.values()].some((a) => a.session.isRunning)) return "working";
  return w.messages.some(
    (m) => m.status === "queued" || m.status === "starting" || m.status === "dispatching",
  )
    ? "waiting to start"
    : "idle";
}

// Files under a folder and their bytes; dot files (an editor's) left out.
async function folderSize(dir: string): Promise<{ files: number; bytes: number }> {
  const out = { files: 0, bytes: 0 };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const at = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await folderSize(at);
      out.files += sub.files;
      out.bytes += sub.bytes;
    } else if (e.isFile()) {
      try {
        out.bytes += (await fs.promises.stat(at)).size;
        out.files++;
      } catch {
        // Gone since it was listed.
      }
    }
  }
  return out;
}

function silentNoticeHeader(name: string, id: string): string {
  return `[From the panel, about session "${name}" (${id}). Act on it if there is something to do; no reply to the session is needed.]`;
}

function replyText(reply: Message): string {
  const text = reply.content;
  return (text.endsWith(INTERRUPTED) ? text.slice(0, -INTERRUPTED.length) : text).trim();
}

function lastReplyContext(text?: string): string {
  return text ? `Its last reply:\n\n${text.length > 1500 ? `…${text.slice(-1500)}` : text}` : "";
}

function silentTurnNotice(input: Message, how: string, text?: string): string {
  return [
    `No report on your message "${oneLine(input.content, 80)}" (${how}).`,
    lastReplyContext(text),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function failedTurnNotice(input: Message, reply: Message): string {
  const error = reply.events
    ?.filter((e) => e.kind === "error")
    .at(-1)
    ?.content.trim();
  const tool = reply.events?.filter((e) => e.kind === "tool_use" && e.toolName).at(-1);
  const toolResult = tool?.toolResult?.trim();
  const toolContext = tool?.toolName
    ? `Last tool: ${oneLine(tool.toolName, 80)}${tool.toolResultIsError ? " (reported an error)" : ""}${toolResult ? ` — ${oneLine(toolResult, 500)}` : tool.toolResult === undefined ? " (outcome unknown)" : " (returned)"}`
    : "";
  return [
    `Worker turn failed on your message "${oneLine(input.content, 80)}".`,
    error ? `Error: ${oneLine(error, 500)}` : "",
    lastReplyContext(replyText(reply)),
    toolContext,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Words, and "quoted phrases" kept whole.
function queryTerms(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

// What an entry of the history is, on one line.
function entryLabel(e: Pick<EntryInfo, "kind" | "role" | "tool" | "depth">): string {
  const what =
    e.kind === "said" ? `said by ${e.role ?? "?"}` : e.tool ? `${e.kind} ${e.tool}` : e.kind;
  return e.depth > 0 ? `${what}, in a subagent` : what;
}

function entryHeader(e: EntryInfo, name: string | undefined): string {
  return `#${e.entry} · ${e.session} "${name ?? "?"}" · ${new Date(e.ts).toISOString()} · ${entryLabel(e)} · message ${e.message}`;
}
