## Ticket CSH-421 – Extend mock VS Code quick pick

**Context**
The shared VS Code shim lacks `window.showQuickPick`, leading to crashes when activation code invokes the lane chooser. We need a faithful stub plus guard coverage.

**Scope**
- Add `showQuickPick` to `scripts/test-utils/mock-vscode.js` with single/multi select and cancel handling.
- Update `scripts/test-vscode-shim.mjs` with assertions for selection and cancellation flows.
- Run unit/integration harnesses to verify the new behavior.
- Record completion in the investigation doc.

**Return**
- Return the list of files updated or created.
- Return the list of tests run (`npm run test:unit`, `npm run test:integration`) and their outcomes.
- Return manual steps, if any, to validate quick-pick behaviour.

**Feedback**
Flag follow-up tickets if you discover additional APIs that require stubbing.

**Acceptance criteria**
- `showQuickPick` stub supports single/multi selection and cancellation without throwing.
- Guard script fails if the stub is removed or regresses.
- Integration tests execute without `showQuickPick`-related errors.

**Dependencies**: None

---

## Ticket CSH-422 – Mock VS Code information/warning/error dialogs

**Context**
Activation uses message dialogs. The shared shim must emulate these to avoid future crashes and tests need guard coverage.

**Scope**
- Implement `showInformationMessage`, `showWarningMessage`, `showErrorMessage` stubs returning promises.
- Support overloads for modal options, string arrays, and QuickPick-like objects.
- Extend guard script to validate promise return values and option handling.
- Update investigation doc with completion status.

**Return**
- Return file change list.
- Return tests executed (`npm run test:unit`, `npm run test:integration`).
- Return any manual verification steps for dialog behaviour.

**Feedback**
Create additional tickets if other dialog APIs surface.

**Acceptance criteria**
- Dialog stubs resolve the expected selection or `undefined`.
- Guard script assertions cover string and item options and pass.
- Integration tests run without dialog-related failures.

**Dependencies**: CSH-421

---

## Ticket CSH-423 – Flesh out mock terminal and progress APIs

**Context**
Manual command features rely on terminal creation and progress reporting; these are absent in the shared shim.

**Scope**
- Add `window.createTerminal` returning an object with `name`, `sendText`, `show`, `dispose`, capturing calls.
- Implement `window.withProgress` supporting `ProgressLocation.Window/Notification`, calling the task with a reporter and returning its result.
- Expand guard script to cover terminal/progress behaviours.
- Re-run manual command tests if available.

**Return**
- Return file change list.
- Return test suite details (`npm run test:unit`, `npm run test:integration`, manual command tests).
- Return manual steps (if any) to inspect captured terminal/progress invocations.

**Feedback**
Open tickets for additional API gaps discovered during implementation.

**Acceptance criteria**
- Terminal/progress stubs behave as defined and guard script enforces them.
- Integration harness executes without terminal/progress TypeErrors.
- Manual command functionality remains green.

**Dependencies**: CSH-421, CSH-422

---

## Ticket CSH-424 – Add workspace-state persistence regression test

**Context**
We must ensure `workspaceState`/`globalState` persist across multiple activations in the same process to prevent regressions.

**Scope**
- Add a test in `scripts/test-integration.mjs` that activates twice, toggles lanes via command, and asserts persisted state.
- Ensure the test runs automatically with integration suite.
- Update the final verification checklist in the investigation doc.

**Return**
- Return file change list.
- Return tests executed (`npm run test:integration`, `node scripts/test-integration.mjs`).
- Return manual steps required to validate persistence (if any).

**Feedback**
If additional state mechanisms need coverage, raise new tickets.

**Acceptance criteria**
- Regression test fails if `workspaceState`/`globalState` stop persisting across activations.
- Integration suite remains green with the new test.
- Documentation reflects the new safeguard.

**Dependencies**: CSH-421, CSH-422, CSH-423

---

## Ticket CSH-425 – Audit shim usage: dry-run harness

**Context**
We need to decide whether `scripts/test-dry-run.mjs` should adopt the shared shim or retain bespoke mocks.

**Scope**
- Evaluate APIs used by the dry-run harness.
- Document migrate vs bespoke decision, owner, and rationale in investigation doc (table).
- Create follow-up ticket if migration is required.

**Return**
- Return investigation doc updates.
- Return any new tickets created (IDs).
- Return steps taken during the audit.

**Feedback**
Raise tickets for uncovered API gaps discovered during the audit.

**Acceptance criteria**
- Decision documented with owner/date and rationale.
- Follow-up ticket filed if migration is planned.

**Dependencies**: CSH-424

---

## Ticket CSH-426 – Audit shim usage: config harness

**Context**
Decide migration strategy for `scripts/test-config.mjs`.

**Scope**
- Review APIs used by config harness.
- Document decision in investigation doc table with owner/date.
- Open migration ticket if needed.

**Return**
- Return doc updates and tickets created.
- Return audit steps performed.

**Feedback**
Log new tickets for uncovered API gaps.

**Acceptance criteria**
- Decision recorded with rationale.
- Follow-up ticket created if migration planned.

**Dependencies**: CSH-425

---

## Ticket CSH-427 – Audit shim usage: codex TS harness

**Context**
Determine whether `scripts/test-codex.ts` should adopt the shared shim.

**Scope**
- Analyze API usage.
- Update investigation doc with decision, owner, due date.
- Raise migration ticket if required.

**Return**
- Return doc updates and new ticket references.
- Return audit steps.

**Feedback**
Flag additional API gaps as needed.

**Acceptance criteria**
- Decision documented with rationale.
- Follow-up ticket filed when migration warranted.

**Dependencies**: CSH-426

---

## Ticket CSH-428 – Audit shim usage: codex JS harness

**Context**
Review `scripts/test-codex.mjs` shim requirements.

**Scope**
- Inspect API usage.
- Document decision in investigation doc table with owner/date.
- Create migration ticket if necessary.

**Return**
- Return doc updates and ticket IDs.
- Return audit notes.

**Feedback**
Add tickets for new API gaps if found.

**Acceptance criteria**
- Decision captured with rationale.
- Follow-up ticket created if migration needed.

**Dependencies**: CSH-427

---

## Ticket CSH-429 – Audit shim usage: workspace harness

**Context**
Finalize shim decision for `scripts/test-workspace.mjs`.

**Scope**
- Review API usage and determine migration vs bespoke.
- Document outcome, owner, due date in investigation doc.
- File migration ticket where applicable.

**Return**
- Return doc changes and new ticket references.
- Return audit process summary.

**Feedback**
Identify additional gaps as needed.

**Acceptance criteria**
- Decision recorded with rationale.
- Follow-up ticket filed if migration planned.

**Dependencies**: CSH-428

---

## Ticket CSH-430 – Update contributor & PR checklists for shim guard

**Context**
We must enforce guard updates when the shim changes.

**Scope**
- Update `CONTRIBUTING.md` and `.github/pull_request_template.md` with guard checklist item referencing `ci-unit-tests`.
- Ensure CODEOWNERS routes shim/guard changes to the reviewer group.

**Return**
- Return modified files.
- Return tests run (if any) to validate docs/CI config (e.g., lint).
- Return manual verification steps for template rendering.

**Feedback**
Flag new tickets if additional documentation needs adjustment.

**Acceptance criteria**
- Checklist changes merged and visible in new PR templates.
- CODEOWNERS reflects reviewer ownership.

**Dependencies**: CSH-429

---

## Ticket CSH-431 – Document CI guard visibility

**Context**
Developers need to know where the guard fails in CI.

**Scope**
- Confirm the job running `npm run test:unit` (expected `ci-unit-tests`).
- Document this in CONTRIBUTING.
- Update plan doc if job name differs.

**Return**
- Return documentation updates.
- Return verification steps confirming job name.

**Feedback**
Open follow-up if CI structure changes.

**Acceptance criteria**
- Documentation clearly states the CI job name for guard failures.
- Confirmation recorded (e.g., screenshot or build link).

**Dependencies**: CSH-430

---

## Ticket CSH-432 – Prototype VS Code API parity lint

**Context**
Prevent future drift by detecting new `vscode` usages absent from the shim.

**Scope**
- Prototype a script comparing `vscode.` usages in `src/extension.ts` (and other activation modules) against shim exports.
- Integrate in warning mode with `npm run lint` or unit tests.
- Document next steps for promoting to blocking mode.

**Return**
- Return new script/config files.
- Return tests or lint commands executed.
- Return manual instructions for interpreting lint output.

**Feedback**
Create a follow-up ticket for graduating to blocking severity.

**Acceptance criteria**
- Script runs in CI (warning mode) and surfaces discrepancies.
- Documentation instructs developers how to act on warnings.

**Dependencies**: CSH-431

---

## Ticket CSH-433 – Persist sanitized Codex extra args

**Context**
Repeated warnings occur because sanitized `codexExtraArgs` are not persisted.

**Scope**
- Modify configuration handling to store sanitized args back to settings or suppress repeated warnings.
- Ensure behaviour is covered by tests.
- Update investigation doc with resolution.

**Return**
- Return file updates.
- Return tests executed (unit/integration as relevant).
- Return manual steps to verify warnings no longer repeat.

**Feedback**
Raise new tickets if additional warning sources are discovered.

**Acceptance criteria**
- Codex extra-arg warnings no longer spam logs during tests.
- All relevant tests pass.

**Dependencies**: CSH-432

---

## Ticket CSH-434 – Final remediation verification

**Context**
After completing prior tickets, we must confirm everything integrates cleanly.

**Scope**
- Execute `npm run test:unit`, `npm run test:integration`, the new persistence regression test, and `npm run test:all`.
- Update `docs/integration-status-bar-stub-investigation.md` with completion entries for each ticket (PR links, ✅ status).
- Confirm plan doc reflects final state and close outstanding issues.

**Return**
- Return list of commands run with outcomes.
- Return documentation updates.
- Return any manual verification steps taken.

**Feedback**
Open follow-up tickets for any residual observations.

**Acceptance criteria**
- All tests succeed, including regression coverage.
- Documentation lists completed tickets with links.
- No outstanding shim drift issues remain.

**Dependencies**: CSH-421, CSH-422, CSH-423, CSH-424, CSH-425, CSH-426, CSH-427, CSH-428, CSH-429, CSH-430, CSH-431, CSH-432, CSH-433
