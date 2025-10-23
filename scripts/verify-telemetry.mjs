#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distPath = path.join(repoRoot, "dist");
const telemetryArtifacts = [
  path.join(distPath, "codex.js"),
  path.join(distPath, "telemetry.js"),
  path.join(distPath, "workflows", "forgeCommit.js"),
];

const missing = telemetryArtifacts.filter((file) => !fs.existsSync(file));

if (missing.length > 0) {
  console.warn(
    "[telemetry] Build artefacts missing:",
    missing.map((file) => path.relative(repoRoot, file)).join(", "),
  );
  console.warn("[telemetry] Run `npm run compile` before re-running this script.");
  process.exitCode = 1;
} else {
  console.info("[telemetry] Build artefacts present.");
}

console.info("");
console.info("Telemetry staging checklist:");
console.info("1. Start CommitSmith on the staging workspace with the fast lane enabled.");
console.info(
  "2. Trigger a commit flow and a guarded-lane run so `workflow.commitFlow.v1` records both lanes.",
);
console.info(
  "3. Open DataHub › CommitSmith › Codex Runtime (dashboards/codex-runtime) and verify `workflow.codexInvocation` shows the new invocation path with schemaVersion=1.",
);
console.info(
  "4. Open DataHub › CommitSmith › Artefacts (dashboards/codex-artifacts) and confirm artifact upload timings land within expected thresholds (<5s).",
);
console.info(
  "5. Open DataHub › CommitSmith › Fast Lane (dashboards/fast-lane) and confirm preCodex vs codex durations update for your session's invocationId.",
);
console.info(
  "6. Record the verification timestamp and invocationId in the rollout log before promoting to production.",
);
