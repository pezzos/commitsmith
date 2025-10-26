## Ticket 1 – Configure Run Completion Grace Window

**Context**
`docs/codex-notif/spec.md` defines a configurable 5 s grace period before triggering fallback, and `docs/codex-notif/plan.md` §1 requires validated knobs plus documentation and smoke coverage for boundary values.

**Scope**
- Add `journalWriter.cooperativeGracePeriodMs` and `COMMITSMITH_JOURNAL_GRACE_MS` configuration with defaults (5 s) and hard validation (reject <0 or >10 s, interpret 0 as “disable fallback”).
- Ensure RunCoordinator emits `run:completed` before cleanup and document the event order.
- Implement non-blocking grace timer start/cancel logic wired to configuration.
- Write smoke tests for grace period at 3 s, 10 s, and 0 s (disabled) to confirm timer behavior.
- Update developer/operator docs to describe the knobs, bounds, and disable semantics.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Configuration accepts values in [0,10] seconds, applies defaults, and rejects invalid inputs with actionable errors.
- Grace timer arms and cancels correctly at runtime for each boundary case, verified by automated smoke tests.
- Documentation reflects the configuration options, ranges, and disable behavior.
- Event emission order is captured in code comments or docs per specification.

**Dependencies**: None

---

## Ticket 2 – JournalWriter Event Wiring & CLI Integration

**Context**
`docs/codex-notif/plan.md` §2 + spec “JournalWriter Logic” require the writer to listen for `run:completed`, start the grace timer, and invoke the CommitSmith CLI via single-flight, feature-flagged pathways.

**Scope**
- Subscribe JournalWriter to the event bus, start/cancel the grace timer, and listen for cooperative `journal.post` acknowledgements.
- Implement feature flag gating (`codexJournalNotifications`, `journalWriter.dryRun`) and log-only behavior when dry-run is on.
- Wrap CommitSmith CLI invocation (`commit-smith journal --append` or bundled script) with sandbox/auth guardrails and single-flight mutex to serialize writes.
- Emit `journal:write:ack` events (`status:"ok"|"failed"`, `retryable`, `ackId`) immediately after CLI completion.
- Add startup guard that probes installed CLI/bundled script version or checksum to ensure `--run-id` support; if outdated, block enablement and surface remediation steps.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- JournalWriter listens to `run:completed`, arms/cancels timers, and publishes `journal:write:ack` events.
- CLI invocations are serialized and respect feature flags, including dry-run logging.
- CLI version probe prevents enabling the flag on unsupported builds and documents remediation.
- Unit/integration coverage demonstrates ack publication and serialized access.

**Dependencies**: Ticket 1 – Configure Run Completion Grace Window; Ticket 6 – CommitSmith CLI Upsert Support (for `--run-id` dependency)

---

## Ticket 3 – JournalWriter Retry Queue & Failure Handling

**Context**
Spec “Retry queue policy” and plan §2 require a bounded retry queue with backoff, telemetry, and operator escalation without disabling fallback safety nets.

**Scope**
- Implement retry queue with max 3 attempts per `runId` (initial + two retries) at 5 s, 30 s, and 5 m intervals.
- Emit telemetry and `journal:write:ack` payloads reflecting retry attempts and failure reasons (`retryable` flag).
- Cancel queued retries when any `journal:write:ack` `{status:"ok"}` for the `runId` arrives.
- Surface non-blocking UI toast/log alerts on failure while leaving fallback armed.
- Add unit tests covering retry backoff, cancellation on success ack, and escalation path when retries exhaust.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Retry queue schedules retries with specified backoff and stops after three attempts.
- Success `status:"ok"` ack drops outstanding retries; failure after final attempt emits escalation event/log.
- Fallback remains armed throughout failures.
- Automated tests validate retry timing, cancellation, and escalation.

**Dependencies**: Ticket 2 – JournalWriter Event Wiring & CLI Integration

---

## Ticket 4 – Cooperative Hook (`journal.post`) Enhancements

**Context**
Spec “Codex Hook (`journal.post`)" and plan §3 require enforcing required fields, applying defaults, emitting ack metadata, and supporting headless logging.

**Scope**
- Enforce required fields (`runId`, `status`, `title`) and default optional fields (`summary`, `nextSteps`, `changedFiles`, `metrics`, etc.) per spec table.
- Merge orchestrator metadata (duration, repo, branch, metrics) into payload before CLI write.
- Return `{ accepted: true, ackId }` to Codex and emit success/failure ack events with status, runId, ackId.
- Update Codex runtime to log `Journal updated → …` in headless contexts instead of toasts.
- Add validation tests covering payload normalization, missing required fields, and headless logging behavior.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Hook rejects missing required fields with actionable errors and populates defaults.
- Ack payloads include `status`, `runId`, `ackId`, and `retryable` flag.
- Headless runs emit structured logs; interactive runs continue to display toasts.
- Tests cover normalization and headless logging path.

**Dependencies**: Ticket 2 – JournalWriter Event Wiring & CLI Integration

---

## Ticket 5 – Fallback Synthesizer Hardening

**Context**
Spec “Fallback Synthesizer (Orchestrator)” and plan §4 describe log scrubbing, prompt limits, deterministic template, telemetry, and scenario coverage.

**Scope**
- Integrate `SecretMasker`, `pathRedactor`, ANSI stripping, and prompt token capping (~2,000 tokens).
- Implement deterministic template fallback including `repo`, `branch` when LLM invocation fails or times out.
- Emit telemetry (`fallbackInvoked`, `journal:fallback:failed`) and ensure writes route through CLI path.
- Add unit/integration tests for cooperative success (no fallback), Codex crash, network outage, and deterministic template usage.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Fallback scrubs secrets and normalizes paths before prompting.
- Prompt size respects configured cap; deterministic template includes `repo` and `branch`.
- Telemetry records fallback success/failure states.
- Tests cover success, crash, network outage, and deterministic fallback scenarios.

**Dependencies**: Ticket 2 – JournalWriter Event Wiring & CLI Integration

---

## Ticket 6 – CommitSmith CLI Upsert Support

**Context**
Spec “Upsert Semantics” and plan §5 require CLI support for `--run-id` lookup, merge semantics, and cooperative/fallback precedence.

**Scope**
- Extend CommitSmith CLI (and bundled script) to accept `--run-id` lookups, returning existing entries when present.
- Implement merge strategy: Codex-authored fields override fallback text; metadata backfilled from orchestrator.
- Reject requests missing `runId` with clear errors; leave fallback timer armed.
- Provide CLI-side unit tests covering lookup, merge, retries, and partial payloads.
- Document CLI version with new capabilities and expose programmatic version/hash for probes.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- CLI supports `--run-id` lookup and returns structured payloads for merges.
- Cooperative-over-fallback precedence honored; partial retries merge as specified.
- Missing `runId` requests fail fast without side effects.
- Tests cover lookup, cooperative-over-fallback, and partial retry merge scenarios.

**Dependencies**: Ticket 1 – Configure Run Completion Grace Window

---

## Ticket 7 – UI & Notification Updates

**Context**
Spec “JournalWriter Logic” and plan §6 require toast/log parity, interactive head-up display, and potential UI surfaces reacting to ack events.

**Scope**
- Ensure UI toast fires within ≤2 s of successful write and links to the journal entry.
- Emit structured log entries (`Journal updated → …`) for headless or CI contexts.
- Update panels/status bars (if applicable) to reflect ack events and link to journal entry.
- Add UI/UX tests verifying toast timing and headless logging.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Toast appears within ≤2 s with correct link; headless contexts log updates exactly once.
- UI surfaces reflect latest ack status without regressions.
- Automated/UI tests cover interactive and headless behaviors.

**Dependencies**: Ticket 4 – Cooperative Hook (`journal.post`) Enhancements; Ticket 2 – JournalWriter Event Wiring & CLI Integration

---

## Ticket 8 – Telemetry & Observability Instrumentation

**Context**
Spec “Data hygiene” telemetry references and plan §7 demand emitting new metrics/fields and updating dashboards/alerts.

**Scope**
- Add telemetry fields (`fallbackInvoked`, `journalWriteFailed`, retry attempt count, `journal:write:ack` status) to `workflow.codexInvocation`, `workflow.codexArtifact`, and `workflow.commitFlow`.
- Record retry queue metrics and ack outcomes for observability.
- Update dashboards (Codex Runtime, Artefacts, Fast Lane) to surface new fields and set alerts for spikes or sustained retry storms.
- Provide validation scripts or queries to verify telemetry presence in staging.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Telemetry payloads include required fields for cooperative and fallback flows.
- Dashboards visualize new metrics and alert thresholds are configured.
- Validation steps confirm signals before promotion; retry storms are detectable.

**Dependencies**: Ticket 2 – JournalWriter Event Wiring & CLI Integration; Ticket 3 – JournalWriter Retry Queue & Failure Handling; Ticket 5 – Fallback Synthesizer Hardening; Ticket 4 – Cooperative Hook (`journal.post`) Enhancements

---

## Ticket 9 – Automated Testing & Validation Suite

**Context**
Plan §8 and spec regression checklist mandate comprehensive automated coverage including concurrency scenarios and flag-off verification.

**Scope**
- Add unit tests for timer logic, retry policy, CLI wrapper, payload normalization, deterministic template.
- Implement integration tests for cooperative path, fallback path, retry flow, headless logging, and concurrency races (parallel fallback, cooperative overwrite during retry) asserting retry queue drains on success ack.
- Build end-to-end staging scripts covering interactive, headless, and feature-flag-disabled runs aligned with regression checklist.
- Document manual validation steps ensuring legacy workflows remain unchanged when the feature flag is off.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Automated suites cover all specified scenarios, including concurrency races.
- End-to-end scripts run successfully in staging with documented outcomes.
- Manual validation checklist exists and confirms flag-off parity.

**Dependencies**: Tickets 1–8

---

## Ticket 10 – Documentation & Runbook Updates

**Context**
Plan §9 requires documentation updates for APIs, configuration, feature flags, and support escalation.

**Scope**
- Update developer docs, API references, and CLI help for `journal.post`, configuration knobs, and feature flag usage.
- Add runbook entries for retry queue manual intervention, monitoring, and rollback procedures.
- Publish QA checklist aligned with experiment matrix and regression scenarios.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Documentation reflects latest APIs/config flags and is reviewed for accuracy.
- Runbook covers retry queue handling and rollback steps.
- QA checklist matches regression/experiment scenarios from spec.

**Dependencies**: Tickets 1–9

---

## Ticket 11 – Controlled Rollout Execution

**Context**
Spec “Rollout Plan” and plan §10 outline dry-run staging, limited production pilot, telemetry checks, and GA promotion criteria.

**Scope**
- Enable `codexJournalNotifications` with `dryRun=true` in staging, verifying logs and telemetry dashboards.
- Pilot in one guarded production repo after staging sign-off; execute cooperative, fallback, and CLI failure drills.
- Monitor telemetry (retry attempts, ack status, fallback metrics) for 24 h, ensure dashboards stay green, or rollback by disabling flag and clearing retry queue.
- Document rollout results and any incidents; confirm GA promotion or rollback decision.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Dry-run staging, limited production, and GA phases executed per timeline with evidence.
- Telemetry dashboards confirm new signals and no retry storms; alerts remain quiet.
- Rollback procedure documented even if unused; GA promotion approved only after 24 h clean telemetry.

**Dependencies**: Tickets 1–10
