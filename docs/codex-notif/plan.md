# PLAN: Codex Journal Notification Mechanism

## Purpose
Implement the notification workflow defined in `docs/codex-notif/spec.md` so every Codex run records
an idempotent journal entry via the CommitSmith CLI, with cooperative and fallback paths, telemetry,
and controlled rollout.

## Milestones
- **M0 – Foundations (Week 0):** Finalize spec, align stakeholders, prepare feature flag defaults.
- **M1 – Core Plumbing (Week 1):** Land event bus updates, JournalWriter timer + CLI pipeline, and
  `journal.post` hook changes gated behind dry-run mode in staging.
- **M2 – Fallback, Telemetry, UI (Week 2):** Ship synthesizer improvements, retry queue, telemetry,
  and interactive/headless notifications; validate in staging and limited production repo.
- **M3 – Rollout (Week 3):** Enable guarded production rollout, monitor dashboards for 24 h, expand
  to GA if clean; otherwise rollback per protocol.

## Workstreams & Tasks

### 1. Event Flow & Configuration
- Add `journalWriter.cooperativeGracePeriodMs` + `COMMITSMITH_JOURNAL_GRACE_MS` config plumbing with
  defaults and validation (recommended 3–10 s); reject negatives or values >10 s, treat `0` as “fallback
  disabled,” and update docs accordingly.
- Ensure RunCoordinator emits `run:completed` before cleanup; document event contract.
- Implement non-blocking grace timer and cancellation hooks; add smoke tests covering min (3 s),
  max (10 s), and disabled (0) settings to confirm timer behavior.
- Wire feature flag `codexJournalNotifications` and `journalWriter.dryRun` (log-only mode).

### 2. JournalWriter Enhancements
- Hook into event bus, start timer, listen for `journal.post` acknowledgements.
- Serialize CLI calls with single-flight mutex to prevent simultaneous writes.
- Integrate CommitSmith CLI invocation (`commit-smith journal --append` / bundled script) including
  handling for required CLI auth/cache guardrails.
- Before enabling the flag, probe installed CommitSmith CLI version (or bundled script checksum) to
  ensure `--run-id` support; if outdated, upgrade CLI or keep flag off until remediation.
- Emit `journal:write:ack` (`status:"ok"|"failed"`, `retryable`) events; cancel fallback on `ok`.
- Implement retry queue (max 3 attempts, 5 s/30 s/5 m backoff); drop pending retries when an ack
  `status:"ok"` arrives for the same `runId`; escalate `retryable=false`.
- Surface non-blocking UI toast/log on failures; keep fallback armed.

### 3. Cooperative Hook (`journal.post`)
- Update API layer to require `runId`, `status`, `title`; accept optional fields with defaults:
  `summary=""`, `nextSteps=[]`, `changedFiles=[]`, `metrics={}`, etc.
- Expand payload validation/normalization to merge orchestrator metadata.
- Return `{ accepted: true, ackId }`, schedule CLI append, and emit success/failure ack events.
- Ensure headless contexts log `Journal updated → …` instead of toast.

### 4. Fallback Synthesizer
- Implement log gathering with `SecretMasker`, `pathRedactor`, ANSI stripping, and prompt token cap.
- Produce YAML/Markdown summary using LLM; include deterministic template fallback with `repo` and
  `branch` when LLM fails.
- Emit telemetry for `fallbackInvoked`, `journal:fallback:failed`; ensure idempotent writes through
  CLI path.
- Add unit/integration coverage for cooperative success, Codex crash, network outage, CLI failure.

### 5. Merge & Upsert Semantics
- Extend CLI to support `--run-id` lookup for existing entries and merge semantics.
- Implement cooperative-over-fallback precedence and partial-update handling (merge metadata, honor
  Codex-authored text).
- Guard against missing `runId` (reject + alert, keep fallback timer armed).
- Concurrency QA: simulate concurrent fallback writes, cooperative overwrite arriving while a retry
  is queued, and assert retry queue drains when `status:"ok"` ack emits.

### 6. UI & Notifications
- Ensure toast appears ≤2 s after successful write; includes link to journal entry.
- For headless runs, emit structured log with `runId`, status, and entry path.
- Update any in-product surfaces (panels, status bars) to reflect new ack event if applicable.

### 7. Telemetry & Observability
- Emit `workflow.codexInvocation`, `workflow.codexArtifact`, and `workflow.commitFlow` updates to
  include new fields (`fallbackInvoked`, `journalWriteFailed`, retry attempt, `journal:write:ack`
  status).
- Instrument `journal:write:ack` outcomes and retry queue metrics.
- Update dashboards (Codex Runtime, Artefacts, Fast Lane) with new signals; add alerts for spikes.

### 8. Testing & Validation
- Unit tests: timer logic, retry policy, CLI invocation wrapper, payload normalization, deterministic
  fallback template.
- Integration tests: cooperative path (Codex hook + ack), fallback path (timer expiry), retry flow,
  headless logging, and concurrency races (parallel fallback, cooperative overwrite during retry).
- End-to-end staging scripts matching regression checklist (interactive, headless, flag-off runs).
- Verify feature flag default-off leaves legacy behavior untouched.
- Validation during rollout: confirm new telemetry fields (`fallbackInvoked`, `journalWriteFailed`,
  retry attempts, ack status) surface on dashboards before promotion; watch for retry storm patterns.

### 9. Documentation & Support
- Update developer docs/CLI help for `journal.post`, config knobs, feature flag usage.
- Add runbook entries covering retry queue manual intervention and rollback procedure.
- Provide QA checklist mirroring experiment matrix and regression scenarios.

### 10. Rollout Execution
- **Week 1 (Dry-run staging):** Enable flag with `dryRun=true`, verify logs, telemetry, dashboards.
- **Week 2 (Limited prod):** Enable on single repo guarded lane, run cooperative/fallback/CLI failure
  drills, confirm notifications and instrumentation.
- **Week 3 (GA decision):** Require 24 h clean telemetry before promoting flag; rollback by disabling
  flag and clearing retry queue if anomalies observed.

## Deliverables & Ownership
- **Orchestrator team:** Event bus changes, JournalWriter updates, fallback synthesizer, telemetry.
- **CLI team:** CommitSmith CLI append enhancements, runId lookup, default handling.
- **Codex runtime:** `journal.post` payload emission, UI toast/log updates.
- **QA/Support:** Regression checklist execution, documentation updates, rollout monitoring.

## Dependencies & Risks
- Requires latest CommitSmith CLI available in all environments (ensure bundler script packaged).
- LLM availability for fallback; deterministic template mitigates outages.
- Feature flag configuration must propagate to Codex runtimes before enabling.
- Ensure secret masker and path redactor libraries are up to date to avoid leakage.

## Completion Criteria
- All acceptance criteria in `spec.md` satisfied (telemetry fields, idempotent entries, notifications).
- Regression checklist passes in staging and limited production.
- Feature flag rolled out per timeline with monitored dashboards showing stable metrics.
- Documentation and runbooks updated, operators trained on retry/rollback procedures.
