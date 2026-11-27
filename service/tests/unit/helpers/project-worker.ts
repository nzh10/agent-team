import type { StartSessionArgs } from "../../../src/project/tools";
import type { Workspace } from "../../../src/workspace/workspace";
import { setupProjects, withTask } from "../projectHarness";

type ProjectHarness = Pick<ReturnType<typeof setupProjects>, "call" | "workers">;
type StartWorkerArgs = Omit<StartSessionArgs, "cwd" | "objectiveId" | "taskId"> & {
  cwd?: string;
  objective_id?: string;
  task_id?: string;
};
type StartTaskWorkerArgs = Omit<StartWorkerArgs, "objective_id" | "task_id">;

export async function startWorker(h: ProjectHarness, lead: Workspace, args: StartWorkerArgs) {
  await h.call(lead, "start_session", { cwd: "wt", ...args });
  return h
    .workers()
    .filter((w) => w.projectLink?.projectId === lead.projectLink?.projectId)
    .at(-1)!;
}

export function startTaskWorker(h: ProjectHarness, lead: Workspace, args: StartTaskWorkerArgs) {
  return startWorker(h, lead, { ...args, objective_id: "core/modules", task_id: "t1" });
}

export async function createTaskAndStartWorker(
  h: ProjectHarness,
  lead: Workspace,
  args: StartTaskWorkerArgs,
) {
  await withTask(h.call, lead);
  return startTaskWorker(h, lead, args);
}

export async function setupWorkerProject(args: StartWorkerArgs) {
  const h = setupProjects();
  const { lead, project } = h.create("clice");
  const worker = await startWorker(h, lead, args);
  return { ...h, lead, project, worker };
}

export async function setupTaskWorkerProject(args: StartTaskWorkerArgs) {
  const h = setupProjects();
  const { lead, project } = h.create("clice");
  const worker = await createTaskAndStartWorker(h, lead, args);
  return { ...h, lead, project, worker };
}
