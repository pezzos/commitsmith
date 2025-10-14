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
│  ├─ codex.ts                  # API client for commit messages + AI fixes
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
* Append new lines (`addEntry()`).
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

  * Retry with Codex AI fix.
  * If still failing → abort (configurable).
* Collect logs to `OUTPUT > CommitSmith`.

**Key Functions:**

```ts
runPipeline(repo: GitRepository): Promise<void>;
runStep(cmd: string, step: string): Promise<StepResult>;
aiFix(errors: StepResult, repo: GitRepository): Promise<boolean>;
```

**Settings Integration:**

* `commitSmith.format.command`
* `commitSmith.typecheck.command`
* `commitSmith.tests.command`
* `commitSmith.pipeline.enable`
* `commitSmith.pipeline.maxAiFixAttempts`

---

### 🧠 **3.3 Codex Integration (`codex.ts`)**

**Purpose:**
Communicate with Codex for:

* Commit message generation (from journal)
* AI Fixes (lint/type/test errors)

**Endpoints:**

* `POST /commit` → Generate commit message
* `POST /fix` → Generate patch for failed step

**Prompt Example (Commit):**

```json
{
  "system": "You are an expert Git commit writer. Generate a concise, conventional commit message.",
  "user": {
    "journal": {
      "current": [
        "feat: expose orchestrator guard",
        "refactor: split job runner in 3 modules"
      ],
      "meta": { "ticket": "T1335", "scope": "jobs-service" }
    }
  }
}
```

**Prompt Example (Fix):**

```json
{
  "system": "Fix lint/type/test issues in the provided file with minimal safe edits.",
  "user": {
    "file": "src/utils/queue.ts",
    "error": "'Queue' is possibly 'undefined'.ts(2532)",
    "code": "<file content here>"
  }
}
```

**Functions:**

```ts
generateCommitMessage(journal: JournalData): Promise<string>;
generateFix(errorData: FixContext): Promise<Patch>;
```

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
| `commitSmith.pipeline.maxAiFixAttempts` | number  | `2`                       | Retry limit            |
| `commitSmith.commit.pushAfter`          | boolean | `false`                   | Auto-push after commit |
| `commitSmith.message.style`             | string  | `"conventional"`          | Message format         |
| `commitSmith.message.enforce72`         | boolean | `true`                    | 72-char limit          |
| `commitSmith.jira.fromBranch`           | boolean | `true`                    | Detect ticket          |
| `commitSmith.codex.model`               | string  | `"codex:commit-writer"`   | Model name             |
| `commitSmith.codex.endpoint`            | string  | `"http://localhost:9999"` | Codex API URL          |

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
