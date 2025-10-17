import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import * as vscode from "vscode";
import { getConfig } from "./config";
import { getOutputChannel } from "./output";
import { JournalData } from "./journal";
import type { CodexExecutionOptions } from "./codexCli/prompts";
import {
  CodexPromptValidationError,
  buildCommitPrompt,
  buildFixPrompt,
  parseCliResult,
  recordCliArtifact,
} from "./codexCli/prompts";

export type { CodexExecutionOptions } from "./codexCli/prompts";

const DEFAULT_CLI_TIMEOUT_MS = 120000;
const DEFAULT_CLI_BINARY = "codex";
const HOMEBREW_CLI_PATH = "/opt/homebrew/bin/codex";
const MAX_PROMPT_LOG_LENGTH = 2000;
const MAX_CLI_LOG_LENGTH = 20000;

export type PipelineStep = "format" | "typecheck" | "tests";

export interface FixContext {
  readonly filePath: string;
  readonly errorMessage: string;
  readonly codeSnippet?: string;
  readonly step?: PipelineStep;
}

export type AIPatch = {
  kind: "unified-diff";
  diff: string;
  meta?: {
    producedBy?: string;
    step?: PipelineStep;
    note?: string;
  };
};

export type CodexOfflineFallbackReason =
  | "timeout"
  | "network"
  | "http";

export interface CodexOfflineFallbackEvent {
  readonly reason: CodexOfflineFallbackReason;
  readonly status?: number;
  readonly error?: Error;
}

type CodexOperation = "commit" | "fix";

type CodexCliEvent<T> =
  | { type: "result"; payload: T }
  | { type: "log"; message?: string }
  | { type: "reasoning"; message?: string }
  | { type: "message"; message?: string }
  | { type: "error"; message?: string };

interface CodexCliRequest {
  readonly model: string;
  readonly operation: CodexOperation;
  readonly payload: unknown;
}

const offlineFallbackEmitter =
  new vscode.EventEmitter<CodexOfflineFallbackEvent>();
export const onCodexOfflineFallback = offlineFallbackEmitter.event;

export async function generateCommitMessage(
  journal: JournalData,
  options?: CodexExecutionOptions,
): Promise<string> {
  const invocation = buildCommitPrompt(journal);
  logPromptPreview("Commit", invocation.prompt, options?.log);
  const rawEvents: string[] = [];
  const response = await runCodexCli<unknown>(
    invocation.operation,
    invocation.payload,
    {
      onEvent: (line) => rawEvents.push(line),
      execution: options,
    },
  );

  try {
    const parsed = parseCliResult(
      invocation,
      response,
    ) as CommitResponse;
    await recordCliArtifact(invocation, options, rawEvents, parsed);
    return parsed.message.trim();
  } catch (error) {
    const recovered = extractCommitResultFromEvents(rawEvents);
    if (recovered) {
      log(
        "[Codex] CLI provided a commit message before failing; using recovered message.",
      );
      logCliDiagnostics(rawEvents);
      await recordCliArtifact(
        invocation,
        options,
        rawEvents,
        recovered,
        error instanceof CodexPromptValidationError
          ? error
          : undefined,
      );
      return recovered.message.trim();
    }
    if (error instanceof CodexPromptValidationError) {
      await recordCliArtifact(
        invocation,
        options,
        rawEvents,
        undefined,
        error,
      );
      emitValidationFallback(error);
      logCliDiagnostics(rawEvents);
      throw error;
    }
    logCliDiagnostics(rawEvents);
    throw error;
  }
}

export async function generateFix(
  context: FixContext,
  options?: CodexExecutionOptions,
): Promise<AIPatch> {
  const invocation = buildFixPrompt(context);
  logPromptPreview("Fix", invocation.prompt, options?.log);
  const rawEvents: string[] = [];
  const response = await runCodexCli<unknown>(
    invocation.operation,
    invocation.payload,
    {
      onEvent: (line) => rawEvents.push(line),
      execution: options,
    },
  );

  try {
    const parsed = parseCliResult(
      invocation,
      response,
    ) as FixResponse;
    validateUnifiedDiff(parsed.diff);
    const meta = normalizeFixMeta(parsed.meta);
    await recordCliArtifact(invocation, options, rawEvents, {
      diff: parsed.diff,
      meta,
    });

    return {
      kind: "unified-diff",
      diff: parsed.diff,
      meta,
    };
  } catch (error) {
    if (error instanceof CodexPromptValidationError) {
      await recordCliArtifact(
        invocation,
        options,
        rawEvents,
        undefined,
        error,
      );
      emitValidationFallback(error);
    }
    throw error;
  }
}

function logPromptPreview(
  label: string,
  prompt: string,
  forwardLog?: (message: string) => void,
): void {
  logMultilineBlock(
    `${label} prompt`,
    prompt,
    MAX_PROMPT_LOG_LENGTH,
    forwardLog,
  );
}

function logMultilineBlock(
  label: string,
  text: string,
  limit: number,
  forwardLog?: (message: string) => void,
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }

  const truncated = trimmed.length > limit;
  const body = truncated
    ? `${trimmed.slice(0, limit)}...(truncated)`
    : trimmed;
  const message = `[Codex] ${label} (${truncated ? "truncated" : "full"}):\n${body}`;
  log(message);
  forwardLog?.(message);
}

function extractCommitResultFromEvents(
  events: string[],
): CommitResponse | undefined {
  if (!events || events.length === 0) {
    return undefined;
  }

  let commitFromCommand: string | undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = safeParseCliEvent(events[index]);
    if (!event) {
      continue;
    }

    if (
      event.type === "result" &&
      event.payload &&
      typeof event.payload.message === "string"
    ) {
      return { message: event.payload.message };
    }

    if (
      event.type === "item.started" &&
      typeof event.item?.command === "string"
    ) {
      const commandMessage = extractCommitMessageFromCommand(
        event.item.command,
      );
      if (commandMessage) {
        commitFromCommand = commandMessage;
      }
    }
  }

  if (commitFromCommand) {
    return { message: commitFromCommand };
  }

  return undefined;
}

function logCliDiagnostics(events: string[]): void {
  if (!events || events.length === 0) {
    return;
  }

  const diagnostics: string[] = [];
  for (const raw of events) {
    const event = safeParseCliEvent(raw);
    if (!event) {
      continue;
    }

    if (event.type === "error" && typeof event.message === "string") {
      diagnostics.push(event.message.trim());
      continue;
    }

    if (
      event.type === "item.completed" &&
      typeof event.item?.aggregated_output === "string"
    ) {
      const output = event.item.aggregated_output.trim();
      if (
        output.length > 0 &&
        (event.item.status === "failed" ||
          /\bfatal\b/i.test(output) ||
          /Operation not permitted/i.test(output))
      ) {
        diagnostics.push(
          [
            event.item.command ? `> ${event.item.command}` : "",
            output,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }
  }

  if (diagnostics.length > 0) {
    logMultilineBlock(
      "Commit CLI diagnostics",
      diagnostics.join("\n\n"),
      MAX_CLI_LOG_LENGTH,
    );
  }
}

function safeParseCliEvent(raw: string): any | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractCommitMessageFromCommand(
  command: string,
): string | undefined {
  if (!command.includes("git commit")) {
    return undefined;
  }

  const doubleQuoted = command.match(
    /git\s+commit[^"]*?-a?m\s+"([^"]+)"/,
  );
  if (doubleQuoted?.[1]) {
    return doubleQuoted[1];
  }

  const singleQuoted = command.match(
    /git\s+commit[^']*?-a?m\s+'([^']+)'/,
  );
  if (singleQuoted?.[1]) {
    return singleQuoted[1];
  }

  return undefined;
}

interface CommitResponse {
  readonly message: string;
}

interface FixResponse {
  readonly diff: string;
  readonly meta?: Record<string, unknown>;
}

function validateUnifiedDiff(diff: unknown): asserts diff is string {
  if (typeof diff !== "string" || diff.trim().length === 0) {
    throw new Error("Codex returned an empty diff.");
  }

  const headerMatch = diff.match(
    /^---\s+(?<from>\S+)\n\+\+\+\s+(?<to>\S+)/,
  );
  if (!headerMatch || !headerMatch.groups) {
    throw new Error("Codex diff output is missing standard headers.");
  }

  const { from, to } = headerMatch.groups;
  const fromInfo = normalizeDiffPath(from, "a");
  const toInfo = normalizeDiffPath(to, "b");

  if (fromInfo?.containsTraversal || fromInfo?.isAbsolute) {
    throw new Error(
      "Codex diff paths must not contain parent directory traversals or absolute paths.",
    );
  }

  if (toInfo?.containsTraversal || toInfo?.isAbsolute) {
    throw new Error(
      "Codex diff paths must not contain parent directory traversals or absolute paths.",
    );
  }
}

function normalizeDiffPath(
  value: string,
  expectedPrefix: "a" | "b",
): { containsTraversal: boolean; isAbsolute: boolean } | null {
  if (value === "/dev/null") {
    return null;
  }

  if (!value.startsWith(`${expectedPrefix}/`)) {
    throw new Error(
      "Codex diff must use repository-relative paths with a/ and b/ prefixes or /dev/null.",
    );
  }

  const pathPart = value.slice(2);
  return {
    containsTraversal: pathPart.includes(".."),
    isAbsolute: pathPart.startsWith("/"),
  };
}

function log(message: string): void {
  getOutputChannel().appendLine(message);
}

interface RunCodexCliOptions {
  readonly onEvent?: (line: string) => void;
  readonly execution?: CodexExecutionOptions;
}

async function runCodexCli<T>(
  operation: CodexOperation,
  payload: unknown,
  options?: RunCodexCliOptions,
): Promise<T> {
  const config = getConfig();
  const request: CodexCliRequest = {
    model: config.codexModel,
    operation,
    payload,
  };

  const binary = resolveCodexBinary(config.codexBinaryPath);
  const sandboxMode =
    operation === "commit" ? "read-only" : "workspace-write";
  const args = [
    "exec",
    operation,
    "--json",
    "--sandbox",
    sandboxMode,
    "--model",
    config.codexModel,
    ...config.codexExtraArgs,
  ];

  if (config.codexSerenaOverride) {
    args.push(
      "-c",
      `mcp_servers.serena=${config.codexSerenaOverride}`,
    );
  }

  const mcpOverrides = getMcpOverrideArgs(config);
  if (mcpOverrides.length > 0) {
    args.push(...mcpOverrides);
  }

  const hasReasoningOverride = config.codexExtraArgs.some((arg) =>
    arg.includes("reasoning.level"),
  );
  if (!hasReasoningOverride) {
    args.push(
      "-c",
      `reasoning.level="${config.codexReasoningLevel}"`,
    );
  }

  if (options?.execution?.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  log(
    `[Codex] exec ${operation} model=${config.codexModel} binary=${binary}`,
  );

  const progressTitle =
    operation === "fix"
      ? "CommitSmith Codex: applying automated fix"
      : "CommitSmith Codex: generating commit message";

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Contacting Codex CLI…" });

      return new Promise<T>((resolve, reject) => {
        let stdoutBuffer = "";
        let stderrBuffer = "";
        const rawStdoutChunks: string[] = [];
        const rawStderrChunks: string[] = [];
        let resultPayload: T | undefined;
        let cliError: Error | undefined;
        let settled = false;
        let didTimeout = false;
        let emittedFallback = false;
        let loggedCliOutput = false;

        const logCliFailureOutputOnce = () => {
          if (loggedCliOutput) {
            return;
          }
          loggedCliOutput = true;
          const stdoutText = rawStdoutChunks.join("") || stdoutBuffer;
          const stderrText = rawStderrChunks.join("") || stderrBuffer;
          logMultilineBlock(
            "CLI stdout",
            stdoutText,
            MAX_CLI_LOG_LENGTH,
          );
          logMultilineBlock(
            "CLI stderr",
            stderrText,
            MAX_CLI_LOG_LENGTH,
          );
        };

        const child = spawn(binary, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
          cwd: options?.execution?.workingDirectory ?? process.cwd(),
          windowsHide: true,
        });

        const timeoutMs = selectCodexTimeout(config);

        const timeoutHandle = setTimeout(() => {
          if (settled) {
            return;
          }
          didTimeout = true;
          progress.report({
            message: "Codex CLI timed out – cancelling request…",
          });
          child.kill();
        }, timeoutMs);

        child.on("error", (error: NodeJS.ErrnoException) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutHandle);
          const enriched =
            error.code === "ENOENT"
              ? new Error(
                  `Codex CLI binary "${binary}" was not found on PATH.`,
                )
              : error;
          if (error.code === "ENOENT") {
            logCliGuidance("missing-binary");
          }
          logCliFailureOutputOnce();
          emitFallbackOnce("network", enriched);
          progress.report({ message: enriched.message });
          reject(enriched);
        });

        const stdout = child.stdout;
        if (stdout) {
          stdout.setEncoding("utf8");
          stdout.on("data", (chunk: string) => {
            rawStdoutChunks.push(chunk);
            stdoutBuffer += chunk;
            stdoutBuffer = processCliLines(stdoutBuffer, (line) => {
              options?.onEvent?.(line);
              try {
                const event = JSON.parse(line) as CodexCliEvent<T>;
                handleCliEvent(event);
              } catch (error) {
                log(`[Codex] Received malformed CLI event: ${line}`);
                progress.report({ message: line });
              }
            });
          });
        }

        const stderr = child.stderr;
        if (stderr) {
          stderr.setEncoding("utf8");
          stderr.on("data", (chunk: string) => {
            rawStderrChunks.push(chunk);
            stderrBuffer += chunk;
          });
        }

        const stdin = child.stdin;
        if (stdin) {
          stdin.setDefaultEncoding("utf8");
          stdin.write(JSON.stringify(request));
          stdin.end();
        }

        child.on("close", (code) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutHandle);

          if (stdoutBuffer.trim().length > 0) {
            stdoutBuffer = processCliLines(
              `${stdoutBuffer}\n`,
              (line) => {
                options?.onEvent?.(line);
                try {
                  const event = JSON.parse(line) as CodexCliEvent<T>;
                  handleCliEvent(event);
                } catch (error) {
                  log(
                    `[Codex] Received malformed CLI event: ${line}`,
                  );
                  progress.report({ message: line });
                }
              },
            );
          }

          if (didTimeout) {
            const timeoutError = new Error(
              `Codex CLI timed out after ${timeoutMs}ms`,
            );
            logCliFailureOutputOnce();
            emitFallbackOnce("timeout", timeoutError);
            progress.report({ message: timeoutError.message });
            return reject(timeoutError);
          }

          if (cliError) {
            logCliFailureOutputOnce();
            emitFallbackOnce("network", cliError);
            progress.report({ message: cliError.message });
            return reject(cliError);
          }

          if (code !== 0) {
            const stderrText = stderrBuffer.trim();
            const error = new Error(
              stderrText
                ? `Codex CLI failed: ${stderrText}`
                : `Codex CLI exited with code ${code}`,
            );
            if (stderrText && looksLikeAuthError(stderrText)) {
              logCliGuidance("auth");
            } else if (
              stderrText &&
              looksLikeMissingBinary(stderrText)
            ) {
              logCliGuidance("missing-binary");
            }
            logCliFailureOutputOnce();
            emitFallbackOnce("network", error);
            progress.report({ message: error.message });
            return reject(error);
          }

          if (typeof resultPayload === "undefined") {
            const error = new Error(
              "Codex CLI did not return a result payload.",
            );
            logCliFailureOutputOnce();
            emitFallbackOnce("network", error);
            progress.report({ message: error.message });
            return reject(error);
          }

          progress.report({ message: "Codex response received." });
          resolve(resultPayload);
        });

        function handleCliEvent(event: CodexCliEvent<T>): void {
          if (event.type === "result") {
            resultPayload = event.payload;
            return;
          }

          if (event.type === "error") {
            cliError = new Error(
              event.message ?? "Codex CLI reported an error event.",
            );
            progress.report({ message: cliError.message });
            return;
          }

          if (
            event.type === "log" ||
            event.type === "reasoning" ||
            event.type === "message"
          ) {
            if (event.message) {
              log(`[Codex] ${event.message}`);
              progress.report({ message: event.message });
            }
          }
        }

        function emitFallbackOnce(
          reason: CodexOfflineFallbackReason,
          error: Error,
        ): void {
          if (!emittedFallback) {
            emittedFallback = true;
            offlineFallbackEmitter.fire({ reason, error });
            log(`[Codex] Request failed: ${error.message}`);
            progress.report({ message: error.message });
          }
        }
      });
    },
  );
}

function processCliLines(
  buffer: string,
  onLine: (line: string) => void,
): string {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    onLine(trimmed);
  }
  return remainder;
}

function selectCodexTimeout(
  config: ReturnType<typeof getConfig>,
): number {
  const baseTimeout =
    (config.codexTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS) ||
    DEFAULT_CLI_TIMEOUT_MS;

  if (isSerenaEnvironment()) {
    const serenaTimeout = config.codexSerenaTimeoutMs ?? baseTimeout;
    return serenaTimeout > 0 ? serenaTimeout : baseTimeout;
  }

  return baseTimeout > 0 ? baseTimeout : DEFAULT_CLI_TIMEOUT_MS;
}

function isSerenaEnvironment(): boolean {
  if (process.env.SERENA || process.env.SERENA_SESSION) {
    return true;
  }
  return Object.keys(process.env).some((key) =>
    key.toUpperCase().startsWith("SERENA_"),
  );
}

let cachedMcpServers: string[] | undefined;

function getMcpOverrideArgs(
  config: ReturnType<typeof getConfig>,
): string[] {
  const whitelist = (config.codexMcpWhitelist ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (whitelist.length === 0) {
    return [];
  }

  const whitelistByLower = new Map<string, string>();
  for (const name of whitelist) {
    const lower = name.toLowerCase();
    if (!whitelistByLower.has(lower)) {
      whitelistByLower.set(lower, name);
    }
  }

  const discovered = discoverConfiguredMcpServers();
  const canonicalByLower = new Map<string, string>();
  for (const name of discovered) {
    const lower = name.toLowerCase();
    if (!canonicalByLower.has(lower)) {
      canonicalByLower.set(lower, name);
    }
  }

  for (const [lower, original] of whitelistByLower) {
    if (!canonicalByLower.has(lower)) {
      canonicalByLower.set(lower, original);
    }
  }

  const entries = Array.from(canonicalByLower.entries()).sort(
    (a, b) => a[1].localeCompare(b[1]),
  );

  const overrides: string[] = [];
  for (const [lower, canonical] of entries) {
    const enabled = whitelistByLower.has(lower);
    overrides.push(
      "-c",
      `mcp_servers.${canonical}.enabled=${enabled ? "true" : "false"}`,
    );
  }

  return overrides;
}

function discoverConfiguredMcpServers(): string[] {
  if (cachedMcpServers) {
    return cachedMcpServers;
  }

  const configPath = resolveCodexConfigPath();
  if (!configPath) {
    cachedMcpServers = [];
    return cachedMcpServers;
  }

  try {
    const contents = readFileSync(configPath, "utf8");
    const regex = /mcp_servers\.([A-Za-z0-9_-]+)/gi;
    const names = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(contents)) !== null) {
      const name = match[1];
      if (name) {
        names.add(name);
      }
    }
    cachedMcpServers = Array.from(names);
    return cachedMcpServers;
  } catch {
    cachedMcpServers = [];
    return cachedMcpServers;
  }
}

function resolveCodexConfigPath(): string | undefined {
  const codexHome =
    process.env.CODEX_HOME && process.env.CODEX_HOME.trim().length > 0
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), ".codex");

  const configPath = path.join(codexHome, "config.toml");
  try {
    accessSync(configPath, fsConstants.F_OK);
    return configPath;
  } catch {
    return undefined;
  }
}

function resolveCodexBinary(configured: string | null): string {
  const fromSettings = configured?.trim();
  if (fromSettings) {
    return fromSettings;
  }

  const fromEnv = process.env.CODEX_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const discovered = findCodexBinaryOnPath(DEFAULT_CLI_BINARY);
  if (discovered) {
    return discovered;
  }

  if (
    process.platform === "darwin" &&
    fileExists(HOMEBREW_CLI_PATH)
  ) {
    return HOMEBREW_CLI_PATH;
  }

  return DEFAULT_CLI_BINARY;
}

function logCliGuidance(kind: "missing-binary" | "auth"): void {
  const installDocs = "https://docs.cursor.com/codex-cli/install";
  const authDocs = "https://docs.cursor.com/codex-cli/auth";

  if (kind === "missing-binary") {
    log(
      `[Codex ⚠️] Codex CLI not found. Install the CLI: ${installDocs} · Authenticate afterwards: ${authDocs}`,
    );
  } else {
    log(
      `[Codex ⚠️] Codex CLI authentication required. Authenticate with the CLI: ${authDocs} · Install docs: ${installDocs}`,
    );
  }
}

function looksLikeAuthError(message: string): boolean {
  return /auth|unauthori[sz]ed|login|token/i.test(message);
}

function looksLikeMissingBinary(message: string): boolean {
  return /not found|ENOENT|command not found/i.test(message);
}

/** @internal */
export const __codexTestUtils = {
  resolveCodexBinaryForTest: resolveCodexBinary,
  looksLikeAuthErrorForTest: looksLikeAuthError,
  looksLikeMissingBinaryForTest: looksLikeMissingBinary,
};

function findCodexBinaryOnPath(
  executable: string,
): string | undefined {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  const directories = pathValue
    .split(path.delimiter)
    .filter((dir) => dir.length > 0);
  if (directories.length === 0) {
    return undefined;
  }

  if (process.platform === "win32") {
    const pathExt = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
    const extensions = pathExt
      .split(";")
      .filter((ext) => ext.length > 0);
    for (const directory of directories) {
      for (const extension of extensions) {
        const normalizedExtension = extension.startsWith(".")
          ? extension
          : `.${extension}`;
        const candidate = path.join(
          directory,
          `${executable}${normalizedExtension}`,
        );
        if (fileExists(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function fileExists(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeFixMeta(
  meta: Record<string, unknown> | undefined,
): AIPatch["meta"] | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }

  const normalized: AIPatch["meta"] = {};

  if (
    typeof meta.producedBy === "string" &&
    meta.producedBy.trim().length > 0
  ) {
    normalized.producedBy = meta.producedBy;
  }

  if (typeof meta.note === "string" && meta.note.trim().length > 0) {
    normalized.note = meta.note;
  }

  if (typeof meta.step === "string" && isPipelineStep(meta.step)) {
    normalized.step = meta.step;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isPipelineStep(value: string): value is PipelineStep {
  return (
    value === "format" || value === "typecheck" || value === "tests"
  );
}

function emitValidationFallback(
  error: CodexPromptValidationError,
): void {
  offlineFallbackEmitter.fire({ reason: "network", error });
  log(
    `[Codex] Schema validation failed (${error.schemaId}): ${error.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
  );
}
