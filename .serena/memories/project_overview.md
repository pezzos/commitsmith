# CommitSmith Overview
- VS Code/Cursor extension that orchestrates an AI-assisted commit workflow alongside the local Codex agent.
- Primary responsibilities: maintain AI change journal, run configurable pre-commit pipeline (format/typecheck/tests), generate conventional commit messages, manage hooks.
- Tech stack: TypeScript targeting VS Code extension APIs, compiled with `tsc` to `dist/`. Uses Node utilities (`yaml`, `ajv`, `minimatch`).
- Key modules: `src/pipeline.ts` (pre-commit pipeline orchestration), `src/journal.ts` (YAML journal IO), `src/config.ts` (settings), `src/codex.ts` (Codex integration), `src/ui.ts` (SCM UX), plus CLI helpers under `bin/` and higher-level workflows under `src/workflows/`.
- Repo layout: scripts for bespoke tests in `scripts/`, TypeScript sources in `src/`, placeholder tests in `test/`, assets for extension packaging in `assets/`.
- Runs on Darwin dev environment; distributed as VS Code extension via `vsce`.