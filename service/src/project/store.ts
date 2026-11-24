import * as fs from "fs";
import * as path from "path";
import { writeAtomicJson } from "../storage/atomic-write";

// A project: one repository (with any worktrees, on any disk) that a lead
// agent looks after. Its external memory lives here, in the server's data
// directory, not in the repository: structured objectives (objectives.ts)
// and free-form notes the lead (or its subagents) keep as markdown files.
//
//   .agent-team/projects/<id>/project.json
//   .agent-team/projects/<id>/objectives/<area>/<name>.toml
//   .agent-team/projects/<id>/issues/<module>.toml
//   .agent-team/projects/<id>/notes/*.md

export interface Project {
  schemaVersion: 2;
  status: "active" | "sealed";
  sealedAt?: number | null;
  sealedReason?: string | null;
  lead: ProjectLead | null;
  leadHistory?: ProjectLead[];
  hostDirs?: Record<string, string[]>;
  id: string;
  name: string;
  root: string | null;
  leadWorkspaceId: string | null;
  createdAt: number;
  // Filed away with its sessions: the sidebar keeps it apart, the lead is
  // still there to ask.
  archivedAt?: number | null;
}

export interface ProjectLead {
  hostId: string;
  workspaceId: string;
}

export class ProjectStore {
  private dir: string;
  private projects = new Map<string, Project>();

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, ".agent-team", "projects");
    if (!fs.existsSync(this.dir)) return;
    for (const id of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, id, "project.json");
      if (!fs.existsSync(file)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(file, "utf-8")) as Omit<Project, "schemaVersion"> & {
          schemaVersion?: number;
        };
        if (p.schemaVersion === undefined || p.schemaVersion === 1) {
          this.save({
            ...p,
            schemaVersion: 2,
            status: "active",
            lead: p.leadWorkspaceId ? { hostId: "local", workspaceId: p.leadWorkspaceId } : null,
          });
        } else if (p.schemaVersion === 2) {
          this.projects.set(p.id, {
            ...p,
            schemaVersion: 2,
            leadWorkspaceId: p.lead?.workspaceId ?? null,
          });
        } else {
          throw new Error(`Unsupported project schemaVersion: ${p.schemaVersion}`);
        }
      } catch (e) {
        console.error(`[projects] ${file} unreadable; the project is skipped`, e);
      }
    }
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  notesDir(id: string): string {
    return path.join(this.dir, id, "notes");
  }

  objectivesDir(id: string): string {
    return path.join(this.dir, id, "objectives");
  }

  issuesDir(id: string): string {
    return path.join(this.dir, id, "issues");
  }

  projectDir(id: string): string {
    return path.join(this.dir, id);
  }

  create(name: string, root: string | null): Project {
    const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const project: Project = {
      schemaVersion: 2,
      id,
      name,
      root,
      status: "active",
      lead: null,
      leadWorkspaceId: null,
      createdAt: Date.now(),
    };
    try {
      fs.mkdirSync(this.notesDir(id), { recursive: true });
      fs.mkdirSync(this.objectivesDir(id), { recursive: true });
      this.save(project);
    } catch (e) {
      this.remove(id);
      throw e;
    }
    return project;
  }

  save(project: Project): void {
    project.leadWorkspaceId = project.lead?.workspaceId ?? null;
    writeAtomicJson(path.join(this.projectDir(project.id), "project.json"), project);
    this.projects.set(project.id, project);
  }

  // Drops the project with its objectives and notes.
  remove(id: string): void {
    this.projects.delete(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }
}
