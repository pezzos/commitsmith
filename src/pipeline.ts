import os from 'node:os';
import { promisify } from 'node:util';
import { exec, execFile } from 'node:child_process';
import path from 'node:path';
import { promises as fs, Dirent } from 'node:fs';
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

import { getConfig } from './config';
import { generateFix, FixContext, AIPatch } from './codex';
import { stageModified } from './utils/git';
import { GitRepository } from './types/git';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const OUTPUT_CHANNEL_NAME = 'CommitSmith';
const GIT_DIFF_BUFFER = 20 * 1024 * 1024;

export type PipelineStepId = 'format' | 'typecheck' | 'tests';
export type PipelineMode = 'execute' | 'dry-run';

export interface DryRunPatchInfo {
  readonly step: PipelineStepId;
  readonly files: string[];
  readonly diff: string;
  readonly meta?: AIPatch['meta'];
}

export interface PipelineOptions {
  readonly repo: GitRepository;
  readonly hooks?: PipelineHooks;
  readonly mode?: PipelineMode;
  readonly onDryRunPatch?: (info: DryRunPatchInfo) => Promise<void> | void;
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
  readonly dryRunSkipReason?: string;
}

interface RepoSnapshot {
  readonly stagedPatch: string;
  readonly unstagedPatch: string;
  readonly untrackedFiles: string[];
  readonly untrackedDirs: string[];
  readonly emptyDirs: string[];
  readonly untrackedDir?: string;
}

const STEP_SEQUENCE: PipelineStepId[] = ['format', 'typecheck', 'tests'];
const STEP_LABELS: Record<PipelineStepId, string> = {
  format: 'FORMAT',
  typecheck: 'TYPECHECK',
  tests: 'TESTS'
};
type SymlinkType = 'dir' | 'file' | 'junction';

export async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
  const config = getConfig();
  const hooks = options.hooks ?? {};
  const mode: PipelineMode = options.mode ?? 'execute';
  const isDryRun = mode === 'dry-run';

  if (!config.pipelineEnable) {
    log(hooks, 'Pipeline disabled via configuration');
    return { status: 'skipped', suppressAutoPush: false };
  }

  const repoRoot = options.repo.rootUri.fsPath;
  const stepDefinitions = await buildStepDefinitions(config, mode, repoRoot);
  const ignoreRules = await readIgnorePatterns(repoRoot);
  const snapshot = isDryRun ? await captureRepoSnapshot(repoRoot) : undefined;

  try {
    for (const step of stepDefinitions) {
      const trimmedCommand = step.command.trim();
      if (trimmedCommand.length === 0) {
        const reason = step.dryRunSkipReason ?? 'No command configured; skipping.';
        log(hooks, `[${formatStepLabel(step.id)} ⏭️] ${reason}`);
        continue;
      }
      const activeStep: StepDefinition = { ...step, command: trimmedCommand };
      let attempt = 0;
      let success = false;
      let lastResult: StepResult | undefined;

      hooks.onStepStart?.({ step: step.id, attempt });

      while (attempt <= config.pipelineMaxAiFixAttempts && !success) {
        const result = await executeStep(activeStep, repoRoot, attempt);
        lastResult = result;

        if (result.success) {
          success = true;
          hooks.onStepComplete?.(result);

          if (!isDryRun && (step.id === 'format' || attempt > 0)) {
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
          options.onDryRunPatch
        );
        if (!fixApplied) {
          break;
        }

        if (isDryRun) {
          success = true;
          hooks.onStepComplete?.({ step: step.id, success: true, stdout: result.stdout, stderr: result.stderr, attempt: attempt + 1 });
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
          log(hooks, `Pipeline aborted on ${step.id}`);
          return { status: 'aborted', failedStep: step.id, suppressAutoPush: false };
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
          log(hooks, `Pipeline continuing via commit-anyway decision after ${step.id}`);
          return {
            status: 'commit-anyway',
            failedStep: step.id,
            commitAnnotation: decisionEvent.commitAnnotation,
            suppressAutoPush: true
          };
        }

        if (decision === 'retry') {
          const retryResult = await executeStep(step, repoRoot, attempt + 1);
          hooks.onStepComplete?.(retryResult);

          if (!retryResult.success) {
            log(hooks, `Pipeline aborted after retry on ${step.id}`);
            return { status: 'aborted', failedStep: step.id, suppressAutoPush: false };
          }

          if (!isDryRun) {
            await stageRelevantChanges(options.repo, ignoreRules);
          }
          continue;
        }

        log(hooks, `Pipeline aborted by decision on ${step.id}`);
        return { status: 'aborted', failedStep: step.id, suppressAutoPush: false };
      }
    }

    return { status: 'completed', suppressAutoPush: false };
  } finally {
    if (snapshot) {
      await restoreRepoSnapshot(repoRoot, snapshot);
    }
  }
}

async function buildStepDefinitions(
  config: ReturnType<typeof getConfig>,
  mode: PipelineMode,
  cwd: string
): Promise<StepDefinition[]> {
  const commands: Record<PipelineStepId, string> = {
    format: config.formatCommand,
    typecheck: config.typecheckCommand,
    tests: config.testsCommand
  } as unknown as Record<PipelineStepId, string>;

  const scripts = mode === 'dry-run' ? await getPackageScripts(cwd) : undefined;

  return STEP_SEQUENCE.map((id) => {
    const baseCommand = commands[id];

    if (mode !== 'dry-run') {
      return { id, command: baseCommand };
    }

    if (id === 'format') {
      const result = translateFormatCommandForDryRun(baseCommand, scripts ?? new Set());
      if (result.skip) {
        return {
          id,
          command: '',
          dryRunSkipReason: result.reason ?? `Skipping mutating command "${baseCommand}" during dry run.`
        };
      }
      return { id, command: result.command };
    }

    return { id, command: baseCommand };
  });
}

function translateFormatCommandForDryRun(command: string, scripts: Set<string>): { command: string; skip: boolean; reason?: string } {
  const trimmed = command.trim();
  if (!trimmed.startsWith('npm run ')) {
    return {
      command: '',
      skip: true,
      reason: `Cannot derive non-mutating variant for "${trimmed}" during dry run.`
    };
  }

  const script = trimmed.replace('npm run ', '');
  const base = script.replace(/:fix$/, '');
  const checkCandidates = [
    `${base}:check`,
    script.endsWith(':fix') ? `${script.slice(0, -4)}check` : '',
    `${base}:dry-run`
  ].filter(Boolean);

  for (const candidate of checkCandidates) {
    if (scripts.has(candidate)) {
      return { command: `npm run ${candidate}`, skip: false };
    }
  }

  return {
    command: '',
    skip: true,
    reason: `No non-mutating variant found for "${trimmed}".`
  };
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
  hooks: PipelineHooks,
  mode: PipelineMode,
  onDryRunPatch?: (info: DryRunPatchInfo) => Promise<void> | void
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

    if (mode === 'dry-run') {
      await onDryRunPatch?.({ step, files: permittedFiles, diff: patch.diff, meta: patch.meta });
      return true;
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
  await execGitWithInput(['apply', '--check', '--whitespace=nowarn', '-'], cwd, diff);
  await execGitWithInput(['apply', '--whitespace=nowarn', '-'], cwd, diff);
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
      .map((line) => line.slice(3).trim())
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

function formatStepLabel(step: PipelineStepId): string {
  return STEP_LABELS[step];
}

let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return outputChannel;
}

async function getPackageScripts(cwd: string): Promise<Set<string>> {
  try {
    const packageJsonPath = path.join(cwd, 'package.json');
    const contents = await fs.readFile(packageJsonPath, 'utf8');
    const pkg = JSON.parse(contents) as { scripts?: Record<string, string> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

async function captureRepoSnapshot(cwd: string): Promise<RepoSnapshot> {
  const [
    { stdout: stagedPatch },
    { stdout: unstagedPatch },
    { stdout: untrackedStdout },
    { stdout: statusStdout }
  ] = await Promise.all([
    execFileAsync('git', ['diff', '--binary', '--cached'], { cwd, maxBuffer: GIT_DIFF_BUFFER }),
    execFileAsync('git', ['diff', '--binary'], { cwd, maxBuffer: GIT_DIFF_BUFFER }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, maxBuffer: GIT_DIFF_BUFFER }),
    execFileAsync('git', ['status', '--porcelain=v2', '-z'], { cwd, maxBuffer: GIT_DIFF_BUFFER })
  ]);

  const untrackedFiles = untrackedStdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const untrackedDirs = statusStdout
    .split('\0')
    .filter((entry) => entry.length > 0 && entry.startsWith('? '))
    .map((entry) => entry.slice(2))
    .filter((path) => path.endsWith('/'))
    .map((path) => path.slice(0, -1));

  let untrackedDir: string | undefined;
  if (untrackedFiles.length > 0) {
    untrackedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-smith-untracked-'));
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
    untrackedDir
  };
}

async function restoreRepoSnapshot(cwd: string, snapshot: RepoSnapshot): Promise<void> {
  await execAsync('git reset --hard', { cwd });
  await execFileAsync('git', ['clean', '-fd', '-e', '.commit-smith', '-e', '.commit-smith/**'], { cwd });

  if (snapshot.stagedPatch.trim().length > 0) {
    await execGitWithInput(['apply', '--binary', '--index', '-'], cwd, snapshot.stagedPatch);
  }

  if (snapshot.unstagedPatch.trim().length > 0) {
    await execGitWithInput(['apply', '--binary', '-'], cwd, snapshot.unstagedPatch);
  }

  if (snapshot.untrackedDir) {
    for (const relativePath of snapshot.untrackedFiles) {
      const source = path.join(snapshot.untrackedDir, relativePath);
      const destination = path.join(cwd, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await copyEntryPreservingSymlink(source, destination);
    }
    await fs.rm(snapshot.untrackedDir, { recursive: true, force: true });
  }

  const dirsToRestore = [...new Set([...snapshot.untrackedDirs, ...snapshot.emptyDirs])].sort((a, b) => a.length - b.length);
  for (const dir of dirsToRestore) {
    await fs.mkdir(path.join(cwd, dir), { recursive: true });
  }
}

function execGitWithInput(args: string[], cwd: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer: GIT_DIFF_BUFFER }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });

    if (!child.stdin) {
      reject(new Error('Failed to write to git stdin.'));
      return;
    }

    child.stdin.on('error', reject);
    child.stdin.end(input, 'utf8');
  });
}

async function copyEntryPreservingSymlink(source: string, destination: string): Promise<void> {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) {
    const target = await fs.readlink(source);
    let linkType: SymlinkType | undefined;

    if (process.platform === 'win32') {
      try {
        const targetStats = await fs.stat(source);
        linkType = targetStats.isDirectory() ? 'junction' : 'file';
      } catch {
        linkType = 'file';
      }
    }

    try {
      await fs.symlink(target, destination, linkType);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (
        process.platform === 'win32' &&
        (linkType === undefined || linkType === 'file') &&
        (nodeError.code === 'EPERM' || nodeError.code === 'EINVAL')
      ) {
        await fs.symlink(target, destination, 'junction');
      } else {
        throw error;
      }
    }
    return;
  }

  await fs.copyFile(source, destination);
}

async function collectEmptyDirectories(root: string): Promise<string[]> {
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
      if (entry.name === '.git') {
        hasContent = true;
        continue;
      }
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
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

  await explore('');
  return emptyDirs;
}
