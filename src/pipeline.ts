import os from "node:os";
import { promisify } from "node:util";
import { exec, execFile } from "node:child_process";
import type { ExecOptions } from "node:child_process";
import path from "node:path";
import {
  promises as fs,
  Dirent,
  constants as fsConstants,
} from "node:fs";
import { minimatch } from "minimatch";

import { getConfig } from "./config";
import {
  generateFix,
  FixContext,
  AIPatch,
  CodexExecutionOptions,
} from "./codex";
import { stageModified } from "./utils/git";
import { getOutputChannel } from "./output";
import { GitRepository } from "./types/git";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const GIT_DIFF_BUFFER = 20 * 1024 * 1024;

export type PipelineStepId = "format" | "typecheck" | "tests";
export type PipelineMode = "execute" | "dry-run";
export type PipelineLane = "fast" | "guarded";

export interface DryRunPatchInfo {
  readonly step: PipelineStepId;
  readonly files: string[];
  readonly diff: string;
  readonly meta?: AIPatch["meta"];
}

export interface PipelineOptions {
  readonly repo: GitRepository;
  readonly hooks?: PipelineHooks;
  readonly mode?: PipelineMode;
  readonly lane?: PipelineLane;
  readonly limitToSteps?: PipelineStepId[];
  readonly onDryRunPatch?: (
    info: DryRunPatchInfo,
  ) => Promise<void> | void;
  readonly codexOptions?: CodexExecutionOptions;
}

export interface PipelineHooks {
  onStepStart?(event: StepLifecycleEvent): void;
  onStepComplete?(result: StepResult): void;
  onDecisionRequired?(
    event: PipelineDecisionEvent,
  ): Promise<PipelineDecision> | PipelineDecision;
  onLog?(message: string): void;
}

export interface StepLifecycleEvent {
  readonly step: PipelineStepId;
  readonly attempt: number;
}

export interface StepResult {
  readonly step: PipelineStepId;
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly attempt: number;
}

export type PipelineDecision = "commitAnyway" | "retry" | "abort";

export interface PipelineDecisionEvent {
  readonly step: PipelineStepId;
  readonly stderr: string;
  readonly attempts: number;
  readonly commitAnnotation: string;
  readonly suppressAutoPush: boolean;
}

export interface PipelineOutcome {
  readonly status:
    | "completed"
    | "aborted"
    | "commit-anyway"
    | "skipped";
  readonly failedStep?: PipelineStepId;
  readonly commitAnnotation?: string;
  readonly suppressAutoPush: boolean;
}

interface StepDefinition {
  readonly id: PipelineStepId;
  readonly command: string;
  readonly dryRunSkipReason?: string;
  readonly envPatch?: Record<string, string>;
}

interface RepoSnapshot {
  readonly stagedPatch: string;
  readonly unstagedPatch: string;
  readonly untrackedFiles: string[];
  readonly untrackedDirs: string[];
  readonly emptyDirs: string[];
  readonly untrackedDir?: string;
}

const STEP_SEQUENCE: PipelineStepId[] = ["format", "typecheck", "tests"];
const STEP_LABELS: Record<PipelineStepId, string> = {
  format: "FORMAT",
  typecheck: "TYPECHECK",
  tests: "TESTS",
};
const FAST_LANE_SKIP_REASONS: Record<PipelineStepId, string> = {
  format: "Fast lane enabled; skipping formatter step.",
  typecheck: "Fast lane enabled; skipping typecheck step.",
  tests: "Fast lane enabled; skipping test step.",
};
type SymlinkType = "dir" | "file" | "junction";

export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineOutcome> {
  const config = getConfig();
  const hooks = options.hooks ?? {};
  const mode: PipelineMode = options.mode ?? "execute";
  const isDryRun = mode === "dry-run";
  const lane: PipelineLane =
    options.lane ??
    (config.pipelineRequireChecks ? "guarded" : "fast");

  if (!config.pipelineEnable) {
    log(hooks, "Pipeline disabled via configuration");
    return { status: "skipped", suppressAutoPush: false };
  }

  const repoRoot = options.repo.rootUri.fsPath;
  const stepDefinitions = await buildStepDefinitions(
    config,
    mode,
    repoRoot,
    lane,
  );
  const targetSteps =
    options.limitToSteps && options.limitToSteps.length > 0
      ? STEP_SEQUENCE.filter((id) =>
          options.limitToSteps!.includes(id),
        )
      : STEP_SEQUENCE;
  const filteredSteps = stepDefinitions.filter((definition) =>
    targetSteps.includes(definition.id),
  );
  if (filteredSteps.length === 0) {
    log(
      hooks,
      "[Pipeline] No steps selected for execution; treating as complete.",
    );
    return { status: "completed", suppressAutoPush: false };
  }
  const ignoreRules = await readIgnorePatterns(repoRoot);
  const snapshot = isDryRun
    ? await captureRepoSnapshot(repoRoot)
    : undefined;

  try {
    for (const step of filteredSteps) {
      const trimmedCommand = step.command.trim();
      if (trimmedCommand.length === 0) {
        const reason =
          step.dryRunSkipReason ?? "No command configured; skipping.";
        log(hooks, `[${formatStepLabel(step.id)} ⏭️] ${reason}`);
        hooks.onStepStart?.({ step: step.id, attempt: 0 });
        hooks.onStepComplete?.({
          step: step.id,
          success: true,
          stdout: "",
          stderr: "",
          attempt: 0,
        });
        continue;
      }
      const activeStep: StepDefinition = {
        ...step,
        command: trimmedCommand,
      };
      let attempt = 0;
      let success = false;
      let lastResult: StepResult | undefined;

      hooks.onStepStart?.({ step: step.id, attempt });

      while (attempt <= config.pipelineMaxAiFixAttempts && !success) {
        logStepInvocation(hooks, activeStep);
        const result = await executeStep(
          activeStep,
          repoRoot,
          attempt,
        );
        lastResult = result;
        logStepStreams(hooks, step.id, result);

        if (result.success) {
          success = true;
          hooks.onStepComplete?.(result);

          if (!isDryRun && (step.id === "format" || attempt > 0)) {
            await stageRelevantChanges(options.repo, ignoreRules);
          }
          break;
        }

        if (attempt >= config.pipelineMaxAiFixAttempts) {
          break;
        }

        const fixApplied = await attemptAiFix(
          step.id,
          result,
          repoRoot,
          ignoreRules,
          options.repo,
          hooks,
          mode,
          options.onDryRunPatch,
          options.codexOptions,
        );
        if (!fixApplied) {
          break;
        }

        if (isDryRun) {
          success = true;
          hooks.onStepComplete?.({
            step: step.id,
            success: true,
            stdout: result.stdout,
            stderr: result.stderr,
            attempt: attempt + 1,
          });
          break;
        }

        attempt += 1;
        hooks.onStepStart?.({ step: step.id, attempt });
      }

      if (!success) {
        const failingResult = lastResult ?? {
          step: step.id,
          success: false,
          stdout: "",
          stderr: "",
          attempt,
        };

        hooks.onStepComplete?.(failingResult);

        if (config.pipelineAbortOnFailure) {
          log(hooks, `Pipeline aborted on ${step.id}`);
          return {
            status: "aborted",
            failedStep: step.id,
            suppressAutoPush: false,
          };
        }

        const decisionEvent: PipelineDecisionEvent = {
          step: step.id,
          stderr: failingResult.stderr,
          attempts: attempt,
          commitAnnotation: `[pipeline failed at ${step.id}: see OUTPUT > CommitSmith]`,
          suppressAutoPush: true,
        };

        const decision = await resolveDecision(hooks, decisionEvent);

        if (decision === "commitAnyway") {
          log(
            hooks,
            `Pipeline continuing via commit-anyway decision after ${step.id}`,
          );
          return {
            status: "commit-anyway",
            failedStep: step.id,
            commitAnnotation: decisionEvent.commitAnnotation,
            suppressAutoPush: true,
          };
        }

        if (decision === "retry") {
          const retryResult = await executeStep(
            step,
            repoRoot,
            attempt + 1,
          );
          logStepStreams(hooks, step.id, retryResult);
          hooks.onStepComplete?.(retryResult);

          if (!retryResult.success) {
            log(hooks, `Pipeline aborted after retry on ${step.id}`);
            return {
              status: "aborted",
              failedStep: step.id,
              suppressAutoPush: false,
            };
          }

          if (!isDryRun) {
            await stageRelevantChanges(options.repo, ignoreRules);
          }
          continue;
        }

        log(hooks, `Pipeline aborted by decision on ${step.id}`);
        return {
          status: "aborted",
          failedStep: step.id,
          suppressAutoPush: false,
        };
      }
    }

    return { status: "completed", suppressAutoPush: false };
  } finally {
    if (snapshot) {
      await restoreRepoSnapshot(repoRoot, snapshot);
    }
  }
}

async function buildStepDefinitions(
  config: ReturnType<typeof getConfig>,
  mode: PipelineMode,
  cwd: string,
  lane: PipelineLane,
): Promise<StepDefinition[]> {
  const npmBinary = await resolveBinary("npm", [
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
  ]);
  const nodeBinary = await resolveBinary("node", [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ]);
  const envPatch = createEnvPatch([npmBinary, nodeBinary]);
  const useFastLane = mode === "execute" && lane === "fast";

  const stepSettings: Record<
    PipelineStepId,
    { enabled: boolean; command: string }
  > = {
    format: {
      enabled: config.formatEnabled,
      command: config.formatEnabled
        ? resolveStepCommandBinary(config.formatCommand, npmBinary)
        : "",
    },
    typecheck: {
      enabled: config.typecheckEnabled,
      command: config.typecheckEnabled
        ? resolveStepCommandBinary(config.typecheckCommand, npmBinary)
        : "",
    },
    tests: {
      enabled: config.testsEnabled,
      command: config.testsEnabled
        ? resolveStepCommandBinary(config.testsCommand, npmBinary)
        : "",
    },
  };

  const scripts =
    mode === "dry-run" ? await getPackageScripts(cwd) : undefined;

  return STEP_SEQUENCE.map((id) => {
    const { enabled, command } = stepSettings[id];

    if (!enabled) {
      return {
        id,
        command: "",
        dryRunSkipReason: "Disabled via configuration.",
      };
    }

    if (useFastLane) {
      return {
        id,
        command: "",
        dryRunSkipReason: FAST_LANE_SKIP_REASONS[id],
      };
    }

    if (mode !== "dry-run") {
      return { id, command, envPatch };
    }

    if (id === "format") {
      const result = translateFormatCommandForDryRun(
        command,
        scripts ?? new Set(),
      );
      if (result.skip) {
        return {
          id,
          command: "",
          dryRunSkipReason:
            result.reason ??
            `Skipping mutating command "${command}" during dry run.`,
        };
      }
      return {
        id,
        command: resolveStepCommandBinary(result.command, npmBinary),
        envPatch,
      };
    }

    if (isDryRunUnsafeGitCommand(command)) {
      return {
        id,
        command: "",
        dryRunSkipReason: `Skipping git command "${command}" during dry run.`,
      };
    }

    return { id, command, envPatch };
  });
}

function translateFormatCommandForDryRun(
  command: string,
  scripts: Set<string>,
): { command: string; skip: boolean; reason?: string } {
  const trimmed = command.trim();
  if (!trimmed.startsWith("npm run ")) {
    return {
      command: "",
      skip: true,
      reason: `Cannot derive non-mutating variant for "${trimmed}" during dry run.`,
    };
  }

  const script = trimmed.replace("npm run ", "");
  const base = script.replace(/:fix$/, "");
  const checkCandidates = [
    `${base}:check`,
    script.endsWith(":fix") ? `${script.slice(0, -4)}check` : "",
    `${base}:dry-run`,
  ].filter(Boolean);

  for (const candidate of checkCandidates) {
    if (scripts.has(candidate)) {
      return { command: `npm run ${candidate}`, skip: false };
    }
  }

  return {
    command: "",
    skip: true,
    reason: `No non-mutating variant found for "${trimmed}".`,
  };
}

function isDryRunUnsafeGitCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed.startsWith("git ")) {
    return false;
  }

  const mutatingSubcommands = new Set([
    "add",
    "apply",
    "branch",
    "checkout",
    "cherry-pick",
    "clean",
    "commit",
    "merge",
    "mv",
    "pull",
    "push",
    "rebase",
    "reset",
    "restore",
    "rm",
    "stash",
    "tag",
  ]);

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    return false;
  }

  return mutatingSubcommands.has(tokens[1]);
}

async function executeStep(
  step: StepDefinition,
  cwd: string,
  attempt: number,
): Promise<StepResult> {
  try {
    const options: ExecOptions = {
      cwd,
      windowsHide: true,
      encoding: "utf8",
    };
    if (step.envPatch) {
      options.env = { ...process.env, ...step.envPatch };
    }
    const { stdout, stderr } = (await execAsync(
      step.command,
      options,
    )) as { stdout: string; stderr: string };
    return { step: step.id, success: true, stdout, stderr, attempt };
  } catch (error) {
    const executionError = error as {
      stdout?: string;
      stderr?: string;
    };
    return {
      step: step.id,
      success: false,
      stdout: executionError.stdout ?? "",
      stderr: executionError.stderr ?? (error as Error).message,
      attempt,
    };
  }
}

async function attemptAiFix(
  step: PipelineStepId,
  result: StepResult,
  repoRoot: string,
  ignoreRules: string[],
  repo: GitRepository,
  hooks: PipelineHooks,
  mode: PipelineMode,
  onDryRunPatch?: (info: DryRunPatchInfo) => Promise<void> | void,
  codexOptions?: CodexExecutionOptions,
): Promise<boolean> {
  try {
    const context: FixContext = {
      filePath:
        extractLikelyFilePath(result.stderr, repoRoot) ?? "unknown",
      errorMessage: result.stderr,
      step,
    };

    log(hooks, `[Codex] Attempting AI fix for ${step}`);
    const patch = await generateFix(context, codexOptions);

    const affectedFiles = extractPatchedFiles(patch.diff);
    const permittedFiles = affectedFiles.filter(
      (file) => !isIgnored(file, ignoreRules),
    );

    if (permittedFiles.length === 0) {
      log(
        hooks,
        "[Codex] Patch only touched ignored files; skipping application",
      );
      return false;
    }

    if (permittedFiles.length !== affectedFiles.length) {
      log(
        hooks,
        "[Codex] Patch includes ignored files; skipping application",
      );
      return false;
    }

    if (mode === "dry-run") {
      await onDryRunPatch?.({
        step,
        files: permittedFiles,
        diff: patch.diff,
        meta: patch.meta,
      });
      return true;
    }

    await applyPatch(repoRoot, patch.diff);
    await stageModified(repo, permittedFiles);
    log(
      hooks,
      `[Codex] Applied patch touching ${permittedFiles.join(", ")}`,
    );
    return true;
  } catch (error) {
    log(
      hooks,
      `[Codex] Fix attempt failed: ${(error as Error).message}`,
    );
    return false;
  }
}

function extractLikelyFilePath(
  stderr: string,
  repoRoot: string,
): string | undefined {
  const stackMatch = stderr.match(
    /at (?:[^(]+\()?((?:file:\/\/)?[^\s)]+):\d+:\d+/,
  );
  if (stackMatch?.[1]) {
    const normalized = normalizeStackPath(stackMatch[1], repoRoot);
    if (!normalized.startsWith("node_modules/")) {
      return normalized;
    }
  }

  const extensionPattern =
    /([^\s'"`]+?\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|markdown|yml|yaml|toml|ini|cfg|conf|config|lock|sh|bash|py|rb|go|rs|java|cs|cpp|c|hpp|h|m|swift|php|sql|html|htm|css|scss|less|vue|svelte|xml|tf))(?:[:]\d+)?/gi;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = extensionPattern.exec(stderr)) !== null) {
    const candidate = match[1];
    // Strip surrounding characters like leading "(" or "./" left by the regex.
    matches.push(candidate.replace(/^[(]/, "").replace(/[,.)]$/, ""));
  }

  if (matches.length === 0) {
    return undefined;
  }

  const withSlash = matches.filter((candidate) => {
    const hasSeparator =
      candidate.includes("/") || candidate.includes("\\");
    if (!hasSeparator) {
      return false;
    }
    const normalized = normalizeStackPath(candidate, repoRoot);
    return !normalized.startsWith("node_modules/");
  });
  if (withSlash.length > 0) {
    return normalizeStackPath(
      withSlash[withSlash.length - 1],
      repoRoot,
    );
  }

  const last = matches[matches.length - 1];
  if (!last) {
    return undefined;
  }
  const normalizedLast = normalizeStackPath(last, repoRoot);
  if (normalizedLast.startsWith("node_modules/")) {
    return undefined;
  }
  return normalizedLast;
}

function normalizeStackPath(raw: string, repoRoot: string): string {
  const withoutScheme = raw.startsWith("file://")
    ? raw.replace(/^file:\/\//, "")
    : raw;
  const normalizedRepoRoot = repoRoot
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  let cleaned = withoutScheme.replace(/\\/g, "/");

  if (
    normalizedRepoRoot.length > 0 &&
    cleaned.startsWith(normalizedRepoRoot)
  ) {
    cleaned = cleaned.slice(normalizedRepoRoot.length);
  }

  cleaned = cleaned.replace(/^\/+/, "");
  cleaned = cleaned.replace(/^(\.\/)+/, "");

  return cleaned;
}

async function applyPatch(cwd: string, diff: string): Promise<void> {
  await execGitWithInput(
    ["apply", "--check", "--whitespace=nowarn", "-"],
    cwd,
    diff,
  );
  await execGitWithInput(
    ["apply", "--whitespace=nowarn", "-"],
    cwd,
    diff,
  );
}

function extractPatchedFiles(diff: string): string[] {
  const files = new Set<string>();
  const addMatcher = /^\+\+\+\s+b\/(.+)$/gm;
  const removeMatcher = /^---\s+a\/(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = addMatcher.exec(diff)) !== null) {
    const file = match[1];
    if (file !== "/dev/null") {
      files.add(file);
    }
  }

  while ((match = removeMatcher.exec(diff)) !== null) {
    const file = match[1];
    if (file !== "/dev/null") {
      files.add(file);
    }
  }

  return Array.from(files);
}

async function stageRelevantChanges(
  repo: GitRepository,
  ignoreRules: string[],
): Promise<void> {
  const changedFiles = await listChangedFiles(repo.rootUri.fsPath);
  const allowed = changedFiles.filter(
    (file) => !isIgnored(file, ignoreRules),
  );
  if (allowed.length === 0) {
    return;
  }
  await stageModified(repo, allowed);
}

async function listChangedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      "git status --porcelain=v1 -z",
      {
        cwd: root,
        windowsHide: true,
      },
    );
    if (!stdout) {
      return [];
    }

    const entries = stdout
      .split("\0")
      .filter((entry) => entry.length > 0);
    const files: string[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const statusX = entry[0] ?? " ";
      const statusY = entry[1] ?? " ";

      const isUntracked = statusX === "?" && statusY === "?";
      const hasWorktreeChange = statusY !== " " && statusY !== "!";
      const needsRestage = isUntracked || hasWorktreeChange;

      if (!needsRestage) {
        continue;
      }

      let pathStart = 3;
      if (entry.length > 3 && entry[2] !== " ") {
        const spaceIndex = entry.indexOf(" ");
        pathStart = spaceIndex >= 0 ? spaceIndex + 1 : entry.length;
      }

      const pathText = entry.slice(pathStart);
      if (!pathText) {
        continue;
      }

      const isRenameOrCopy =
        statusX === "R" ||
        statusX === "C" ||
        statusY === "R" ||
        statusY === "C";

      if (isRenameOrCopy) {
        const targetPath = entries[index + 1];
        if (targetPath) {
          files.push(targetPath);
          index += 1;
          continue;
        }
      }

      if (pathText !== "/dev/null") {
        files.push(pathText);
      }
    }

    return files;
  } catch {
    return [];
  }
}

async function readIgnorePatterns(root: string): Promise<string[]> {
  const ignorePath = path.join(root, ".commit-smith-ignore");
  try {
    const content = await fs.readFile(ignorePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isIgnored(file: string, rules: string[]): boolean {
  return rules.some((pattern) => minimatch(file, pattern));
}

async function resolveDecision(
  hooks: PipelineHooks,
  event: PipelineDecisionEvent,
): Promise<PipelineDecision> {
  if (!hooks.onDecisionRequired) {
    return "abort";
  }

  try {
    const decision = await hooks.onDecisionRequired(event);
    return decision;
  } catch {
    return "abort";
  }
}

function log(hooks: PipelineHooks, message: string): void {
  hooks.onLog?.(message);
  getOutputChannel().appendLine(message);
}

function logStepInvocation(
  hooks: PipelineHooks,
  step: StepDefinition,
): void {
  log(hooks, `[${formatStepLabel(step.id)} ↪] ${step.command}`);
}

function formatStepLabel(step: PipelineStepId): string {
  return STEP_LABELS[step];
}

function logStepStreams(
  hooks: PipelineHooks,
  step: PipelineStepId,
  result: StepResult,
): void {
  const stdout = result.stdout?.trim();
  const stderr = result.stderr?.trim();
  if (stdout) {
    logStream(hooks, step, "stdout", stdout);
  }
  if (stderr) {
    logStream(hooks, step, "stderr", stderr);
  }
}

function logStream(
  hooks: PipelineHooks,
  step: PipelineStepId,
  kind: "stdout" | "stderr",
  value: string,
): void {
  const lines = value.split(/\r?\n/).map((line) => line.trimEnd());
  const maxLines = 10;
  const recentLines = lines.slice(-maxLines);
  const label = formatStepLabel(step);
  for (const line of recentLines) {
    if (line.length === 0) {
      continue;
    }
    log(hooks, `[${label} ${kind}] ${line}`);
  }
  if (lines.length > maxLines) {
    log(
      hooks,
      `[${label} ${kind}] … (${lines.length - maxLines} more lines)`,
    );
  }
}

function resolveStepCommandBinary(
  command: string,
  npmBinary: string,
): string {
  if (!command) {
    return command;
  }
  return replaceLeadingBinary(command, "npm", npmBinary);
}

function replaceLeadingBinary(
  command: string,
  binaryName: string,
  resolved: string,
): string {
  if (!resolved || resolved === binaryName) {
    return command;
  }

  const trimmed = command.trimStart();
  if (
    !trimmed.startsWith(`${binaryName} `) &&
    trimmed !== binaryName
  ) {
    return command;
  }

  const leadingWhitespace = command.slice(
    0,
    command.length - trimmed.length,
  );
  const rest = trimmed.slice(binaryName.length);
  const quotedBinary = resolved.includes(" ")
    ? `"${resolved}"`
    : resolved;
  return `${leadingWhitespace}${quotedBinary}${rest}`;
}

const binaryCache = new Map<string, string>();
const binaryEnvKeys: Record<string, string[]> = {
  npm: ["COMMITSMITH_NPM_PATH", "NPM_PATH"],
  node: ["COMMITSMITH_NODE_PATH"],
  npx: ["COMMITSMITH_NPX_PATH"],
  pnpm: ["COMMITSMITH_PNPM_PATH"],
  yarn: ["COMMITSMITH_YARN_PATH"],
};

async function resolveBinary(
  name: string,
  fallbacks: string[],
): Promise<string> {
  if (binaryCache.has(name)) {
    return binaryCache.get(name)!;
  }

  const envKeys = [
    ...(binaryEnvKeys[name] ?? []),
    `COMMITSMITH_${name.toUpperCase()}_PATH`,
  ];
  for (const key of envKeys) {
    const value = process.env[key];
    if (value && (await fileExists(value))) {
      binaryCache.set(name, value);
      return value;
    }
  }

  const fromPath = await findExecutableOnPath(name);
  if (fromPath) {
    binaryCache.set(name, fromPath);
    return fromPath;
  }

  for (const candidate of fallbacks) {
    if (await fileExists(candidate)) {
      binaryCache.set(name, candidate);
      return candidate;
    }
  }

  binaryCache.set(name, name);
  return name;
}

function createEnvPatch(
  resolvedBinaries: string[],
): Record<string, string> | undefined {
  const additions = new Set<string>();
  for (const binary of resolvedBinaries) {
    if (!binary) {
      continue;
    }
    const normalized = binary.trim();
    if (
      !normalized ||
      normalized === "npm" ||
      normalized === "node"
    ) {
      continue;
    }
    const dir = path.dirname(normalized);
    if (dir) {
      additions.add(dir);
    }
  }

  if (additions.size === 0) {
    return undefined;
  }

  const existingPath = process.env.PATH ?? "";
  const pathEntries = existingPath.split(path.delimiter);
  const newEntries = [...additions].filter(
    (dir) => !pathEntries.includes(dir),
  );
  if (newEntries.length === 0) {
    return undefined;
  }

  const combinedPath = `${newEntries.join(path.delimiter)}${existingPath ? `${path.delimiter}${existingPath}` : ""}`;
  return { PATH: combinedPath };
}

async function findExecutableOnPath(
  executable: string,
): Promise<string | undefined> {
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
        if (await fileExists(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function getPackageScripts(cwd: string): Promise<Set<string>> {
  try {
    const packageJsonPath = path.join(cwd, "package.json");
    const contents = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(contents) as {
      scripts?: Record<string, string>;
    };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

async function captureRepoSnapshot(
  cwd: string,
): Promise<RepoSnapshot> {
  const [
    { stdout: stagedPatch },
    { stdout: unstagedPatch },
    { stdout: untrackedStdout },
    { stdout: statusStdout },
  ] = await Promise.all([
    execFileAsync("git", ["diff", "--binary", "--cached"], {
      cwd,
      maxBuffer: GIT_DIFF_BUFFER,
    }),
    execFileAsync("git", ["diff", "--binary"], {
      cwd,
      maxBuffer: GIT_DIFF_BUFFER,
    }),
    execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd, maxBuffer: GIT_DIFF_BUFFER },
    ),
    execFileAsync("git", ["status", "--porcelain=v2", "-z"], {
      cwd,
      maxBuffer: GIT_DIFF_BUFFER,
    }),
  ]);

  const untrackedFiles = untrackedStdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const untrackedDirs = statusStdout
    .split("\0")
    .filter((entry) => entry.length > 0 && entry.startsWith("? "))
    .map((entry) => entry.slice(2))
    .filter((path) => path.endsWith("/"))
    .map((path) => path.slice(0, -1));

  let untrackedDir: string | undefined;
  if (untrackedFiles.length > 0) {
    untrackedDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "commit-smith-untracked-"),
    );
    for (const relativePath of untrackedFiles) {
      const source = path.join(cwd, relativePath);
      const destination = path.join(untrackedDir, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await copyEntryPreservingSymlink(source, destination);
    }
  }

  const emptyDirs = await collectEmptyDirectories(cwd);

  return {
    stagedPatch: stagedPatch,
    unstagedPatch: unstagedPatch,
    untrackedFiles,
    untrackedDirs,
    emptyDirs,
    untrackedDir,
  };
}

async function restoreRepoSnapshot(
  cwd: string,
  snapshot: RepoSnapshot,
): Promise<void> {
  await execAsync("git reset --hard", { cwd });
  await execFileAsync(
    "git",
    ["clean", "-fd", "-e", ".commit-smith", "-e", ".commit-smith/**"],
    { cwd },
  );

  if (snapshot.stagedPatch.trim().length > 0) {
    await execGitWithInput(
      ["apply", "--binary", "--index", "-"],
      cwd,
      snapshot.stagedPatch,
    );
  }

  if (snapshot.unstagedPatch.trim().length > 0) {
    await execGitWithInput(
      ["apply", "--binary", "-"],
      cwd,
      snapshot.unstagedPatch,
    );
  }

  if (snapshot.untrackedDir) {
    for (const relativePath of snapshot.untrackedFiles) {
      const source = path.join(snapshot.untrackedDir, relativePath);
      const destination = path.join(cwd, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await copyEntryPreservingSymlink(source, destination);
    }
    await fs.rm(snapshot.untrackedDir, {
      recursive: true,
      force: true,
    });
  }

  const dirsToRestore = [
    ...new Set([...snapshot.untrackedDirs, ...snapshot.emptyDirs]),
  ].sort((a, b) => a.length - b.length);
  for (const dir of dirsToRestore) {
    await fs.mkdir(path.join(cwd, dir), { recursive: true });
  }
}

function execGitWithInput(
  args: string[],
  cwd: string,
  input: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: GIT_DIFF_BUFFER },
      (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      },
    );

    if (!child.stdin) {
      reject(new Error("Failed to write to git stdin."));
      return;
    }

    child.stdin.on("error", reject);
    child.stdin.end(input, "utf8");
  });
}

async function copyEntryPreservingSymlink(
  source: string,
  destination: string,
): Promise<void> {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) {
    const target = await fs.readlink(source);
    let linkType: SymlinkType | undefined;

    if (process.platform === "win32") {
      try {
        const targetStats = await fs.stat(source);
        linkType = targetStats.isDirectory() ? "junction" : "file";
      } catch {
        linkType = "file";
      }
    }

    try {
      await fs.symlink(target, destination, linkType);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (
        process.platform === "win32" &&
        (linkType === undefined || linkType === "file") &&
        (nodeError.code === "EPERM" || nodeError.code === "EINVAL")
      ) {
        await fs.symlink(target, destination, "junction");
      } else {
        throw error;
      }
    }
    return;
  }

  await fs.copyFile(source, destination);
}

async function collectEmptyDirectories(
  root: string,
): Promise<string[]> {
  const emptyDirs: string[] = [];

  async function explore(relative: string): Promise<boolean> {
    const fullPath = relative ? path.join(root, relative) : root;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(fullPath, { withFileTypes: true });
    } catch {
      return false;
    }

    let hasContent = false;
    for (const entry of entries) {
      if (entry.name === ".git") {
        hasContent = true;
        continue;
      }
      const nextRelative = relative
        ? path.join(relative, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        const childEmpty = await explore(nextRelative);
        if (!childEmpty) {
          hasContent = true;
        }
      } else {
        hasContent = true;
      }
    }

    if (!hasContent && relative) {
      emptyDirs.push(relative);
      return true;
    }

    return !hasContent;
  }

  await explore("");
  return emptyDirs;
}
