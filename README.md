# Agent Team

A self-hosted panel for running a team of coding agents. Each project has a
long-lived **lead** you plan the work with; when you decide on something, the
lead starts **workers** in the repository or a git worktree, and every one of
them is a conversation you can open and join — from a browser, or from a phone
where the panel installs as a home-screen app.

The panel runs Pi and Codex (through `codex app-server`). Claude, Cursor and
agy sessions from older versions remain readable as history but cannot be sent
new work. The panel provides the orchestration and UI, not a model of its own.

## How the team works

- **Projects and leads** — a project is a repository with a lead session. You
  talk the work over with the lead; it starts worker sessions with a
  complete, self-contained task through the panel's own MCP tools, in the
  repository or one of a few worktrees it reuses rather than making one per
  session. It never starts work you did not ask for.
- **Autonomous workers** — a worker decides what it can itself and asks you,
  in its own session, what is yours to decide; the sidebar marks it
  "your turn". When the task is done it reports to the lead with
  `finish_task`; `report_progress` is only for news that changes the lead's
  plans. The lead steps back: it does not relay, chase or poll.
- **Isolated workers** — for one self-contained task the lead can start a
  worker that sees its own task and nothing else of the project: only
  `report_progress`, `finish_task` and `current_task`, no board, notes,
  issues, history or other sessions. Tagged "isolated" in the sidebar.
- **An objectives board** — objectives with tasks, decisions and dependencies,
  kept current by the workers as they go and read by the lead to talk things
  over with you. A list by area and a dependency graph; each objective is a
  TOML file under `.agent-team/projects/`, editable by hand, with the
  project's notes beside it.
- **A shared, searchable history** — every message, thinking block, tool call
  (input, output and how long it ran) and subagent run of every session is
  stored in `history.db`. Leads and workers search it like grep
  (`search_history`, `read_entry`, `read_session`) and query it with
  read-only SQL (`query_history`): counts, grouping, one tool's calls across
  sessions.
- **Across projects** — leads message each other's projects
  (`list_projects`, `message_project`).
- **Surviving restarts and limits** — a turn a server restart cut off is
  carried on by the panel itself; a turn stopped by a usage limit is retried
  after the window resets.
- Leads and workers write to you in Simplified Chinese (code, identifiers
  and commits stay English); the instruction is in
  `service/src/project/tools.ts`.

## The panel

- **Workspaces** — a folder plus the agents working in it, project or not.
  Each agent keeps a separate session, so two agents in the same repo do not
  share context.
- **A transcript that shows the work**, not just the answer: thinking blocks,
  tool calls with their run times, subagent and background-task cards, and a
  per-message row with effort level and context usage. Long histories page
  in lazily.
- **Pi extension UI** — dialogs accept replies; `notify` shows a short-lived
  notice. Keyed `setStatus` entries and `setWidget` text blocks appear beside
  the composer, grouped by agent. They survive a browser refresh, not a Pi
  process restart. Omit `statusText` or `widgetLines` to clear its key.
  `setTitle` targets a terminal, and `set_editor_text` would overwrite a user's
  local draft: the panel does neither. These and unknown methods are logged
  as unhandled (method and request ID only), never answered as dialogs.
- **Side panels**, floating or pinned beside the chat:
  - _Agents_ — from a lead, every session of the project in a two-line card
    to unfold; from any other session, that session alone: its agents'
    models and context, background tasks and wake-ups, and the buttons to
    stop them.
  - _Files_ — the workspace's tree and its uncommitted changes as diffs; a
    file a reply names opens here.
  - _Objectives_ — the project's board.
- **Run state per agent** — idle, working, waiting on background work, or
  sleeping until a scheduled wake-up. The context figure is the size of the
  turn's last request against the model's window, not a running total. A
  message to a working Codex agent goes into its running turn. Native Pi
  sessions take the next queued input between model requests, after the current
  tools finish. Until handoff it stays cancellable; a Stop leaves it queued.
  If Pi may have taken it but delivery cannot be confirmed, the panel shows
  **delivery outcome unknown** and never resends it automatically. Pi's shared
  queue is not cleared. Antigravity ACP keeps panel FIFO delivery.
- **Slash commands** handled by the panel itself: `/effort <level>`,
  `/model <id>`, `/fast [on|off]` (Codex's priority tier), `/context` and
  `/usage`. `/goal` is disabled.
- **Scheduled wake-ups** — an agent can put itself to sleep and come back
  later; the banner says what it is waiting for and when it returns.
- **Git awareness** — branch, dirty count and open PRs per folder.
- **Search** across every workspace's messages from the sidebar.
- **Mobile-first UI** — installable PWA, safe-area aware, composer pinned above
  the keyboard. Coming back from the background re-syncs the open transcript
  and replaces a socket the phone silently dropped, so a turn that finished
  while the screen was off shows as finished. One bundled font (Sarasa Mono
  SC) for Latin and Chinese, so both line up the same on every device.
- **Housekeeping** — workspaces idle past `archive_after_days` are archived:
  history leaves memory (still on disk) and idle CLI processes shut down.
  Sending a message restores them.

### Account quota

The sidebar shows last-observed account limits separately from CPU and memory. Refresh reads native Codex limits and asks one connected Pi session for its registered providers. Antigravity ACP uses the provider’s `/usage` event; Pi OAuth logins for `openai-codex` and `kimi-coding` use their respective read-only account usage endpoints. None starts a model turn. An unconfigured backend is neutral, not a quota failure. While Pi or ACP is getting ready, the sidebar shows what it is waiting for. Installing the ACP runtime triggers a new read from a connected Pi session. A transient read failure retries that provider at most twice; last-known bars retain their original observation time. Pi providers without a verified quota reader report unsupported.

Pi sessions load `/quota` automatically. To use the same command in standalone Pi, run `pi -e /path/to/yaat/service/src/session/pi-quota.ts` from an installed checkout. `/quota` checks all registered providers regardless of the current model. Enable `pi-antigravity-acp-provider` for ACP readings. OAuth quota comes from Pi’s credential resolver, not from the native Codex login. No account pooling or credential switching is performed.

## Requirements

- Node.js 26+ (the history is stored with `node:sqlite`)
- A [Codex](https://developers.openai.com/codex/cli) login, if you use Codex
  (`npx codex login` in the repository runs the bundled CLI)

Codex runs as the binary of the `@openai/codex` version pinned in
`service/package.json`, not a `codex` on your `PATH`: bump it there when new
model ids are rejected.

[pixi](https://pixi.sh) is used for the Node toolchain but is optional; plain
`npm` works too.

## Getting started

For a guided single-command service setup (macOS `launchd` and Linux
`systemd --user`), see [docs/DEPLOY.md](docs/DEPLOY.md):

```bash
git clone https://github.com/16bit-ykiko/agent-team.git
cd agent-team
./scripts/setup-prereqs.sh --install   # check/install Node.js 26+, Pi CLI & packages
./scripts/yaat-service.sh install-deps
./scripts/yaat-service.sh install
```

For setup problems, open **Service diagnostics** in the sidebar, or run `AGENT_TEAM_BASE_DIR="$HOME/.yaat" scripts/start-server.sh --doctor --json` after building. The report identifies the failed step and how to fix it. ACP is optional; prepare its runtime explicitly before using ACP models ([instructions](docs/DEPLOY.md#optional-antigravity-acp-runtime)).

Or run directly in the foreground:

```bash
cp config.example.toml config.toml
$EDITOR config.toml          # see "Configuration" below

npm install
npm run build                # webview, then service
node dist/server.js          # http://localhost:9800
```

With pixi, `pixi run serve` builds and starts in one step.

### Development

```bash
pixi run dev-webview         # Vite dev server with HMR
npm run check                # tsc (strict) + ESLint + prettier, zero tolerance
npm test                     # service + webview (Vitest, no browser)
npm run fmt                  # prettier
```

For layout changes, install Playwright's Chromium (`npx playwright install chromium`,
or `npx playwright install --with-deps chromium` on Linux if system libraries are missing).
Run `npm run test:browser` for headless geometry tests, or `npm run test:slow` for the
full local checks, unit tests, and browser suite before committing or pushing.

To try the UI without touching your own data, seed a demo — a project with a
lead, workers, history and a board; no session is started — into a separate
base directory and run a second instance on it:

```bash
npm run demo -- .agent-team/dev
cp config.example.toml .agent-team/dev/config.toml
AGENT_TEAM_PORT=9801 AGENT_TEAM_BASE_DIR=$PWD/.agent-team/dev node dist/server.js
```

CI (`.github/workflows/ci.yml`) runs `check`, `test` and `build` on every push
and pull request. Agent-facing project rules live in `AGENTS.md`, with
task-specific playbooks under `.agents/skills/` (deploy, capture-sdk,
stream-debug, add-model, review).

Codex event mapping is tested against recorded real interactions
(`service/tests/snap/codex/`): each fixture is a script (`<name>.ts`, which
also states what it verifies), the recording it produced (`<name>.jsonl`) and
the transcript the replay pins (`<name>.snap.md`).
`npm run capture -- codex <name>` records a fixture with your own login;
`npm run summarize -- <file.jsonl>` prints one line per frame. When a CLI
changes shape, re-record rather than guess.

## Configuration

Use `config.toml` for YAAT settings (`config.example.toml` is the template).
The port and auth cookie secret need a restart. Pi owns provider configuration.

```toml
[auth]                       # omit the section to disable auth entirely
username = "agent"
password = "..."             # compared in plain text; use a long random one
session_secret = "..."       # openssl rand -hex 32
max_age_days = 30

[workspace]
archive_after_days = 14      # 0 disables archiving

[hosts.local]
label = "Local"
type = "local"

[user]
language = "简体中文"          # user-facing project replies, questions and summaries only

[projects]                   # what new leads (and workers started without a model) run on
model = "gpt-6-astra"         # any model in the picker
effort = "high"

[pi]                         # keeping [pi] present populates the Pi model picker at startup
exclude_packages = []        # omit `packages` to use locally installed packages in ~/.pi/agent/settings.json
default_model = "provider/model"
default_effort = "medium"
offline = true               # set false to allow Pi npm access on startup

[server]
# Enables self-restart on macOS (`yaat-service.sh init-config` fills this in automatically):
# restart_command = ["launchctl", "kickstart", "-k", "gui/501/com.yaat.server"]
```

Omitting `[user].language` adds no language instruction. A language change
is reflected in Pi's project instructions on the next turn and in Codex on
thread start or resume in a new app-server process.

If upgrading from a config with `[providers.*]`, migrate custom Pi providers to
`~/.pi/agent/models.json` and remove those tables from `config.toml`. The managed
Pi home links `models.json`; start a new Pi process to pick up changes. Its
`models-store.json` cache is separate and seeded from the user cache only once.
If a package is unsuitable for headless Pi on your machine, list it in
`[pi].exclude_packages`.

### Environment

| Variable              | Default   | Meaning                           |
| --------------------- | --------- | --------------------------------- |
| `AGENT_TEAM_PORT`     | `9800`    | HTTP + WebSocket port             |
| `AGENT_TEAM_HOST`     | `0.0.0.0` | Address the server listens on     |
| `AGENT_TEAM_BASE_DIR` | cwd       | Where `.agent-team/` is stored    |
| `AGENT_TEAM_WEB_DIR`  | bundled   | Where the built UI is served from |
| `AGENT_TEAM_DEBUG`    | unset     | `1` logs raw CLI payloads         |

State (workspaces, `history.db` and its search index, projects and their
boards, debug snapshots) lives under `.agent-team/` in the base directory.

## Available models

The Codex model list is maintained by hand in
[`service/src/config/presets.ts`](service/src/config/presets.ts) and is empty
when the pinned Codex binary is unavailable. Other model ids route to Pi;
`provider/model` is the conventional Pi form.

For Codex, a `[1m]` suffix selects the 872K context window through
`model_context_window`; the plain CLI model id has the suffix stripped.

Agent identities (name, avatar, colour) default to the presets in the same
file and can be configured with `[[agent_presets]]` in `config.toml`. A lead
can pin a worker's identity by exact preset name in `start_session`. Codex
registers panel tools when a thread starts; resumed threads keep their
original tool schema and descriptions.

## Running it as a service

`scripts/yaat-service.sh` installs and manages the server on both macOS
(`launchd` under `~/Library/LaunchAgents/com.yaat.server.plist`) and Linux
(`systemd --user` under `~/.config/systemd/user/agent-team-server.service`),
backed by `scripts/start-server.sh`. See [docs/DEPLOY.md](docs/DEPLOY.md) for
full details, including `launchd` `Aqua` Keychain behaviour and dev instances.

If you expose it beyond localhost, put it behind TLS and keep `[auth]` on —
agents here run with full filesystem access to the folders you give them.

On Linux systemd or macOS launchd, run `scripts/yaat-service.sh deploy-deferred --when-idle --timeout 600`
from the installed checkout. The detached job stages a release and waits for all
work to finish, including the session that requested it. See [deployment](docs/DEPLOY.md#safe-deferred-deployment)
for prerequisites, job status, and cancellation.

## Layout

```
service/src/     Node server
  server/        HTTP + WebSocket, auth, uploads
  session/       codex.ts, shared types, host lifecycle, read-only legacy sessions
  workspace/     message list, event aggregation, persistence, search
  project/       project leads, worker sessions, objectives, the panel's MCP tools
  config/        config.toml, agent + model lists (presets.ts, hand-maintained)
  repo/          git status, PR lookups, directory completion
webview/src/     React UI (Vite)
  state/         WebSocket client and client-side aggregation
  chat/          transcript rendering, markdown, input helpers
  panels/        the side panels: agents, files, background work
  project/       the objectives board and dependency graph
  sidebar/ workspace/ viewport/ dev/ fonts/
scripts/         start script, deferred deploy, SDK capture + smoke tests, demo seed,
                 font and file-icon import
AGENTS.md        shared project rules (also imported by .claude/CLAUDE.md)
.agents/skills/  task-specific playbooks
```

## Credits

Originally forked from [16bit-ykiko/agent-team](https://github.com/16bit-ykiko/agent-team) by [ykiko](https://github.com/16bit-ykiko). See [NOTICE](NOTICE) for attribution details.

## License

[Apache-2.0](LICENSE)
