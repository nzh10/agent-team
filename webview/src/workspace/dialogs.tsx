import { useState, useRef, useEffect, useMemo } from "react";
import { EffortSelect, effortOf } from "./EffortSelect";
import type { AgentPreset, CodexAuthState, ModelOption, HostInfo } from "../state/useServer";
import { isImageAvatar } from "./avatar";
import { DialogFrame } from "./DialogFrame";
import { copyText } from "../chat/clipboard";

import { CODEX_SETUP_VALUE, isCodexSetup, needsCodexSetup, usableModels } from "./models";
export const CODEX_LOGIN_COMMAND = "npx codex login";

// Small modal confirmation used for destructive actions (purging archived
// workspaces). Enter confirms, Escape cancels.
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <DialogFrame title={title} className="dialog-confirm" onClose={onClose}>
      <p className="dialog-body">{body}</p>
      <div className="dialog-actions">
        <button
          data-dialog-focus={danger ? "" : undefined}
          type="button"
          className="btn-secondary"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          data-dialog-focus={danger ? undefined : ""}
          type="button"
          className={danger ? "btn-danger" : "btn-primary"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </DialogFrame>
  );
}

const BACKEND_GROUPS: Array<[ModelOption["backend"], string]> = [
  ["pi", "Pi"],
  ["codex", "Codex"],
];

function defaultAddSelection(
  selectableModels: ModelOption[],
  preset: AgentPreset | undefined,
  fallback: string,
) {
  const available = selectableModels.find((m) => m.id === preset?.model);
  const model = available?.id ?? fallback;
  const effort =
    (!preset?.model || available) &&
    preset?.effort &&
    effortOf(selectableModels, model).levels.includes(preset.effort)
      ? preset.effort
      : "";
  return { model, effort };
}

export function AddAgentDialog({
  presets,
  models,
  codexAuth,
  onOpenCodexSetup,
  suspended = false,
  onClose,
  onAdd,
}: {
  presets: AgentPreset[];
  models: ModelOption[];
  codexAuth?: CodexAuthState | null;
  onOpenCodexSetup?: () => void;
  suspended?: boolean;
  onClose: () => void;
  onAdd: (name: string, model: string, avatar: string, color: string, effort?: string) => void;
}) {
  const showCodexHint = needsCodexSetup(codexAuth);
  const selectableModels = useMemo(() => usableModels(models, codexAuth), [codexAuth, models]);

  const [selectedPreset, setSelectedPreset] = useState(0);
  const initial = defaultAddSelection(selectableModels, presets[0], selectableModels[0]?.id ?? "");
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState(initial.effort);

  // When models refresh live (e.g. after signing in to Codex and clicking
  // Re-check), pick a valid model if nothing usable was selected yet.
  useEffect(() => {
    if (model && selectableModels.some((m) => m.id === model)) return;
    const next = defaultAddSelection(
      selectableModels,
      presets[selectedPreset],
      selectableModels[0]?.id ?? "",
    );
    setModel(next.model);
    setEffort(next.effort);
  }, [selectableModels, model, presets, selectedPreset]);

  const chooseModel = (next: string) => {
    if (isCodexSetup(next)) {
      onOpenCodexSetup?.();
      return;
    }
    setModel(next);
    if (!effortOf(selectableModels, next).levels.includes(effort)) setEffort("");
  };
  const [customName, setCustomName] = useState("");

  const preset = presets[selectedPreset];
  const finalName = customName || preset?.name || "Agent";

  return (
    <DialogFrame title="Add Agent" onClose={onClose} suspended={suspended}>
      <div className="preset-grid">
        {presets.map((p, i) => (
          <div
            key={p.name}
            className={`preset-item ${i === selectedPreset ? "selected" : ""}`}
            onClick={() => {
              setSelectedPreset(i);
              if (p.model || p.effort) {
                const next = defaultAddSelection(selectableModels, p, model);
                setModel(next.model);
                setEffort(next.effort);
              }
              setCustomName("");
            }}
          >
            <div
              className="agent-avatar"
              style={{
                width: 36,
                height: 36,
                background: isImageAvatar(p.avatar) ? "transparent" : p.color,
                fontSize: 18,
              }}
            >
              {isImageAvatar(p.avatar) ? (
                <img
                  src={p.avatar}
                  alt={p.name}
                  style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover" }}
                />
              ) : (
                p.avatar
              )}
            </div>
            <span>{p.name}</span>
          </div>
        ))}
      </div>

      <label className="dialog-field">
        <span>Name (or use preset)</span>
        <input
          data-dialog-focus
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          placeholder={preset?.name}
        />
      </label>

      <div className="dialog-field">
        <label className="dialog-field-label" htmlFor="add-agent-model">
          Model
        </label>
        <select id="add-agent-model" value={model} onChange={(e) => chooseModel(e.target.value)}>
          {selectableModels.length === 0 && (
            <option value="" disabled>
              No models available
            </option>
          )}
          {BACKEND_GROUPS.map(([backend, label]) => {
            const group = selectableModels.filter((m) => m.backend === backend);
            if (group.length > 0) {
              return (
                <optgroup key={backend} label={label}>
                  {group.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              );
            }
            if (backend === "codex" && showCodexHint) {
              return (
                <optgroup key={backend} label={label}>
                  <option value={CODEX_SETUP_VALUE} className="codex-unauth-option">
                    Codex (not signed in)
                  </option>
                </optgroup>
              );
            }
            return null;
          })}
        </select>
        {showCodexHint && onOpenCodexSetup && (
          <button type="button" className="codex-auth-hint" onClick={onOpenCodexSetup}>
            Sign in to Codex…
          </button>
        )}
      </div>

      {effortOf(selectableModels, model).levels.length > 0 && (
        <label className="dialog-field">
          <span>Effort</span>
          <EffortSelect
            {...effortOf(selectableModels, model)}
            value={effort}
            onChange={setEffort}
            label="Reasoning effort"
            fresh
          />
        </label>
      )}

      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!model}
          onClick={() => {
            if (!model) return;
            onAdd(
              finalName,
              model,
              preset?.avatar ?? "🤖",
              preset?.color ?? "#888",
              effort || undefined,
            );
            onClose();
          }}
        >
          Add
        </button>
      </div>
    </DialogFrame>
  );
}

export function CodexSetupDialog({
  codexAuth,
  rechecking,
  onRecheck,
  onClose,
}: {
  codexAuth: CodexAuthState | null;
  rechecking: boolean;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [checkRequested, setCheckRequested] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sawRecheckingRef = useRef(false);

  useEffect(() => {
    return () => clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    if (rechecking) {
      sawRecheckingRef.current = true;
      return;
    }
    if (sawRecheckingRef.current && codexAuth?.authenticated) {
      sawRecheckingRef.current = false;
      onClose();
    }
  }, [rechecking, codexAuth?.authenticated, onClose]);

  const handleCopy = async () => {
    const ok = await copyText(CODEX_LOGIN_COMMAND);
    setCopyState(ok ? "copied" : "failed");
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState("idle"), 2000);
  };

  const handleRecheck = () => {
    setCheckRequested(true);
    onRecheck();
  };

  const statusNote = (() => {
    if (rechecking) return null;
    if (codexAuth?.authenticated) return "Codex is signed in.";
    if (!checkRequested) return null;
    if (codexAuth?.status === "error" && codexAuth.error) {
      return `Check failed: ${codexAuth.error}`;
    }
    if (codexAuth?.status === "unavailable") {
      return "Codex CLI binary is unavailable on the server.";
    }
    return "Still not signed in. Finish running the command above, then click Re-check.";
  })();

  return (
    <DialogFrame
      title="Sign in to Codex"
      className="dialog-codex-setup"
      overlayClass="dialog-codex-setup-overlay"
      priority={1}
      onClose={onClose}
    >
      <p className="dialog-body">
        Run this command in your terminal to sign in with your Codex account, then re-check to
        unlock Codex models and quota:
      </p>
      <div className="codex-cmd-box">
        <code className="codex-cmd-code">{CODEX_LOGIN_COMMAND}</code>
        <button
          type="button"
          className="btn-secondary codex-copy-btn"
          onClick={() => void handleCopy()}
        >
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
      {statusNote && (
        <p
          className={`codex-auth-status${codexAuth?.authenticated ? " authenticated" : ""}`}
          role="status"
        >
          {statusNote}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
        <button
          data-dialog-focus
          type="button"
          className="btn-primary"
          disabled={rechecking}
          onClick={handleRecheck}
        >
          {rechecking ? "Checking…" : "Re-check"}
        </button>
      </div>
    </DialogFrame>
  );
}

// Projects can be organisational-only: no repository or checkout is needed.
export function CreateProjectDialog({
  hosts = [],
  onListDirs,
  dirSuggestions,
  onClose,
  onCreate,
}: {
  hosts?: HostInfo[];
  onClose: () => void;
  onCreate: (name: string, root: string | null) => void;
} & DirectorySource) {
  const [name, setName] = useState("");
  const [withoutGit, setWithoutGit] = useState(false);
  const local = hosts.find((host) => host.type === "local");
  const {
    path: root,
    field,
    dismiss,
  } = useDirectoryField({
    onListDirs: local?.connected === false ? undefined : onListDirs,
    dirSuggestions,
    disabled: withoutGit,
    label: "Repository path",
    placeholder: withoutGit ? "No repository" : "/path/to/repository",
  });
  const onEscape = () => {
    if (!dismiss()) onClose();
  };
  const canSubmit = name.trim().length > 0 && (withoutGit || root.trim().length > 0);
  return (
    <DialogFrame
      title="New Project"
      onClose={onClose}
      onEscape={onEscape}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onCreate(name.trim(), withoutGit ? null : root.trim());
        onClose();
      }}
    >
      <label className="dialog-field">
        <span>Name</span>
        <input
          data-dialog-focus
          value={name}
          placeholder="Project name…"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {field}
      <label className="dialog-checkbox">
        <input
          type="checkbox"
          checked={withoutGit}
          onChange={(e) => setWithoutGit(e.target.checked)}
        />
        <span>Create without a Git repository</span>
      </label>
      <p className="dialog-help">
        A project without Git still has objectives, issues, notes and a lead session.
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          Create project
        </button>
      </div>
    </DialogFrame>
  );
}

type DirectorySource = {
  onListDirs?: (prefix: string) => void;
  dirSuggestions?: { prefix: string; dirs: string[] };
};

function useDirectoryField({
  onListDirs,
  dirSuggestions,
  initialPath = "",
  disabled = false,
  label,
  placeholder,
}: DirectorySource & {
  initialPath?: string;
  disabled?: boolean;
  label: string;
  placeholder: string;
}) {
  const [dirPath, setDirPath] = useState(initialPath);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      clearTimeout(blurTimerRef.current);
    };
  }, []);

  const requestDirs = (value: string) => {
    clearTimeout(debounceRef.current);
    if (onListDirs) debounceRef.current = setTimeout(() => onListDirs(value), 120);
  };

  // The server echoes the prefix, so stale replies for older input are ignored.
  const suggestions =
    !disabled && onListDirs && dirSuggestions?.prefix === dirPath ? dirSuggestions.dirs : [];

  const handlePathChange = (value: string) => {
    setDirPath(value);
    setSuggestOpen(true);
    setSuggestIdx(0);
    requestDirs(value);
  };

  const pickSuggestion = (dir: string) => {
    setDirPath(dir);
    setSuggestIdx(0);
    requestDirs(dir);
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (!suggestOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      pickSuggestion(suggestions[suggestIdx % suggestions.length]);
    } else if (e.key === "Escape") {
      setSuggestOpen(false);
    }
  };

  const field = (
    <label className="dialog-field path-field">
      <span>{label}</span>
      <input
        value={dirPath}
        disabled={disabled}
        onChange={(e) => handlePathChange(e.target.value)}
        onKeyDown={handlePathKeyDown}
        onFocus={() => {
          clearTimeout(blurTimerRef.current);
          setSuggestOpen(true);
          requestDirs(dirPath);
        }}
        onBlur={() => {
          // Tapping/clicking anywhere else closes the list — the only way
          // to dismiss on mobile, where there is no Esc. Delayed so a
          // click that lands past the list (e.g. on Create after the
          // list shrinks) completes before the layout shifts. Picking a
          // suggestion never blurs: items preventDefault on mousedown.
          blurTimerRef.current = setTimeout(() => setSuggestOpen(false), 150);
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      {suggestOpen && suggestions.length > 0 && (
        <div className="dir-suggest">
          {suggestions.map((dir, i) => (
            <div
              key={dir}
              className={`dir-suggest-item ${i === suggestIdx ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSuggestion(dir);
              }}
            >
              {dir}
            </div>
          ))}
        </div>
      )}
    </label>
  );
  return {
    path: dirPath,
    field,
    dismiss: () => {
      if (!suggestOpen || suggestions.length === 0) return false;
      setSuggestOpen(false);
      return true;
    },
  };
}

// A workspace is just a name plus a directory, a session of that folder's
// project (the server brings the project and its lead the first time). The
// path field completes directories live against the server (shell-style
// tab completion).
export function CreateWorkspaceDialog({
  hosts,
  onClose,
  onCreate,
  onListDirs,
  dirSuggestions,
  initialPath,
  projectFolders = [],
}: {
  hosts: HostInfo[];
  onClose: () => void;
  onCreate: (name: string, path: string, hostId?: string, projectName?: string) => void;
  onListDirs: (prefix: string) => void;
  dirSuggestions: { prefix: string; dirs: string[] };
  initialPath?: string;
  // Where the projects work (their repositories and worktrees): a folder
  // outside them all starts a project, which can be named here.
  projectFolders?: string[];
}) {
  const [name, setName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "local");
  const {
    path: dirPath,
    field,
    dismiss,
  } = useDirectoryField({
    onListDirs,
    dirSuggestions,
    initialPath: initialPath ?? "~/",
    label: "Directory path",
    placeholder: "~/workspace/...",
  });
  const onEscape = () => {
    if (!dismiss()) onClose();
  };

  const canSubmit = dirPath.trim().length > 0;
  const defaultName = dirPath.split("/").filter(Boolean).pop() ?? "";
  const folder = dirPath.trim().replace(/\/+$/, "");
  const newProject =
    defaultName !== "" &&
    defaultName !== "~" &&
    !projectFolders.some((f) => folder === f || folder.startsWith(`${f}/`));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const finalName = (name.trim() || defaultName || "session").trim();
    const project = newProject ? projectName.trim() : "";
    onCreate(finalName, dirPath.trim(), hostId || undefined, project || undefined);
    onClose();
  };

  return (
    <DialogFrame title="New Session" onClose={onClose} onEscape={onEscape} onSubmit={handleSubmit}>
      <label className="dialog-field">
        <span>Name</span>
        <input
          data-dialog-focus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName || "Session name…"}
        />
      </label>
      {field}
      {newProject && (
        <label className="dialog-field">
          <span>Project</span>
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder={defaultName}
          />
        </label>
      )}
      {hosts.length > 1 && (
        <label className="dialog-field">
          <span>Host</span>
          <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          Create session
        </button>
      </div>
    </DialogFrame>
  );
}
