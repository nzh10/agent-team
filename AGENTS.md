# YAAT repository guide

YAAT is a self-hosted panel for Pi RPC and native Codex app-server sessions. Older backend histories are read-only. `service/` owns runtime, delivery and persistence; `webview/` renders the WebSocket projection; `shared/` holds contracts used by both; `scripts/` owns operational tooling.

## Invariants

- Use Node.js 26+ and install workspaces from the repository root. Do not add `"type": "module"` to the root package: `dist/server.js` is CommonJS.
- Do not restart, kill, or deploy the live service from a session without explicit permission in the current request. An authorized staged deployment must use `scripts/yaat-service.sh deploy-deferred --when-idle`; see the deploy skill. Do not match server processes with `pkill -f`; target a specific PID when authorized.
- Verify with `npm run check`, `npm test` and `npm run build`. `npm run test:slow` additionally runs browser and end-to-end tests. Do not skip a failing test. Include regression coverage for behavior changes.
- Read the event path end to end: session → workspace → WebSocket → client state → renderer. A continuously connected browser and a fresh snapshot should show the same transcript and queue affordances. Use recordings for backend frame shape and order; never invent them. Explain any snapshot change before regenerating it.
- Use real-account captures and smoke tests sparingly, one at a time. Prefer existing fixtures or deterministic offline tests; live sessions spend the user's quota.
- Keep changes small and reversible. Clean up references to behavior you replace, across code, tests, documentation and skills. Preserve the existing UI layout unless asked to change it. Comment non-obvious constraints, not the edit itself.
- Commit and push only when requested. Review non-trivial diffs independently before committing (review skill). Use an imperative conventional commit subject. Before pushing, run `npm run test:slow` and `npm run build`.

## Skills

Read these when their boundary applies:

- `.agents/skills/deploy/SKILL.md` — before building, scheduling a deployment, or checking whether production restarted.
- `.agents/skills/capture-sdk/SKILL.md` — when backend emission order or shape matters; use a recorded Pi/Codex fixture.
- `.agents/skills/stream-debug/SKILL.md` — before changing session/workspace/client event projection or investigating a transcript rendering issue.
- `.agents/skills/add-model/SKILL.md` — before editing `service/src/config/presets.ts`.
- `.agents/skills/review/SKILL.md` — before non-trivial commits and for independent review.
