# SPEC: Commit Journal Integration via Codex Run Notifications

## Purpose
Ensure **every Codex run** (success, failure, or abort) automatically generates or updates a corresponding **entry in the Commit Journal**.

No run should complete without leaving a traceable, structured record in `.ai-commit-journal.yml` or its rendered view.  
Codex may voluntarily post its own summary, but the orchestrator guarantees a fallback within seconds.

---

## Goals

| Goal | Description |
|------|--------------|
| 1 | Guarantee one journal entry per Codex run |
| 2 | Support both cooperative (Codex posts) and fallback (orchestrator synthesis) modes |
| 3 | Avoid duplicates via `runId`-based upsert |
| 4 | Capture essential metadata: repo, branch, ticketId, verdict, duration, results |
| 5 | Maintain consistent human-readable summaries |

---

## Architecture Overview

```

Codex Run → RunCompleted Event → JournalWriter → Commit Journal Entry
↳ (timeout) → Fallback Synthesizer

````

**Timeline (default settings)**

```
t0      RunCoordinator publishes `run:completed`
        ├─ Other post-run hooks (artifact uploads, alerts) execute immediately
        └─ JournalWriter arms grace timer (default 5s; configurable via
           `journalWriter.cooperativeGracePeriodMs` / `COMMITSMITH_JOURNAL_GRACE_MS`,
           recommended 3–10 s depending on Codex exit latency)

t0+Δ    Codex calls `journal.post` → JournalWriter upserts via CLI, emits
        `journal:write:ack`, cancels timer (prevents fallback double-write)

t0+5s   (if no ack) JournalWriter invokes fallback synthesizer and writes via CLI
```

> **Implementation guardrail:** JournalWriter MUST continue to append through the CommitSmith CLI  
> (`commit-smith journal --append ...` or `node ./bin/commit-smith.js journal --append ...`).  
> We never write `.ai-commit-journal.yml` directly so that sandbox cache configuration, CLI
> authentication (`codex login`), and telemetry hooks remain intact.

Two complementary flows:

1. **Cooperative Mode (Preferred)**  
   Codex posts its run summary directly using the `journal.post` hook at the end of execution.

2. **Fallback Mode (Guaranteed)**  
   If Codex fails to post within 5 seconds after the `run:completed` event,  
   the orchestrator auto-generates a summary from logs, metadata, and pipeline results.

**Event flow & timeout control**

* The RunCoordinator emits `run:completed` once Codex transitions to a terminal state and before any
  repo cleanup runs. JournalWriter subscribes to the same event bus as other post-run hooks; it
  reacts in parallel without blocking them.
* A non-blocking grace timer (`journalWriter.cooperativeGracePeriodMs`, default `5000`) starts when
  the event is observed. JournalWriter simply waits for a `journal.post` acknowledgement while other
  hooks continue to drain.
* Configure the timeout via `commitSmith.config.yml` or the environment variable
  `COMMITSMITH_JOURNAL_GRACE_MS`. Increase the value for automation-heavy repos or set it to `0` to
  disable the fallback timer (e.g., for long Codex shutdown sequences).
* JournalWriter cancels the timer as soon as a cooperative write is confirmed, so slow Codex exits
  do not stall follow-up automation.

---

## Event Schema: `run:completed`

| Field | Type | Required | Description |
|--------|------|-----------|-------------|
| `runId` | string | ✅ | Unique stable identifier for the Codex run |
| `status` | enum(`success`, `failed`, `aborted`) | ✅ | Final state of the run |
| `startedAt` | ISO8601 | ✅ | Timestamp when the run started |
| `endedAt` | ISO8601 | ✅ | Timestamp when the run ended |
| `repo` | string | ✅ | Repository path or slug |
| `branch` | string | ✅ | Branch name |
| `ticketId` | string | optional | Associated ticket if applicable |
| `changedFiles` | array<string> | optional | List of modified files |
| `ci` | object | optional | Results of sub-pipelines |
| `ci.lint` | `pass` / `fail` | optional | Linter result |
| `ci.typecheck` | `pass` / `fail` | optional | Typecheck result |
| `ci.tests` | object | optional | `{ passed, failed, skipped }` |
| `codex` | object | optional | `{ tool, version, exitCode }` |

---

## Journal Entry Format

Each journal entry must contain a **YAML front-matter** followed by a readable summary.

```markdown
---
runId: "abcd-1234"
ticketId: "ISSUE-421"
repo: "commitsmith"
branch: "feature/journal-sync"
status: "failed"
startedAt: "2025-10-25T22:15:00Z"
endedAt: "2025-10-25T22:15:37Z"
durationSec: 37
changedFiles:
  - src/journal_writer.ts
  - src/orchestrator.ts
metrics:
  lint: pass
  typecheck: fail
  tests:
    passed: 42
    failed: 3
    skipped: 0
nextSteps:
  - Fix missing return in `validateRunResult()`
  - Add regression test for failed typecheck recovery
---

### CommitSmith Run Summary
Codex attempted to finalize the run for `feature/journal-sync` but typecheck validation failed.
Linter passed and most tests succeeded. The orchestrator prevented commit publication
and logged this entry for traceability.

````

---

### Upsert Semantics

* **Detection.** JournalWriter invokes the CLI with `--run-id <runId>` so the tool can surface an
  existing entry before writing. The CLI performs the lookup against `.ai-commit-journal.yml` and
  returns the prior payload when present.
* **Validation.** Requests missing `runId` are rejected with a non-retryable error; JournalWriter
  logs the failure, surfaces a toast/log to the user, and leaves the timer running so fallback can
  produce a compliant payload.
* **Normalization.** The orchestrator ensures core metadata (`runId`, `repo`, `branch`, `durationSec`,
  `metrics`, `changedFiles`) matches the `run:completed` envelope. Cooperative payloads that omit or
  mis-shape those fields are merged with the canonical values before the CLI write.
* **Merge strategy.** Cooperative Codex payloads are treated as the source of truth for
  human-authored fields (`title`, `summary`, `nextSteps`). The orchestrator merges in structured
  metadata (duration, CI metrics, changed files) if they are missing or stale.
* **Partial posts.** When Codex omits optional fields (e.g., no `nextSteps`), JournalWriter asks the
  CLI to upsert only the missing keys, preserving whatever Codex supplied and backfilling metadata
  from the event envelope.
* **Retries.** Replays with the same `runId` remain idempotent. If fallback wrote first and Codex
  later posts cooperatively, the cooperative payload overwrites human-facing text and merges metrics.
  If Codex posted partially and retries with richer content, only the new fields are merged. Fallback
  never overwrites a human-authored field unless that field is blank.
* **Conflict resolution.** If both flows provide a value for the same human-facing field, the
  cooperative payload wins; fallback data is appended as auxiliary metadata or dropped entirely.

**Examples**

*Fallback first, cooperative later*

```diff
# Fallback write
---
runId: "r-123"
title: "Record Codex run outcome"
status: "failed"
summary: "Codex did not publish a summary..."
nextSteps:
  - "Review logs for run r-123 and rerun Codex if needed."
---

# Cooperative overwrite
---
runId: "r-123"
title: "Fix failing typecheck"
status: "failed"
summary: "Typecheck errored in src/foo.ts."
nextSteps:
  - "Update FooProps to include bar."
durationSec: 67
metrics:
  typecheck: fail
---
```

Result: cooperative `title`, `summary`, and `nextSteps` replace fallback text; duration/metrics merge
from orchestrator metadata.

*Cooperative partial payload, retry adds details*

```diff
# Initial post
---
runId: "r-456"
title: "Ship telemetry tweak"
status: "success"
summary: ""
nextSteps: []
---

# Retry with more detail
---
runId: "r-456"
summary: "Updated telemetry dispatch to batch events."
metrics:
  tests:
    passed: 128
    failed: 0
    skipped: 4
---
```

Result: summary field updates, metrics merge in, and empty `nextSteps` remain untouched.

---

## JournalWriter Logic

**Responsibility:** maintain consistency between Codex runs and Commit Journal.

1. Listen for `run:completed` events.
2. Start the asynchronous grace timer (default **5 seconds**, configurable via
   `journalWriter.cooperativeGracePeriodMs`) while watching for a cooperative `journal.post`
   acknowledgement.
3. If no entry is confirmed before the timer elapses, invoke the fallback synthesizer and write via
   the CLI path above.
4. Upsert based on `runId` (idempotent write).
5. Emit toast “Journal updated” + link to entry (or log equivalent for headless runs).
6. Publish a `journal:write:ack` event so other automation can cancel their own fallbacks.
7. Route every write through `commit-smith journal --append` (or the bundled script) and surface CLI
   failures as non-blocking alerts (toast + structured log). Failed writes enter the retry queue while
   fallback safety nets remain armed.
8. Serialize CLI invocations through a single-flight mutex so only one append command runs at a time;
   subsequent runs wait for the current attempt to finish before issuing their own write.

JournalWriter never mutates `.ai-commit-journal.yml` directly; the CLI preserves sandbox cache
behavior and respects the existing authentication contract. Runs continue even when the CLI reports
errors—the retry queue and fallback synthesizer keep the journal from drifting.

**Retry queue policy**

* Attempts: max 3 per `runId` (initial + two retries). We back off at 5 s, 30 s, and 5 m.
* Failure telemetry: each attempt records `journalWriteFailed=true` with the attempt number.
* Drop to manual: after the final retry, we emit `journal:write:failed` with `retryable=false`,
  escalate to the operator channel, and leave the fallback timer armed so the templated entry still
  lands.
* Clearing the queue automatically cancels older retries once a cooperative success arrives—any
  `journal:write:ack` with `{ status: "ok" }` for a given `runId` drops outstanding retries for that
  `runId` so stale writes never fire.

---

## Fallback Synthesizer (Orchestrator)

If Codex is silent:

* Generate title: *6–10 words, imperative mood.*
* Extract key stats from pipelines and logs.
* Produce:

  * verdict (success/failed/aborted)
  * 3–6 concise bullets (changes + key results)
  * 1–3 actionable next steps if not success.
* Render YAML + Markdown block identical to Codex format.

**Data hygiene**

* Run harvested logs through `SecretMasker` (API keys, tokens, email addresses) and normalize paths
  with `pathRedactor` so only repo-relative segments remain before assembling the prompt.
* Strip ANSI color, redact home directories, and elide files outside `writable_roots`; truncate any
  residual blob that still contains potential secrets.

**Prompt management**

* Cap the prompt to ~2,000 tokens, preferring the newest log lines. When oversized, drop verbose
  step output and keep metadata sections first.

**Failure handling**

* If the LLM call fails or times out, fall back to a deterministic template:

  ```
  ---
  runId: "<id>"
  title: "Record Codex run outcome"
  status: "<status>"
  repo: "<repo>"
  branch: "<branch>"
  summary: "Codex did not publish a summary. Refer to orchestration logs."
  nextSteps:
    - "Review logs for run <id> and rerun Codex if needed."
  ---
  ```

* Emit `journal:fallback:failed` telemetry and surface the template result so the CLI remains
  idempotent.

**Experiment matrix**

| Scenario | Expectation | Validation |
|----------|-------------|------------|
| Cooperative success | Codex payload arrives within grace window | Timer cancels, no fallback write |
| Hard crash | No Codex post, logs available | Fallback synthesizer produces summary, telemetry marks `fallbackInvoked=true` |
| Network outage | CLI call to LLM fails | Deterministic template written, follow-up alert emitted |
| CLI failure | CLI append returns non-zero | Template retained, `journalWriteFailed=true`, retry queued, user notified |

Prompt template:

```text
System:
Summarize a CI/automation run for a human reader.

User (logs + metadata attached):
Produce:
- title: 6–10 words, imperative
- verdict: success|failed|aborted
- 3–6 bullets (changes, results)
- nextSteps: 1–3 actionable items if not success

Output YAML + Markdown summary. No fluff.
```

---

## Codex Hook (`journal.post`)

Codex must call this endpoint after each run:

```json
{
  "runId": "abcd-1234",
  "title": "Refactor Commit Journal writer",
  "status": "success",
  "ticketId": "JIRA-789",
  "repo": "commitsmith",
  "branch": "main",
  "durationSec": 42,
  "changedFiles": ["src/journal_writer.ts"],
  "metrics": {
    "lint": "pass",
    "typecheck": "pass",
    "tests": { "passed": 50, "failed": 0, "skipped": 0 }
  },
  "nextSteps": []
}
```

If Codex fails or crashes, fallback ensures coverage.

**Field defaults**

| Field | Default when omitted | Notes |
|-------|----------------------|-------|
| `ticketId` | `null` | Not persisted if missing |
| `summary` | `""` | Populated by fallback if empty |
| `nextSteps` | `[]` | JournalWriter keeps array empty for successes |
| `changedFiles` | `[]` | Filled from `run:completed.changedFiles` |
| `metrics` | `{}` | Populated with available CI results |
| `metrics.tests` | `{ passed: 0, failed: 0, skipped: 0 }` | Only when parent present |
| `durationSec` | derived from `endedAt - startedAt` | Rounded to nearest second |

**Contract notes**

* `title`, `status`, and `runId` are required. `nextSteps`, `summary`, `changedFiles`, `metrics`, and
  `ticketId` are optional; JournalWriter defaults them to empty arrays/objects (or omits them) and
  backfills metadata from the `run:completed` payload when Codex omits values.
* The hook returns `202 Accepted` with `{ "accepted": true, "ackId": "<uuid>" }` immediately after
  the CLI append is enqueued. A separate `journal:write:ack` event (containing the same `ackId`) is
  published when the CLI reports success (`{ status: "ok", runId, ackId }`), allowing the orchestrator
  to cancel fallback timers. When the CLI fails, we emit `{ status: "failed", runId, ackId, error,
  retryable }` instead; `retryable=true` keeps the fallback armed and schedules the retry queue,
  while `retryable=false` signals manual intervention.
* For non-interactive runs (CI, pre-commit hooks, headless terminals), Codex writes
  `Journal updated → .ai-commit-journal.yml#<runId>` to stdout instead of triggering a toast. Users
  can discover the entry via `commit-smith journal --show --run-id <runId>` if they need to inspect
  it manually.

---

## Acceptance Criteria

1. Every Codex run generates **exactly one journal entry**.
2. Entry contains `runId`, `repo`, `branch`, `status`, `duration`, and `changedFiles`.
3. Interactive runs show a “Journal updated” toast within **≤2 seconds**; headless/non-interactive
   runs log an equivalent message (including the `runId`) in the same window.
4. Duplicates are merged via `runId`.
5. Failures show 1–3 actionable next steps.
6. If Codex crashes, the orchestrator still writes a valid summary.
7. Duplicate `runId` submissions remain idempotent, regardless of cooperative or fallback order.
8. Telemetry records `fallbackInvoked` and `journalWriteFailed` booleans for observability.
9. Legacy workflows (feature flag disabled) proceed unchanged—no journal writes or new notifications.

**Regression checklist**

* Cooperative success: Codex posts, timer cancels, ack observed.
* Fallback success: Codex silent, synthesizer writes, telemetry marks fallback.
* CLI failure: CLI append fails, deterministic template logged, alert raised, retry queued.
* Headless run: toast suppressed, log line emitted, automation parses `runId`.
* Feature flag disabled: no journal writes occur, legacy workflow untouched.

---

## Future Enhancements

* Append structured `diffStats` (added/removed lines)
* Generate daily/weekly summaries from journal entries
* Add search and filters in CommitSmith UI
* Optionally push summaries to external services (Slack, Notion, etc.)

---

## Rollout Plan

1. Gate delivery behind the `codexJournalNotifications` feature flag (orchestrator + Codex client),
   default-off in production.
2. Provide a dry-run mode (`journalWriter.dryRun=true`) that logs payloads without writing so
   automation-heavy repos can validate integrations safely.
3. Run a per-repo smoke checklist before enabling the flag: cooperative success, fallback success,
   CLI-failure simulation, notification (toast/log) verification, and telemetry assertions
   (`fallbackInvoked`, `journalWriteFailed`).
4. Rollback plan: flip the feature flag off, clear the retry queue, and emit a status update on the
   dashboards if journal writes start failing in production.
5. Timeline guidance: Week 1 enable dry-run in staging and monitor DataHub › CommitSmith › Codex Runtime
   plus Artefacts dashboards for noise; Week 2 allow limited production (one repo, guarded lane);
   Week 3 evaluate metrics and, if green, promote to general availability. Any regression resets the
   timeline and reverts to dry-run.

During rollout and after GA, watch the Fast Lane dashboard for `fallbackInvoked`/`journalWriteFailed`
spikes. Promotion/rollback decisions require 24 h of clean telemetry and no open incidents.

---

**Status:** Draft v1.0
**Owner:** CommitSmith Product / Orchestrator team
**Author:** Pezzos (Alexandre Pezzotta)
**Last Updated:** 2025-10-26
