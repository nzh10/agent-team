import { execFileSync } from "node:child_process";
import { closeHistory, saveWorkspace } from "../service/src/workspace/state";
import type { WorkspaceState } from "../service/src/workspace/workspace";

export const seedGit = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });

export function seedCommit(
  dir: string,
  user: string,
  email: string,
  file: string,
  message: string,
): void {
  seedGit("-C", dir, "add", "--", file);
  seedGit(
    "-C",
    dir,
    "-c",
    `user.name=${user}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "--no-gpg-sign",
    "-qm",
    message,
  );
}

export function seedWorkspaces(base: string, states: Iterable<WorkspaceState>): void {
  try {
    for (const state of states) saveWorkspace(base, state);
  } finally {
    closeHistory(base);
  }
}
