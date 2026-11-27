import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { vi } from "vitest";
import { AgentsPanel, type AgentsPanelActions } from "../../src/panels/AgentsPanel";
import type { Workspace } from "../../src/state/useServer";

export function agentsActions(
  fields: Partial<AgentsPanelActions> = {},
  action: () => () => void = () => vi.fn(),
): AgentsPanelActions {
  return {
    onOpen: action(),
    onStop: action(),
    onArchive: action(),
    onRestore: action(),
    onSetReporting: action(),
    onAddAgent: action(),
    onClearContext: action(),
    onRemoveAgent: action(),
    onSetModel: action(),
    onSetEffort: action(),
    onStopTask: action(),
    onCancelWake: action(),
    onStopAll: action(),
    ...fields,
  };
}

export function renderAgents(
  sessions: Workspace[],
  fields: Partial<Omit<ComponentProps<typeof AgentsPanel>, "sessions">> = {},
) {
  const actions = fields.actions ?? agentsActions();
  const view = render(
    <AgentsPanel
      sessions={sessions}
      project={undefined}
      activeWsId={sessions[0].id}
      connected
      models={[]}
      {...fields}
      actions={actions}
    />,
  );
  return { ...view, actions };
}
