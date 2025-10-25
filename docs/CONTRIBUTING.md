# Contributing to CommitSmith

## Development Workflow

- Run `npm run test:unit` and `npm run test:integration` before opening a PR.
- When updating VS Code shim helpers under `scripts/test-utils/mock-vscode.js`, also update the guard tests in `scripts/test-vscode-shim.mjs`. Locally run `npm run test:unit`. In CI (GitHub Actions), this guard executes under the job **ci-unit-tests**, so shim/guard mismatches fail that stage.
- `npm run lint` now emits a warning-mode VS Code API parity check (`[vscode-shim][warning]`). Resolve warnings by extending the shim/guard. Follow-up work (ticket CSH-434) will graduate this lint to blocking once signals stabilize.
