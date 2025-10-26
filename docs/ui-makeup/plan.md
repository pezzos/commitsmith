# CommitSmith UI Refactor – Implementation Plan

## Purpose
Translate the technical specification into actionable engineering work with clear user-focused acceptance tests. This plan assumes the existing extension scaffolding is in place and that Codex-driven automation will implement the slices iteratively. The plan aligns with `SPEC_UI_REFACTOR v1.0`.

## Preconditions
- VS Code ≥ 1.90.
- `.ai-commit-journal.yml` initialized and telemetry opt-in state captured.
- Existing commands for format, lint, typecheck, tests, Codex review, and commit callable through the orchestrator.
- Webview assets can be served from `media/`.

## Global Interfaces & Conventions
- **Orchestrator contracts**
  - `runFormat(): Promise<PipelineResult>`; `runLint(): Promise<PipelineResult>`; `runTypecheck(onLog: (chunk: string) => void, onError?: (err: Error) => void): Promise<PipelineResult>`; `runTests(onLog: (chunk: string) => void, onError?: (err: Error) => void): Promise<TestPipelineResult>`; `runCodexReview(): Promise<CodexReviewResult>`; `commitAndPush(input: { message: string; push: boolean }): Promise<CommitResult>`.
  - `PipelineResult = { success: boolean; startedAt: string; finishedAt: string; logs?: string[] }`; `TestPipelineResult` extends with `{ summary?: { total: number; passed: number; failed: number; durationMs: number } }`.
  - Streaming steps supply log callbacks emitting `Buffer | string` chunks; UI converts to UTF-8 and appends.
- **Step concurrency & gate**
  - Single global execution gate: only one pipeline step runs at a time; same-step re-entry rejected immediately with toast “<Step> already running—wait for it to finish” and status bar `CommitSmith: <Step> already running`.
  - No cross-step overlap allowed; requests while another runs are rejected (no queue).
- **Timeouts & retries**
  - Apply step timeouts: Format/Lint 60s, Typecheck 300s, Tests 300s, Codex Review 120s. Checks auto-fail with `TimeoutError` and message “<Step> timed out after <n>s—review logs and retry.” Codex Review retries once automatically; other steps do not retry.
- **Error taxonomy**
  - Normalize orchestrator errors into `UserError`, `InfraError`, `OfflineError`, `TimeoutError`. Unknown blobs become `InfraError` with captured detail. UI tooltips: UserError (“Fix issues in your code”), InfraError (“Missing dependency or tool”), OfflineError (“Codex unavailable—retry later”), TimeoutError (“Exceeded <n>s timeout—rerun”).
- **Log streaming**
  - Prefer orchestrator event streams; if absent, wrap `child_process.spawn` and listen to `stdout.on('data')`.
  - Apply secret masking (configurable regex) before logs reach UI; masking enabled by default (`commitSmith.logs.maskPatterns` setting).
- **Log truncation & backpressure**
  - Cap logs at 500 lines or 100 KB per step; append a single `… truncated` marker when limit reached.
  - Rate-limit append events to ≤20 updates/sec; coalesce data every 100 ms before posting to the webview.
- **Log pagination & deduplication**
  - “Load more” fetches 50-entry pages via `(timestamp, index)` cursor; deduplicate by hash of `ts + source + text` per view session.
- **Timestamps**
  - Emit all timestamps as ISO 8601 UTC strings; store same in state and telemetry.
- **UI stack & assets**
  - Webview built with vanilla HTML/CSS/TypeScript; assets under `/media/` resolved via `webview.asWebviewUri`.
- **CSP & security**
  - Content Security Policy: `default-src 'none'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; connect-src ${webview.cspSource}`. Disallow inline scripts/eval and any non-`asWebviewUri` URLs.
- **Secret masking**
  - Apply best-effort masking for tokens, keys, signed URLs before displaying logs (regex configurable, enabled by default).
- **Offline banner lifecycle**
  - Banner fixed at top; shown when Codex ping fails on panel open, every 30 s poll, or before Codex action; hides after successful ping or manual “Retry” success.
- **No-AI mode**
  - When Codex unavailable, display discrete banner “AI unavailable—using heuristics”, enable heuristic summary automatically, skip Codex errors from blocking commits.
- **Telemetry gating & schema**
  - Guard all events with `commitSmith.telemetry.enabled`. Emit: `step_started {step}`, `step_finished {step, success, durationMs}`, `manual_note_added {chars}`, `commit_attempted {withPush, source}`, `commit_result {success}`. Include timestamp and invocation ID.
- **Keyboard navigation & shortcuts**
  - Focus order: Step controls (Format → Lint → Typecheck → Tests → Codex Review), Journal preview, Manual note + opt-out, Skip checkboxes, Commit editor, Commit controls.
  - Register keybindings (user-toggleable) e.g., `cmd+shift+,` Format, `cmd+shift+.` Lint, `cmd+shift+/` Typecheck, `cmd+shift+'` Tests, `cmd+shift+enter` Commit; documented in README.
- **Blocking visuals & skip policy**
  - Blocking steps display red chip + tooltip “Resolve before committing”. Each step has “Allow skip” checkbox; gating logic uses `(blocking && !skippable[step])`.
- **Journal preview limit & load more**
  - Display recent 50 entries with scroll container; “Load more” requests next page, merging without duplication.
- **Manual note opt-out**
  - Checkbox “Don’t add notes to next commit” persisted per workspace.
- **Low-confidence warning**
  - Amber banner above commit message when confidence <0.4 with status bar message `CommitSmith: ⚠️ Low confidence message`.
- **Shared state schema & scope**
  - Store in `workspaceState`: `collapsedSections`, `draftMessage`, `draftNote`, `manualNoteOptOut`, `pushAfterCommit`, `lastConfidence`, `offline`, `skippable`, `skipWarningsDismissed`.
- **Event & type exports**
  - Shared module (`src/shared/types.ts`) exports `StepId`, `StepStatusEvent`, `AppendLogEvent`, `JournalEntry`, `PipelineResult`, `TestPipelineResult`, `CodexReviewResult`, `CommitResult`.
- **Step labels & status bar templates**
  - Mapping: `format → Format`, `lint → Lint`, `typecheck → Typecheck`, `tests → Tests`, `codexReview → Codex Review`.
  - Status messages: `CommitSmith: Running <Step>`, `CommitSmith: ✅ All checks passed`, `CommitSmith: ❌ <Step> failed`, `CommitSmith: ⚠️ Low confidence message`, `CommitSmith: <Step> already running`.
- **Error handling & normalization**
  - Convert unstructured errors to `InfraError` with captured detail; surface sanitized message + “Open logs” link.
- **Cancellation**
  - Document orchestrator cancellation as “not supported”; UI shows disabled cancel button with tooltip.
- **Commit heuristics & validation**
  - Fallback generator uses `git diff --numstat` grouping by top-level folder; new files in `src/` imply `feat`, pure refactors default `refactor`, otherwise `chore`. Header limited to 72 chars; optional body wraps at 72; include additions/deletions summary lines; manual notes merged under `Notes:` heading.
  - Enforce Conventional Commit: truncate header >72, body optional ≤1000 chars wrapped at 72, append `BREAKING CHANGE: …` when `!` present but footer missing.
  - Preference `commitSmith.validation.allowOverride` (default true); “Show details” reveals issues and “Commit anyway” button.
- **Empty commit UX**
  - Placeholder text “Enter a message or run Codex/heuristics”; display counters for header (0–72) and body (0–1000).
- **Field limits**
  - Manual notes ≤500 chars; enforce with live counter.
- **Skippable steps**
  - Persist `skippable: Record<StepId, boolean>`; gating evaluates blocking only when not skipped.
- **Pre-commit revalidation**
  - Extension re-checks gate, blocking/skippable state, and repository selection immediately before calling `commitAndPush`.
- **Internationalization readiness**
  - Store UI copy in string dictionary for future localization.
- **Accessibility roles & live regions**
  - Status section uses `role="status"`; log containers use `aria-live="polite"` and `aria-controls` linking buttons to logs.
- **Themes & contrast**
  - Define CSS variables for chip states ensuring AA contrast across light/dark themes; include high-contrast adjustments.
- **Keyboard shortcuts documentation**
  - README includes table of shortcuts and instructions to disable via VS Code settings.
- **Targeted rerun commands**
  - Provide commands (even if stubbed) for “Rerun last” and “Rerun failed only” for Lint and Tests.
- **Log deduplication**
  - Deduplicate logs/journal entries by hash `sha256(ts + source + text)` during render and pagination.
- **Cleanup & disposal**
  - Dispose bridge listeners, event subscriptions, timers, telemetry intervals, and stream handles when panel hides or reloads.
- **Multi-root behavior**
  - Operate on selected SCM repository; disable UI with tooltip “Select a repository to run CommitSmith” when none.
- **Command alignment**
  - Ensure `package.json` contributes container `commitSmith.container`, view `commitSmith.panel`, and commands `commitSmith.*` matching implementation constants.
- **No external URLs**
  - Block hyperlinks that are not sanitized file links; provide copyable URLs instead.
- **No-AI gradient**
  - Banner uses subtle gradient to indicate fallback without alarming user.
- **Telemetry & no-AI**
  - `commit_attempted` event marks `source: 'heuristic'` when Codex unavailable.
- **Unit & integration tests**
  - Minimum: state store reducer, notifier single-toast enforcement, log truncation marker; integration via `vscode-test` including reload-mid-run scenario.
- **Smoke reload mid-run**
  - Automated smoke test reloads window during Typecheck to confirm running state persists.
- **Persistence scope**
  - All persisted data stored in `workspaceState`; no use of `globalState` to avoid cross-repo bleed.
- **Type exports**
  - Share types via `src/shared/types.ts` consumed by both extension and webview scripts.
- **README mapping**
  - README must include “Requirement → UI surface” table for Marketplace review.
- **Telemetry flag guard**
  - Highest-level notation: notifier checks flag before scheduling any event.
- **Field validation**
  - UI enforces note/message limits and shows counters; override still logs warning.
- **Gradual fallback**
  - When Codex returns repeated `OfflineError`, degrade gracefully to heuristics with info toast (no blocking).
- **Settings references**
  - Document relevant settings: `commitSmith.logs.maskPatterns`, `commitSmith.validation.allowOverride`, keyboard shortcut toggles.

## Infrastructure Pass – Shared Foundations
- **Implementation**
  - Update `package.json` contributions with the new sidebar container, icon, and command registrations needed across all slices.
  - Define `CommitSmithUIBridge` including typed message contracts, debounce helpers for high-frequency events, and a dedicated error channel feeding the notifier.
  - Introduce a shared step-status model describing the payload shape (status, timestamps, blocking state, log metadata) that every slice publishes and consumes.
  - Stand up a lightweight state store that wraps `workspaceState` with an in-memory cache, providing typed getters/setters for persisted fields (collapsed sections, drafts, skip flags, toggles).
  - Export shared types via `src/shared/types.ts` and ensure both extension and webview build pipelines consume them.
  - Inject CSP meta tags and nonce plumbing into webview bootstrap and verify `asWebviewUri` usage for assets.
  - Implement disposal registry to release bridge listeners, timers, and orchestrator streams on panel disposal.
  - Establish multi-root repository selector utility used by all step triggers.
- **User Tests**
  - Reload extension and confirm view + commands appear in Command Palette.
  - Invoke a sample bridge message in developer mode and verify contract validation + error channel behavior (no crashes, error toast triggered).
  - Confirm persisted fields are accessible through the shared store after reload.
  - Check that command IDs in `package.json` match implementation constants (`commitSmith.*`), and CSP blocks inline scripts via attempted injection test.

## Slice Breakdown

### Slice A – Panel Skeleton (SPEC §7.A)
- **Implementation**
  - Add `CommitSmithViewProvider` registering the sidebar view described in the spec.
  - Wire `CommitSmithUIBridge` into webview bootstrap, retaining handles on resolve/revive and surfacing an offline banner placeholder when Codex is unavailable.
  - Lay out collapsible sections per spec: each step includes header/status chip, streamed log region, action row, skip checkbox, and command buttons; journal panel and commit area mirror final layout so later slices only supply behavior. Include basic mock HTML scaffold with placeholder data and TypeScript listener stubs for bridge messages.
  - Display disabled-overlay when no SCM repository selected, with tooltip from global conventions.
  - Persist collapsed/expanded state and message/note drafts using the shared state store.
- **User Tests**
  - Open VS Code, activate CommitSmith view, confirm sections appear with default collapsed state.
  - Collapse and expand sections, reload window, verify state persists.
  - Enter draft commit message and note, reload window, confirm text persists.
  - Deselect repository in multi-root setup; confirm buttons disabled with tooltip “Select a repository to run CommitSmith.”

### Slice B – Unified Feedback (SPEC §7.B)
- **Implementation**
  - Introduce centralized `CommitSmithNotifier` to manage status bar item and single toast emission, including throttling so bursts of messages coalesce.
  - Publish `STEP_STATUS` events (with started/ended timestamps) through the notifier, ensuring downstream slices consume a single source of truth.
  - Wire baseline idle/running states from the view provider lifecycle with standardized status bar templates defined in global conventions.
  - Enforce gate rejection flow: second trigger while a step runs immediately surfaces toast and does not enqueue work.
- **User Tests**
  - Trigger dummy action (e.g., refresh) and confirm status bar updates once.
  - Ensure only one toast appears per simulated action, even if the action triggers multiple internal updates.
  - Start Format and immediately trigger Lint; verify rejection toast, no concurrent execution, and status bar shows “CommitSmith: Format already running.”

### Slice C – Format Step (SPEC §7.C)
- **Implementation**
  - Connect “Format” button to orchestrator command.
  - Emit full `STEP_STATUS` payloads (status, timestamps, blocking flag) via notifier and shared store.
  - Stream logs into collapsible panel with truncation safeguards (500 lines / 100 KB) for long output and attach standardized log summary (success/failure badge with duration), including secret masking pass.
  - Record blocking state for failures; disable button while action in flight.
- **User Tests**
  - Click “Format”, observe status chip change and log stream updates.
  - Introduce formatting error in repo, rerun, confirm error state, toast, step marked blocking, and log snippet shown; other controls remain enabled.
  - Verify timestamps are chronological, masked secrets do not appear in logs, and truncated marker appears exactly once when cap reached.
  - Simulate `TimeoutError` from orchestrator (mock) and confirm standardized timeout copy displayed with retry guidance.

### Slice D – Lint Step (SPEC §7.D)
- **Implementation**
  - Mirror Slice C wiring for lint command, emitting full `STEP_STATUS` payloads and streaming logs with truncation safeguards.
  - On failure, flag step as blocking via shared state so Slice I can enforce commit gating. Ensure summary object lists error count and duration.
  - Add “Rerun last” button (active) and “Rerun failed only” button (disabled placeholder until supported) leveraging common bridge commands.
- **User Tests**
  - Run lint on clean repo, ensure success unlocks commit flow.
  - Introduce lint failure; verify commit control disabled and error summary displayed until resolved.
  - Confirm timestamp ordering, truncated marker behavior, and that “Rerun failed only” displays informative tooltip when unsupported.
  - Trigger `UserError` (lint rule violation) vs `InfraError` (missing binary) and validate tooltip text matches taxonomy.

### Slice E – Typecheck Step (SPEC §7.E)
- **Implementation**
  - Hook typecheck button to orchestrator, ensuring long-running command logs stream incrementally (no buffering).
  - Emit full `STEP_STATUS` payloads with accurate start/end timestamps and blocking state.
  - Add cancel safeguard if orchestrator supports it; otherwise, surface disabled cancel control with tooltip “Cancel not supported.”
  - Normalize summary badge to show success/failure + total diagnostics count.
  - Attach log pagination control (“Load more logs”) to request additional history via bridge and deduplicate.
- **User Tests**
  - Run typecheck on normal project; confirm log continues to append during execution.
  - Simulate extended run and ensure UI remains responsive (buttons disabled appropriately, logs scroll).
  - Verify timestamps remain in order, truncated marker present at limit, and “Load more logs” fetches earlier entries without duplicates.
  - Force timeout scenario (mock) and confirm UI shows standard timeout message and sets status to error with retry hint.
  - Confirm cancel button remains disabled with tooltip “Cancel not supported.”

### Slice F – Tests Step (SPEC §7.F)
- **Implementation**
  - Integrate test runner command with structured result summary (pass/fail counts) appended after logs.
  - Emit full `STEP_STATUS` payloads, ensuring blocking state reflects failures and timestamps recorded.
  - Support `Rerun last` (active) and `Rerun failed only` (stub) controls; hook into bridge with clear disabled state for stub.
  - Maintain streaming logs with truncation and pagination support like Typecheck.
  - Summary structure: `{ total, passed, failed, durationMs }` appended after log tail in consistent format.
- **User Tests**
  - Run passing test suite; verify summary shows total tests and duration.
  - Break a test; rerun, confirm failure summary, clickable log, and commit button remains blocked.
  - Confirm long log runs truncate appropriately, truncated marker visible, pagination loads more logs without duplicates, and rerun controls behave as expected.
  - Simulate `TimeoutError` to ensure consistent messaging and blocking state.

### Slice G – Codex Review Integration (SPEC §7.G)
- **Implementation**
  - Connect “Codex Review” action to orchestrator, ingesting AI feedback and storing it in journal with `source=codex`.
  - Display AI review snippet within UI, with timestamp and confidence when available.
  - Detect Codex offline when `runCodexReview` rejects with `OfflineError` or times out after 10s; show offline banner, skip journal entry, and fall back to local guidance without errors.
  - Emit telemetry (`step_started`, `step_finished`) for Codex review actions respecting opt-in flag.
  - Update No-AI gradient banner styling when fallback persists.
- **User Tests**
  - Trigger review; ensure panel shows loading state, then AI feedback.
  - Disconnect Codex (or simulate failure); confirm offline banner surfaces, graceful fallback occurs, and journal entry is omitted or marked appropriately.
  - Check journal viewer subsection reflects new entry with correct metadata when Codex succeeds.
  - Verify telemetry suppressed when `telemetry.enabled=false` and emitted otherwise.
  - Stay in offline state to confirm No-AI banner renders gradient styling without overwhelming rest of UI.

### Slice H – Journal Snapshot & Manual Note (SPEC §7.H / §8)
- **Implementation**
  - Embed journal preview widget displaying latest entries (pipeline + codex + manual).
  - Wire manual note submission to append `[manual-entry]` items without editing files.
  - Merge manual notes into the next draft commit message unless the user opts out via toggle.
  - Validate input (non-empty, <= 500 chars) with inline feedback, and persist `[manual-entry]` flag in journal schema.
  - When multiple notes exist pre-commit, concatenate in chronological order with bullet separator in draft message preview.
  - Include character counter and warning when note near 500 char limit.
- **User Tests**
  - Submit valid note; confirm immediate appearance in journal preview and persisted after reload.
  - Verify note content auto-appends to draft message and respects opt-out preference.
  - Attempt empty/oversized note; observe inline validation preventing submission.
  - Click “Load more” in journal preview and confirm older entries stream in via bridge without duplicate rows.
  - Toggle opt-out; ensure manual notes no longer merge into draft and re-enable merges after toggle reset.
  - Enter 480+ char note; confirm character counter and warning threshold behavior before reaching 500 char limit.
  - Add multiple notes; confirm draft displays `Notes:` heading with bullet list in chronological order.

### Slice I – Commit & Push Flow (SPEC §7.I / §8)
- **Implementation**
  - Implement commit message editor honoring message source priority (Codex → heuristic → manual notes) and surfacing low-confidence (<0.4) warnings.
  - Enforce prerequisites: all blocking steps green, message valid, push toggle persisted via shared store.
  - Execute commit via orchestrator and optionally push when checkbox enabled, disabling both actions when blocked states exist; revalidate gate/skip state server-side immediately before invocation.
  - Implement heuristic fallback generator using `git diff --numstat` to synthesize summary when Codex message unavailable, grouping by top-level folder, adjusting verbs, and wrapping body lines at 72 chars with optional additions/deletions bullet list.
  - Validate message against Conventional Commit regex `^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([\w\\-]+\))?!?: .{1,72}$`; warn but allow override when opt-in preference set; enforce header/body truncation rules.
  - Merge manual notes under `Notes:` heading when opt-out unchecked; append bullet list for multiple notes.
  - Surface placeholder and character counters for header/body; disable commit until message non-empty.
  - Respect per-step skip checkboxes, showing summary of skipped steps before commit.
  - Normalize unstructured orchestrator errors to InfraError view with tooltip.
- **User Tests**
  - With all steps succeeding, edit message, click “Commit & Push”; verify toast, status bar success, and journal entry.
  - Toggle “Push after commit” off and confirm only commit happens.
  - Trigger low-confidence Codex message; confirm warning banner and ability to edit before committing.
  - Attempt commit with failing step or invalid message; ensure actionable warning and control remains disabled (including push).
  - Reload window and confirm push toggle persistence.
  - Reload window after setting skip flag; confirm skip preference persists and gating respects it.
  - Disconnect Codex and verify heuristic fallback message populates editor with summary plus merged manual notes under “Notes:” section when opt-out unchecked.
  - Confirm “Notes:” block omitted when user opts out of note merge.
  - Toggle step skip for Tests; confirm commit allowed with skip, recorded in telemetry, and banner shows skipped steps.
  - Simulate override preference disabled; ensure “Commit anyway” button hidden.
  - Trigger header >72 chars; verify automatic truncation and toast indicating truncation.
  - Cause InfraError from orchestrator; verify normalized tooltip and status message.
  - Validate header/body character counters update live and placeholder text appears when message cleared.
  - Attempt to race commit by toggling skip flag mid-submit; ensure pre-commit revalidation stops commit when blocking step restored.

### Slice J – Packaging & Polish (SPEC §7.J / §13 / §12)
- **Implementation**
  - Finalize styles, accessibility attributes, and responsive behavior.
  - Ensure screen-reader announcements fire for status changes (e.g., step success/failure, offline banner).
  - Update README (section per panel area, manual note flow, confidence warnings, keyboard shortcuts, No-AI mode) plus requirement-to-UI table; update changelog, CONTRIBUTING.md, and license headers for new assets/telemetry.
  - Extract UI strings into dictionary module to demonstrate localization readiness.
  - Capture demo GIF showcasing modular workflow; store under `/media/`.
  - Run Marketplace validation tooling.
- **User Tests**
  - Navigate panel solely via keyboard; confirm focus order and ARIA labels.
  - Resize VS Code window; ensure layout adapts without overlapping content.
  - Review README demo and instructions for accuracy.
  - Use screen reader to verify status changes and offline banner announcements.
  - Validate chip colors meet AA contrast in light and dark themes.
  - Verify keyboard shortcut documentation matches actual bindings and note how to disable them.
  - Confirm UI strings pulled from dictionary module for future localization hooks.

## Regression & Smoke Checklist
- Launch extension: panel activates without errors, CSP blocks inline script injection attempts, offline banner hidden when Codex reachable.
- Multi-root: with no SCM repo selected, all step buttons disabled with tooltip; selecting repo re-enables controls.
- Concurrency gate: run Format, immediately trigger Lint—verify rejection toast, no queued work, status bar shows “CommitSmith: Format already running”.
- End-to-end flow: format → lint → typecheck → tests → codex review → add manual note → commit & push, including reload mid-sequence to confirm state persistence and skip settings retention.
- Long-running Typecheck: reload VS Code mid-run; upon return, view still shows running state until completion; log truncation marker and pagination function as expected.
- Timeout handling: simulate Format (60s) and Typecheck (600s) timeouts; ensure standardized timeout message, `TimeoutError` classification, and telemetry `step_finished` recorded with `success=false`.
- Secret masking: inject fake token into logs and confirm masked output both live and after pagination.
- Logs & journal pagination: trigger “Load more” for logs and journal; confirm 50-entry pages, no duplicates thanks to hash dedupe, truncated marker remains singular.
- Manual notes: verify `[manual-entry]` entries appear in journal preview, merge into commit draft under `Notes:` when opt-out unchecked, and disappear when opted out.
- Heuristic fallback / No-AI: disable Codex to validate banner gradient, heuristic summary generation (≤72 char header, wrapped body), and telemetry `commit_attempted` source=`heuristic`.
- Skip policy: mark Tests as skippable, commit proceeds while recording skipped steps; ensure non-skipped blocking step still prevents commit.
- Override policy: with `allowOverride=false`, “Commit anyway” absent; when true, “Show details” reveals override button and gating still revalidated before commit.
- Telemetry: confirm no events when `telemetry.enabled=false`; when enabled, verify sample payloads (`step_started`, `commit_attempted`) captured with correct metadata.
- Keyboard shortcuts: confirm registered shortcuts trigger actions and can be disabled via settings.
- Accessibility & contrast: run VS Code Accessibility Insights and NVDA/VoiceOver; ensure ARIA roles, live regions, and chip contrast meet AA.
- README & docs: verify README contains requirement-to-UI table, keyboard shortcut list, No-AI documentation, and that new strings come from dictionary.
- Resource cleanup: show panel, hide/destroy, re-open; confirm disposables cleared (no duplicate listeners, timers, or memory leaks via profiler).
