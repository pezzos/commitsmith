## Codex CLI Invocation Rollout Plan

### Timeline
- **Validation:** Run smoke tests in staging to confirm the streaming (`stdin`) invocation works with the current Codex CLI build.
- **GA:** CommitSmith now ships only the streaming path; no feature flag or workspace setting remains.

### Telemetry Review
- `workflow.codexInvocation` (`path=new`) for success/error/fallback counts.
- CLI helper: `node scripts/analyze-codex-shadow.mjs <telemetry.jsonl>` still works for historical comparisons but now only reports `new`.

### Rollback Checklist
1. Roll back the CommitSmith extension to the last version that still contained the legacy invocation code.
2. Verify telemetry returns to nominal success rate after rollback.
3. Notify extension users (template below) and log the reason/time of rollback.
4. File follow-up issues capturing root cause and remediation steps before retrying GA.

### Communication Plan
- **Audience:** CommitSmith extension users and partner teams.
- **Cadence:**
  - Pre-shadow announcement outlining benefits and minimum Codex version (`codex --version >= 0.6.0`).
  - Daily telemetry summaries in #commit-smith during the shadow week.
  - GA announcement after parity approval linking to the migration guide and rollback steps.
- **Key Messages:**
  - Reminder to upgrade Codex CLI and remove deprecated flags (`--prompt-file`, `--dry-run`).
  - Clarify that no shadow/legacy toggle is available; fixes require an extension rollback.
  - Links: `docs/migrations/codex-cli-invocation.md` (contract/migration) & this rollout note.
