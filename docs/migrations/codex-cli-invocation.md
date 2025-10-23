## Codex CLI Invocation Migration Guide

### Overview
CommitSmith now streams prompts to the Codex CLI over `stdin` instead of passing temporary prompt files or unsupported flags such as `--dry-run`. A feature gate (`commitSmith.codex.cliInvocationVersion`) controls rollout: use `legacy` for emergency fallback, `shadow` to run both paths for telemetry, and `new` for fully migrated environments.

### Minimum Codex CLI Version
- **Required version:** `0.6.0` or newer. Earlier versions lack `stdin` support.
- CommitSmith probes `codex --version` once per session; outdated binaries trigger `codex-cli-guard.v1` telemetry and show an upgrade message.

### Updating Custom Integrations
If you embed CommitSmith helpers or call `runCodexCli` directly:

1. Ensure the Codex CLI on PATH satisfies the minimum version.
2. Remove any usages of `--prompt-file`, `--dry-run`, or equivalent flags; data is now streamed via `stdin`.
3. When mocking Codex, ensure your stub reads payloads from `stdin` and emits JSONL events that include `codex-cli-commit.v1` or `codex-cli-fix.v1`.

### Manual Testing Checklist
1. Set `"commitSmith.codex.cliInvocationVersion": "shadow"` and run a commit flow. Confirm `workflow.codexInvocation` emits paths `shadow` and `legacy`, and `workflow.codexShadowComparison` reports latency deltas.
2. Switch the setting to `"new"`, repeat the workflow, and verify telemetry now reports only `path=new`.
3. Inspect the CommitSmith output channel to ensure prompts are logged without `--prompt-file`/`--dry-run` flags.

### Rollback
If issues arise, set `commitSmith.codex.cliInvocationVersion` to `"legacy"` (or roll back to a prior extension version) and rerun the workflow. Capture Codex CLI version, CommitSmith extension version, and relevant `workflow.codexInvocation` / `workflow.codexShadowComparison` telemetry in the regression report.
