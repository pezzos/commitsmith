import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import * as vscode from "vscode";
import { getConfig } from "./config";
import type { CommitSmithConfig } from "./config";
import { appendDebugLine, getOutputChannel } from "./output";
import { JournalData } from "./journal";
import type {
  CodexExecutionOptions,
  CodexPromptInvocation,
} from "./codexCli/prompts";
import {
  CodexPromptValidationError,
  buildCommitPrompt,
  buildFixPrompt,
  parseCliResult,
  recordCliArtifact,
} from "./codexCli/prompts";
import { recordTelemetry } from "./telemetry";

export type { CodexExecutionOptions } from "./codexCli/prompts";

const DEFAULT_CLI_TIMEOUT_MS = 120000;
const DEFAULT_CLI_BINARY = "codex";
const HOMEBREW_CLI_PATH = "/opt/homebrew/bin/codex";
const MAX_PROMPT_LOG_LENGTH = 2000;
const MAX_CLI_LOG_LENGTH = 20000;
const MIN_CODEX_CLI_VERSION = "0.6.0";
const CODEX_CLI_VERSION_TIMEOUT_MS = 5000;

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
type CodexAdoptionEntrypoint = "commit" | "fix" | "diagnostics";

interface CodexCliItem {
  readonly id?: string;
  readonly type?: string;
  readonly text?: string;
  readonly command?: string;
  readonly status?: string;
  readonly aggregated_output?: string;
  readonly output_text?: string | string[];
  readonly output?: unknown;
}

type CodexCliEvent<T> =
  | { type: "result"; payload: T }
  | { type: "log"; message?: string }
  | { type: "reasoning"; message?: string }
  | { type: "message"; message?: string }
  | { type: "error"; message?: string }
  | { type: "item.started"; item?: CodexCliItem }
  | { type: "item.completed"; item?: CodexCliItem }
  | { type: "thread.started"; thread_id?: string }
  | {
      type: "turn.started" | "turn.completed";
      usage?: unknown;
      [key: string]: unknown;
    };

interface CodexCliRequest {
  readonly model: string;
  readonly operation: CodexOperation;
  readonly payload: unknown;
}

const offlineFallbackEmitter =
  new vscode.EventEmitter<CodexOfflineFallbackEvent>();
export const onCodexOfflineFallback = offlineFallbackEmitter.event;

type CodexInvocationPath = "new";
type CodexInvocationOutcome = "success" | "error" | "fallback";

export interface CodexInvocationMetrics {
  readonly id: string;
  readonly operation: CodexOperation;
  readonly path: CodexInvocationPath;
  readonly durationMs: number;
  readonly startedAt: number;
  readonly promptBytes: number;
  readonly outcome: CodexInvocationOutcome;
  readonly fallbackReason?: CodexOfflineFallbackReason;
  readonly errorMessage?: string;
}

interface CodexInvocationResult<T> {
  readonly payload: T;
  readonly metrics: CodexInvocationMetrics;
}

export interface CommitMessageResult {
  readonly message: string;
  readonly invocation: CodexInvocationMetrics;
  readonly artifactRecorded: boolean;
  readonly artifactDurationMs?: number;
}

export class CodexInvocationError extends Error {
  readonly metrics: CodexInvocationMetrics;
  readonly cause?: Error;

  constructor(
    message: string,
    metrics: CodexInvocationMetrics,
    cause?: Error,
  ) {
    super(message);
    this.name = "CodexInvocationError";
    this.metrics = metrics;
    this.cause = cause;
  }
}

const CODEX_INVOCATION_SCHEMA_VERSION = 1;
const CODEX_ARTIFACT_SCHEMA_VERSION = 1;

class CodexCliCompatibilityError extends Error {
  readonly version?: string;

  constructor(message: string, version?: string) {
    super(message);
    this.name = "CodexCliCompatibilityError";
    this.version = version;
  }
}

const codexCompatibilityChecks = new Map<
  string,
  Promise<string | undefined>
>();

export async function generateCommitMessage(
  journal: JournalData,
  options?: CodexExecutionOptions,
): Promise<CommitMessageResult> {
  const invocation = buildCommitPrompt(journal);
  logPromptPreview("Commit", invocation.prompt, options?.log);
  recordCodexAdoptionTelemetry("commit");
  const rawEvents: string[] = [];
  const { payload: response, metrics } = await runCodexCli<unknown>(
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
    const artifactTelemetry = await recordArtifactWithMetrics(
      invocation,
      options,
      rawEvents,
      parsed,
      metrics,
    );
    return {
      message: parsed.message.trim(),
      invocation: metrics,
      artifactRecorded: artifactTelemetry.recorded,
      artifactDurationMs: artifactTelemetry.durationMs,
    };
  } catch (error) {
    const recovered = extractCommitResultFromEvents(rawEvents);
    if (recovered) {
      log(
        "[Codex] CLI provided a commit message before failing; using recovered message.",
      );
      logCliDiagnostics(rawEvents);
      const artifactTelemetry = await recordArtifactWithMetrics(
        invocation,
        options,
        rawEvents,
        recovered,
        metrics,
        error instanceof CodexPromptValidationError
          ? error
          : undefined,
      );
      return {
        message: recovered.message.trim(),
        invocation: metrics,
        artifactRecorded: artifactTelemetry.recorded,
        artifactDurationMs: artifactTelemetry.durationMs,
      };
    }
    if (error instanceof CodexPromptValidationError) {
      await recordArtifactWithMetrics(
        invocation,
        options,
        rawEvents,
        undefined,
        metrics,
        error,
      );
      emitValidationFallback(error);
      logCliDiagnostics(rawEvents);
      throw error;
    }
    logCliDiagnostics(rawEvents);
    recordCodexArtifactTelemetry({
      invocationId: metrics.id,
      kind: invocation.kind,
      durationMs: 0,
      path: metrics.path,
      recorded: false,
    });
    throw error;
  }
}

export async function generateFix(
  context: FixContext,
  options?: CodexExecutionOptions,
): Promise<AIPatch> {
  const invocation = buildFixPrompt(context);
  logPromptPreview("Fix", invocation.prompt, options?.log);
  recordCodexAdoptionTelemetry("fix");
  const rawEvents: string[] = [];
  const { payload: response, metrics } = await runCodexCli<unknown>(
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
    await recordArtifactWithMetrics(
      invocation,
      options,
      rawEvents,
      {
        diff: parsed.diff,
        meta,
      },
      metrics,
    );

    return {
      kind: "unified-diff",
      diff: parsed.diff,
      meta,
    };
  } catch (error) {
    if (error instanceof CodexPromptValidationError) {
      await recordArtifactWithMetrics(
        invocation,
        options,
        rawEvents,
        undefined,
        metrics,
        error,
      );
      emitValidationFallback(error);
    } else {
      recordCodexArtifactTelemetry({
        invocationId: metrics.id,
        kind: invocation.kind,
        durationMs: 0,
        path: metrics.path,
        recorded: false,
      });
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
  if (logDebug(message)) {
    forwardLog?.(message);
  }
}

function extractCommitResultFromEvents(
  events: string[],
): CommitResponse | undefined {
  if (!events || events.length === 0) {
    return undefined;
  }

  let commitFromCommand: string | undefined;
  const parsedEvents: CodexCliEvent<unknown>[] = [];

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = safeParseCliEvent(events[index]);
    if (!event) {
      continue;
    }

    parsedEvents.push(event);

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

    if (event.type === "item.completed") {
      const commit = coerceCommitResponseFromItem(event.item);
      if (commit) {
        return commit;
      }
    }
  }

  if (commitFromCommand) {
    return { message: commitFromCommand };
  }

  if (shouldDebugEvents()) {
    const tail = events.slice(-5).join("\n");
    logMultilineBlock(
      "Commit CLI events (tail)",
      tail,
      MAX_CLI_LOG_LENGTH,
    );
    const parsedTail = parsedEvents
      .slice(0, 5)
      .map((event) => JSON.stringify(event))
      .join("\n");
    logMultilineBlock(
      "Commit CLI parsed events (tail)",
      parsedTail,
      MAX_CLI_LOG_LENGTH,
    );
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

function shouldDebugEvents(): boolean {
  const flag = process.env.CODEX_DEBUG;
  if (!flag) {
    return false;
  }
  return flag
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((value) => value.toLowerCase() === "events");
}

function logRawEvent(line: string): void {
  const timestamp = new Date().toISOString();
  logDebug(`[Codex][raw-event][${timestamp}] ${line}`);
}

function safeParseCliEvent(raw: string): any | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAgentMessageText(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isObjectRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function coerceCommitResponseFromAgentMessage(
  parsed: Record<string, unknown>,
): CommitResponse | undefined {
  if (typeof parsed.message === "string") {
    const message = parsed.message.trim();
    if (message.length === 0) {
      return undefined;
    }
    const meta = isObjectRecord(parsed.meta)
      ? (parsed.meta as Record<string, unknown>)
      : undefined;
    return meta ? { message, meta } : { message };
  }

  const subject =
    typeof parsed.subject === "string"
      ? parsed.subject.trim()
      : typeof parsed.title === "string"
        ? parsed.title.trim()
        : "";

  let body = "";
  if (typeof parsed.body === "string") {
    body = parsed.body.trim();
  } else if (Array.isArray(parsed.body)) {
    body = parsed.body
      .filter((entry) => typeof entry === "string")
      .join("\n")
      .trim();
  } else if (Array.isArray(parsed.lines)) {
    body = parsed.lines
      .filter((entry) => typeof entry === "string")
      .join("\n")
      .trim();
  }

  if (subject.length === 0 && body.length === 0) {
    return undefined;
  }

  const message =
    body.length > 0 ? `${subject}\n\n${body}`.trim() : subject;
  const meta = isObjectRecord(parsed.meta)
    ? (parsed.meta as Record<string, unknown>)
    : undefined;
  return meta ? { message, meta } : { message };
}

function coerceCommitResponseFromItem(
  item: CodexCliItem | undefined,
): CommitResponse | undefined {
  if (!item || item.type !== "agent_message") {
    return undefined;
  }
  const parsed = parseAgentMessageText(item.text);
  if (!parsed) {
    if (typeof item.text === "string") {
      const fallback = item.text.trim();
      if (fallback.length > 0) {
        return { message: fallback };
      }
    }
    return undefined;
  }
  return coerceCommitResponseFromAgentMessage(parsed);
}

function coerceCliResultFromItem(
  operation: CodexOperation,
  item: CodexCliItem | undefined,
): unknown | undefined {
  if (!item) {
    return undefined;
  }

  if (operation === "commit") {
    return coerceCommitResponseFromItem(item);
  }

  if (item.type === "agent_message") {
    return parseAgentMessageText(item.text) ?? item.text;
  }

  return undefined;
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
  readonly meta?: Record<string, unknown>;
}

interface FixResponse {
  readonly diff: string;
  readonly meta?: Record<string, unknown>;
}

function validateUnifiedDiff(diff: unknown): asserts diff is string {
  if (typeof diff !== "string" || diff.trim().length === 0) {
    throw new Error("Codex returned an empty diff.");
  }

  const trimmedDiff = stripLeadingDiffMetadata(diff);
  const headerMatch = trimmedDiff.match(
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

function stripLeadingDiffMetadata(diff: string): string {
  const lines = diff.split(/\r?\n/);
  let start = 0;
  while (start < lines.length) {
    const line = lines[start];
    if (line.startsWith("--- ")) {
      break;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.trim().length === 0
    ) {
      start += 1;
      continue;
    }
    break;
  }

  return lines.slice(start).join("\n");
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

function logDebug(message: string): boolean {
  return appendDebugLine(message);
}

interface PromptWriteMetrics {
  readonly writeDurationMs: number;
  readonly waitForDrainMs: number;
}

function writePromptToStdin(
  stdin: Writable,
  payload: string,
): Promise<PromptWriteMetrics> {
  return new Promise((resolve, reject) => {
    stdin.setDefaultEncoding("utf8");
    const writeStart = performance.now();
    let drainStart: number | undefined;
    let waitForDrainMs = 0;

    const handleDrain = () => {
      if (typeof drainStart === "number") {
        waitForDrainMs = performance.now() - drainStart;
      }
    };

    const handleWriteError = (error: Error) => {
      stdin.off("drain", handleDrain);
      reject(error);
    };

    const finalizeWrite = () => {
      stdin.off("error", handleWriteError);
      stdin.off("drain", handleDrain);
      const writeDurationMs = performance.now() - writeStart;
      const handleEndError = (error: Error) => {
        stdin.off("error", handleEndError);
        reject(error);
      };
      stdin.once("error", handleEndError);
      stdin.end(() => {
        stdin.off("error", handleEndError);
        resolve({
          writeDurationMs,
          waitForDrainMs,
        });
      });
    };

    const attemptWrite = () => {
      try {
        const wroteImmediately = stdin.write(
          payload,
          "utf8",
          finalizeWrite,
        );
        if (!wroteImmediately) {
          drainStart = performance.now();
          stdin.once("drain", handleDrain);
        }
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    };

    stdin.once("error", handleWriteError);
    attemptWrite();
  });
}

function recordPromptWriteTelemetry(
  operation: CodexOperation,
  metrics: PromptWriteMetrics,
): void {
  recordTelemetry({
    name: "codexCli.stdinWrite",
    schema: "codex-cli-stdin-write",
    schemaVersion: 1,
    properties: {
      operation,
    },
    measurements: {
      writeMs: Number(metrics.writeDurationMs.toFixed(3)),
      waitForDrainMs: Number(metrics.waitForDrainMs.toFixed(3)),
    },
  });
}

function formatPromptWriteLog(metrics: PromptWriteMetrics): string {
  const { writeDurationMs, waitForDrainMs } = metrics;
  const base = `prompt write completed in ${writeDurationMs.toFixed(1)}ms`;
  if (waitForDrainMs > 0) {
    return `${base} (waited ${waitForDrainMs.toFixed(1)}ms for drain)`;
  }
  return base;
}

async function ensureCodexCliSupportsStdin(
  binary: string,
): Promise<void> {
  let check = codexCompatibilityChecks.get(binary);
  if (!check) {
    check = performCodexCliCompatibilityCheck(binary);
    codexCompatibilityChecks.set(binary, check);
  }
  await check;
}

function performCodexCliCompatibilityCheck(
  binary: string,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      reject(error);
    };
    const succeed = (version?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve(version);
    };

    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      cwd: process.cwd(),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      const combinedOutput = [stdout.trim(), stderr.trim()]
        .filter((part) => part.length > 0)
        .join("\n");

      if (code !== 0) {
        const message =
          combinedOutput.length > 0
            ? `Codex CLI version probe failed: ${combinedOutput}`
            : `Codex CLI version probe exited with code ${code}`;
        fail(new Error(message));
        return;
      }

      const version = parseCodexCliVersion(combinedOutput);
      if (!version) {
        const error = new CodexCliCompatibilityError(
          `Unable to determine Codex CLI version from output: ${combinedOutput || "(empty)"}. Upgrade Codex CLI to version ${MIN_CODEX_CLI_VERSION} or newer.`,
        );
        logCliGuidance("upgrade", {
          binary,
          version: "unknown",
          minimumVersion: MIN_CODEX_CLI_VERSION,
        });
        recordVersionGuardTelemetry(binary, "unparseable");
        fail(error);
        return;
      }

      if (compareSemver(version, MIN_CODEX_CLI_VERSION) < 0) {
        const error = new CodexCliCompatibilityError(
          `Codex CLI binary "${binary}" is out of date (reported ${version}; requires ${MIN_CODEX_CLI_VERSION}+). Upgrade the Codex CLI to continue.`,
          version,
        );
        logCliGuidance("upgrade", {
          binary,
          version,
          minimumVersion: MIN_CODEX_CLI_VERSION,
        });
        recordVersionGuardTelemetry(binary, "outdated", version);
        fail(error);
        return;
      }

      logDebug(
        `[Codex] CLI version ${version} validated for stdin support.`,
      );
      succeed(version);
    });

    timeoutHandle = setTimeout(() => {
      child.kill();
      const error = new CodexCliCompatibilityError(
        `Codex CLI version probe timed out after ${CODEX_CLI_VERSION_TIMEOUT_MS}ms.`,
      );
      recordVersionGuardTelemetry(binary, "timeout");
      fail(error);
    }, CODEX_CLI_VERSION_TIMEOUT_MS);
  });
}

function parseCodexCliVersion(output: string): string | undefined {
  const match = output.match(/v?(\d+\.\d+\.\d+)/);
  return match?.[1];
}

function compareSemver(a: string, b: string): number {
  const parse = (value: string): [number, number, number] => {
    const parts = value.split(".", 3);
    return [
      Number.parseInt(parts[0] ?? "0", 10) || 0,
      Number.parseInt(parts[1] ?? "0", 10) || 0,
      Number.parseInt(parts[2] ?? "0", 10) || 0,
    ];
  };
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);

  if (aMajor !== bMajor) {
    return aMajor - bMajor;
  }
  if (aMinor !== bMinor) {
    return aMinor - bMinor;
  }
  return aPatch - bPatch;
}

type VersionGuardOutcome = "outdated" | "unparseable" | "timeout";

function recordVersionGuardTelemetry(
  binary: string,
  outcome: VersionGuardOutcome,
  version?: string,
): void {
  recordTelemetry({
    name: "codexCli.versionGuard",
    schema: "codex-cli-guard",
    schemaVersion: 1,
    properties: {
      outcome,
      binary,
      reportedVersion: version ?? "unknown",
      minimumRequired: MIN_CODEX_CLI_VERSION,
    },
  });
}

function recordCodexAdoptionTelemetry(
  entrypoint: CodexAdoptionEntrypoint,
): void {
  recordTelemetry({
    name: "codexCli.adoption",
    schema: "codex-cli-adoption",
    schemaVersion: 1,
    properties: {
      entrypoint,
      strategy: "stdin",
    },
  });
}

function recordCodexInvocationTelemetry(
  metrics: CodexInvocationMetrics,
): void {
  recordTelemetry({
    name: "workflow.codexInvocation",
    schema: "workflow.codexInvocation",
    schemaVersion: CODEX_INVOCATION_SCHEMA_VERSION,
    properties: {
      invocationId: metrics.id,
      operation: metrics.operation,
      path: metrics.path,
      outcome: metrics.outcome,
      fallbackReason: metrics.fallbackReason ?? "none",
    },
    measurements: {
      durationMs: Number(metrics.durationMs.toFixed(3)),
      promptBytes: metrics.promptBytes,
    },
  });
}

interface CodexArtifactTelemetry {
  readonly invocationId: string;
  readonly kind: "commit" | "fix";
  readonly durationMs: number;
  readonly path: CodexInvocationPath;
  readonly recorded: boolean;
}

function recordCodexArtifactTelemetry(
  artifact: CodexArtifactTelemetry,
): void {
  recordTelemetry({
    name: "workflow.codexArtifact",
    schema: "workflow.codexArtifact",
    schemaVersion: CODEX_ARTIFACT_SCHEMA_VERSION,
    properties: {
      invocationId: artifact.invocationId,
      kind: artifact.kind,
      path: artifact.path,
      recorded: artifact.recorded ? "true" : "false",
    },
    measurements: {
      durationMs: Number(artifact.durationMs.toFixed(3)),
    },
  });
}

interface ArtifactMetricResult {
  readonly recorded: boolean;
  readonly durationMs?: number;
}

async function recordArtifactWithMetrics<T>(
  invocation: CodexPromptInvocation<T>,
  options: CodexExecutionOptions | undefined,
  rawEvents: string[],
  result: T | undefined,
  invocationMetrics: CodexInvocationMetrics,
  error?: CodexPromptValidationError,
): Promise<ArtifactMetricResult> {
  const shouldRecord = Boolean(options?.recordArtifact);
  let durationMs: number | undefined;
  if (shouldRecord) {
    const start = performance.now();
    await recordCliArtifact(
      invocation,
      options,
      rawEvents,
      result,
      error,
    );
    durationMs = performance.now() - start;
  } else {
    await recordCliArtifact(
      invocation,
      options,
      rawEvents,
      result,
      error,
    );
  }

  recordCodexArtifactTelemetry({
    invocationId: invocationMetrics.id,
    kind: invocation.kind,
    durationMs: durationMs ?? 0,
    path: invocationMetrics.path,
    recorded: shouldRecord,
  });

  return {
    recorded: shouldRecord,
    durationMs,
  };
}

interface RunCodexCliOptions {
  readonly onEvent?: (line: string) => void;
  readonly execution?: CodexExecutionOptions;
}

export async function runCodexCli<T>(
  operation: CodexOperation,
  payload: unknown,
  options?: RunCodexCliOptions,
): Promise<CodexInvocationResult<T>> {
  const config = getConfig();
  return runCodexCliImpl<T>(
    config,
    operation,
    payload,
    options ?? {},
    true,
  );
}

async function runCodexCliImpl<T>(
  config: CommitSmithConfig,
  operation: CodexOperation,
  payload: unknown,
  options: RunCodexCliOptions,
  showProgress: boolean,
): Promise<CodexInvocationResult<T>> {
  const invocationPath: CodexInvocationPath = "new";
  const request: CodexCliRequest = {
    model: config.codexModel,
    operation,
    payload,
  };
  const promptJson = JSON.stringify(request);
  const promptBytes = Buffer.byteLength(promptJson, "utf8");
  const invocationId = randomUUID();
  const startedAt = Date.now();
  const invocationStart = performance.now();
  let fallbackReason: CodexOfflineFallbackReason | undefined;
  let telemetryFinalized = false;
  let recordedMetrics: CodexInvocationMetrics | undefined;
  const effectiveOptions = options ?? {};

  const binary = resolveCodexBinary(config.codexBinaryPath);
  const sandboxMode =
    operation === "commit" ? "read-only" : "workspace-write";
  const debugEvents = shouldDebugEvents();
  const args = ["exec"];

  args.push(
    "--json",
    "--sandbox",
    sandboxMode,
    "--model",
    config.codexModel,
    ...config.codexExtraArgs,
  );

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

  // CommitSmith always runs Codex inside a Git workspace; avoid --skip-git-repo-check to keep parity with the CLI defaults.
  logDebug(
    `[Codex] exec binary=${binary} model=${config.codexModel} operation=${operation} path=${invocationPath}`,
  );
  logDebug(`[Codex] args ${JSON.stringify(args)}`);

  const progressTitle =
    operation === "fix"
      ? "CommitSmith Codex: applying automated fix"
      : "CommitSmith Codex: generating commit message";

  const runWithProgress = async (
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<CodexInvocationResult<T>> => {
    progress.report({ message: "Contacting Codex CLI…" });
    const finalize = (
      outcome: CodexInvocationOutcome,
      error?: Error,
    ): CodexInvocationMetrics => {
      if (telemetryFinalized && recordedMetrics) {
        return recordedMetrics;
      }
      telemetryFinalized = true;
      const durationMs = performance.now() - invocationStart;
      const metrics: CodexInvocationMetrics = {
        id: invocationId,
        operation,
        path: invocationPath,
        durationMs,
        startedAt,
        promptBytes,
        outcome,
        fallbackReason,
        errorMessage: error?.message,
      };
      recordedMetrics = metrics;
      recordCodexInvocationTelemetry(metrics);
      return metrics;
    };

    const rejectWithTelemetry = (
      reject: (reason?: unknown) => void,
      error: Error,
    ): void => {
      const metrics = finalize(
        fallbackReason ? "fallback" : "error",
        error,
      );
      const invocationError = new CodexInvocationError(
        error.message,
        metrics,
        error,
      );
      invocationError.stack = error.stack;
      reject(invocationError);
    };

    try {
      await ensureCodexCliSupportsStdin(binary);
    } catch (error) {
      const message =
        (error as Error)?.message ??
        "Codex CLI compatibility check failed.";
      log(`[Codex] ${message}`);
      progress.report({ message });
      const errObject =
        error instanceof Error ? error : new Error(String(error));
      const metrics = finalize("error", errObject);
      throw new CodexInvocationError(
        errObject.message,
        metrics,
        errObject,
      );
    }

    return new Promise<CodexInvocationResult<T>>(
      (resolve, reject) => {
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

        const emitCliLine = (line: string) => {
          effectiveOptions.onEvent?.(line);
          if (debugEvents) {
            logRawEvent(line);
          }
          try {
            const event = JSON.parse(line) as CodexCliEvent<T>;
            handleCliEvent(event);
          } catch (error) {
            logDebug(`[Codex] Received malformed CLI event: ${line}`);
            progress.report({ message: line });
          }
        };

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
          cwd:
            effectiveOptions.execution?.workingDirectory ??
            process.cwd(),
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
          rejectWithTelemetry(reject, enriched);
        });

        const stdout = child.stdout;
        if (stdout) {
          stdout.setEncoding("utf8");
          stdout.on("data", (chunk: string) => {
            rawStdoutChunks.push(chunk);
            stdoutBuffer += chunk;
            stdoutBuffer = processCliLines(stdoutBuffer, emitCliLine);
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
          writePromptToStdin(stdin, promptJson)
            .then((metrics) => {
              logDebug(`[Codex] ${formatPromptWriteLog(metrics)}.`);
              recordPromptWriteTelemetry(operation, metrics);
            })
            .catch((error) => {
              if (settled) {
                return;
              }
              cliError =
                error instanceof Error
                  ? error
                  : new Error(String(error));
              log(
                `[Codex] Failed to write prompt: ${cliError.message}`,
              );
              progress.report({ message: cliError.message });
              try {
                child.kill();
              } catch {
                // ignore – process may already be terminating
              }
            });
        } else {
          const error = new Error(
            "Codex CLI stdin is not available; cannot send prompt.",
          );
          cliError = error;
          log(`[Codex] ${error.message}`);
          progress.report({ message: error.message });
          try {
            child.kill();
          } catch {
            // ignore
          }
        }

        child.on("close", (code) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutHandle);

          if (stdoutBuffer.trim().length > 0) {
            stdoutBuffer = processCliLines(
              `${stdoutBuffer}
`,
              emitCliLine,
            );
          }

          if (didTimeout) {
            const timeoutError = new Error(
              `Codex CLI timed out after ${timeoutMs}ms`,
            );
            logCliFailureOutputOnce();
            emitFallbackOnce("timeout", timeoutError);
            progress.report({ message: timeoutError.message });
            return rejectWithTelemetry(reject, timeoutError);
          }

          if (cliError) {
            logCliFailureOutputOnce();
            emitFallbackOnce("network", cliError);
            progress.report({ message: cliError.message });
            return rejectWithTelemetry(reject, cliError);
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
            return rejectWithTelemetry(reject, error);
          }

          if (typeof resultPayload === "undefined") {
            const error = new Error(
              "Codex CLI did not return a result payload.",
            );
            logCliFailureOutputOnce();
            emitFallbackOnce("network", error);
            progress.report({ message: error.message });
            return rejectWithTelemetry(reject, error);
          }

          progress.report({ message: "Codex response received." });
          const metrics = finalize("success");
          resolve({ payload: resultPayload, metrics });
        });

        function handleCliEvent(event: CodexCliEvent<T>): void {
          if (event.type === "result") {
            resultPayload = event.payload;
            return;
          }

          if (event.type === "item.completed") {
            const coerced = coerceCliResultFromItem(
              operation,
              event.item,
            );
            if (typeof coerced !== "undefined") {
              resultPayload = coerced as T;
            }
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
              logDebug(`[Codex] ${event.message}`);
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
            fallbackReason = reason;
            offlineFallbackEmitter.fire({ reason, error });
            log(`[Codex] Request failed: ${error.message}`);
            progress.report({ message: error.message });
          }
        }
      },
    );
  };

  if (showProgress) {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: progressTitle,
        cancellable: false,
      },
      (progress) => runWithProgress(progress),
    );
  }

  return runWithProgress({ report() {} } as vscode.Progress<{
    message?: string;
  }>);
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

function logCliGuidance(
  kind: "missing-binary" | "auth" | "upgrade",
  details?: {
    binary?: string;
    version?: string;
    minimumVersion?: string;
  },
): void {
  const installDocs = "https://docs.cursor.com/codex-cli/install";
  const authDocs = "https://docs.cursor.com/codex-cli/auth";

  if (kind === "upgrade") {
    const binaryLabel = details?.binary ?? "Codex CLI";
    const versionLabel = details?.version
      ? ` (reported ${details.version})`
      : "";
    const requirementLabel = details?.minimumVersion
      ? `; requires ${details.minimumVersion}+`
      : "";
    log(
      `[Codex ⚠️] ${binaryLabel}${versionLabel}${requirementLabel} is out of date. Upgrade the Codex CLI: ${installDocs}`,
    );
    return;
  }

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
  minCodexCliVersionForTest: MIN_CODEX_CLI_VERSION,
  resetCodexCompatibilityForTest(): void {
    codexCompatibilityChecks.clear();
  },
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
