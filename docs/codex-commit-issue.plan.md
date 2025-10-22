# Codex Commit Issue – Remediation Plan

## Context
- Experiment 8 proved the Codex CLI works when invoked as `codex exec --json --sandbox <mode> --model <model>` with the prompt streamed on stdin.
- CommitSmith currently calls `codex exec commit … --prompt-file … --dry-run`, so Codex never reads the generated prompt and returns an agent error instead of JSON.
- The commit workflow also chains format/typecheck/test runners before Codex runs, stretching the end-to-end cycle for every commit attempt.

## Objectives
1. Deliver a working Codex commit invocation that returns `codex-cli-commit.v1` payloads in both read-only and workspace-write sandboxes.
2. Guard against regressions by asserting the exact CLI argument vector, stdin behaviour, and failure handling.
3. Refactor the commit workflow into a split-stage pipeline that keeps formatter/typecheck/test runners available as opt-in checks while defaulting to a fast commit path.
4. Instrument the workflow to capture “pre-Codex prep” vs “Codex exec” timing and adoption of the fast lane, so we can quantify speed gains without regressing success rates.

## Action Plan
1. **Command invocation fix**
   - Update `runCodexCli` with a documented child-process contract: send the JSON prompt via a single buffered `stdin.write`, call `stdin.end()` immediately afterward, launch the child with `stdio: ['pipe', 'pipe', 'pipe']`, and surface any write/back-pressure failures right away.
   - Preserve the existing environment/profile propagation (`--json`, `--sandbox`, `--model`, `--profile`, env vars) and add a compatibility guard that checks `codex --version` (or the handshake metadata) so we emit a targeted “upgrade Codex CLI” error whenever the installed binary predates stdin support.
   - Propagate the change across every call site (commit, fix, diagnostics) and capture an adoption matrix; each pathway should emit an interim telemetry flag so we can compare legacy vs new helper usage during rollout.
2. **Regression coverage**
   - Contract suite: swap in a fake Codex binary that captures argv, stdin payload, exit code, and sandbox flag across both read-only and workspace-write modes, confirming the prompt arrives before `stdin.end()` and the child exits cleanly.
   - Negative suite: simulate stdin write rejections or CLI exits that never emit `codex-cli-commit.v1`, ensuring we throw before falling back to heuristic messaging.
   - Add telemetry assertions verifying we still emit the journal update when Codex succeeds.
   - Build an integration harness that runs against the mocked Codex binary in both sandbox configurations, verifying the argv/stdio contract without requiring the real CLI.
   - Record a journal entry summarising the CLI change once merged.
3. **Split-stage workflow**
   - Update `src/pipeline.ts` so the default commit “fast lane” skips formatter/typecheck/test stages while honouring `commitSmith.pipeline.requireChecks`; expose a UI toggle/quick action that locks in the guarded lane for teams that rely on the current behaviour.
   - Keep formatter/typecheck/test runners available as opt-in stages, queue them asynchronously, and surface their last-known status inline in the preflight summary (with single-click reruns and prompts such as `npm run format:fix`, `npm run typecheck`, `npm run test:all` when stale).
   - Introduce a one-time toast explaining the skipped checks, linking the exact commands above, and storing a “don’t remind me” preference so power users avoid repeated prompts.
   - Trim redundant artifact uploads or repeated Codex calls, and capture before/after telemetry on Codex invocation counts and artifact upload time to demonstrate the reduction in redundant work.
4. **Instrumentation & rollout**
   - Instrument the workflow entry/exit points to record pre-Codex prep vs Codex exec durations plus fast-lane adoption, and collect aggregate success/error counts for both invocation paths.
   - Gate both legacy and new invocation paths behind `commitSmith.codex.cliInvocationVersion`, run them side by side for at least one week in shadow mode while comparing success rates, latency, and fallback frequency; maintain a rollback checklist and automated metric before promoting the new path.
   - Publish a communication plan for extension users outlining the staged rollout, rollback steps, and expectations during the shadow period.
   - Expand documentation with a migration note covering the new CLI contract, minimum Codex version, and guidance for custom scripts that call `runCodexCli`.
   - Assign owners to audit diagnostics/fix flows for `--prompt-file` usage, recreate any prior `--dry-run` semantics inside CommitSmith (explicit no-op mode), and document the outcomes before deleting the legacy flags.
   - Notify the Codex tooling owners and document the new invocation syntax in `docs/codex-commit-issue.md` and AGENTS.md.

## Open Questions / Risks
- Owner (diagnostics): Audit every Codex entrypoint (fix, diagnostics, etc.) for `--prompt-file` / `--dry-run` usage, document findings, and sign off before removal.
- Owner (workflow): Recreate any `--dry-run` safety semantics as explicit noop git guards inside CommitSmith and demonstrate parity before we drop the flag.
- Owner (telemetry): Validate dashboards still receive equivalent signals once long-running stages become optional and document any required adjustments.

## Definition of Done
- CommitSmith emits a commit message JSON payload locally and in Serena read-only sandbox.
- Automated tests cover the new command invocation path.
- Documentation reflects the simplified workflow and the corrected CLI syntax.
