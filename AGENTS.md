## CommitSmith Journal Workflow
<!-- slug: commitsmith-journal-workflow -->

CommitSmith relies on `.ai-commit-journal.yml` to store Codex-authored change summaries. Run the initializer command `CommitSmith: Initialize CommitSmith` (`commitSmith.initializeRepo`) if this file is missing.

At the end of each task, Codex MUST append journal entries via the CLI (CommitSmith never self-appends). Include metadata flags when you know the scope or ticket:
```bash
commit-smith journal --append "feat: add payment retries" --meta scope=payments --meta ticket=T123
```

Keep the `meta` section fresh with `--meta key=value` updates. Common keys include `scope`, `ticket`, `ticketFromBranch` (use `true`/`false`), and `style`, but feel free to add others when they provide useful context.

Re-run the initializer after repo resets or whenever `.ai-commit-journal.yml`, `.gitignore`, or this guidance disappears.
