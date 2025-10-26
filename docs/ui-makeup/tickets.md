## Ticket 1 – Establish Shared Infrastructure Foundations

**Context**
Lay the groundwork described in SPEC_UI_REFACTOR v1.0 (§4, §6) and plan “Infrastructure Pass – Shared Foundations” so later slices can rely on consistent commands, messaging, security, state, and repository handling.

**Scope**
- Update `package.json` contributions (`commitSmith.container`, `commitSmith.panel`, command registrations) and verify command IDs align with implementation constants.
- Implement shared state store backed by `workspaceState` with in-memory cache for keys (`collapsedSections`, `draftMessage`, `draftNote`, `manualNoteOptOut`, `pushAfterCommit`, `lastConfidence`, `offline`, `skippable`, `skipWarningsDismissed`).
- Create `src/shared/types.ts` exporting shared TypeScript types (`StepId`, `StepStatusEvent`, `AppendLogEvent`, `JournalEntry`, `PipelineResult`, `TestPipelineResult`, `CodexReviewResult`, `CommitResult`).
- Implement `CommitSmithUIBridge` with typed message contracts, debounce/backpressure helpers, error channel, CSP nonce wiring, secret-masking utilities, and disposal registry.
- Introduce multi-root repository selector utility and global execution gate enforcing single concurrent step with rejection toast/status.
- Configure webview CSP, asset loading via `asWebviewUri`, and mask-pattern setting (`commitSmith.logs.maskPatterns`); block external URLs.
- Document orchestrator interfaces (format/lint/typecheck/tests/codex/commit) with timeout wrappers and error normalization (`UserError`, `InfraError`, `OfflineError`, `TimeoutError`).
- Add VS Code command scaffolds for keyboard shortcuts (without wiring actions yet) and settings references for override/shortcuts/mask patterns.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Shared state store, type exports, bridge, gate, and security scaffolding exist and compile without TypeScript errors.
- `package.json` contributions and keybindings load without VS Code warnings; commands appear in Command Palette.
- CSP blocks inline script injection; secret masking utilities configured; external URLs rejected.
- Documented orchestrator contracts, timeout wrappers, and error normalization utilities are in place.

**Dependencies**: None

---

## Ticket 2 – Build Panel Skeleton (Slice A)

**Context**
Implement the static panel layout per SPEC §3-§5 and plan Slice A before dynamic behaviors are added.

**Scope**
- Create `CommitSmithViewProvider` rendering vanilla HTML/TS webview with CSP nonce, loading assets via `asWebviewUri`.
- Build panel structure: step sections (header/status chip, action row, log placeholder, skip checkbox), journal preview, manual note area, commit section with placeholders.
- Integrate bridge bootstrap retaining handles on resolve/revive; include offline banner placeholder and disabled overlay when no SCM repo selected.
- Persist collapsed sections, draft message, draft note using shared state store; restore on load.
- Add basic mock HTML/TS placeholders and listener stubs for upcoming bridge messages.
- Ensure keyboard focus order matches plan; apply CSS variables for chips and theme-safe defaults.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Panel renders in VS Code with correct sections, tooltips, and placeholders; offline banner hidden by default.
- Collapsed state, drafts, and skip checkboxes persist across reloads.
- Multi-root scenario disables buttons with tooltip “Select a repository to run CommitSmith”.
- CSP-compliant markup validated; keyboard navigation matches defined order.

**Dependencies**: Ticket 1

---

## Ticket 3 – Implement Unified Notifier and Status Wiring (Slice B)

**Context**
Add centralized feedback per SPEC §5.2 and plan Slice B to guarantee single toasts/status handling before step actions.

**Scope**
- Implement `CommitSmithNotifier` managing status bar item, toast throttling, and telemetry gating (`step_started`, `step_finished`, etc.).
- Publish `STEP_STATUS` events with timestamps through notifier/bridge and update status chips placeholders.
- Enforce global gate rejection: identical or cross-step triggers while running produce standardized toast/status message, no queueing.
- Wire baseline idle/running states on view activation/deactivation and offline banner state updates (with 30s ping timer).
- Add unit tests for notifier ensuring max one toast per action and correct status text templates.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Triggered mock actions update status bar using defined templates; only one toast emitted per event.
- Gate rejection works (Format followed by Lint shows “Format already running” message, no duplicate executions).
- Telemetry respects `commitSmith.telemetry.enabled`; events suppressed when false.
- Unit tests for notifier/gate pass.

**Dependencies**: Tickets 1–2

---

## Ticket 4 – Format Step Execution (Slice C)

**Context**
Deliver the first functional step as per SPEC §3.1, §10 and plan Slice C.

**Scope**
- Wire Format button to orchestrator `runFormat` with timeout (60s) and error taxonomy mapping.
- Stream logs into UI via bridge using secret masking, truncation (500 lines/100 KB), rate limiting, and `… truncated` marker.
- Emit full `STEP_STATUS` payloads (startedAt/endedAt/blocking) and update summary badge/duration.
- Persist last run state in shared store, respecting skip checkbox.
- Handle timeout, UserError, InfraError with appropriate chip color, tooltips, toast, status bar messaging.
- Add unit/integration coverage for log truncation marker and state store reducer relevant to step.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Running Format updates chips, logs, status bar, and summary badge; truncation marker appears once when limit reached.
- Masked tokens remain hidden in streamed logs (live and persisted), and last-run metadata (status, timestamps, blocking flag) survives webview reload.
- Timeout scenario shows standard message; blocking flag is recorded in shared store for later consumption.
- Manual/unit tests cover Format success/failure/timeouts and log truncation marker behavior.

**Dependencies**: Tickets 1–3

---

## Ticket 5 – Lint Step Execution (Slice D)

**Context**
Implement Lint step aligning with SPEC §3.1, §10 and plan Slice D.

**Scope**
- Wire Lint button to orchestrator `runLint` with timeout handling and shared log streaming utilities.
- Emit `STEP_STATUS` payloads, blocking states, and error summaries including counts.
- Add “Rerun last” active control and stub “Rerun failed only” button with tooltip.
- Ensure lint failures disable commit flow (pending future ticket) by persisting blocking flag; success clears it.
- Update tests to cover `UserError` vs `InfraError` tooltips and truncated log behaviors.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Lint step mirrors Format behavior with correct log handling and blocking persistence.
- Rerun controls behave as specified; stub button displays informative tooltip.
- Lint-specific tests (error taxonomy, truncation marker) pass.

**Dependencies**: Tickets 1–4

---

## Ticket 6 – Typecheck Step Execution (Slice E)

**Context**
Deliver long-running Typecheck integration consistent with SPEC §3.1, §10 and plan Slice E.

**Scope**
- Wire Typecheck button to orchestrator `runTypecheck` with streaming callback, timeout (600s), optional cancel button disabled with tooltip.
- Implement log pagination (“Load more logs”) fetching prior chunks via bridge with deduplication hash.
- Emit `STEP_STATUS` events, blocking state, diagnostics-count summary, and timeout messaging.
- Preserve responsive UI: disable buttons during run, maintain scroll without jank.
- Add tests covering pagination dedupe, timeout copy, and disabled cancel control.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Typecheck logs stream incrementally with truncation/pagination working; timeout shows standard messaging.
- Cancel button remains disabled with tooltip; summary badge displays diagnostics counts.
- Tests validating pagination/truncation/timeouts pass.

**Dependencies**: Tickets 1–5

---

## Ticket 7 – Tests Step Execution (Slice F)

**Context**
Implement Tests step per SPEC §3.1, §10 and plan Slice F.

**Scope**
- Connect Tests button to orchestrator `runTests` with streaming logs, timeout (900s), summary object, and blocking logic.
- Provide “Rerun last” active and “Rerun failed only” stub controls; ensure UI states consistent.
- Implement pagination/dedup logic shared with Typecheck; reuse secret masking/truncation utilities.
- Emit `STEP_STATUS` events and telemetry for test runs; record summary `{total, passed, failed, durationMs}`.
- Add tests verifying summary rendering, timeout handling, and rerun controls.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Tests step streams and paginates logs, populates summary, and enforces blocking/timeout rules.
- Rerun controls behave per spec; telemetry emitted only when enabled.
- Automated/manual tests confirm truncation marker and summary accuracy.

**Dependencies**: Tickets 1–6

---

## Ticket 8 – Codex Review Integration (Slice G)

**Context**
Integrate Codex review per SPEC §3.1, §10, §11 and plan Slice G, respecting No-AI fallback.

**Scope**
- Wire Codex Review button to orchestrator `runCodexReview` with 10s timeout, single retry, and payload normalization.
- Update UI to display AI feedback snippet, confidence badge, timestamp, and journal entry with `source=codex` on success.
- Implement offline detection (timeout/offline errors) triggering banner, gradient styling, and heuristic fallback messaging without journaling.
- Emit telemetry events for review actions and ensure gating prevents concurrent steps.
- Add tests covering success, offline fallback, telemetry gating, and banner lifecycle.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Successful review displays feedback, logs journal entry with `source=codex`, updates status bar/toast.
- Offline scenarios show banner, skip journal entry, and fall back to heuristic guidance.
- Telemetry suppressed when disabled; tests cover scenarios above.

**Dependencies**: Tickets 1–7

---

## Ticket 9 – Journal Snapshot & Manual Notes (Slice H)

**Context**
Implement journal viewer and manual note features per SPEC §3.1, §8, §9 and plan Slice H.

**Scope**
- Render journal preview showing latest 50 entries with badges, timestamps, and pagination (`Load more`) using dedupe hashing.
- Implement manual note submission with validation (non-empty, ≤500 chars), `[manual-entry]` tagging, and persistence in state/journal.
- Merge manual notes into commit draft under `Notes:` heading unless opt-out checkbox (persisted) is set; support multiple notes bullet list.
- Add character counter warnings near 500-char limit; update UI strings via dictionary.
- Ensure manual note actions emit telemetry (`manual_note_added`), show masked content in logs if needed.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Journal preview paginates correctly without duplicates; “Load more” retrieves next 50 entries.
- Manual notes appear immediately, persist after reload, follow `[manual-entry]` schema, and merge into draft as specified.
- Opt-out toggle prevents merge; counters and validation messages behave per plan; telemetry behaves respecting enabled flag.

**Dependencies**: Tickets 1–8

---

## Ticket 10 – Commit & Push Flow (Slice I)

**Context**
Implement commit workflow per SPEC §3.1, §8, §10 and plan Slice I, enforcing gating, heuristics, override policy, skips, and validation.

**Scope**
- Implement commit message source priority (Codex → heuristic → manual notes), heuristic generator using `git diff --numstat` with verb rules, wrapped body, additions/deletions summary, and `Notes:` merge.
- Enforce Conventional Commit regex, 72-char header truncation, body ≤1000 chars, counters, placeholder text; handle low-confidence (<0.4) warning banner and status message.
- Respect skip checkboxes (`skippable` map) when evaluating blocking; revalidate gate and skip state server-side before `commitAndPush`.
- Support push toggle persistence, override preference (`commitSmith.validation.allowOverride`) with “Show details” and conditional “Commit anyway”.
- Normalize orchestrator errors to taxonomy; block commit on `Timeout`/`Infra`/`User` errors; log telemetry (`commit_attempted`, `commit_result`).
- Add integration tests (vscode-test) covering fallback message, skip persistence, override behavior, and No-AI banner interactions.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Commit flow only enabled when gating/validation pass or skip overrides allow; low-confidence warning/telemetry behaves as specified.
- Heuristic fallback produces valid Conventional Commit with `Notes:` section when applicable; opt-out prevents addition.
- Push toggle persists; override UI behaves per preference; errors mapped to tooltips/messages.
- Integration/unit tests covering skip persistence, fallback, override, and validation pass.

**Dependencies**: Tickets 1–9

---

## Ticket 11 – Packaging, Documentation, and Accessibility Polish (Slice J)

**Context**
Finalize deliverable per SPEC §3.2, §11, §13 and plan Slice J ensuring accessibility, documentation, theming, and QA completeness.

- **Scope**
  - Refine CSS/theme variables, chip colors, responsive layout, and offline banner gradient; double-check localization dictionary usage.
  - Ensure ARIA roles, `aria-live`, `aria-controls`, and keyboard focus order are correct; run Accessibility Insights and NVDA/VoiceOver audits.
  - Document keybindings, No-AI mode, manual notes, confidence warnings, skip policy, and requirement-to-UI mapping in README; update changelog, CONTRIBUTING.md, license headers.
  - Produce demo GIF showing modular workflow; store under `/media/`; verify CSP references.
  - Add/expand automated tests: state store reducer, notifier single-toast, log truncation; integration smoke for reload mid-run.
  - Execute full Regression & Smoke Checklist from plan (CSP, multi-root disable, concurrency gate, long-run reload, timeouts, masking, pagination, manual notes, heuristic fallback, skip/override policy, telemetry toggles, shortcuts, accessibility, documentation, cleanup).
  - Run VS Code Marketplace validation, ensure telemetry flag gating documented, confirm disposal/cleanup watchers removed.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Accessibility audits pass without critical issues; screen readers announce status/log updates correctly.
- README includes requirement-to-UI table, keyboard shortcut table, No-AI documentation, testing guidance; demo GIF renders.
- Automated test suites (unit + integration) green; Marketplace validation passes.
- Full Regression & Smoke Checklist executed with documented results.
- Resource disposal confirmed (no duplicate listeners/timers) via manual checks.

**Dependencies**: Tickets 1–10
