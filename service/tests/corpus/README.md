# Offline pilot corpus

`anon-pilot.jsonl` is one JSON record exported from a local YAAT cache and a contiguous run of UI telemetry. It retains two active sessions, three archived worktrees, absent `attention.lastResult`, one cached reply with 35 events, and 32 actions dominated by `workspace.switch` and `chat.send`. The action rows do not identify the sessions, prompts, or replies, and are not backend frames. The stability pilot uses their switch frequency to choose a short repeated switch path, and the cache to restore archive/history structure. The Pi foreground-subagent tape supplies actual RPC input for the separate trace replay. The queue pilot drives the real browser and Hub with the recorded non-steerable Pi queue tape, holding replies until the user has acted.

To export a different slice, pass zero-based positions in `.agent-team/cache/index.json` and optionally `workspace-ordinal:message-seq` selectors for history rows:

```sh
npm exec -- tsx scripts/export-anon-corpus.ts "$YAAT_BASE" new-slice.jsonl 0,2,3 3:5
```

The base directory contains `.agent-team/cache/` and `telemetry.db`. The exporter opens SQLite read-only and refuses to overwrite output. It keeps field presence, nesting, array order, approved enums and structural numbers (including original timestamps), and UTF-16 string lengths. It assigns ordinal aliases to identities and unknown keys, masks freeform strings, and zeroes opaque numbers. Both the exporter and tests verify the serialized shape against an allowlist. The result is a structural fixture, not a session backup. Review the exact timing and other retained structure before sharing a new export; redaction does not erase activity patterns.

## Published journey slice

`anon-journey.jsonl` retains 31 approved actions in order (26 switches and 5 sends) and 11 row kinds from three locally cached session histories. It contains only public enum strings in two arrays. The strict schema accepts no timestamps, identifiers (including aliases), paths, free text, or other metadata. The exporter validates both the structural redaction and the narrower projection; `export-anon-corpus.test.ts` validates the committed output and injects disallowed keys, values and types. Export to a new file:

```sh
npm exec -- tsx scripts/export-anon-corpus.ts --journey "$YAAT_BASE" new-journey.jsonl 0,1,2 0:1 0:2 0:3 0:4 0:5 1:1 1:2 1:3 2:1 2:2 2:3
```

The test assigns sandbox destinations to the leading switch burst and seeds generated message text from row kinds. There is no join between telemetry and sessions. The Pi tape supplies recorded stream and Stop frames, not the activity export; no native session file is opened by the exporter.

## Heavy transcript profile

Run `npm run bench:heavy -- --dry-run` to seed and validate the synthetic corpus without a build, server, or browser. Run `npm run --silent bench:heavy` with Playwright Chromium for the full benchmark. It uses a scratch build and home, disables native provider startup, and blocks external browser requests. It does not read real session activity.

The JSON report records cold-open time, three light-to-heavy switch times, and Chromium heap and DOM samples. Times include Playwright navigation or click through the animation frame after the latest row mounts. The fixture uses aggregate cache counts, message sizes, event counts, and Markdown frequencies: 93 synthetic sessions, including two leads paged to 150 loaded rows each. Samples report loaded rows, mounted rows, and inactive payload bytes separately. JavaScript heap size is not total tab memory. Compare runs on the same host and Chromium build. Keep this manual benchmark outside the test tiers; those tiers cover reconnect, reading continuity, and diagram interactions.

## Tier ownership and mock equivalence

| Regression guard                                                                                                                    | Coverage and OS                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send, stream, queued badge and dimming, targeted Remove, no dispatch of the cancelled prompt, and live/rehydrated transcript parity | `queue-journey.test.tsx` runs the production App, real loopback WebSocket, Hub, and workspace persistence against Pi's recorded `single-queue-order` tape. It runs browserless in Fast and in Linux + Windows CI. `journey-pilot-queue` keeps the real Chromium interactions and reload in both CI jobs.                                                                                             |
| Switch sessions, resync a connected App, and deliberate Stop                                                                        | The browserless journey switches between seeded sessions, checks a new socket gets the pending page, remounts before and after settlement, and clicks Stop against `interrupt-abort`. Snap replays retain the original backend lifecycle checks.                                                                                                                                                     |
| One nonzero exit and file-lock release                                                                                              | `crash-and-restore` checks Pi resume and no duplicate prompt; `deterministic-process-exit.test.ts` checks real child exit, SQLite rollback, and a new write. Both run in Fast and in Linux + Windows CI.                                                                                                                                                                                             |
| Steered ownership, authoritative clears, and retained older pages                                                                   | `liveness` keeps the switch and reconnect races in Fast and CI; `app` checks full client history, resident quote jumps, and sidebar reload after late detail eviction. The thousand-message App search, `stream` byte-budget case, and browser resize/reader journey run in Slow and CI. The real-server history journey verifies the full ordered union and rehydrates an evicted transcript in CI. |
| Real pixels, theme contrast, retained state, and large archive/worktree loads                                                       | Slow retains all browser component tests, local stability unit tests, the Chromium subagent pilot and the full-stack Demo bounds. CI also runs the pilots and Demo, and owns the other offline E2E replays and OS-specific checks. Real Pi and the missing-Pi negative check run on Linux CI; orphan-shutdown stress stays local in Slow.                                                            |

### Demo and journey coverage

`demo-browser.test.ts` runs `scripts/bench-demo.ts` against the built bundle in Slow and Linux + Windows CI. The Demo owns these shared success checks:

- `journey-chat-streaming`: the mobile worker's exact table cell, code and multiline Bash-result clipboard text, result hide, and keyboard trace collapse with focus restored. Replay checks Cancel, the stopped badge and styling, hidden Cancel, the settled layout reply, and the quote-target highlight. The journey still checks live streaming, thinking, and completed subagent traces.
- `journey-board-projects`: Active includes the Files objective and hides the phones objective; its drawer lists the seeded task and decision. Opening the archived parser hit switches transcripts and clears search. The journey still checks drawer navigation via the dependency link, explicit search clearing, and Restore.
- `journey-panels-agents`: the seeded untracked `NOTES.md` diff shows its addition; a file added on disk while Files is open appears in Changes and has the correct diff. The journey still checks diff counts, the Files toolbar return, and exact line quotes.
- `diagram-preview.browser`: seeded Mermaid and `dot` previews are inline, hide and restore source, preserve clipboard text, and keep their controls inside the block. Demo checks desktop hover, Tab focus, Enter, labels, and pressed state, plus touch sizing. Browser Mode retains the `graphviz` alias, contrast, wide scrolling, cache eviction and safety cases.

The narrower journeys own fault and stateful paths: `journey-panels-agents` checks the real missing-file 404 and recovery and blocks the bundle to check both persisted theme choices before startup; `journey-board-projects` reopens a note changed on disk. The Demo keeps ordinary theme switching and opening both notes. The three journeys share loopback server and Chromium setup, browser-error reporting, and Windows-safe fixture teardown.

Fast and Slow print elapsed time without budget alerts. Target Fast at 5 s typical / 10 s p99, Slow at 180 s / 270 s p99. The two CI jobs use a hard 10-minute ceiling including setup.

Regression checks during development: suppressing the Hub-to-browser `message_removed` frame left `Third prompt.` visible and the queue pilot failed at its removal assertion. Adding a 1 px right margin to the message column changed its measured width from 974 to 973 CSS pixels and failed the subagent pilot. Same-length middle swaps and duplicates failed the App client-history and real Chromium mounted-window assertions. Accepting a stale cursor failed the App resync assertion. The passing fixtures contain no fault injections.
