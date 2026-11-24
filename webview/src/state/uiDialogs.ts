import type { UiDialogRequest } from "./useServer";

export function uiDialogKey(dialog: UiDialogRequest): string {
  return [dialog.workspaceId, dialog.agentId, dialog.processGeneration, dialog.requestId].join(":");
}

export function compareUiDialogs(a: UiDialogRequest, b: UiDialogRequest): number {
  return a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId);
}

export function selectUiDialogs(dialogs: readonly UiDialogRequest[], workspaceId: string | null) {
  let currentDialog: UiDialogRequest | undefined;
  let otherDialog: UiDialogRequest | undefined;
  const otherWorkspaces = new Set<string>();
  for (const dialog of dialogs) {
    if (dialog.workspaceId === workspaceId) {
      if (!currentDialog || compareUiDialogs(dialog, currentDialog) < 0) currentDialog = dialog;
    } else {
      otherWorkspaces.add(dialog.workspaceId);
      if (!otherDialog || compareUiDialogs(dialog, otherDialog) < 0) otherDialog = dialog;
    }
  }
  return { currentDialog, otherDialog, otherDialogCount: otherWorkspaces.size };
}
