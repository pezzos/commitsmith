## Codex CLI Invocation Rollout Plan

### Timeline
- **Shadow week:** Enable `commitSmith.codex.cliInvocationVersion = "shadow"` for insiders. Collect telemetry daily comparing legacy vs new paths.
- **Go/No-Go:** At the end of the shadow window, confirm success rate, latency, and fallback parity (Ticket 7 dashboards + `scripts/analyze-codex-shadow.mjs`).
- **GA:** Flip managed settings to `"new"` only after parity is confirmed and rollback checklist is signed.

### Telemetry Review
- `workflow.codexInvocation` (paths `legacy`, `shadow`, `new`) for success/error/fallback counts.
- `workflow.codexShadowComparison` for latency deltas and fallback differences.
- CLI helper: `node scripts/analyze-codex-shadow.mjs <telemetry.jsonl>` to summarise parity locally.

### Rollback Checklist
1. Set `commitSmith.codex.cliInvocationVersion = "legacy"` for affected workspaces.
2. Verify legacy path telemetry returns to nominal success rate.
3. Notify extension users (template below) and log the reason/time of rollback.
4. File follow-up issues and schedule another shadow period before retrying GA.

### Communication Plan
- **Audience:** CommitSmith extension users and partner teams.
- **Cadence:**
  - Pre-shadow announcement outlining benefits and minimum Codex version (`codex --version >= 0.6.0`).
  - Daily telemetry summaries in #commit-smith during the shadow week.
  - GA announcement after parity approval linking to the migration guide and rollback steps.
- **Key Messages:**
  - Reminder to upgrade Codex CLI and remove deprecated flags (`--prompt-file`, `--dry-run`).
  - Instructions for opting into/out of shadow mode via workspace settings.
  - Links: `docs/migrations/codex-cli-invocation.md` (contract/migration) & this rollout note.
