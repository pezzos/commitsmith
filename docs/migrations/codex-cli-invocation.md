## Codex CLI Invocation Migration Guide

### Overview
CommitSmith now streams prompts to the Codex CLI over `stdin` instead of passing temporary prompt files or unsupported flags such as `--dry-run`. The legacy/shadow feature gate has been removed—CommitSmith always uses the streaming path because the file-based fallback never produced valid results.

### Minimum Codex CLI Version
- **Required version:** `0.6.0` or newer. Earlier versions lack `stdin` support.
- CommitSmith probes `codex --version` once per session; outdated binaries trigger `codex-cli-guard.v1` telemetry and show an upgrade message.

### Updating Custom Integrations
If you embed CommitSmith helpers or call `runCodexCli` directly:

1. Ensure the Codex CLI on PATH satisfies the minimum version.
2. Remove any usages of `--prompt-file`, `--dry-run`, or equivalent flags; data is now streamed via `stdin`.
3. When mocking Codex, ensure your stub reads payloads from `stdin` and emits JSONL events that include `codex-cli-commit.v1` or `codex-cli-fix.v1`.

### Manual Testing Checklist
1. Run a commit flow and confirm prompts are streamed (no `--prompt-file`/`--dry-run` flags in the output channel).
2. Verify `workflow.codexInvocation` telemetry reports `path=new` for the invocation.

### Rollback
If issues arise, roll back to a prior CommitSmith release and rerun the workflow. Capture Codex CLI version, CommitSmith extension version, and relevant `workflow.codexInvocation` telemetry in the regression report.
