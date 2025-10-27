import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { getConfig } from "../../config";
import {
  CommitSmithStateStore,
  CommitSmithUIBridge,
  StepExecutionGate,
  RepositorySelector,
  CommitSmithNotifier,
} from ".";
import {
  InfraError,
  OfflineError,
  StepId,
  StepStatusEvent,
  StepSummary,
  TimeoutError,
  UserError,
} from "../../shared/types";
import { StepLogBuffer } from "./logBuffer";
import { SecretMasker } from "./security";
import {
  describeStep,
  formatTimeoutForStep,
  normalizeError,
  OrchestratorCommands,
} from "./orchestrator";

const LOG_HISTORY_PAGE_SIZE = 50;

type CommandStep = "format" | "lint" | "typecheck";

interface StepCopy {
  readonly label: string;
  readonly noun: string;
}

const COMMAND_STEP_COPY: Record<CommandStep, StepCopy> = {
  format: { label: "Format", noun: "formatter" },
  lint: { label: "Lint", noun: "linter" },
  typecheck: { label: "Typecheck", noun: "typechecker" },
};

interface StepControllerDeps {
  readonly stateStore: CommitSmithStateStore;
  readonly bridge: CommitSmithUIBridge;
  readonly gate: StepExecutionGate;
  readonly repositorySelector: RepositorySelector;
  readonly notifier: CommitSmithNotifier;
  readonly orchestrator?: Pick<OrchestratorCommands, "runTypecheck">;
}

export class StepController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly logBuffers = new Map<StepId, StepLogBuffer>();
  private readonly masker = new SecretMasker();
  private readonly orchestrator?: Pick<OrchestratorCommands, "runTypecheck">;

  constructor(private readonly deps: StepControllerDeps) {
    this.orchestrator = deps.orchestrator;
    this.disposables.push(
      this.deps.bridge.onDidReceiveMessage((message) => {
        if (message.type === "RUN_STEP") {
          void this.handleRunStep(message.payload.step);
        } else if (message.type === "REQUEST_LOG_PAGE") {
          this.handleLogHistoryRequest(
            message.payload.step,
            message.payload.before,
          );
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose?.();
    }
    for (const buffer of this.logBuffers.values()) {
      buffer.dispose();
    }
    this.masker.dispose();
  }

  private async handleRunStep(step: StepId): Promise<void> {
    if (!this.deps.gate.tryEnter(step)) {
      return;
    }

    if (!isCommandStep(step)) {
      void vscode.window.showInformationMessage(
        `${describeStep(step)} step is not yet implemented.`,
      );
      this.deps.gate.exit(step);
      return;
    }

    const copy = COMMAND_STEP_COPY[step];
    const skippable = this.deps.stateStore.get("skippable") ?? {};
    const buffer = this.getLogBuffer(step);
    buffer.reset();

    if (skippable[step]) {
      buffer.append(`Skipping ${copy.label} (allow skip enabled).\n`);
      buffer.close();
      const now = new Date();
      const event: StepStatusEvent = {
        step,
        status: "success",
        blocking: false,
        startedAt: now.toISOString(),
        endedAt: now.toISOString(),
        message: "Skipped (Allow skip enabled)",
        tooltip: "Skipped (allow skip enabled)",
      };
      await this.deps.stateStore.setStepStatus(step, event);
      this.deps.bridge.postMessage({
        type: "STEP_STATUS",
        payload: event,
      });
      this.deps.notifier.stepFinished(step, event);
      this.deps.gate.exit(step);
      return;
    }

    const startedAt = new Date();
    const repo = this.deps.repositorySelector.active;
    if (!repo) {
      await this.handleFailure(step, startedAt, new InfraError("Select a repository to run CommitSmith."), {
        label: copy.label,
        timeoutMs: formatTimeoutForStep(step),
      });
      this.deps.gate.exit(step);
      return;
    }

    const config = getConfig();
    const command = this.getCommandForStep(step, config).trim();
    const timeoutMs = formatTimeoutForStep(step);

    if (command.length === 0) {
      buffer.append(`${copy.label} command is not configured.\n`);
      buffer.close();
      await this.handleSuccess(step, startedAt, {
        label: copy.label,
        skipped: true,
        skipMessage: `Skipped (no ${copy.noun} configured)`,
      });
      this.deps.gate.exit(step);
      return;
    }

    buffer.append(`$ ${command}\n`);
    const runningEvent: StepStatusEvent = {
      step,
      status: "running",
      blocking: true,
      startedAt: startedAt.toISOString(),
      endedAt: null,
      message: `Running ${copy.label}…`,
      tooltip: `Running ${copy.label}…`,
    };
    await this.deps.stateStore.setStepStatus(step, runningEvent);
    this.deps.bridge.postMessage({
      type: "STEP_STATUS",
      payload: runningEvent,
    });
    this.deps.notifier.stepStarted(step);

    try {
      if (step === "typecheck") {
        await this.runTypecheckStep({
          startedAt,
          buffer,
          copy,
          timeoutMs,
        });
      } else {
        await this.executeCommand(
          step,
          command,
          repo.rootUri.fsPath,
          buffer,
          timeoutMs,
          copy,
        );
        buffer.close();
        await this.handleSuccess(step, startedAt, {
          label: copy.label,
          skipped: false,
          summary: this.createSuccessSummary(step),
        });
      }
    } catch (error) {
      buffer.append(
        `\n${normalizeError(error, `${copy.label} failed`).message}\n`,
      );
      buffer.close();
      await this.handleFailure(step, startedAt, error, {
        label: copy.label,
        timeoutMs,
      });
    } finally {
      this.deps.gate.exit(step);
    }
  }

  private async handleSuccess(
    step: StepId,
    startedAt: Date,
    context: {
      label: string;
      skipped: boolean;
      skipMessage?: string;
      summary?: StepSummary;
    },
  ): Promise<void> {
    const endedAt = new Date();
    const duration = endedAt.getTime() - startedAt.getTime();
    const completedMessage = `Completed in ${formatDuration(duration)}`;
    const message = context.skipped
      ? context.skipMessage ?? `Skipped (${context.label} disabled)`
      : completedMessage;
    const tooltip = context.skipped ? message : completedMessage;
    const summary: StepSummary | undefined = context.skipped
      ? undefined
      : context.summary ?? this.createSuccessSummary(step);
    const event: StepStatusEvent = {
      step,
      status: "success",
      blocking: false,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      message,
      tooltip,
      summary,
    };
    await this.deps.stateStore.setStepStatus(step, event);
    this.deps.bridge.postMessage({
      type: "STEP_STATUS",
      payload: event,
    });
    this.deps.notifier.stepFinished(step, event);
  }

  private async runTypecheckStep(options: {
    readonly startedAt: Date;
    readonly buffer: StepLogBuffer;
    readonly copy: StepCopy;
    readonly timeoutMs: number;
  }): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!orchestrator?.runTypecheck) {
      options.buffer.append(
        "\nTypecheck orchestrator is not available.\n",
      );
      options.buffer.close();
      await this.handleFailure(
        "typecheck",
        options.startedAt,
        new InfraError("Typecheck orchestrator unavailable."),
        {
          label: options.copy.label,
          timeoutMs: options.timeoutMs,
        },
      );
      return;
    }

    try {
      const result = await orchestrator.runTypecheck((chunk) => {
        options.buffer.append(chunk);
      });
      options.buffer.close();
      if (result.success) {
        await this.handleSuccess("typecheck", options.startedAt, {
          label: options.copy.label,
          skipped: false,
          summary: this.resolveSummaryFromPipeline(
            "typecheck",
            result.stepSummary,
          ),
        });
      } else {
        const pipelineError =
          result.error ?? new InfraError("Typecheck failed");
        await this.handleFailure(
          "typecheck",
          options.startedAt,
          pipelineError,
          {
            label: options.copy.label,
            timeoutMs: options.timeoutMs,
            summary: result.stepSummary,
          },
        );
      }
    } catch (error) {
      const normalized = normalizeError(
        error,
        `${options.copy.label} failed`,
      );
      options.buffer.append(`\n${normalized.message}\n`);
      options.buffer.close();
      await this.handleFailure(
        "typecheck",
        options.startedAt,
        error,
        {
          label: options.copy.label,
          timeoutMs: options.timeoutMs,
        },
      );
    }
  }

  private async handleFailure(
    step: StepId,
    startedAt: Date,
    error: unknown,
    context: { label: string; timeoutMs: number; summary?: StepSummary },
  ): Promise<void> {
    const normalized = normalizeError(error, `${context.label} failed`);
    const now = new Date();
    const tooltip = this.describeErrorTooltip(
      error,
      normalized,
      context.timeoutMs,
    );
    const message = this.describeErrorMessage(tooltip, normalized);
    const summary =
      context.summary ?? this.createErrorSummary(step, normalized);
    const event: StepStatusEvent = {
      step,
      status: "error",
      blocking: true,
      startedAt: startedAt.toISOString(),
      endedAt: now.toISOString(),
      message,
      tooltip,
      summary,
    };
    await this.deps.stateStore.setStepStatus(step, event);
    this.deps.bridge.postMessage({
      type: "STEP_STATUS",
      payload: event,
    });
    this.deps.notifier.stepFinished(step, event);
    this.deps.notifier.showStepError(step, normalized.message);
  }

  private handleLogHistoryRequest(
    step: StepId,
    before?: string,
  ): void {
    const buffer = this.logBuffers.get(step);
    if (!buffer) {
      this.deps.bridge.postMessage({
        type: "LOG_HISTORY",
        payload: {
          step,
          entries: [],
          hasMore: false,
        },
      });
      return;
    }
    const { entries, hasMore } = buffer.getHistory(
      before,
      LOG_HISTORY_PAGE_SIZE,
    );
    this.deps.bridge.postMessage({
      type: "LOG_HISTORY",
      payload: {
        step,
        entries,
        hasMore,
      },
    });
  }

  private describeErrorTooltip(
    originalError: unknown,
    normalized: Error,
    timeoutMs: number,
  ): string {
    if (originalError instanceof TimeoutError) {
      const seconds = Math.ceil(timeoutMs / 1000);
      return `Exceeded ${seconds}s timeout—rerun`;
    }
    if (normalized instanceof InfraError) {
      return "Missing dependency or tool";
    }
    if (normalized instanceof OfflineError) {
      return "Codex unavailable—retry later";
    }
    return "Fix issues in your code";
  }

  private describeErrorMessage(
    tooltip: string,
    normalized: Error,
  ): string {
    if (normalized instanceof UserError) {
      return `${tooltip} (1 blocking issue)`;
    }
    return tooltip;
  }

  private createSuccessSummary(step: StepId): StepSummary {
    if (step === "typecheck") {
      return { kind: "success", errorCount: 0, warningCount: 0 };
    }
    return { kind: "success", errorCount: 0 };
  }

  private resolveSummaryFromPipeline(
    step: StepId,
    summary?: StepSummary,
  ): StepSummary {
    if (summary) {
      return summary;
    }
    return this.createSuccessSummary(step);
  }

  private createErrorSummary(step: StepId, normalized: Error): StepSummary {
    if (normalized instanceof UserError) {
      return { kind: "error", errorCount: 1 };
    }
    if (step === "typecheck") {
      return { kind: "error", errorCount: 0, warningCount: 0 };
    }
    return { kind: "error" };
  }

  private getLogBuffer(step: StepId): StepLogBuffer {
    let buffer = this.logBuffers.get(step);
    if (!buffer) {
      buffer = new StepLogBuffer(step, this.deps.bridge, this.masker);
      this.logBuffers.set(step, buffer);
    }
    return buffer;
  }

  private getCommandForStep(
    step: CommandStep,
    config: ReturnType<typeof getConfig>,
  ): string {
    switch (step) {
      case "format":
        return config.formatCommand;
      case "lint":
        return config.lintCommand;
      case "typecheck":
        return config.typecheckCommand;
      default:
        return "";
    }
  }

  private async executeCommand(
    step: CommandStep,
    command: string,
    cwd: string,
    buffer: StepLogBuffer,
    timeoutMs: number,
    copy: StepCopy,
  ): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: {
          ...process.env,
        },
      });

      let resolved = false;
      const complete = (error?: Error) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timeoutHandle);
        child.removeAllListeners();
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (data) => {
        buffer.append(String(data));
      });
      child.stderr?.on("data", (data) => {
        buffer.append(String(data));
      });
      child.on("error", (error) => {
        complete(
          error instanceof Error
            ? new InfraError(error.message)
            : new InfraError(`${copy.label} command failed to start`),
        );
      });
      child.on("close", (code) => {
        if (typeof code === "number" && code !== 0) {
          complete(new UserError(`${copy.label} exited with code ${code}`));
        } else {
          complete();
        }
      });

      const timeoutHandle = setTimeout(() => {
        child.kill();
        complete(
          new TimeoutError(
            `${copy.label} timed out after ${Math.ceil(timeoutMs / 1000)}s`,
            timeoutMs,
          ),
        );
      }, timeoutMs);
    });
  }
}

function isCommandStep(step: StepId): step is CommandStep {
  return step === "format" || step === "lint" || step === "typecheck";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}
