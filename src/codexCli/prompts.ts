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
  readonly log?: (message: string) => void;
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
    `Return only JSON that satisfies schema ${schema.id}. Do not run commands that modify the repository (e.g. 'git commit', 'git push').`,
    "Craft a clear subject and body that communicate both what changed and why it matters.",
    "If you need more detail you may run read-only commands such as 'git status --short', 'git diff --cached', or 'cat <file>', but never modify files.",
    "Focus on the files and topics mentioned in the journal. Avoid broad directory listings (e.g. 'ls') or large documentation reads unless a journal entry explicitly points to them.",
    "Journal entries are already collected for you; do not run `commit-smith` commands or write to `.ai-commit-journal.yml`.",
    "",
    "Journal entries:",
    ...(journal.current ?? []).map((entry, index) => {
      const fileLabel =
        entry?.file && entry.file.length > 0
          ? `${entry.file} — `
          : "";
      const message = entry?.message ?? "";
      return `${index + 1}. ${fileLabel}${message}`.trim();
    }),
  ];

  if (journal.meta && Object.keys(journal.meta).length > 0) {
    promptLines.push("", "Metadata:");
    for (const [key, value] of Object.entries(journal.meta)) {
      if (key === "stagedFiles") {
        continue;
      }
      promptLines.push(`- ${key}: ${String(value)}`);
    }
  }

  const stagedFilesMeta = journal.meta?.stagedFiles;
  if (Array.isArray(stagedFilesMeta)) {
    const stagedFiles = stagedFilesMeta
      .map((file) =>
        typeof file === "string" ? file.trim() : String(file),
      )
      .filter((file) => file.length > 0);
    if (stagedFiles.length > 0) {
      promptLines.push("", "Staged files to emphasise:");
      for (const file of stagedFiles) {
        promptLines.push(`- ${file}`);
      }
    }
  }

  promptLines.push(
    "",
    "Reply with JSON matching the schema and include only fields described therein.",
    "Summarise the most important technical changes and their motivations so the message reads well even without additional context.",
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
    "",
    "Inspect only the files necessary to address this failure. Avoid broad repo listings (e.g. 'ls') or unrelated documentation reads.",
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
