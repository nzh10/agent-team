import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import {
  AUTO_RELOAD,
  useServer,
  type Message,
  type AgentInfo,
  type IssueModules,
  type MessageOrigin,
  type Project,
  type Workspace,
} from "./state/useServer";
import { groupWorkspaces } from "./sidebar/groups";
import { agentQueues, agentState, isAgentActive, pillLabel } from "./workspace/agents";
import { SidePanel } from "./panels/SidePanel";
import { Rail, type RailItem } from "./panels/Rail";
import { AgentsPanel, type AgentsPanelActions } from "./panels/AgentsPanel";
import { workCount } from "./panels/SessionTasks";
import { FilesPanel, type CodeQuote } from "./panels/FilesPanel";
import { fileRoots, scopeSessions, scopeSummary, sessionState, stateSummary } from "./panels/scope";
import { FileOpenContext, splitFileRef, type FileRef } from "./chat/fileRef";
import { extractImageFiles, installMacCtrlClipboard } from "./chat/clipboard";
import { installMacTextKeys } from "./chat/textKeys";
import { isImeKeyEvent } from "./chat/ime";
import { AgentAvatar } from "./workspace/avatar";
import { formatRelative, shortModel } from "./format";
import { MessageItem, MessageBoundary, originLabel, SessionLinkContext } from "./chat/messages";
import {
  AddAgentDialog,
  CodexSetupDialog,
  CreateProjectDialog,
  CreateWorkspaceDialog,
  ConfirmDialog,
} from "./workspace/dialogs";
import { ExtensionUi } from "./workspace/ExtensionUi";
import { UiDialogModal, uiDialogKey } from "./workspace/UiDialogModal";
import { Sidebar } from "./sidebar/Sidebar";
import { GitBar } from "./workspace/GitBar";
import { ReportSwitch } from "./workspace/ReportSwitch";
import { BoardPage, type SessionInfo } from "./project/BoardPage";
import { HistoryHint } from "./chat/HistoryHint";
import {
  viewportVars,
  fullHeight,
  keyboardOpen,
  isStandalone,
  readSafeTop,
  type ViewportMetrics,
} from "./viewport/viewport";
import {
  ViewportTracker,
  healViewport,
  isAtBottom,
  isTextInput,
  settleScroller,
} from "./viewport/viewportHeal";
import { uploadSnapshot } from "./dev/debugSnapshot";

// Re-exported for tests and for anyone importing the old single-file layout.
export { GitBar } from "./workspace/GitBar";
export { EventItem, SubAgentItem, StepGroup, MessageItem, BannerItem } from "./chat/messages";
export {
  AddAgentDialog,
  CodexSetupDialog,
  CreateProjectDialog,
  CreateWorkspaceDialog,
  ConfirmDialog,
} from "./workspace/dialogs";
export { UiDialogModal } from "./workspace/UiDialogModal";
export { Sidebar } from "./sidebar/Sidebar";

function compressToBlob(file: File, maxDim = 1600, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      try {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(src);
            if (blob) resolve(blob);
            else reject(new Error("toBlob returned null"));
          },
          "image/jpeg",
          quality,
        );
      } catch (e) {
        URL.revokeObjectURL(src);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error(`Failed to load image: ${file.name}`));
    };
    img.src = src;
  });
}

async function uploadImage(file: File): Promise<{ name: string; url: string }> {
  let blob: Blob;
  try {
    blob = await Promise.race([
      compressToBlob(file),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Compression timeout")), 10000),
      ),
    ]);
  } catch {
    blob = file;
  }
  const contentType = blob instanceof File ? blob.type || "image/jpeg" : "image/jpeg";
  const res = await fetch("upload", {
    method: "POST",
    headers: { "Content-Type": contentType, "X-Filename": file.name },
    credentials: "include",
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json() as Promise<{ name: string; url: string }>;
}

// Paging back to a search hit: the server's maximum page, and how far back
// to go before giving up.
const JUMP_PAGE = 200;
const NO_ISSUES: IssueModules = [];
const JUMP_MAX_PAGES = 10;

export function App() {
  const {
    workspaces,
    projects,
    issues,
    connected,
    user,
    presets,
    models,
    codexAuth,
    recheckingCodexAuth,
    recheckCodexAuth,
    commands,
    extensionUi,
    dismissNotice,
    pendingDialogs,
    selectCommandAgent,
    respondUiDialog,
    hosts,
    systemStatus,
    quota,
    refreshQuota,
    createWorkspace,
    createProject,
    renameProject,
    sealProject,
    deleteProject,
    deleteWorkspace,
    addAgent,
    removeAgent,
    sendMessage,
    abort,
    interrupt,
    cancelWakeup,
    markSeen,
    clearContext,
    loadMessages,
    loadMessageDetails,
    loadSubagentEvents,
    cancelSubagent,
    cancelQueued,
    startReplayDemo,
    lastError,
    clearError,
    searchServer,
    searchResults,
    listDirs,
    dirSuggestions,
    archiveWorkspace,
    unarchiveWorkspace,
    setReporting,
    purgeArchived,
    archiveProject,
    archiveAfterDays,
  } = useServer();
  // Sessions and projects named in the chat, by their names as they are now;
  // recomputed only when one of those names changes.
  const namesKey = [...workspaces, ...projects].map((x) => `${x.id}\t${x.name}`).join("\n");
  const sessionLinks = useMemo(() => {
    const names = new Map(namesKey.split("\n").map((l) => l.split("\t") as [string, string]));
    return { nameOf: (id: string) => names.get(id) };
  }, [namesKey]);
  // The archived sessions a Clear asked to delete: a project's, or (null)
  // those in no project.
  const [purgeScope, setPurgeScope] = useState<{ projectId: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);
  const takeSnapshot = useCallback(() => {
    uploadSnapshot().then(
      (p) => setNotice(`Snapshot saved: ${p}`),
      (e) => setNotice(`Snapshot failed: ${e instanceof Error ? e.message : e}`),
    );
  }, []);

  // Server errors (busy agent, cancel failures...) were previously only
  // logged to the console; surface them as a dismissible toast.
  useEffect(() => {
    if (!lastError) return;
    const t = setTimeout(clearError, 6000);
    return () => clearTimeout(t);
  }, [lastError, clearError]);

  // iOS Safari overlays the keyboard on top of a 100vh layout instead of
  // resizing it, hiding the input row and the newest messages. Track the
  // visual viewport and size the app to it; keep the bottom in view while
  // the composer is focused. In a standalone home-screen app the layout
  // viewport can also stay stuck ~60px short of the screen, which is why the
  // facts below carry the screen height and the top safe-area inset.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Safe-area insets only change on rotation, so probe them there rather
    // than on every visual-viewport scroll event.
    let safeTop = readSafeTop();
    const facts = (): ViewportMetrics => ({
      vvHeight: vv.height,
      vvOffsetTop: vv.offsetTop,
      innerHeight: window.innerHeight,
      screenHeight: window.screen.height,
      safeTop,
      standalone: isStandalone(),
    });
    const tracker = new ViewportTracker(Math.max(window.innerHeight, fullHeight(facts()) ?? 0));
    let healTimer: ReturnType<typeof setTimeout> | undefined;
    const heal = () => {
      const f = facts();
      // A focused field means the keyboard is up or animating in, whatever
      // the viewport numbers say at this instant; the focusout heal follows.
      const keyboard = keyboardOpen(f) || isTextInput(document.activeElement);
      if (!tracker.needsHeal(window.innerHeight, keyboard)) return;
      healViewport(appRef.current, messagesContainerRef.current);
    };
    const scheduleHeal = () => {
      clearTimeout(healTimer);
      healTimer = setTimeout(heal, 140);
    };
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) scheduleHeal();
    };
    document.addEventListener("focusout", onFocusOut);
    const onWindowResize = () => {
      safeTop = readSafeTop();
      tracker.observe(window.innerHeight);
      scheduleHeal();
    };
    window.addEventListener("resize", onWindowResize);
    let keyboardWasOpen = keyboardOpen(facts());
    const apply = () => {
      // Pin the app to the keyboard-free visible strip: size it to the
      // visual viewport AND follow its pan offset. (Never call scrollTo here
      // — that fights the browser's own scroll-into-view and pushes the
      // composer back under the keyboard.)
      const el = document.documentElement;
      const f = facts();
      const keyboard = keyboardOpen(f);
      const scroller = messagesContainerRef.current;
      const focused = document.activeElement === textareaRef.current;
      // Measured before the box changes: whether to stay glued to the end.
      const atBottom = scroller ? scroller.clientHeight > 0 && isAtBottom(scroller) : false;
      const vars = viewportVars(f);
      if (vars.height) el.style.setProperty("--app-height", vars.height);
      else el.style.removeProperty("--app-height");
      if (vars.offset) el.style.setProperty("--app-offset", vars.offset);
      else el.style.removeProperty("--app-offset");
      if (focused && scroller) scroller.scrollTop = scroller.scrollHeight;
      if (keyboard !== keyboardWasOpen) {
        // The scroller's box just changed height: see settleScroller.
        keyboardWasOpen = keyboard;
        requestAnimationFrame(() => settleScroller(scroller, atBottom || focused));
      }
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("resize", onWindowResize);
      document.removeEventListener("focusout", onFocusOut);
      clearTimeout(healTimer);
    };
  }, []);
  const appRef = useRef<HTMLDivElement>(null);
  // The side panels' heads are as tall as the chat header (styles.css).
  const headerRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      appRef.current?.style.setProperty("--chat-header-height", `${el.offsetHeight}px`),
    );
    observer.observe(el, { box: "border-box" });
    return () => observer.disconnect();
  }, []);

  const [activeWsId, setActiveWsId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("activeWsId");
    } catch {
      return null;
    }
  });
  const [hasInput, setHasInput] = useState(false);
  const inputMapRef = useRef(new Map<string, string>());
  // Set when switching to a workspace whose draft should be typed on at once.
  const focusComposerRef = useRef(false);
  const prevWsIdRef = useRef<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [createInPath, setCreateInPath] = useState<string | undefined>(undefined);
  // The workspace the Add Agent dialog is open for.
  const [addAgentFor, setAddAgentFor] = useState<string | null>(null);
  const [showCodexSetup, setShowCodexSetup] = useState(false);
  const openCodexSetup = useCallback(() => setShowCodexSetup(true), []);
  const closeCodexSetup = useCallback(() => setShowCodexSetup(false), []);
  // The side panel open beside the chat: pinned (the chat makes room),
  // floating over it, or maximised over the chat area until it closes.
  // Pinning persists, and so does a width once dragged; code needs more
  // room than the lists, so the Files panel has its own.
  const [openPanel, setOpenPanel] = useState<PanelId | null>(null);
  // Pinned unless chosen otherwise: floating over the chat, a panel cuts its
  // lines mid-word and covers Send (its width always leaves the chat room).
  const [panelPinned, setPanelPinned] = useState(() => readSetting("panelDock") !== "0");
  // Maximised for the workspace it was maximised in: opening another one
  // shows its chat.
  const [maxFor, setMaxFor] = useState<string | null>(null);
  const panelMax = maxFor !== null && maxFor === activeWsId;
  const [listWidth, setListWidth] = useSavedWidth("listPanelWidth");
  const [filesWidth, setFilesWidth] = useSavedWidth("filesPanelWidth");
  const togglePanel = useCallback((id: PanelId) => {
    setOpenPanel((cur) => (cur === id ? null : id));
    setMaxFor(null);
  }, []);
  const closePanel = useCallback(() => {
    setOpenPanel(null);
    setMaxFor(null);
  }, []);
  const toggleMax = useCallback(
    () => setMaxFor((m) => (m === activeWsId ? null : activeWsId)),
    [activeWsId],
  );
  // What the Files panel shows for each session: the last path named in its
  // chat (relative to the workspace it was named in), or else the session's
  // own folder. `seq` starts the panel over for each file opened.
  const [fileTargets, setFileTargets] = useState<
    Record<string, { wsId: string; ref: FileRef; seq: number }>
  >({});
  const fileSeq = useRef(0);
  const showFile = useCallback((wsId: string, ref: FileRef, session: string) => {
    const seq = ++fileSeq.current;
    setFileTargets((t) => ({ ...t, [session]: { wsId, ref, seq } }));
    setOpenPanel("files");
  }, []);
  const togglePin = useCallback(() => {
    writeSetting("panelDock", panelPinned ? "0" : "1");
    setPanelPinned(!panelPinned);
  }, [panelPinned]);
  // The project whose board page is open, whichever workspace is.
  const [boardProjectId, setBoardProjectId] = useState<string | null>(null);
  const closeBoard = useCallback(() => setBoardProjectId(null), []);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [sealingProjectId, setSealingProjectId] = useState<string | null>(null);
  const closeDeleteProject = useCallback(() => setDeletingProjectId(null), []);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  // A lead whose project has not arrived yet has nothing to delete.
  const askDeleteProject = useCallback((id: string) => {
    if (projectsRef.current.some((p) => p.id === id)) setDeletingProjectId(id);
  }, []);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [cmdQuery, setCmdQuery] = useState<string | null>(null);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The drawer's overlay outlives it a moment: the second tap of a double
  // tap on a session lands on it, not on whatever the closing drawer uncovers.
  const [sidebarShield, setSidebarShield] = useState(false);
  useEffect(() => {
    if (sidebarOpen) {
      setSidebarShield(true);
      return;
    }
    const t = setTimeout(() => setSidebarShield(false), 400);
    return () => clearTimeout(t);
  }, [sidebarOpen]);
  const [pendingImages, setPendingImages] = useState<Array<{ file: File; preview: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const compositionEndTsRef = useRef(0);

  const activeWsIdRef = useRef(activeWsId);
  activeWsIdRef.current = activeWsId;
  const [quotedMsg, setQuotedMsg] = useState<{
    id: string;
    wsId: string;
    agentId: string | null;
    content: string;
    from?: MessageOrigin;
  } | null>(null);

  const handleQuote = useCallback((msg: Message) => {
    const wsId = activeWsIdRef.current;
    if (wsId) {
      setQuotedMsg({
        wsId,
        id: msg.id,
        agentId: msg.agentId,
        content: msg.content,
        from: msg.from,
      });
    }
  }, []);

  const [searchQuery, setSearchQuery] = useState("");
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const prevRunningRef = useRef<Record<string, boolean>>({});
  const [finishedStatus, setFinishedStatus] = useState<Record<string, "done" | "failed">>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(
    () =>
      installMacCtrlClipboard(
        () => textareaRef.current,
        (files) =>
          setPendingImages((prev) => [
            ...prev,
            ...files.map((file) => ({ file, preview: URL.createObjectURL(file) })),
          ]),
      ),
    [],
  );
  useEffect(() => installMacTextKeys(), []);
  const projectFolders = useMemo(
    () => [
      ...projects.flatMap((p) => (p.root ? [p.root] : [])),
      ...workspaces.filter((w) => w.projectLink).map((w) => w.cwd),
    ],
    [projects, workspaces],
  );
  const draggingRef = useRef(false);

  const sortedWorkspaces = useMemo(
    () =>
      [...workspaces].sort((a, b) => {
        const aTime = a.lastMessageAt ?? a.createdAt;
        const bTime = b.lastMessageAt ?? b.createdAt;
        return bTime - aTime;
      }),
    [workspaces],
  );
  const activeWs = workspaces.find((w) => w.id === activeWsId);
  const activeProject = activeWs?.projectLink
    ? projects.find((p) => p.id === activeWs.projectLink!.projectId)
    : undefined;
  const boardProject = projects.find((p) => p.id === boardProjectId);
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;
  const projectSealed = activeProject?.status === "sealed";
  const onRenameProject = useCallback(
    (name: string) => {
      if (boardProjectId) renameProject(boardProjectId, name);
    },
    [boardProjectId, renameProject],
  );
  const onDeleteBoardProject = useCallback(() => {
    if (boardProjectId) setDeletingProjectId(boardProjectId);
  }, [boardProjectId]);
  // Sessions as the board shows them, stable across stream frames.
  const sessionsKey = workspaces
    .map((w) => {
      const state =
        w.archivedAt != null ? "archived" : w.agents.some(isAgentActive) ? "working" : "idle";
      return `${w.id}\u0000${w.name}\u0000${state}`;
    })
    .join("\u0001");
  const boardSessions = useMemo(
    () =>
      new Map(
        sessionsKey
          .split("\u0001")
          .filter(Boolean)
          .map((e) => {
            const [id, name, state] = e.split("\u0000");
            return [id, { name, state } as SessionInfo];
          }),
      ),
    [sessionsKey],
  );

  // What the side panels cover: the project's sessions, or this workspace.
  const scope = useMemo(
    () => scopeSessions(activeWs, workspaces, activeProject),
    [activeWs, workspaces, activeProject],
  );
  // From a project's lead, the Agents panel is the project's overview; from
  // any other session, that session alone.
  const overview = activeWs?.projectLink?.role === "lead";
  const panelSessions = useMemo(
    () => (overview ? scope : activeWs ? [activeWs] : []),
    [overview, scope, activeWs],
  );
  const railItems: RailItem[] = [
    ...(activeProject
      ? [
          {
            id: "board",
            label: `Objectives of ${activeProject.name}`,
            icon: "board" as const,
            page: true,
            active: boardProjectId === activeProject.id,
            onClick: () => setBoardProjectId(activeProject.id),
          },
        ]
      : []),
    {
      id: "agents",
      label: "Agents and sessions",
      icon: "agents" as const,
      active: openPanel === "agents",
      badge:
        panelSessions.filter((w) => sessionState(w) === "working").length +
        workCount(panelSessions),
      onClick: () => togglePanel("agents"),
    },
    {
      id: "files",
      label: "Files",
      icon: "files" as const,
      active: openPanel === "files",
      onClick: () => togglePanel("files"),
    },
    {
      id: "changes",
      label: "Changes",
      icon: "changes" as const,
      active: openPanel === "changes",
      onClick: () => togglePanel("changes"),
    },
  ];
  const fileScope = activeWsId ?? "";
  const files =
    fileTargets[fileScope] ?? (activeWs && { wsId: activeWs.id, ref: WORKSPACE_ROOT, seq: 0 });
  // Where the reader went in the panel, kept for the session without
  // starting the panel over.
  const keepFile = (ref: FileRef) =>
    files && setFileTargets((t) => ({ ...t, [fileScope]: { ...files, ref } }));
  const roots = useMemo(() => fileRoots(scope), [scope]);
  // Opens a file named in the chat, relative to a workspace's folder: a
  // message delivered from another session names paths in that session's.
  const fileOpener = useMemo(() => {
    const byWs = new Map<string, (ref: string) => void>();
    return (wsId: string) => {
      let open = byWs.get(wsId);
      if (!open) {
        open = (ref) => showFile(wsId, splitFileRef(ref), fileScope);
        byWs.set(wsId, open);
      }
      return open;
    };
  }, [showFile, fileScope]);
  const workspaceIds = useMemo(() => new Set(workspaces.map((w) => w.id)), [workspaces]);
  // Sidebar folder groups; explicit expand/collapse choices persist.
  const wsGroups = useMemo(() => groupWorkspaces(workspaces, projects), [workspaces, projects]);
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("wsGroupOverrides") ?? "{}") as Record<
        string,
        boolean
      >;
    } catch {
      return {};
    }
  });
  const toggleGroup = useCallback((key: string, expanded: boolean) => {
    setGroupOverrides((prev) => {
      const next = { ...prev, [key]: expanded };
      try {
        localStorage.setItem("wsGroupOverrides", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  // Switching into a workspace whose group was explicitly collapsed clears
  // that override once (e.g. jumping there from search), after which the
  // group can be collapsed again freely.
  useEffect(() => {
    if (!activeWsId) return;
    const g = wsGroups.find((grp) => grp.workspaces.some((w) => w.id === activeWsId));
    if (!g) return;
    setGroupOverrides((prev) => {
      if (prev[g.key] !== false) return prev;
      const next = { ...prev, [g.key]: true };
      try {
        localStorage.setItem("wsGroupOverrides", JSON.stringify(next));
      } catch {}
      return next;
    });
    // Deliberately keyed on the active workspace only: re-running on every
    // wsGroups identity change would instantly undo a manual collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWsId]);
  const activeWsRef = useRef(activeWs);
  activeWsRef.current = activeWs;

  // Message props must keep their identity across stream frames, or every
  // memoized MessageItem re-renders on each one. Handlers read the active
  // workspace at call time; settled messages get an agents list that only
  // changes when an agent's name, look or model does, not with its
  // activity, which ticks every second while a tool runs.
  const onLoadSubagentEvents = useCallback(
    (messageId: string, taskId: string) => {
      const ws = activeWsRef.current;
      if (ws) loadSubagentEvents(ws.id, messageId, taskId);
    },
    [loadSubagentEvents],
  );
  const onCancelSubagent = useCallback(
    (agentId: string, taskId: string) => {
      const ws = activeWsRef.current;
      if (ws) cancelSubagent(ws.id, agentId, taskId);
    },
    [cancelSubagent],
  );
  const onCancelQueued = useCallback(
    (messageId: string) => {
      const ws = activeWsRef.current;
      if (ws) cancelQueued(ws.id, messageId);
    },
    [cancelQueued],
  );
  const onLoadDetails = useCallback(
    (messageId: string) => {
      const ws = activeWsRef.current;
      if (ws) loadMessageDetails(ws.id, messageId);
    },
    [loadMessageDetails],
  );
  const agentsLook = (activeWs?.agents ?? [])
    .map((a) => [a.id, a.name, a.avatar, a.color, a.model].join("\u0000"))
    .join("\n");
  const settledAgents = useMemo<AgentInfo[]>(
    () => activeWs?.agents ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on how the agents look; see above
    [agentsLook],
  );

  const onSelectWorkspace = useCallback((id: string) => {
    setActiveWsId(id);
    setSidebarOpen(false);
  }, []);
  // Links to other sessions (message senders, the board, the lead) can
  // outlive the session they point at.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const openWorkspace = useCallback(
    (id: string) => {
      if (workspacesRef.current.some((w) => w.id === id)) onSelectWorkspace(id);
      else setNotice("That session no longer exists.");
    },
    [onSelectWorkspace],
  );
  const agentActions = useMemo<AgentsPanelActions>(
    () => ({
      onOpen: (id) => {
        // On a phone the panel covers the chat: step aside for the session.
        if (window.matchMedia?.(PHONE).matches) setOpenPanel(null);
        openWorkspace(id);
      },
      onStop: (id) => void interrupt(id),
      onArchive: (id) => archiveWorkspace(id),
      onRestore: (id) => unarchiveWorkspace(id),
      onSetReporting: (id, reports) => setReporting(id, reports),
      onAddAgent: (id) => setAddAgentFor(id),
      onClearContext: (id, agentId) => clearContext(id, agentId),
      onRemoveAgent: (id, agentId) => removeAgent(id, agentId),
      // Through the chat, so the switch shows where it happened.
      onSetModel: (id, agentId, model) => void sendMessage(id, `/model ${model}`, agentId),
      onSetEffort: (id, agentId, effort) => void sendMessage(id, `/effort ${effort}`, agentId),
      onStopTask: (id, agentId, taskId) => cancelSubagent(id, agentId, taskId),
      onCancelWake: (id, agentId) => cancelWakeup(id, agentId),
      onStopAll: (id) => abort(id),
    }),
    [
      openWorkspace,
      interrupt,
      archiveWorkspace,
      unarchiveWorkspace,
      setReporting,
      clearContext,
      removeAgent,
      sendMessage,
      cancelSubagent,
      cancelWakeup,
      abort,
    ],
  );

  const onDeleteWorkspace = useCallback(
    (id: string) => {
      deleteWorkspace(id);
      setActiveWsId((cur) => (cur === id ? null : cur));
    },
    [deleteWorkspace],
  );
  const onCreateWorkspace = useCallback(() => {
    setCreateInPath(undefined);
    setShowCreate(true);
  }, []);
  const onCreateWorkspaceIn = useCallback((cwd: string) => {
    setCreateInPath(cwd);
    setShowCreate(true);
  }, []);
  const onReplayDemo = useCallback(() => {
    const wsId = startReplayDemo();
    setActiveWsId(wsId);
    setSidebarOpen(false);
  }, [startReplayDemo]);
  const onPurgeArchived = useCallback(
    (projectId: string | null) => setPurgeScope({ projectId }),
    [],
  );
  const closePurge = useCallback(() => setPurgeScope(null), []);
  const onArchiveProject = useCallback(
    (projectId: string) => archiveProject(projectId, true),
    [archiveProject],
  );
  const onRestoreProject = useCallback(
    (projectId: string) => archiveProject(projectId, false),
    [archiveProject],
  );
  const onArchiveBoardProject = useCallback(
    (archived: boolean) => {
      if (boardProjectId) archiveProject(boardProjectId, archived);
    },
    [boardProjectId, archiveProject],
  );
  const onSealBoardProject = useCallback(() => {
    if (boardProjectId) setSealingProjectId(boardProjectId);
  }, [boardProjectId]);

  // The session on screen is read on every device, also when a turn of it
  // ends; a page in the background or out of focus reads nothing.
  const attended = usePageAttended();
  const hasActive = !!activeWs;
  const activeBusy = activeWs?.agents.some((a) => a.busy) ?? false;
  const needsMark = (activeWs?.unread ?? 0) > 0;
  // What was last marked: the session and whether it ran. Marked again when
  // it has unread messages (a mark lost with a dead socket comes back after
  // the reconnect), when a turn of it starts or ends, and on coming back.
  const marked = useRef("");
  useEffect(() => {
    // The board covers the session.
    if (!activeWsId || !hasActive || !attended || !connected || boardProjectId) {
      marked.current = "";
      return;
    }
    const key = `${activeWsId} ${activeBusy}`;
    if (!needsMark && key === marked.current) return;
    marked.current = key;
    markSeen(activeWsId);
    setFinishedStatus((prev) => {
      if (!(activeWsId in prev)) return prev;
      const next = { ...prev };
      delete next[activeWsId];
      return next;
    });
  }, [activeWsId, hasActive, needsMark, activeBusy, attended, connected, boardProjectId, markSeen]);

  // A session another device showed is no longer "finished" here either.
  const seenTicks = useRef<Record<string, number>>({});
  useEffect(() => {
    const seen: string[] = [];
    for (const ws of workspaces) {
      const tick = ws.seenTick ?? 0;
      if (tick !== (seenTicks.current[ws.id] ?? 0)) seen.push(ws.id);
      seenTicks.current[ws.id] = tick;
    }
    if (seen.length === 0) return;
    setFinishedStatus((prev) => {
      if (!seen.some((id) => id in prev)) return prev;
      const next = { ...prev };
      for (const id of seen) delete next[id];
      return next;
    });
  }, [workspaces]);

  const runningSnapshot = useMemo(
    () =>
      Object.fromEntries(workspaces.map((ws) => [ws.id, ws.agents.some((a) => a.busy)] as const)),
    [workspaces],
  );

  useEffect(() => {
    const updates: Record<string, "done" | "failed"> = {};
    for (const ws of workspaces) {
      const isRunning = runningSnapshot[ws.id];
      const wasRunning = prevRunningRef.current[ws.id];
      // Nothing unread: another device was showing it.
      if (wasRunning && !isRunning && ws.id !== activeWsId && (ws.unread ?? 0) > 0) {
        const lastAgent = [...ws.messages].reverse().find((m) => m.kind === "agent");
        updates[ws.id] = lastAgent?.status === "error" ? "failed" : "done";
      }
      prevRunningRef.current[ws.id] = isRunning;
    }
    if (Object.keys(updates).length > 0) {
      setFinishedStatus((prev) => ({ ...prev, ...updates }));
    }
  }, [runningSnapshot, activeWsId, workspaces]);

  // Search runs server-side over the full message history — the client only
  // holds lazily-loaded windows, so local filtering missed almost everything.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) return;
    const t = setTimeout(() => searchServer(q), 200);
    return () => clearTimeout(t);
  }, [searchQuery, searchServer]);
  // null = query in flight (debounce or awaiting the server echo).
  const searchHits = searchResults.query === searchQuery.trim() ? searchResults.hits : null;

  // Fetch older pages until the jump target is loaded, keeping history contiguous.
  const [pendingJump, setPendingJump] = useState<{
    wsId: string;
    msgId: string;
    pages: number;
    fromSearch: boolean;
  } | null>(null);
  const jumpScrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const jumpHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelJumpTimers = useCallback(() => {
    clearTimeout(jumpScrollTimerRef.current);
    clearTimeout(jumpHighlightTimerRef.current);
  }, []);
  useLayoutEffect(() => {
    setHighlightMsgId(null);
    return cancelJumpTimers;
  }, [activeWsId, cancelJumpTimers]);

  const startJump = useCallback(
    (wsId: string, msgId: string, fromSearch: boolean) => {
      cancelJumpTimers();
      setHighlightMsgId(null);
      setPendingJump({ wsId, msgId, pages: 0, fromSearch });
    },
    [cancelJumpTimers],
  );
  const jumpToMessage = useCallback(
    (wsId: string, msgId: string) => {
      setActiveWsId(wsId);
      setSearchQuery("");
      startJump(wsId, msgId, true);
    },
    [startJump],
  );
  const jumpToMessageInActiveWs = useCallback(
    (msgId: string) => {
      const wsId = activeWsIdRef.current;
      if (wsId) startJump(wsId, msgId, false);
    },
    [startJump],
  );

  useEffect(() => {
    if (activeWsId) {
      try {
        localStorage.setItem("activeWsId", activeWsId);
      } catch {}
    }
  }, [activeWsId]);

  useEffect(() => {
    if (!activeWsId && sortedWorkspaces.length > 0) setActiveWsId(sortedWorkspaces[0].id);
    if (activeWsId && workspaces.length > 0 && !workspaces.find((w) => w.id === activeWsId)) {
      setActiveWsId(sortedWorkspaces[0]?.id ?? null);
    }
  }, [sortedWorkspaces, activeWsId, workspaces]);

  useEffect(() => {
    if (prevWsIdRef.current && prevWsIdRef.current !== activeWsId) {
      inputMapRef.current.set(prevWsIdRef.current, textareaRef.current?.value ?? "");
    }
    prevWsIdRef.current = activeWsId;
    const restored = activeWsId ? (inputMapRef.current.get(activeWsId) ?? "") : "";
    const el = textareaRef.current;
    if (el) {
      el.value = restored;
      el.style.height = "36px";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
      if (focusComposerRef.current) {
        focusComposerRef.current = false;
        el.focus();
        el.selectionStart = el.selectionEnd = restored.length;
      }
    }
    setHasInput(restored.trim().length > 0);
    setMentionTarget(restored.match(/(?:^|\s)@(\S+)/)?.[1] ?? null);
    userScrolledUpRef.current = false;
    stuckToBottomRef.current = true;
    prevMsgCountRef.current = 0;
    jumpScrollTopRef.current = null;
    anchorRef.current = null;
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView();
    });
  }, [activeWsId]);

  // Also on every reconnect: the newest page resyncs in place, without
  // touching the draft or the reader's scroll position.
  useEffect(() => {
    if (activeWsId && connected) loadMessages(activeWsId);
  }, [activeWsId, connected, loadMessages]);

  // The open workspace dropped its history (archived while in view, e.g. by
  // a project's lead): fetch it again rather than spin until a switch.
  const activeLoaded = activeWs?.messagesLoaded ?? true;
  const loadedRef = useRef({ id: activeWsId, loaded: activeLoaded });
  useEffect(() => {
    const prev = loadedRef.current;
    loadedRef.current = { id: activeWsId, loaded: activeLoaded };
    if (connected && activeWsId && prev.id === activeWsId && prev.loaded && !activeLoaded) {
      loadMessages(activeWsId);
    }
  }, [activeWsId, activeLoaded, connected, loadMessages]);

  // Prepending a page changes scrollHeight; Safari has no overflow-anchor,
  // so remember where we were and restore it once the page is in the DOM.
  const anchorRef = useRef<{ wsId: string; firstId: string; height: number; top: number } | null>(
    null,
  );
  const rememberHistoryAnchor = useCallback((wsId: string, firstId: string) => {
    const el = messagesContainerRef.current;
    if (el) anchorRef.current = { wsId, firstId, height: el.scrollHeight, top: el.scrollTop };
  }, []);
  const onMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el || !activeWs || activeWs.loadingOlder) return;
    if (el.scrollTop < 80 && activeWs.hasMore) {
      const oldest = activeWs.messages[0];
      if (oldest) {
        rememberHistoryAnchor(activeWs.id, oldest.id);
        loadMessages(activeWs.id, oldest.timestamp);
      }
    }
  }, [activeWs, loadMessages, rememberHistoryAnchor]);

  const prevMsgCountRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  // Whether a growing reply keeps the view pinned to its end. Any upward
  // scroll lets go (a finger dragging back to reread moves a few pixels per
  // frame, far less than "scrolled up"); the very bottom takes hold again.
  const stuckToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const jumpScrollTopRef = useRef<number | null>(null);
  const wasStreamingRef = useRef(false);

  const onMessagesScrollTrack = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor && anchor.wsId === activeWsIdRef.current) {
      // Keep the reader's latest position if they scroll while a page is in flight.
      anchor.height = el.scrollHeight;
      anchor.top = el.scrollTop;
    }
    // A jump is not a request to reattach to the bottom or load another page.
    const jumpTop = jumpScrollTopRef.current;
    jumpScrollTopRef.current = null;
    if (jumpTop === el.scrollTop) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 150;
    if (distFromBottom <= 8) stuckToBottomRef.current = true;
    else if (el.scrollTop < lastScrollTopRef.current || userScrolledUpRef.current) {
      stuckToBottomRef.current = false;
    }
    lastScrollTopRef.current = el.scrollTop;
    onMessagesScroll();
  }, [onMessagesScroll]);

  // The composer growing (a long draft, the command list) takes the
  // transcript's room from below: a reader at the end stays there. Keyed on
  // the open workspace's id, not the one asked for: the transcript exists
  // once the workspace does.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      // At the end in the old box (content that grew meanwhile, a box the
      // reader opened, says not); a pixel short is settleScroller's nudge.
      const wasAtEnd = el.scrollHeight - el.scrollTop - height <= 8;
      const shrank = el.clientHeight < height;
      height = el.clientHeight;
      if (shrank && wasAtEnd && el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
        el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeWs?.id]);

  // Follow the conversation while the reader is at the bottom: a new
  // message scrolls into view, a streaming one keeps the end pinned. Only
  // while something streams (or just finished): a reply growing because the
  // reader opened a box must stay where they tapped.
  useLayoutEffect(() => {
    const msgs = activeWs?.messages ?? [];
    const prevCount = prevMsgCountRef.current;
    prevMsgCountRef.current = msgs.length;
    const streaming = msgs.some((m) => m.status === "streaming");
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = streaming;
    const anchor = anchorRef.current;
    const el = messagesContainerRef.current;
    if (anchor && el && anchor.wsId === activeWs?.id && msgs[0]?.id !== anchor.firstId) {
      anchorRef.current = null;
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      return;
    }
    if (prevCount === 0 && msgs.length > 0) {
      messagesEndRef.current?.scrollIntoView();
    } else if (msgs.length > prevCount) {
      if (!userScrolledUpRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    } else if (stuckToBottomRef.current && (streaming || wasStreaming)) {
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [activeWs?.id, activeWs?.messages]);

  useEffect(() => {
    const jump = pendingJump;
    if (!jump) return;
    if (activeWsId !== jump.wsId) {
      // The reader went elsewhere: coming back later must not resume it.
      setPendingJump(null);
      return;
    }
    if (!activeWs || !activeWs.messagesLoaded) return;
    if (activeWs.messages.some((m) => m.id === jump.msgId)) {
      setPendingJump(null);
      setHighlightMsgId(jump.msgId);
      jumpScrollTimerRef.current = setTimeout(() => {
        const target = document.getElementById(`msg-${jump.msgId}`);
        const scroller = messagesContainerRef.current;
        if (!target || !scroller?.contains(target)) return;
        userScrolledUpRef.current = true;
        stuckToBottomRef.current = false;
        const before = scroller.scrollTop;
        if (!jump.fromSearch) target.focus({ preventScroll: true });
        target.scrollIntoView({ behavior: "instant", block: "center" });
        const after = scroller.scrollTop;
        lastScrollTopRef.current = after;
        if (after !== before) jumpScrollTopRef.current = after;
      }, 100);
      jumpHighlightTimerRef.current = setTimeout(() => setHighlightMsgId(null), 2000);
      return;
    }
    if (activeWs.loadingOlder) return;
    const oldest = activeWs.messages[0];
    if (activeWs.hasMore && oldest && jump.pages < JUMP_MAX_PAGES) {
      // Keep the viewport anchored in case the target never turns up.
      rememberHistoryAnchor(activeWs.id, oldest.id);
      loadMessages(activeWs.id, oldest.timestamp, JUMP_PAGE);
      setPendingJump({ ...jump, pages: jump.pages + 1 });
    } else {
      setPendingJump(null);
      if (jump.fromSearch) setNotice("That message is no longer in the history.");
    }
  }, [pendingJump, activeWsId, activeWs, loadMessages, rememberHistoryAnchor]);

  const isAnyRunning = activeWs?.agents.some(isAgentActive) ?? false;
  const hasAgents = (activeWs?.agents.length ?? 0) > 0;

  // The agent a Send would go to: first @mention in the draft, else the
  // default agent. The primary button morphs to Stop while it is busy.
  const [mentionTarget, setMentionTarget] = useState<string | null>(null);
  const targetAgent = useMemo(() => {
    if (!activeWs || activeWs.agents.length === 0) return null;
    if (mentionTarget) {
      const hit = activeWs.agents.find((a) => a.name === mentionTarget);
      if (hit) return hit;
    }
    return activeWs.agents.find((a) => a.isDefault) ?? activeWs.agents[0];
  }, [activeWs, mentionTarget]);
  const targetBusy = !!targetAgent && agentQueues(targetAgent);
  const othersRunning = activeWs?.agents.some((a) => a.busy && a.id !== targetAgent?.id) ?? false;

  useEffect(() => {
    selectCommandAgent(activeWs?.id ?? null, targetAgent?.id ?? null);
  }, [activeWs?.id, targetAgent?.id, selectCommandAgent]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startW = sidebarWidth;

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const w = Math.max(150, Math.min(500, startW + ev.clientX - startX));
        setSidebarWidth(w);
      };

      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  const mentionAgents =
    activeWs?.agents.filter((a) => {
      if (mentionQuery === null) return false;
      if (mentionQuery === "") return true;
      return a.name.toLowerCase().startsWith(mentionQuery.toLowerCase());
    }) ?? [];

  const filteredCmds = commands.filter((c) => {
    if (cmdQuery === null) return false;
    if (cmdQuery === "") return true;
    return c.name.toLowerCase().startsWith(cmdQuery.toLowerCase());
  });

  const setDivText = useCallback(
    (text: string) => {
      if (activeWsId) inputMapRef.current.set(activeWsId, text);
      const el = textareaRef.current;
      if (el) {
        el.value = text;
        el.focus();
        el.selectionStart = el.selectionEnd = text.length;
        el.style.height = "36px";
        el.style.height = Math.min(el.scrollHeight, 120) + "px";
      }
      setHasInput(text.trim().length > 0);
    },
    [activeWsId],
  );

  // Lines picked in the Files panel, quoted into the composer under their
  // path (relative to the session's folder when inside it; in backticks, so
  // an absolute one does not open the message as a slash command), ready for
  // the question. A panel covering the composer (a phone's, a maximised
  // one) steps aside.
  const askAbout = useCallback(
    (q: CodeQuote) => {
      const cwd = activeWsRef.current?.cwd;
      const path = cwd && q.path.startsWith(`${cwd}/`) ? q.path.slice(cwd.length + 1) : q.path;
      const where = `\`${path}:${q.to > q.from ? `${q.from}-${q.to}` : q.from}\``;
      const longest = Math.max(0, ...(q.text.match(/`{3,}/g) ?? []).map((m) => m.length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      const quote = `${where}\n${fence}${q.lang ?? ""}\n${q.text}\n${fence}\n`;
      const draft = textareaRef.current?.value ?? "";
      setDivText(draft.trim() ? `${draft.trimEnd()}\n\n${quote}` : quote);
      if (window.matchMedia?.(PHONE).matches) setOpenPanel(null);
      setMaxFor(null);
    },
    [setDivText],
  );

  // From the board: open the project's lead with the objective named in the
  // composer, ready for the question.
  const askLead = useCallback(
    (objectiveId: string) => {
      const project = projectsRef.current.find((p) => p.id === boardProjectId);
      if (project?.status === "sealed") return;
      const leadId = project?.leadWorkspaceId ?? project?.lead?.workspaceId;
      if (!leadId) return;
      // Added to whatever was being written to the lead, not in its place.
      const onLead = activeWsIdRef.current === leadId;
      const draft = onLead
        ? (textareaRef.current?.value ?? "")
        : (inputMapRef.current.get(leadId) ?? "");
      const text = draft.trim()
        ? `${draft.trimEnd()}\nAbout ${objectiveId}: `
        : `About ${objectiveId}: `;
      setBoardProjectId(null);
      if (onLead) {
        setDivText(text);
        return;
      }
      inputMapRef.current.set(leadId, text);
      focusComposerRef.current = true;
      openWorkspace(leadId);
    },
    [boardProjectId, setDivText, openWorkspace],
  );
  const openSessionFromBoard = useCallback(
    (id: string) => {
      setBoardProjectId(null);
      openWorkspace(id);
    },
    [openWorkspace],
  );

  const applyCommand = useCallback(
    (cmdName: string) => {
      setDivText(`/${cmdName} `);
      setCmdQuery(null);
      textareaRef.current?.focus();
    },
    [setDivText],
  );

  const applyMention = useCallback(
    (agentName: string) => {
      const val = textareaRef.current?.value ?? "";
      const atIdx = val.lastIndexOf("@");
      if (atIdx !== -1) {
        setDivText(val.slice(0, atIdx) + `@${agentName} `);
      }
      setMentionQuery(null);
      textareaRef.current?.focus();
    },
    [setDivText],
  );

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newImages = files
      .filter((f) => f.type.startsWith("image/"))
      .map((file) => ({ file, preview: URL.createObjectURL(file) }));
    setPendingImages((prev) => [...prev, ...newImages]);
    e.target.value = "";
  }, []);

  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // Set while a send is in flight (uploading, or waiting on a liveness probe)
  // so a second tap cannot send the same draft twice.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const handleSend = useCallback(async () => {
    const text = (textareaRef.current?.value ?? "").trim();
    const ws = activeWsRef.current;
    if (
      (!text && pendingImages.length === 0) ||
      !ws ||
      activeProjectRef.current?.status === "sealed" ||
      sendingRef.current
    ) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    let sent = false;
    try {
      let images: Array<{ name: string; url: string }> | undefined;
      if (pendingImages.length > 0) {
        setUploading(true);
        try {
          images = await Promise.all(pendingImages.map(({ file }) => uploadImage(file)));
        } catch (e) {
          console.error("Image upload failed:", e);
          alert(`Image upload failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        } finally {
          setUploading(false);
        }
      }
      sent = await sendMessage(
        ws.id,
        text,
        undefined,
        images,
        quotedMsg
          ? { messageId: quotedMsg.id, agentId: quotedMsg.agentId, content: quotedMsg.content }
          : undefined,
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    // Not sent: the draft, images and quote stay for another try.
    if (!sent) return;
    if (pendingImages.length > 0) {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
      setPendingImages([]);
    }
    setQuotedMsg(null);
    inputMapRef.current.set(ws.id, "");
    // A send held by a liveness probe can complete after the reader moved to
    // another workspace or kept typing: that draft is not the one sent.
    const el = textareaRef.current;
    if (activeWsRef.current?.id !== ws.id) return;
    if (el && el.value.trim() !== text) {
      inputMapRef.current.set(ws.id, el.value);
      return;
    }
    setMentionQuery(null);
    setCmdQuery(null);
    if (el) {
      el.value = "";
      el.style.height = "36px";
    }
    setHasInput(false);
  }, [sendMessage, pendingImages, quotedMsg]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isImeKeyEvent(e, composingRef.current, compositionEndTsRef.current)) return;
    if (cmdQuery !== null && filteredCmds.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdIdx((i) => (i + 1) % filteredCmds.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCmdIdx((i) => (i - 1 + filteredCmds.length) % filteredCmds.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyCommand(filteredCmds[cmdIdx].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCmdQuery(null);
        return;
      }
    }
    if (mentionQuery !== null && mentionAgents.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionAgents.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionAgents.length) % mentionAgents.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(mentionAgents[mentionIdx].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const currentDialog = pendingDialogs
    .filter((dialog) => dialog.workspaceId === activeWsId)
    .sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId))[0];
  const otherDialog = pendingDialogs
    .filter((dialog) => dialog.workspaceId !== activeWsId)
    .sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId))[0];
  const otherDialogCount = new Set(
    pendingDialogs
      .filter((dialog) => dialog.workspaceId !== activeWsId)
      .map((dialog) => dialog.workspaceId),
  ).size;

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    const val = el.value;
    const has = val.trim().length > 0;
    if (has !== hasInput) setHasInput(has);
    if (activeWsId) inputMapRef.current.set(activeWsId, val);
    setMentionTarget(val.match(/(?:^|\s)@(\S+)/)?.[1] ?? null);

    el.style.height = "36px";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";

    const before = val.slice(0, el.selectionStart);

    const atMatch = before.match(/@(\w*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionIdx(0);
    } else {
      setMentionQuery(null);
    }

    const cmdMatch = val.match(/^\/([\w-]*)$/);
    if (cmdMatch) {
      setCmdQuery(cmdMatch[1]);
      setCmdIdx(0);
    } else {
      setCmdQuery(null);
    }
  };

  return (
    <SessionLinkContext.Provider value={sessionLinks}>
      <div className="app" ref={appRef}>
        {notice && (
          <div className="info-toast" onClick={() => setNotice(null)} title="Dismiss">
            {notice}
          </div>
        )}
        {lastError && (
          <div className="error-toast" onClick={clearError} title="Dismiss">
            ⚠ {lastError}
          </div>
        )}
        {otherDialog && (
          <div className="ui-dialog-alert" role="alert">
            <span>
              {otherDialogCount} other session{otherDialogCount === 1 ? "" : "s"} waiting for your
              response
            </span>
            <button type="button" onClick={() => onSelectWorkspace(otherDialog.workspaceId)}>
              Open session
            </button>
          </div>
        )}
        {(sidebarOpen || sidebarShield) && (
          <div
            className={`sidebar-overlay${sidebarOpen ? "" : " closing"}`}
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div
          className={`sidebar${sidebarOpen ? " sidebar-open" : ""}`}
          style={{ width: sidebarWidth }}
        >
          <Sidebar
            workspaces={workspaces}
            projects={projects}
            activeWsId={activeWsId}
            connected={connected}
            groupOverrides={groupOverrides}
            finishedStatus={finishedStatus}
            searchQuery={searchQuery}
            searchHits={searchHits}
            quota={quota}
            onRefreshQuota={refreshQuota}
            systemStatus={systemStatus}
            onSelect={onSelectWorkspace}
            onDelete={onDeleteWorkspace}
            onDeleteProject={askDeleteProject}
            onToggleGroup={toggleGroup}
            onSearchChange={setSearchQuery}
            onJump={jumpToMessage}
            onCreate={onCreateWorkspace}
            onCreateProject={() => setShowCreateProject(true)}
            onCreateIn={onCreateWorkspaceIn}
            onReplayDemo={onReplayDemo}
            onPurgeArchived={onPurgeArchived}
            onArchiveProject={onArchiveProject}
            onRenameProject={renameProject}
            onRestoreProject={onRestoreProject}
            onDebugSnapshot={takeSnapshot}
          />
        </div>

        <div className="resize-handle" onMouseDown={onResizeStart} />

        <div className="main-panel">
          {activeWs ? (
            <>
              <div className="panel-header" ref={headerRef}>
                <div className="panel-header-top">
                  <button className="mobile-menu-btn" onClick={() => setSidebarOpen(true)}>
                    &#9776;
                  </button>
                  <span className="panel-title" title={headerTitle(activeWs)}>
                    {headerTitle(activeWs)}
                  </span>
                  <button
                    className="agents-chip"
                    aria-pressed={openPanel === "agents"}
                    title="Agents and sessions"
                    onClick={() => togglePanel("agents")}
                  >
                    <span className="agents-chip-avatars">
                      {activeWs.agents.slice(0, 3).map((a) => (
                        <AgentAvatar key={a.id} agent={a} size={20} />
                      ))}
                    </span>
                    <span
                      className={`agent-status-dot agent-status-${chipDot(activeWs, connected)}`}
                    />
                    <span className="agents-chip-label">{chipLabel(activeWs, connected)}</span>
                  </button>
                </div>
                <div className="workspace-info-bar">
                  <span className="ws-info-item" title={activeWs.cwd}>
                    <span className="ws-info-icon">&#128193;</span>
                    <span className="ws-info-path">
                      <bdi>{activeWs.cwd}</bdi>
                    </span>
                  </span>
                  <GitBar git={activeWs.git ?? null} pr={activeWs.pr ?? null} />
                  {projectSealed && (
                    <span className="sealed-badge" title={activeProject?.sealedReason ?? undefined}>
                      Sealed · read-only
                    </span>
                  )}
                  <span className="ws-info-spacer" />
                  {/* Phones: the panels' rail shares the branch's line. */}
                  <Rail className="header-rail" items={railItems} />
                  {!projectSealed && (
                    <ReportSwitch
                      link={activeWs.projectLink}
                      onSet={(reports) => setReporting(activeWs.id, reports)}
                    />
                  )}
                  {/* A lead goes with its project. */}
                  {!projectSealed &&
                  activeWs.archivedAt == null &&
                  activeWs.projectLink?.role !== "lead" ? (
                    <button
                      className="btn-ghost ws-archive-btn"
                      title="Archive: unload history from memory and stop idle sessions"
                      disabled={isAnyRunning}
                      onClick={() => archiveWorkspace(activeWs.id)}
                    >
                      Archive
                    </button>
                  ) : null}
                </div>
                {projectSealed && (
                  <div className="sealed-banner" role="status">
                    This project is sealed. History, objectives, issues and notes are read-only.
                    {activeProject?.sealedReason ? ` Reason: ${activeProject.sealedReason}` : ""}
                  </div>
                )}
                {activeWs.archivedAt != null && (
                  <div className="archived-banner">
                    <span>
                      Archived {formatRelative(activeWs.archivedAt)}
                      {archiveAfterDays > 0 ? ` · idle for over ${archiveAfterDays} days` : ""}.
                      Sending a message restores it.
                    </span>
                    {!projectSealed && (
                      <button
                        className="btn-inline"
                        onClick={() => unarchiveWorkspace(activeWs.id)}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="messages" ref={messagesContainerRef} onScroll={onMessagesScrollTrack}>
                <FileOpenContext.Provider value={fileOpener(activeWs.id)}>
                  {(() => {
                    const msgs = activeWs.messages;
                    const total = msgs.length;
                    if (!activeWs.messagesLoaded) {
                      return (
                        <HistoryHint hasMore={false} loading={false} loaded={false} count={0} />
                      );
                    }
                    if (total === 0) {
                      return (
                        <div className="empty-state">
                          {activeWs.agents.length === 0
                            ? "Add an agent to get started."
                            : "Send a message to start working."}
                        </div>
                      );
                    }
                    return (
                      <>
                        <HistoryHint
                          hasMore={!!activeWs.hasMore}
                          loading={!!activeWs.loadingOlder}
                          loaded
                          count={total}
                        />
                        {msgs.map((msg, i) => {
                          const prev = i > 0 ? msgs[i - 1] : null;
                          const compact =
                            !!prev &&
                            msg.kind === "agent" &&
                            prev.kind === "agent" &&
                            !!msg.turnId &&
                            msg.turnId === prev.turnId;
                          const item = (
                            <MessageItem
                              user={user}
                              msg={msg}
                              agents={msg.status === "streaming" ? activeWs.agents : settledAgents}
                              compact={compact}
                              highlight={msg.id === highlightMsgId}
                              onQuote={handleQuote}
                              onJumpToMessage={jumpToMessageInActiveWs}
                              onLoadSubagentEvents={onLoadSubagentEvents}
                              onCancelSubagent={onCancelSubagent}
                              onCancelQueued={onCancelQueued}
                              onLoadDetails={onLoadDetails}
                              onOpenWorkspace={openWorkspace}
                            />
                          );
                          const from = msg.from?.workspaceId;
                          return (
                            <MessageBoundary key={msg.id} messageId={msg.id}>
                              {from && from !== activeWs.id && workspaceIds.has(from) ? (
                                <FileOpenContext.Provider value={fileOpener(from)}>
                                  {item}
                                </FileOpenContext.Provider>
                              ) : (
                                item
                              )}
                            </MessageBoundary>
                          );
                        })}
                      </>
                    );
                  })()}
                </FileOpenContext.Provider>
                <div ref={messagesEndRef} />
              </div>

              <div className="input-area">
                {quotedMsg &&
                  (() => {
                    const canJump = quotedMsg.wsId === activeWs.id;
                    const QuotePreview = canJump ? "button" : "div";
                    const qa = workspaces
                      .find((ws) => ws.id === quotedMsg.wsId)
                      ?.agents.find((a) => a.id === quotedMsg.agentId);
                    const author =
                      qa?.name ?? (quotedMsg.from ? originLabel(quotedMsg.from) : "User");
                    const preview =
                      quotedMsg.content.slice(0, 100) +
                      (quotedMsg.content.length > 100 ? "..." : "");
                    return (
                      <div className="quote-bar">
                        <QuotePreview
                          className="quote-bar-content"
                          {...(canJump && {
                            type: "button" as const,
                            title: "Jump to quoted message",
                            "aria-label": `Jump to quoted message from ${author}: ${preview}`,
                            onClick: () => jumpToMessageInActiveWs(quotedMsg.id),
                          })}
                        >
                          <span className="quote-bar-agent">
                            {qa ? (
                              <AgentAvatar agent={qa} size={16} />
                            ) : quotedMsg.from ? (
                              "◆"
                            ) : (
                              "👤"
                            )}{" "}
                            {author}
                          </span>
                          <span className="quote-bar-preview">{preview}</span>
                        </QuotePreview>
                        <button
                          type="button"
                          className="quote-bar-close"
                          title="Remove quote"
                          onClick={() => setQuotedMsg(null)}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })()}
                {cmdQuery !== null && filteredCmds.length > 0 && (
                  <div className="command-popup">
                    {filteredCmds.map((cmd, i) => (
                      <div
                        key={`${cmd.source ?? "unknown"}:${cmd.name}:${i}`}
                        className={`command-item ${i === cmdIdx ? "active" : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyCommand(cmd.name);
                        }}
                      >
                        <span className="command-name">/{cmd.name}</span>
                        {cmd.source && <span className="command-source">{cmd.source}</span>}
                        {cmd.argumentHint && (
                          <span className="command-hint">{cmd.argumentHint}</span>
                        )}
                        <span className="command-desc">{cmd.description}</span>
                      </div>
                    ))}
                  </div>
                )}
                {mentionQuery !== null && mentionAgents.length > 0 && (
                  <div className="mention-popup">
                    {mentionAgents.map((a, i) => (
                      <div
                        key={a.id}
                        className={`mention-item ${i === mentionIdx ? "active" : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyMention(a.name);
                        }}
                      >
                        <AgentAvatar agent={a} size={20} />
                        <span className="mention-name">{a.name}</span>
                        <span className="mention-model">{shortModel(a.model)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {pendingImages.length > 0 && (
                  <div className="image-preview-strip">
                    {pendingImages.map((img, i) => (
                      <div key={i} className="image-preview-item">
                        <img src={img.preview} alt={img.file.name} />
                        <button
                          className="image-preview-remove"
                          onClick={() => removePendingImage(i)}
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <ExtensionUi
                  workspace={activeWs}
                  ui={extensionUi}
                  placement="aboveEditor"
                  dismiss={dismissNotice}
                />
                <div className="input-row">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={handleFileSelect}
                  />
                  <button
                    className="btn-attach"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!hasAgents || projectSealed}
                    title="Attach image"
                  >
                    +
                  </button>
                  <textarea
                    ref={textareaRef}
                    className="chat-input"
                    name="chat-message"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={handleTextareaChange}
                    onKeyDown={handleKeyDown}
                    onCompositionStart={() => {
                      composingRef.current = true;
                    }}
                    onCompositionEnd={(e) => {
                      composingRef.current = false;
                      compositionEndTsRef.current = e.timeStamp;
                    }}
                    onPaste={(e) => {
                      const imgs = extractImageFiles(e.clipboardData);
                      if (imgs.length === 0) return;
                      e.preventDefault();
                      setPendingImages((prev) => [
                        ...prev,
                        ...imgs.map((file) => ({ file, preview: URL.createObjectURL(file) })),
                      ]);
                    }}
                    disabled={!hasAgents || projectSealed}
                    placeholder={
                      projectSealed
                        ? "Project sealed · read-only"
                        : window.matchMedia?.(PHONE).matches
                          ? activeWs.agents.length > 1
                            ? "Message, or @ an agent"
                            : "Message, or / for commands"
                          : activeWs.agents.length > 1
                            ? "Type / for commands, @ to mention an agent..."
                            : "Type / for commands, or send a message..."
                    }
                    rows={1}
                  />
                  {othersRunning && !projectSealed && (
                    <button
                      className="btn-abort btn-abort-others"
                      title="Stop what every agent is doing now; background tasks keep going"
                      onClick={() => interrupt(activeWs.id)}
                    >
                      <span className="btn-text">Stop all</span>
                      <span className="btn-icon" aria-hidden="true">
                        ⏹
                      </span>
                    </button>
                  )}
                  {targetBusy && !projectSealed && (
                    <button
                      className="btn-abort"
                      title={`Stop ${targetAgent.name}'s turn; background tasks keep going`}
                      onClick={() => interrupt(activeWs.id, targetAgent.id)}
                    >
                      ◼
                    </button>
                  )}
                  <button
                    className="btn-primary-slot"
                    onClick={() => {
                      void handleSend();
                    }}
                    disabled={
                      (!hasInput && pendingImages.length === 0) ||
                      !hasAgents ||
                      sending ||
                      uploading ||
                      projectSealed
                    }
                    aria-busy={sending || uploading || undefined}
                    title={
                      targetBusy
                        ? `${targetAgent.name} is busy — message will run next`
                        : targetAgent && activeWs.agents.length > 1
                          ? `Send to ${targetAgent.name}`
                          : "Send"
                    }
                  >
                    <span className="btn-text">
                      {uploading ? "Uploading..." : targetBusy ? "Queue" : "Send"}
                    </span>
                    <span className="btn-icon" aria-hidden="true">
                      {uploading ? "…" : targetBusy ? "⇥" : "↑"}
                    </span>
                  </button>
                </div>
                <ExtensionUi
                  workspace={activeWs}
                  ui={extensionUi}
                  placement="belowEditor"
                  dismiss={dismissNotice}
                />
              </div>
            </>
          ) : (
            <>
              <div className="empty-header mobile-only">
                <button className="mobile-menu-btn" onClick={() => setSidebarOpen(true)}>
                  &#9776;
                </button>
                <span>Agent Team</span>
              </div>
              <div className="empty-state">
                {workspaces.length === 0
                  ? "No workspaces yet. Click + to create one."
                  : "Select a workspace."}
              </div>
            </>
          )}
        </div>

        {activeWs && openPanel === "agents" && (
          <SidePanel
            title="Agents"
            subtitle={scopeSummary(panelSessions, overview ? activeProject : undefined)}
            pinned={panelPinned}
            maximized={panelMax}
            inset={sidebarWidth}
            width={listWidth}
            onPin={togglePin}
            onMaximize={toggleMax}
            onClose={closePanel}
            onWidth={setListWidth}
          >
            <AgentsPanel
              sessions={panelSessions}
              project={activeProject}
              activeWsId={activeWsId}
              connected={connected}
              models={models}
              codexAuth={codexAuth}
              onOpenCodexSetup={openCodexSetup}
              actions={agentActions}
              overview={overview}
            />
          </SidePanel>
        )}
        {files && openPanel === "files" && (
          <SidePanel
            title="Files"
            subtitle={activeProject?.name ?? activeWs?.name}
            kind="wide"
            pinned={panelPinned}
            maximized={panelMax}
            inset={sidebarWidth}
            width={filesWidth}
            onPin={togglePin}
            onMaximize={toggleMax}
            onClose={closePanel}
            onWidth={setFilesWidth}
            flush
          >
            <FilesPanel
              key={`${files.wsId}:${files.seq}`}
              wsId={files.wsId}
              target={files.ref}
              roots={roots}
              onAsk={askAbout}
              onOpen={keepFile}
            />
          </SidePanel>
        )}
        {activeWs && openPanel === "changes" && (
          <SidePanel
            title="Changes"
            subtitle={activeWs.name}
            kind="wide"
            pinned={panelPinned}
            maximized={panelMax}
            inset={sidebarWidth}
            width={filesWidth}
            onPin={togglePin}
            onMaximize={toggleMax}
            onClose={closePanel}
            onWidth={setFilesWidth}
            flush
          >
            <FilesPanel
              key={activeWs.id}
              wsId={activeWs.id}
              target={{ path: activeWs.cwd }}
              roots={roots}
              onAsk={askAbout}
              changesOnly
              openFile={(path) => showFile(activeWs.id, { path }, fileScope)}
            />
          </SidePanel>
        )}
        {activeWs && <Rail className="side-rail" items={railItems} />}

        {showCreateProject && (
          <CreateProjectDialog
            onClose={() => setShowCreateProject(false)}
            onCreate={createProject}
          />
        )}

        {showCreate && (
          <CreateWorkspaceDialog
            hosts={hosts}
            onClose={() => setShowCreate(false)}
            onCreate={createWorkspace}
            onListDirs={listDirs}
            dirSuggestions={dirSuggestions}
            initialPath={createInPath}
            projectFolders={projectFolders}
          />
        )}

        {purgeScope && (
          <ConfirmDialog
            title="Delete archived sessions"
            body={purgeBody(workspaces, projects, purgeScope.projectId)}
            confirmLabel="Delete all"
            danger
            onConfirm={() => purgeArchived(purgeScope.projectId)}
            onClose={closePurge}
          />
        )}

        {boardProject && (
          <BoardPage
            project={boardProject}
            issues={issues[boardProject.id] ?? NO_ISSUES}
            sessions={boardSessions}
            onClose={closeBoard}
            onOpenSession={openSessionFromBoard}
            onAskLead={
              boardProject.status !== "sealed" &&
              (boardProject.leadWorkspaceId ?? boardProject.lead?.workspaceId) &&
              workspaces.some(
                (w) => w.id === (boardProject.leadWorkspaceId ?? boardProject.lead?.workspaceId),
              )
                ? askLead
                : null
            }
            onRename={onRenameProject}
            onArchive={boardProject.status === "sealed" ? undefined : onArchiveBoardProject}
            onSeal={boardProject.status === "sealed" ? undefined : onSealBoardProject}
            onDelete={onDeleteBoardProject}
          />
        )}

        {sealingProjectId && (
          <ConfirmDialog
            title="Seal project"
            body="Sealing stops its sessions and makes its history, board and notes permanently read-only."
            confirmLabel="Seal project"
            danger
            onConfirm={() => sealProject(sealingProjectId)}
            onClose={() => setSealingProjectId(null)}
          />
        )}

        {deletingProjectId &&
          (() => {
            const project = projects.find((p) => p.id === deletingProjectId);
            if (!project) return null;
            const sessions = workspaces.filter(
              (w) => w.projectLink?.projectId === project.id && w.projectLink.role === "worker",
            ).length;
            const kept =
              sessions === 0
                ? ""
                : sessions === 1
                  ? " The session it started stays as a plain workspace."
                  : ` The ${sessions} sessions it started stay as plain workspaces.`;
            return (
              <ConfirmDialog
                title={`Delete project ${project.name}`}
                body={`Deletes its lead session, objectives and notes.${kept}`}
                confirmLabel="Delete project"
                danger
                onConfirm={() => deleteProject(project.id)}
                onClose={closeDeleteProject}
              />
            );
          })()}

        {currentDialog && (
          <UiDialogModal
            key={uiDialogKey(currentDialog)}
            dialog={currentDialog}
            onRespond={respondUiDialog}
          />
        )}

        {addAgentFor && !projectSealed && (
          <AddAgentDialog
            presets={presets}
            models={models}
            codexAuth={codexAuth}
            onOpenCodexSetup={openCodexSetup}
            suspended={showCodexSetup}
            onClose={() => setAddAgentFor(null)}
            onAdd={(name, model, avatar, color, effort) =>
              addAgent(addAgentFor, name, model, avatar, color, effort)
            }
          />
        )}

        {showCodexSetup && (
          <CodexSetupDialog
            codexAuth={codexAuth}
            rechecking={recheckingCodexAuth}
            onRecheck={recheckCodexAuth}
            onClose={closeCodexSetup}
          />
        )}
      </div>
    </SessionLinkContext.Provider>
  );
}

// Project leads survive a purge (server: purge_archived).
// "name — folder", unless the name already starts with the folder's
// ("clice · lead" of the project clice).
function headerTitle(ws: Workspace): string {
  return ws.name === ws.project || ws.name.startsWith(`${ws.project} `)
    ? ws.name
    : `${ws.name} — ${ws.project}`;
}

function purgeBody(workspaces: Workspace[], projects: Project[], projectId: string | null): string {
  const known = new Set(projects.map((p) => p.id));
  const project = projects.find((p) => p.id === projectId);
  // A project's lead is never purged: the project goes with it.
  const doomed = workspaces.filter((w) => {
    const link = w.projectLink && known.has(w.projectLink.projectId) ? w.projectLink : null;
    if (w.archivedAt == null || link?.role === "lead") return false;
    return projectId === null ? !link : link?.projectId === projectId;
  });
  const whose = project ? ` of ${project.name}` : " that belong to no project";
  return `Permanently delete the ${doomed.length} archived session(s)${whose}, with their message history and logs.`;
}

type PanelId = "agents" | "files" | "changes";
const WORKSPACE_ROOT: FileRef = { path: "." };
// Where side panels become full-screen sheets (styles.css).
const PHONE = "(max-width: 768px), (max-height: 500px)";

// The page is in front of the user: visible, focused, and touched in the
// last few minutes (a desktop left on reads nothing for the phone).
const IDLE_MS = 5 * 60_000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
function usePageAttended(): boolean {
  const [present, setPresent] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  // A page that reloaded itself waits for a touch.
  const [reloaded] = useState(() => {
    try {
      const yes = sessionStorage.getItem(AUTO_RELOAD) !== null;
      sessionStorage.removeItem(AUTO_RELOAD);
      return yes;
    } catch {
      return false;
    }
  });
  const [active, setActive] = useState(!reloaded);
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const touched = () => {
      // Pointer moves come many a second; the timer restarts at most every 10s.
      if (Date.now() - last < 10_000 && idle) return;
      last = Date.now();
      setActive(true);
      clearTimeout(idle);
      idle = setTimeout(() => setActive(false), IDLE_MS);
    };
    const update = () => {
      const now = document.visibilityState === "visible" && document.hasFocus();
      setPresent(now);
      if (now) touched();
    };
    if (!reloaded) touched();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    for (const e of INPUT_EVENTS) window.addEventListener(e, touched, { passive: true });
    return () => {
      clearTimeout(idle);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, touched);
    };
  }, [reloaded]);
  return present && active;
}

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts for the session.
  }
}

// A panel width the user dragged to, saved; null for the automatic one.
function useSavedWidth(key: string): [number | null, (width: number | null) => void] {
  const [width, setWidth] = useState(() => Number(readSetting(key)) || null);
  const save = useCallback(
    (w: number | null) => {
      setWidth(w);
      writeSetting(key, w === null ? null : String(w));
    },
    [key],
  );
  return [width, save];
}

// The header chip for the open workspace's agents: one agent's own state, or
// the counts for several.
function chipLabel(ws: Workspace, connected: boolean): string {
  if (ws.agents.length === 0) return "No agents";
  if (ws.agents.length === 1) return pillLabel(ws.agents[0], connected);
  if (!connected) return `${ws.agents.length} agents · offline`;
  const busy = stateSummary(
    ws.agents.map((a) => {
      const s = agentState(a);
      return s === "working" || s === "waiting" || s === "sleeping" ? s : "idle";
    }),
  );
  return `${ws.agents.length} agents · ${busy}`;
}

function chipDot(ws: Workspace, connected: boolean): string {
  const s = sessionState(ws);
  if (s === "working") return "busy";
  if (s === "waiting" || s === "sleeping") return s;
  return connected ? "online" : "offline";
}
