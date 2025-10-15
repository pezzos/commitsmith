# Task Completion Checklist
- Ensure TypeScript sources compile via `npm run compile` when edits touch `src/`.
- Run targeted scripted tests (`npm run test:<area>`) corresponding to modified modules; default to `npm run test:pipeline` or `npm run test:dry-run` for pipeline/dry-run changes.
- Verify `dist/` artefacts if task depends on compiled output or CLI interface.
- Confirm journal YAML or git fixtures remain untouched unless intentionally modified.
- Update documentation/specs when behavior changes (README, SPEC) and mention new commands in docs if applicable.