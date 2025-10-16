## CommitSmith Journal Workflow
<!-- slug: commitsmith-journal-workflow -->

CommitSmith relies on `.ai-commit-journal.yml` to store Codex-authored change summaries. Run the initializer command `CommitSmith: Initialize CommitSmith` (`commitSmith.initializeRepo`) if this file is missing.

At the end of each task, Codex MUST append journal entries via the CLI (CommitSmith never self-appends):
```bash
commit-smith journal --append "feat: add payment retries"
```