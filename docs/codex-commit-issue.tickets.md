## Ticket 1 – Audit Legacy Codex Flag Usage

**Context**
Identify every CommitSmith code path that still relies on `--prompt-file` or `--dry-run` when calling the Codex CLI so we can safely rewrite the invocation.

**Scope**
- Inspect commit, fix, diagnostics, and supporting utilities for Codex CLI flag usage.
- Document where `--prompt-file` and `--dry-run` are consumed.
- Propose owner assignments for each area requiring updates.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Inventory of `--prompt-file`/`--dry-run` usage is published at `docs/codex-commit-issue.md#legacy-flag-inventory`, covering all in-repo callers, extension settings, CI scripts, and partner/custom tooling.
- Each inventory entry tags whether the follow-up is a code change or communication-only update and records an accountable owner so downstream work remains tracked.
- No code changes beyond annotations and documentation.

**Dependencies**: None

---

## Ticket 2 – Add Codex CLI Version Guard

**Context**
Before rewriting the invocation flow, the extension must refuse to run with outdated Codex binaries that lack stdin support and provide an actionable error.

**Scope**
- Add a version or handshake probe to `runCodexCli`.
- Emit a targeted “upgrade Codex CLI” error when the requirement is not met.
- Add telemetry for guard hits.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Minimum supported Codex CLI version or handshake signature (e.g., `codex --version >= X.Y.Z` or `stdin-support` capability) is explicitly documented, enforced in code, and communicated to users.
- Guard caches probe results per VS Code session so the binary is probed only once per launch.
- Guard failures emit a clear “upgrade Codex CLI” message and surface in telemetry dashboards/alerts for fast operational visibility.
- Telemetry events capture guard activations using the versioned payload schema.
- Unit tests cover pass/fail paths.

**Dependencies**: Ticket 1

---

## Ticket 3 – Implement Stdin-Based Codex Invocation

**Context**
Replace the current invalid CLI command with the new stdin-driven contract while preserving environment/profile wiring.

**Scope**
- Update `runCodexCli` to stream the JSON prompt via a buffered `stdin.write`, call `stdin.end()`, enforce `stdio: ['pipe','pipe','pipe']`, and surface write errors immediately.
- Ensure existing flags (`--json`, `--sandbox`, `--model`, `--profile`) and env propagation remain intact.
- Update every entrypoint (commit, fix, diagnostics) to use the new helper path and register telemetry adoption flags.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Codex invocation uses the stdin contract, logs stdin write/back-pressure timing metrics, and satisfies the documented child-process behaviour.
- Environment/profile propagation is byte-for-byte identical to the current helper, with a checklist confirming sandbox selection remains unchanged.
- Each entrypoint (commit/fix/diagnostics) emits adoption metrics distinguishing legacy vs new helper usage.

**Dependencies**: Ticket 2

---

## Ticket 4 – Regression Test Suites for Codex Invocation

**Context**
Guarantee the new CLI contract through automated tests and ensure failures no longer fall back silently.

**Scope**
- Add a contract test that swaps in a fake Codex binary (stored under `scripts/fixtures/codex-fake/`) to capture argv, stdin payload, exit handling, and sandbox flags for both read-only and workspace-write modes.
- Add a negative test that simulates stdin write rejection or CLI exits without `codex-cli-commit.v1`, asserting we throw before heuristic fallback.
- Add telemetry assertions confirming journal updates fire on success.
- Build a sandbox-friendly integration harness using the mocked binary to validate both sandboxes.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Mocked Codex fixture under `scripts/fixtures/codex-fake/` passes in both read-only and workspace-write sandboxes during CI.
- Negative paths fail fast without falling back to heuristic messaging.
- Regression coverage asserts exactly one journal emission per successful run and exercises telemetry assertions.

**Dependencies**: Ticket 3

---

## Ticket 5 – Split Commit Workflow into Fast and Guarded Lanes

**Context**
Reduce commit latency while keeping formatter/typecheck/test protections available for teams that need them.

**Scope**
- Update `src/pipeline.ts` to default to the fast lane that skips heavy stages but honours `commitSmith.pipeline.requireChecks`.
- Add UI toggles/quick actions to opt into the guarded lane and trigger individual checks.
- Queue formatter/typecheck/test stages asynchronously, surface last-known status, and offer single-click reruns.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Fast lane is the default, guarded lane is selectable, and both honour existing configuration and pipeline hooks (webhooks, journal updates, custom scripts).
- Async formatter/typecheck/test execution prevents duplicate runs when toggling lanes and documents how stale results remain visible and refreshable.
- Manual commands for checks are clearly surfaced so users retain status visibility.

**Dependencies**: Ticket 3

---

## Ticket 6 – UX Messaging for Workflow Changes

**Context**
Ensure users understand the new fast lane and how to run checks manually without constant reminders.

**Scope**
- Implement a one-time toast explaining skipped checks, including links to `npm run format:fix`, `npm run typecheck`, and `npm run test:all`.
- Store a preference so power users can suppress future reminders.
- Update the preflight summary UI to include manual command guidance.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Toast appears once per user, is backed by UX sign-off artefacts (screenshots or Storybook review), and can be dismissed permanently.
- Manual command links are available in the UI.
- Automated coverage proves the dismissal preference survives reloads and host restarts.

**Dependencies**: Ticket 5

---

## Ticket 7 – Telemetry Enhancements for Workflow and Codex Invocation

**Context**
Measure the impact of the new flow and validate that we maintain success rates while speeding up commits.

**Scope**
- Instrument pre-Codex prep vs Codex exec durations and fast-lane adoption metrics.
- Track Codex invocation counts, artifact upload time, success/error/fallback rates for both legacy and new invocation paths.
- Ensure telemetry updates include journal emission confirmation.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Versioned telemetry payloads carry a schema version, differentiate legacy vs new/shadow invocation paths, and appear side-by-side in documented dashboards prior to rollout.
- Staging verification checklist is scripted, executed, and signed off before production rollout.
- Documentation, including inline updates to AGENTS.md, records metric definitions, dashboard locations, and staging verification steps.

**Dependencies**: Ticket 3

---

## Ticket 8 – Rollout Strategy and Migration Docs

**Context**
Deploy the new invocation safely, communicate changes, and provide guidance for custom scripts.

**Scope**
- Implement the `commitSmith.codex.cliInvocationVersion` gate with shadow mode running legacy and new paths for at least one week.
- Add automated comparisons for success rates, latency, and fallback frequency; prepare rollback checklist.
- Publish a migration note covering the new CLI contract, minimum Codex version, and guidance for custom integrations.
- Draft a communication plan for extension users.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Feature flag controls legacy vs new invocation; shadow mode telemetry is captured and reviewed for at least one week with go/no-go tied to Ticket 7 telemetry parity and a signed rollback checklist before GA.
- Rollout documentation includes a preview → GA timeline, explicit rollback window, and communication plan.
- Migration note includes the new CLI contract, required Codex version, manual steps for scripted `runCodexCli`, and is linked from AGENTS.md and internal documentation.

**Dependencies**: Tickets 3, 4, 7

---

## Ticket 9 – Remove Deprecated Flags and Final Cleanup

**Context**
After rollout, delete unused code paths and ensure dashboards remain accurate.

**Scope**
- Remove `--prompt-file`/`--dry-run` usage and dead code across commit, fix, diagnostics flows once confirmed safe.
- Implement noop git safeguards inside CommitSmith where `--dry-run` behaviour was previously expected.
- Validate telemetry dashboards still receive equivalent signals after workflow changes; adjust queries if needed.

**Return**
- Return the list of files that were updated or created by the implementation.
- Return the list of tests that were run to validate the implementation.
- Return the list of tasks to do to test the implementation and ensure it's complete and correct.

**Feedback**
While implementing the ticket, if you notice that a future ticket needs improvement or a new ticket should be created, please take action.

**Acceptance criteria**
- Flag usage is fully removed after at least two stable production release cycles without regressions.
- Noop git safeguards cover prior use cases and are exercised by regression tests.
- A scheduled dashboard QA review verifies reporting accuracy post-removal, with any required adjustments applied.

**Dependencies**: Tickets 1–8
