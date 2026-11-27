import type { SyntheticEvent } from "react";
import type { TelemetryAction } from "../../shared/telemetry";
import { recordTelemetry } from "./telemetry";

const clickActions = [
  "panel.files",
  "panel.diff",
  "panel.agents",
  "panel.stats",
  "panel.board",
  "panel.notes",
  "panel.issues",
  "panel.close",
  "chat.jump_latest",
  "chat.quote_jump",
  "chat.diagram_preview",
  "sidebar.archive_toggle",
  "trace.step_toggle",
  "trace.subagent_toggle",
  "trace.subagent_page",
  "trace.tool_toggle",
  "stats.turn_toggle",
  "stats.step_toggle",
  "stats.load_more",
] as const satisfies readonly TelemetryAction[];
const focusActions = ["sidebar.search"] as const satisfies readonly TelemetryAction[];
type DelegatedAction = (typeof clickActions)[number] | (typeof focusActions)[number];

export function telemetryTarget(action: DelegatedAction | undefined) {
  return { "data-telemetry": action };
}

// Match only the nearest action/control. A Cancel button inside a trace
// header, for example, is not a click on the header's toggle.
export function recordTelemetryEvent(event: SyntheticEvent<HTMLElement>): void {
  const { target, currentTarget, type } = event;
  const actions = type === "click" ? clickActions : type === "focus" ? focusActions : null;
  if (!actions || !(target instanceof Element)) return;
  const control = target.closest("[data-telemetry], button, a, input, select, textarea");
  if (!control || !currentTarget.contains(control) || control.matches(":disabled")) return;
  const action = actions.find((value) => value === control.getAttribute("data-telemetry"));
  if (action) recordTelemetry(action);
}
