import * as vscode from "vscode";
import {
  CommitResult,
  CodexReviewResult,
  InfraError,
  OfflineError,
  PipelineResult,
  StepId,
  TestPipelineResult,
  TimeoutError,
  UserError,
} from "../../shared/types";

export interface OrchestratorCommands {
  readonly runFormat: () => Promise<PipelineResult>;
  readonly runLint: () => Promise<PipelineResult>;
  readonly runTypecheck: (
    onLog: (chunk: string) => void,
  ) => Promise<PipelineResult>;
  readonly runTests: (
    onLog: (chunk: string) => void,
  ) => Promise<TestPipelineResult>;
  readonly askCodexReview: () => Promise<CodexReviewResult>;
  readonly commitAndPush: (input: {
    readonly message: string;
    readonly push: boolean;
  }) => Promise<CommitResult>;
}

export interface TimeoutConfig {
  readonly formatMs: number;
  readonly lintMs: number;
  readonly typecheckMs: number;
  readonly testsMs: number;
  readonly codexReviewMs: number;
  readonly commitMs: number;
}

const DEFAULT_TIMEOUTS: TimeoutConfig = {
  formatMs: 60_000,
  lintMs: 60_000,
  typecheckMs: 600_000,
  testsMs: 900_000,
  codexReviewMs: 10_000,
  commitMs: 120_000,
};

export function getDefaultTimeouts(): TimeoutConfig {
  return { ...DEFAULT_TIMEOUTS };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new TimeoutError(
          `${label} timed out after ${Math.ceil(timeoutMs / 1000)}s`,
          timeoutMs,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

export function normalizeError(
  error: unknown,
  fallbackMessage: string,
): UserError | InfraError | OfflineError {
  if (error instanceof UserError) {
    return error;
  }
  if (error instanceof InfraError) {
    return error;
  }
  if (error instanceof OfflineError) {
    return error;
  }
  if (error instanceof TimeoutError) {
    return new InfraError(error.message);
  }
  if (error instanceof Error) {
    return new InfraError(error.message);
  }
  return new InfraError(fallbackMessage);
}

export function formatTimeoutForStep(step: StepId): number {
  switch (step) {
    case "format":
    case "lint":
      return DEFAULT_TIMEOUTS.formatMs;
    case "typecheck":
      return DEFAULT_TIMEOUTS.typecheckMs;
    case "tests":
      return DEFAULT_TIMEOUTS.testsMs;
    case "codexReview":
      return DEFAULT_TIMEOUTS.codexReviewMs;
  }
}

export function describeStep(step: StepId): string {
  switch (step) {
    case "format":
      return "Format";
    case "lint":
      return "Lint";
    case "typecheck":
      return "Typecheck";
    case "tests":
      return "Tests";
    case "codexReview":
      return "Codex Review";
    default:
      return step;
  }
}

export type CommandRegistration = vscode.Disposable;
