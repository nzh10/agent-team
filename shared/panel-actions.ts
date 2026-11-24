// Panel calls with an effect elsewhere render as transcript actions.
export const PANEL_ACTIONS: ReadonlySet<string> = new Set([
  "start_session",
  "message_session",
  "message_project",
  "stop_session",
  "archive_session",
  "report_progress",
  "finish_task",
]);

export function panelActionOf(event: { kind: string; toolName?: string }): string | null {
  const prefix = "mcp__panel__";
  if (event.kind !== "tool_use" || !event.toolName?.startsWith(prefix)) return null;
  const name = event.toolName.slice(prefix.length);
  return PANEL_ACTIONS.has(name) ? name : null;
}
