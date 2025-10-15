import { getConfig } from '../config';
import { initializeJournal, readJournal, clearCurrent } from '../journal';
import { runPipeline, PipelineHooks, PipelineOutcome, PipelineDecisionEvent, PipelineDecision, PipelineStepId } from '../pipeline';
import { commit, push } from '../utils/git';
import { generateCommitMessage } from '../codex';
import { GitRepository } from '../types/git';

export interface ForgeCommitOptions {
  readonly repo: GitRepository;
  readonly journalRoot?: string;
  readonly log: (message: string) => void;
  readonly promptDecision: (event: PipelineDecisionEvent) => Promise<PipelineDecision>;
}

export type ForgeCommitResult =
  | { status: 'empty' }
  | { status: 'pipeline-aborted'; failedStep?: PipelineStepId }
  | { status: 'commit-success'; pushFailed: boolean }
  | { status: 'commit-warning'; pushFailed: boolean; commitAnnotation: string }
  | { status: 'error'; message: string };

export async function forgeCommitFromJournal(options: ForgeCommitOptions): Promise<ForgeCommitResult> {
  const journalRoot = options.journalRoot ?? options.repo.rootUri.fsPath;
  const config = getConfig();

  try {
    await initializeJournal({ root: journalRoot });
    const journal = await readJournal({ root: journalRoot });

    if (!journal.current || journal.current.length === 0) {
      return { status: 'empty' };
    }

    const pipelineHooks = createPipelineHooks(options);
    const outcome: PipelineOutcome = await runPipeline({ repo: options.repo, hooks: pipelineHooks });

    if (outcome.status === 'aborted') {
      return { status: 'pipeline-aborted', failedStep: outcome.failedStep };
    }

    const commitMessage = await generateCommitMessage(journal);
    const finalMessage = outcome.commitAnnotation
      ? `${commitMessage}\n\n${outcome.commitAnnotation}`
      : commitMessage;

    await commit(options.repo, finalMessage);
    options.log('[COMMIT ✅] Created git commit.');

    let pushFailed = false;
    if (config.commitPushAfter && !outcome.suppressAutoPush) {
      try {
        await push(options.repo);
        options.log('[PUSH ✅] Changes pushed to remote.');
      } catch (error) {
        pushFailed = true;
        options.log(`[PUSH ❌] ${(error as Error).message}`);
      }
    } else if (config.commitPushAfter && outcome.suppressAutoPush) {
      options.log('[PUSH ⏭️] Skipped auto-push due to pipeline decision.');
    }

    await clearCurrent({ root: journalRoot });
    options.log('[JOURNAL 🗑️] Cleared current entries.');

    if (outcome.status === 'commit-anyway') {
      return {
        status: 'commit-warning',
        pushFailed,
        commitAnnotation: outcome.commitAnnotation ?? ''
      };
    }

    return { status: 'commit-success', pushFailed };
  } catch (error) {
    return { status: 'error', message: (error as Error).message };
  }
}

function createPipelineHooks(options: ForgeCommitOptions): PipelineHooks {
  return {
    onStepStart: ({ step, attempt }) => {
      options.log(`[${formatStepLabel(step)} ▶️] Attempt ${attempt + 1}`);
    },
    onStepComplete: (result) => {
      const status = result.success ? '✅' : '❌';
      options.log(`[${formatStepLabel(result.step)} ${status}]`);
    },
    onDecisionRequired: (event) => options.promptDecision(event)
  };
}

function formatStepLabel(step: PipelineStepId): string {
  switch (step) {
    case 'format':
      return 'FORMAT';
    case 'typecheck':
      return 'TYPECHECK';
    case 'tests':
      return 'TESTS';
    default:
      return step.toUpperCase();
  }
}
