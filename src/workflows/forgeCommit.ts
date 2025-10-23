import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import * as vscode from "vscode";

import { getConfig } from "../config";
import {
  initializeJournal,
  readJournal,
  clearCurrent,
  JournalData,
} from "../journal";
import {
  runPipeline,
  PipelineHooks,
  PipelineOutcome,
  PipelineDecisionEvent,
  PipelineDecision,
  PipelineStepId,
  PipelineLane,
} from "../pipeline";
import { commit, push } from "../utils/git";
import {
  generateCommitMessage,
  CodexInvocationError,
} from "../codex";
import { recordTelemetry } from "../telemetry";
import { GitRepository } from "../types/git";

export interface ForgeCommitOptions {
  readonly repo: GitRepository;
  readonly journalRoot?: string;
  readonly log: (message: string) => void;
  readonly promptDecision: (
    event: PipelineDecisionEvent,
  ) => Promise<PipelineDecision>;
  readonly pipelineLane?: PipelineLane;
}

export type ForgeCommitResult =
  | { status: "empty" }
  | { status: "pipeline-aborted"; failedStep?: PipelineStepId }
  | { status: "commit-success"; pushFailed: boolean }
  | {
      status: "commit-warning";
      pushFailed: boolean;
      commitAnnotation: string;
    }
  | { status: "error"; message: string };

export async function forgeCommitFromJournal(
  options: ForgeCommitOptions,
): Promise<ForgeCommitResult> {
  const journalRoot =
    options.journalRoot ?? options.repo.rootUri.fsPath;
  const config = getConfig();
  const repoRoot = options.repo.rootUri.fsPath;
  const codexOptions = {
    workingDirectory: repoRoot,
    log: options.log,
  };
  const lane: PipelineLane =
    options.pipelineLane ??
    (config.pipelineRequireChecks ? "guarded" : "fast");
  const preCodexStart = performance.now();
  const telemetry: CommitFlowTelemetry = {
    lane,
    journalEntries: 0,
    pipelineStatus: "not-started",
    commitStatus: "unknown",
    preCodexMs: 0,
    codexMs: undefined,
    artifactMs: undefined,
    artifactRecorded: false,
    codexOutcome: "not-invoked",
    fallbackReason: undefined,
    invocationId: undefined,
    invocationPath: undefined,
    pushFailed: false,
    journalConfirmed: false,
    failedStep: undefined,
  };
  const finalizeResult = (
    result: ForgeCommitResult,
  ): ForgeCommitResult => {
    recordCommitFlowTelemetry(telemetry);
    return result;
  };

  try {
    await initializeJournal({ root: journalRoot });
    const journal = await readJournal({ root: journalRoot });
    telemetry.journalEntries = journal.current?.length ?? 0;

    if (!journal.current || journal.current.length === 0) {
      telemetry.pipelineStatus = "skipped";
      telemetry.commitStatus = "empty";
      telemetry.preCodexMs = performance.now() - preCodexStart;
      return finalizeResult({ status: "empty" });
    }

    const pipelineHooks = createPipelineHooks(options);
    const outcome: PipelineOutcome = await runPipeline({
      repo: options.repo,
      hooks: pipelineHooks,
      codexOptions,
      lane,
    });
    telemetry.pipelineStatus = outcome.status;
    telemetry.preCodexMs = performance.now() - preCodexStart;

    if (outcome.status === "aborted") {
      telemetry.commitStatus = "pipeline-aborted";
      telemetry.failedStep = outcome.failedStep;
      return finalizeResult({
        status: "pipeline-aborted",
        failedStep: outcome.failedStep,
      });
    }

    let commitMessage: string;
    let usedOfflineFallback = false;
    try {
      const stagedFiles = await listStagedFiles(repoRoot);
      const journalForPrompt: JournalData = {
        current: journal.current,
        meta: {
          ...journal.meta,
          stagedFiles,
        },
      };
      const commitResult = await generateCommitMessage(
        journalForPrompt,
        codexOptions,
      );
      commitMessage = commitResult.message;
      telemetry.codexOutcome = commitResult.invocation.outcome;
      telemetry.codexMs = commitResult.invocation.durationMs;
      telemetry.artifactMs = commitResult.artifactDurationMs;
      telemetry.artifactRecorded = commitResult.artifactRecorded;
      telemetry.invocationId = commitResult.invocation.id;
      telemetry.invocationPath = commitResult.invocation.path;
      telemetry.fallbackReason =
        commitResult.invocation.fallbackReason ?? undefined;
    } catch (error) {
      usedOfflineFallback = true;
      if (error instanceof CodexInvocationError) {
        telemetry.codexOutcome = error.metrics.outcome;
        telemetry.codexMs = error.metrics.durationMs;
        telemetry.invocationId = error.metrics.id;
        telemetry.invocationPath = error.metrics.path;
        telemetry.fallbackReason =
          error.metrics.fallbackReason ?? "unknown";
      } else {
        telemetry.codexOutcome = "error";
        telemetry.fallbackReason = "unknown";
      }
      const stagedFiles = await listStagedFiles(repoRoot);
      commitMessage = buildOfflineCommitMessage(stagedFiles);
      options.log(
        `[OFFLINE ⚠️] Codex unavailable (${(error as Error).message ?? "unknown reason"}). Generated heuristic commit message.`,
      );
      options.log(
        "[Codex] CLI events have been written to the CommitSmith output channel for inspection.",
      );
      void vscode.window.showWarningMessage(
        `[CommitSmith] Codex could not provide a commit message. Fallback used. Reason: ${(error as Error).message}`,
      );
    }

    const finalMessage = outcome.commitAnnotation
      ? `${commitMessage}\n\n${outcome.commitAnnotation}`
      : commitMessage;

    await commit(options.repo, finalMessage);
    options.log("[COMMIT ✅] Created git commit.");
    telemetry.commitStatus =
      outcome.status === "commit-anyway"
        ? "commit-warning"
        : "commit-success";

    let pushFailed = false;
    if (config.commitPushAfter && !outcome.suppressAutoPush) {
      try {
        await push(options.repo);
        options.log("[PUSH ✅] Changes pushed to remote.");
      } catch (error) {
        pushFailed = true;
        options.log(`[PUSH ❌] ${(error as Error).message}`);
      }
    } else if (config.commitPushAfter && outcome.suppressAutoPush) {
      options.log(
        "[PUSH ⏭️] Skipped auto-push due to pipeline decision.",
      );
    }
    telemetry.pushFailed = pushFailed;

    await clearCurrent({ root: journalRoot });
    options.log("[JOURNAL 🗑️] Cleared current entries.");
    telemetry.journalConfirmed = true;

    if (usedOfflineFallback) {
      options.log(
        "[OFFLINE ✅] Commit created with offline fallback message.",
      );
    }

    if (outcome.status === "commit-anyway") {
      return finalizeResult({
        status: "commit-warning",
        pushFailed,
        commitAnnotation: outcome.commitAnnotation ?? "",
      });
    }

    return finalizeResult({ status: "commit-success", pushFailed });
  } catch (error) {
    telemetry.commitStatus = "error";
    return finalizeResult({
      status: "error",
      message: (error as Error).message,
    });
  }
}

const COMMIT_FLOW_SCHEMA_VERSION = 1;

interface CommitFlowTelemetry {
  readonly lane: PipelineLane;
  journalEntries: number;
  pipelineStatus: string;
  commitStatus: string;
  preCodexMs: number;
  codexMs?: number;
  artifactMs?: number;
  artifactRecorded: boolean;
  codexOutcome: string;
  fallbackReason?: string;
  invocationId?: string;
  invocationPath?: string;
  pushFailed: boolean;
  journalConfirmed: boolean;
  failedStep?: PipelineStepId;
}

function recordCommitFlowTelemetry(
  telemetry: CommitFlowTelemetry,
): void {
  const properties: Record<string, string> = {
    lane: telemetry.lane,
    pipelineStatus: telemetry.pipelineStatus,
    commitStatus: telemetry.commitStatus,
    codexOutcome: telemetry.codexOutcome,
    fastLane: telemetry.lane === "fast" ? "true" : "false",
    journalConfirmed: telemetry.journalConfirmed ? "true" : "false",
    artifactRecorded: telemetry.artifactRecorded ? "true" : "false",
    pushFailed: telemetry.pushFailed ? "true" : "false",
    journalEntries: telemetry.journalEntries.toString(),
  };

  properties.fallbackReason = telemetry.fallbackReason ?? "none";
  properties.invocationId = telemetry.invocationId ?? "none";
  properties.invocationPath = telemetry.invocationPath ?? "unknown";
  if (telemetry.failedStep) {
    properties.failedStep = telemetry.failedStep;
  }

  const measurements: Record<string, number> = {
    preCodexMs: Number(telemetry.preCodexMs.toFixed(3)),
  };

  if (typeof telemetry.codexMs === "number") {
    measurements.codexMs = Number(telemetry.codexMs.toFixed(3));
  }

  if (typeof telemetry.artifactMs === "number") {
    measurements.artifactMs = Number(telemetry.artifactMs.toFixed(3));
  }

  recordTelemetry({
    name: "workflow.commitFlow",
    schema: "workflow.commitFlow",
    schemaVersion: COMMIT_FLOW_SCHEMA_VERSION,
    properties,
    measurements,
  });
}

function createPipelineHooks(
  options: ForgeCommitOptions,
): PipelineHooks {
  return {
    onStepStart: ({ step, attempt }) => {
      options.log(
        `[${formatStepLabel(step)} ▶️] Attempt ${attempt + 1}`,
      );
    },
    onStepComplete: (result) => {
      const status = result.success ? "✅" : "❌";
      options.log(`[${formatStepLabel(result.step)} ${status}]`);
    },
    onDecisionRequired: (event) => options.promptDecision(event),
  };
}

function formatStepLabel(step: PipelineStepId): string {
  const labels: Record<PipelineStepId, string> = {
    format: "FORMAT",
    typecheck: "TYPECHECK",
    tests: "TESTS",
  };
  return labels[step];
}

const execFileAsync = promisify(execFile);

async function listStagedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "--cached"],
      { cwd: root },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function buildOfflineCommitMessage(stagedFiles: string[]): string {
  const normalizedFiles = stagedFiles.map((file) =>
    file.replace(/^\.\//, ""),
  );
  const scope = deriveScope(normalizedFiles);
  const scopeSegment = scope ? `(${scope})` : "";
  const subject = `chore${scopeSegment}: commit updated files [offline mode]`;

  const fileLines = normalizedFiles
    .slice(0, 3)
    .map((file) => `- ${file}`);
  if (fileLines.length === 0) {
    return subject;
  }

  return `${subject}\n\n${fileLines.join("\n")}`;
}

function deriveScope(files: string[]): string | undefined {
  if (files.length === 0) {
    return "workspace";
  }

  const first = files[0];
  const withoutPrefix = first.replace(/^\.\//, "");
  const segments = withoutPrefix.split(/[\\/]/).filter(Boolean);

  if (segments.length === 0) {
    return "workspace";
  }

  const firstSegment = segments.length > 1 ? segments[0] : "";
  return sanitizeScope(firstSegment || "workspace");
}

function sanitizeScope(value: string): string {
  if (!value) {
    return "workspace";
  }
  return (
    value
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9\-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "workspace"
  );
}
