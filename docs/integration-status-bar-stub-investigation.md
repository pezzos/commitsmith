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
| Quick pick / `showQuickPick` | lane chooser (`lines ~157`, `~440`) | ✖ → **Follow-up:** implement `showQuickPick` stub returning selectable items. *Owner:* pipeline team. **Acceptance:** guard script asserts method exists and resolves the provided item. |
| `showInformationMessage`, `showWarningMessage`, `showErrorMessage` | reminder + error flows | ✖ → **Follow-up:** add noop message stubs resolving `undefined`. *Owner:* pipeline team. **Acceptance:** guard script verifies each function returns a promise. |
| `vscode.window.createTerminal`, `withProgress` | manual command runner / pipeline feedback | ✖ → **Follow-up:** coordinate with manual-command feature owner to provide stub terminal and progress reporter. **Acceptance:** guard script covers both APIs and manual-command tests remain green. |

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
- Monitor quick pick/terminal usage and expand the shared shim when activation begins to rely on those APIs; coordinate with harness owners before broadening coverage.

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
