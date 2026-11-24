---
name: deploy
description: Build and verify YAAT safely; use the staged controller only for an authorized production restart. Read before any build, restart, deployment, or restart status check.
---

# Deploy safely

An agent in the panel usually works inside the service it would restart. For ordinary verification run `npm run check && npm test && npm run build` in your worktree; do not overwrite `dist/` in the installed checkout while it serves that directory. To run a second instance, use a separate build, port and `AGENT_TEAM_BASE_DIR` with a scratch config. Sending a prompt there still uses the selected provider and account.

Only when the user explicitly asks for a production restart in this turn, finish the changes and verification, then from the installed checkout with the correct base directory, label and port:

```bash
./scripts/yaat-service.sh deploy-deferred --when-idle --timeout 600
```

This schedules a detached controller on Linux systemd or macOS launchd. Record its job ID and finish your turn: your own activity blocks cutover. If safe scheduling is refused, do not substitute a fixed-delay restart; other managers require a separately authorized maintenance window.

On the next turn, or when the user asks whether the restart happened:

```bash
./scripts/yaat-service.sh deploy-status <id>
./scripts/yaat-service.sh health
./scripts/yaat-service.sh status
```

`succeeded` proves the candidate process and assets were verified; `rolled_back` proves the prior generation was verified. A pre-cutover timeout or cancellation does not restart the app. If `recoveryRequired` is true, inspect the installed checkout's `.agent-team/releases/transaction.json` and active unit before doing anything. Do not hand-edit release pointers or prune during recovery. See [deployment operations](../../../docs/DEPLOY.md#safe-deferred-deployment).
