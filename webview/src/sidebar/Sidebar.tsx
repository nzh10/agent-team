import { telemetryTarget } from "../telemetryEvents";
import type { QuotaState } from "../../../shared/quota";
import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Workspace, Project, SystemStatus, SearchHit } from "../state/useServer";
import {
  groupWorkspaces,
  isGroupExpanded,
  archivedWorkspaces,
  archivedFolderLabel,
  canFoldWorker,
  initialIdleWorkers,
  workspaceStatus,
  type GroupStatus,
  type WorkspaceGroup,
} from "./groups";
import { Icon } from "../panels/Icon";
import { DEFAULT_BRANCH } from "../panels/scope";
import { formatBytes, formatRelative } from "../format";
import { RoleTag } from "../workspace/RoleTag";
import { NameInput } from "../project/NameInput";
import { ConfirmDialog } from "../workspace/dialogs";
import { QuotaPanel } from "./QuotaPanel";
import { formatShortDateTime, quotaTone } from "./quota";
import { attentionBreakdown, sessionAttention, summarizeAttention } from "./attention";
import { usePush } from "./usePush";
import { StreamSilence } from "./StreamSilence";
import { UsageDashboard } from "../usage/UsageDashboard";

interface ThemeController {
  get: () => "light" | "dark";
  subscribe: (listener: () => void) => () => void;
  toggle: () => void;
}

declare global {
  interface Window {
    // Installed synchronously by index.html, not by isolated component mounts.
    yaatTheme?: ThemeController;
  }
}

function ThemeToggle({ controller }: { controller: ThemeController }) {
  const dark = useSyncExternalStore(controller.subscribe, controller.get) === "dark";
  return (
    <button
      type="button"
      aria-label="Dark theme"
      aria-pressed={dark}
      title="Dark theme"
      onClick={controller.toggle}
    >
      <Icon name={dark ? "moon" : "sun"} />
    </button>
  );
}

function gitTitle(git: { dirty: number; ahead: number; behind: number }): string {
  const parts: string[] = [];
  if (git.dirty) parts.push(`${git.dirty} changed file${git.dirty === 1 ? "" : "s"}`);
  if (git.ahead) parts.push(`${git.ahead} ahead`);
  if (git.behind) parts.push(`${git.behind} behind`);
  return parts.length ? parts.join(", ") : "clean";
}

function SessionWait({ workspace }: { workspace: Workspace }) {
  const retry = workspace.agents.find((a) => a.retryLabel)?.retryLabel;
  if (retry) {
    const attempt = retry.match(/\bRetrying (?:in \d+s )?\((\d+)\b/)?.[1];
    return (
      <span className="session-silence" title={retry}>
        <span className="clip">{attempt ? `Retrying (attempt ${attempt})` : "Retrying"}</span>
      </span>
    );
  }
  return <StreamSilence workspace={workspace} />;
}

function statusDotClass(state: GroupStatus): string {
  if (state === "working") return "running";
  if (state === "waiting") return "waiting";
  if (state === "sleeping") return "waiting sleeping";
  return "idle";
}

const STATUS_COLORS = { danger: "var(--error)", warn: "var(--warning)", normal: "var(--accent)" };

export const FOLDED_IDLE_STORAGE_KEY = "sidebarFoldedIdle";

function readFoldedWorkerIds(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY) ?? "[]");
    return new Set(
      Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeFoldedWorkerIds(ids: ReadonlySet<string>): void {
  try {
    if (ids.size) localStorage.setItem(FOLDED_IDLE_STORAGE_KEY, JSON.stringify([...ids]));
    else localStorage.removeItem(FOLDED_IDLE_STORAGE_KEY);
  } catch {
    // Private mode: the choice lasts for this mount.
  }
}

function StatusBar({ label, pct, extra }: { label: string; pct: number; extra?: string }) {
  return (
    <div className="status-item">
      <span className="status-label">{label}</span>
      <span className="status-value">
        <span
          className="status-bar"
          role="progressbar"
          aria-label={label}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className="status-bar-fill"
            style={{ width: `${pct}%`, background: STATUS_COLORS[quotaTone(pct)] }}
          />
        </span>
        <span className="status-pct">{extra ?? `${pct}%`}</span>
      </span>
    </div>
  );
}

export function SystemStatusPanel({ status }: { status: SystemStatus }) {
  const memPct = Math.round((status.memUsed / status.memTotal) * 100);

  return (
    <div className="system-status-panel">
      <div className="system-status-grid">
        <StatusBar label="CPU" pct={status.cpuUsage} />
        <StatusBar
          label="Mem"
          pct={memPct}
          extra={`${formatBytes(status.memUsed)} / ${formatBytes(status.memTotal)}`}
        />
      </div>
    </div>
  );
}

export interface SidebarProps {
  workspaces: Workspace[];
  projects?: Project[];
  activeWsId: string | null;
  connected: boolean;
  // True after an authoritative init, including one with zero workspaces.
  snapshotReady?: boolean;
  // Mobile keeps the drawer mounted while it is translated off screen.
  sidebarOpen?: boolean;
  groupOverrides: Record<string, boolean>;
  searchQuery: string;
  searchHits: SearchHit[] | null;
  systemStatus: SystemStatus | null;
  quota?: QuotaState | null;
  onRefreshQuota?: (force?: boolean, providers?: readonly string[]) => void;
  now?: number;
  onSelect: (wsId: string) => void;
  onDelete: (wsId: string) => void;
  // The × on a project's lead deletes the project (after confirming).
  onDeleteProject?: (projectId: string) => void;
  onToggleGroup: (key: string, expanded: boolean) => void;
  onSearchChange: (q: string) => void;
  onJump: (wsId: string, msgId: string) => void;
  onCreate: () => void;
  onCreateProject?: () => void;
  // Create a workspace in a group's folder (the "+" on the group header).
  onCreateIn: (cwd: string) => void;
  onReplayDemo: () => void;
  // Capture synchronously, then save a layout snapshot on the server.
  onDebugSnapshot: () => void | Promise<unknown>;
  // One project's archived sessions, or (null) those in no project.
  onPurgeArchived: (projectId: string | null) => void;
  onArchiveWorkspace?: (wsId: string) => void;
  onArchiveProject?: (projectId: string) => void;
  onRenameProject?: (projectId: string, name: string) => void;
  onRestoreProject?: (projectId: string) => void;
}

export const Sidebar = memo(function Sidebar(p: SidebarProps) {
  const push = usePush(p.connected);
  const now = p.now ?? Date.now();
  const snapshotReady = p.snapshotReady ?? p.workspaces.length > 0;
  const debug = new URLSearchParams(window.location.search).get("debug") === "1";
  const [debugOpen, setDebugOpen] = useState(debug);
  const [health, setHealth] = useState<"unknown" | "healthy" | "unhealthy">("unknown");
  const [snapshotStatus, setSnapshotStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [snapshotStatusHidden, setSnapshotStatusHidden] = useState(false);
  const snapshotUpload = useRef<{ showResult: boolean } | null>(null);
  const snapshotStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debugId = useId();
  const debugTrigger = useRef<HTMLButtonElement>(null);
  const debugStrip = useRef<HTMLDivElement>(null);
  const sidebarOpen = p.sidebarOpen ?? true;
  const previousSidebarOpen = useRef(sidebarOpen);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const deleting = p.workspaces.find((ws) => ws.id === deleteId);
  useEffect(() => {
    return () => {
      if (snapshotStatusTimer.current) clearTimeout(snapshotStatusTimer.current);
    };
  }, []);
  useEffect(() => {
    setHealth("unknown");
    if (!p.connected) return;
    let request: AbortController | undefined;
    const check = async () => {
      request?.abort();
      const controller = (request = new AbortController());
      let health: "healthy" | "unhealthy" = "unhealthy";
      try {
        const response = await fetch("api/diagnostics", { signal: controller.signal });
        const report: unknown = response.ok ? await response.json() : null;
        health =
          !!report &&
          typeof report === "object" &&
          "issues" in report &&
          Array.isArray(report.issues) &&
          report.issues.every(
            (issue: unknown) =>
              !!issue &&
              typeof issue === "object" &&
              "severity" in issue &&
              issue.severity === "info",
          )
            ? "healthy"
            : "unhealthy";
      } catch {
        // An unavailable report must not hide the diagnostics attention indicator.
      }
      if (!controller.signal.aborted) setHealth(health);
    };
    void check();
    // Model/account readiness can change without reconnecting the socket.
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      clearInterval(timer);
      request?.abort();
    };
  }, [p.connected]);
  useEffect(() => {
    if (previousSidebarOpen.current && !sidebarOpen) setDebugOpen(false);
    previousSidebarOpen.current = sidebarOpen;
  }, [sidebarOpen]);
  useEffect(() => {
    if (!debugOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const strip = debugStrip.current;
      if (!strip || getComputedStyle(strip).display === "none") return;
      setDebugOpen(false);
      debugTrigger.current?.focus();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
    };
  }, [debugOpen]);

  const clearSnapshotTimer = () => {
    if (snapshotStatusTimer.current) {
      clearTimeout(snapshotStatusTimer.current);
      snapshotStatusTimer.current = null;
    }
  };
  const dismissSnapshotStatus = () => {
    clearSnapshotTimer();
    if (snapshotUpload.current) {
      // A push action takes over the status, not the in-flight upload guard.
      snapshotUpload.current.showResult = false;
      setSnapshotStatusHidden(true);
    } else setSnapshotStatus("idle");
  };
  const saveSnapshot = () => {
    if (snapshotUpload.current) return;
    clearSnapshotTimer();
    push.clearStatus();
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(p.onDebugSnapshot());
    } catch (err) {
      pending = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const upload = (snapshotUpload.current = { showResult: true });
    setSnapshotStatusHidden(false);
    setSnapshotStatus("saving");
    const settle = (status: "saved" | "error") => {
      if (snapshotUpload.current !== upload) return;
      snapshotUpload.current = null;
      if (!upload.showResult) {
        setSnapshotStatus("idle");
        return;
      }
      setSnapshotStatus(status);
      snapshotStatusTimer.current = setTimeout(
        () => {
          snapshotStatusTimer.current = null;
          setSnapshotStatus("idle");
        },
        status === "error" ? 5000 : 3000,
      );
    };
    // Rejection must not close the strip; inline status and App toast surface it.
    void pending.then(
      () => settle("saved"),
      () => settle("error"),
    );
  };
  const toggleDebug = () => setDebugOpen((v) => !v);
  const diagnosticsState = !p.connected ? "offline" : health === "unhealthy" ? "unhealthy" : null;
  const triggerAbnormal = diagnosticsState !== null && !debugOpen;
  const triggerLabel = triggerAbnormal
    ? `Debug tools (service diagnostics ${diagnosticsState})`
    : "Debug tools";
  const diagnosticsLabel = diagnosticsState
    ? `Service diagnostics (${diagnosticsState})`
    : "Service diagnostics";
  const snapshotBusy = snapshotStatus === "saving";
  const snapshotStatusText =
    snapshotStatus === "saving"
      ? "Saving snapshot…"
      : snapshotStatus === "saved"
        ? "Snapshot saved"
        : snapshotStatus === "error"
          ? "Snapshot failed"
          : null;
  const known = new Set((p.projects ?? []).map((pr) => pr.id));
  // A lead takes its project with it; one whose project is unknown (its
  // project.json unreadable) is just a workspace.
  const deleteButton = (ws: Workspace) => {
    const link = ws.projectLink;
    const owner = link && p.projects?.find((project) => project.id === link.projectId);
    if (owner?.status === "sealed") return null;
    const project = link?.role === "lead" && known.has(link.projectId) ? link.projectId : null;
    return (
      <button
        type="button"
        className="task-delete"
        title={project ? "Delete project" : "Delete session"}
        onClick={(e) => {
          e.stopPropagation();
          if (project && p.onDeleteProject) p.onDeleteProject(project);
          else setDeleteId(ws.id);
        }}
      >
        <Icon name="close" />
      </button>
    );
  };
  const groups = useMemo(
    () => groupWorkspaces(p.workspaces, p.projects),
    [p.workspaces, p.projects],
  );
  const manualFolded = useRef<ReadonlySet<string> | null>(null);
  if (manualFolded.current === null) manualFolded.current = readFoldedWorkerIds();
  const [foldedIdle, setFoldedIdle] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...manualFolded.current!,
        ...(snapshotReady ? groups.flatMap((g) => initialIdleWorkers(g, p.activeWsId, now)) : []),
      ]),
  );
  const [showIdle, setShowIdle] = useState<ReadonlySet<string>>(new Set());
  const bootstrapped = useRef(snapshotReady && groups.length > 0);
  const expandedDefaults = useRef(new Map<string, boolean>());
  useLayoutEffect(() => {
    const bootstrap = snapshotReady && !bootstrapped.current && groups.length > 0;
    if (bootstrap) bootstrapped.current = true;
    // Only an authoritative init (including an empty one) may prune storage.
    if (snapshotReady) {
      const eligible = new Set(
        groups
          .filter((g) => g.project && g.project.archivedAt == null)
          .flatMap((g) => g.workspaces)
          .filter((w) => canFoldWorker(w, p.activeWsId))
          .map((w) => w.id),
      );
      const automatic = bootstrap
        ? groups.flatMap((g) => initialIdleWorkers(g, p.activeWsId, now))
        : [];
      // Reconcile before every read and write so another tab's fold is not
      // replaced by this mount's cached set.
      const durable = readFoldedWorkerIds();
      manualFolded.current = durable;
      setFoldedIdle((prev) => {
        const next = new Set([...prev, ...durable, ...automatic].filter((id) => eligible.has(id)));
        return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
      });
      const next = new Set([...durable].filter((id) => eligible.has(id)));
      if (next.size !== durable.size) {
        manualFolded.current = next;
        writeFoldedWorkerIds(next);
      }
    }
    for (const g of groups) {
      if (!expandedDefaults.current.has(g.key) || g.workspaces.some((w) => w.id === p.activeWsId)) {
        expandedDefaults.current.set(
          g.key,
          isGroupExpanded(
            g,
            {},
            now,
            g.workspaces.some((w) => w.id === p.activeWsId),
          ),
        );
      }
    }
  }, [groups, p.workspaces, p.activeWsId, now, snapshotReady]);
  const archived = archivedWorkspaces(p.workspaces, p.projects);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const activeIsArchived = archived.some((w) => w.id === p.activeWsId);
  const showArchived = archivedOpen || activeIsArchived;
  const live = groups.filter((g) => !g.project?.archivedAt);
  const shelved = groups.filter((g) => g.project?.archivedAt);
  const [shelfOpen, setShelfOpen] = useState(false);
  const showShelf =
    shelfOpen ||
    shelved.some((g) => [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId));
  // The project whose name is being edited.
  const [renaming, setRenaming] = useState<string | null>(null);
  // Groups whose archived sessions are unfolded.
  const [openArchives, setOpenArchives] = useState<ReadonlySet<string>>(new Set());
  const toggleArchive = (key: string) => {
    setOpenArchives((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const archivedItem = (ws: Workspace, folder: string | null) => (
    <div
      key={ws.id}
      className={`task-item task-item-archived ${ws.id === p.activeWsId ? "active" : ""}`}
      onClick={() => p.onSelect(ws.id)}
      title={ws.cwd}
    >
      <div className="task-status idle" />
      <div className="task-info">
        <div className="task-name">
          <span className="task-name-text">
            <span className="clip">{ws.name}</span>
          </span>
          <span className="task-time">{formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}</span>
        </div>
        {folder && <div className="task-meta">{folder}</div>}
      </div>
      <span className="task-hover">
        <span className="task-time">{formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}</span>
        {deleteButton(ws)}
      </span>
    </div>
  );

  // A group's archived sessions, folded until asked for (or one is open).
  const archiveList = (g: WorkspaceGroup, list: Workspace[]) => {
    const open = openArchives.has(g.key) || list.some((w) => w.id === p.activeWsId);
    return (
      <>
        <div
          className="ws-archive-toggle"
          role="button"
          aria-expanded={open}
          {...telemetryTarget("sidebar.archive_toggle")}
          onClick={() => toggleArchive(g.key)}
        >
          <span className="events-toggle" aria-hidden="true">
            ▸
          </span>
          <span>Archived</span>
          {open && <span className="ws-group-count">{list.length}</span>}
          {open && g.project && g.project.status !== "sealed" && (
            <button
              className="ws-archived-purge"
              title={`Delete the archived sessions of ${g.label}`}
              onClick={(e) => {
                e.stopPropagation();
                p.onPurgeArchived(g.project!.id);
              }}
            >
              Clear
            </button>
          )}
        </div>
        {open && list.map((w) => archivedItem(w, archivedFolderLabel(w, g.project)))}
      </>
    );
  };

  // A folder's group or a project's (its row is its lead), with its archived
  // sessions folded under it; `shelf` for an archived project's.
  const renderGroup = (g: WorkspaceGroup, shelf = false) => {
    const current = [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId);
    const expanded =
      p.groupOverrides[g.key] ??
      (current || (expandedDefaults.current.get(g.key) ?? isGroupExpanded(g, {}, now)));
    const toggle = () => p.onToggleGroup(g.key, !expanded);
    // A project's own row is its lead, archived with it or not: it opens the
    // lead, which is not listed again under it; the arrow folds the sessions
    // it started.
    const lead = g.project
      ? [...g.workspaces, ...g.archived].find((w) => w.projectLink?.role === "lead")
      : undefined;
    const items = g.workspaces.filter((w) => w !== lead);
    const past = g.archived.filter((w) => w !== lead);
    const attention = summarizeAttention(g.workspaces, null, g.project ? [g.project] : []);
    const summary = attentionBreakdown(attention);
    const idle =
      !shelf && g.project
        ? items.filter((w) => foldedIdle.has(w.id) && canFoldWorker(w, p.activeWsId))
        : [];
    const visible = items.filter((w) => !idle.includes(w));
    const foldable =
      !shelf && g.project ? visible.filter((w) => canFoldWorker(w, p.activeWsId)) : [];
    const idleOpen = showIdle.has(g.key);
    const toggleIdle = () =>
      setShowIdle((prev) => {
        const next = new Set(prev);
        if (!next.delete(g.key)) next.add(g.key);
        return next;
      });
    const foldIdle = () => {
      const manual = new Set([
        ...readFoldedWorkerIds(),
        ...manualFolded.current!,
        ...foldable.map((w) => w.id),
      ]);
      manualFolded.current = manual;
      writeFoldedWorkerIds(manual);
      setFoldedIdle((prev) => new Set([...prev, ...foldable.map((w) => w.id)]));
      setShowIdle((prev) => {
        const next = new Set(prev);
        next.delete(g.key);
        return next;
      });
    };
    const hasContent = items.length > 0 || past.length > 0;
    // A project of archived sessions only (its lead archived too) has no live one.
    const git = (g.workspaces[0] ?? g.archived[0])?.git;
    const isRenaming = Boolean(g.project && renaming === g.project.id);
    const canAdd = !g.project || Boolean(g.project.root && g.project.status !== "sealed");
    const canArchiveProject =
      !shelf && Boolean(g.project && g.project.status !== "sealed" && p.onArchiveProject);
    const canRestoreProject =
      shelf && Boolean(g.project && g.project.status !== "sealed" && p.onRestoreProject);
    const leadDelete = lead ? deleteButton(lead) : null;
    const hasActions =
      !isRenaming && (canAdd || canArchiveProject || canRestoreProject || Boolean(leadDelete));
    const renderWorkerItem = (ws: Workspace) => {
      const state = workspaceStatus(ws);
      const busy = state === "working" || state === "waiting";
      const cue = sessionAttention(ws);
      const owner = ws.projectLink
        ? p.projects?.find((project) => project.id === ws.projectLink!.projectId)
        : undefined;
      const canArchive =
        Boolean(p.onArchiveWorkspace) &&
        ws.archivedAt == null &&
        ws.projectLink?.role !== "lead" &&
        owner?.status !== "sealed" &&
        !busy &&
        !ws.queued;
      return (
        <div
          key={ws.id}
          className={`task-item ${ws.id === p.activeWsId ? "active" : ""}${busy ? " task-item-active" : ""}`}
          onClick={() => p.onSelect(ws.id)}
        >
          <div className={`task-status ${statusDotClass(state)}`} aria-hidden="true" />
          <div className="task-info">
            <div className="task-name">
              <span className="task-name-text">
                <RoleTag link={ws.projectLink} />
                <span className="clip" title={ws.name}>
                  {ws.name}
                </span>
              </span>
              {cue ? (
                <span
                  className={`session-attention attention-${cue}${cue === "yourTurn" ? " awaits-tag" : ""}`}
                >
                  <span className="clip">
                    {cue === "yourTurn"
                      ? "Your turn"
                      : cue === "failed"
                        ? "Failed"
                        : "Unread result"}
                  </span>
                </span>
              ) : p.connected ? (
                <SessionWait workspace={ws} />
              ) : null}
            </div>
          </div>
          <span className="task-hover">
            <span className="task-time">
              {formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}
            </span>
            {canArchive && (
              <button
                type="button"
                className="task-archive"
                title="Archive session"
                aria-label="Archive session"
                onClick={(e) => {
                  e.stopPropagation();
                  p.onArchiveWorkspace!(ws.id);
                }}
              >
                <Icon name="archive" />
              </button>
            )}
            {deleteButton(ws)}
          </span>
        </div>
      );
    };
    return (
      <div key={g.key} className="ws-group">
        <div
          className={`ws-group-header${g.project ? " ws-group-project" : ""}${lead && lead.id === p.activeWsId ? " active" : ""}${current ? " current" : ""}`}
          aria-expanded={lead ? undefined : expanded}
          title={
            lead
              ? `Open the lead of ${g.label}`
              : g.project
                ? (g.project.root ?? "No repository")
                : g.key
          }
          onClick={() => (lead ? p.onSelect(lead.id) : toggle())}
        >
          {lead && !hasContent ? (
            // Nothing to fold: an empty slot keeps the name in line.
            <span className="events-toggle" />
          ) : lead ? (
            <button
              type="button"
              className="events-toggle ws-group-toggle"
              aria-label={expanded ? `Fold ${g.label}` : `Unfold ${g.label}`}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
            >
              <span className="events-toggle" aria-hidden="true">
                ▸
              </span>
            </button>
          ) : (
            <span className="events-toggle" aria-hidden="true">
              ▸
            </span>
          )}
          {isRenaming ? (
            <NameInput
              name={g.label}
              label="Project name"
              className="ws-group-rename"
              onDone={(name) => {
                setRenaming(null);
                if (name) p.onRenameProject?.(g.project!.id, name);
              }}
            />
          ) : (
            <span
              className="ws-group-label"
              {...(g.project &&
                g.project.status !== "sealed" &&
                p.onRenameProject && {
                  title: "Double-click to rename",
                  onDoubleClick: (e: React.MouseEvent) => {
                    e.stopPropagation();
                    setRenaming(g.project!.id);
                  },
                })}
            >
              {g.label}
            </span>
          )}
          {g.project?.status === "sealed" && (
            <span className="ws-group-sealed" title={g.project.sealedReason ?? undefined}>
              Sealed
            </span>
          )}
          {git?.branch && !DEFAULT_BRANCH.test(git.branch) && (
            <span className="ws-group-branch" title={gitTitle(git)}>
              {git.branch}
            </span>
          )}
          {!isRenaming && (
            <span className="ws-group-status">
              {g.status !== "idle" && (
                <span className={`task-status ${statusDotClass(g.status)}`} aria-hidden="true" />
              )}
              {g.project && summary ? (
                <span
                  className={`ws-group-attention attention-${attention.yourTurn ? "yourTurn" : attention.failed ? "failed" : "unread"}`}
                  role="status"
                  aria-label={`${g.label}: ${summary}`}
                  title={summary}
                >
                  <span className="clip">{summary}</span>
                </span>
              ) : lead && p.connected ? (
                <SessionWait workspace={lead} />
              ) : null}
              {!expanded && !summary && items.length > 0 && (
                <span className="ws-group-count">{items.length}</span>
              )}
            </span>
          )}
          {hasActions && (
            <span className="ws-group-actions">
              {canAdd && (
                <button
                  type="button"
                  className="ws-group-add"
                  title={
                    g.project ? `New session in ${g.project.name}` : `New workspace in ${g.key}`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onCreateIn(g.project?.root ?? g.key);
                  }}
                >
                  <Icon name="plus" />
                </button>
              )}
              {canArchiveProject && (
                <button
                  type="button"
                  className="ws-group-pill ws-group-archive"
                  title={`Archive ${g.label} with its sessions`}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onArchiveProject!(g.project!.id);
                  }}
                >
                  Archive
                </button>
              )}
              {canRestoreProject && (
                <button
                  type="button"
                  className="ws-group-pill"
                  title={`Bring ${g.label} back among the projects`}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onRestoreProject!(g.project!.id);
                  }}
                >
                  Restore
                </button>
              )}
              {leadDelete}
            </span>
          )}
        </div>
        {expanded && hasContent && (
          <div className="ws-group-items">
            {visible.map(renderWorkerItem)}
            {idle.length > 0 ? (
              <>
                <div className="ws-idle-row">
                  <button
                    type="button"
                    className="ws-idle-toggle"
                    aria-expanded={idleOpen}
                    aria-label={`${idleOpen ? "Hide" : "Show"} ${idle.length} folded session${idle.length === 1 ? "" : "s"}`}
                    title={`${idleOpen ? "Hide" : "Show"} ${idle.length} folded session${idle.length === 1 ? "" : "s"}`}
                    onClick={toggleIdle}
                  >
                    <span className="events-toggle" aria-hidden="true">
                      ▸
                    </span>
                    <span className="ws-idle-label">... ({idle.length})</span>
                  </button>
                  {foldable.length > 0 && (
                    <button
                      type="button"
                      className="ws-idle-fold"
                      title={`Fold ${foldable.length} idle session${foldable.length === 1 ? "" : "s"}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        foldIdle();
                      }}
                    >
                      Fold (+{foldable.length})
                    </button>
                  )}
                </div>
                {idleOpen && idle.map(renderWorkerItem)}
              </>
            ) : foldable.length > 0 ? (
              <div className="ws-idle-row">
                <button type="button" className="ws-idle-toggle" onClick={foldIdle}>
                  Fold ({foldable.length})
                </button>
              </div>
            ) : null}
            {past.length > 0 && archiveList(g, past)}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="sidebar-header">
        <span className="sidebar-title">
          <span>Workspaces</span> {!p.connected && <span className="disconnected">offline</span>}
        </span>
        <span className="sidebar-actions">
          <button
            type="button"
            className="sidebar-push"
            aria-label="Notifications"
            aria-pressed={push.subscribed}
            aria-disabled={push.unavailable || push.busy}
            title={push.hint}
            onClick={() => {
              if (push.busy) return;
              dismissSnapshotStatus();
              void push.toggle().then((explain) => {
                if (explain) setDebugOpen(true);
              });
            }}
          >
            <Icon name="bell" />
          </button>
          {window.yaatTheme && <ThemeToggle controller={window.yaatTheme} />}
          <button title="New session" onClick={p.onCreate}>
            <Icon name="plus" />
          </button>
          {p.onCreateProject && (
            <button title="New project" onClick={p.onCreateProject}>
              <Icon name="newProject" />
            </button>
          )}
          <button
            type="button"
            title="Usage"
            aria-label="Usage"
            aria-haspopup="dialog"
            onClick={() => setShowUsage(true)}
          >
            <Icon name="usage" />
          </button>
          <button
            ref={debugTrigger}
            type="button"
            className="sidebar-debug"
            aria-label={triggerLabel}
            aria-expanded={debugOpen}
            aria-pressed={debugOpen}
            aria-controls={debugId}
            title={triggerLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleDebug}
          >
            <Icon name="debug" />
            {triggerAbnormal && <span className="sidebar-debug-dot" aria-hidden="true" />}
          </button>
        </span>
      </div>
      {debugOpen && (
        <div
          ref={debugStrip}
          id={debugId}
          className="sidebar-debug-strip"
          role="group"
          aria-label="Debug tools"
        >
          {(snapshotStatusHidden || !snapshotStatusText) && push.status && (
            <span
              className={`sidebar-debug-status${push.status.tone ? ` sidebar-debug-status-${push.status.tone}` : ""}`}
              role="status"
              title={push.status.text}
            >
              {push.status.text}
            </span>
          )}
          {!snapshotStatusHidden && snapshotStatusText && (
            <span
              className={`sidebar-debug-status sidebar-debug-status-${snapshotStatus}`}
              role="status"
              aria-live="polite"
            >
              {snapshotStatusText}
            </span>
          )}
          <button
            type="button"
            className="sidebar-debug-action"
            aria-label="Send test push"
            title="Send test push"
            disabled={!p.connected || push.testing}
            onClick={() => {
              dismissSnapshotStatus();
              void push.testPush();
            }}
          >
            <Icon name="testPush" />
          </button>
          <a
            className="sidebar-debug-action"
            href="api/diagnostics?format=text"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={diagnosticsLabel}
            title={diagnosticsLabel}
          >
            <Icon name="diagnostics" />
            {diagnosticsState !== null && <span className="sidebar-debug-dot" aria-hidden="true" />}
          </a>
          <button
            type="button"
            className="sidebar-debug-action"
            aria-label="Replay demo"
            title="Replay demo"
            onClick={p.onReplayDemo}
          >
            <Icon name="play" />
          </button>
          <button
            type="button"
            className="sidebar-debug-action"
            aria-label="Capture debug snapshot"
            aria-busy={snapshotBusy}
            title={snapshotBusy ? "Saving debug snapshot…" : "Capture debug snapshot (Alt+Shift+S)"}
            aria-keyshortcuts="Alt+Shift+S"
            disabled={snapshotBusy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveSnapshot}
          >
            <Icon name="camera" />
          </button>
        </div>
      )}
      <div className="search-bar">
        <input
          type="text"
          value={p.searchQuery}
          {...telemetryTarget("sidebar.search")}
          onChange={(e) => p.onSearchChange(e.target.value)}
          placeholder="Search messages…"
          autoComplete="off"
        />
        {p.searchQuery && (
          <button className="search-clear" onClick={() => p.onSearchChange("")}>
            ×
          </button>
        )}
      </div>
      {p.searchQuery.trim() ? (
        <div className="search-results">
          {p.searchHits === null ? (
            <div className="search-empty">Searching…</div>
          ) : p.searchHits.length === 0 ? (
            <div className="search-empty">No results</div>
          ) : (
            p.searchHits.map((r, i) => (
              <div
                key={i}
                className="search-result-item"
                onClick={() => p.onJump(r.workspaceId, r.messageId)}
              >
                <div className="search-result-ws">{r.workspaceName}</div>
                <div className="search-result-snippet">{r.snippet}</div>
                <div className="search-result-time">{formatShortDateTime(r.timestamp)}</div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="task-list">
          {groups.length === 0 && archived.length === 0 && (
            <div className="sidebar-empty">No workspaces yet</div>
          )}
          {live.map((g) => renderGroup(g))}
          {shelved.length > 0 && (
            <div className="ws-group ws-shelf">
              <div
                className="ws-group-header ws-archived-header"
                {...telemetryTarget("sidebar.archive_toggle")}
                aria-expanded={showShelf}
                onClick={() => setShelfOpen((v) => !v)}
                title="Projects filed away. Their leads and history are still there."
              >
                <span className="events-toggle" aria-hidden="true">
                  ▸
                </span>
                <span className="ws-group-label">Archived projects</span>
                <span className="ws-group-count">{shelved.length}</span>
              </div>
              {showShelf && shelved.map((g) => renderGroup(g, true))}
            </div>
          )}
          {archived.length > 0 && (
            <div className="ws-group ws-archived">
              <div
                className="ws-group-header ws-archived-header"
                {...telemetryTarget("sidebar.archive_toggle")}
                aria-expanded={showArchived}
                onClick={() => setArchivedOpen((v) => !v)}
                title="Idle workspaces. History stays on disk; sending a message restores one."
              >
                <span className="events-toggle" aria-hidden="true">
                  ▸
                </span>
                <span className="ws-group-label">Archived</span>
                {showArchived && <span className="ws-group-count">{archived.length}</span>}
                {showArchived && (
                  <button
                    className="ws-archived-purge"
                    title="Delete the archived workspaces that belong to no project"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onPurgeArchived(null);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              {showArchived && (
                <div className="ws-group-items">
                  {archived.map((ws) => archivedItem(ws, ws.project))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {p.quota && (
        <QuotaPanel quota={p.quota} refresh={p.onRefreshQuota} now={now} connected={p.connected} />
      )}
      {debugOpen && p.systemStatus && <SystemStatusPanel status={p.systemStatus} />}
      {showUsage && (
        <UsageDashboard workspaces={p.workspaces} onClose={() => setShowUsage(false)} />
      )}
      {deleting && (
        <ConfirmDialog
          telemetryAction="confirm.delete_session"
          title={`Delete ${deleting.name}?`}
          body="This session and its message history will be deleted."
          confirmLabel="Delete session"
          danger
          onConfirm={() => p.onDelete(deleting.id)}
          onClose={() => setDeleteId(null)}
        />
      )}
    </>
  );
});
