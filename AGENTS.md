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
