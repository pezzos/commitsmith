#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  console.info(
    "Usage: node scripts/analyze-codex-shadow.mjs <telemetry.jsonl>",
  );
}

async function main() {
  const [inputFile] = process.argv.slice(2);
  if (!inputFile) {
    usage();
    process.exit(1);
    return;
  }

  const resolved = path.resolve(process.cwd(), inputFile);
  const content = await readFile(resolved, "utf8");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    console.warn("[shadow] No telemetry events found.");
    return;
  }

  const invocations = [];
  const comparisons = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event?.name === "workflow.codexInvocation") {
        invocations.push(event);
      } else if (event?.name === "workflow.codexShadowComparison") {
        comparisons.push(event);
      }
    } catch (error) {
      console.warn("[shadow] Skipping invalid JSON line:", line);
    }
  }

  if (invocations.length === 0) {
    console.warn("[shadow] No codex invocation telemetry present.");
  }

  const summary = new Map();
  for (const event of invocations) {
    const pathKey = event?.properties?.path ?? "unknown";
    const stats = summary.get(pathKey) ?? {
      total: 0,
      success: 0,
      fallback: 0,
      error: 0,
      durationMs: 0,
    };
    stats.total += 1;
    const outcome = event?.properties?.outcome ?? "unknown";
    if (outcome === "success") {
      stats.success += 1;
    } else if (outcome === "fallback") {
      stats.fallback += 1;
    } else {
      stats.error += 1;
    }
    const duration =
      event?.measurements?.durationMs ??
      event?.measurements?.duration ??
      0;
    stats.durationMs += Number(duration) || 0;
    summary.set(pathKey, stats);
  }

  console.info("=== Codex Invocation Summary ===");
  for (const [pathKey, stats] of summary.entries()) {
    const average =
      stats.total > 0
        ? (stats.durationMs / stats.total).toFixed(2)
        : "0.00";
    console.info(
      `${pathKey.padEnd(7)} total=${stats.total} success=${stats.success} fallback=${stats.fallback} error=${stats.error} avgDurationMs=${average}`,
    );
  }

  if (comparisons.length > 0) {
    console.info("\n=== Shadow Comparisons ===");
    for (const event of comparisons) {
      const props = event.properties ?? {};
      const measurements = event.measurements ?? {};
      console.info(
        `shadow=${props.shadowOutcome} legacy=${props.legacyOutcome} Δ=${
          measurements.durationDeltaMs ?? "n/a"
        }ms fallback=${props.legacyFallback}`,
      );
    }
  } else {
    console.info(
      "\n[shadow] No workflow.codexShadowComparison events found.",
    );
  }
}

main().catch((error) => {
  console.error("[shadow] Telemetry analysis failed:", error);
  process.exitCode = 1;
});
