## Ticket 1 – Bootstrap CommitSmith extension workspace

**Context**
Set up the baseline VS Code / Cursor extension project so subsequent feature tickets can focus on functional modules.

**Scope**
- Scaffold the extension file structure (`src/`, `assets/`, `.commit-smith-ignore`, config files) aligned with SPEC.md §2.
- Author `package.json`, `tsconfig.json`, build scripts, and minimal `README.md` describing local development.
- Implement an empty `extension.ts` that activates/deactivates without errors.

**Return**
- Files updated/created
- Tests executed: `npm run compile`, `npm run test:unit`
- Manual validation tasks: load the extension in VS Code’s Extension Development Host to confirm activation succeeds.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Project builds with `npm run compile` and no TypeScript errors.
- Extension activates cleanly in Extension Development Host with a placeholder command.
- Repository structure matches SPEC.md §2 layout.
- `.commit-smith-ignore` exists at the repo root (empty allowed).

**Dependencies**: none

---

## Ticket 2 – Implement configuration management module

**Context**
CommitSmith needs a single source of truth for user settings described in SPEC.md §3.4.

**Scope**
- Create `src/config.ts` defining `CommitSmithConfig` and helpers to read VS Code settings (with defaults, including `codex.timeoutMs`).
- Add lightweight validation/tight typing for enums (e.g., message style).
- Expose change listeners so other modules can react to configuration updates.
- Extend `package.json` with `contributes.configuration` entries (and JSON schema) so settings surface in VS Code preferences.

**Return**
- Files updated/created
- Tests executed: `npm run test:config`
- Manual validation tasks: Use VS Code Settings UI to change a CommitSmith setting and confirm the module returns the updated value via logs.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- `getConfig()` returns fully-populated config with defaults matching SPEC.md §3.4.
- VS Code settings UI shows CommitSmith configuration with correct defaults and descriptions.
- Settings updates propagate via an exported event or callback.
- Module covered with unit tests for defaulting and overrides.

**Dependencies**: Ticket 1

---

## Ticket 3 – Build journal management with CLI entry point

**Context**
The extension must consume `.ai-commit-journal.yml` maintained by the Codex agent and surface a CLI helper for external writes (SPEC.md §3.1).

**Scope**
- Implement `src/journal.ts` with `readJournal`, `clearCurrent`, `initializeJournal`, and CLI-facing `addEntry`.
- Author `assets/schema/ai-commit-journal.schema.json` per SPEC.md §3.1 and enforce validation against it; handle auto-creation when missing.
- Provide a Node CLI command (`npx commit-smith journal --append ...`) by wiring a `bin` entry in `package.json` that invokes `addEntry`.

**Return**
- Files updated/created
- Tests executed: `npm run test:journal`
- Manual validation tasks: Run the CLI to append an entry, then verify `readJournal` reflects it.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Journal read/write operations handle missing file, malformed YAML, and schema validation errors gracefully.
- CLI helper appends entries without activating the VS Code extension runtime.
- Extension clears `current` section only after instructed by later pipeline completion (no auto-appends inside the extension).

**Dependencies**: Tickets 1, 2

---

## Ticket 4 – Implement Git utility wrapper

**Context**
Pipeline operations require consistent Git interactions per SPEC.md §3.6.

**Scope**
- Author `src/utils/git.ts` with helpers to obtain the active repository, stage modified files, commit with a supplied message, and optional push.
- Ensure staging logic supports selective `git add` for provided file paths.
- Surface descriptive errors/logging for missing repository or command failures.

**Return**
- Files updated/created
- Tests executed: `npm run test:git`
- Manual validation tasks: From a test workspace, call the utilities via an integration script to stage and commit dummy changes.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- All exported functions operate against the active VS Code `GitRepository`.
- Stage helper can accept an explicit file list (used by AI patch application).
- Errors propagate with actionable messages logged to the CommitSmith output channel.

**Dependencies**: Tickets 1, 2

---

## Ticket 5 – Integrate Codex API client

**Context**
Codex-backed commit messages and AI fixes require a robust client abstraction (SPEC.md §3.3, §3.8).

**Scope**
- Create `src/codex.ts` with `generateCommitMessage` and `generateFix` returning the `AIPatch` contract.
- Implement HTTP client with timeout support (`commitSmith.codex.timeoutMs`) and graceful error handling that triggers offline fallback signals.
- Log all request/response metadata (excluding sensitive content) to the CommitSmith output channel.

**Return**
- Files updated/created
- Tests executed: `npm run test:codex`
- Manual validation tasks: Run a sample command invoking `generateFix` against a mock server to confirm diff parsing.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Client honors configuration endpoints and model names, respecting timeout and error paths.
- `generateFix` returns `kind: 'unified-diff'` diffs validated for repository-relative paths.
- Offline fallback hook is exposed when requests fail according to SPEC.md §5.

**Dependencies**: Tickets 1, 2

---

## Ticket 6 – Implement pre-commit pipeline engine

**Context**
Run format/type/test commands, invoke AI fixes, and orchestrate error handling per SPEC.md §3.2 and §3.8.

**Scope**
- Build `src/pipeline.ts` orchestrating steps, retries up to `maxAiFixAttempts`, and re-running commands after each applied patch.
- Emit structured callbacks/events for decision points when `abortOnFailure === false`, carrying metadata for UI layers to decide commit/abort, and ensure annotation/autopush suppression logic is exposed for consumers.
- Integrate `.commit-smith-ignore` filtering and selective `git add` using utilities from Ticket 4.

**Return**
- Files updated/created
- Tests executed: `npm run test:pipeline`
- Manual validation tasks: Trigger pipeline in a headless harness to confirm retries, callbacks, and annotations behave as described.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Pipeline executes configured commands sequentially and logs to the CommitSmith output channel.
- AI patch application follows the unified diff contract and respects ignore rules.
- Decision callbacks include all data needed for UI consumers to implement commit/abort prompts, while the core engine exposes no direct VS Code UI dependencies.

**Dependencies**: Tickets 2, 3, 4, 5

---

## Ticket 7 – Surface VS Code commands and UI

**Context**
Expose user-facing controls (SCM button, commands, notifications) leveraging pipeline and journal modules (SPEC.md §3.5, §4).

**Scope**
- Register commands: `commitSmith.generateFromJournal`, `commitSmith.clearJournal`, `commitSmith.installHooks` (expose a guarded stub for `commitSmith.dryRun` that returns a “Coming soon” notification until Ticket 8 wires the engine).
- Bind the SCM title button and connect command flows to journal, pipeline, and git utilities.
- Implement notifications and output logging consistent with the Visual Style guidelines.

**Return**
- Files updated/created
- Tests executed: `npm run test:integration`
- Manual validation tasks: Invoke each command in Extension Development Host; confirm `commitSmith.dryRun` surfaces the temporary “Coming soon” notification.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- SCM button and palette commands operate without throwing exceptions.
- Pipeline-triggering commands properly read the journal, call Codex, and handle commit or abort paths.
- Dry-run command surfaces a guarded notification without invoking the pipeline until Ticket 8 lands.
- Output channel reflects the structured status blocks defined in SPEC.md §4.

**Dependencies**: Tickets 2, 3, 4, 5, 6

---

## Ticket 8 – Deliver dry-run mode and artefact export

**Context**
Simulate the pipeline without mutating the workspace, producing patch previews and summaries (SPEC.md §3.7).

**Scope**
- Extend pipeline command handling to support dry-run execution with non-mutating checks and Codex patch capture.
- Replace the stubbed `commitSmith.dryRun` handler with the full implementation, wiring notifications and output messaging.
- Write dry-run artefacts (`.commit-smith/patches/<ISO-timestamp>/`) including diffs, `summary.json`, and `COMMIT_MESSAGE.md`.

**Return**
- Files updated/created
- Tests executed: `npm run test:dry-run`
- Manual validation tasks: Run the dry-run command on staged changes and verify the generated patches and summary.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Dry-run command leaves git status unchanged and journal untouched.
- Artefact bundle includes patches for each Codex suggestion plus summary metadata.
- User messaging clearly states that no changes were applied and points to the artefact folder.

**Dependencies**: Tickets 6, 7

---

## Ticket 9 – Implement offline fallback commit messaging

**Context**
Provide resilient commit messaging when Codex is unavailable (SPEC.md §5, clarifications).

**Scope**
- Detect Codex failures (network, non-200, timeout) and generate heuristic commit messages with `[offline mode]` suffix.
- Derive scope from the first staged file’s directory and list up to three modified files in the body.
- Ensure fallback messages integrate with pipeline annotations and respect `abortOnFailure` decisions.

**Return**
- Files updated/created
- Tests executed: `npm run test:offline`
- Manual validation tasks: Simulate a Codex timeout and confirm commits use the fallback format with warning logs.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Commit flow proceeds with fallback messaging when Codex is unreachable, and logs a clear `[offline mode]` warning in `OUTPUT > CommitSmith`.
- Journal clearing behavior follows normal rules (cleared only on real commit, preserved in dry-run).
- Auto-push remains disabled when fallback commits result from pipeline failures.

**Dependencies**: Tickets 4, 5, 6, 7

---

## Ticket 10 – First-run initialization command

**Context**
New users often click the CommitSmith commands before the workspace contains the required journal or ignore rules, leading to cryptic failures. Provide a guided initialization flow when a repository is first opened.

**Scope**
- Add an activation-time check that determines whether the repo needs setup (missing `.ai-commit-journal.yml`, `.gitignore` without the ignore rule, missing the exact sentinel heading `## CommitSmith Journal Workflow` (slug `commitsmith-journal-workflow`) in `AGENTS.md`).
- Surface a notification/button and matching command palette entry to trigger initialization, and ensure the prompt reappears only until all setup checks pass.
- Invoke the idempotent helpers to create the empty journal, patch `.gitignore`, and call the AGENTS guidance helper delivered in Ticket 12, logging the command name plus a summary of each step to `OUTPUT > CommitSmith`.

**Return**
- Files updated/created
- Tests executed: targeted unit tests covering initialization status detection (presence of `.ai-commit-journal.yml`, `.gitignore` rule, and the literal sentinel heading `## CommitSmith Journal Workflow` / slug `commitsmith-journal-workflow`) and rerun behavior, plus manual smoke (trigger initializer twice in a fresh repo)
- Manual validation tasks: Open a fresh git repo, trigger initializer, confirm follow-up click skips notification and commands run without errors.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Users receive a clear prompt the first time CommitSmith loads a repo that lacks required files.
- Initialization is idempotent, can be rerun via command palette, and stops prompting once `.ai-commit-journal.yml` exists with `current: []` and `meta: {}`, `.gitignore` contains `.ai-commit-journal.yml`, and `AGENTS.md` includes the literal sentinel heading `## CommitSmith Journal Workflow` (slug `commitsmith-journal-workflow`, added by Ticket 12).
- Initialization summary (including command name and per-step results) is written to the CommitSmith output channel.

**Dependencies**: Tickets 1, 4

---

## Ticket 11 – Idempotent journal + ignore setup

**Context**
CommitSmith relies on `.ai-commit-journal.yml` and `.gitignore` configuration; missing or double-appending entries cause workflow regressions.

**Scope**
- Implement helper logic that ensures `.ai-commit-journal.yml` exists with the exact empty payload `current: []` / `meta: {}` defined in SPEC §3.1, reusing the schema validator from `journal.ts` (Ticket 3) and leaving existing content untouched.
- Update `.gitignore` to include `.ai-commit-journal.yml` only when absent, preserving existing line endings.
- Provide utility functions (exposed via `initializeJournal` / related APIs) that can be invoked from the initializer and other flows without producing duplicate entries.

**Return**
- Files updated/created
- Tests executed: automated tests covering empty journal creation, malformed journal failure cases (error surfaced without overwriting or auto-repair), idempotent re-runs, and `.gitignore` patching (including CRLF preservation)
- Manual validation tasks: Remove the journal file, rerun initializer helper, confirm file recreated and `.gitignore` unchanged when already correct.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Journal initialization writes exactly `current: []` and `meta: {}` when the file is missing and reuses the existing journal JSON-schema validation from SPEC §3.1 to reject malformed payloads with actionable errors (failing fast, surfacing the error, and leaving the file untouched).
- Automated coverage asserts the SPEC §3.1 validation failure path returns an error without mutating the journal on disk, preventing silent rebuilds.
- `.gitignore` is modified only when necessary (no duplicate lines, respects existing line endings, including CRLF).
- Helpers include automated test coverage (including malformed journal failure and CRLF preservation cases) and can be invoked multiple times without modifying the repo once it is in the desired state.

**Dependencies**: Tickets 3 (journal schema validator), 4

---

## Ticket 12 – Document agent responsibilities

**Context**
Agents (Codex/Ops) need clear instructions on updating the journal and running the initializer. `AGENTS.md` currently lacks guidance, causing inconsistent workflows.

**Scope**
- Create `AGENTS.md` if missing, then append a `## CommitSmith Journal Workflow` section explaining the journal lifecycle, the initializer command ID (`commitSmith.initializeRepo`), and the exact `commit-smith journal --append "<entry>"` workflow from BRIEF §4 (including usage example), plus guidance on when to rerun initialization after repo resets.
- Add a lightweight automated guard that proves the AGENTS guidance writer is idempotent so Ticket 10 can invoke it repeatedly without diffs.
- Ensure the section is added exactly once, formatted consistently with existing guidance.

**Return**
- Files updated/created
- Tests executed: automated idempotency test (e.g., snapshot/fixture ensuring a second invocation is a no-op) plus manual verification
- Manual validation tasks: Run initializer twice; confirm `AGENTS.md` section is present once and unchanged on subsequent runs.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- `AGENTS.md` contains an explicit `## CommitSmith Journal Workflow` section covering `.ai-commit-journal.yml`, the initializer command ID (`commitSmith.initializeRepo`), and the `commit-smith journal --append "<entry>"` workflow (with usage example), plus guidance on rerunning initialization after repo resets.
- Running the initializer when the section already exists leaves the file untouched (no duplicate blocks), verified by automated idempotency tests.
- Automated guard proves the writer is idempotent under repeated runs (supporting Ticket 10's repeated invocations).
- Formatting matches the established style in `AGENTS.md`.

**Dependencies**: Tickets 11

---

## Ticket 13 – Update SCM button to hammer icon

**Context**
The SCM button currently displays the full text label “CommitSmith: AI Commit (Journal)”, which is verbose. Design requests replacing it with a compact hammer icon to match the product branding.

**Scope**
- Swap the SCM title button label so it renders only the hammer icon (⚒️), providing a codicon fallback (`codicon-tools`) when the emoji font is unavailable, while keeping the descriptive tooltip/ARIA label “CommitSmith: AI Commit (Journal)”.
- Ensure the command palette entry and hover text continue to describe the action clearly.
- Verify the icon displays correctly across light/dark themes and high-DPI displays.

**Return**
- Files updated/created
- Tests executed: manual verification in the VS Code Extension Development Host plus an automated smoke check ensuring the aria-label remains “CommitSmith: AI Commit (Journal)” when the fallback codicon path is used
- Manual validation tasks: Hover and keyboard-focus the SCM button to confirm tooltip/accessibility, check high-DPI/light/dark themes for proper icon rendering.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- SCM button shows the hammer icon instead of the text label, with a codicon fallback (`codicon-tools`) when the hammer emoji is unavailable.
- Tooltip/ARIA label retains the descriptive action text (“CommitSmith: AI Commit (Journal)”) across both emoji and fallback renderers, validated by automated smoke test.
- Command palette entry remains unchanged.

**Dependencies**: Tickets 7

---

## Ticket 14 – Replace Codex API client with CLI runner

**Context**
CommitSmith currently calls Codex over HTTP (`src/codex.ts`). We are migrating to the Codex CLI (`codex exec`) for all headless usage to align with the CommitSmith Journal workflow.

**Scope**
- Replace the HTTP client in `src/codex.ts` with a CLI-backed runner that shells out to `codex exec` using `--json` output, an appropriate sandbox policy, and a discovery chain for the binary (`commitSmith.codex.binaryPath` VS Code setting → `CODEX_PATH` env var → `codex` on PATH).
- Detect when the CLI binary is missing or exits with “command not found”/auth errors, emit a user-facing message in the CommitSmith output channel with links to install/auth docs, and trigger the same offline fallback signal used today.
- Stream CLI JSONL events, surface reasoning/log messages once in the existing CommitSmith output channel, and translate CLI failures into the current `CodexOfflineFallbackEvent` signals.
- Ensure helper methods still return unified diffs and commit message strings compatible with existing pipeline workflows.

**Return**
- Files updated/created
- Tests executed: focused unit tests for the new CLI runner plus `npm run test:codex`
- Manual validation tasks: run `CommitSmith: AI Commit (Journal)` and trigger a pipeline AI fix in an Extension Development Host with Codex CLI (approval policy `never`) configured

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- `generateCommitMessage` and `generateFix` rely solely on the CLI runner; no HTTP requests remain in `src/codex.ts`.
- CLI event streaming logs appear once in the CommitSmith output channel without spawning duplicate channels.
- Missing/misconfigured CLI detection produces a clearly worded guidance message (including install/auth instructions) and fires `onCodexOfflineFallback` exactly like the HTTP client.

**Dependencies**: None

---

## Ticket 15 – Define Codex CLI schemas and prompt adapters

**Context**
Switching to the CLI requires structured prompts and output schemas so commit messages and diffs match CommitSmith expectations.

**Scope**
- Add versioned JSON schemas under `assets/schema/` (e.g., `codex-cli-commit.v1.schema.json`, `codex-cli-fix.v1.schema.json`) describing CLI output for commit messages and AI fix diffs, with guidance on incrementing the `.vN` suffix when schema shape changes.
- Implement prompt adapter utilities that assemble journal and pipeline context for `codex exec`, returning parsed results that satisfy existing types and persisting prompts/results under `.commit-smith/patches/<timestamp>/cli/` (store prompt text, schema version, raw JSONL, parsed payloads; reuse retention policy already applied to dry-run artefacts).
- Update dry-run artefact generation to persist CLI prompts/results and validation metadata for audit.

**Return**
- Files updated/created
- Tests executed: new unit tests covering schema parsing and prompt adapters, plus `npm run test:dry-run`
- Manual validation tasks: run a dry run and verify `summary.json` reflects CLI-produced data

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Schemas validate CLI output and raise actionable errors (including schema version, offending field) when responses are malformed.
- Prompt adapters become the single entry point for providing journal/pipeline context to Codex CLI and emit telemetry-ready error objects (prompt summary, schema version, validation failure) when validation fails.
- Dry-run artefacts capture prompts, schema version, raw response JSONL, and parsed result in `.commit-smith/patches/<timestamp>/cli/` without regressing existing consumers and respecting existing retention behaviour.

**Dependencies**: Tickets 14

---

## Ticket 16 – Remove Codex API configuration, docs, and tests

**Context**
After the CLI migration, HTTP-specific settings (`codex.endpoint`, `codex.timeoutMs`) and documentation must be retired.

**Scope**
- Update `src/config.ts`, VS Code settings, BRIEF.md, SPEC.md, README.md, AGENTS.md, bootstrap prompts, onboarding tutorials, and any agent guidance to reference the CLI only, including installation/authentication steps and required environment setup.
- Remove unused configuration values, mocks, and tests tied to HTTP fetch behavior and purge all HTTP env var examples (`codexEndpoint`, `codexTimeoutMs`, API URLs/keys) from docs/config samples and onboarding copy.
- Introduce optional CLI configuration (path/extra flags) if needed.

**Return**
- Files updated/created
- Tests executed: `npm run test:config`, `npm run test:unit`
- Manual validation tasks: verify the settings UI in VS Code reflects only CLI-centric options.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- No code or documentation references `codexEndpoint`/`codexTimeoutMs`; CLI usage (installation, auth, configuration) is documented end-to-end across BRIEF/SPEC/README/AGENTS/onboarding.
- Configuration defaults and tests align with CLI invocation.
- Onboarding materials instruct agents to install and authenticate the Codex CLI, and all HTTP env var examples are removed.

**Dependencies**: Tickets 14

---

## Ticket 17 – Update workflows and tests to consume CLI-backed helpers

**Context**
Workflows (`forgeCommit`, `pipeline`, dry run`) and tests currently depend on API-specific helpers.

**Scope**
- Refactor `src/workflows/forgeCommit.ts`, `src/pipeline.ts`, and `src/workflows/dryRun.ts` to use the CLI-backed helpers without changing business logic.
- Provide a shared CLI mock helper for tests that simulates streaming JSONL output, and update test harnesses (`scripts/test-*.mjs`, integration tests) to use it instead of HTTP mocks.
- Confirm pipeline AI fix logging and dry-run patch capture behave identically post-migration.

**Return**
- Files updated/created
- Tests executed: `npm run test:pipeline`, `npm run test:integration`, `npm run test:offline`
- Manual validation tasks: run `CommitSmith: AI Commit (Journal)` end-to-end to confirm pipeline fixes and commit message generation succeed via CLI.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- Workflows operate with CLI-backed helpers and pass existing automated suites.
- Test harnesses validate CLI output handling via the shared JSONL mock, including failure scenarios.
- Streaming logs remain single-threaded/deduplicated across workflows (verified via tests that the output channel receives one sequence per operation), and offline fallback still produces heuristic commit messages when CLI execution fails.

**Dependencies**: Tickets 14, 15

---

## Ticket 18 – Final verification and cleanup of Codex CLI migration

**Context**
Following implementation, we need a final QA pass to ensure the CLI integration is stable and polished.

**Scope**
- Execute a full manual validation pass (initializer, dry run, AI fix, commit) with Codex CLI configured.
- Audit logs and documentation for leftover API references or confusing messaging.
- Prepare changelog/release notes announcing the CLI migration and deprecation of the HTTP API path.
- Remove any TODOs or scaffolding related to the deprecated API and capture outstanding gaps as follow-up tickets.

**Return**
- Files updated/created
- Tests executed: full suite (`npm run compile && npm run test:integration`)
- Manual validation tasks: follow the CommitSmith Journal workflow from bootstrap to commit, documenting findings.

**Feedback**
If a future ticket needs improvement, note it.

**Acceptance criteria**
- CommitSmith end-to-end workflows succeed solely with CLI integration enabled.
- Documentation, logs, and settings are coherent and free of API remnants.
- Changelog/release notes explain the migration/deprecation, and every issue uncovered during validation is recorded (closed or captured as follow-up tickets) before the epic is marked complete.

**Dependencies**: Tickets 14–17

---
