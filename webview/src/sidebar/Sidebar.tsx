import type { QuotaState } from "../../../shared/quota";
import { memo, useState, useEffect } from "react";
import type { Workspace, Project, SystemStatus, SearchHit } from "../state/useServer";
import {
  groupWorkspaces,
  isGroupExpanded,
  archivedWorkspaces,
  type WorkspaceGroup,
} from "./groups";
import { isAgentActive } from "../workspace/agents";
import { Icon } from "../panels/Icon";
import { DEFAULT_BRANCH } from "../panels/scope";
import { formatBytes, formatRelative } from "../format";
import { RoleTag } from "../workspace/RoleTag";
import { NameInput } from "../project/NameInput";
import { ConfirmDialog } from "../workspace/dialogs";
import { QuotaPanel } from "./QuotaPanel";
import { formatShortDateTime, quotaTone } from "./quota";

function gitTitle(git: { dirty: number; ahead: number; behind: number }): string {
  const parts: string[] = [];
  if (git.dirty) parts.push(`${git.dirty} changed file${git.dirty === 1 ? "" : "s"}`);
  if (git.ahead) parts.push(`${git.ahead} ahead`);
  if (git.behind) parts.push(`${git.behind} behind`);
  return parts.length ? parts.join(", ") : "clean";
}

const STATUS_COLORS = { danger: "var(--error)", warn: "var(--warning)", normal: "var(--accent)" };

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
  groupOverrides: Record<string, boolean>;
  finishedStatus: Record<string, "done" | "failed">;
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
  // Save a layout snapshot on the server (see debugSnapshot.ts).
  onDebugSnapshot: () => void;
  // One project's archived sessions, or (null) those in no project.
  onPurgeArchived: (projectId: string | null) => void;
  onArchiveProject?: (projectId: string) => void;
  onRenameProject?: (projectId: string, name: string) => void;
  onRestoreProject?: (projectId: string) => void;
}

export const Sidebar = memo(function Sidebar(p: SidebarProps) {
  const now = p.now ?? Date.now();
  const debug = new URLSearchParams(window.location.search).get("debug") === "1";
  const [healthy, setHealthy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleting = p.workspaces.find((ws) => ws.id === deleteId);
  useEffect(() => {
    setHealthy(false);
    if (!p.connected || debug) return;
    let request: AbortController | undefined;
    const check = async () => {
      request?.abort();
      const controller = (request = new AbortController());
      let healthy = false;
      try {
        const response = await fetch("api/diagnostics", { signal: controller.signal });
        const report: unknown = response.ok ? await response.json() : null;
        healthy =
          !!report &&
          typeof report === "object" &&
          "issues" in report &&
          Array.isArray(report.issues) &&
          report.issues.length === 0;
      } catch {
        // An unavailable report must not hide the diagnostics link.
      }
      if (!controller.signal.aborted) setHealthy(healthy);
    };
    void check();
    // Model/account readiness can change without reconnecting the socket.
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      clearInterval(timer);
      request?.abort();
    };
  }, [p.connected, debug]);
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
  const groups = groupWorkspaces(p.workspaces, p.projects);
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
  const toggleArchive = (key: string) =>
    setOpenArchives((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

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
    const root = g.project?.root;
    return (
      <>
        <div
          className="ws-archive-toggle"
          role="button"
          aria-expanded={open}
          onClick={() => toggleArchive(g.key)}
        >
          <span className="events-toggle">{open ? "▾" : "▸"}</span>
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
        {open &&
          list.map((w) =>
            archivedItem(
              w,
              w.cwd === root ? null : (w.cwd.split("/").filter(Boolean).pop() ?? w.cwd),
            ),
          )}
      </>
    );
  };

  // A folder's group or a project's (its row is its lead), with its archived
  // sessions folded under it; `shelf` for an archived project's.
  const renderGroup = (g: WorkspaceGroup, shelf = false) => {
    const expanded = isGroupExpanded(
      g,
      p.groupOverrides,
      now,
      [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId),
    );
    const toggle = () => p.onToggleGroup(g.key, !expanded);
    // A project's own row is its lead, archived with it or not: it opens the
    // lead, which is not listed again under it; the arrow folds the sessions
    // it started.
    const lead = g.project
      ? [...g.workspaces, ...g.archived].find((w) => w.projectLink?.role === "lead")
      : undefined;
    const items = g.workspaces.filter((w) => w !== lead);
    const past = g.archived.filter((w) => w !== lead);
    const leadUnread = lead?.unread ?? 0;
    const hasContent = items.length > 0 || past.length > 0;
    // A project of archived sessions only (its lead archived too) has no live one.
    const git = (g.workspaces[0] ?? g.archived[0])?.git;
    // The group of the open session: on touch only its row offers a new one.
    const current = [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId);
    return (
      <div key={g.key} className="ws-group">
        <div
          className={`ws-group-header${g.project ? " ws-group-project" : ""}${lead && lead.id === p.activeWsId ? " active" : ""}${current ? " current" : ""}`}
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
              className="events-toggle ws-group-toggle"
              aria-label={expanded ? `Fold ${g.label}` : `Unfold ${g.label}`}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="events-toggle">{expanded ? "▾" : "▸"}</span>
          )}
          {g.project && renaming === g.project.id ? (
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
          {leadUnread > 0 && lead!.id !== p.activeWsId && (
            <span className="unread-badge">{leadUnread}</span>
          )}
          {git?.branch && !DEFAULT_BRANCH.test(git.branch) && (
            <span className="ws-group-branch" title={gitTitle(git)}>
              {git.branch}
            </span>
          )}
          {(!g.project || (g.project.root && g.project.status !== "sealed")) && (
            <button
              className="ws-group-add"
              title={g.project ? `New session in ${g.project.name}` : `New workspace in ${g.key}`}
              onClick={(e) => {
                e.stopPropagation();
                p.onCreateIn(g.project?.root ?? g.key);
              }}
            >
              <Icon name="plus" />
            </button>
          )}
          {!expanded && items.length > 0 && <span className="ws-group-count">{items.length}</span>}
          {g.running && <span className="streaming-dot" />}
          {!shelf && g.project && g.project.status !== "sealed" && p.onArchiveProject && (
            <button
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
          {shelf && g.project && g.project.status !== "sealed" && p.onRestoreProject && (
            <button
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
          {lead && deleteButton(lead)}
        </div>
        {expanded && hasContent && (
          <div className="ws-group-items">
            {items.map((ws) => {
              const running = ws.agents.some(isAgentActive);
              const unread = ws.unread ?? 0;
              const awaits = ws.awaitsUser && !running && ws.id !== p.activeWsId;
              return (
                <div
                  key={ws.id}
                  className={`task-item ${ws.id === p.activeWsId ? "active" : ""}${running ? " task-item-active" : ""}`}
                  onClick={() => p.onSelect(ws.id)}
                >
                  <div
                    className={`task-status ${running ? "running" : (p.finishedStatus[ws.id] ?? "idle")}`}
                  />
                  <div className="task-info">
                    <div className="task-name">
                      <span className="task-name-text">
                        <RoleTag link={ws.projectLink} />
                        <span className="clip" title={ws.name}>
                          {ws.name}
                        </span>
                        {awaits && (
                          <span className="awaits-tag" title="Waiting for your reply">
                            your turn
                          </span>
                        )}
                        {unread > 0 && ws.id !== p.activeWsId && (
                          <span className="unread-badge">{unread}</span>
                        )}
                      </span>
                    </div>
                  </div>
                  <span className="task-hover">
                    <span className="task-time">
                      {formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}
                    </span>
                    {deleteButton(ws)}
                  </span>
                </div>
              );
            })}
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
          Workspaces {!p.connected && <span className="disconnected">offline</span>}
        </span>
        <span className="sidebar-actions">
          {debug && (
            <button
              title="Replay rendering demo (synthetic events for visual review)"
              onClick={p.onReplayDemo}
            >
              <Icon name="play" />
            </button>
          )}
          <button title="New session" onClick={p.onCreate}>
            <Icon name="plus" />
          </button>
          {p.onCreateProject && (
            <button title="New project" onClick={p.onCreateProject}>
              <Icon name="board" />
            </button>
          )}
          {debug && (
            <button
              className="sidebar-debug"
              title="Save a layout debug snapshot (viewport, geometry, DOM) on the server"
              onClick={p.onDebugSnapshot}
            >
              <Icon name="snapshot" />
            </button>
          )}
        </span>
      </div>
      <div className="search-bar">
        <input
          type="text"
          value={p.searchQuery}
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
                onClick={() => setShelfOpen((v) => !v)}
                title="Projects filed away. Their leads and history are still there."
              >
                <span className="events-toggle">{showShelf ? "▾" : "▸"}</span>
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
                onClick={() => setArchivedOpen((v) => !v)}
                title="Idle workspaces. History stays on disk; sending a message restores one."
              >
                <span className="events-toggle">{showArchived ? "▾" : "▸"}</span>
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
      {(debug || !p.connected || !healthy) && (
        <small className="system-status-panel">
          <a href="api/diagnostics?format=text" target="_blank" rel="noreferrer">
            Service diagnostics
          </a>
          {" · "}
          <a href="api/diagnostics" target="_blank" rel="noreferrer">
            JSON
          </a>
        </small>
      )}
      {p.quota && (
        <QuotaPanel quota={p.quota} refresh={p.onRefreshQuota} now={now} connected={p.connected} />
      )}
      {p.systemStatus && <SystemStatusPanel status={p.systemStatus} />}
      {deleting && (
        <ConfirmDialog
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
