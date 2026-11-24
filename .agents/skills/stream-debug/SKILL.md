---
name: stream-debug
description: Debug Pi and Codex event projection, transcript rendering, queue transitions and reconnect equivalence. Read before editing the session/workspace/client event path or investigating a rendering issue.
---

# Stream debugging

Find the matching fixture in `service/tests/snap/{pi,codex}` and read its `.snap.md` together with the recording (`npm run summarize -- <file.jsonl>`). If it is missing or ambiguous, follow the capture-sdk skill. Prefer an offline replay over a real account turn. Assert the visible symptom and verify both the snapshot and the live projection; the event pipeline is described in `AGENTS.md`.

## Evidence boundaries

- **Codex:** A `turn/steer` response admits a steer, but only the later `userMessage` carrying its `clientId` proves it was read. An unread steer goes back into the queue after interruption. Late command completion can belong to the interrupted turn even after a new turn starts (`codex/steer-interrupt`). Do not reuse an old item as evidence for the new turn.
- **Pi:** `prompt` acknowledgement, actual read, and `agent_settled` are different boundaries. A process may handle an input without a durable conversation entry, and Pi can initially buffer a user entry. Only positive session proof or explicit rejection distinguishes receipt from non-delivery after a questionable write; absence alone must not replay a report. For initial input and resume, see `pi/crash-and-restore` and `tests/unit/project-v2.test.ts`.
- **Compaction:** Pi's `compact` RPC is not a prompt. `compaction_end` can occur outside a turn; its token estimates are not usage or delivery receipts. Pi appends a compaction record but does not rewrite the session. ACP usage changes do not prove Pi compaction and must not set its checkpoint (`pi/compaction-and-retry`).
- **Subagents:** A foreground Pi tool and a detached run are different even when both emit progress; compare `pi/pi-subagents-foreground` and `pi/pi-subagents-async`. A card or banner is not in itself evidence that the main turn ended.
- **Queue:** A `send_receipt` confirms Hub admission, not model receipt. Authoritative clears (e.g. `queuedFor: null`, `steering: false`) matter to a continuously connected browser; assert them against a fresh page. Do not infer a send outcome from a new WebSocket's request IDs.

Run the source fixture, `snap.test.ts` and `broadcast.test.ts` when changing projection. If the renderer is the issue, use a `webview/tests/` regression showing the same visible card, banner, queue action, or detail before and after reconnect. Do not paper over a diverging projection by regenerating its snapshot.
