import * as vscode from 'vscode';
import { initializeConfigWatcher, onDidChangeConfig } from './config';
import { getRepo } from './utils/git';
import { forgeCommitFromJournal } from './workflows/forgeCommit';
import { PipelineDecisionEvent, PipelineDecision } from './pipeline';
import { initializeJournal, clearCurrent } from './journal';
import { onCodexOfflineFallback } from './codex';

const COMMAND_GENERATE = 'commitSmith.generateFromJournal';
const COMMAND_CLEAR = 'commitSmith.clearJournal';
const COMMAND_INSTALL_HOOKS = 'commitSmith.installHooks';
const COMMAND_DRY_RUN = 'commitSmith.dryRun';
const OUTPUT_CHANNEL_NAME = 'CommitSmith';

export function activate(context: vscode.ExtensionContext): void {
  initializeConfigWatcher(context);

  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  const codexFallbackDisposable = onCodexOfflineFallback((event) => {
    const reason = event.reason === 'timeout' ? 'Codex request timed out' : event.reason === 'network' ? 'Codex request failed' : `Codex returned HTTP ${event.status}`;
    outputChannel.appendLine(`[CODEX ⚠️] ${reason}`);
    vscode.window.showWarningMessage(`CommitSmith fallback: ${reason}`);
  });
  context.subscriptions.push(codexFallbackDisposable);

  const configSubscription = onDidChangeConfig((updated) => {
    outputChannel.appendLine(`[CONFIG] Updated pipeline configuration: ${JSON.stringify(updated)}`);
  });
  context.subscriptions.push(configSubscription);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_GENERATE, () => handleGenerateFromJournal(outputChannel)),
    vscode.commands.registerCommand(COMMAND_CLEAR, handleClearJournal),
    vscode.commands.registerCommand(COMMAND_INSTALL_HOOKS, handleInstallHooks),
    vscode.commands.registerCommand(COMMAND_DRY_RUN, handleDryRun)
  );
}

export function deactivate(): void {
  // Disposables are tracked in activate.
}

async function handleGenerateFromJournal(outputChannel: vscode.OutputChannel): Promise<void> {
  try {
    const repo = await getRepo();
    await initializeJournal({ root: repo.rootUri.fsPath });

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CommitSmith: forging commit',
        cancellable: false
      },
      async () => forgeCommitFromJournal({
        repo,
        journalRoot: repo.rootUri.fsPath,
        log: (message) => outputChannel.appendLine(message),
        promptDecision: (event) => promptForDecision(event)
      })
    );

    switch (result.status) {
      case 'empty':
        vscode.window.showInformationMessage('CommitSmith journal is empty – nothing to forge.');
        return;
      case 'pipeline-aborted':
        vscode.window.showErrorMessage(
          `CommitSmith aborted: ${result.failedStep ? `Pipeline failed at ${result.failedStep}.` : 'Pipeline stopped.'}`
        );
        return;
      case 'commit-warning':
        if ('commitAnnotation' in result && result.commitAnnotation) {
          outputChannel.appendLine(`[COMMIT ⚠️] ${result.commitAnnotation}`);
        }
        if (result.pushFailed) {
          vscode.window.showWarningMessage('Commit completed with warnings. Push failed; check Output panel.');
        } else {
          vscode.window.showWarningMessage('Commit completed with warnings. Review the output log.');
        }
        return;
      case 'commit-success':
        if (result.pushFailed) {
          vscode.window.showWarningMessage('Commit succeeded, but push failed. Check the output log.');
        } else {
          vscode.window.showInformationMessage('CommitSmith forged your commit successfully.');
        }
        return;
      case 'error':
        vscode.window.showErrorMessage(`CommitSmith failed: ${result.message}`);
        return;
    }
  } catch (error) {
    outputChannel.appendLine(`[ERROR] ${(error as Error).message}`);
    vscode.window.showErrorMessage(`CommitSmith failed: ${(error as Error).message}`);
  }
}

async function handleClearJournal(): Promise<void> {
  try {
    const repo = await getRepo();
    await clearCurrent({ root: repo.rootUri.fsPath });
    vscode.window.showInformationMessage('CommitSmith journal cleared.');
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to clear journal: ${(error as Error).message}`);
  }
}

function handleInstallHooks(): void {
  vscode.window.showInformationMessage('CommitSmith hooks installation is coming soon.');
}

function handleDryRun(): void {
  vscode.window.showInformationMessage('CommitSmith dry-run mode is coming soon.');
}

async function promptForDecision(event: PipelineDecisionEvent): Promise<PipelineDecision> {
  const choice = await vscode.window.showWarningMessage(
    `CommitSmith: ${event.step} is still failing after retries.`,
    { modal: true },
    'Commit anyway',
    'Retry step',
    'Abort pipeline'
  );

  if (choice === 'Commit anyway') {
    return 'commitAnyway';
  }
  if (choice === 'Retry step') {
    return 'retry';
  }
  return 'abort';
}
