---
name: capture-sdk
description: Snap fixtures — record a real Codex or Pi interaction once, anonymize it, and replay it as a test with a pinned transcript. Read BEFORE changing how backend frames map to events, and whenever you are unsure what a backend actually emits — record, don't guess.
---

# Snap fixtures: record real backend streams

Frame shapes and order from `codex app-server` and `pi --mode rpc` (including third-party Pi providers like Antigravity ACP) are not documented well enough to code against from memory; past bugs (missing `null` optional args, foreground vs async subagent cards, phantom results on resume) all came from guessing. **If a fix depends on what the stream looks like, record it first — never fabricate protocol frames out of thin air.**

## Rate limit — read first

Every live recording is a real session on the user's account. Bursts of sessions can get the account **banned**. Record only the fixture the current bug needs (one or two), never "all of them"; the recorder refuses more than 4 per run and enforces a cooldown between them — do not shorten that; never loop recordings to "try again". Reuse an existing recording whenever one shows the frames you need (`ls service/tests/snap/{codex,pi}`).

Before recording an Antigravity ACP Pi turn, check `pgrep -a agy` so you do not collide with another run spending shared Gemini quota, and keep prompts short and original.

## Anatomy

One fixture = three files in `service/tests/snap/<backend>/`:

- `<name>.ts` — the script and the intent. Steps drive the recorder _and_ the replay; `description` is the test name; `verify()` states why the fixture exists.
- `<name>.jsonl` — the recording: a header line (backend, model, CLI version, date, and for Pi the truthful `source`) followed by `{t, frame}` entries interleaved with `{t, step}` markers, `{t, sent}` lines written to the process, plus `{t, close}` and `{t, error}`.
- `<name>.snap.md` — the transcript the replay produced, pinned by vitest (`toMatchFileSnapshot`). Reviewed like code; regenerate with `npm test -w service -- -u` only after you understand every changed line.

`service/tests/snap/snap.test.ts` globs `codex` and `pi` fixtures. For each: replay through the real session (`CodexSession` / `PiSession` wired to a player of the recorded frames with `Date` advanced per frame), the real `Workspace`, then `verify()`, the snapshot, and the client/server transcript convergence. `service/tests/snap/broadcast.test.ts` and `service/tests/snap/sentinel.test.ts` also enforce broadcast convergence and privacy/anonymization gates.

## Record: Codex

```bash
npm run capture -- codex commands                              # writes service/tests/snap/codex/commands.jsonl
npm run summarize -- service/tests/snap/codex/commands.jsonl   # folds consecutive Codex deltas
```

- Steps: `send`, `wait`, `end`, `abort`, `interrupt`, `compact` (`thread/compact/start`), and `requeued` (a steered message the stopped turn never read). A `send` while a turn runs is `turn/steer`; `end` stops the app-server and the next step resumes the thread in a new one. `tools` declares client-defined tools (`dynamicTools`) answered with each one's `reply`.
- `api: "usage-limit"` points Codex at a local stand-in returning `usage_limit_reached` and `x-codex-*` headers so a limit is recorded without spending quota.
- Default model `gpt-6-luna` at low effort (`model:` in the fixture overrides). Recording cwd is `/tmp/sdk-capture`; strings are trimmed and base64 payloads replaced.

## Record & Extract: Pi

See `service/tests/snap/PI-CAPTURE.md` for full details and anonymization rules.

```bash
# Live account-backed Pi RPC capture (spends quota; per-user lock + cooldown):
npm run capture -- pi basic-turn
npm run capture -- pi tools-bash-edit
# For ACP: PI_ACP_EXTENSION=/path/to/provider npm run capture -- pi antigravity-acp-turn

# Offline deterministic E2E RPC tap (no online account quota):
npm run capture -- pi scenario
npm run capture -- pi scenario-widgets

# Offline retry/compaction fault recordings under real Pi CLI:
npm run capture -- pi compaction-and-retry
npm run capture -- pi retry-failed

# Passive anonymized get_messages excerpt from an existing Pi v3 session transcript:
npm run --silent capture -- pi extract ~/.yaat/pi-sessions/<ws>/<file>.jsonl <1-based-line>
npm run summarize -- service/tests/snap/pi/basic-turn.jsonl   # Pi RPC commands and events
```

- **Do not reconstruct RPC deltas** from `~/.yaat/.agent-team/logs/*/stream.jsonl` (Workspace projections) or Pi v3 transcripts (final messages only). Use live `pi --mode rpc`, offline `pi scenario`, or `pi extract` (which restores the redacted entry inside a credential-free offline Pi to serialize its true `get_messages` RPC shape).
- Inspect every changed `.jsonl` (including object keys) before committing; run `snap.test.ts`, `broadcast.test.ts`, and `sentinel.test.ts`.

## Workflow for a stream bug

1. Find or write the fixture; `verify()` states the expected outcome; run `npm test -w service`.
2. No recording → record or extract it (respecting rate limits above). Read the summary end to end.
3. Watch it fail, fix the server side, then make the client aggregation agree if the convergence check complains — never fork the logic.
4. Review the `.snap.md` diff; accept with `-u` only for lines you can explain.

## Re-record when

- `@openai/codex`, `pi`, `pi-subagents`, or a Pi provider package (e.g. `pi-antigravity-acp-provider`) is bumped.
- A live run or screenshot shows a scenario no fixture covers.
- The mapping needs a frame field you cannot point to in an existing recording.
