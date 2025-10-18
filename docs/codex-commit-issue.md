# Codex Commit Workflow Investigation

## Summary
- **Symptom:** When the Codex commit workflow runs in the Serena read-only sandbox, the CLI returns an informational agent message instead of the required JSON payload. The extension treats this as a failure, falls back to the offline heuristic message, and (ironically) reports a successful commit even though no Codex message was produced.
- **Impact:** Automated commit generation is effectively broken. Every commit attempt yields a fallback subject/body and wipes the journal, while Codex insists it cannot perform the commit.
- **Status:** Unresolved. Multiple prompt and documentation updates failed to change Codex’s behaviour. Further investigation with the Codex CLI/runtime team is required.

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
- Escalate to the Codex CLI team with:
  - The full prompt and logs (attached above).
  - Confirmation that the environment is intentionally read-only and that we only need the JSON message.
  - Request an option or model behaviour change so Codex can return the commit message even when it cannot write to `.git`.
- In parallel, adjust CommitSmith to avoid clearing the journal on these failures (prevent data loss) – tracked separately.
- Pause further prompt tweaks until we have guidance from the Codex team; additional changes have shown no effect.

## Attachments / References
- `src/codexCli/prompts.ts` – commit prompt text with latest instructions.
- `AGENTS.md` / `src/agents.ts` – updated guidance for humans vs. automated runs.
- Serena run logs (see above excerpt) – show the blocking agent message.

---
Prepared by Codex automation investigation – 17 Oct 2024.
