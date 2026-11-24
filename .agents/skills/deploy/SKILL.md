---
name: deploy
description: Build and restart the production agent-team server safely from inside a session, watch the deploy log, and verify the server came back. Read BEFORE any build/restart/redeploy or when asked whether the server restarted.
---

# Deploy

Production uses `scripts/start-server.sh` (default port `9800`), run by:

- **macOS:** `launchd` agent `com.yaat.server` in `gui/$(id -u)` (managed via `scripts/yaat-service.sh`)
- **Linux:** `agent-team-server.service` (`systemd --user`, managed via `scripts/yaat-service.sh`), or `~/.local/bin/agent-team-service supervise` on machines without a systemd user bus

A restart can cut off active sessions, including the one requesting it. Use safe deferred deploy on Linux systemd or macOS launchd; other managers need an explicitly authorized maintenance procedure.

## Confirm who you are

Linux:

```bash
pid=$(systemctl --user show -p MainPID --value "${YAAT_SERVICE_LABEL:-agent-team-server}" 2>/dev/null)
[[ $pid =~ ^[1-9] ]] || pid=$(pgrep -f '^\S*node dist/server.js' -o); echo server=$pid
pgrep -P "$pid" | wc -l                       # live agent sessions (you are one)
grep -qa "AGENT_TEAM" /proc/$$/environ && echo "running inside the server"
```

macOS:

```bash
pid=$(launchctl print "gui/$(id -u)/${YAAT_SERVICE_LABEL:-com.yaat.server}" 2>/dev/null | awk '/pid =/{print $3; exit}')
[[ $pid =~ ^[1-9] ]] || pid=$(pgrep -f 'node dist/server.js' -o); echo server=$pid
pgrep -P "$pid" | wc -l                       # live agent sessions (you are one)
ps eww -p $$ | grep -q "AGENT_TEAM_" && echo "running inside the server"
```

A "busy agent" seen in the UI while you are working is usually you. Never conclude the server is idle from the panel.

## Redeploy

Only when the user asked for a restart in this turn. Finish all edits, run `npm run check && npm test` first, then:

```bash
./scripts/yaat-service.sh deploy-deferred --when-idle --timeout 600
```

Run from the installed checkout, with the matching label, base dir and port. The running server must already support the control socket. The command schedules a detached systemd user job or separate one-shot LaunchAgent (macOS build logs: `.agent-team/releases/jobs/<id>/controller.log`), prints its ID, and returns. Finish your turn; it is a blocker until it settles. A timeout or cancellation before cutover does not restart the service. Older servers or other service managers require an explicitly authorized maintenance window. Do not substitute the legacy fixed-delay command for a rejected safe deploy.

If the user said "先别重启" (don't restart yet), commit and stop; schedule nothing.

## Verify (next turn, or when asked "重启了吗")

```bash
./scripts/yaat-service.sh deploy-status <id>
./scripts/yaat-service.sh health
./scripts/yaat-service.sh status
```

`queued` means the controller has not yet started. `succeeded` means the candidate boot identity and static assets were verified; `rolled_back` means the prior generation was verified instead. Use `deploy-cancel <id>` only before cutover. If `recoveryRequired` is true, inspect the installed checkout's `.agent-team/releases/transaction.json` and active unit before taking any action. See [deployment operations](../../../docs/DEPLOY.md#safe-deferred-deployment).

## Testing a build without touching production

Run a second instance on another port with its **own base dir and its own build**. Without `AGENT_TEAM_BASE_DIR` it would read and write production's data (the repo root's `.agent-team/`, or `~/.yaat` when using `yaat-service.sh`); built into `dist/`, production would serve the new bundle.

```bash
D=$PWD/.agent-team/dev-9801
./scripts/yaat-service.sh init-config --base-dir "$D" --no-auth
(cd webview && npx vite build --outDir "$D/build/webview" --emptyOutDir)
npx esbuild service/src/index.ts --bundle --format=cjs --platform=node --target=node26 \
  --outfile="$D/build/server.js" --external:@anthropic-ai/claude-agent-sdk --external:@cursor/sdk
npm run demo -- "$D"                            # optional, on an empty base dir: demo project and history
AGENT_TEAM_HOST=127.0.0.1 AGENT_TEAM_PORT=9801 AGENT_TEAM_BASE_DIR=$D node "$D/build/server.js" > /tmp/agent-team-9801.log 2>&1 &
```

Stop it by PID (`kill $!`), never with `pkill -f` on the command line — that pattern matches your own shell. Writing to an agent there starts a real session on the user's account.

## Never

- `systemctl restart` / `launchctl kickstart` / `kill` the server inline.
- Restart without `npm run check && npm test` green.
- Trust "没有活跃的进程" without `pgrep -P` — the count has been wrong before.
