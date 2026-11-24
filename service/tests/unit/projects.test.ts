import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { ProjectStore } from "../../src/project/store";
import { leadToolset, workerToolset, type PanelApi } from "../../src/project/tools";
import { SETTLE_MS, START_SPACING_MS, awaitsUser } from "../../src/project/manager";
import { AGENT_PRESETS } from "../../src/config/presets";
import { MCP_TEXT_LIMIT } from "../../src/session/types";
import { Workspace } from "../../src/workspace/workspace";
import { historyOf, saveIndex, saveWorkspace, loadAll } from "../../src/workspace/state";
import { summarizeMessages } from "../../src/workspace/summary";
import { FakeHost, FakeSession } from "./fakes";
import { HostRegistry } from "../../src/session/host";
import { setupProjects as setup, tick, tmpDir as tmp, withTask } from "./projectHarness";

// Fake setTimeout and Date without hijacking DirWatcher's 250ms setInterval
// polling, which otherwise runs thousands of sync fs scans on long jumps.
const useFakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

describe("ProjectStore", () => {
  it("persists projects outside the repository and removes them whole", () => {
    const base = tmp();
    const store = new ProjectStore(base);
    const p = store.create("clice", "/repo/clice");
    p.lead = { hostId: "local", workspaceId: "ws-lead" };
    store.save(p);
    expect(fs.existsSync(store.notesDir(p.id))).toBe(true);
    expect(fs.existsSync(store.objectivesDir(p.id))).toBe(true);

    const reopened = new ProjectStore(base);
    expect(reopened.list()).toEqual([p]);
    reopened.remove(p.id);
    expect(reopened.list()).toEqual([]);
    expect(fs.existsSync(reopened.notesDir(p.id))).toBe(false);
  });
});

describe("panel tool arguments", () => {
  const project = {
    schemaVersion: 2 as const,
    status: "active" as const,
    lead: { hostId: "local", workspaceId: "ws-l" },
    id: "p1",
    name: "clice",
    root: "/repo",
    leadWorkspaceId: "ws-l",
    createdAt: 1,
  };
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...a: unknown[]) => {
      calls.push([name, ...a]);
      return "ok";
    };
  const api: PanelApi = {
    projectStatus: (...a) => Promise.resolve(record("projectStatus")(...a)),
    startSession: record("startSession"),
    readSession: (...a) => Promise.resolve(record("readSession")(...a)),
    searchHistory: (...a) => Promise.resolve(record("searchHistory")(...a)),
    readEntry: (...a) => Promise.resolve(record("readEntry")(...a)),
    queryHistory: (...a) => Promise.resolve(record("queryHistory")(...a)),
    messageSession: record("messageSession"),
    stopSession: record("stopSession"),
    archiveSession: record("archiveSession"),
    listObjectives: record("listObjectives"),
    readObjective: (...a) => Promise.resolve(record("readObjective")(...a)),
    writeObjective: (...a) => Promise.resolve(record("writeObjective")(...a)),
    addItems: record("addItems"),
    updateItem: record("updateItem"),
    deleteObjective: record("deleteObjective"),
    listIssues: record("listIssues"),
    readIssue: (...a) => Promise.resolve(record("readIssue")(...a)),
    writeIssues: (...a) => Promise.resolve(record("writeIssues")(...a)),
    writeIssueGroup: record("writeIssueGroup"),
    closeIssues: record("closeIssues"),
    listProjects: record("listProjects"),
    messageProject: record("messageProject"),
    listNotes: () => [],
    readNote: () => {
      throw new Error("Not used in this fixture");
    },
    writeNote: () => Promise.reject(new Error("Not used in this fixture")),
    workerReport: (...a) => Promise.resolve(record("workerReport")(...a)),
    currentTask: (...a) => Promise.resolve(record("currentTask")(...a)),
    checkReporting: () => {},
  };
  const byName = (tools: ReturnType<typeof leadToolset>) =>
    Object.fromEntries(tools.tools.map((t) => [t.name, t]));

  afterEach(() => void calls.splice(0));

  it("map onto the project's API", async () => {
    const t = byName(leadToolset(api, project, "/notes", ["m"]));
    await t.start_session.handler({
      title: "modules",
      cwd: "../clice-modules",
      task: "do it",
      objective_id: "core/modules",
      task_id: "t2",
    });
    await t.read_session.handler({ session_id: "ws-w" });
    await t.search_history.handler({
      query: "PartialSpec",
      in: ["tool_output"],
      tool: "Bash",
      since: "2026-09-01",
      level: "subagents",
      project: "clice",
      limit: 5,
      offset: 10,
    });
    await t.read_entry.handler({ entry: 12 });
    await t.query_history.handler({ sql: "select 1", project: "*" });
    await t.write_objective.handler({
      id: "core/modules",
      status: "later",
      reason: "after the index",
      depends_on: ["index/format"],
    });
    await t.add_items.handler({ objective_id: "core/modules", decisions: ["which std?"] });
    await t.update_item.handler({ objective_id: "core/modules", item_id: "d1", outcome: "C++20" });
    await t.message_project.handler({ project_id: "p2", message: "hi" });
    expect(calls).toEqual([
      [
        "startSession",
        "p1",
        {
          title: "modules",
          cwd: "../clice-modules",
          task: "do it",
          objectiveId: "core/modules",
          taskId: "t2",
        },
      ],
      ["readSession", "p1", "ws-w", 6, undefined, false, false],
      [
        "searchHistory",
        "p1",
        {
          query: "PartialSpec",
          in: ["tool_output"],
          tool: "Bash",
          since: Date.parse("2026-09-01"),
          depth: "subagents",
          caseSensitive: false,
          project: "clice",
          limit: 5,
          offset: 10,
        },
      ],
      ["readEntry", "p1", 12, 1, 200, 0],
      ["queryHistory", "p1", "select 1", "*"],
      [
        "writeObjective",
        "p1",
        {
          id: "core/modules",
          status: "later",
          reason: "after the index",
          dependsOn: ["index/format"],
        },
        // The lead speaks for no worker session.
        undefined,
      ],
      ["addItems", "p1", "core/modules", [], ["which std?"]],
      ["updateItem", "p1", "core/modules", "d1", { outcome: "C++20" }, undefined],
      ["messageProject", "p1", "p2", "hi"],
    ]);
  });

  it("route a worker's reports to its own workspace", async () => {
    const t = byName(workerToolset(api, "ws-w", project, "/notes"));
    await t.report_progress.handler({ text: "tests pass" });
    // There is no blocked report: a decision goes to the user in the worker's own session.
    await t.finish_task.handler({ summary: "merged", blocked: true });
    await t.finish_task.handler({ summary: "done", context: "merged", objective_id: "a/x" });
    expect(calls).toEqual([
      ["workerReport", "ws-w", "tests pass", false, undefined, undefined],
      ["workerReport", "ws-w", "merged", true, {}, undefined],
      ["workerReport", "ws-w", "done", true, { context: "merged", objectiveId: "a/x" }, undefined],
    ]);
    expect(Object.keys(t.finish_task.shape)).toEqual(["summary", "context", "objective_id"]);
  });

  it("give an isolated worker its reports and its task, and no word of the rest", async () => {
    const lead = byName(leadToolset(api, project, "/notes", ["m"]));
    await lead.start_session.handler({ title: "w", cwd: "wt", task: "t", isolated: true });
    const set = workerToolset(api, "ws-w", project, "/notes", true);
    const t = byName(set);
    expect(Object.keys(t)).toEqual(["report_progress", "finish_task", "current_task"]);
    expect(Object.keys(t.finish_task.shape)).toEqual(["summary"]);
    expect(Object.keys(t.current_task.shape)).toEqual([]);
    await t.finish_task.handler({ summary: "done" });
    await t.current_task.handler({});
    expect(calls).toEqual([
      ["startSession", "p1", { title: "w", cwd: "wt", task: "t", isolated: true }],
      ["workerReport", "ws-w", "done", true, {}, undefined],
      ["currentTask", "ws-w", undefined],
    ]);
    expect(set.instructions).not.toContain("Write user-facing");
    expect(set.instructions).toContain("not yours to look at");
    for (const word of [
      "/notes",
      "search_history",
      "write_issues",
      "project_status",
      "read_session",
    ]) {
      expect(set.instructions, word).not.toContain(word);
    }
  });

  it("give a worker the board to keep, as its own session, but not to delete or archive", async () => {
    const t = byName(workerToolset(api, "ws-w", project, "/notes"));
    expect(Object.keys(t)).toEqual([
      "report_progress",
      "finish_task",
      "current_task",
      "list_objectives",
      "write_objective",
      "add_items",
      "update_item",
      "list_issues",
      "read_issue",
      "write_issues",
      "write_issue_group",
      "close_issues",
      "list_notes",
      "read_note",
      "write_note",
      "project_status",
      "read_session",
      "search_history",
      "read_entry",
      "query_history",
    ]);
    await t.write_objective.handler({ id: "core/modules", context: "lexer done" });
    await t.update_item.handler({ objective_id: "core/modules", item_id: "t1", state: "doing" });
    await t.add_items.handler({ objective_id: "core/modules", tasks: ["docs"] });
    expect(calls).toEqual([
      ["writeObjective", "p1", { id: "core/modules", context: "lexer done" }, "ws-w"],
      ["updateItem", "p1", "core/modules", "t1", { state: "doing" }, "ws-w"],
      ["addItems", "p1", "core/modules", ["docs"], []],
    ]);
    expect(t.delete_objective).toBeUndefined();
    expect(t.archive_objective).toBeUndefined();
  });

  it("let a worker read the project's sessions and history as the lead does, but act on none", async () => {
    const t = byName(workerToolset(api, "ws-w", project, "/notes"));
    const lead = byName(leadToolset(api, project, "/notes", ["m"]));
    for (const name of ["read_session", "search_history", "query_history", "project_status"]) {
      expect(t[name].description).toBe(lead[name].description);
    }
    await t.read_session.handler({ session_id: "ws-x" });
    await t.query_history.handler({ sql: "select 1" });
    expect(calls).toEqual([
      ["readSession", "p1", "ws-x", 6, undefined, false, false],
      ["queryHistory", "p1", "select 1", undefined],
    ]);
    for (const name of [
      "start_session",
      "message_session",
      "stop_session",
      "archive_session",
      "message_project",
    ]) {
      expect(t[name], name).toBeUndefined();
    }
    expect(workerToolset(api, "ws-w", project, "/notes").instructions).toContain(
      "search_history finds it",
    );
  });

  it.each([undefined, "Icelandic"])(
    "scopes the optional user-facing language (%s) to project replies",
    (language) => {
      const set = leadToolset(api, project, "/notes", ["gpt-6-astra"], [], language);
      for (const text of [
        set.instructions,
        workerToolset(api, "ws-w", project, "/notes", false, false, language).instructions,
        workerToolset(api, "ws-w", project, "/notes", true, false, language).instructions,
        workerToolset(api, "ws-w", project, "/notes", false, true, language).instructions,
      ]) {
        if (language)
          expect(text).toContain(
            `Write user-facing replies, questions and summaries in ${language}. Keep code, identifiers, commit messages and repository files in English.`,
          );
        else expect(text).not.toContain("Write user-facing");
      }
      expect(byName(set).start_session.description).toContain("a worktree, reused");
    },
  );

  it("shows preset dispatch hints only in the lead's start_session description", () => {
    const scoutHint = "Map unfamiliar repositories before implementation";
    const reviewHint = "Audit diffs for correctness regressions";
    const lead = leadToolset(
      api,
      project,
      "/notes",
      ["m"],
      [
        { name: "Scout", when_to_use: scoutHint },
        { name: "Reviewer", when_to_use: reviewHint },
        { name: "Plain" },
        { name: "Blank", when_to_use: "   " },
      ],
    );
    const description = byName(lead).start_session.description;
    expect(description).toContain(
      `Dispatch hints: "Scout": ${scoutHint}; "Reviewer": ${reviewHint}.`,
    );
    expect(description).not.toContain("Blank:");
    expect(lead.instructions).not.toContain("Dispatch hints");

    const withoutHints = byName(
      leadToolset(api, project, "/notes", ["m"], [{ name: "Scout" }, { name: "Reviewer" }]),
    ).start_session.description;
    expect(withoutHints).toContain('Presets: "Scout", "Reviewer".');
    expect(withoutHints).not.toContain("Dispatch hints");

    for (const worker of [
      workerToolset(api, "ws-w", project, "/notes"),
      workerToolset(api, "ws-i", project, "/notes", true),
      workerToolset(api, "ws-u", project, "/notes", false, true),
    ]) {
      expect(worker.instructions).not.toContain("Dispatch hints");
      for (const hint of [scoutHint, reviewHint]) {
        expect(worker.instructions).not.toContain(hint);
        for (const tool of worker.tools) expect(tool.description).not.toContain(hint);
      }
    }
  });

  it("tell the lead and its workers to delete what is done or replaced, in a few thousand characters", () => {
    const lead = leadToolset(api, project, "/notes", ["gpt-6-astra"]).instructions;
    const worker = workerToolset(api, "ws-w", project, "/notes").instructions;
    for (const text of [lead, worker]) {
      expect(text).toContain("Delete what is obsolete");
      expect(text).toContain("done work goes with its objective, which the lead deletes");
      expect(text).not.toContain("as you go");
    }
    expect(worker).toContain("When your work replaces something");
    expect(worker).toContain("objectives (name those in finish_task: the lead deletes them)");
    expect(worker).toContain("your own tasks stay");
    const w = byName(workerToolset(api, "ws-w", project, "/notes"));
    expect(w.finish_task.description).toContain("once per task");
    // A list given replaces the one there; the descriptions say so.
    const issue = (w.write_issues.shape.issues as z.ZodArray<z.ZodObject<z.ZodRawShape>>).element
      .shape;
    for (const field of [
      w.write_objective.shape.depends_on,
      w.write_issue_group.shape.objectives,
      issue.tags,
      issue.objectives,
    ] as z.ZodType[]) {
      expect(field.description).toBe("The whole list");
    }
    expect(lead).toContain("check the board keeps nothing about the old one");
    expect(lead.length).toBeLessThan(5000);
    expect(worker.length).toBeLessThan(3800);
    // Nothing the CLI would cut.
    const tools = [
      ...leadToolset(api, project, "/notes", ["m"]).tools,
      ...workerToolset(api, "ws-w", project, "/notes").tools,
    ];
    for (const t of tools) expect(t.description.length, t.name).toBeLessThan(MCP_TEXT_LIMIT);
  });

  it("turn a thrown error into a rejection", async () => {
    const failing: PanelApi = {
      ...api,
      stopSession: () => {
        throw new Error("No session ws-x in this project");
      },
    };
    const t = byName(leadToolset(failing, project, "/notes", ["m"]));
    await expect(t.stop_session.handler({ session_id: "ws-x" })).rejects.toThrow("No session ws-x");
  });
});

describe("ProjectManager", () => {
  it("uses configured lead and least-used generic worker identities", async () => {
    const { host, create, call, workers } = setup();
    const first = { name: "One", avatar: "1", color: "red" };
    const second = { name: "Two", avatar: "2", color: "blue" };
    host.agentPresets = () => [first, second];
    const { lead } = create("first");
    expect([...lead.agents.values()][0].info).toMatchObject({ ...first, name: "Lead" });
    host.projectDefaults = () => ({ lead_name: "Boss", lead_avatar: "B", lead_color: "green" });
    expect([...create("other").lead.agents.values()][0].info).toMatchObject({
      name: "Boss",
      avatar: "B",
      color: "green",
    });
    for (const expected of [first, second, first]) {
      await call(lead, "start_session", { title: "worker", cwd: "wt", task: "work" });
      expect([...workers().at(-1)!.agents.values()][0].info).toMatchObject(expected);
    }
  });

  it("wires configured dispatch hints into lead tools but never worker tools", async () => {
    const { host, create, call, manager, workers } = setup();
    const hint = "Use Scout for repository reconnaissance";
    host.agentPresets = () => [{ name: "Scout", avatar: "S", color: "blue", when_to_use: hint }];
    const { lead } = create("dispatch hints");
    const leadStart = manager.toolsFor(lead)!.tools.find((tool) => tool.name === "start_session")!;
    expect(leadStart.description).toContain(`Dispatch hints: "Scout": ${hint}.`);

    await call(lead, "start_session", { title: "worker", cwd: "wt", task: "work" });
    const worker = manager.toolsFor(workers()[0])!;
    expect(worker.instructions).not.toContain(hint);
    for (const tool of worker.tools) {
      expect(tool.description).not.toContain(hint);
      expect(tool.description).not.toContain("Dispatch hints");
    }
  });

  it("matches Kimi's effort preset unless the lead pins a different identity", async () => {
    const { host, create, call, session, workers } = setup();
    const kimi = "kimi-coding/k3.1-pro-highspeed";
    const perseus = { name: "Perseus", avatar: "avatars/Perseus.jpg", color: "#C0C0C0" };
    const ayanami = { name: "Ayanami", avatar: "avatars/Ayanami.jpg", color: "#88CCFF" };
    const presets = [
      { ...perseus, model: "gpt-6-astra", effort: "ultra" },
      { name: "Scout", avatar: "S", color: "red", model: kimi, effort: "low" },
      { ...ayanami, model: kimi, effort: "max" },
    ];
    host.agentPresets = () => presets;
    host.modelOptions = () => [
      { id: "gpt-6-astra", backend: "codex", label: "Astra" },
      { id: kimi, backend: "pi", label: "Kimi", effortLevels: ["low", "max"] },
      { id: "mock/unknown-levels", backend: "pi", label: "Unknown levels" },
    ];
    const { lead } = create("preset matching");
    const args = { title: "worker", cwd: "wt", task: "work" };
    const start = async (overrides: Record<string, string>) => {
      await call(lead, "start_session", { ...args, ...overrides });
      const worker = workers().at(-1)!;
      return { ...worker.resolveAgent()!.info, effort: session(worker).getState().config.effort };
    };

    expect(await start({ model: kimi, effort: "max" })).toMatchObject({
      ...ayanami,
      model: kimi,
      effort: "max",
    });
    expect(await start({ model: kimi })).toMatchObject({
      name: "Scout",
      model: kimi,
      effort: undefined,
    });
    expect(await start({ preset: "Perseus", model: kimi })).toMatchObject({
      ...perseus,
      model: kimi,
      effort: undefined,
    });
    expect(await start({ preset: "Ayanami" })).toMatchObject({
      ...ayanami,
      model: kimi,
      effort: "max",
    });
    await expect(
      call(lead, "start_session", { ...args, preset: "Perseus", model: kimi, effort: "ultra" }),
    ).rejects.toThrow(`${kimi} has no effort ultra`);
    expect(workers()).toHaveLength(4);
    expect(await start({ preset: "Ayanami", model: "mock/unknown-levels" })).toMatchObject({
      ...ayanami,
      model: "mock/unknown-levels",
      effort: undefined,
    });
    const tool = session(lead).panelTools!.tools.find((t) => t.name === "start_session")!;
    expect(tool.description).toContain('Presets: "Perseus", "Scout", "Ayanami"');
  });

  it("rejects unknown and ambiguous preset names and unavailable preset models before creation", async () => {
    const { host, create, call, session } = setup();
    const preset = { name: "Scout", avatar: "S", color: "red" };
    host.agentPresets = () => [
      preset,
      { ...preset, avatar: "X" },
      { ...preset, name: "Offline", model: "mock/offline" },
    ];
    const { lead } = create("bad presets");
    const createWorkspace = vi.spyOn(host, "createWorkspace");
    const args = { title: "worker", cwd: "wt", task: "work" };
    await expect(call(lead, "start_session", { ...args, preset: "scout" })).rejects.toThrow(
      'Unknown preset "scout"; one of: "Offline"',
    );
    await expect(call(lead, "start_session", { ...args, preset: "Scout" })).rejects.toThrow(
      'Ambiguous preset "Scout"',
    );
    await expect(call(lead, "start_session", { ...args, preset: "Offline" })).rejects.toMatchObject(
      {
        issue: { code: "invalid_explicit_model", source: "agent_presets.model", value: null },
      },
    );
    expect(createWorkspace).not.toHaveBeenCalled();
    const tool = session(lead).panelTools!.tools.find((t) => t.name === "start_session")!;
    expect(tool.description).toContain('Presets: "Offline".');
    expect(tool.description).not.toContain('"Scout"');
  });

  it("chooses least-used matching identities despite interleaved unmatched workers", async () => {
    const { host, create, call, workers } = setup();
    const model = "gpt-6-astra";
    const first = { name: "One", avatar: "1", color: "red" };
    const second = { name: "Two", avatar: "2", color: "blue" };
    const generic = { name: "Generic", avatar: "G", color: "green" };
    host.agentPresets = () => [
      { ...first, model },
      { ...second, model },
    ];
    const { lead } = create("interleaved");
    const start = async (model: string) => {
      await call(lead, "start_session", { title: "worker", cwd: "wt", task: "work", model });
      return workers().at(-1)!.resolveAgent()!.info;
    };

    expect(await start(model)).toMatchObject(first);
    expect(await start("gpt-5.5")).toMatchObject({ ...AGENT_PRESETS[0], model: "gpt-5.5" });
    expect(await start(model)).toMatchObject(second);
    const bound = host.agentPresets();
    host.agentPresets = () => [...bound, generic];
    expect(await start("gpt-5.5")).toMatchObject({ ...generic, model: "gpt-5.5" });
    expect(await start(model)).toMatchObject(first);
  });

  it("creates a lead on Opus with the lead's tools", () => {
    const { create, session } = setup();
    const { lead, project } = create("clice");
    expect(lead.projectLink).toEqual({ projectId: project.id, role: "lead" });
    expect(lead.name).toBe("clice · lead");
    expect([...lead.agents.values()][0].info.model).toBe("gpt-6-astra");
    const tools = session(lead).panelTools!.tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(["start_session", "archive_session", "message_project"]),
    );
  });

  it("starts a worker in a worktree folder and hands it the task", async () => {
    const { create, call, session, workspaces, root, objectives } = setup();
    const { lead, project } = create("clice");
    await withTask(call, lead);

    const reply = await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "implement it",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    expect(reply).toContain(`Started session ${worker.id}`);
    expect(worker.cwd).toBe(path.join(root, "wt"));
    expect(worker.projectLink).toEqual({ projectId: project.id, role: "worker" });
    expect(session(worker).sent).toEqual(["[From the project lead]\n\nimplement it"]);
    expect(worker.messages.find((m) => m.kind === "user")).toMatchObject({
      content: "implement it",
      from: { role: "lead" },
    });
    expect(objectives()[0]).toMatchObject({
      sessions: [worker.id],
      tasks: [{ id: "t1", state: "doing", session: worker.id }],
    });
  });

  it("validates Pi worker presets and project defaults when levels are known", async () => {
    const { host, create, call, session, workers } = setup();
    host.modelOptions = () => [
      { id: "mock/known", backend: "pi", label: "Known", effortLevels: ["low"] },
      { id: "mock/unknown", backend: "pi", label: "Unknown" },
    ];
    host.projectDefaults = () => ({ model: "mock/known", effort: "xhigh" });
    const { lead } = create("pi");
    expect(session(lead).getState().config.effort).toBeUndefined();
    const args = { title: "Worker", cwd: "wt", task: "task", effort: "xhigh" };
    await expect(call(lead, "start_session", args)).rejects.toThrow(
      "mock/known has no effort xhigh",
    );
    await call(lead, "start_session", { ...args, model: "mock/unknown" });
    expect(session(workers()[0]).getState().config.effort).toBe("xhigh");
  });

  it("starts a worker at the effort asked for, one its model has", async () => {
    const { create, call, session, workspaces, root } = setup();
    fs.mkdirSync(path.join(root, "wt"), { recursive: true });
    const { lead } = create("clice");
    const workers = () => [...workspaces.values()].filter((w) => w.projectLink?.role === "worker");
    await call(lead, "start_session", {
      title: "w",
      cwd: "wt",
      task: "t",
      model: "gpt-5.6-terra",
      effort: "max",
    });
    expect([...workers()[0].agents.values()][0].info.model).toBe("gpt-5.6-terra");
    expect(session(workers()[0]).getState().config.effort).toBe("max");
    // On the default model too.
    await call(lead, "start_session", { title: "w2", cwd: "wt", task: "t", effort: "low" });
    expect(session(workers()[1]).getState().config.effort).toBe("low");

    await expect(
      call(lead, "start_session", {
        title: "w3",
        cwd: "wt",
        task: "t",
        model: "gpt-5.5",
        effort: "max",
      }),
    ).rejects.toThrow("gpt-5.5 has no effort max; one of: low, medium, high, xhigh");
    await expect(
      call(lead, "start_session", {
        title: "w4",
        cwd: "wt",
        task: "t",
        model: "gpt-5.5",
        effort: "ultra",
      }),
    ).rejects.toThrow("gpt-5.5 has no effort ultra; one of: low, medium, high, xhigh");
    expect(workers()).toHaveLength(2);

    // An empty effort is none: the model's default stands.
    await call(lead, "start_session", { title: "w5", cwd: "wt", task: "t", effort: "" });
    expect(session(workers()[2]).getState().config.effort).toBeUndefined();
  });

  it("runs leads and unnamed workers on the configured model and effort, if a lead may run on it", async () => {
    const { manager, root, workspaces, call, host, session, workers } = setup();
    fs.mkdirSync(path.join(root, "wt"), { recursive: true });
    host.projectDefaults = () => ({ model: "gpt-5.6-sol", effort: "high" });
    const project = manager.create("clice", root);
    const lead = workspaces.get(project.leadWorkspaceId!)!;
    expect([...lead.agents.values()][0].info.model).toBe("gpt-5.6-sol");
    expect(session(lead).getState().config.effort).toBe("high");
    const start = lead.agents.values().next().value!.session as unknown as {
      panelTools: { tools: Array<{ name: string; description: string }> };
    };
    const tool = start.panelTools.tools.find((t) => t.name === "start_session")!;
    expect(tool.description).toContain("Models: gpt-5.6-sol, gpt-6-astra");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    expect(workers()[0].resolveAgent()!.info.model).toBe("gpt-5.6-sol");
    expect(session(workers()[0]).getState().config.effort).toBe("high");

    const args = { title: "named", cwd: "wt", task: "t", preset: AGENT_PRESETS[0].name };
    await call(lead, "start_session", args);
    expect(session(workers().at(-1)!).getState().config.effort).toBe("high");
    await call(lead, "start_session", { ...args, model: "gpt-5.6-sol" });
    expect(session(workers().at(-1)!).getState().config.effort).toBeUndefined();

    // A model no lead runs on, or an effort its model lacks, is not taken.
    host.projectDefaults = () => ({ model: "gpt-5", effort: "high" });
    const other = path.join(root, "..", "other");
    fs.mkdirSync(other, { recursive: true });
    const next = workspaces.get(manager.create("other", other).leadWorkspaceId!)!;
    expect([...next.agents.values()][0].info.model).toBe("gpt-6-astra");
    host.projectDefaults = () => ({ model: "gpt-5.5", effort: "max" });
    await call(lead, "start_session", { title: "w2", cwd: "wt", task: "t" });
    expect(session(workers().at(-1)!).getState().config.effort).toBeUndefined();
  });

  it("takes a Codex model for the lead and its workers, not an unknown one", async () => {
    const { manager, root, workspaces, call } = setup();
    fs.mkdirSync(path.join(root, "wt"), { recursive: true });
    expect(() => manager.create("x", root, "gpt-5")).toThrow(
      "The selected model is not in the available model catalog.",
    );
    const project = manager.create("clice", root, "gpt-5.5");
    const lead = workspaces.get(project.leadWorkspaceId!)!;
    expect([...lead.agents.values()][0].info.model).toBe("gpt-5.5");
    await call(lead, "start_session", {
      title: "w",
      cwd: "wt",
      task: "t",
      model: "gpt-5.6-luna",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    expect([...worker.agents.values()][0].info.model).toBe("gpt-5.6-luna");
    await call(lead, "start_session", { title: "c", cwd: "wt", task: "t", model: "gpt-5.5" });
    const codex = [...workspaces.values()].filter((w) => w.projectLink?.role === "worker")[1];
    expect([...codex.agents.values()][0].info.model).toBe("gpt-5.5");
  });

  it("does not invent a default model for new leads, worker tools, or starts", async () => {
    const { host, manager, root, create, call, session, workspaces } = setup();
    const { lead } = create("existing lead");
    host.modelOptions = () => [];
    const tool = manager.toolsFor(lead)!.tools.find((tool) => tool.name === "start_session")!;
    expect(tool.description).toContain("Models: none available.");
    expect(tool.description).not.toContain("gpt-6-astra");
    expect((tool.shape.model as z.ZodString).description).toBe(
      "Model override. No models are available.",
    );
    session(lead).setPanelTools(manager.toolsFor(lead));

    const args = { title: "worker", cwd: "wt", task: "work" };
    await expect(call(lead, "start_session", args)).rejects.toMatchObject({
      issue: { code: "no_models_available" },
    });
    expect(() => manager.create("new lead", null, undefined, root)).toThrow(
      "No models are available to start a session.",
    );
    expect(workspaces.size).toBe(1);
    expect(manager.list()).toHaveLength(1);
  });

  it("refuses bad input before creating anything", async () => {
    const { create, call, workspaces } = setup();
    const { lead } = create("clice");
    await expect(
      call(lead, "start_session", { title: "x", cwd: "nope", task: "t" }),
    ).rejects.toThrow("worktree add");
    await expect(
      call(lead, "start_session", { title: "x", cwd: "wt", task: "t", model: "gpt-5" }),
    ).rejects.toMatchObject({
      issue: { code: "invalid_explicit_model", source: "request.model", value: null },
    });
    await expect(
      call(lead, "start_session", { title: "x", cwd: "wt", task: "t", objective_id: "core/x" }),
    ).rejects.toThrow("No objective core/x");
    await withTask(call, lead);
    await expect(
      call(lead, "start_session", {
        title: "x",
        cwd: "wt",
        task: "t",
        objective_id: "core/modules",
        task_id: "t9",
      }),
    ).rejects.toThrow("No task t9 in core/modules");
    expect(workspaces.size).toBe(1);
  });

  it("tells a worker what it is on, as it stands: the task, the lead's word since, its objective", async () => {
    const { create, call, workspaces, endTurn } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "add_items", { objective_id: "core/modules", decisions: ["which std?"] });
    await call(lead, "write_objective", { id: "core/lexer", title: "Lexer", goal: "tokens" });
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "Implement C++20 modules in the scanner.",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    await call(lead, "update_item", {
      objective_id: "core/modules",
      item_id: "d1",
      outcome: "C++20",
    });
    await call(lead, "message_session", { session_id: worker.id, message: "Skip header units." });
    endTurn(worker);
    await tick();

    const now = await call(worker, "current_task");
    expect(now).toContain(`You are session ${worker.id} "modules"`);
    expect(now).toContain("Implement C++20 modules in the scanner.");
    expect(now).toContain("Later from the lead");
    expect(now).toContain("Skip header units.");
    expect(now).toContain("core/modules — Modules");
    expect(now).toContain(`- t1 [doing] implement (session ${worker.id})`);
    expect(now).toContain("- d1 settled: which std? → C++20");
    expect(now).not.toContain("core/lexer");
    // Another objective, by id.
    expect(await call(worker, "current_task", { objective_id: "core/lexer" })).toContain(
      "core/lexer — Lexer",
    );
  });

  it("omits still-queued lead messages from current_task while keeping delivered ones", async () => {
    const { create, call, session, workspaces, endTurn } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "Implement scanner.",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;

    await call(lead, "message_session", { session_id: worker.id, message: "Use C++20." });
    endTurn(worker);
    await tick();

    // Queued behind the active turn: must not leak into current_task before dispatch.
    await call(lead, "message_session", {
      session_id: worker.id,
      message: "Do not touch parser.",
    });
    expect(worker.messages.find((m) => m.content === "Do not touch parser.")?.status).toBe(
      "queued",
    );

    const midTurn = await call(worker, "current_task");
    expect(midTurn).toContain("Implement scanner.");
    expect(midTurn).toContain("Use C++20.");
    expect(midTurn).not.toContain("Do not touch parser.");

    endTurn(worker);
    await tick();
    const afterDelivery = await call(worker, "current_task");
    expect(afterDelivery).toContain("Do not touch parser.");

    // A lead message whose dispatch failed never reached the worker and stays omitted.
    await call(lead, "message_session", {
      session_id: worker.id,
      message: "Never delivered.",
    });
    vi.spyOn(session(worker), "send").mockRejectedValueOnce(new Error("boom"));
    endTurn(worker);
    await tick();
    expect(worker.messages.find((m) => m.content === "Never delivered.")?.status).toBe("error");
    expect(await call(worker, "current_task")).not.toContain("Never delivered.");
  });

  it("starts an isolated worker that sees its own tasks and nothing else of the board", async () => {
    const { create, call, session, workspaces, objectives } = setup();
    const { lead, project } = create("clice");
    await withTask(call, lead);
    await call(lead, "add_items", {
      objective_id: "core/modules",
      tasks: ["document"],
      decisions: ["which std?"],
    });
    await call(lead, "write_objective", { id: "core/modules", context: "lexer half done" });
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "Implement it.",
      objective_id: "core/modules",
      task_id: "t1",
      isolated: true,
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    expect(worker.projectLink).toEqual({ projectId: project.id, role: "worker", isolated: true });
    expect(session(worker).panelTools!.tools.map((t) => t.name)).toEqual([
      "report_progress",
      "finish_task",
      "current_task",
    ]);
    const now = await call(worker, "current_task");
    expect(now).toContain("Implement it.");
    expect(now).toContain(
      "core/modules — Modules\ngoal: C++20\n\nyour tasks:\n- t1 [doing] implement",
    );
    for (const hidden of ["document", "which std?", "lexer half done", "decisions"]) {
      expect(now, hidden).not.toContain(hidden);
    }
    // Neither reaches the handler through a backend's schema; the manager holds anyway.
    await expect(call(worker, "current_task", { objective_id: "core/modules" })).rejects.toThrow(
      "reads only its own task",
    );
    await call(worker, "finish_task", { summary: "done", context: "rewritten" });
    expect(objectives()[0]).toMatchObject({
      context: "lexer half done",
      tasks: [{ id: "t1", state: "review" }, { state: "todo" }],
    });
  });

  it("delivers a worker's report to the lead and moves its task to review", async () => {
    const { create, call, session, workspaces, objectives } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;

    // The lead is busy: the report waits in its queue.
    session(lead).isRunning = true;
    await call(worker, "finish_task", { summary: "done on branch modules" });
    await tick();
    expect(session(lead).sent).toEqual([]);
    const report = lead.messages.find((m) => m.from?.role === "worker")!;
    expect(report).toMatchObject({
      status: "queued",
      content: "Finished:\n\ndone on branch modules",
      from: { workspaceId: worker.id, name: "modules" },
    });
    expect(objectives()[0].tasks[0].state).toBe("review");
  });

  it("writes the objective's context with the finished report, and sends nothing when it is refused", async () => {
    const { create, call, workspaces, objectives, session } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    session(lead).isRunning = true;
    await expect(
      call(worker, "finish_task", { summary: "done", context: "x".repeat(1001) }),
    ).rejects.toThrow("The context is 1001 characters");
    expect(lead.messages.some((m) => m.from?.role === "worker")).toBe(false);
    expect(objectives()[0].tasks[0].state).toBe("doing");
    await call(worker, "finish_task", { summary: "done", context: "Modules scan; docs left." });
    expect(objectives()[0]).toMatchObject({ context: "Modules scan; docs left." });
    expect(objectives()[0].tasks[0].state).toBe("review");
    expect(objectives()[0].contextWritten).toBeGreaterThan(0);
  });

  it("still reports when the context has nowhere to go, and says so", async () => {
    const { create, call, workspaces, objectives } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    const reports = () => lead.messages.filter((m) => m.from?.role === "worker").length;
    // An empty context is none.
    expect(await call(worker, "finish_task", { summary: "a", context: "" })).toBe(
      "Reported to the lead.",
    );
    await call(lead, "write_objective", { id: "core/modules", status: "dropped", reason: "r" });
    expect(await call(worker, "finish_task", { summary: "b", context: "c" })).toBe(
      "Reported to the lead. The context was not written: no objective on the board names this session.",
    );
    expect(
      await call(worker, "finish_task", {
        summary: "c",
        context: "c",
        objective_id: "core/modules",
      }),
    ).toBe("Reported to the lead. The context was not written: core/modules is dropped.");
    expect(reports()).toBe(3);
    expect(objectives()[0]).toMatchObject({ status: "dropped", reason: "r" });
  });

  it("takes back a context over the limit that is already there", async () => {
    const { create, call, workspaces, objectives, base } = setup();
    const { project, lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    const long = "x".repeat(1500);
    const file = path.join(
      base,
      ".agent-team",
      "projects",
      project.id,
      "objectives",
      "core",
      "modules.toml",
    );
    // By hand, before the limit: above the tasks.
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf-8").replace("\n[[tasks]]", `context = "${long}"\n\n[[tasks]]`),
    );
    expect(objectives()[0].context).toBe(long);
    expect(await call(worker, "finish_task", { summary: "s", context: long })).toBe(
      "Reported to the lead.",
    );
  });

  it("gives a worker its task and objectives without who else worked there or needs them", async () => {
    const { create, call, workspaces } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "write_objective", {
      id: "core/docs",
      title: "Docs",
      goal: "g",
      depends_on: ["core/modules"],
    });
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    const now = await call(worker, "current_task");
    expect(now).toContain("core/modules — Modules");
    expect(now).not.toContain("needed by:");
    expect(now).not.toContain("sessions:");
    const full = await call(lead, "read_objective", { id: "core/modules" });
    expect(full).toContain("needed by: core/docs");
    expect(full).toContain(`sessions: ${worker.id} "modules"`);
  });

  it("lets a worker keep the board: its new objective and the task it takes up name it", async () => {
    const { create, call, workers, objectives } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const w = workers()[0];
    await call(w, "update_item", { objective_id: "core/modules", item_id: "t1", state: "doing" });
    expect(objectives()[0].tasks[0]).toMatchObject({ state: "doing", session: w.id });
    await call(w, "write_objective", { id: "core/modules", context: "half the lexer" });
    expect(objectives()[0].context).toBe("half the lexer");
    // Not added to an objective it only wrote to.
    expect(objectives()[0].sessions).toEqual([]);
    await call(w, "write_objective", { id: "core/docs", title: "Docs", goal: "Write them" });
    expect(objectives().find((o) => o.id === "core/docs")!.sessions).toEqual([w.id]);
    expect(await call(w, "current_task")).toContain("core/docs");
    // The lead's own taking up names nobody.
    await call(lead, "add_items", { objective_id: "core/modules", tasks: ["bench"] });
    await call(lead, "update_item", {
      objective_id: "core/modules",
      item_id: "t2",
      state: "doing",
    });
    const modules = objectives().find((o) => o.id === "core/modules")!;
    expect(modules.tasks[1]).toMatchObject({ text: "bench", state: "doing" });
    expect(modules.tasks[1].session).toBeUndefined();
  });

  it("shows which worktrees a session works in and which are free to reuse", async () => {
    const { create, call, workers, root, manager } = setup();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
    const [used, free] = ["wt-1", "wt-2"].map((n) => path.join(path.dirname(root), n));
    git("worktree", "add", "-q", used, "-b", "one");
    git("worktree", "add", "-q", free, "-b", "two");
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: used, task: "t" });
    const status = await call(lead, "project_status");
    expect(status).toMatch(
      /## Size\n- objectives: 0 files, 0 KB\n- issues: 0 modules, 0 KB\n- notes: \d+ files?, \d+ KB/,
    );
    const line = (dir: string) =>
      status.split("\n").find((l) => l.startsWith(`- ${fs.realpathSync(dir)} `))!;
    expect(line(used)).toMatch(new RegExp(`; in use by ${workers()[0].id} \\(`));
    expect(line(free)).toMatch(/; free$/);
    expect(line(root)).toContain(`in use by ${lead.id}`);
    // The user's own session there: the lead is told the worktree is not its to reuse.
    manager.setReporting(workers()[0].id, false);
    expect(
      (await call(lead, "project_status"))
        .split("\n")
        .find((l) => l.startsWith(`- ${fs.realpathSync(used)} `)),
    ).toContain("the user's own: not yours to reuse");
  });

  it("lets leads message each other without waiting", async () => {
    const { create, call, session } = setup();
    const a = create("clice");
    const b = create("clangd");
    expect(await call(a.lead, "list_projects")).toContain(`${b.project.id} "clangd"`);
    const reply = await call(a.lead, "message_project", {
      project_id: b.project.id,
      message: "which LSP version?",
    });
    expect(reply).toContain('Sent to the lead of "clangd"');
    expect(session(b.lead).sent[0]).toContain(`(${a.project.id}). If they ask for something`);
    expect(b.lead.messages.find((m) => m.from)!.from).toEqual({
      workspaceId: a.lead.id,
      name: "clice",
      role: "peer",
      projectId: a.project.id,
    });
    await expect(
      call(a.lead, "message_project", { project_id: a.project.id, message: "x" }),
    ).rejects.toThrow("That is this project");
  });

  it("archives only an idle worker", async () => {
    const { create, call, session, workspaces } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    await expect(call(lead, "archive_session", { session_id: worker.id })).rejects.toThrow(
      "still working",
    );
    // The turn ends.
    session(worker).isRunning = false;
    session(worker).emit("event", { kind: "result", content: "" });
    expect(await call(lead, "archive_session", { session_id: worker.id })).toBe('Archived "w".');
    expect(worker.isArchived).toBe(true);
  });

  it("lets the user switch a worker's reports to the lead off and on: it then only reads the project", async () => {
    const { create, call, session, workspaces, frames, manager } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    const names = () => session(worker).panelTools!.tools.map((t) => t.name);
    expect(names()).toContain("finish_task");
    const finish = session(worker).panelTools!.tools.find((t) => t.name === "finish_task")!;
    // What the lead still had queued for it goes with the switch.
    session(worker).isRunning = true;
    await call(lead, "message_session", { session_id: worker.id, message: "and the tests" });
    expect(worker.messages.some((m) => m.status === "queued")).toBe(true);

    manager.setReporting(worker.id, false);
    expect(worker.projectLink).toMatchObject({ role: "worker", unreported: true });
    expect(worker.messages.some((m) => m.status === "queued")).toBe(false);
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "workspace_updated", id: worker.id }),
    );
    expect(names().sort()).toEqual(
      [
        "list_objectives",
        "read_objective",
        "list_issues",
        "list_notes",
        "read_issue",
        "read_note",
        "project_status",
        "read_session",
        "search_history",
        "read_entry",
        "query_history",
      ].sort(),
    );
    expect(session(worker).panelTools!.instructions).toContain(
      "do not report to the project's lead",
    );
    expect(await call(worker, "list_objectives")).toContain("core/modules");
    // A tool definition the agent still remembers sends nothing.
    await expect(finish.handler({ summary: "done" })).rejects.toThrow(
      "does not report to the lead",
    );
    expect(lead.messages.some((m) => m.from?.role === "worker")).toBe(false);
    // The lead can no longer send it work, stop or archive it; it sees whose it is.
    for (const [tool, args] of [
      ["message_session", { session_id: worker.id, message: "x" }],
      ["stop_session", { session_id: worker.id }],
      ["archive_session", { session_id: worker.id }],
    ] as const) {
      await expect(call(lead, tool, args)).rejects.toThrow("the user's own session");
    }
    expect(await call(lead, "project_status")).toContain(
      "(the user's own: does not report to you)",
    );

    manager.setReporting(worker.id, true);
    expect(worker.projectLink).toEqual({
      projectId: worker.projectLink!.projectId,
      role: "worker",
    });
    expect(names()).toContain("finish_task");
    // The lead has no switch of its own.
    expect(() => manager.setReporting(lead.id, false)).toThrow();
  });

  it("lets a switch off outlast what the worker's running turn holds: its writes and its report are refused, its steered message stays", async () => {
    const { create, call, session, workers, manager, objectives, endTurn } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "w",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const [worker] = workers();
    const s = session(worker);
    const tool = (name: string) => s.panelTools!.tools.find((t) => t.name === name)!;

    // A message the running turn already took, and one still waiting.
    s.isRunning = true;
    Object.assign(s, { steer: () => Promise.resolve(true) });
    await call(lead, "message_session", { session_id: worker.id, message: "steered" });
    Object.assign(s, { steer: () => Promise.resolve(false) });
    await call(lead, "message_session", { session_id: worker.id, message: "waiting" });
    await tick();
    const write = tool("write_objective");

    // A report whose context is still being written when the switch comes.
    const m = manager as unknown as { stamp: (...a: unknown[]) => Promise<unknown> };
    const stamp = m.stamp.bind(manager);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    m.stamp = async (...a) => {
      await held;
      return stamp(...a);
    };
    const report = tool("finish_task").handler({ summary: "done", context: "Done." });
    manager.setReporting(worker.id, false);
    release();
    await expect(report).rejects.toThrow("does not report to the lead");
    expect(lead.messages.some((x) => x.from?.role === "worker")).toBe(false);

    const contents = () =>
      worker.messages.filter((x) => x.from?.role === "lead").map((x) => x.content);
    expect(contents()).toContain("steered");
    expect(contents()).not.toContain("waiting");
    // The board no longer says it works on the lead's task, and it waits on no one.
    expect(objectives()[0].tasks[0]).toMatchObject({ state: "todo" });
    expect(objectives()[0].tasks[0].session).toBeUndefined();
    expect(objectives()[0].sessions).not.toContain(worker.id);
    expect(manager.awaitsUser(worker)).toBe(false);
    // The turn ends without the model having read the steered one: it is not run later.
    const steered = worker.messages.find((x) => x.content === "steered")!;
    s.emit("unread", [steered.id]);
    endTurn(worker);
    await tick();
    expect(contents()).not.toContain("steered");
    expect(s.sent.filter((p) => p.startsWith("[From the project lead]"))).toHaveLength(1);
    await expect(write.handler({ id: "core/modules", title: "Renamed" })).rejects.toThrow(
      "does not report to the lead",
    );
    expect(await call(worker, "read_objective", { id: "core/modules" })).toContain("Modules");
    expect(await call(worker, "read_objective", { id: "core/modules" })).not.toContain("Renamed");
  });

  it("no longer shows a switched-off worker as waiting for the user on the lead's task", async () => {
    const { create, call, session, workers, manager } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const [worker] = workers();
    await tick();
    // The task's turn ends in a question, with no report.
    session(worker).isRunning = false;
    session(worker).emit("event", { kind: "text_delta", content: "Which branch?" });
    session(worker).emit("event", { kind: "result", content: "" });
    await tick();
    expect(awaitsUser(worker)).toBe(true);
    manager.setReporting(worker.id, false);
    expect(awaitsUser(worker)).toBe(false);
  });

  it("drops a rate-limit retry of the lead's task, and gives a switched-off isolated worker the project to read", async () => {
    const { create, call, session, workers, manager } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t", isolated: true });
    const [worker] = workers();
    await tick();
    const task = worker.messages.find((m) => m.from?.role === "lead")!;
    const agent = [...worker.agents.values()][0];
    Object.assign(agent, {
      input: { id: task.id, replies: [] },
      retryPending: true,
      lastEnvelope: { inputId: "task", text: "[From the project lead]\n\nt" },
    });
    manager.setReporting(worker.id, false);
    expect(agent).toMatchObject({ retryPending: false, lastEnvelope: undefined });
    expect(session(worker).panelTools!.tools.map((t) => t.name)).toContain("list_objectives");
    expect(worker.projectLink).toMatchObject({ isolated: true, unreported: true });
  });

  it("renames the project, its lead and the tools' instructions", () => {
    const { create, manager, session, frames } = setup();
    const { lead, project } = create("clice");
    manager.rename(project.id, "clice2");
    expect(lead.name).toBe("clice2 · lead");
    expect(session(lead).panelTools!.instructions).toContain('project "clice2"');
    expect(frames).toContainEqual({ type: "workspace_updated", id: lead.id });
  });

  it("deletes the project and its lead, leaving its sessions as plain workspaces", async () => {
    const { create, call, manager, session, workspaces, frames } = setup();
    const { lead, project } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    manager.delete(project.id);
    expect(workspaces.has(lead.id)).toBe(false);
    expect(worker.projectLink).toBeUndefined();
    expect(session(worker).panelTools).toBeNull();
    expect(manager.list()).toEqual([]);
    expect(frames).toContainEqual({ type: "project_deleted", projectId: project.id });
  });

  it("forgets a deleted worker in the objectives", async () => {
    const { create, call, manager, workspaces, objectives } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "w",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    await manager.forget(worker);
    expect(objectives()[0].sessions).toEqual([]);
    expect(objectives()[0].tasks[0].session).toBeUndefined();
  });
});

describe("project messages that must not be lost or looped", () => {
  it("saves a report awaiting a Lead agent but rejects direct sends to an empty worker", async () => {
    const { create, call, workers, manager, objectives } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "w",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const [worker] = workers();
    lead.removeAgent([...lead.agents.keys()][0]);

    await expect(call(worker, "finish_task", { summary: "done" })).resolves.toMatch(
      /saved.*awaiting a Lead/,
    );
    expect(objectives()[0].tasks[0].state).toBe("review");
    worker.removeAgent([...worker.agents.keys()][0]);
    const tools = manager.toolsFor(lead)!.tools;
    await expect(
      tools
        .find((t) => t.name === "message_session")!
        .handler({ session_id: worker.id, message: "x" }),
    ).rejects.toThrow("has no agent");
  });

  it("wait out a rate-limit pause instead of replacing the prompt to retry", async () => {
    const registry = new HostRegistry();
    const fake = new FakeHost();
    registry.register(fake);
    const ws = new Workspace("ws-x", "w", "p", "local", "/tmp", registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
    });
    const agent = ws.addAgent("A", "gpt-6-astra[1m]", "a", "c", { backend: "codex" });
    const s = fake.lastSession!;
    await ws.sendMessage("P1");
    s.isRunning = false;
    s.emit("event", { kind: "error", content: "Usage limit reached (five-hour)." });
    ws.pauseAgent(agent.id, Date.now() + 3600_000, true);

    expect(ws.deliver("report", { workspaceId: "w2", name: "w2", role: "worker" }, "REPORT")).toBe(
      "queued",
    );
    expect(s.sent).toEqual(["P1"]);
    expect(ws.retryLast(agent.id)).toBe(true);
    expect(s.sent).toEqual(["P1", "P1"]);
    s.isRunning = false;
    s.emit("event", { kind: "result", content: "" });
    await tick();
    expect(s.sent).toEqual(["P1", "P1", "REPORT"]);
  });

  it("stop two leads from answering each other forever", async () => {
    const { create, call, session } = setup();
    const a = create("a");
    const b = create("b");
    const send = (from: typeof a, to: typeof b) => {
      session(to.lead).isRunning = false;
      return call(from.lead, "message_project", { project_id: to.project.id, message: "m" });
    };
    for (let i = 0; i < 3; i++) {
      await send(a, b);
      await send(b, a);
    }
    await expect(send(a, b)).rejects.toThrow("stop here and tell the user");
    expect(session(b.lead).sent.at(-1)).toContain("otherwise no reply is needed");
  });

  it("space out worker starts so a lead cannot burst sessions", async () => {
    useFakeTimers();
    try {
      const { create, call, workers, session } = setup();
      const { lead } = create("a");
      for (let i = 0; i < 3; i++) {
        await call(lead, "start_session", { title: `w${i}`, cwd: "wt", task: "t" });
      }
      const sent = () => workers().map((w) => session(w).sent.length);
      expect(sent()).toEqual([1, 0, 0]);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(sent()).toEqual([1, 1, 0]);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(sent()).toEqual([1, 1, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("project edge cases", () => {
  it("default workers to a Claude model even when the lead workspace has a Codex agent first", async () => {
    const { create, workers, manager } = setup();
    const { lead } = create("a");
    const claudeLead = [...lead.agents.keys()][0];
    lead.addAgent("Cx", "gpt-6-astra", "c", "c", { backend: "codex" });
    lead.removeAgent(claudeLead);
    const start = manager.toolsFor(lead)!.tools.find((t) => t.name === "start_session")!;
    expect(await start.handler({ title: "w", cwd: "wt", task: "t" })).toContain("on gpt-6-astra");
    expect([...workers()[0].agents.values()][0].info.model).toBe("gpt-6-astra");
  });

  it("default workers to Opus 5.5 whatever model the lead was switched to", async () => {
    const { create, workers, manager } = setup();
    const { lead } = create("a");
    const [agent] = lead.agents.values();
    agent.info.model = "gpt-5.6-terra";
    const start = manager.toolsFor(lead)!.tools.find((t) => t.name === "start_session")!;
    expect((start.shape.model as z.ZodString).description).toContain("Default gpt-6-astra");
    expect(await start.handler({ title: "w", cwd: "wt", task: "t" })).toContain("on gpt-6-astra");
    await start.handler({ title: "f", cwd: "wt", task: "t", model: "gpt-5.6-terra" });
    expect(workers().map((w) => [...w.agents.values()][0].info.model)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-terra",
    ]);
  });

  it("refuse board updates for a deleted project instead of recreating its folder", async () => {
    const { base, create, manager } = setup();
    const { lead, project } = create("a");
    const tools = manager.toolsFor(lead)!.tools;
    manager.delete(project.id);
    await expect(
      tools
        .find((t) => t.name === "write_objective")!
        .handler({ id: "core/late", title: "late", goal: "g" }),
    ).rejects.toThrow(`No project ${project.id}`);
    expect(fs.existsSync(path.join(base, ".agent-team", "projects", project.id))).toBe(false);
  });

  it("save renamed and unlinked workspaces right away", async () => {
    const { create, call, manager, workers, saved } = setup();
    const { lead, project } = create("a");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const [worker] = workers();
    manager.rename(project.id, "b");
    expect(saved).toEqual([lead.id]);
    manager.delete(project.id);
    expect(saved).toEqual([lead.id, worker.id]);
  });

  it("show a worker's cut-off turn in the project status", async () => {
    const { create, call, workers, registry } = setup();
    const { lead } = create("a");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const worker = workers()[0];
    // A restart mid-turn marks the reply interrupted.
    const restored = Workspace.fromState(worker.getState(), registry);
    const reply = restored.messages.find((m) => m.kind === "agent")!;
    worker.messages.find((m) => m.kind === "agent")!.content = reply.content;
    expect(await call(lead, "project_status")).toContain("its last turn did not finish");
  });
});

describe("project messages across a restart", () => {
  it("keep a queued report's sender and prompt", async () => {
    const { create, call, session, workers, registry, base } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const [worker] = workers();
    session(lead).isRunning = true;
    await call(worker, "finish_task", { summary: "done" });

    saveWorkspace(base, lead.getState());
    saveIndex(base, [lead.id]);
    const [state] = loadAll(base);
    expect(state.projectLink).toEqual(lead.projectLink);
    const restored = Workspace.fromState(state, registry);
    const queued = restored.messages.find((m) => m.status === "queued")!;
    expect(queued.from).toMatchObject({ role: "worker", workspaceId: worker.id });
    expect(summarizeMessages([queued])[0].from).toEqual(queued.from);
    restored.dequeueNext([...restored.agents.keys()][0]);
    const s = [...restored.agents.values()][0].session as FakeSession;
    expect(s.sent).toEqual([expect.stringMatching(/^\[agent-team:report:[\da-f-]+\]/)]);
    expect(s.sent[0]).toContain(`[From session "w" (${worker.id})]\n\nFinished:\n\ndone`);
  });
});

describe("message_session and read_session", () => {
  it("queue behind a busy worker and say so", async () => {
    const { create, call, session, workers, endTurn } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "first task" });
    const [worker] = workers();
    expect(
      await call(lead, "message_session", { session_id: worker.id, message: "tests too" }),
    ).toBe('Sent to "w" (queued: it is busy).');
    endTurn(worker);
    await tick();
    expect(session(worker).sent).toEqual([
      "[From the project lead]\n\nfirst task",
      "[From the project lead]\n\ntests too",
    ]);
  });

  it("go into a Codex worker's running turn, and its stop takes back what the model had not read", async () => {
    const { create, call, session, workers } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "first task" });
    const [worker] = workers();
    const s = session(worker);
    // As CodexSession does: steered ids it has not seen read go back at the
    // turn's end.
    const unread: string[] = [];
    Object.assign(s, {
      steer: (_text: string, id: string) => {
        unread.push(id);
        return Promise.resolve(true);
      },
      abort: () => {
        s.isRunning = false;
        s.emit("unread", unread.splice(0));
      },
    });
    expect(
      await call(lead, "message_session", { session_id: worker.id, message: "tests too" }),
    ).toBe('Sent to "w" (it is working: the message goes into its running turn).');
    const note = worker.messages.find((m) => m.content === "tests too")!;
    expect(note).toMatchObject({ status: "queued", steering: true });
    await call(lead, "stop_session", { session_id: worker.id });
    await tick();
    expect(worker.messages.includes(note)).toBe(false);
    expect(s.sent).toEqual(["[From the project lead]\n\nfirst task"]);
  });

  it("refuse the lead itself and other projects' sessions", async () => {
    const { create, call, workers } = setup();
    const a = create("a");
    const b = create("b");
    await call(b.lead, "start_session", { title: "theirs", cwd: "wt", task: "t" });
    const [other] = workers();
    for (const id of [a.lead.id, other.id]) {
      await expect(
        call(a.lead, "message_session", { session_id: id, message: "x" }),
      ).rejects.toThrow(`No session ${id} in this project`);
    }
  });

  it("label senders, count tool calls and cut long replies", async () => {
    const { create, call, session, workers, endTurn } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const [worker] = workers();
    session(worker).emit("event", {
      kind: "tool_use",
      content: "**Bash**",
      toolName: "Bash",
      toolUseId: "t1",
    });
    session(worker).emit("event", { kind: "text_delta", content: "x".repeat(3500) });
    endTurn(worker);
    await tick();
    await worker.sendMessage("user typed this");
    const out = await call(lead, "read_session", { session_id: worker.id, last: 10 });
    const agentName = [...worker.agents.values()][0].info.name;
    const headers = out.split("\n").filter((l) => l.startsWith("--- "));
    expect(headers.map((h) => h.split(" · ")[0])).toEqual([
      "--- Lead",
      `--- ${agentName}`,
      "--- user",
      `--- ${agentName}`,
    ]);
    // The message id, for reading around it later.
    expect(headers[1]).toMatch(/ · done · 1 tool calls · msg-\S+$/);
    expect(out).toContain("x".repeat(3000) + " …(truncated)");
    const last1 = await call(lead, "read_session", { session_id: worker.id, last: 1 });
    expect(last1.split("\n").filter((l) => l.startsWith("--- "))).toHaveLength(1);
  });
});

describe("rate-limit retries", () => {
  // A worker whose lead task just hit a rate limit, its retry pending.
  const limited = async () => {
    const h = setup();
    const { lead } = h.create("a");
    await h.call(lead, "start_session", { title: "w", cwd: "wt", task: "build it" });
    const w = h.workers()[0];
    const [agentId] = w.agents.keys();
    const s = h.session(w);
    // As a limit goes: the server pauses on the session's signal, then the
    // error and the turn's result (snap fixture claude/usage-limit).
    w.pauseAgent(agentId, Date.now() + 3600_000, true);
    s.emit("event", { kind: "error", content: "Usage limit reached" });
    h.endTurn(w);
    return { ...h, lead, w, agentId, s };
  };
  const CARRY_ON = "[From the panel] A usage limit cut your turn off. Carry on where you left off.";
  // A worker whose turn the CLI started (after its task was done) the
  // limit cut: no prompt of ours to send again.
  const cutWakeUp = async () => {
    const h = setup();
    const { lead } = h.create("a");
    await h.call(lead, "start_session", { title: "w", cwd: "wt", task: "build it" });
    const w = h.workers()[0];
    const [agentId] = w.agents.keys();
    const s = h.session(w);
    h.endTurn(w);
    wakeUp(s);
    w.pauseAgent(agentId, Date.now() + 3600_000, true);
    s.emit("event", { kind: "error", content: "Usage limit reached" });
    h.endTurn(w);
    return { ...h, w, agentId, s };
  };
  // A wake-up or a task's report starting a turn while they wait.
  const wakeUp = (s: { isRunning: boolean; emit(e: string, v: unknown): void }) => {
    s.isRunning = true;
    s.emit("event", {
      kind: "notice",
      level: "wakeup",
      content: "A background task reported back — resumed to handle its result.",
    });
  };

  it("are dropped by a stop, the lead's or the user's, a cleared context and an archive", async () => {
    for (const stop of ["lead", "user", "clear", "archive"] as const) {
      const { lead, w, agentId, s, call } = await limited();
      if (stop === "lead") await call(lead, "stop_session", { session_id: w.id });
      if (stop === "user") w.abortAll();
      if (stop === "clear") w.clearContext(agentId);
      if (stop === "archive") await call(lead, "archive_session", { session_id: w.id });
      expect(w.retryLast(agentId), stop).toBe(false);
      expect(w.getState().agents[0].pausedUntil, stop).toBeUndefined();
      expect(s.sent, stop).toHaveLength(1);
    }
  });

  it("tell the agent to carry on, never re-send a prompt already answered, when a turn the CLI started hits the limit", async () => {
    const { w, s, call, endTurn } = await limited();
    const [agentId] = w.agents.keys();
    expect(w.retryLast(agentId)).toBe(true);
    await call(w, "finish_task", { summary: "built" });
    endTurn(w);
    // A wake-up after a background task, then the limit.
    s.emit("event", { kind: "text_delta", content: "checking the build" });
    w.pauseAgent(agentId, Date.now() + 3600_000, true);
    s.emit("event", { kind: "error", content: "Usage limit reached" });
    endTurn(w);
    expect(w.retryLast(agentId)).toBe(true);
    expect(s.sent.slice(2)).toEqual([CARRY_ON]);
    expect(w.messages.filter((m) => m.kind === "system").pop()?.content).toContain(
      "was told to carry on where the usage limit cut it off",
    );
  });

  it("give way to the user's message when all they would do is tell the agent to carry on", async () => {
    const { w, agentId, s } = await cutWakeUp();
    await w.sendMessage("never mind, do Y");
    expect(s.sent.slice(1)).toEqual(["never mind, do Y"]);
    expect(w.retryLast(agentId)).toBe(false);
  });

  it("give way to the user's message that came while the turn that ended them ran", async () => {
    const { w, s, endTurn } = await limited();
    wakeUp(s);
    s.emit("event", { kind: "text_delta", content: "the build passed" });
    await w.sendMessage("do Y");
    endTurn(w);
    await tick();
    expect(s.sent.slice(1)).toEqual(["do Y"]);
  });

  it("stay a carry-on when the carry-on is cut off too", async () => {
    const { w, agentId, s, endTurn } = await cutWakeUp();
    expect(w.retryLast(agentId)).toBe(true);
    w.pauseAgent(agentId, Date.now() + 3600_000, true);
    s.emit("event", { kind: "error", content: "Usage limit reached" });
    endTurn(w);
    // So the user's message still goes in its place.
    await w.sendMessage("do Y");
    expect(s.sent).toEqual(["[From the project lead]\n\nbuild it", CARRY_ON, "do Y"]);
  });

  it("tell the agent to carry on after a restart too", async () => {
    const { w, agentId, restart, session } = await cutWakeUp();
    const back = restart(w);
    expect(back.retryLast(agentId)).toBe(true);
    expect(session(back).sent).toEqual([CARRY_ON]);
  });

  it("are dropped by the user's Stop on a turn the CLI started", async () => {
    const { w, agentId, s } = await limited();
    wakeUp(s);
    w.pauseAgent(agentId, Date.now() - 1, true);
    (s as unknown as { interrupt(): Promise<boolean> }).interrupt = () => Promise.resolve(true);
    await w.interruptAgent(agentId);
    s.isRunning = false;
    s.emit("event", { kind: "result", content: "", interrupted: true });
    await tick();
    expect(s.sent).toHaveLength(1);
    expect(w.retryLast(agentId)).toBe(false);
  });

  it("go ahead of what comes in meanwhile: the lead's message waits, the user's is the cue to retry now", async () => {
    useFakeTimers();
    try {
      const { lead, w, agentId, s, call, endTurn } = await limited();
      // Past the reset, the retry not yet fired (a restart's ladder).
      w.pauseAgent(agentId, Date.now() - 1, true);
      await call(lead, "message_session", { session_id: w.id, message: "also Y" });
      expect(s.sent).toHaveLength(1);
      expect(w.retryLast(agentId)).toBe(true);
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.sent.slice(1)).toEqual([
        "[From the project lead]\n\nbuild it",
        "[From the project lead]\n\nalso Y",
      ]);

      w.pauseAgent(agentId, Date.now() + 3600_000, true);
      s.isRunning = false;
      await w.sendMessage("U");
      expect(s.sent.slice(3)).toEqual(["[From the project lead]\n\nalso Y"]);
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.sent.slice(4)).toEqual(["U"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keep their prompt and their time through a turn the CLI starts that the limit refuses too", async () => {
    const { w, agentId, s, endTurn } = await limited();
    wakeUp(s);
    s.emit("event", { kind: "error", content: "Usage limit reached" });
    endTurn(w);
    await tick();
    expect(s.sent).toHaveLength(1);
    expect(w.retryLast(agentId)).toBe(true);
    expect(s.sent.slice(1)).toEqual(["[From the project lead]\n\nbuild it"]);
  });

  it("wait on through a turn the CLI starts that ends without an answer of the model's", async () => {
    const { w, agentId, s, endTurn } = await limited();
    // An overloaded API: a notice, a retry banner and nothing from the model.
    wakeUp(s);
    s.emit("event", { kind: "retry", content: "API retry 1/10 in 5s" });
    endTurn(w);
    await tick();
    expect(s.sent).toHaveLength(1);
    expect(w.retryLast(agentId)).toBe(true);
    expect(s.sent.slice(1)).toEqual(["[From the project lead]\n\nbuild it"]);
  });

  it("go right after a turn the CLI starts that the limit lets through, as a carry-on", async () => {
    const { w, agentId, s, endTurn } = await limited();
    wakeUp(s);
    s.emit("event", { kind: "text_delta", content: "the build passed" });
    endTurn(w);
    await tick();
    // That turn saw "build it": sending it again would do it twice.
    expect(s.sent.slice(1)).toEqual([CARRY_ON]);
    expect(w.retryLast(agentId)).toBe(false);
  });

  it("outlast a turn the CLI started that runs when they fall due", async () => {
    const { w, agentId, s } = await limited();
    wakeUp(s);
    w.pauseAgent(agentId, Date.now() - 1, true);
    expect(w.retryLast(agentId)).toBe(false);
    s.emit("event", { kind: "error", content: "[Claude error] connection reset" });
    s.isRunning = false;
    await tick();
    expect(s.sent.slice(1)).toEqual(["[From the project lead]\n\nbuild it"]);
  });

  it("outlast a turn the CLI started that fails after the model saw their prompt, as a carry-on", async () => {
    const { w, agentId, s } = await limited();
    wakeUp(s);
    s.emit("event", { kind: "tool_use", content: "**Bash**", toolName: "Bash", toolUseId: "t1" });
    w.pauseAgent(agentId, Date.now() - 1, true);
    s.emit("event", { kind: "error", content: "[Claude error] connection reset" });
    s.isRunning = false;
    await tick();
    expect(s.sent.slice(1)).toEqual([CARRY_ON]);
  });

  it("are not used up by the user writing while a turn still runs", async () => {
    useFakeTimers();
    try {
      const { w, agentId, s, endTurn } = await limited();
      s.isRunning = true;
      await w.sendMessage("U");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.sent).toHaveLength(1);
      expect(w.retryLast(agentId)).toBe(true);
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.sent.slice(1)).toEqual(["[From the project lead]\n\nbuild it", "U"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("worker tasks held back for spacing", () => {
  const twoStarts = async () => {
    const env = setup();
    const { lead } = env.create("a");
    await env.call(lead, "start_session", { title: "w0", cwd: "wt", task: "first" });
    const reply = await env.call(lead, "start_session", { title: "w1", cwd: "wt", task: "second" });
    const w1 = env.workers().find((w) => w.name === "w1")!;
    return { ...env, lead, reply, w1 };
  };

  it("wait as a saved queued message and go out after the gap, or after a restart", async () => {
    useFakeTimers();
    try {
      const { reply, w1, session, registry } = await twoStarts();
      expect(reply).toContain("Its task goes out in 15 s");
      const task = w1.messages.find((m) => m.kind === "user")!;
      expect(task).toMatchObject({ status: "queued", content: "second", from: { role: "lead" } });
      const restored = Workspace.fromState(w1.getState(), registry);
      expect(restored.messages.find((m) => m.status === "queued")?.queuedEnvelope?.text).toBe(
        "[From the project lead]\n\nsecond",
      );
      expect(session(w1).sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual(["[From the project lead]\n\nsecond"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leave nothing to retry once sent, so a restart sends nothing again", async () => {
    useFakeTimers();
    try {
      const { w1, session, endTurn, registry } = await twoStarts();
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      endTurn(w1);
      const saved = w1.getState().agents[0];
      expect([saved.pausedUntil, saved.lastEnvelope]).toEqual([undefined, undefined]);
      const restored = Workspace.fromState(w1.getState(), registry);
      expect([...restored.agents.values()][0].retryPending).toBe(false);
      expect(session(w1).sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("space the lead's messages that wake idle workers", async () => {
    useFakeTimers();
    try {
      const { w1, lead, call, session, endTurn, workers } = await twoStarts();
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      const w0 = workers().find((w) => w.name === "w0")!;
      endTurn(w0);
      endTurn(w1);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(await call(lead, "message_session", { session_id: w0.id, message: "go on" })).toBe(
        'Sent to "w0".',
      );
      expect(await call(lead, "message_session", { session_id: w1.id, message: "go on" })).toBe(
        'Sent to "w1"; it goes out in 15 s: starts are spaced out.',
      );
      expect(session(w1).sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual([
        "[From the project lead]\n\nsecond",
        "[From the project lead]\n\ngo on",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("go out even when their timer fires a millisecond early", async () => {
    useFakeTimers();
    try {
      const { w1, session } = await twoStarts();
      vi.setSystemTime(Date.now() - 1);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual(["[From the project lead]\n\nsecond"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pass a queued lead message on to the agent that takes over from a removed one", async () => {
    const { w1 } = await twoStarts();
    const [first] = w1.agents.keys();
    const b = w1.addAgent("B", "gpt-6-astra", "b", "c", { backend: "codex" });
    expect(w1.removeAgent(first)).toEqual([]);
    await tick();
    const heir = w1.agents.get(b.id)!.session as FakeSession;
    expect(heir.sent).toEqual(["[From the project lead]\n\nsecond"]);
  });

  it("keep a lead message passed on to the agent that takes over through a crash", async () => {
    const { w1, base, registry } = await twoStarts();
    const [first] = w1.agents.keys();
    const b = w1.addAgent("B", "gpt-6-astra", "b", "c", { backend: "codex" });
    (w1.agents.get(b.id)!.session as FakeSession).isRunning = true;
    // As the server saves: the messages it was told changed, and new ones.
    const save = () => historyOf(base).save(w1.id, w1.getMessages(), w1.takeChanged());
    save();
    expect(w1.removeAgent(first)).toEqual([]);
    save();
    const back = Workspace.fromState(
      { ...w1.getState(), messages: historyOf(base).load(w1.id) },
      registry,
    );
    expect(back.messages.find((m) => m.status === "queued")).toMatchObject({
      content: "second",
      queuedFor: b.id,
    });
  });

  it("are not held back by a restart's checks on the workers that owe their lead a word", async () => {
    useFakeTimers();
    try {
      const { create, call, manager, workers } = setup();
      const { lead } = create("a");
      for (let i = 0; i < 8; i++) {
        await call(lead, "start_session", { title: `w${i}`, cwd: "wt", task: `t${i}` });
      }
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(workers().every((w) => !w.lastDelivered()[0].answered)).toBe(true);
      manager.recheckWorkers();
      expect(await call(lead, "start_session", { title: "x", cwd: "wt", task: "x" })).not.toContain(
        "goes out in",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stay ahead of a follow-up sent in the meantime", async () => {
    useFakeTimers();
    try {
      const { w1, lead, call, session, endTurn } = await twoStarts();
      expect(await call(lead, "message_session", { session_id: w1.id, message: "also X" })).toBe(
        'Sent to "w1" (queued: it is busy).',
      );
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      endTurn(w1);
      await vi.advanceTimersByTimeAsync(10);
      expect(session(w1).sent).toEqual([
        "[From the project lead]\n\nsecond",
        "[From the project lead]\n\nalso X",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("are dropped by stop_session", async () => {
    useFakeTimers();
    try {
      const { w1, lead, call, session, frames } = await twoStarts();
      await call(lead, "stop_session", { session_id: w1.id });
      expect(w1.messages.some((m) => m.status === "queued")).toBe(false);
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "message_removed", workspaceId: w1.id }),
      );
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("are dropped with their project", async () => {
    useFakeTimers();
    try {
      const { w1, session, manager, lead } = await twoStarts();
      manager.delete(lead.projectLink!.projectId);
      expect(w1.projectLink).toBeUndefined();
      expect(w1.messages.some((m) => m.status === "queued")).toBe(false);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a worker that goes idle without reporting", () => {
  // A lead with one worker running the task it was given.
  const started = async () => {
    const h = setup();
    const { lead, project } = h.create("a");
    await h.call(lead, "start_session", { title: "w", cwd: "wt", task: "do it" });
    const w = h.workers()[0];
    const say = (text: string, to = w) =>
      h.session(to).emit("event", { kind: "text_delta", content: text });
    const told = () =>
      lead
        .getMessages()
        .filter((m) => m.from?.workspaceId === w.id)
        .map((m) => m.content);
    const settle = () => vi.advanceTimersByTimeAsync(SETTLE_MS);
    const ask = (message: string) => h.call(lead, "message_session", { session_id: w.id, message });
    // The lead's message queued behind the task, which then ends and lets it run.
    const askNext = async (message: string) => {
      await ask(message);
      h.endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
    };
    const state = (s: string) => h.session(w).emit("runState", s);
    return { ...h, lead, project, w, say, told, settle, ask, askNext, state };
  };
  const CARRY_ON =
    "[From the panel] A server restart cut your turn off. Carry on where you left off.";
  const note = (how: string, message: string, reply?: string) =>
    [`No report on your message "${message}" (${how}).`, reply && `Its last reply:\n\n${reply}`]
      .filter(Boolean)
      .join("\n\n");

  it("takes a refused finish_task for no report: the worker still waits for the user", async () => {
    useFakeTimers();
    try {
      const { w, session } = await started();
      session(w).emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "f1",
        content: "**finish_task**",
      });
      session(w).emit("event", {
        kind: "tool_result",
        toolUseId: "f1",
        content: "The context is 1200 characters, over the 1000 the board takes.",
        isError: true,
      });
      session(w).emit("event", { kind: "text_delta", content: "Shall I shorten it?" });
      session(w).isRunning = false;
      session(w).emit("event", { kind: "result", content: "" });
      expect(awaitsUser(w)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a task that ends in a question to the user, across a restart too", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, restart, manager } = await started();
      say("Which branch should this go on?");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
      expect(w.lastDelivered()[0].answered).toBe(true);
      const back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(back.lastDelivered()[0].answered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the lead once, with the last reply, when its later message is answered without a report", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, askNext } = await started();
      await askNext("which branch is it on?");
      say("feature/x");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
      expect(told()).toEqual([]);
      await settle();
      expect(told()).toEqual([note("its turn ended", "which branch is it on?", "feature/x")]);
      // A wake-up turn after it (a background task) is no new work from the lead.
      say("late output");
      endTurn(w);
      await settle();
      expect(told()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the wait from the last thing the worker did", async () => {
    useFakeTimers();
    try {
      const { w, say, told, endTurn, ask } = await started();
      await ask("also this");
      say("first");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
      say("second");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
      expect(told()).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(told()).toEqual([note("its turn ended", "also this", "second")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not tell in the gap between a background task's end and the turn it starts", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, askNext, state } = await started();
      await askNext("run the build");
      // Timings from the claude/bash-bg recording.
      say("started");
      state("waiting");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(4008);
      state("idle");
      await vi.advanceTimersByTimeAsync(1861);
      state("working");
      await settle();
      expect(told()).toEqual([]);
      say("the output says done");
      endTurn(w);
      state("idle");
      await settle();
      expect(told()).toEqual([note("its turn ended", "run the build", "the output says done")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing more once it finished, but a progress report is not one", async () => {
    useFakeTimers();
    try {
      const { w, call, say, told, settle, endTurn, ask } = await started();
      say("Done.");
      await call(w, "finish_task", { summary: "merged" });
      endTurn(w);
      await settle();
      expect(told()).toEqual(["Finished:\n\nmerged"]);

      // A follow-up queued behind the turn that reported is owed its own.
      await ask("the API docs");
      await ask("and the README");
      await call(w, "finish_task", { summary: "API docs written" });
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      await call(w, "report_progress", { text: "README half done" });
      say("Stopping here for now.");
      endTurn(w);
      await settle();
      expect(told().slice(1)).toEqual([
        "Finished:\n\nAPI docs written",
        "Progress:\n\nREADME half done",
        note("its turn ended", "and the README", "Stopping here for now."),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells how a failed turn ended, and leaves one the user stopped to them", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, session, endTurn, ask, state } = await started();
      say("Working on it");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await settle();
      expect(told()).toEqual([
        note("its turn failed: API Error: 529 overloaded", "do it", "Working on it"),
      ]);

      await ask("try again");
      say("Retrying");
      session(w).isRunning = false;
      w.abortAll();
      await settle();
      expect(w.lastDelivered()[0]).toMatchObject({ stopped: "user", answered: true });

      // Stopped while it waited on a background task, its turn long over.
      await ask("run the benchmark");
      say("Started it in the background.");
      state("waiting");
      endTurn(w);
      w.abortAll();
      state("idle");
      await settle();
      expect(w.lastDelivered()[0]).toMatchObject({ stopped: "user", answered: true });

      // Context cleared under a background task: a stop too.
      await ask("profile it");
      say("Profiling in the background.");
      state("waiting");
      endTurn(w);
      w.clearContext([...w.agents.keys()][0]);
      state("idle");
      await settle();
      expect(told()).toHaveLength(1);
      expect(w.lastDelivered()[0].answered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a stopped turn that a wake-up then carried on as ended, and keeps the reply past a stray error", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, session, endTurn, state } = await started();
      say("Build started.");
      state("waiting");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "result", content: "", interrupted: true });
      state("working");
      say("Build passed.");
      endTurn(w);
      state("idle");
      // The CLI dies afterwards with an error of its own.
      session(w).emit("event", { kind: "error", content: "[Claude error] exited" });
      await settle();
      expect(told()).toEqual([
        note("its turn failed: [Claude error] exited", "do it", "Build passed."),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the lead's own stop alone, and a worker the user took over to the user", async () => {
    useFakeTimers();
    try {
      const { lead, w, call, say, told, settle, session, endTurn, ask } = await started();
      session(w).isRunning = false;
      await call(lead, "stop_session", { session_id: w.id });
      await settle();
      expect(told()).toEqual([]);

      // The user's turns after the lead's message make it theirs.
      await ask("which commit?");
      say("abc123");
      await w.sendMessage("now rebase it");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      say("Rebased.");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
      expect(w.lastDelivered()[0].answered).toBe(true);

      // A failed turn too: the user is there to see it.
      await ask("and push it");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await w.sendMessage("what happened?");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
      expect(w.lastDelivered()[0]).toMatchObject({ since: true, answered: true });

      // A command the panel answers itself runs no turn.
      await ask("which branch?");
      say("main");
      endTurn(w);
      await w.sendMessage("/usage");
      await settle();
      expect(told()).toEqual([note("its turn ended", "which branch?", "main")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits while anything is still to run: a queued message, a pause, a background task, a wake-up", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, ask, state } = await started();
      await ask("also this");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);

      const [agentId] = w.agents.keys();
      w.pauseAgent(agentId, Date.now() + 60_000);
      say("Also done.");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
      w.pauseAgent(agentId, 0);

      state("waiting");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);

      state("sleeping");
      await settle();
      expect(told()).toEqual([]);
      state("idle");
      await settle();
      expect(told()).toEqual([note("its turn ended", "also this", "Also done.")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps two agents of a worker apart, and a stop of one from the other", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, askNext } = await started();
      await askNext("is staging up?");
      const b = w.addAgent("B", "gpt-6-astra", "b", "c", { backend: "codex" });
      const other = w.agents.get(b.id)!.session as FakeSession;
      await w.sendMessage("look at the logs", b.id);
      say("Need the staging URL.");
      endTurn(w);
      other.emit("event", { kind: "text_delta", content: "tailing them" });
      other.emit("runState", "waiting");
      other.isRunning = false;
      other.emit("event", { kind: "result", content: "" });
      w.abortAll();
      other.emit("runState", "idle");
      await settle();
      expect(told()).toEqual([note("its turn ended", "is staging up?", "Need the staging URL.")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws out of its timer, and stops with the manager", async () => {
    useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { lead, w, told, settle, endTurn, ask, askNext, manager, host } = await started();
      await askNext("which branch?");
      const [leadAgent] = lead.agents.keys();
      lead.removeAgent(leadAgent);
      endTurn(w);
      await settle();
      expect(errors).toHaveBeenCalledWith("[projects]", expect.any(Error));

      host.addAgent(lead, "Lead", "gpt-6-astra", "l", "c");
      await ask("again");
      manager.close();
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
    } finally {
      errors.mockRestore();
      vi.useRealTimers();
    }
  });

  it("comes from the panel, about the worker", async () => {
    useFakeTimers();
    try {
      const { lead, w, endTurn, askNext, settle } = await started();
      await askNext("which branch?");
      endTurn(w);
      await settle();
      expect(lead.getMessages().find((m) => m.from?.workspaceId === w.id)!.from).toEqual({
        workspaceId: w.id,
        name: "w",
        role: "panel",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on a turn a restart cut off, a shutdown or a crash, without the lead", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, restart, manager, ask, session, endTurn } = await started();
      say("Halfway through");
      w.abortAll("restart");
      let back = restart(w);
      expect(awaitsUser(back)).toBe(false);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(session(back).sent).toEqual([CARRY_ON]);
      expect(back.getMessages().filter((m) => m.from?.role === "panel")).toMatchObject([
        { from: { workspaceId: w.id, name: "w", role: "panel" } },
      ]);
      // What comes of it stands for the task: a question waits for the user.
      say("Which branch should this go on?", back);
      endTurn(back);
      await settle();
      expect(told()).toEqual([]);
      expect(awaitsUser(back)).toBe(true);
      // Nothing is cut off any more: a later restart carries nothing on.
      back = restart(back);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([]);
      expect(awaitsUser(back)).toBe(true);

      // The lead's later question, cut off by a crash mid-turn, goes on too,
      // and its answer reaches the lead as the answer to the question.
      await ask("which commit?");
      say("Looking", back);
      back = restart(back);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([CARRY_ON]);
      say("abc123", back);
      endTurn(back);
      await settle();
      expect(told()).toEqual([note("its turn ended", "which commit?", "abc123")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on the lead's message past a command the user had the panel answer", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, restart, manager, askNext, session, endTurn } = await started();
      await askNext("which commit?");
      say("Looking");
      await w.sendMessage("/usage");
      const back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([CARRY_ON]);
      say("abc123", back);
      endTurn(back);
      await settle();
      expect(told()).toEqual([note("its turn ended", "which commit?", "abc123")]);
      expect(awaitsUser(back)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on once: cut off again, the lead is told", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, restart, manager, session } = await started();
      say("Halfway through");
      w.abortAll("restart");
      let back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([CARRY_ON]);
      say("Three quarters", back);
      back.abortAll("restart");
      back = restart(back);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([]);
      expect(told()).toEqual([
        note("a server restart cut it off again after it carried on", "do it", "Three quarters"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a carry-on waiting for its start slot when the user writes first", async () => {
    useFakeTimers();
    try {
      const { w, say, told, restart, manager, session, endTurn } = await started();
      say("Halfway through");
      w.abortAll("restart");
      const back = restart(w);
      manager.recheckWorkers();
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 1000);
      // Other starts hold the next slots.
      manager.takeStartSlot(1000);
      manager.takeStartSlot(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(session(back).sent).toEqual([]);
      await back.sendMessage("forget that, do this instead");
      endTurn(back);
      await vi.advanceTimersByTimeAsync(3 * START_SPACING_MS);
      expect(session(back).sent).toEqual(["forget that, do this instead"]);
      expect(told()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a turn a restart cut off to the user who wrote to it since", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, restart, manager, session, endTurn } = await started();
      say("Halfway through");
      w.abortAll("restart");
      const back = restart(w);
      await back.sendMessage("never mind, stop there");
      endTurn(back);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual(["never mind, stop there"]);
      expect(told()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps across a restart what it owes and what it already reported", async () => {
    useFakeTimers();
    try {
      const { w, call, say, told, settle, endTurn, restart, manager, ask } = await started();
      say("Done.");
      await call(w, "finish_task", { summary: "merged" });
      endTurn(w);
      let back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual(["Finished:\n\nmerged"]);

      // A notice still waiting at the restart.
      await ask("which commit?");
      say("abc123", back);
      endTurn(back);
      back = restart(back);
      manager.recheckWorkers();
      await settle();
      expect(told()[1]).toBe(note("its turn ended", "which commit?", "abc123"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a rate-limit retry still to run, however late it is", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, session, endTurn, askNext } = await started();
      await askNext("is it merged?");
      const [agentId] = w.agents.keys();
      say("Working");
      w.pauseAgent(agentId, Date.now() + 1000, true);
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "rate limited" });
      await settle();
      expect(told()).toEqual([]);
      w.retryLast(agentId);
      say("Done now");
      endTurn(w);
      await settle();
      expect(told()).toEqual([note("its turn ended", "is it merged?", "Done now")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("owes nothing once archived", async () => {
    useFakeTimers();
    try {
      const { lead, w, told, settle, endTurn, call, manager } = await started();
      endTurn(w);
      await call(lead, "archive_session", { session_id: w.id });
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(w.getState().agents[0].delivered?.answered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on a task whose background work a crash cut off, and shows no wait till then", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, state, restart, manager, session } = await started();
      say("Started the build in the background.");
      state("waiting");
      endTurn(w);
      const back = restart(w);
      expect(awaitsUser(back)).toBe(false);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(session(back).sent).toEqual([CARRY_ON]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the lead what a session the user started answers it", async () => {
    useFakeTimers();
    try {
      const { lead, call, host, project, session, endTurn, settle, w } = await started();
      const own = host.createWorkspace("mine", w.cwd, { projectId: project.id, role: "worker" });
      host.addAgent(own, "A", "gpt-6-astra", "a", "c");
      await own.sendMessage("what does this do?");
      endTurn(own);
      await settle();
      await call(lead, "message_session", { session_id: own.id, message: "which branch?" });
      await vi.advanceTimersByTimeAsync(0);
      session(own).emit("event", { kind: "text_delta", content: "main" });
      endTurn(own);
      await settle();
      expect(
        lead
          .getMessages()
          .filter((m) => m.from?.workspaceId === own.id)
          .map((m) => m.content),
      ).toEqual([note("its turn ended", "which branch?", "main")]);
      expect(awaitsUser(own)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a fresh lead nothing of what the lead of a deleted project said", async () => {
    useFakeTimers();
    try {
      const { w, endTurn, settle, manager, project, workspaces } = await started();
      manager.delete(project.id);
      endTurn(w);
      manager.restored(w);
      manager.recheckWorkers();
      await settle();
      const fresh = workspaces.get(manager.get(w.projectLink!.projectId)!.leadWorkspaceId!)!;
      expect(fresh.getMessages().filter((m) => m.from)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows it waiting for the user when its task or the user's turn ends on them", async () => {
    useFakeTimers();
    try {
      const { w, say, settle, endTurn, restart, frames } = await started();
      const shown = () =>
        frames
          .filter((f) => f.type === "workspace_updated" && f.id === w.id)
          .map((f) => f.awaitsUser === true);
      say("Which branch should this go on?");
      endTurn(w);
      // At once, and once.
      expect(shown()).toEqual([true]);
      await settle();
      expect(shown()).toEqual([true]);
      expect(awaitsUser(restart(w))).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    useFakeTimers();
    try {
      const { w, lead, say, settle, endTurn, session, call, askNext, frames, manager, project } =
        await started();
      const shown = () =>
        frames
          .filter((f) => f.type === "workspace_updated" && f.id === w.id)
          .map((f) => f.awaitsUser === true);
      say("Which branch?");
      endTurn(w);
      // The user answers, and it reports the task finished. A client that
      // connects meanwhile leaves the others holding what it gets.
      await w.sendMessage("main");
      expect(awaitsUser(w)).toBe(false);
      manager.showAllAwaiting();
      expect(shown()).toEqual([true, false]);
      session(w).emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "t1",
        content: "**finish_task**",
      });
      await call(w, "finish_task", { summary: "merged" });
      // A command the panel answers itself is no turn, during one or after.
      await w.sendMessage("/usage");
      endTurn(w);
      await settle();
      await w.sendMessage("/usage");
      manager.showAllAwaiting();
      expect(awaitsUser(w)).toBe(false);
      expect(shown()).toEqual([true, false]);

      // A question of the user's after that is answered to them; not inside
      // an archived project.
      await w.sendMessage("which commit?");
      say("abc123");
      endTurn(w);
      await settle();
      expect(shown()).toEqual([true, false, true]);
      // Archived with its project it waits for nobody, until it is opened.
      endTurn(lead);
      manager.setArchived(project.id, true);
      manager.setArchived(project.id, false);
      expect(w.isArchived).toBe(true);
      expect(shown()).toEqual([true, false, true, false]);
      w.archivedAt = null;
      manager.showAwaiting(w);
      expect(shown()).toEqual([true, false, true, false, true]);

      // What it answers the lead later is the lead's.
      await w.sendMessage("thanks");
      await askNext("is it pushed?");
      say("yes");
      endTurn(w);
      await settle();
      expect(shown()).toEqual([true, false, true, false, true, false]);

      // A failed turn, or one the user stopped, asks nothing.
      await w.sendMessage("push the tag");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await settle();
      expect(awaitsUser(w)).toBe(false);
      await w.sendMessage("try again");
      say("Pushing");
      session(w).isRunning = false;
      w.abortAll();
      await settle();
      expect(awaitsUser(w)).toBe(false);
      expect(shown()).toEqual([true, false, true, false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows it waiting only once nothing more is to run, through wake-ups and notices", async () => {
    useFakeTimers();
    try {
      const { w, say, settle, endTurn, state, call, session, frames } = await started();
      const shown = () =>
        frames
          .filter((f) => f.type === "workspace_updated" && f.id === w.id)
          .map((f) => f.awaitsUser === true);
      // A background task still runs, then a pause holds it: not yet.
      say("Which branch? The build runs meanwhile.");
      state("waiting");
      endTurn(w);
      expect(awaitsUser(w)).toBe(false);
      const [agentId] = w.agents.keys();
      w.pauseAgent(agentId, Date.now() + 1000);
      state("idle");
      expect(shown()).toEqual([]);
      await settle();
      expect(shown()).toEqual([true]);
      // A notice of the panel's after it changes nothing.
      w.postSystemMessage("Context compacted.");
      expect(awaitsUser(w)).toBe(true);
      // Reported finished, a wake-up's turn after it asks nothing.
      await w.sendMessage("main");
      session(w).emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "t1",
        content: "**finish_task**",
      });
      await call(w, "finish_task", { summary: "merged" });
      endTurn(w);
      session(w).isRunning = true;
      say("late output");
      endTurn(w);
      await settle();
      expect(awaitsUser(w)).toBe(false);
      expect(shown()).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a task the lead retried after it failed waiting for the user", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, session, endTurn, ask } = await started();
      say("Working on it");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await settle();
      expect(told()).toHaveLength(1);
      await ask("try again");
      say("Which branch should this go on?");
      endTurn(w);
      await settle();
      expect(told()).toHaveLength(1);
      expect(awaitsUser(w)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads no command the panel answered as the user's turn after a restart", async () => {
    useFakeTimers();
    try {
      const { w, say, settle, session, call, endTurn, restart } = await started();
      say("Which branch?");
      endTurn(w);
      await w.sendMessage("main");
      session(w).emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "t1",
        content: "**finish_task**",
      });
      await call(w, "finish_task", { summary: "merged" });
      endTurn(w);
      await w.sendMessage("/usage");
      await settle();
      expect(awaitsUser(restart(w))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  const emitRefusedFinish = (s: FakeSession, toolUseId: string) => {
    s.emit("event", {
      kind: "tool_use",
      toolName: "mcp__panel__finish_task",
      toolUseId,
      content: "**finish_task**",
    });
    s.emit("event", {
      kind: "tool_result",
      toolUseId,
      content: "The context is over the limit.",
      isError: true,
    });
  };

  it("clears awaitsUser in a multi-agent worker once finish_task succeeds, and re-arms on later user turns or dialogs", async () => {
    useFakeTimers();
    try {
      const { w, say, settle, session, call, endTurn, restart, host, frames, manager } =
        await started();
      const shown = () =>
        frames
          .filter((f) => f.type === "workspace_updated" && f.id === w.id)
          .map((f) => f.awaitsUser === true);

      host.addAgent(w, "Allen", "gpt-6-astra", "b", "c");
      const [primaryEntry, allenEntry] = [...w.agents.values()];
      const allen = allenEntry.session as FakeSession;
      const endAllen = () => {
        allen.isRunning = false;
        allen.emit("event", { kind: "result", content: "" });
      };

      // Primary asks a question, then user consults a second agent who replies
      // without finish_task, then user tells the primary to finish.
      say("Here is my plan. Thoughts?");
      endTurn(w);
      expect(awaitsUser(w)).toBe(true);
      expect(shown()).toEqual([true]);

      await w.sendMessage("@Allen review this");
      allen.emit("event", { kind: "text_delta", content: "Looks solid." });
      endAllen();
      expect(awaitsUser(w)).toBe(true);

      await w.sendMessage("LGTM, go ahead");
      session(w).emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "ft1",
        content: "**finish_task**",
      });
      await call(w, "finish_task", { summary: "done" });
      endTurn(w);
      await settle();
      expect(awaitsUser(w)).toBe(false);
      expect(shown()).toEqual([true, false]);

      // Pending UI dialog still forces awaitsUser even after finish_task,
      // and showAwaiting broadcasts both the rise and clear.
      const dialog = {
        workspaceId: w.id,
        agentId: primaryEntry.info.id,
        processGeneration: 1,
        requestId: "confirm-1",
      };
      session(w).emit("ui_dialog_request", dialog);
      manager.showAwaiting(w);
      expect(awaitsUser(w)).toBe(true);
      expect(manager.awaitsUser(w)).toBe(true);
      session(w).emit("ui_dialog_resolved", dialog);
      manager.showAwaiting(w);
      expect(awaitsUser(w)).toBe(false);
      expect(manager.awaitsUser(w)).toBe(false);
      expect(shown()).toEqual([true, false, true, false]);

      // A targeted local slash command (@Allen /usage) after finish_task is not
      // mistaken for a new user turn after restart.
      await w.sendMessage("@Allen /usage");
      const afterFinish = restart(w);
      expect(awaitsUser(afterFinish)).toBe(false);

      // A new user message AFTER a successful finish_task re-arms awaitsUser
      // (both live and after restart), even when handled by the second agent.
      const [, allenAfter] = [...afterFinish.agents.values()];
      const allenRestarted = allenAfter.session as FakeSession;
      await afterFinish.sendMessage("@Allen one more check?");
      allenRestarted.emit("event", { kind: "text_delta", content: "Looks good, merge it?" });
      allenRestarted.isRunning = false;
      allenRestarted.emit("event", { kind: "result", content: "" });
      expect(awaitsUser(afterFinish)).toBe(true);
      const afterFollowUp = restart(afterFinish);
      expect(awaitsUser(afterFollowUp)).toBe(true);

      // A refused finish_task on a follow-up after an earlier successful
      // finish_task does not clear awaitsUser either.
      const primaryAfter = [...afterFollowUp.agents.values()][0].session as FakeSession;
      await afterFollowUp.sendMessage("report the follow-up too");
      emitRefusedFinish(primaryAfter, "ft-post-err");
      primaryAfter.emit("event", { kind: "text_delta", content: "Context too long." });
      primaryAfter.isRunning = false;
      primaryAfter.emit("event", { kind: "result", content: "" });
      expect(awaitsUser(afterFollowUp)).toBe(true);
      expect(awaitsUser(restart(afterFollowUp))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a refused finish_task supersede an earlier agent turn", async () => {
    useFakeTimers();
    try {
      const { w, say, settle, session, endTurn, restart, host } = await started();
      host.addAgent(w, "Allen", "gpt-6-astra", "b", "c");
      const allen = [...w.agents.values()][1].session as FakeSession;

      say("Plan?");
      endTurn(w);
      await w.sendMessage("@Allen thoughts?");
      allen.emit("event", { kind: "text_delta", content: "LGTM" });
      allen.isRunning = false;
      allen.emit("event", { kind: "result", content: "" });
      expect(awaitsUser(w)).toBe(true);

      // Refused finish_task on a failed turn must not clear Allen's earlier turn.
      await w.sendMessage("go ahead");
      emitRefusedFinish(session(w), "ft-err");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await settle();
      expect(awaitsUser(w)).toBe(true);

      // Refused finish_task on a completed turn still keeps awaitsUser true,
      // both live and after restart.
      await w.sendMessage("try again");
      emitRefusedFinish(session(w), "ft-err-2");
      say("Shall I shorten it?");
      endTurn(w);
      await settle();
      expect(awaitsUser(w)).toBe(true);
      expect(awaitsUser(restart(w))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears awaitsUser across a restart when a second agent finishes while primary keeps its delivered task turn", async () => {
    useFakeTimers();
    try {
      const { w, say, settle, call, endTurn, restart, host } = await started();
      host.addAgent(w, "Allen", "gpt-6-astra", "b", "c");
      const allen = [...w.agents.values()][1].session as FakeSession;

      // Primary stops on the task (a.input === a.delivered, restored after restart).
      say("Which approach?");
      endTurn(w);
      expect(awaitsUser(w)).toBe(true);

      // Second agent finishes the task without primary getting another turn.
      await w.sendMessage("@Allen wrap it up");
      allen.emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "ft-allen",
        content: "**finish_task**",
      });
      await call(w, "finish_task", { summary: "done by Allen" });
      allen.isRunning = false;
      allen.emit("event", { kind: "result", content: "" });
      await settle();
      expect(awaitsUser(w)).toBe(false);
      expect(awaitsUser(restart(w))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves to the user across a restart what they took over", async () => {
    useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, askNext, restart, manager } = await started();
      await askNext("which commit?");
      say("abc123");
      endTurn(w);
      await w.sendMessage("thanks");
      endTurn(w);
      const back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(back.lastDelivered()[0]).toMatchObject({ since: true, answered: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never shows the lead, a session the user started or an archived one waiting", async () => {
    useFakeTimers();
    try {
      const { lead, w, say, endTurn, call, host, session, project } = await started();
      say("Which branch?");
      endTurn(w);
      expect(awaitsUser(w)).toBe(true);
      await call(lead, "archive_session", { session_id: w.id });
      expect(awaitsUser(w)).toBe(false);

      const own = host.createWorkspace("mine", w.cwd, { projectId: project.id, role: "worker" });
      host.addAgent(own, "A", "gpt-6-astra", "a", "c");
      await own.sendMessage("what does this do?");
      session(own).emit("event", { kind: "text_delta", content: "It parses." });
      endTurn(own);
      expect(awaitsUser(own)).toBe(false);

      await lead.sendMessage("hi");
      session(lead).emit("event", { kind: "text_delta", content: "Hello." });
      endTurn(lead);
      expect(awaitsUser(lead)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is archived with all its sessions once none is busy, and comes back with its lead", async () => {
    useFakeTimers();
    try {
      const { w, lead, told, settle, endTurn, askNext, manager, project } = await started();
      await askNext("which branch?");
      expect(() => manager.setArchived(project.id, true)).toThrow(
        'Still busy: "w"; stop them first',
      );
      expect(manager.get(project.id)!.archivedAt ?? null).toBeNull();
      endTurn(w);
      await settle();
      expect(told()).toHaveLength(1);
      expect(() => manager.setArchived(project.id, true)).toThrow('Still busy: "a · lead"');
      endTurn(lead);
      manager.setArchived(project.id, true);
      expect([lead.isArchived, w.isArchived]).toEqual([true, true]);
      manager.setArchived(project.id, false);
      expect([lead.isArchived, w.isArchived]).toEqual([false, true]);

      // A session of an archived project opened again brings it back.
      manager.setArchived(project.id, true);
      w.archivedAt = null;
      manager.restored(w);
      expect(manager.get(project.id)!.archivedAt).toBeNull();
      expect(lead.isArchived).toBe(false);

      // One archived before its sessions went with it is settled at startup.
      manager.setArchived(project.id, true);
      lead.archivedAt = null;
      manager.archiveShelved();
      expect(lead.isArchived).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
