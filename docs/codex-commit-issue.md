# Codex Commit Workflow Investigation

## Summary
- **Symptom:** When the Codex commit workflow runs in the Serena read-only sandbox, the CLI returns an informational agent message instead of the required JSON payload. The extension treats this as a failure, falls back to the offline heuristic message, and (ironically) reports a successful commit even though no Codex message was produced.
- **Impact:** Automated commit generation is effectively broken. Every commit attempt yields a fallback subject/body and wipes the journal, while Codex insists it cannot perform the commit.
- **Status:** Unresolved. Multiple prompt and documentation updates failed to change Codex’s behaviour. Further investigation with the Codex CLI/runtime team is required.
- **Observed failing layer (as of 20 Oct 2024):** direct CLI invocations (read-only and workspace-write) both abort immediately with `failed to initialize rollout recorder: Operation not permitted`, suggesting a CLI-level safety/permission gate rather than a parser or prompt issue. Additional host-level captures are still required to confirm behaviour once the session can start.

## Environment
- Serena automation harness
  - `sandbox_mode=workspace-write` for edit operations, but Codex commit requests are forced into `read-only` sandbox internally (to protect `.git`).
  - `approval_policy=never` – Codex has no escalation path.
- CommitSmith VS Code extension (branch `main`, ahead 7 locally).
- Test runner: `npm run compile` (TypeScript only; npm CLI unavailable in sandbox for integration tests).

## Symptom Details
1. The commit prompt now contains explicit instructions:
   - Do not run `git commit`, `commit-smith`, or any commands that modify the repo.
   - Read-only environment, return JSON only.
2. Despite that, Codex responds with:
   > “I’m in a read-only sandbox … I can’t stage or create a commit here.”
   No JSON payload is produced.
3. The extension interprets “missing payload” as a failure, triggers the offline fallback, logs `[OFFLINE ⚠️] Codex unavailable`, and clears the journal.

Latest log (17 Oct 2024):

```
[Codex] Commit prompt (full): …
[Codex] exec commit model=gpt-5-codex …
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I’m in a read-only sandbox with “never” approval, so I can’t stage or create a commit here…"}}
[CODEX ⚠️] Codex request failed …
[OFFLINE ⚠️] Codex unavailable … Generated heuristic commit message.
```

## Timeline of Investigation

| Step | Change | Result |
| --- | --- | --- |
| 1 | Detected Codex attempting `git commit` → failing to create `.git/index.lock`. | Commit blocked; fallback triggered. |
| 2 | Updated `runCodexCli` to use `--sandbox read-only` for `operation === "commit"`. | Prevented `.git` writes, but Codex still attempted commit-like behaviour. |
| 3 | Added diagnostics logging (`logCliDiagnostics`) so we could capture CLI events on every failure. | Logs now show Codex’s agent messages. |
| 4 | Improved fix prompts and file-path extraction to keep Codex focused on real files. | Fix workflow works better; unrelated to commit issue. |
| 5 | Traced commit prompt generation (`buildCommitPrompt`). Added instructions: avoid `ls`, don’t run `commit-smith`, environment is read-only, return JSON only. | Codex still replies with “can’t commit in read-only sandbox”. |
| 6 | Updated AGENTS.md and generator to clarify journal instructions are for humans; automated runs must not call `commit-smith`. | No change in Codex behaviour. |
| 7 | Added explicit reminder in prompt: “Always reply with valid JSON matching the schema.” | Still no payload; same agent message. |

## Instrumentation & Prompt Changes
- `CODEX_DEBUG=events` flag now enables verbose logging inside `runCodexCli` (`src/codex.ts`):
  - emits the full CLI argument vector (`[Codex] args [...]`).
  - echoes every trimmed event line as `[Codex][raw-event] ...` before parsing.
  - dumps the tail of the event buffer when no `result` payload is extracted.
- Documentation updates (AGENTS.md / `src/agents.ts`) clarify that automated Codex runs must not invoke `commit-smith`; those instructions target humans only.
- Commit prompt reinforced with read-only reminders and “JSON-only” guidance to stop Codex from reporting permission issues instead of returning a payload.

## Reproduction Attempts
1. **Direct Node harness.** Attempted to call `generateCommitMessage` with `CODEX_DEBUG=events` from a standalone Node script. Blocked by the lack of the VS Code host module (`Error: Cannot find module 'vscode'`). The existing `scripts/test-codex*.ts` mocks don’t exercise the real CLI.
2. **CLI binary dry run.** Not possible inside the Serena sandbox because the `codex` binary is unavailable and network access is restricted.

## Current Evidence
- Latest field logs (17 Oct 2024) show the prompt already instructs Codex to skip all mutating commands and return JSON only, yet the agent still reports it cannot commit in read-only mode and no payload is emitted.
- With `CODEX_DEBUG=events` enabled, future runs will log the raw stream for confirmation that the CLI truly omits a `result` event.

### Latest sandbox run (18 Oct 2024)
- `npm run test:all` passes end to end, but surfaces configuration noise:
  - `commitSmith.codex.serenaTimeoutMs must be >= 1000` warning.
  - Multiple temporary journal resets (`Journal schema validation failed: /current must be array`) while fixtures hydrate.
  - Node warnings about `MODULE_TYPELESS_PACKAGE_JSON` for `scripts/test-utils/mock-codex-cli.js` (would require adding `"type": "module"` to package.json to silence).
- Codex commit attempt with debugging shows the exact CLI invocation:
  - `--sandbox read-only` appears alongside the Serena MCP override and `reasoning.level="low"`.
  - Raw events cover Serena activation, onboarding checks, memory reads, `git status`, and staged diff inspection before the familiar agent message about lacking permission. **No `result` event appears before exit.**
  - CLI args captured via instrumentation:
    ```json
    ["exec","commit","--json","--sandbox","read-only","--model","gpt-5-codex","-c","mcp_servers.serena={command=\"/Users/a.pezzotta/.local/bin/uvx\",args=[\"--from\",\"git+https://github.com/oraios/serena\",\"serena-mcp-server\",\"--context\",\"codex\",\"--project\",\"/Users/a.pezzotta/repos/commitsmith\"],optional=true,autostart=false,startup_timeout_ms=30000,request_timeout_ms=15000}","-c","mcp_servers.context7.enabled=false","-c","mcp_servers.github.enabled=false","-c","mcp_servers.playwright.enabled=false","-c","mcp_servers.serena.enabled=true","-c","mcp_servers.time.enabled=false","-c","reasoning.level=\"low\""]
    ```
- The extension still falls back to the offline heuristic commit message and immediately clears the journal state.

## Investigation Log
- **2024-10-19 • Experiment 1 – Manual CLI invocation (read-only sandbox)**
  - Command: `codex exec commit --json --sandbox read-only --model gpt-5-codex` with a minimal commit payload piped from Python.
  - Environment flags: `--sandbox read-only`; no additional MCP overrides; `CODEX_DEBUG` unset.
  - Observed CLI events: Immediate failure `failed to initialize rollout recorder: Operation not permitted (os error 1)` followed by `Failed to create session`. No JSON events emitted.
  - Conclusion: The standalone Codex binary cannot start in this Serena shell; requires less restricted environment to capture event stream.
- **2024-10-20 • Experiment 1b – Manual CLI (workspace-write sandbox)**
  - Command: `codex exec commit --json --sandbox workspace-write --model gpt-5-codex` (same payload as above).
  - Environment flags: `--sandbox workspace-write`; `CODEX_DEBUG` unset.
  - Observed CLI events: Identical failure (`failed to initialize rollout recorder: Operation not permitted (os error 1)`), indicating the CLI aborts before any model interaction regardless of sandbox mode in this environment.
  - Conclusion: Failure occurs prior to prompt evaluation; the CLI needs permission to create its rollout recorder, so these shell-level tests cannot proceed inside Serena.
- **2024-10-19 • Experiment 2 – Instrumentation readiness (VS Code workflow)**
  - Command: (pending) commit workflow via VS Code with `CODEX_DEBUG=events`.
  - Environment flags: `CODEX_DEBUG=events` triggers raw-event logging in `runCodexCli`.
  - Observed CLI events: Not yet recorded; VS Code host required to satisfy `vscode` module dependency.
  - Conclusion: Instrumentation merged and awaiting execution in a full extension host.
- **2024-10-19 • Experiment 3 – Parser tail diagnostics**
  - Command: n/a (code path instrumentation only).
  - Environment flags: `CODEX_DEBUG=events` causes `extractCommitResultFromEvents` to dump the last five raw events if no payload is found.
  - Observed CLI events: Pending; will trigger automatically on the next failing commit run.
  - Conclusion: Parser instrumentation ready; need real commit attempt to consume data.
- **2024-10-19 • Experiment 4 – Writable sandbox control**
  - Command: (pending) `codex exec commit … --sandbox workspace-write --dry-run`.
  - Environment flags: Intends to run without read-only restriction.
  - Observed CLI events: not captured (requires environment where CLI can write to `.git`).
  - Conclusion: Control experiment blocked until we can run outside Serena.
- **2024-10-19 • Experiment 5 – Argument audit**
  - Command: Observed during latest sandbox run; automatic logging emitted `[Codex] args [...]` showing `--sandbox read-only`, Serena MCP override, `reasoning.level="low"`, and disabled auxiliary MCP servers.
  - Environment flags: `CODEX_DEBUG=events` (active in user-provided log).
  - Observed CLI events: full arg array captured; raw events still terminate with permission agent message and no `result` payload.
  - Conclusion: Arguments match expectations; refusal persists despite explicit read-only messaging.
- **2024-10-20 • Experiment 6 – Parser diagnostics**
  - Command: instrumentation change only (`extractCommitResultFromEvents` now dumps parsed event tail when no payload is found).
  - Environment flags: requires `CODEX_DEBUG=events` to activate.
  - Observed CLI events: none yet (awaiting host run), but future captures will include both raw and parsed tails for debugging losses.
  - Conclusion: Parser instrumentation ready; pending live data.

## Tests Executed
- `npm run compile` after each code change (passes).
- Codex CLI repro attempts via CommitSmith (commit workflow) – fails every time with the agent message above.
- Fix workflow smoke tests (manual) to confirm prompts still route correctly.

## Findings & Open Questions
1. Codex’s agent message mentions staging/committing, suggesting the model still thinks it must perform the git operation itself. This might be hard-coded behaviour when it sees “commit” operations, regardless of prompt constraints.
2. The CLI terminates the run once the agent emits that message; no JSON `result` event ever arrives.
3. Because the CLI returns no payload, CommitSmith treats it as an error and falls back. The offline logic currently clears the journal, which means every failed attempt loses context.
4. Updating prompts and documentation had no effect, so the root issue likely lies inside the Codex CLI or the model configuration (possibly a built-in safety rule when it detects restricted permissions).

## Recommendation / Next Steps
1. Re-run the commit workflow within VS Code (with `CODEX_DEBUG=events`) and capture the `[Codex][raw-event] …` output to prove definitively whether a `result` payload is ever emitted.
2. Outside the Serena sandbox, run the Codex CLI manually:
   - `codex exec commit … --sandbox read-only --dry-run`
   - `codex exec commit … --sandbox workspace-write --dry-run`
   to see if refusal is keyed off the sandbox flag.
3. Escalate to the Codex CLI/runtime team with the captured prompt, raw events, and sandbox comparison once we confirm the CLI omits the payload under read-only mode.
4. Update CommitSmith to avoid clearing the journal when the CLI returns no payload (preventing data loss during retries).
5. Pause further prompt edits until CLI behaviour is clarified.

## Attachments / References
- `src/codexCli/prompts.ts` – commit prompt text with latest instructions.
- `src/codex.ts` – instrumentation for CLI args & raw event tracing.
- `AGENTS.md` / `src/agents.ts` – updated guidance separating human vs automated journal responsibilities.
- Serena run logs (latest excerpt above) – show raw events and blocking agent message.

---
Prepared by Codex automation investigation – 17 Oct 2024.
