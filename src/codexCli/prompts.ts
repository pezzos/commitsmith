import { JournalData } from "../journal";
import type { FixContext } from "../codex";
import {
  CodexSchemaValidationError,
  CodexSchemaValidator,
  getCommitSchemaValidator,
  getFixSchemaValidator,
} from "./schema";
import {
  CodexCliArtifact,
  CodexCliArtifactRecorder,
} from "./artifacts";

export interface CodexExecutionOptions {
  readonly recordArtifact?: CodexCliArtifactRecorder;
  readonly workingDirectory?: string;
  readonly skipGitRepoCheck?: boolean;
}

export interface CodexPromptInvocation<T> {
  readonly kind: "commit" | "fix";
  readonly operation: "commit" | "fix";
  readonly schema: CodexSchemaValidator<T>;
  readonly prompt: string;
  readonly promptSummary: string;
  readonly payload: unknown;
  readonly context: Record<string, unknown>;
}

export class CodexPromptValidationError extends Error {
  readonly schemaId: string;
  readonly issues: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
  }>;
  readonly promptSummary: string;

  constructor(
    schemaId: string,
    promptSummary: string,
    issues: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>,
  ) {
    const formatted =
      issues.length > 0
        ? issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ")
        : "unknown issue";
    super(
      `Codex CLI response failed validation for ${schemaId}: ${formatted}`,
    );
    this.name = "CodexPromptValidationError";
    this.schemaId = schemaId;
    this.promptSummary = promptSummary;
    this.issues = issues;
  }
}

export function buildCommitPrompt(
  journal: JournalData,
): CodexPromptInvocation<{ message: string }> {
  const schema = getCommitSchemaValidator<{ message: string }>();
  const entryCount = journal.current?.length ?? 0;
  const promptSummary = `commit entries=${entryCount} schema=${schema.id}`;

  const promptLines: string[] = [
    "You are CommitSmith Codex.",
    `Act as an expert release engineer generating a commit message that satisfies schema ${schema.id}.`,
    "",
    "Journal entries:",
    ...(journal.current ?? []).map(
      (entry, index) => `${index + 1}. ${entry}`,
    ),
  ];

  if (journal.meta && Object.keys(journal.meta).length > 0) {
    promptLines.push("", "Metadata:");
    for (const [key, value] of Object.entries(journal.meta)) {
      promptLines.push(`- ${key}: ${String(value)}`);
    }
  }

  promptLines.push(
    "",
    "Reply with JSON matching the schema and include only fields described therein.",
  );

  const payload = {
    schema: schema.id,
    prompt: promptLines.join("\n"),
    context: {
      journal,
    },
  };

  return {
    kind: "commit",
    operation: "commit",
    schema,
    prompt: payload.prompt,
    promptSummary,
    payload,
    context: {
      journalEntries: entryCount,
    },
  };
}

export function buildFixPrompt(
  context: FixContext,
): CodexPromptInvocation<{
  diff: string;
  meta?: Record<string, unknown>;
}> {
  const schema = getFixSchemaValidator<{
    diff: string;
    meta?: Record<string, unknown>;
  }>();
  const promptSummary = `fix step=${context.step ?? "unknown"} file=${context.filePath} schema=${schema.id}`;
  const promptLines: string[] = [
    "You are CommitSmith Codex.",
    `Generate a unified diff that resolves the failure described below. Your response must be JSON satisfying schema ${schema.id}.`,
    "",
    `Failing step: ${context.step ?? "unknown"}`,
    `File path: ${context.filePath}`,
    "",
    "Failure details:",
    context.errorMessage,
  ];

  if (context.codeSnippet) {
    promptLines.push("", "Code snippet:", context.codeSnippet);
  }

  promptLines.push("", "Return only fields defined in the schema.");

  const payload = {
    schema: schema.id,
    prompt: promptLines.join("\n"),
    context,
  };

  return {
    kind: "fix",
    operation: "fix",
    schema,
    prompt: payload.prompt,
    promptSummary,
    payload,
    context: {
      step: context.step ?? "unknown",
      filePath: context.filePath,
    },
  };
}

export async function recordCliArtifact<T>(
  invocation: CodexPromptInvocation<T>,
  options: CodexExecutionOptions | undefined,
  rawEvents: string[],
  result: T | undefined,
  error?: CodexPromptValidationError,
): Promise<void> {
  if (!options?.recordArtifact) {
    return;
  }

  const artifact: CodexCliArtifact = {
    kind: invocation.kind,
    schemaId: invocation.schema.id,
    prompt: invocation.prompt,
    promptSummary: invocation.promptSummary,
    rawEvents,
    result,
    error: error
      ? {
          message: error.message,
          issues: error.issues,
        }
      : undefined,
    context: invocation.context,
  };

  await options.recordArtifact(artifact);
}

export function parseCliResult<T>(
  invocation: CodexPromptInvocation<T>,
  value: unknown,
): T {
  try {
    return invocation.schema.parse(value);
  } catch (error) {
    if (error instanceof CodexSchemaValidationError) {
      throw new CodexPromptValidationError(
        invocation.schema.id,
        invocation.promptSummary,
        error.issues,
      );
    }
    throw error;
  }
}
