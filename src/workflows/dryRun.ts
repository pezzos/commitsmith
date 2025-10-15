import path from 'node:path';
import { promises as fs } from 'node:fs';

import { readJournal } from '../journal';
import {
  runPipeline,
  PipelineHooks,
  PipelineDecisionEvent,
  PipelineDecision,
  PipelineStepId,
  DryRunPatchInfo,
  PipelineOutcome
} from '../pipeline';
import { generateCommitMessage } from '../codex';
import { GitRepository } from '../types/git';

interface StepSummary {
  readonly step: PipelineStepId;
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly attempt: number;
}

interface PatchSummary {
  readonly step: PipelineStepId;
  readonly files: string[];
  readonly file: string;
}

export interface DryRunOptions {
  readonly repo: GitRepository;
  readonly log: (message: string) => void;
  readonly promptDecision: (event: PipelineDecisionEvent) => Promise<PipelineDecision>;
}

export type DryRunResult =
  | { status: 'empty' }
  | { status: 'aborted'; folder: string; failedStep?: PipelineStepId }
  | { status: 'completed'; folder: string }
  | { status: 'error'; message: string };

export async function performDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const repoRoot = options.repo.rootUri.fsPath;
  try {
    const journal = await readJournal({ root: repoRoot, createIfMissing: false });

    if (!journal.current || journal.current.length === 0) {
      return { status: 'empty' };
    }

    const artifactsRoot = path.join(repoRoot, '.commit-smith', 'patches');
    await fs.mkdir(artifactsRoot, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:]/g, '-');
    const artifactDir = path.join(artifactsRoot, timestamp);
    await fs.mkdir(artifactDir, { recursive: true });

    const stepSummaries: StepSummary[] = [];
    const patchSummaries: PatchSummary[] = [];

    const hooks: PipelineHooks = {
      onStepStart: ({ step, attempt }) => {
        options.log(`[${formatStepLabel(step)} ▶️] Attempt ${attempt + 1}`);
      },
      onStepComplete: (result) => {
        const status = result.success ? '✅' : '❌';
        options.log(`[${formatStepLabel(result.step)} ${status}]`);
        stepSummaries.push({
          step: result.step,
          success: result.success,
          stdout: result.stdout,
          stderr: result.stderr,
          attempt: result.attempt
        });
      },
      onDecisionRequired: (event) => options.promptDecision(event)
    };

    const capturePatch = async (info: DryRunPatchInfo) => {
      const fileName = `patch-${String(patchSummaries.length + 1).padStart(2, '0')}.diff`;
      await fs.writeFile(path.join(artifactDir, fileName), info.diff, 'utf8');
      patchSummaries.push({ step: info.step, files: info.files, file: fileName });
    };

    const outcome: PipelineOutcome = await runPipeline({
      repo: options.repo,
      hooks,
      mode: 'dry-run',
      onDryRunPatch: capturePatch
    });

    const commitMessage = await generateCommitMessage(journal);
    await fs.writeFile(path.join(artifactDir, 'COMMIT_MESSAGE.md'), `${commitMessage}\n`, 'utf8');

    const summary = {
      timestamp: new Date().toISOString(),
      status: outcome.status,
      failedStep: outcome.failedStep ?? null,
      steps: stepSummaries,
      patches: patchSummaries
    };
    await fs.writeFile(path.join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

    options.log(`[DRY-RUN 📦] Artefacts saved to ${artifactDir}`);

    if (outcome.status === 'aborted') {
      return { status: 'aborted', folder: artifactDir, failedStep: outcome.failedStep };
    }

    return { status: 'completed', folder: artifactDir };
  } catch (error) {
    return { status: 'error', message: (error as Error).message };
  }
}

function formatStepLabel(step: PipelineStepId): string {
  const labels: Record<PipelineStepId, string> = {
    format: 'FORMAT',
    typecheck: 'TYPECHECK',
    tests: 'TESTS'
  };
  return labels[step];
}
