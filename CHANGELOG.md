# Changelog

## [Unreleased]

- Added Codex CLI integration as the sole execution path for commit message and fix generation.
- Removed legacy HTTP configuration options (`commitSmith.codex.endpoint`, `commitSmith.codex.timeoutMs`) and updated documentation to reference the CLI workflow.
- Introduced reusable CLI mocks across integration tests and verified streaming logs remain deduplicated.

## [0.0.8]

- Initial project scaffolding and journal workflow foundations.
