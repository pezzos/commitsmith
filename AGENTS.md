## CommitSmith Journal Workflow
<!-- slug: commitsmith-journal-workflow -->

CommitSmith relies on `.ai-commit-journal.yml` to store Codex-authored change summaries, if absent, run the initializer command `CommitSmith: Initialize Repository` (`commitSmith.initializeRepo`) to create it.

At the end of each task, Codex MUST append journal entries via the CLI (CommitSmith never self-appends):
```bash
codex journal --append "feat: add payment retries"
```
