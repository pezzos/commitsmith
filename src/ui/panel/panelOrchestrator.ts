import { spawn } from "node:child_process";
import { getConfig } from "../../config";
import {
  InfraError,
  PipelineResult,
  StepSummary,
  TimeoutError,
  UserError,
} from "../../shared/types";
import { RepositorySelector } from "./repositorySelector";
import { formatTimeoutForStep, OrchestratorCommands } from "./orchestrator";

interface RunCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly label: string;
  readonly timeoutMs: number;
  readonly onLog: (chunk: string) => void;
}

export function createPanelOrchestrator(
  repositorySelector: RepositorySelector,
): Pick<OrchestratorCommands, "runTypecheck"> {
  return {
    async runTypecheck(onLog) {
      const startedAt = new Date();
      const repo = repositorySelector.active;
      if (!repo) {
        return failureResult(startedAt, new InfraError("Select a repository to run CommitSmith."));
      }
      const config = getConfig();
      const command = (config.typecheckCommand || "").trim();
      if (command.length === 0) {
        return {
          success: true,
          blocking: false,
          startedAt: startedAt.toISOString(),
          finishedAt: startedAt.toISOString(),
          stepSummary: emptySummary("success"),
        };
      }
      return await runCommand({
        command,
        cwd: repo.rootUri.fsPath,
        label: "Typecheck",
        timeoutMs: formatTimeoutForStep("typecheck"),
        onLog,
      });
    },
  };
}

async function runCommand({
  command,
  cwd,
  label,
  timeoutMs,
  onLog,
}: RunCommandOptions): Promise<PipelineResult> {
  const startedAt = new Date();
  return await new Promise<PipelineResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
      },
    });

    let settled = false;
    const finish = (result: PipelineResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data) => {
      onLog(String(data));
    });
    child.stderr?.on("data", (data) => {
      onLog(String(data));
    });

    child.on("error", (error) => {
      const message =
        error instanceof Error ? error.message : `${label} command failed to start`;
      finish(failureResult(startedAt, new InfraError(message)));
    });

    child.on("close", (code) => {
      if (typeof code === "number" && code !== 0) {
        finish(
          failureResult(
            startedAt,
            new UserError(`${label} exited with code ${code}`),
          ),
        );
      } else {
        finish(successResult(startedAt));
      }
    });

    const timeoutHandle = setTimeout(() => {
      child.kill();
      finish(
        failureResult(
          startedAt,
          new TimeoutError(
            `${label} timed out after ${Math.ceil(timeoutMs / 1000)}s`,
            timeoutMs,
          ),
        ),
      );
    }, timeoutMs);
  });
}

function successResult(startedAt: Date): PipelineResult {
  return {
    success: true,
    blocking: false,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    stepSummary: emptySummary("success"),
  };
}

function failureResult(startedAt: Date, error: Error): PipelineResult {
  return {
    success: false,
    blocking: true,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    error:
      error instanceof Error
        ? error
        : new InfraError("Command failed unexpectedly"),
    stepSummary: emptySummary("error"),
  };
}

function emptySummary(kind: StepSummary["kind"]): StepSummary {
  return { kind, errorCount: 0, warningCount: 0 };
}
