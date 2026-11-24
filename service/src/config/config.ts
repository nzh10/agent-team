import * as fs from "fs";
import * as path from "path";
import TOML from "@iarna/toml";
import { AGENT_PRESETS, type AgentPreset } from "./presets";

import {
  readAcp,
  readProxy,
  RuntimeConfigError,
  type AcpConfig,
  type ProxyConfig,
} from "./runtime";

export interface ServerConfig {
  proxy?: ProxyConfig;
  remote_uploads_url?: string;
  restart_command?: string[];
}

export interface WorkspaceConfig {
  // Workspaces idle for this long are archived automatically: their messages
  // leave memory, idle CLI processes are shut down and the sidebar folds them
  // into an "Archived" section. 0 disables the sweep.
  archive_after_days: number;
}

export const DEFAULT_ARCHIVE_AFTER_DAYS = 14;

export interface AuthConfig {
  username: string;
  password: string;
  session_secret: string;
  max_age_days: number;
}

export interface HostConfig {
  label: string;
  type: "local";
}

export interface PiConfig {
  acp?: AcpConfig;
  packages?: string[];
  exclude_packages?: string[];
  default_model?: string;
  default_effort?: string;
  offline?: boolean;
}

// The model, and its effort, a new project's lead runs on, and the workers
// it starts without naming one.
export interface ProjectsConfig {
  lead_name?: string;
  lead_avatar?: string;
  lead_color?: string;
  model?: string;
  effort?: string;
}

export interface AppConfig {
  user: { name: string; avatar: string; language?: string };
  presets: AgentPreset[];
  server: ServerConfig;
  workspace: WorkspaceConfig;
  auth: AuthConfig | null;
  hosts: Record<string, HostConfig>;
  projects: ProjectsConfig;
  pi?: PiConfig;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readPresets(value: unknown): AgentPreset[] {
  if (value === undefined || (Array.isArray(value) && !value.length)) return AGENT_PRESETS;
  if (!Array.isArray(value)) throw new RuntimeConfigError("Expected [[agent_presets]]");
  return value.map((row: Record<string, unknown>, i) => {
    const name = optionalString(row?.name);
    const avatar = optionalString(row?.avatar);
    const color = optionalString(row?.color);
    const whenToUse = optionalString(row.when_to_use)?.trim();
    if (!name || !avatar || !color)
      throw new RuntimeConfigError(`agent_presets[${i}] needs name, avatar and color`);
    return {
      name,
      avatar,
      color,
      model: optionalString(row.model),
      effort: optionalString(row.effort),
      ...(whenToUse && { when_to_use: whenToUse }),
    };
  });
}

export function loadConfig(baseDir: string): AppConfig {
  const configPath = path.join(baseDir, "config.toml");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nCopy config.example.toml to config.toml to get started.`,
    );
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(raw);
  } catch (error) {
    // The parser message includes source lines, which can contain credentials.
    const line = (error as { line?: number }).line;
    throw Object.assign(
      new Error(`Invalid config.toml${typeof line === "number" ? ` at line ${line + 1}` : ""}`),
      { line },
    );
  }

  const serverSection = parsed.server as Record<string, unknown> | undefined;
  const server: ServerConfig = {
    remote_uploads_url: (serverSection?.remote_uploads_url as string) || undefined,
    restart_command: stringArray(serverSection?.restart_command),
    proxy: readProxy(serverSection?.proxy),
  };

  const wsSection = parsed.workspace as Record<string, unknown> | undefined;
  const archiveDays = wsSection?.archive_after_days;
  const workspace: WorkspaceConfig = {
    archive_after_days:
      typeof archiveDays === "number" && archiveDays >= 0
        ? archiveDays
        : DEFAULT_ARCHIVE_AFTER_DAYS,
  };

  const hosts: Record<string, HostConfig> = {};
  const rawHosts = parsed.hosts;
  if (rawHosts && typeof rawHosts === "object") {
    for (const [id, cfg] of Object.entries(rawHosts as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object") {
        const c = cfg as Record<string, string>;
        hosts[id] = {
          label: c.label ?? id,
          type: "local",
        };
      }
    }
  }
  if (Object.keys(hosts).length === 0) {
    hosts["local"] = { label: "Local", type: "local" };
  }

  if (parsed.providers !== undefined)
    throw new RuntimeConfigError(
      "[providers.*] is no longer supported. Migrate custom Pi providers to ~/.pi/agent/models.json and remove the [providers.*] tables from config.toml.",
    );

  let auth: AuthConfig | null = null;
  const rawAuth = parsed.auth as Record<string, unknown> | undefined;
  if (rawAuth) {
    // A half-filled [auth] must not silently turn login off.
    for (const key of ["username", "password", "session_secret"]) {
      if (!rawAuth[key]) throw new RuntimeConfigError(`[auth] is missing ${key}`);
    }
    auth = {
      username: rawAuth.username as string,
      password: rawAuth.password as string,
      session_secret: rawAuth.session_secret as string,
      max_age_days: (rawAuth.max_age_days as number) ?? 30,
    };
  }

  const rawProjects = parsed.projects as Record<string, unknown> | undefined;
  const projects: ProjectsConfig = {
    lead_name: optionalString(rawProjects?.lead_name),
    lead_avatar: optionalString(rawProjects?.lead_avatar),
    lead_color: optionalString(rawProjects?.lead_color),
    ...(typeof rawProjects?.model === "string" &&
      rawProjects.model && { model: rawProjects.model }),
    ...(typeof rawProjects?.effort === "string" &&
      rawProjects.effort && { effort: rawProjects.effort }),
  };

  const rawPi = parsed.pi as Record<string, unknown> | undefined;
  const pi: PiConfig | undefined = rawPi
    ? {
        acp: readAcp(rawPi.acp),
        packages: stringArray(rawPi.packages),
        exclude_packages: stringArray(rawPi.exclude_packages),
        default_model: typeof rawPi.default_model === "string" ? rawPi.default_model : undefined,
        default_effort: typeof rawPi.default_effort === "string" ? rawPi.default_effort : undefined,
        offline: typeof rawPi.offline === "boolean" ? rawPi.offline : undefined,
      }
    : undefined;

  const rawUser = parsed.user as Record<string, unknown> | undefined;
  const language = optionalString(rawUser?.language)?.trim();
  const user = {
    name: optionalString(rawUser?.name) ?? "You",
    avatar: optionalString(rawUser?.avatar) ?? "avatars/header.jpg",
    ...(language && { language }),
  };
  return {
    server,
    workspace,
    auth,
    hosts,
    projects,
    pi,
    user,
    presets: readPresets(parsed.agent_presets),
  };
}
