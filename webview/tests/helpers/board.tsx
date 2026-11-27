import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { vi } from "vitest";
import { BoardPage } from "../../src/project/BoardPage";
import type { Project } from "../../src/state/useServer";
import { project } from "./fixtures";

type BoardFields = Omit<ComponentProps<typeof BoardPage>, "project">;

export const boardProject = (objectives: Project["objectives"]) =>
  project("p1", { name: "clice", root: "/repo/clice", createdAt: 0, objectives });

export function boardProps(
  fields: Partial<BoardFields> = {},
  action: () => () => void = () => vi.fn(),
): BoardFields {
  return {
    sessions: new Map(),
    onClose: action(),
    onOpenSession: action(),
    onAskLead: action(),
    onRename: action(),
    onDelete: action(),
    ...fields,
  };
}

export function renderBoard(project: Project, fields?: Partial<BoardFields>) {
  const props = boardProps(fields);
  return { ...render(<BoardPage project={project} {...props} />), ...props };
}
