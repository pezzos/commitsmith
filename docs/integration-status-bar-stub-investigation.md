Integration Test Failure – VS Code Status Bar Stub Regression
============================================================

## Summary
- Running `npm run test:all` (or `node scripts/test-integration.mjs`) aborts with `TypeError: Cannot read properties of undefined (reading 'Left')` when the compiled extension tries to access `vscode.StatusBarAlignment.Left`.
- Subsequent retries surfaced additional `TypeError`s for `workspaceState.get`, `workspace.onDidSaveTextDocument`, `workspace.onDidChangeTextDocument`, `workspace.onDidChangeWorkspaceFolders`, and `window.onDidCloseTerminal`, blocking the pipeline test stage.
- The failures reproduce consistently when the extension activates outside of VS Code because our integration harness replaces the `vscode` module with a bespoke shim defined in `scripts/test-integration.mjs`.

## Findings
- `PipelineLaneController` now persists the chosen lane through `context.workspaceState` and drives a status bar item created via `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101)` (`src/extension.ts:95`).
- `PipelineCheckScheduler` wires multiple VS Code events—`workspace.onDidSaveTextDocument`, `workspace.onDidChangeTextDocument`, `workspace.onDidChangeWorkspaceFolders`, and `window.onDidCloseTerminal`—to keep the status bar summary in sync (`src/extension.ts:226`–`src/extension.ts:245`).
- The integration harness intercepts `Module._load("vscode")` to provide a minimal stub (`scripts/test-integration.mjs:24`–`scripts/test-integration.mjs:157`). Before today it only exposed `EventEmitter`, `commands.registerCommand`, and `window.createOutputChannel`, so every new API usage listed above resolved to `undefined`.
- The activation context supplied by the harness lacked a `workspaceState` implementation (`scripts/test-integration.mjs:160`–`scripts/test-integration.mjs:187`), which caused the second crash once the status bar alignment issue was addressed.
- Configuration validation warnings in the log (`commitSmith.pipeline.maxAiFixAttempts must be >= 0`, etc.) stem from the shim returning fallback defaults and are unrelated to the crash; the pipeline only halts because the mocked VS Code surface is incomplete.

## Root Cause
- The VS Code shim used by `scripts/test-integration.mjs` fell out of sync with the extension’s current dependencies. Recent pipeline lane work introduced new status bar and workspace hooks, but the shim continued to emulate a much smaller portion of the API surface. As soon as the compiled extension accessed the missing members, Node threw `TypeError`s.

## Remediation
- Extracted a reusable shim via `scripts/test-utils/mock-vscode.js` and updated integration harnesses to consume it (`scripts/test-integration.mjs`, `scripts/test-integration.ts`).
- Added `scripts/test-vscode-shim.mjs` (wired into `npm run test:unit`) to assert the shim surface so regressions fail fast.
- Extend the shim to define the members exercised by pipeline activation:
  - Provide `StatusBarAlignment.Left`/`Right` and a `window.createStatusBarItem` stub that returns a disposable object mirroring the real API shape (`scripts/test-utils/mock-vscode.js`).
  - Stub `window.setStatusBarMessage`, `window.onDidCloseTerminal`, `workspace.onDidSaveTextDocument`, `workspace.onDidChangeTextDocument`, and `workspace.onDidChangeWorkspaceFolders` to return no-op disposables (`scripts/test-utils/mock-vscode.js`).
  - Supply lightweight `workspaceState`/`globalState` stores with `get`/`update` so activation can persist preferences (`scripts/test-utils/mock-vscode.js`).
- After updating the shim, `node scripts/test-integration.mjs` completes successfully and the pipeline check proceeds past the integration stage.

## Follow-ups
- Add a checklist item (or reviewer reminder) to keep `scripts/test-utils/mock-vscode.js` in sync with new VS Code API usages introduced in `src/extension.ts`.

---

Status Bar Lane Regression
==========================

### Repro Path
- Entry command (repo root):  
  ```bash
  npm run compile
  node ./scripts/test-integration.mjs
  ```  
  The same activation occurs inside `npm run test:integration`.
- Harness configuration overrides (resolver inside `scripts/test-integration.mjs`):  
  - `pipelineEnable=true`, `pipelineRequireChecks=false`, `pipelineMaxAiFixAttempts=0`, `pipelineAbortOnFailure=true`  
  - `formatCommand="npm run format:fix"`, `typecheckCommand="npm run typecheck"`, `testsCommand="npm test -- -w"`  
  - `codexModel="gpt-5-codex"`, `codexReasoningLevel="low"`, `codexExtraArgs=[]` after sanitisation, `jiraFromBranch=true`
- Harness flags: mock replaces `Module._load("vscode")` and injects stub git/journal modules; no additional CLI flags are required.
- Context object supplied to `activate`: `{ subscriptions: [], workspaceState: MapMemento, globalState: MapMemento }`.
- Activation path: `dist/extension.js` → `activate(context)` → `new PipelineLaneController(context)` → `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101)` and `context.workspaceState.get`.
- Failure condition: historical shim exported `window.createStatusBarItem` and `StatusBarAlignment` as `undefined`, producing `TypeError: Cannot read properties of undefined (reading 'Left')`.

### Shim Coverage Matrix

| API surface | `src/extension.ts` usage (post-lane work) | `scripts/test-utils/mock-vscode.js` support | Notes |
| --- | --- | --- | --- |
| `vscode.window.createStatusBarItem` | used for pipeline lane (`lines ~95`, `~294`) | ✔ | returns stub with `text`, `tooltip`, etc. |
| `vscode.StatusBarAlignment.Left/Right` | lane + checks status bar construction | ✔ | constants defined in shim |
| `context.workspaceState.get/update` | storing selected lane | ✔ | shim supplies `Map`-backed memento |
| `context.globalState.get/update` | fast-lane reminder tracking | ✔ | same memento helper |
| `vscode.window.setStatusBarMessage` | lane toggle feedback (`line ~134`, `~491`) | ✔ | returns disposable |
| `vscode.workspace.onDidSaveTextDocument`, `onDidChangeTextDocument`, `onDidChangeWorkspaceFolders` | check scheduler subscriptions (`lines ~319`) | ✔ | stub returns disposable |
| `vscode.window.onDidCloseTerminal` | clears manual terminal handle | ✔ | stub returns disposable |
| `vscode.workspace.workspaceFolders`, `getConfiguration`, `onDidChangeConfiguration` | activation defaults | ✔ | implemented |
| `vscode.commands.registerCommand` | command registration checks | ✔ | collects IDs |
| Quick pick / `showQuickPick` | lane chooser (`lines ~157`, `~440`) | ✔ | stub returns default selection, respects `canPickMany`, and supports queued overrides/cancellation; guard asserts single, multi, and cancel flows. |
| `showInformationMessage`, `showWarningMessage`, `showErrorMessage` | reminder + error flows | ✔ | stubs return promises, honor modal/options metadata, support string/message-item actions, and guard captures selection behaviour. |
| `vscode.window.createTerminal`, `withProgress` | manual command runner / pipeline feedback | ✔ | terminal stub captures `sendText`/`show` calls and exit status; `withProgress` supports window/notification locations, reporter updates, and guard verifies recorded progress. |
| Dry-run harness (`scripts/test-dry-run.mjs`) | bespoke shim covering configuration, output channel, minimal progress reporting | Keep bespoke (2025-10-24 – owner: pipeline QA). Rationale: harness builds `dist/workflows/dryRun.js` directly and mocks codex CLI/child processes; adopting shared shim would require replicating git exec stubbing and Mock Codex wiring. No additional VS Code APIs needed. Review cadence: quarterly (next review due 2026-01-24). | |
| Config harness (`scripts/test-config.mjs`) | bespoke shim limited to `workspace.getConfiguration` and `onDidChangeConfiguration` | Keep bespoke (2025-10-25 – owner: pipeline QA). Rationale: harness only validates `dist/config.js` defaults/overrides using Map-backed configuration; shared shim adds no benefit and would complicate precise configuration assertions. No new VS Code APIs involved. Review cadence: quarterly (next review due 2026-01-25). | |
| Codex TS harness (`scripts/test-codex.ts`) | bespoke shim providing config access, output channel, progress reporter, telemetry subscription, codex CLI mock wiring | Keep bespoke (2025-10-25 – owner: codex platform). Rationale: harness exercises codex CLI spawn/telemetry with custom codex mock; migrating would require layering the shared shim atop complex CLI stubbing with no additional VS Code APIs. Review cadence: quarterly (next review due 2026-01-25). | |
| Codex JS harness (`scripts/test-codex.mjs`) | _File removed_ – legacy JS harness superseded by TypeScript variant (`scripts/test-codex.ts`) | No action (2025-10-25 – owner: codex platform). Rationale: the JS harness no longer exists in repo; all codex workflow coverage runs through the TS harness audited above, so shared shim adoption is not applicable. Review cadence: verify remains absent quarterly (next review due 2026-01-25). | |
| Workspace harness (`scripts/test-workspace.mjs`) | _File removed_ – workspace tests handled elsewhere | No action (2025-10-25 – owner: pipeline QA). Rationale: harness was deleted; no shim migration needed. Review cadence: verify remains absent quarterly (next review due 2026-01-25). | |

### Workspace/Global State Lifecycle
- The helper’s mementos persist for the life of the mock instance (multiple activations within the same Node process see the same values). State resets when the harness exits, matching VS Code process lifetime semantics.  
- **Remediation item:** add a regression test (e.g. in `scripts/test-integration.mjs`) that calls `activate()` twice in the same process using the existing mock, toggles the lane in the first activation, and asserts the second activation reads the persisted lane (and fast-lane reminder flag) from `workspaceState`/`globalState`.

### Harness Adoption
- `scripts/test-integration.mjs` and `scripts/test-integration.ts` both import `withVscodeMock`; no integration entry point continues to inline its own shim.  
- **Evaluation item:** pipeline QA leads will audit scenario-specific harnesses (`test-dry-run.mjs`, `test-config.mjs`, `test-codex.ts`, etc.), decide migration versus bespoke coverage, and record the decision (and owner) in this document and follow-up tickets to prevent drift.

### Guard Script Enforcement
- `scripts/test-vscode-shim.mjs` runs under `npm run test:unit` (CI fails during the unit-test stage). It currently asserts alignment constants, status bar item shape, disposable-returning hooks, and memento persistence.  
- Reviewer expectation: whenever `mock-vscode.js` gains new members, extend `scripts/test-vscode-shim.mjs` in the same PR; reviewers should reject changes that lack matching guard updates.  
- CI gate: failures appear in the `npm run test:unit` stage—if the shim drifts, the unit-test job fails, preventing merge.

### Action Items / Ownership
- **Checklist:** Add a reviewer reminder to ensure `scripts/test-utils/mock-vscode.js` is updated alongside any new VS Code API usage in `src/extension.ts`. *Owner:* pipeline team reviewers (track via CODEOWNERS checklist).  
- Monitor terminal/progress usage and expand the shared shim when activation begins to rely on those APIs; coordinate with harness owners before broadening coverage.

### Ticket Status
- CSH-421 ✅ ([this PR](#)) – Added `window.showQuickPick` stub with queueable overrides/cancellation plus guard coverage; `npm run test:unit` and `npm run test:integration` pass with the updated shim.
- CSH-422 ✅ ([this PR](#)) – Added dialog stubs with modal/options support, queueable selections, guard assertions, and passing unit/integration suites.
- CSH-423 ✅ ([this PR](#)) – Added terminal/progress shims with call tracking, guard coverage, and passing unit/integration test suites.
- CSH-424 ✅ ([this PR](#)) – Added workspace-state persistence regression exercising double activation and lane toggling within `scripts/test-integration.mjs`.
- CSH-425 ✅ ([this PR](#)) – Audited dry-run harness; decision recorded to keep bespoke shim with quarterly review.
- CSH-426 ✅ ([this PR](#)) – Audited config harness; retained bespoke shim with documented cadence.
- CSH-427 ✅ ([this PR](#)) – Audited codex TS harness; bespoke shim maintained with review cadence.
- CSH-428 ✅ ([this PR](#)) – Confirmed codex JS harness removed; no migration required.
- CSH-429 ✅ ([this PR](#)) – Confirmed workspace harness removal; no migration required.
- CSH-430 ✅ ([this PR](#)) – Added shim/guard checklist to CONTRIBUTING and PR template; CODEOWNERS updated.
- CSH-431 ✅ ([this PR](#)) – Documented `ci-unit-tests` job as guard location in CONTRIBUTING.
- CSH-432 ✅ ([this PR](#)) – Added warning-mode VS Code API parity lint wired into `npm run lint`.
- CSH-433 ✅ ([this PR](#)) – Deduplicated Codex CLI deprecated-flag warnings each process and added config test coverage.
- CSH-434 ✅ ([this PR](#)) – Final verification run (`npm run test:unit`, `npm run test:integration`, `node scripts/test-integration.mjs`, `npm run test:all`) confirmed green status.

### Final Verification Checklist
- ✅ 2025-10-25 – `npm run test:integration`, `node ./scripts/test-integration.mjs`, and `npm run test:all` executed; persistence regression and guard suites green in this PR.

### Open Questions
- Some scenario harnesses still maintain bespoke (minimalist) shims. As we migrate more activation logic into shared code, evaluate whether those suites should adopt the common helper or keep tailored mocks.  
- No additional TypeErrors surfaced in current logs, but we should continue scanning CI output for unhandled VS Code members as future features roll out.

Dry-Run Skip Logging Regression
===============================

## Summary
- `npm run test:dry-run` (invoked from the full pipeline) crashed with `AssertionError [ERR_ASSERTION]: Skip reason should be logged` in `scripts/test-dry-run.mjs:280`.
- The dry-run harness builds the extension (`npm run compile`) and then exercises the compiled `dist/` output; when the pipeline skips mutating commands it expects visible `[FORMAT ⏭️] …` / `[TESTS ⏭️] …` log lines.
- The compiled `dist/pipeline.js` continued to gate those skip messages behind the debug flag, so they never surfaced in non-debug runs.

## Findings
- `src/pipeline.ts:169` logs skip reasons via `log(hooks, …, { debug: true })`. The default CLI configuration keeps debug output hidden (`shouldShowDebugOutput()` is false) so the skip message is discarded.
- In production the user would also miss the rationale for the skipped formatter/test steps, defeating the purpose of the dry-run summary.
- The compiled JavaScript in `dist/pipeline.js:62` mirrors the debug-gated log call. Because `scripts/test-dry-run.mjs` imports `../dist/workflows/dryRun.js`, updating TypeScript alone is insufficient until `npm run compile` refreshes the bundle.
- The repeated `[CommitSmith] Removing deprecated Codex CLI flag …` warnings stem from `parseCliArgs` in `src/config.ts:366`. Each fresh `getConfig()` call sanitizes the string-valued `commitSmith.codex.extraArgs`, emitting a warning for every banned token (`--prompt-file`, `--dry-run`). During the dry-run test the configuration is read multiple times (module initialization, explicit assertions, pipeline execution), so the warnings appear in clusters, making the output unusually verbose.

## Root Cause
- The dry-run workflow evolved to rely on the skip rationale being visible, but the logging remained marked as debug-only. Integration tests that assert on the user-facing log therefore fail once the compiled bundle is regenerated, and real users would see a silent skip.
- The verbosity is an expected side effect of the current sanitization routine: configuration reads are not cached and the stored value still contains the deprecated flags, so each read repeats the warning sequence.

## Remediation
- Update `src/pipeline.ts:169` to drop the `{ debug: true }` option so skip reasons always surface: `log(hooks, `[${formatStepLabel(step.id)} ⏭️] ${reason}`);`.
- Run `npm run compile` so the updated TypeScript propagates into `dist/pipeline.js` (line `63`) before executing `scripts/test-dry-run.mjs`.
- Acknowledge the warning noise as a known behavior; one potential improvement is to persist the sanitized `codexExtraArgs` or guard repeated warnings, but that is out of scope for the immediate fix.

## Follow-ups
- Consider caching sanitized Codex extra arguments (or flipping the stored value) to avoid printing the deprecation warning every time `getConfig()` runs.
- Validate other skip-path log statements to ensure they are not accidentally hidden behind debug flags.

Q&A: Status Bar Shim and Test Harness Coverage
----------------------------------------------

**Which change first required `createStatusBarItem` and lane persistence?**  
Commit `2ec852f` (“feat: enhance pipeline with fast lane and telemetry improvements”) added the `PipelineLaneController` to `src/extension.ts`, introducing both the status bar item (`vscode.window.createStatusBarItem`) and the persisted lane selection via `context.workspaceState`. That change is when the legacy shim diverged.

**Did every integration harness adopt `mock-vscode.js` immediately?**  
Yes. As part of the extraction both `scripts/test-integration.mjs` and `scripts/test-integration.ts` were updated in the same change set to import `withVscodeMock`. No integration harness still embeds the old inline shim; only scenario-specific tests (dry-run, config, etc.) keep their bespoke stubs.

**How long do the stubbed `workspaceState`/`globalState` values persist?**  
The helper stores data in memory for the lifetime of the mock. Multiple activations during a single test run share the same memento, but state is reset when the harness exits. We are not attempting to simulate persistence across separate process runs.

**Are there other VS Code APIs the extension touches that the shared shim skips?**  
Activation currently uses quick picks, information/warning/error messages, `withProgress`, and terminal creation. Those interactions are stubbed in the feature-specific harnesses but not exhaustively mirrored in the shared helper. If activation code starts invoking them directly, the shim will need incremental updates.

**How strict is `scripts/test-vscode-shim.mjs`?**  
It exercises the pieces the activation harness depends on today (status bar members, disposable-returning listeners, memento behavior). It is intentionally selective rather than a full snapshot; adding new APIs still requires extending the shim (and optionally its guard) but the test will catch regressions in the existing surface.

**Do other tests rely on the minimalist shim behavior?**  
No other harness imported the original inline shim; suites such as `test-dry-run.mjs` install their own targeted stubs and continue to behave as before. The richer helper only affects the integration scripts that opted in.

**Have we automated reminders for new VS Code API usage?**  
Beyond the new guard script and this documentation, there is no additional lint or telemetry yet. Keeping the shim in sync remains a reviewer checklist item/to-do for future work.
