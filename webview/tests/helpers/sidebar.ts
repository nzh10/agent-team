import { vi } from "vitest";
import type { SidebarProps } from "../../src/sidebar/Sidebar";

const noop = () => {};

export function healthResponse(issues: object[] = []) {
  return { ok: true, json: () => Promise.resolve({ issues }) };
}

export function stubHealth(issues: object[] = []) {
  const fetch = vi.fn(() => Promise.resolve(healthResponse(issues)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

export function sidebarProps(
  fields: Partial<SidebarProps> = {},
  action = () => noop,
): SidebarProps {
  return {
    workspaces: [],
    activeWsId: null,
    connected: true,
    groupOverrides: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: null,
    onSelect: action(),
    onDelete: action(),
    onToggleGroup: action(),
    onSearchChange: action(),
    onJump: action(),
    onCreate: action(),
    onCreateIn: action(),
    onReplayDemo: action(),
    onDebugSnapshot: action(),
    onPurgeArchived: action(),
    ...fields,
  };
}
