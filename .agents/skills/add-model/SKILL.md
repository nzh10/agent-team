---
name: add-model
description: Add, rename or retire a native Codex model, or diagnose a missing model in the Pi catalog. Read before editing service/src/config/presets.ts.
---

# Add a model

## Pi RPC

Pi models come from the running model catalog, not `MODEL_OPTIONS`. Use the full `provider/model` ID in `[pi].default_model` or a preset. Configure custom providers in `~/.pi/agent/models.json`, or use a Pi package, as the service user. Check the catalog with `scripts/start-server.sh --doctor --json` (point `AGENT_TEAM_BASE_DIR` at the intended instance; no model turn). A new Pi process is needed to reliably pick up catalog changes. For Antigravity ACP, prepare its runtime separately as described in `docs/DEPLOY.md`; a catalog entry does not prove the runtime is ready.

## Native Codex

Verify the **pinned** `@openai/codex` binary from `service/package.json`, not a `codex` on `PATH`. Presence in `MODEL_OPTIONS` does not prove the account can run a model. Check `~/.codex/models_cache.json` for visible slugs and supported reasoning levels. If a binary bump is needed, install the exact version into the service workspace, compare the generated experimental app-server types with `service/src/session/codex-rpc.ts`, and capture relevant protocol fixtures again (capture-sdk skill).

One `npm run smoke:codex -- <slug> <effort>` exercises the actual binary through `CodexSession` and spends account quota. Do not loop or parallelize it. For a retired native ID, retain any option metadata needed to resume existing agents, but remove it from the picker. Cover routing/options edits in `service/tests/unit/presets.test.ts`. A live service restart is a separate permission (deploy skill).
