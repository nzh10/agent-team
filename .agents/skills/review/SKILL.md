---
name: review
description: Use before committing a non-trivial change or when asked for an independent code review. Delegate a fixed diff to a read-only reviewer and verify its findings before fixing them.
---

# Review

1. **Freeze the scope.** Name the repository and working directory. For a commit range, resolve both endpoints to SHAs and use `git diff <before> <after>`. For a branch, resolve its merge base with the target and compare that SHA to the branch tip SHA. For unstaged tracked edits, save `git diff --binary` to a temporary patch outside the repository and give the reviewer its path. Check `git status --short`: staged and untracked files are not part of an unstaged diff. Include them explicitly if they belong to the requested review. Do not change the review inputs while the reviewer works.
2. **Delegate with fresh context.** Enable `pi-subagents` if necessary, then call `subagent` with `agent: "reviewer"`, the explicit `cwd`, and a self-contained task. Use fresh context, not `oracle` (which forks the parent context). Provide the exact diff command or patch, applicable requirements and project rules, not the author's reasoning or preferred conclusion. Let Pi route the reviewer; do not pin a model.
3. **Request read-only findings.** Ask the reviewer to inspect the diff and relevant surrounding code, without editing, committing, or starting other agents. Return findings directly to the parent, ranked by severity, each with `file:line`, the failing input or scenario, observed versus required behavior, and a minimal reproduction or test suggestion. Return “no findings” if none.
4. **Verify in the parent.** Treat every finding as a hypothesis. Inspect the cited path, exercise the smallest reproducer or replay the relevant fixture, and compare the result to the requirement. Fix confirmed defects, add regression coverage where appropriate, and rerun affected checks. Do not automatically run a second full review for verified localized fixes; run a follow-up review on the incremental diff (plus necessary context) only when fixes introduce new risk or invalidate prior review conclusions.

Report all three categories (use “none” for empty sections):

- **confirmed** — finding, reproduction evidence, fix and validation result.
- **refuted** — finding and the specific counterexample or evidence ruling it out.
- **unverified** — finding, missing evidence, and the next check needed. Do not present it as a defect.
