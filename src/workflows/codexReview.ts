import {
  CodexReviewResult,
  InfraError,
  OfflineError,
  TimeoutError,
  UserError,
} from "../shared/types";
import { addEntry, readJournal } from "../journal";
import {
  CodexExecutionOptions,
  generateCommitMessage,
} from "../codex";
import { CodexPromptValidationError } from "../codexCli/prompts";
import { CodexInvocationError } from "../codex";

export interface RunCodexReviewOptions {
  readonly cwd: string;
  readonly codexOptions?: CodexExecutionOptions;
}

export async function runCodexReview(
  options: RunCodexReviewOptions,
): Promise<CodexReviewResult> {
  const { cwd, codexOptions } = options;
  const timestamp = () => new Date().toISOString();

  let journal;
  try {
    journal = await readJournal({
      root: cwd,
      createIfMissing: true,
    });
  } catch (error) {
    return {
      success: false,
      ts: timestamp(),
      error: normalizeReviewError(error),
    };
  }

  try {
    const result = await generateCommitMessage(journal, {
      workingDirectory: cwd,
      ...codexOptions,
    });

    const text = buildReviewSnippet(result.message);
    const confidence = inferConfidence(result.message);
    const ts = timestamp();
    const metadata =
      typeof confidence === "number" ? { confidence } : undefined;

    try {
      await addEntry(
        {
          message: text,
          source: "codex",
          ts,
          metadata,
        },
        { root: cwd },
      );
    } catch (journalError) {
      const error =
        journalError instanceof Error
          ? journalError
          : new Error("Failed to append Codex review to journal.");
      return {
        success: false,
        ts,
        error: new InfraError(error.message),
      };
    }

    return {
      success: true,
      text,
      confidence: confidence ?? undefined,
      ts,
    };
  } catch (error) {
    return {
      success: false,
      ts: timestamp(),
      error: normalizeReviewError(error),
    };
  }
}

function buildReviewSnippet(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "Codex did not return any feedback.";
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length <= 1) {
    return trimmed;
  }
  const [, ...rest] = lines;
  const body = rest.join("\n").trim();
  return body.length > 0 ? body : lines[0];
}

function inferConfidence(message: string): number | undefined {
  const trimmed = message.trim();
  if (!trimmed) {
    return undefined;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length >= 3) {
    return 0.75;
  }
  if (lines.length === 2) {
    return 0.68;
  }
  return 0.6;
}

function normalizeReviewError(
  error: unknown,
): OfflineError | TimeoutError | InfraError | UserError {
  if (
    error instanceof OfflineError ||
    error instanceof TimeoutError ||
    error instanceof InfraError ||
    error instanceof UserError
  ) {
    return error;
  }
  if (error instanceof CodexPromptValidationError) {
    return new InfraError(error.message);
  }
  if (error instanceof CodexInvocationError) {
    if (error.cause instanceof TimeoutError) {
      return error.cause;
    }
    if (error.cause instanceof OfflineError) {
      return error.cause;
    }
    if (error.metrics.fallbackReason) {
      return new OfflineError(error.message);
    }
    return new InfraError(error.message);
  }
  if (error instanceof Error) {
    return new InfraError(error.message);
  }
  return new InfraError("Codex review failed.");
}
