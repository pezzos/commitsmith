## CommitSmith Journal Workflow
<!-- slug: commitsmith-journal-workflow -->

CommitSmith relies on `.ai-commit-journal.yml` to store Codex-authored change summaries. Run the initializer command `CommitSmith: Initialize CommitSmith` (`commitSmith.initializeRepo`) if this file is missing.

> These instructions describe the human workflow. Automated Codex runs in read-only sandboxes must not attempt to execute `commit-smith` commands; just produce the requested outputs and rely on humans to record the journal entry.

Make sure the Codex CLI is installed (`codex` available on your PATH or configured via `commitSmith.codex.binaryPath`) and authenticated with `codex login` before starting a task.

At the end of each task, Codex MUST append journal entries via the CLI (CommitSmith never self-appends). Include metadata flags when you know the scope or ticket:
```bash
commit-smith journal --append "feat: add payment retries" --meta scope=payments --meta ticket=T123
# or, if you prefer invoking the bundled script:
node ./bin/commit-smith.js journal --append "feat: add payment retries" --meta scope=payments --meta ticket=T123
```
Prefer the bundled script in this repository to avoid npm cache or sandbox issues. If you need to fall back to `npx`, set a writable cache (for example `npm_config_cache=.npm-cache`) so it succeeds in restricted environments.

Keep the `meta` section fresh with `--meta key=value` updates. Common keys include `scope`, `ticket`, `ticketFromBranch` (use `true`/`false`), and `style`, but feel free to add others when they provide useful context.

Re-run the initializer after repo resets or whenever `.ai-commit-journal.yml`, `.gitignore`, or this guidance disappears.

## Telemetry & Dashboards
- `workflow.codexInvocation` v1 captures Codex runtime path (`legacy`, `shadow`, `new`), duration, and fallback reason. Dashboard: **DataHub › CommitSmith › Codex Runtime** (`dashboards/codex-runtime`).
- `workflow.codexArtifact` v1 records CLI artifact persistence time and whether artefacts were written. Dashboard: **DataHub › CommitSmith › Artefacts** (`dashboards/codex-artifacts`).
- `workflow.commitFlow` v1 compares pre-Codex prep vs Codex execution timings, lane adoption (`fast` vs `guarded`), push outcomes, and journal confirmation. Dashboard: **DataHub › CommitSmith › Fast Lane** (`dashboards/fast-lane`).

All telemetry payloads include `schemaVersion` and an invocation identifier so dashboards can be correlated with staging or production rollouts.

## Codex CLI Migration & Rollout
- Migration guide: `docs/migrations/codex-cli-invocation.md` (stdin contract, minimum Codex CLI version, and guidance for custom tooling).
- Rollout plan & rollback checklist: `docs/rollout/codex-cli-rollout.md`.
- Telemetry comparison helper: `node scripts/analyze-codex-shadow.mjs <telemetry.jsonl>`.

## Staging Verification Checklist
Run the scripted checklist before promoting changes to production:
1. `npm run compile`
2. `node ./scripts/verify-telemetry.mjs`
3. Confirm dashboards above display fresh staging events (filter by your session `invocationId`).

Document any anomalies directly in the telemetry dashboards and block rollout until resolved.
