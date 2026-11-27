// Seed a dev instance with a remote-free Git clone, worktrees, transcripts and a board.
// No sessions start. Usage: npm run demo -- .agent-team/dev-9801
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectStore } from "../service/src/project/store";
import { ObjectiveStore, type Objective } from "../service/src/project/objectives";
import { IssueStore } from "../service/src/project/issues";
import { writeNote } from "../service/src/project/notes";
import { saveIndex } from "../service/src/workspace/state";
import { LEAD_MODEL } from "../service/src/project/manager";
import { backendForModel, defaultEffortForModel } from "../service/src/config/presets";
import type {
  AgentState,
  Message,
  MessageOrigin,
  WorkspaceState,
} from "../service/src/workspace/workspace";
import type { StreamEvent } from "../service/src/session/types";

import { isScriptMain, REPO_ROOT as ROOT } from "./script-paths.mjs";
import { seedCommit, seedGit as git, seedWorkspaces } from "./seed-corpus";

// Use actual scratch paths for both Markdown cases: a native absolute path
// with a line suffix, and a file URL with a line range.
function seedFileLinks(demo: string) {
  const root = path.join(demo, "_reports");
  fs.mkdirSync(root);
  const links = [
    { label: "Parser trace", file: path.join(root, "解析 trace.txt"), line: 42, end: 42 },
    { label: "Resolver report", file: path.join(root, "解析 report.txt"), line: 12, end: 20 },
  ];
  for (const { file, line } of links) {
    const lines = Array.from({ length: 90 }, (_, i) => `frame ${i + 1}`);
    lines[line - 1] = randomUUID();
    fs.writeFileSync(file, lines.join("\n"));
  }
  const drivePath = links[0].file.replaceAll("\\", "\\\\");
  const markdown = `[${links[0].label}](<${drivePath}:42>) · [${links[1].label}](${pathToFileURL(links[1].file).href}#L12-L20)`;
  return { markdown, links };
}

export interface SeedDemoOptions {
  quiet?: boolean;
  // Write a minimal config.toml if absent (used by automated E2E/benchmark runs).
  writeConfig?: boolean;
}

export interface SeedDemoResult {
  baseDir: string;
  repo: string;
  projectId: string;
  projectName: string;
  fileLinks: ReturnType<typeof seedFileLinks>["links"];
  worktrees: {
    mobilePanels: string;
    wakeTime: string;
    fileRoutes: string;
    readme: string;
  };
  workspaces: {
    lead: string;
    mobile: string;
    wake: string;
    routes: string;
    solo: string;
    past: string;
  };
}

export function seedDemo(baseDir: string, options: SeedDemoOptions = {}): SeedDemoResult {
  const base = path.resolve(baseDir);
  const inRepo = path.relative(ROOT, base);
  if (path.basename(base) === ".agent-team") {
    throw new Error(`${base} is a data dir; pass the dir that holds it (AGENT_TEAM_BASE_DIR)`);
  }
  // The production data lives in the repository root; a clone elsewhere in
  // the working tree would show up as untracked files.
  if (
    !inRepo.startsWith("..") &&
    !path.isAbsolute(inRepo) &&
    !inRepo.startsWith(`.agent-team${path.sep}`)
  ) {
    throw new Error(`${base} is in the repository; use a dir under .agent-team/ or outside it`);
  }
  for (const taken of [".agent-team", "demo"]) {
    if (fs.existsSync(path.join(base, taken))) {
      throw new Error(`${base} already has ${taken}/; seed an empty dir`);
    }
  }

  const demo = path.join(base, "demo");
  const repo = path.join(demo, "agent-team");
  const tree = (name: string) => path.join(demo, "agent-team-wt", name);
  const commit = (dir: string, file: string, text: string, message: string) => {
    fs.writeFileSync(path.join(dir, file), text);
    seedCommit(dir, "demo", "demo@localhost", file, message);
  };

  let result: SeedDemoResult;
  try {
    result = populate();
  } catch (e) {
    // Both were checked to be new: a failed run leaves nothing behind.
    fs.rmSync(demo, { recursive: true, force: true });
    fs.rmSync(path.join(base, ".agent-team"), { recursive: true, force: true });
    throw e;
  }

  const configPath = path.join(base, "config.toml");
  if (options.writeConfig && !fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      [
        "[user]",
        'name = "Demo"',
        'avatar = "D"',
        "",
        "[workspace]",
        "archive_after_days = 14",
        "",
        "[hosts.local]",
        'label = "Local"',
        'type = "local"',
        "",
      ].join("\n"),
    );
  } else if (!options.quiet && !fs.existsSync(configPath)) {
    console.log(`note: the server needs ${configPath} (see config.example.toml)`);
  }
  return result;

  function populate(): SeedDemoResult {
    fs.mkdirSync(demo, { recursive: true });
    git("clone", "--quiet", "--no-hardlinks", ROOT, repo);
    // Agents here must not push to the real repository.
    git("-C", repo, "remote", "remove", "origin");
    let baseBranch = git("-C", repo, "rev-parse", "--abbrev-ref", "HEAD").toString("utf-8").trim();
    if (!baseBranch || baseBranch === "HEAD") {
      baseBranch = "demo-base";
      git("-C", repo, "checkout", "-qb", baseBranch);
    }
    for (const [name, branch] of [
      ["mobile-panels", "ui/mobile-panels"],
      ["wake-time", "fix/wake-time"],
      ["file-routes", "fix/file-routes"],
      ["readme", "docs/readme"],
    ]) {
      git("-C", repo, "worktree", "add", "--quiet", "-b", branch, tree(name));
    }
    // Track the local base branch (no remote) so the ahead indicator renders in the demo UI.
    git("-C", tree("wake-time"), "branch", "--quiet", "--set-upstream-to", baseBranch);
    // What the finished workers say they committed.
    commit(
      tree("wake-time"),
      "WAKE-TIME.md",
      "Wake-ups count from the CLI's own delay in the ScheduleWakeup result.\n",
      "fix: wake-ups at the CLI's time",
    );
    commit(
      tree("file-routes"),
      "FILE-ROUTES.md",
      "Raw file downloads stream through pipeline(); FIFOs are refused.\n",
      "fix: file routes cannot take the server down",
    );
    // Work in progress, for the changed-files count.
    fs.appendFileSync(
      path.join(tree("mobile-panels"), "webview/src/styles.css"),
      "\n/* sheet header: 44px touch targets */\n",
    );
    fs.writeFileSync(
      path.join(tree("mobile-panels"), "NOTES.md"),
      "# Mobile panels\n\n- [ ] sheet header\n",
    );

    const now = Date.now();
    const ago = (min: number) => now - min * 60_000;
    let seq = 0;
    const id = (p: string) => `${p}-${now.toString(36)}-${++seq}`;

    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turns: 0,
      duration_ms: 0,
    };
    // As the server adds them: the lead's model (workers inherit it), its
    // default effort, permissions bypassed.
    const model = LEAD_MODEL;
    const effort = defaultEffortForModel(model) ?? undefined;
    const agent = (name: string, avatar: string, color: string, cwd: string): AgentState => ({
      id: id("agent"),
      name,
      model,
      avatar,
      color,
      isDefault: true,
      session: {
        sessionId: null,
        config: { cwd, backend: backendForModel(model), model, effort },
        usage,
      },
    });

    const user = (min: number, content: string, from?: MessageOrigin): Message => ({
      id: id("msg"),
      kind: "user",
      agentId: null,
      content,
      timestamp: ago(min),
      status: "done",
      ...(from && { from }),
    });
    const reply = (
      a: AgentState,
      min: number,
      content: string,
      events: StreamEvent[],
      tokens: number,
    ): Message => ({
      id: id("msg"),
      kind: "agent",
      agentId: a.id,
      content,
      timestamp: ago(min),
      status: "done",
      events,
      ...(effort && { effort }),
      context: { tokens, window: 1_000_000 },
    });
    const joined = (min: number, a: AgentState): Message => ({
      id: id("msg"),
      kind: "system",
      agentId: null,
      content: `${a.avatar} **${a.name}** joined the team`,
      timestamp: ago(min),
      status: "done",
    });
    let tool = 0;
    const toolCall = (
      toolName: string,
      content: string,
      toolResult: string,
      step: number,
      contentOffset = 0,
    ): StreamEvent => ({
      kind: "tool_use",
      content,
      toolName,
      toolUseId: `toolu_demo${++tool}`,
      toolResult,
      step,
      contentOffset,
    });
    const panelTool = (name: string, input: object, result: string, step: number) =>
      toolCall(
        `mcp__panel__${name}`,
        `**${name}**\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
        result,
        step,
      );
    const report = (name: "report_progress" | "finish_task", text: string, step: number) =>
      toolCall(`mcp__panel__${name}`, `**${name}**\n\n> ${text}`, "Delivered to the lead.", step);
    const read = (file: string, result: string, step: number) =>
      toolCall("Read", `**Read** \`${file}\``, result, step);
    const bash = (command: string, result: string, step: number) =>
      toolCall("Bash", `**Bash**\n\`\`\`bash\n${command}\n\`\`\``, result, step);
    const edit = (file: string, from: string, to: string, step: number, at = 0): StreamEvent => ({
      kind: "tool_use",
      content: `**Edit** \`${file}\`\n\`\`\`diff\n${from
        .split("\n")
        .map((l) => `- ${l}`)
        .join("\n")}\n${to
        .split("\n")
        .map((l) => `+ ${l}`)
        .join("\n")}\n\`\`\``,
      toolName: "Edit",
      toolInput: { tool: "Edit", file_path: file, old_string: from, new_string: to },
      toolUseId: `toolu_demo${++tool}`,
      toolResult: `The file ${file} has been updated.`,
      step,
      contentOffset: at,
    });
    const thinking = (content: string, step: number, at = 0): StreamEvent => ({
      kind: "thinking",
      content,
      step,
      contentOffset: at,
      durationMs: 4200,
      tokens: 180,
    });
    const explore = (description: string, summary: string, at = 0): StreamEvent[] => {
      const toolUseId = `toolu_demo${++tool}`;
      const subagent = {
        taskId: `a${tool}demo`,
        description,
        prompt: `${description}. Report file paths with line numbers.`,
        agentType: "Explore",
        taskType: "local_agent",
      };
      return [
        {
          kind: "subagent_start",
          content: description,
          toolUseId,
          contentOffset: at,
          subagent: {
            ...subagent,
            status: "completed",
            summary,
            usage: { totalTokens: 41_200, toolUses: 14, durationMs: 48_000 },
          },
        },
        {
          kind: "subagent_done",
          content: summary,
          toolUseId,
          contentOffset: at,
          subagent: { taskId: subagent.taskId, description: "", status: "completed", summary },
        },
      ];
    };

    // The project and its sessions.
    const store = new ProjectStore(base);
    const project = store.create("agent-team", repo);
    const origin = (ws: WorkspaceState, role: MessageOrigin["role"]): MessageOrigin => ({
      workspaceId: ws.id,
      name: ws.name,
      role,
      projectId: project.id,
    });

    const session = (
      name: string,
      cwd: string,
      a: AgentState,
      role: "lead" | "worker" | null,
      created: number,
    ): WorkspaceState => ({
      id: id("ws"),
      name,
      project: path.basename(cwd),
      hostId: "local",
      cwd,
      agents: [a],
      messages: [],
      createdAt: ago(created),
      lastActivityAt: ago(created),
      archivedAt: null,
      ...(role && { projectLink: { projectId: project.id, role } }),
    });

    const leadAgent = agent("Lead", "avatars/Laffey.jpg", "#D8A0D8", repo);
    const lead = session("agent-team · lead", repo, leadAgent, "lead", 300);
    const mobileAgent = agent("Perseus", "avatars/Perseus.jpg", "#C0C0C0", tree("mobile-panels"));
    const mobile = session("mobile panels", tree("mobile-panels"), mobileAgent, "worker", 90);
    const wakeAgent = agent("Allen", "avatars/Allen.jpg", "#8AB4F8", tree("wake-time"));
    const wake = session("wake-up time", tree("wake-time"), wakeAgent, "worker", 70);
    const routesAgent = agent(
      "Shorekeeper",
      "avatars/Shorekeeper.jpg",
      "#7DD3FC",
      tree("file-routes"),
    );
    const routes = session("file routes", tree("file-routes"), routesAgent, "worker", 200);
    routes.archivedAt = ago(120);
    project.lead = { hostId: lead.hostId, workspaceId: lead.id };
    store.save(project);

    lead.messages = [
      joined(300, leadAgent),
      user(
        95,
        "面板在大屏上太小了，手机上按钮也不好点。先把移动端的 sheet 做好，唤醒时间那个 bug 也顺手修掉。",
      ),
      reply(
        leadAgent,
        94,
        [
          "分成两件事，各开一个 worker：",
          "",
          "1. **mobile panels** — `webview/src/panels/SidePanel.tsx` 的 sheet 头部按钮只有 26px，" +
            "`webview/src/styles.css:3588` 的 body 内边距在手机上也偏小。worktree 在 `ui/mobile-panels`。",
          "2. **wake-up time** — CLI 把唤醒时间向上取整到整分钟，结果面板比实际早 30–90 秒。" +
            "见 `service/src/session/codex.ts` 的 `noteSchedule`。",
          "",
          "看板上记为 `ui/mobile-panels` 和 `session/wake-time`。",
        ].join("\n"),
        [
          thinking("两个互不相关的改动，可以并行。", 1),
          read("webview/src/panels/SidePanel.tsx", "export function SidePanel({ … }) {\n  …\n}", 2),
          ...explore(
            "Find where the wake-up time is computed",
            "service/src/session/codex.ts noteSchedule: at = now + delaySeconds; the CLI's result says the real delay.",
          ),
          {
            kind: "tool_use",
            content: `**start_session** mobile panels in \`${tree("mobile-panels")}\`\n\n> Sheet header and Files toolbar: 44px touch targets.`,
            toolName: "mcp__panel__start_session",
            toolUseId: `toolu_demo${++tool}`,
            toolResult: `Started session ${mobile.id} ("mobile panels") in ${tree("mobile-panels")} on ${model}.`,
            step: 4,
            contentOffset: 0,
          },
          {
            kind: "tool_use",
            content: `**start_session** wake-up time in \`${tree("wake-time")}\`\n\n> Take the wake-up time from the CLI's result.`,
            toolName: "mcp__panel__start_session",
            toolUseId: `toolu_demo${++tool}`,
            toolResult: `Started session ${wake.id} ("wake-up time") in ${tree("wake-time")} on ${model}.`,
            step: 5,
            contentOffset: 0,
          },
        ],
        48_300,
      ),
      user(
        40,
        [
          "Finished:",
          "",
          "唤醒时间修好了：`service/src/session/codex.ts` 改成读 CLI 的 tool result（`in 93s`），" +
            "被拒绝的调用不再算作已安排。",
          "",
          "测试：`service/tests/unit/codex-session.test.ts`，snap `service/tests/snap/codex/interrupt.snap.md` 两行时间变了，" +
            "和 CLI 自己说的 12:51 / 12:53 对得上。",
        ].join("\n"),
        origin(wake, "worker"),
      ),
      reply(
        leadAgent,
        39,
        "收到。`session/wake-time` 做完了，已从看板删掉。改动在 worktree `fix/wake-time`，可以直接看 " +
          "[claude.ts](service/src/session/codex.ts) 的 diff。",
        [
          panelTool(
            "delete_objective",
            { id: "session/wake-time" },
            "Deleted session/wake-time.",
            1,
          ),
        ],
        52_900,
      ),
      user(
        12,
        "Progress:\n\nsheet 头部改到 44px，`webview/src/styles.css` 里加了 `--touch`。还差文件工具栏的按钮，预计半小时。",
        origin(mobile, "worker"),
      ),
    ];

    mobile.messages = [
      joined(90, mobileAgent),
      user(
        89,
        [
          "目标 `ui/mobile-panels`：手机上的面板 sheet 要好点。",
          "",
          "- 头部按钮至少 44px 触控区",
          "- 文件工具栏按钮同样处理，路径保持可读",
          "- 完成后用 report_progress 汇报，附上改了哪些文件",
        ].join("\n"),
        origin(lead, "lead"),
      ),
      reply(
        mobileAgent,
        60,
        [
          "sheet 头部已经改好，截图对比过：",
          "",
          "| 元素 | 之前 | 之后 |",
          "| --- | --- | --- |",
          "| 关闭 / 固定按钮 | 26px | 44px |",
          "| 文件工具栏按钮 | 24px | 36px |",
          "| 目录行高 | 30px | 44px |",
          "",
          "改动在 `webview/src/styles.css` 和 `webview/src/panels/SidePanel.tsx:62`。测试：",
          "",
          "```bash",
          "npx vitest run tests/agents-panel.test.tsx tests/files-panel.test.tsx",
          "```",
          "",
          "手机上从文件列表进入预览，再用 **Ask Lines** 把选中的行带回聊天：",
          "",
          "```mermaid",
          "flowchart TD",
          "  Files --> Preview --> Chat",
          "```",
          "",
          "两个面板共用同一套 sheet 外壳：",
          "",
          "```dot",
          "digraph panels {",
          "  node [shape=box];",
          "  SidePanel -> { Files Agents };",
          "}",
          "```",
        ].join("\n"),
        [
          read("webview/src/styles.css", "…", 1),
          edit(
            "webview/src/styles.css",
            ".side-panel-close {\n  width: 26px;\n  height: 26px;",
            ".side-panel-close {\n  width: var(--touch, 26px);\n  height: var(--touch, 26px);",
            2,
          ),
          bash(
            "npx vitest run tests/agents-panel.test.tsx tests/files-panel.test.tsx",
            " Test Files  2 passed (2)\n      Tests  31 passed (31)",
            3,
          ),
          report("report_progress", "sheet 头部改到 44px，还差文件工具栏的按钮，预计半小时。", 4),
          {
            kind: "subagent_start",
            content: "npm run build",
            toolUseId: `toolu_demo${++tool}`,
            contentOffset: 0,
            subagent: {
              taskId: "bdemo1",
              description: "Build the bundle",
              prompt: "```bash\nnpm run build\n```",
              agentType: "shell",
              taskType: "local_bash",
              status: "completed",
              summary: 'Background command "Build the bundle" completed (exit code 0)',
            },
          },
        ],
        96_400,
      ),
    ];

    wake.messages = [
      joined(70, wakeAgent),
      user(
        69,
        "目标 `session/wake-time`：唤醒时间用 CLI 的结果算，不要用请求的 delaySeconds。完成后 finish_task。",
        origin(lead, "lead"),
      ),
      reply(
        wakeAgent,
        41,
        "改好了，`noteSchedule` 现在读 tool result 里的 `(in 93s)`，读不到再退回 delaySeconds。见 `service/src/session/codex.ts`。",
        [
          read("service/src/session/codex.ts", "…", 1),
          edit(
            "service/src/session/codex.ts",
            "const delay = Number(input.delaySeconds ?? 0);",
            "const delay = Number(/\\(in (\\d+)s\\)/.exec(result)?.[1] ?? input.delaySeconds ?? 0);",
            2,
          ),
          bash(
            "npm test -w service",
            " Test Files  23 passed (23)\n      Tests  316 passed (316)",
            3,
          ),
          report("finish_task", "唤醒时间改为读 CLI 的 tool result，测试通过。", 4),
        ],
        61_800,
      ),
    ];

    routes.messages = [
      joined(200, routesAgent),
      user(
        199,
        "目标 `ui/file-routes`：/api/file 读不了的文件不能让进程退出。",
        origin(lead, "lead"),
      ),
      reply(
        routesAgent,
        150,
        "已修复并提交，见 `service/src/server/http.ts` 的 `sendRaw`。",
        [bash("npm test -w service", "Tests  316 passed (316)", 1)],
        40_100,
      ),
    ];

    // A session the user opened in the project (a worktree of its repository).
    const soloAgent = agent("Laffey", "avatars/Laffey.jpg", "#D8A0D8", tree("readme"));
    const solo = session("readme", tree("readme"), soloAgent, "worker", 20);
    solo.messages = [
      joined(20, soloAgent),
      user(18, "README 里的部署一节还准确吗？"),
      reply(
        soloAgent,
        17,
        [
          "基本准确，两处过时：",
          "",
          "- `README.md` 提到的 `npm run deploy` 已经换成 `scripts/deploy-deferred.sh`",
          "- 配置示例见 `config.example.toml`，`[auth]` 一节多了 `max_age_days`",
          "",
          "要我改吗？",
        ].join("\n"),
        [
          read("README.md", "# Agent Team\n…", 1),
          bash("grep -n deploy README.md", "88:npm run deploy", 2),
        ],
        22_700,
      ),
    ];

    // A workspace from before projects, archived: the lead's history.
    const pastAgent = agent("Ayanami", "avatars/Ayanami.jpg", "#A5B4FC", repo);
    const past = session("parser crash", repo, pastAgent, null, 60 * 24 * 9);
    past.archivedAt = ago(60 * 24 * 7);
    const { markdown, links } = seedFileLinks(demo);
    past.messages = [
      joined(60 * 24 * 9, pastAgent),
      user(60 * 24 * 9, "clice 在打开 `src/Index/Parser.cpp` 时崩了，帮我看下。"),
      reply(
        pastAgent,
        60 * 24 * 9 - 30,
        "ASAN 报告指向 `TemplateResolver::resolve` 的 use-after-free：缓存的 `Decl*` 在重新解析后失效。改成按 USR 重新查找，已修复并加了回归测试。\n\n" +
          markdown,
        [bash("ctest -R parser", "100% tests passed", 1)],
        88_000,
      ),
    ];

    const all = [lead, mobile, wake, routes, solo, past];
    for (const w of all) w.lastActivityAt = Math.max(...w.messages!.map((m) => m.timestamp));
    seedWorkspaces(base, all);

    // The board.
    const objectives = new ObjectiveStore(store.objectivesDir(project.id));
    const objective = (
      o: Partial<Objective> & Pick<Objective, "id" | "title" | "goal">,
    ): Objective => ({
      area: o.id.split("/")[0],
      status: "active",
      priority: "normal",
      dependsOn: [],
      tasks: [],
      decisions: [],
      sessions: [],
      updatedAt: now,
      ...o,
    });
    for (const o of [
      objective({
        id: "ui/mobile-panels",
        title: "Panels on phones",
        goal: "The panels as full-screen sheets that are comfortable to use by touch.",
        priority: "high",
        context: "Sheet header done (44px); the Files toolbar is next.",
        contextWritten: ago(12),
        tasks: [
          {
            id: "header",
            text: "44px touch targets in the sheet header",
            state: "done",
            session: mobile.id,
          },
          {
            id: "toolbar",
            text: "Files toolbar buttons and folder rows",
            state: "doing",
            session: mobile.id,
          },
          { id: "landscape", text: "Phones held sideways", state: "todo" },
        ],
        sessions: [mobile.id],
        decisions: [{ id: "swipe", question: "Swipe down to close the sheet?" }],
      }),
      objective({
        id: "ui/panel-size",
        title: "Panels that use a big screen",
        goal: "On a wide or full-screen window a panel can take most of the room, e.g. to read code.",
        priority: "high",
        tasks: [
          { id: "default", text: "Default width grows with the window", state: "todo" },
          { id: "max", text: "Maximise a panel over the chat", state: "todo" },
        ],
      }),
      objective({
        id: "ui/file-search",
        title: "Search in the Files panel",
        goal: "Find a file by name without walking folders.",
        status: "later",
        reason: "After the mobile work; ripgrep --files is fast enough, no index.",
      }),
      objective({
        id: "infra/deploy-preview",
        title: "Preview deploys per branch",
        goal: "Try a worker's branch on its own port before merging.",
        priority: "low",
        dependsOn: ["ui/mobile-panels"],
        decisions: [{ id: "ports", question: "Fixed port range or ask the OS?" }],
      }),
      objective({
        id: "infra/windows",
        title: "Native Windows server",
        goal: "",
        status: "dropped",
        reason: "WSL works well; not worth two code paths.",
      }),
    ]) {
      objectives.write(o);
    }

    // Known defects on the board (issues/<module>.toml).
    const issues = new IssueStore(store.issuesDir(project.id));
    issues.writeAll([
      {
        id: "ui",
        title: "Mobile & Panel UI",
        notes: "Touch-target and responsive layout issues tracked alongside the UI objectives.",
        objectives: ["ui/mobile-panels", "ui/panel-size"],
        updatedAt: now,
        issues: [
          {
            id: "04-12#1",
            state: "open",
            evidence: "R",
            tags: ["mobile", "touch"],
            text: "Files toolbar buttons stay 24px wide on phones (`webview/src/panels/FilesPanel.tsx`).",
            written: ago(30),
            objectives: ["ui/mobile-panels"],
          },
        ],
        groups: [
          {
            id: "sheet-chrome",
            title: "Sheet header & resize edge",
            notes: "Shared by `SidePanel.tsx` and mobile sheet styles.",
            objectives: ["ui/mobile-panels"],
            issues: [
              {
                id: "04-12#2",
                state: "decision",
                evidence: "V",
                tags: ["mobile", "gesture"],
                text: "Swipe-down to dismiss conflicts with vertical scrolling inside the Files diff view.",
                written: ago(18),
                objectives: ["ui/mobile-panels"],
              },
            ],
          },
        ],
      },
      {
        id: "session",
        title: "Session Runtime",
        notes: "CLI process lifecycle and streaming invariants.",
        objectives: [],
        updatedAt: now,
        issues: [
          {
            id: "04-11#1",
            state: "accepted",
            evidence: "H",
            tags: ["windows"],
            text: "Native Windows PTY spawning is not supported; WSL is the supported environment.",
            written: ago(60 * 24),
            objectives: [],
          },
        ],
        groups: [],
      },
    ]);
    issues.reserve(["04-12#1", "04-12#2", "04-11#1"]);

    // Project notes (notes/*.md).
    const notesDir = store.notesDir(project.id);
    writeNote(
      notesDir,
      "architecture",
      [
        "# Architecture Notes",
        "",
        "Live server + webview overview for the demo project:",
        "",
        "- Side panels live in `webview/src/panels/SidePanel.tsx`.",
        "- Server HTTP & WebSocket routing lives in `service/src/server/server.ts`.",
        "- Board data is stored as TOML under `.agent-team/projects/<id>/`.",
        "",
      ].join("\n"),
      null,
    );
    writeNote(
      notesDir,
      "mobile-spec",
      [
        "# Mobile Panels Spec",
        "",
        "Touch targets on viewports `<= 600px` must be at least **44px**.",
        "",
        "- Sheet header close & pin controls: `44px`",
        "- Directory entries in `webview/src/panels/FilesPanel.tsx`: `44px` row height",
        "",
      ].join("\n"),
      null,
    );

    // Last: the index is what makes the server load the workspaces.
    saveIndex(
      base,
      all.map((w) => w.id),
    );
    if (!options.quiet) {
      console.log(`demo in ${base}: ${all.length} workspaces, project ${project.id}`);
    }
    return {
      baseDir: base,
      repo,
      projectId: project.id,
      projectName: project.name,
      fileLinks: links,
      worktrees: {
        mobilePanels: tree("mobile-panels"),
        wakeTime: tree("wake-time"),
        fileRoutes: tree("file-routes"),
        readme: tree("readme"),
      },
      workspaces: {
        lead: lead.id,
        mobile: mobile.id,
        wake: wake.id,
        routes: routes.id,
        solo: solo.id,
        past: past.id,
      },
    };
  }
}

if (isScriptMain("seed-demo.ts")) {
  if (!process.argv[2]) throw new Error("usage: npm run demo -- <base dir of a dev instance>");
  // npm runs scripts from the package root; a relative path is the caller's.
  const target = path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]);
  seedDemo(target);
}
