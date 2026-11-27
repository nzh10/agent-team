import type { AgentInfo, Message, Objective, Project, Workspace } from "../../src/state/useServer";

export function agent(id: string, fields: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    name: "Agent",
    model: "claude-opus-5-5",
    avatar: "A",
    color: "#888",
    isDefault: true,
    ...fields,
  };
}

export function workspace(id: string, fields: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    project: "repo",
    hostId: "local",
    cwd: "/repo",
    agents: [],
    messages: [],
    createdAt: 1,
    ...fields,
  };
}

export function message(id: string, fields: Partial<Message> = {}): Message {
  return { id, kind: "agent", agentId: "a", content: "", timestamp: 1, status: "done", ...fields };
}

export function objective(id: string, fields: Partial<Objective> = {}): Objective {
  return {
    id,
    area: id.split("/")[0],
    title: id,
    goal: `goal of ${id}`,
    status: "active",
    priority: "normal",
    dependsOn: [],
    tasks: [],
    decisions: [],
    sessions: [],
    updatedAt: 1_800_000_000_000,
    ...fields,
  };
}

export function project(id: string, fields: Partial<Project> = {}): Project {
  return {
    id,
    name: "Project",
    root: "/repo",
    leadWorkspaceId: "lead",
    createdAt: 1,
    objectives: [],
    ...fields,
  };
}
