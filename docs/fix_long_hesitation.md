# Codex Commit Investigation ("Fix Long Hesitation")

## Objective
Pin down why Codex refuses to return a commit message JSON payload when the workspace is sandboxed as read-only, even after prompt and guidance updates.

## Instrumentation Added
- `CODEX_DEBUG=events` now drives extra logging in `runCodexCli` (`src/codex.ts`):
  - Every CLI argument is logged (`[Codex] args [...]`).
  - Each raw event line is echoed as `[Codex][raw-event] ...` before parsing.
  - When no `result` event is found, the tail of the raw event buffer is logged via `logMultilineBlock`.
- Added documentation notes (AGENTS.md / `src/agents.ts`) clarifying that automated runs must not execute `commit-smith`.

## Reproduction Attempts
1. **Direct Node harness** – tried running `generateCommitMessage` with `CODEX_DEBUG=events` using a plain Node script.
   - Blocked by the missing `vscode` module because we are outside the VS Code host. (Error: `Cannot find module 'vscode'`.)
   - Scripts under `scripts/test-codex*.ts` rely on mocks and therefore do not exercise the real CLI.
2. **CLI binary test** – not possible inside the Serena sandbox; `codex` binary is unavailable and network access is restricted.

## Current Evidence
- Latest field logs (17 Oct 2024, supplied by user) show:
  - Prompt already tells Codex the environment is read-only, to skip `commit-smith`, and to return JSON only.
  - Codex still responds with an agent message about not being able to commit, and no `result` payload arrives.
  - CommitSmith falls back to the heuristic message and clears the journal.
- With instrumentation enabled, the next run (from a real VS Code session) will yield a `[Codex][raw-event] ...` stream and confirm whether the CLI emits a `result` event at all.

## Next Steps for Follow-up Investigator
1. Run the commit workflow inside VS Code with `CODEX_DEBUG=events`.
   - Collect the `[Codex][raw-event] …` output to determine if a `result` event ever appears.
   - Observe the logged CLI args to verify `--sandbox read-only` is the only behavioural change.
2. Execute the Codex CLI manually in two modes (outside Serena if necessary):
   - `codex exec commit … --sandbox read-only --dry-run`.
   - `codex exec commit … --sandbox workspace-write --dry-run`.
   - Compare behaviours to see if the refusal is keyed off the sandbox flag.
3. If a writable sandbox produces a correct JSON payload, escalate the issue as a probable CLI safeguard triggered by read-only mode. Otherwise, continue inspecting event handling within CommitSmith.

## Open Questions
- Does the Codex CLI intentionally short-circuit commit requests when it detects read-only sandboxes?
- Are we missing a `result` event due to parsing/stream handling, or is the CLI truly omitting it?
- Should CommitSmith avoid clearing the journal when no `result` arrives (to prevent data loss)?

## References
- Instrumented code: `src/codex.ts` (event logging & args), `src/codexCli/prompts.ts` (prompt updates).
- Previous investigation log: `docs/codex-commit-issue.md`.

**Status:** Data collection blocked until a session with a working Codex CLI & VS Code host is available.
