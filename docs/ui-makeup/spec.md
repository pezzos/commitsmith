Perfect. Below is a **complete, Codex-ready technical specification** for the **CommitSmith UI Refactor Project** — structured as a formal `SPEC.md` you can drop straight into your repo. It’s detailed enough for Codex to scaffold the project step by step (views, commands, webview provider, and incremental delivery).

---

# 🧩 CommitSmith UI Refactor — Full Technical Specification

## 1. Overview

**CommitSmith** is a VS Code extension that automates clean commits with integrated formatting, linting, type checks, tests, and intelligent commit messages powered by Codex.

This refactor introduces a **dedicated UI panel** within VS Code, replacing the single “all-in-one” button with a modular interface that exposes every step of the commit pipeline. It also adds a **manual note field** for developers to append contextual comments directly into the Codex journal, without touching raw files.

---

## 2. Goals

| Goal                      | Description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| Modular pipeline controls | Separate buttons for each stage (Format, Lint, Typecheck, Tests, Review, Commit). |
| Transparency              | Live status and logs for each operation, visible inside the panel.                |
| Manual input              | Add a secure text field to append notes to the Codex journal.                     |
| Feedback consistency      | Single status bar + single toast per action (no duplicates).                      |
| Publish-ready UI          | Clean, self-contained, responsive, accessible.                                    |

---

## 3. Functional Requirements

### 3.1 Core Features

1. **Dedicated Sidebar Panel**

   * Appears under VS Code “Source Control” activity bar.
   * Name: **CommitSmith**
   * Icon: `/media/icon.svg`

2. **Modular Action Buttons**

   * Each pipeline step (Format, Lint, Typecheck, Tests, Review Codex, Commit & Push) has its own button.
   * Each button reports live status and exposes logs in a collapsible section.

3. **Manual Note Entry**

   * Editable text field to append developer notes.
   * Adds a `[manual-entry]` entry in the Codex journal automatically (no file edit).
   * Optionally merges the note into the next commit message draft.

4. **Commit Message & Push**

   * Displays the current draft commit message (from Codex or fallback).
   * Allows editing.
   * “Commit & Push” button disabled until all checks pass and message is valid.
   * Optional “Push after commit” checkbox.

5. **Unified Feedback**

   * One status bar entry summarizing state (idle, running, success, error).
   * One toast notification per action (no duplicates).

---

### 3.2 Non-Functional Requirements

| Category      | Requirement                                                      |
| ------------- | ---------------------------------------------------------------- |
| Performance   | Updates should appear <500ms after command execution.            |
| Accessibility | Keyboard navigation, ARIA labels, focus order respected.         |
| Persistency   | Collapsed state, notes, and last commit message survive reloads. |
| Reliability   | No uncaught errors; no file corruption on concurrent runs.       |
| Compatibility | Works with VS Code ≥ 1.90 and CommitSmith orchestrator v2.0+.    |

---

## 4. Architecture

### 4.1 Components

| Component                 | Responsibility                                      |
| ------------------------- | --------------------------------------------------- |
| `CommitSmithViewProvider` | Main `WebviewViewProvider` rendering the panel UI.  |
| `CommitSmithOrchestrator` | Facade connecting UI actions to pipeline commands.  |
| `CommitSmithJournal`      | API for reading/writing structured journal entries. |
| `CommitSmithNotifier`     | Centralized notification + status bar manager.      |
| `CommitSmithUIBridge`     | Message channel between webview and extension.      |

---

### 4.2 Message Protocol (Webview ⇄ Extension)

#### Outbound (UI → Extension)

```json
{
  "type": "RUN_STEP",
  "payload": { "step": "format" | "lint" | "typecheck" | "tests" | "codexReview" }
}
```

```json
{
  "type": "ADD_MANUAL_NOTE",
  "payload": { "text": "string" }
}
```

```json
{
  "type": "COMMIT_AND_PUSH",
  "payload": { "message": "string", "push": true }
}
```

#### Inbound (Extension → UI)

```json
{
  "type": "STEP_STATUS",
  "payload": {
    "step": "format" | "lint" | "typecheck" | "tests" | "codexReview",
    "status": "idle" | "running" | "success" | "error",
    "startedAt": "ISO-8601",
    "endedAt": "ISO-8601|null"
  }
}
```

```json
{
  "type": "APPEND_LOG",
  "payload": { "step": "format|...", "lines": ["string", "..."] }
}
```

```json
{
  "type": "JOURNAL_SNAPSHOT",
  "payload": {
    "entries": [
      { "ts": "ISO-8601", "source": "codex|pipeline|manual", "text": "string" }
    ]
  }
}
```

```json
{
  "type": "COMMIT_BUFFER",
  "payload": { "draft": "string" }
}
```

---

## 5. UI Layout

### 5.1 Visual Structure

| Section          | Contents                                              | Behavior                                                                                                  |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Checks**       | Buttons: Format, Lint, Typecheck, Tests, Review Codex | Show colored chips (gray idle, blue running, green success, red error). Expandable log below each button. |
| **Journal**      | Read-only list of recent entries                      | Displays timestamp + source badge + text. “Copy all” optional.                                            |
| **Manual Entry** | Text field + “Add Note” button                        | Validates non-empty input; posts to journal with `[manual-entry]`.                                        |
| **Commit**       | Message editor + “Commit & Push” button               | Disabled until checks OK. One toast and status bar update per action.                                     |

---

### 5.2 Status Bar Behavior

| State   | Example text                       |
| ------- | ---------------------------------- |
| Idle    | `CommitSmith: Ready`               |
| Running | `CommitSmith: Running tests…`      |
| Success | `CommitSmith: ✅ All checks passed` |
| Error   | `CommitSmith: ❌ Lint failed`       |

---

## 6. Commands (VS Code contribution)

### 6.1 Package.json

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "commitSmith.container", "title": "CommitSmith", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "commitSmith.container": [
        { "id": "commitSmith.panel", "name": "CommitSmith Panel" }
      ]
    },
    "commands": [
      { "command": "commitSmith.openPanel", "title": "CommitSmith: Open Panel" },
      { "command": "commitSmith.runFormat", "title": "CommitSmith: Run Formatter" },
      { "command": "commitSmith.runLint", "title": "CommitSmith: Run Linter" },
      { "command": "commitSmith.runTypecheck", "title": "CommitSmith: Run Typecheck" },
      { "command": "commitSmith.runTests", "title": "CommitSmith: Run Tests" },
      { "command": "commitSmith.askCodexReview", "title": "CommitSmith: Ask Codex Review" },
      { "command": "commitSmith.addManualNote", "title": "CommitSmith: Add Manual Note" },
      { "command": "commitSmith.commitAndPush", "title": "CommitSmith: Commit & Push" }
    ]
  }
}
```

---

## 7. Incremental Implementation Plan (Slices)

| Slice | Deliverable                                                   | Test Gate                                  |
| ----- | ------------------------------------------------------------- | ------------------------------------------ |
| A     | Panel skeleton (`CommitSmithViewProvider` with static layout) | Renders sections, persists collapsed state |
| B     | Status bar + notification unification                         | Only one toast per action                  |
| C     | Format button (end-to-end with logs)                          | Status + log updates correct               |
| D     | Lint button                                                   | Error disables Commit button               |
| E     | Typecheck button                                              | Long-run logs stream correctly             |
| F     | Tests button                                                  | Failures summarized clearly                |
| G     | Codex Review integration                                      | Adds entry to Journal (`source=codex`)     |
| H     | Journal snapshot + Manual entry                               | Adding note updates instantly              |
| I     | Commit & Push                                                 | Preconditions enforced, clean UX           |
| J     | Packaging                                                     | README, icon, GIF demo, publish-ready      |

Each slice ends with manual testing and potential UI adjustment before moving to the next.

---

## 8. Commit Message Logic

### Input Sources Priority

1. **Codex contract output**

   ```json
   { "message": "string", "confidence": 0.9 }
   ```
2. **Fallback generator** — heuristic summary from `git diff --numstat`
3. **Manual notes** — appended under “Notes:” section

### Validation Rules

* Non-empty, ≤ 300 chars
* Trimmed, one-line Conventional Commit format preferred
* Confidence <0.4 triggers a warning in UI but still editable

---

## 9. Journal Entry Structure

| Field    | Type     | Example                       |           |            |
| -------- | -------- | ----------------------------- | --------- | ---------- |
| `ts`     | ISO 8601 | `"2025-10-25T13:12:43Z"`      |           |            |
| `source` | `"codex" | "pipeline"                    | "manual"` | `"manual"` |
| `text`   | string   | `"Fixed missing type import"` |           |            |

Stored as array inside a `journal.json` managed by the orchestrator. Never manually edited by the user.

---

## 10. Error Handling

| Case                      | Behavior                                          |
| ------------------------- | ------------------------------------------------- |
| Pipeline step fails       | Show red chip, disable commit, append log snippet |
| JSON contract invalid     | Fall back to heuristic message + warning toast    |
| Manual note rejected      | Flash input red + tooltip reason                  |
| Network/Codex unavailable | Display offline banner, allow local fallback      |

---

## 11. Telemetry (optional)

Tracked (no code content):

* Step start / finish (timing)
* Manual note added
* Commit attempt / success / failure

Configurable opt-in through `commitSmith.telemetry.enabled`.

---

## 12. Future Extensions (Out of Scope for this iteration)

* Diff viewer inside panel
* Per-file selective lint/test
* Multi-repo orchestration
* Inline diagnostics integration

---

## 13. Definition of Done

✅ All pipeline actions functional and independent
✅ Journal editable only via panel
✅ Single toast rule enforced
✅ UI state persisted
✅ Packaging passes Marketplace validation
✅ Demo GIF + updated README

---

**End of SPEC**

---

You can name this file `SPEC_UI_REFACTOR.md` in the root of the CommitSmith repository.
Codex will be able to chunk it per slice (`A` through `J`) and start scaffolding commands and the webview in isolation, with a validation checkpoint after each one.
