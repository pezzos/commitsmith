Parfait, voici le **Project Brief officiel pour *CommitSmith***, rédigé comme un vrai document produit/open source prêt à filer à Codex 👇

---

# 🧠 **CommitSmith — Project Brief**

> *“Your AI-forged commits.”*
> Part of the **EpicSmith** suite — handcrafted automation tools for modern devs.

---

## **1. Overview**

**CommitSmith** is a VS Code / Cursor extension that transforms the way developers commit code.
It works hand-in-hand with **Codex**, the local AI agent, to maintain a *living journal* of code changes and generate clear, conventional, context-aware commit messages — all while ensuring every commit passes formatting, type checking, and tests.

Forget guessing from diffs — CommitSmith *knows what changed* because Codex keeps track of it in real-time.

---

## **2. Core Vision**

> **Forge commits, not guesses.**

CommitSmith brings discipline and intelligence to your commit workflow.
Instead of reading raw `git diff`, it leverages Codex’s internal context: each time Codex edits code, it appends a concise summary to a shared journal.
When you hit the **AI Commit** button, CommitSmith:

1. Runs pre-commit checks (format → typecheck → tests) following the configured pipeline.
2. Invokes Codex to craft a polished commit message from the change journal.
3. Commits, clears the journal, and optionally pushes.

---

## **3. User Story**

> As a developer using Cursor or VS Code,
> I want to commit my work with a single click,
> and have CommitSmith automatically generate a perfect, useful conventional commit message —
> after making sure my code is formatted, type-safe, and tested.

---

## **4. Core Features**

### 🔨 **AI Commit Journal**

* File: `.ai-commit-journal.yml`
* Maintained automatically by Codex (not the user).
* Captures every meaningful change as short, imperative entries:

  ```yaml
  current:
    - feat: expose queue orchestrator single-worker guard
    - refactor: split job runner in 3 modules
    - test: add e2e restart-on-crash
  meta:
    ticketFromBranch: true
    scope: jobs-service
    style: conventional
  ```
* Codex updates it after each task via the extension-provided CLI helper (CommitSmith never self-appends):

  ```
  commit-smith journal --append "refactor: split job runner into scheduler/worker/utils" --meta scope=jobs-service --meta ticket=T1335
  ```
* CommitSmith reads and clears it upon successful commit.

---

### 💬 **Smart Commit Message Generation**

* Adds a **button to the Source Control (SCM)** panel:

  > `AI Commit (Journal)`
* Reads `current` from the journal + optional metadata.
* Builds a commit message using Codex or GPT-4o, enforcing:

  * ≤72 char subject line
  * Conventional Commit format
  * Optional branch-based ticket prefix (e.g. `T1335:`)
* Fills the commit message box automatically.
* Optionally auto-commits & pushes when confirmed.

---

### ⚙️ **Pre-commit Pipeline**

Runs before message generation, ensuring high-quality commits.

| Step          | Default Command      | Description                                         |
| ------------- | -------------------- | --------------------------------------------------- |
| **Format**    | `npm run format:fix` | Auto-stage fixed files; fallback to AI fix if fails |
| **Typecheck** | `npm run typecheck`  | Abort or AI fix and retry (configurable)            |
| **Tests**     | `npm test -- -w`     | Runs fast test suite; AI fix on failures            |
Note: The commands are configurable.

**Fallback AI Fix**

* Uses Codex to correct only the failing sections from the staged files only.
* Limited diff patching, safe edits only.
* Auto-restages fixed files.
* `StepResult` objects track `stdout`/`stderr` plus parsed `FixContext` entries (file, message, snippet) passed to Codex.
* Codex returns `AIPatch` unified diffs; validate with `git apply --check`, apply only to staged/implicated files (respecting `.commit-smith-ignore`), and restage affected paths.
* If a step keeps failing:
  * `abortOnFailure === true` → hard stop, no commit.
  * `abortOnFailure === false` → user modal with options:
    1. **Commit anyway** (skip remaining checks, annotate body with `[pipeline failed at <step>: see OUTPUT > CommitSmith]`, disable auto-push),
    2. **Retry step (no AI)**,
    3. **Abort**.

**If all checks pass:** proceed with commit.
**If not:** surface logs, abort, or allow override (depending on user config).

---

### 🧩 **Configuration**

All options exposed via VS Code settings:

| Setting                                 | Description                            | Default                 |
| --------------------------------------- | -------------------------------------- | ----------------------- |
| `commitSmith.format.command`            | Format command                         | `npm run format:fix`    |
| `commitSmith.typecheck.command`         | Typecheck command                      | `npm run typecheck`     |
| `commitSmith.tests.command`             | Test command                           | `npm test -- -w`        |
| `commitSmith.pipeline.enable`           | Enable pre-commit pipeline             | `true`                  |
| `commitSmith.pipeline.maxAiFixAttempts` | Retry limit for AI fix                 | `2`                     |
| `commitSmith.commit.pushAfter`          | Auto-push after commit                 | `false`                 |
| `commitSmith.message.style`             | Commit style (`conventional`, `plain`) | `conventional`          |
| `commitSmith.message.enforce72`         | Enforce 72-char limit                  | `true`                  |
| `commitSmith.jira.fromBranch`           | Extract ticket from branch             | `true`                  |
| `commitSmith.codex.model`               | Codex model used                       | `gpt-5-codex`           |
| `commitSmith.codex.timeoutMs`           | Codex request timeout (ms)             | `10000`                 |
| `commitSmith.pipeline.abortOnFailure`   | Stop pipeline when a step fails        | `true`                  |
Note: We must ensure `codex` is installed, configured and available.

---

### 🔧 **Developer Experience**

* **Dry Run mode** → saves `.patch` preview before AI applies fixes.
* **Output Channel** → `CommitSmith` logs all steps (color-coded).
* **Ignore rules** → `.commit-smith-ignore` file to skip paths/files.
* **Install Hooks command** → generates `.git/hooks/pre-commit` to run the same pipeline via CLI.
* **Scope detection** → fallback to workspace folder name if none in branch.
* Dry run simulates the full pipeline without altering the repo: uses `--check` formats where possible, captures Codex patches to `.commit-smith/patches/<timestamp>/<file>.patch`, and writes `summary.json` + `COMMIT_MESSAGE.md` artefacts.
* `.commit-smith-ignore` patterns override `.gitignore`, followed by internal defaults, to keep unwanted paths out of checks, fixes, journaling, and dry-run artefacts.

---

## **5. Technical Scope**

### 🧱 **Architecture**

| Module        | Responsibility                          |
| ------------- | --------------------------------------- |
| `journal.ts`  | Read/write `.ai-commit-journal.yml`     |
| `pipeline.ts` | Run pre-commit steps (format/type/test) |
| `codex.ts`    | Call Codex for message & fixes          |
| `config.ts`   | Handle VS Code settings                 |
| `ui.ts`       | SCM button, progress UI, notifications  |

### ⚙️ **Core Commands**

* `commitSmith.generateFromJournal`
* `commitSmith.clearJournal`
* `commitSmith.installHooks`

### 🧩 **Dependencies**

`yaml`, `execa`, `child_process`, `simple-git`, `axios`, `vscode`

---

## **6. AI Prompts**

### 🧠 Commit Message Prompt

> **System:**
> You are an expert Git commit writer.
> Generate a concise, conventional commit message (≤ 72 chars subject + bullet list).
>
> **User:**
>
> ```
> AI Commit Journal:
> current:
>   - feat: expose queue orchestrator single-worker guard
>   - refactor: split job runner in 3 modules
>   - test: add e2e restart-on-crash
> meta:
>   ticket: T1335
>   scope: jobs-service
> ```
>
> **Output:**
>
> ```
> feat(jobs-service): enforce single-worker guard (T1335)
>
> - expose orchestrator guard + fail-fast
> - refactor runner into scheduler/worker/utils
> - add e2e restart-on-crash
> ```

---

### 🧩 AI Fix Prompt

> **System:**
> You are an AI assistant that fixes code errors caused by lint, type, or test failures.
> Apply minimal, safe edits to resolve the issue without altering logic.
>
> **User:**
>
> ```
> File: src/utils/queue.ts
> Error: 'Queue' is possibly 'undefined'.ts(2532)
> ```
>
> *(code snippet here)*

---

## **7. Branding & Identity**

| Element           | Value                                         |
| ----------------- | --------------------------------------------- |
| **Name**          | CommitSmith                                   |
| **Tagline**       | “Your AI-forged commits.”                     |
| **Suite**         | EpicSmith                                     |
| **Icon**          | ⚒️                                            |
| **Color palette** | Copper `#e0b356` on dark forge gray `#1b1a1a` |
| **Logo**          | Stylized hammer on a “C”                      |
| **Extension ID**  | `epicsmith.commit-smith`                      |
| **Repository**    | `github.com/EpicSmith/commit-smith`           |

---

## **8. Success Criteria**

✅ Codex automatically updates the change journal during coding sessions.
✅ “AI Commit” runs the pre-commit pipeline and commits clean code.
✅ Commit messages are conventional, contextual, and consistent.
✅ No hallucinations — journal is the only source of truth.
✅ Works seamlessly in Cursor and vanilla VS Code.
✅ Developer can configure everything from settings.
✅ Offline fallback produces heuristic `[offline mode]` commits when Codex is unreachable (network errors, non-200, or >10s timeout).

---

## **9. Roadmap**

| Phase                        | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| **P1 — MVP**                 | Journal + Commit Button + Codex message generation |
| **P2 — Pre-commit pipeline** | Format + Typecheck + Tests + AI Fix                |
| **P3 — UI & Config**         | Settings page + Logs + Dry-run patches             |
| **P4 — Hooks packaging**     | Git hooks generator                                |
| **P5 — Marketplace release** | Branding, icon, README, demo video                 |

---

## **10. Next Steps**

1. **Codex** challenges this brief (risks, missing details, unclear edge cases).
2. **Pezzos & G** answer and refine the SPEC.
3. **Codex** generates:

   * `SPEC.md` (technical design)
   * `ROADMAP.md` (tickets & dependencies)
   * `extension.ts` scaffolding
   * `package.json`
   * `README.md`

---

🔥 Ready to forge commits like a pro.
