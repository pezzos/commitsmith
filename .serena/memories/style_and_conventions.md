# Style & Conventions
- TypeScript with `strict` compiler settings; CommonJS modules targeting ES2020, source under `src/` compiled to `dist/`.
- Favor synchronous VS Code extension patterns with async/await for IO-heavy work; respect existing error-handling/logging utilities in pipeline and workflows.
- Configuration derives from VS Code settings namespace `commitSmith.*`; pipeline steps represented as typed objects (`PipelineStep`, etc.).
- Follow conventional commit phrasing in journal interactions and generated commits.
- Tests currently scripted via bespoke Node runners in `scripts/*.mjs|.ts`; use temporary repositories or fixture dirs when validating git interactions.