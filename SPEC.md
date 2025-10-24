# 🧠 **CommitSmith — SPEC.md**

> *Part of the EpicSmith suite — handcrafted automation tools for modern devs.*

---

## **1. Project Overview**

**CommitSmith** is a VS Code / Cursor extension that automates the entire Git commit flow through AI assistance.
It uses **Codex** as a local AI agent to maintain a structured *AI Commit Journal* of all code modifications and to generate clear, conventional commit messages automatically.

CommitSmith ensures every commit is:

* clean (passes format, typecheck, and tests),
* meaningful (documented by Codex),
* and consistent (enforced message style).

---

## **2. Architecture Overview**

```
commit-smith/
├─ src/
│  ├─ extension.ts              # Activation, command registration, entry point
│  ├─ journal.ts                # Read/write .ai-commit-journal.yml
│  ├─ codex.ts                  # Codex CLI runner for commit messages + AI fixes
│  ├─ pipeline.ts               # Pre-commit sequence (format/type/test)
│  ├─ config.ts                 # Configuration management (VS Code settings)
│  ├─ ui.ts                     # UI bindings (SCM button, notifications)
│  └─ utils/
│     └─ git.ts                 # Wrapper for simple-git (stage/commit/push)
├─ assets/
│  ├─ icon.svg                  # Logo/icon for Marketplace
│  └─ schema/
│     └─ ai-commit-journal.schema.json
├─ package.json
├─ README.md
└─ .ai-commit-journal.yml       # Runtime state file managed by Codex
```

---

## **3. Functional Specifications**

### 🧩 **3.1 Journal Management (`journal.ts`)**

**Purpose:**
Provide read/write access to `.ai-commit-journal.yml`, the single source of truth for Codex-generated change logs.

**Format:**

```yaml
current:
  - feat: add orchestrator guard
  - refactor: split job runner in 3 modules
meta:
  ticketFromBranch: true
  scope: jobs-service
  style: conventional
```

**Behaviors:**

* Read existing YAML file, parse entries.
* Expose CLI helper so Codex can append entries (`addEntry()`), while the extension itself never writes to the journal.
* Clear `current` after successful commit (`clearCurrent()`).
* Auto-create file if missing (`initializeJournal()`).
* Validate format via JSON Schema (`assets/schema/ai-commit-journal.schema.json`).

**APIs:**

```ts
readJournal(): Promise<JournalData>;
addEntry(text: string): Promise<void>;
clearCurrent(): Promise<void>;
initializeJournal(): Promise<void>;
```

---

### ⚙️ **3.2 Pre-commit Pipeline (`pipeline.ts`)**

**Purpose:**
Run configurable pre-commit tasks and optionally trigger AI-based code fixes.

**Pipeline order:**

1. **Format** → `npm run format:fix`
2. **Typecheck** → `npm run typecheck`
3. **Tests** → `npm test -- -w`

**Behavior:**

* Execute commands using `execa`.
* Detect modified files → auto-stage (`simple-git`).
* If a command fails:

  * Retry with Codex AI fix up to `commitSmith.pipeline.maxAiFixAttempts`, re-running the step after each applied patch.
  * If still failing and `commitSmith.pipeline.abortOnFailure === true`, halt the pipeline with no commit.
  * If still failing and `abortOnFailure === false`, open a modal offering:
    1. **Commit anyway** — skip remaining steps, annotate the commit body with `[pipeline failed at <step>: see OUTPUT > CommitSmith]`, and suppress auto-push even when enabled.
    2. **Retry step (no AI)** — run the command once more without Codex assistance; show the modal again if it still fails.
    3. **Abort** — exit the pipeline without committing.
* Collect logs to `OUTPUT > CommitSmith`, and continue to subsequent steps once a failing step eventually passes.

**Key Functions:**

```ts
runPipeline(repo: GitRepository): Promise<void>;
runStep(cmd: string, step: string): Promise<StepResult>;
aiFix(errors: StepResult, repo: GitRepository): Promise<boolean>;
```

* Parse command output to populate `errors` for failed steps (see type definitions in §3.8).
* Provide each `FixContext` to Codex; expect scoped `AIPatch` unified diffs, validate with `git apply --check`, apply eligible patches, and restage only affected files.
* Respect `.commit-smith-ignore` when evaluating candidate files, and skip any patch that cannot be applied cleanly.

**Settings Integration:**

* `commitSmith.format.command`
* `commitSmith.typecheck.command`
* `commitSmith.tests.command`
* `commitSmith.pipeline.enable`
* `commitSmith.pipeline.maxAiFixAttempts`
* `commitSmith.pipeline.abortOnFailure`

---

### 🧠 **3.3 Codex Integration (`codex.ts`)**

**Purpose:**  
Interact with the Codex CLI (`codex exec`) to generate commit messages and AI fixes. The CLI streams JSONL events; CommitSmith aggregates reasoning logs, validates schema-compliant results, and records artefacts under `.commit-smith/patches/<timestamp>/cli/`.

**Execution flow:**

1. Build prompts via `src/codexCli/prompts.ts`, embedding schema identifiers (`codex-cli-commit.v1`, `codex-cli-fix.v1`).
2. Spawn `codex exec <operation> --json --sandbox workspace --model <model> [extraArgs...]`.
3. Stream JSONL events from `stdout`, logging reasoning once per message.
4. Collect the terminal `result` event, parse against the JSON schema (Ajv), and emit validation errors through `CodexPromptValidationError`.
5. Persist prompt text, raw events, parsed result, and schema metadata alongside dry-run artefacts for auditability.

**Functions:**

```ts
generateCommitMessage(journal: JournalData, options?: CodexExecutionOptions): Promise<string>;
generateFix(errorData: FixContext, options?: CodexExecutionOptions): Promise<AIPatch>;
```

* Fix responses must satisfy the unified diff contract in §3.8.
* Validation failures and CLI errors trigger the offline fallback event emitter.
* Optional `CodexExecutionOptions.recordArtifact` captures CLI artefacts (used by dry run).

---

### 🔧 **3.4 Configuration (`config.ts`)**

**Purpose:**
Expose and load user-defined settings from VS Code configuration.

**Available settings:**

| Key                                     | Type    | Default                   | Description            |
| --------------------------------------- | ------- | ------------------------- | ---------------------- |
| `commitSmith.format.command`            | string  | `"npm run format:fix"`    | Format command         |
| `commitSmith.typecheck.command`         | string  | `"npm run typecheck"`     | Typecheck command      |
| `commitSmith.tests.command`             | string  | `"npm test -- -w"`        | Test command           |
| `commitSmith.pipeline.enable`           | boolean | `true`                    | Enable pipeline        |
| `commitSmith.pipeline.requireChecks`    | boolean | `false`                   | Force formatter/typecheck/test before commits |
| `commitSmith.pipeline.maxAiFixAttempts` | number  | `2`                       | Retry limit            |
| `commitSmith.commit.pushAfter`          | boolean | `false`                   | Auto-push after commit |
| `commitSmith.message.style`             | string  | `"conventional"`          | Message format         |
| `commitSmith.message.enforce72`         | boolean | `true`                    | 72-char limit          |
| `commitSmith.jira.fromBranch`           | boolean | `true`                    | Detect ticket          |
| `commitSmith.codex.model`               | string  | `"gpt-5-codex"`           | Model name             |
| `commitSmith.codex.binaryPath`          | string  | `""`                      | Optional CLI path override |
| `commitSmith.codex.extraArgs`           | string  | `""`                      | Extra CLI flags (space-separated) |
| `commitSmith.pipeline.abortOnFailure`   | boolean | `true`                    | Abort pipeline on failure |

**Codex CLI requirements:** install the Codex CLI (see [docs.cursor.com/codex-cli/install](https://docs.cursor.com/codex-cli/install)), authenticate with `codex login`, and ensure the binary is available on `PATH` (or set `commitSmith.codex.binaryPath`). Use `commitSmith.codex.extraArgs` for environment-specific flags such as `--profile`.

**API:**

```ts
getConfig(): CommitSmithConfig;
```

---

### 💬 **3.5 UI Layer (`ui.ts`)**

**Purpose:**
Bridge between user and logic — expose commands, register UI, display messages.

**Components:**

* SCM title button: `AI Commit (Journal)`
* Output Channel: `CommitSmith`
* Notifications: `vscode.window.showInformationMessage`
* Status bar lane toggle + check summary (`Fast lane` / `Guarded lane`, formatter/typecheck/test icons)

**Commands:**

| Command ID                        | Action                                    |
| --------------------------------- | ----------------------------------------- |
| `commitSmith.generateFromJournal` | Read journal, call Codex, fill commit box |
| `commitSmith.clearJournal`        | Clear `current` entries                   |
| `commitSmith.installHooks`        | Create `.git/hooks/pre-commit`            |
| `commitSmith.dryRun`              | Preview AI fixes as patches               |

**SCM Integration:**

```json
{
  "contributes": {
    "menus": {
      "scm/title": [
        {
          "command": "commitSmith.generateFromJournal",
          "group": "navigation@1",
          "when": "scmProvider == git"
        }
      ]
    }
  }
}
```

---

### 🔨 **3.6 Git Utilities (`utils/git.ts`)**

**Purpose:**
Simplify Git operations for staging and committing.

**Features:**

* Get active repository
* Stage modified files
* Commit message injection
* Optional push

**API:**

```ts
getRepo(): GitRepository;
stageModified(repo: GitRepository): Promise<void>;
commit(repo: GitRepository, message: string): Promise<void>;
push(repo: GitRepository): Promise<void>;
```

---

### 🧪 **3.7 Dry-run & Ignore Rules**

**Dry Run (`commitSmith.dryRun`):**

* Simulate the full pipeline while leaving the working tree untouched.
* Skip mutating commands (e.g., use `--check` variants where possible) yet still capture diagnostics.
* Request Codex patches on failures but never apply them; instead, export them to `.commit-smith/patches/<ISO-timestamp>/<relative-path>.patch`.
* Emit a `summary.json` file in the same directory describing attempted steps, patch statuses, and aggregated logs.
* Generate the commit message from the journal but leave `repo.inputBox` empty; write the result to `COMMIT_MESSAGE.md` within the patch folder.
* Preserve git state entirely—no `git add`, `git commit`, or journal clearing—while surfacing results in `OUTPUT > CommitSmith` and a “Dry run completed (no changes applied)” notification.

**Ignore File (`.commit-smith-ignore`):**

* Plain-text glob patterns (same semantics as `.gitignore`).
* Precedence: `.commit-smith-ignore` → `.gitignore` → internal defaults (e.g., `.ai-commit-journal.yml`, `.commit-smith/**`).
* Ignored paths are excluded from pipeline checks, AI fixes, patch previews, and journaling.

---

### 📦 **3.8 Type Definitions & Patch Handling**

```ts
export type PipelineStep = "format" | "typecheck" | "tests";

export interface FixContext {
  filePath: string;
  errorMessage: string;
  codeSnippet?: string;
}

export interface StepResult {
  step: PipelineStep;
  success: boolean;
  stdout: string;
  stderr: string;
  errors?: FixContext[];
}

export type AIPatch = {
  kind: "unified-diff";
  diff: string;
  meta?: {
    producedBy?: string;
    step?: PipelineStep;
    note?: string;
  };
};
```

* Only `kind: "unified-diff"` patches are supported in the MVP; diffs must be repo-relative with LF endings.
* Before application, run `git apply --check` and verify that every touched file is either staged or explicitly referenced by the failing step (after `.commit-smith-ignore` filtering).
* Apply valid patches with `git apply`, then restage just the affected files (`git add` on the patch paths).
* If a patch fails validation or application, skip it, log the error, and continue to the next patch.

---

## **4. UI & UX**

### **User Flow**

1. Codex automatically appends lines to `.ai-commit-journal.yml`.
2. User opens SCM panel and clicks “AI Commit (Journal)”.
3. CommitSmith runs pipeline:

   * format → typecheck → test → AI fix fallback.
4. On success, Codex generates a commit message.
5. CommitSmith commits and clears the journal.
6. Logs displayed in Output.

---

### **Visual Style**

* Accent color: `#e0b356` (forged copper)
* Icon: ⚒️
* Output panel sectioning:

  ```
  [FORMAT ✅]
  [TYPECHECK ✅]
  [TESTS ✅]
  [AI FIX ⚒️ 1 applied]
  [COMMIT ✅]
  ```
* Tooltip on SCM button: “Forge your commit with AI”.

---

## **5. Non-Functional Requirements**

| Requirement       | Description                                             |
| ----------------- | ------------------------------------------------------- |
| **Compatibility** | VS Code + Cursor compatible                             |
| **OS Support**    | macOS, Linux, Windows                                   |
| **Performance**   | Pipeline ≤ 10s typical                                  |
| **Reliability**   | Never commit if pipeline fails                          |
| **Extensibility** | Future modules: LintSmith, TestSmith                    |
| **Privacy**       | AI prompts contain no source code beyond context needed |
| **Offline Mode**  | Fallback to local heuristic message                     |

**Offline Mode Behavior:**

* Triggered when Codex returns a CLI error, emits malformed JSON, or fails within the internal 60s timeout window.
* Use staged changes to craft `chore: commit updated files [offline mode]` messages with a short file list.
* Derive scope from the first file's folder when available and log a warning in `OUTPUT > CommitSmith`.

---

## **6. Future Enhancements**

* Multi-repo support (multiple workspaces)
* GitLens deep integration
* Codex memory feedback loop (store commit style preferences)
* UI dashboard for recent commits
* Metrics dashboard: average fixes, failed commits, AI saves

---

## **7. Acceptance Criteria**

✅ Codex journal updates automatically.
✅ One-click “AI Commit” performs the full pipeline and generates the message.
✅ Journal cleared post-commit.
✅ Pre-commit tasks can be customized and retried with AI fix.
✅ All settings available in VS Code preferences.
✅ Works on both Cursor and native VS Code.

---

## **8. Deliverables for Codex**

* `package.json` (extension definition)
* `extension.ts` (activation + command wiring)
* Module stubs (`journal.ts`, `pipeline.ts`, `codex.ts`, etc.)
* `README.md` (user guide)
* `ROADMAP.md` (epic + tasks + future milestones)
* `SPEC.md` (this file)

---

## **9. Owner & Context**

**Owner:** EpicSmith (Pezzos & G)
**Agent:** Codex
**Repo:** `github.com/EpicSmith/commit-smith`
**License:** MIT
**Status:** Phase P1 — Architecture Design
**Tagline:** *“Your AI-forged commits.”*

---

🔥 **CommitSmith is where commits are crafted, not guessed.**
