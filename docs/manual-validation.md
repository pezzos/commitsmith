# Manual Validation Notes (Ticket 18)

> The development environment available to this workflow does not provide access to a VS Code Extension Development Host or the Codex CLI, so the steps below are documented but not executed. Please perform them locally to complete the QA pass.

## Prerequisites
- Codex CLI installed and on your `PATH` (`codex --version` should succeed).
- Codex CLI authenticated via `codex login`.
- Clean workspace with the latest CommitSmith sources.

## Validation Checklist
1. **Bootstrap guidance**
   - Open the repo in VS Code.
   - Run `CommitSmith: Run Codex Onboarding` and confirm the terminal launches `codex` with the AGENTS.md prompt.
   - Verify the output channel logs the onboarding status once.
2. **Initializer**
   - Execute `CommitSmith: Initialize CommitSmith` and confirm `.ai-commit-journal.yml` is created or refreshed.
3. **Journal CLI**
   - Run `node ./bin/commit-smith.js journal --append "qa: manual validation"` and confirm the new entry appears in `.ai-commit-journal.yml`.
   - (Optional) If you must use `npx`, provide a writable cache (for example `npm_config_cache=.npm-cache npx --yes commit-smith journal ...`) so the command succeeds under restrictive permissions.
4. **Dry run**
   - Add a failing test or format issue.
   - Run `CommitSmith: Dry Run (Coming Soon)` and confirm CLI artefacts appear under `.commit-smith/patches/<timestamp>/cli/` with `prompt.txt`, `meta.json`, `raw.jsonl`, and `result.json`.
5. **AI fix via pipeline**
   - Introduce a lint error, then run the pipeline (format/type/test) to trigger `codex exec fix`.
   - Confirm the output channel logs a single reasoning sequence per CLI run.
6. **Commit flow**
   - Populate the journal and run `CommitSmith: AI Commit (Journal)`.
   - Ensure `codex exec commit` produces the commit message and the command completes without HTTP references.
7. **Offline fallback**
   - Temporarily rename `codex` to simulate an error and repeat the commit flow to verify fallback messaging and heuristic commit creation.

## Findings
- *Not executed in CI; awaiting manual confirmation.*
- No additional issues were observed during static review.

Please record any anomalies as follow-up tickets before closing the migration epic.
