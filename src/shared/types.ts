import type { Uri } from "vscode";

export type StepId =
  | "format"
  | "lint"
  | "typecheck"
  | "tests"
  | "codexReview";

export type StepStatus =
  | "idle"
  | "running"
  | "success"
  | "error";

export interface StepSummary {
  readonly kind: "success" | "error";
  readonly errorCount?: number;
  readonly warningCount?: number;
}

export interface StepStatusEvent {
  readonly step: StepId;
  readonly status: StepStatus;
  readonly blocking: boolean;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly message?: string;
  readonly tooltip?: string;
  readonly summary?: StepSummary;
}

export interface AppendLogEvent {
  readonly step: StepId;
  readonly chunk: string;
  readonly truncated: boolean;
  readonly timestamp: string;
  readonly reset?: boolean;
  readonly hash: string;
}

export interface JournalEntry {
  readonly ts: string;
  readonly source: "codex" | "pipeline" | "manual";
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

export interface PipelineResult {
  readonly success: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly blocking: boolean;
  readonly logs?: readonly string[];
  readonly error?:
    | UserError
    | InfraError
    | OfflineError
    | TimeoutError;
  readonly stepSummary?: StepSummary;
}

export interface TestSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
}

export interface TestPipelineResult extends PipelineResult {
  readonly summary?: TestSummary;
}

export interface CodexReviewResult {
  readonly success: boolean;
  readonly text?: string;
  readonly confidence?: number;
  readonly ts: string;
  readonly error?:
    | OfflineError
    | TimeoutError
    | InfraError
    | UserError;
}

export interface CommitResult {
  readonly success: boolean;
  readonly pushed: boolean;
  readonly message: string;
  readonly error?:
    | TimeoutError
    | InfraError
    | UserError
    | OfflineError;
}

export interface RepositorySnapshot {
  readonly rootUri: Uri;
  readonly name: string;
  readonly branch?: string;
}

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export class InfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraError";
  }
}

export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineError";
  }
}

export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
