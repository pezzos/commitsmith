# Status Bar Shim Remediation Plan

Goal: eliminate the status bar shim regression class by aligning the integration harness with the extension’s VS Code API usage and adding guard rails that prevent future drift.

## 1. Close Shim Coverage Gaps

1. **Quick pick support (Issue #1)**
   - Create ticket: `CSH-421 – Extend mock-vscode quick pick` (Assignee: @pipeline-lanes; Due: 2024-07-12).
   - Implement `vscode.window.showQuickPick` in `scripts/test-utils/mock-vscode.js`, returning the first provided item when `canPickMany` is false and echoing the array when true, resolving `undefined` when the caller passes `items = undefined` or the shim simulates cancel, and tolerating `onDidSelectItem` callbacks (invoke if provided, otherwise no-op without throwing).
   - Update `scripts/test-vscode-shim.mjs` to assert the method exists, covers selection/cancellation paths, respects `canPickMany`, and safely handles `onDidSelectItem` hooks.
   - Verification: re-run `npm run test:unit` (guard) and `npm run test:integration` after the shim update and record the results in the ticket.

2. **Message dialog stubs (Issue #2)**
   - Create ticket: `CSH-422 – Mock VS Code info/warn/error dialogs` (Assignee: @pipeline-lanes; Due: 2024-07-12).
   - Add `showInformationMessage`, `showWarningMessage`, and `showErrorMessage` that return promises resolving to the selected item (default `undefined`), supporting overloads for modal options, string arrays, and `QuickPickItem`-style objects, and forwarding the modal flag/option metadata into an internal debug log for inspection.
   - Extend guard script assertions to confirm each method returns a thenable, round-trips string and item options, records modal metadata, and handles modal flag passthrough.
   - Verification: re-run `npm run test:unit` (guard) and `npm run test:integration`, noting results in the ticket.

3. **Terminal / progress APIs (Issue #3)**
   - Create ticket: `CSH-423 – Flesh out mock terminal/progress` (Assignee: @manual-command-owner with @pipeline-lanes support; Due: 2024-07-19).
   - Minimum behavior: `createTerminal` must expose `name`, `sendText`, `show`, and `dispose` (all no-ops recording invocations) and accumulate `sendText` payloads on a `sentCommands` array for assertions; `withProgress` must accept `ProgressLocation.Window`/`Notification` without failing, call the task callback immediately with an object exposing `report({ message, increment })`, and return the callback’s resolved value.
   - Guard script coverage: add assertions that `createTerminal` returns the stub shape, tracks `sentCommands`, `withProgress` invokes the callback, and progress reports capture the last message/increment.
   - Verification: re-run `npm run test:unit`, `npm run test:integration`, ensure manual-command tests remain green, and capture the CI run links in the ticket.

## 2. Persisted State Regression Test

4. Add a regression test that:
   - Uses `withVscodeMock` once and drives the sequence: activate → trigger `commitSmith.pipeline.toggleLane` to switch to guarded → dispose → reactivate → assert the guarded lane and fast-lane reminder flag persist.
   - Uses shim spies to assert `context.workspaceState.update` was invoked rather than mutating state directly.
   - Lives alongside the existing integration harness (`scripts/test-integration.mjs`) and runs in CI.
   - Update the “Final verification” checklist to include executing this test before sign-off.
   - Owner: Pipeline team (ticket `CSH-424 – Workspace-state persistence regression`, Due: 2024-07-12).

## 3. Harness Audit

5. Review scenario-specific harnesses individually (`scripts/test-dry-run.mjs`, `scripts/test-config.mjs`, `scripts/test-codex.ts`, `scripts/test-codex.mjs`, `scripts/test-workspace.mjs`):
   - Maintain a table in the investigation doc summarizing migrate vs bespoke decisions, owners, due dates, rationale (including which APIs bespoke shims emulate), and a review cadence (quarterly revisit for bespoke shims).
   - Capture resulting tickets (e.g., `CSH-425`..`CSH-429`) for any migrations, link them in the doc, and schedule periodic review for any retained bespoke shims.
   - Owner: Pipeline QA leads (audit completion target: 2024-07-19).

## 4. Guard & Checklist Enforcement

6. Guard script policy
   - Update `CONTRIBUTING.md` and `.github/pull_request_template.md` with the reviewer checklist item “If `mock-vscode.js` changed, was `test-vscode-shim.mjs` updated (ci-unit-tests will fail otherwise)?” and include the checkbox referencing the CI stage.
   - Ensure CODEOWNERS call out the shim/guard pair with a focused reviewer group able to respond quickly so enforcement doesn’t bottleneck.
   - Owner: Pipeline team reviewers (ticket `CSH-430`, Due: 2024-07-05).

7. CI visibility
   - Confirm `npm run test:unit` executes in the `ci-unit-tests` GitHub Actions job and note this explicitly in CONTRIBUTING.
   - Owner: CI maintainer (ticket `CSH-431`, Due: 2024-07-05).

8. Lint guard for API drift
   - Prototype a script that inspects `src/extension.ts` (and siblings) for `vscode.` usages, diffs them against shim exports, and emits actionable messages (e.g., “Extension uses window.showXYZ but shim lacks it”), initially running in warning-only mode before graduating to blocking and eventually wiring into `npm run lint`.
   - Track as ticket `CSH-432 – Shim/extension API parity lint` (Owner: Tooling guild; Due: 2024-07-26).

9. Codex extra args sanitization follow-up
   - Plan a separate tech-debt ticket (`CSH-433`) to persist sanitized `codexExtraArgs` back into workspace settings (or log once), eliminating repeated warnings once shim work stabilizes.
   - Owner: Config subsystem maintainers (Due: 2024-07-26).

## 5. Final Verification

10. After implementing the above:
    - Execute `npm run test:unit`, `npm run test:integration`, the new workspace-state regression, and `npm run test:all`.
    - As each ticket ships, append completion status using the standard format `CSH-421 ✅ PR #1234` back into `docs/integration-status-bar-stub-investigation.md`, keeping the doc as the single source of truth for remediation state.
    - Owner: Assigned engineer closing the loop.
