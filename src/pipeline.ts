import { promisify } from 'node:util';
import { exec, execFile } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import minimatch from 'minimatch';

import { getConfig } from './config';
import { generateFix, FixContext } from './codex';
import { stageModified } from './utils/git';
import { GitRepository } from './types/git';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const OUTPUT_CHANNEL_NAME = 'CommitSmith';

export type PipelineStepId = 'format' | 'typecheck' | 'tests';

export interface PipelineOptions {
  readonly repo: GitRepository;
  readonly hooks?: PipelineHooks;
}

export interface PipelineHooks {
  onStepStart?(event: StepLifecycleEvent): void;
  onStepComplete?(result: StepResult): void;
  onDecisionRequired?(event: PipelineDecisionEvent): Promise<PipelineDecision> | PipelineDecision;
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

export type PipelineDecision = 'commitAnyway' | 'retry' | 'abort';

export interface PipelineDecisionEvent {
  readonly step: PipelineStepId;
  readonly stderr: string;
  readonly attempts: number;
  readonly commitAnnotation: string;
  readonly suppressAutoPush: boolean;
}

export interface PipelineOutcome {
  readonly status: 'completed' | 'aborted' | 'commit-anyway' | 'skipped';
  readonly failedStep?: PipelineStepId;
  readonly commitAnnotation?: string;
  readonly suppressAutoPush: boolean;
}

interface StepDefinition {
  readonly id: PipelineStepId;
  readonly command: string;
}

const STEP_SEQUENCE: PipelineStepId[] = ['format', 'typecheck', 'tests'];

export async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
  const config = getConfig();
  const hooks = options.hooks ?? {};

  if (!config.pipelineEnable) {
    log(hooks, 'Pipeline disabled via configuration');
    return { status: 'skipped', suppressAutoPush: false };
  }

  const stepDefinitions = buildStepDefinitions(config);
  const repoRoot = options.repo.rootUri.fsPath;
  const ignoreRules = await readIgnorePatterns(repoRoot);
  const outcome: PipelineOutcome = {
    status: 'completed',
    suppressAutoPush: false
  };

  for (const step of stepDefinitions) {
    let attempt = 0;
    let success = false;
    let lastResult: StepResult | undefined;

    hooks.onStepStart?.({ step: step.id, attempt });

    while (attempt <= config.pipelineMaxAiFixAttempts && !success) {
      const result = await executeStep(step, repoRoot, attempt);
      lastResult = result;

      if (result.success) {
        success = true;
        hooks.onStepComplete?.(result);

        if (step.id === 'format' || attempt > 0) {
          await stageRelevantChanges(options.repo, ignoreRules);
        }
        break;
      }

      if (attempt >= config.pipelineMaxAiFixAttempts) {
        break;
      }

      const fixApplied = await attemptAiFix(step.id, result, repoRoot, ignoreRules, options.repo, hooks);
      if (!fixApplied) {
        break;
      }

      attempt += 1;
      hooks.onStepStart?.({ step: step.id, attempt });
    }

    if (!success) {
      const failingResult = lastResult ?? {
        step: step.id,
        success: false,
        stdout: '',
        stderr: '',
        attempt
      };

      hooks.onStepComplete?.(failingResult);

      if (config.pipelineAbortOnFailure) {
        outcome.status = 'aborted';
        outcome.failedStep = step.id;
        log(hooks, `Pipeline aborted on ${step.id}`);
        return outcome;
      }

      const decisionEvent: PipelineDecisionEvent = {
        step: step.id,
        stderr: failingResult.stderr,
        attempts: attempt,
        commitAnnotation: `[pipeline failed at ${step.id}: see OUTPUT > CommitSmith]`,
        suppressAutoPush: true
      };

      const decision = await resolveDecision(hooks, decisionEvent);

      if (decision === 'commitAnyway') {
        outcome.status = 'commit-anyway';
        outcome.failedStep = step.id;
        outcome.commitAnnotation = decisionEvent.commitAnnotation;
        outcome.suppressAutoPush = true;
        log(hooks, `Pipeline continuing via commit-anyway decision after ${step.id}`);
        return outcome;
      }

      if (decision === 'retry') {
        const retryResult = await executeStep(step, repoRoot, attempt + 1);
        hooks.onStepComplete?.(retryResult);

        if (!retryResult.success) {
          outcome.status = 'aborted';
          outcome.failedStep = step.id;
          log(hooks, `Pipeline aborted after retry on ${step.id}`);
          return outcome;
        }

        await stageRelevantChanges(options.repo, ignoreRules);
        continue;
      }

      outcome.status = 'aborted';
      outcome.failedStep = step.id;
      log(hooks, `Pipeline aborted by decision on ${step.id}`);
      return outcome;
    }
  }

  return outcome;
}

function buildStepDefinitions(config: ReturnType<typeof getConfig>): StepDefinition[] {
  const commands: Record<PipelineStepId, string | undefined> = {
    format: config.formatCommand,
    typecheck: config.typecheckCommand,
    tests: config.testsCommand
  } as unknown as Record<PipelineStepId, string | undefined>;

  return STEP_SEQUENCE.map((id) => ({ id, command: commands[id] ?? '' })).filter((step) => step.command.trim().length > 0);
}

async function executeStep(step: StepDefinition, cwd: string, attempt: number): Promise<StepResult> {
  try {
    const { stdout, stderr } = await execAsync(step.command, { cwd, windowsHide: true });
    return { step: step.id, success: true, stdout, stderr, attempt };
  } catch (error) {
    const executionError = error as { stdout?: string; stderr?: string };
    return {
      step: step.id,
      success: false,
      stdout: executionError.stdout ?? '',
      stderr: executionError.stderr ?? (error as Error).message,
      attempt
    };
  }
}

async function attemptAiFix(
  step: PipelineStepId,
  result: StepResult,
  repoRoot: string,
  ignoreRules: string[],
  repo: GitRepository,
  hooks: PipelineHooks
): Promise<boolean> {
  try {
    const context: FixContext = {
      filePath: extractLikelyFilePath(result.stderr) ?? 'unknown',
      errorMessage: result.stderr,
      step
    };

    log(hooks, `[Codex] Attempting AI fix for ${step}`);
    const patch = await generateFix(context);

    const affectedFiles = extractPatchedFiles(patch.diff);

    const permittedFiles = affectedFiles.filter((file) => !isIgnored(file, ignoreRules));

    if (permittedFiles.length === 0) {
      log(hooks, '[Codex] Patch only touched ignored files; skipping application');
      return false;
    }

    if (permittedFiles.length !== affectedFiles.length) {
      log(hooks, '[Codex] Patch includes ignored files; skipping application');
      return false;
    }

    await applyPatch(repoRoot, patch.diff);
    await stageModified(repo, permittedFiles);
    log(hooks, `[Codex] Applied patch touching ${permittedFiles.join(', ')}`);
    return true;
  } catch (error) {
    log(hooks, `[Codex] Fix attempt failed: ${(error as Error).message}`);
    return false;
  }
}

function extractLikelyFilePath(stderr: string): string | undefined {
  const match = stderr.match(/\s(\S+\.[a-zA-Z0-9]+)/);
  return match?.[1];
}

async function applyPatch(cwd: string, diff: string): Promise<void> {
  await execFileAsync('git', ['apply', '--check', '--whitespace=nowarn', '-'], { cwd, input: diff });
  await execFileAsync('git', ['apply', '--whitespace=nowarn', '-'], { cwd, input: diff });
}

function extractPatchedFiles(diff: string): string[] {
  const files = new Set<string>();
  const addMatcher = /^\+\+\+\s+b\/(.+)$/gm;
  const removeMatcher = /^---\s+a\/(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = addMatcher.exec(diff)) !== null) {
    const file = match[1];
    if (file !== '/dev/null') {
      files.add(file);
    }
  }

  while ((match = removeMatcher.exec(diff)) !== null) {
    const file = match[1];
    if (file !== '/dev/null') {
      files.add(file);
    }
  }
  return Array.from(files);
}

async function stageRelevantChanges(repo: GitRepository, ignoreRules: string[]): Promise<void> {
  const changedFiles = await listChangedFiles(repo.rootUri.fsPath);
  const allowed = changedFiles.filter((file) => !isIgnored(file, ignoreRules));
  if (allowed.length === 0) {
    return;
  }
  await stageModified(repo, allowed);
}

async function listChangedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: root, windowsHide: true });
    if (!stdout.trim()) {
      return [];
    }
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readIgnorePatterns(root: string): Promise<string[]> {
  const ignorePath = path.join(root, '.commit-smith-ignore');
  try {
    const content = await fs.readFile(ignorePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function isIgnored(file: string, rules: string[]): boolean {
  return rules.some((pattern) => minimatch(file, pattern));
}

async function resolveDecision(hooks: PipelineHooks, event: PipelineDecisionEvent): Promise<PipelineDecision> {
  if (!hooks.onDecisionRequired) {
    return 'abort';
  }
  try {
    const decision = await hooks.onDecisionRequired(event);
    return decision;
  } catch {
    return 'abort';
  }
}

function log(hooks: PipelineHooks, message: string): void {
  hooks.onLog?.(message);
  const channel = getOutputChannel();
  channel.appendLine(message);
}

let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return outputChannel;
}
