import * as vscode from 'vscode';
import { initializeConfigWatcher, onDidChangeConfig } from './config';
import { getRepo } from './utils/git';
import { forgeCommitFromJournal } from './workflows/forgeCommit';
import { performDryRun } from './workflows/dryRun';
import { PipelineDecisionEvent, PipelineDecision } from './pipeline';
import { initializeJournal, clearCurrent } from './journal';
import { getInitializationStatus, initializeRepository } from './initializer';
import { onCodexOfflineFallback } from './codex';
import { offerCodexBootstrap, executeCodexBootstrap } from './bootstrap';
import { getOutputChannel, isVscodeOutputChannel, OutputChannelLike } from './output';

const COMMAND_GENERATE = 'commitSmith.generateFromJournal';
const COMMAND_CLEAR = 'commitSmith.clearJournal';
const COMMAND_INSTALL_HOOKS = 'commitSmith.installHooks';
const COMMAND_INITIALIZE = 'commitSmith.initializeRepo';
const COMMAND_DRY_RUN = 'commitSmith.dryRun';
const COMMAND_BOOTSTRAP = 'commitSmith.codexBootstrap';

export function activate(context: vscode.ExtensionContext): void {
  initializeConfigWatcher(context);

  const outputChannel = getOutputChannel();
  if (isVscodeOutputChannel(outputChannel)) {
    context.subscriptions.push(outputChannel);
  }

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
    vscode.commands.registerCommand(COMMAND_DRY_RUN, () => handleDryRun(outputChannel)),
    vscode.commands.registerCommand(COMMAND_INITIALIZE, () => handleInitializeRepo(context, outputChannel)),
    vscode.commands.registerCommand(COMMAND_BOOTSTRAP, () => handleCodexBootstrap(context, outputChannel))
  );

  void promptForInitializationIfNeeded(context, outputChannel);
}

export function deactivate(): void {
  // Disposables are tracked in activate.
}

async function handleGenerateFromJournal(outputChannel: OutputChannelLike): Promise<void> {
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

async function handleInitializeRepo(context: vscode.ExtensionContext, outputChannel: OutputChannelLike): Promise<void> {
  try {
    const repo = await getRepo({ suppressInitializationReminder: true });
    await runInitializationFlow(context, repo.rootUri.fsPath, outputChannel, { origin: 'manual-command' });
  } catch (error) {
    const message = (error as Error).message;
    outputChannel.appendLine(`[INIT][error] ${message}`);
    vscode.window.showErrorMessage(`CommitSmith initialization failed: ${message}`);
  }
}

async function handleCodexBootstrap(context: vscode.ExtensionContext, outputChannel: OutputChannelLike): Promise<void> {
  try {
    const repo = await getRepo({ suppressInitializationReminder: true });
    await executeCodexBootstrap(context, repo.rootUri.fsPath, outputChannel);
  } catch (error) {
    const message = (error as Error).message;
    outputChannel.appendLine(`[BOOTSTRAP][error] ${message}`);
    vscode.window.showErrorMessage(`Codex onboarding failed: ${message}`);
  }
}

async function handleDryRun(outputChannel: OutputChannelLike): Promise<void> {
  try {
    const repo = await getRepo();

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CommitSmith: dry run',
        cancellable: false
      },
      async () =>
        performDryRun({
          repo,
          log: (message) => outputChannel.appendLine(message),
          promptDecision: (event) => promptForDecision(event)
        })
    );

    switch (result.status) {
      case 'empty':
        vscode.window.showInformationMessage('CommitSmith journal is empty – nothing to simulate.');
        return;
      case 'aborted':
        vscode.window.showWarningMessage(
          `Dry run aborted ${result.failedStep ? `at ${result.failedStep}` : ''}. Artefacts saved to ${result.folder}.`
        );
        return;
      case 'completed':
        vscode.window.showInformationMessage(`Dry run completed. Artefacts saved to ${result.folder}.`);
        return;
      case 'error':
        vscode.window.showErrorMessage(`CommitSmith dry run failed: ${result.message}`);
        return;
    }
  } catch (error) {
    outputChannel.appendLine(`[ERROR] ${(error as Error).message}`);
    vscode.window.showErrorMessage(`CommitSmith dry run failed: ${(error as Error).message}`);
  }
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

async function promptForInitializationIfNeeded(
  context: vscode.ExtensionContext,
  outputChannel: OutputChannelLike
): Promise<void> {
  try {
    const repo = await getRepo({ suppressInitializationReminder: true });
    const status = await getInitializationStatus(repo.rootUri.fsPath);
    if (!status.needsInitialization) {
      await offerCodexBootstrap(context, repo.rootUri.fsPath, outputChannel);
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      'CommitSmith needs to finish its workspace setup before journal workflows can run.',
      'Initialize CommitSmith',
      'Later'
    );

    if (choice === 'Initialize CommitSmith') {
      await runInitializationFlow(context, repo.rootUri.fsPath, outputChannel, { origin: 'activation' });
    }
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('CommitSmith journal invalid')) {
      outputChannel.appendLine(`[INIT][error] ${message}`);
      vscode.window.showErrorMessage(`CommitSmith initialization failed: ${message}`);
    }
    // Git repository unavailable or other issue; ignore otherwise.
  }
}

interface InitializationFlowOptions {
  readonly origin: 'activation' | 'manual-command';
}

async function runInitializationFlow(
  context: vscode.ExtensionContext,
  repoRoot: string,
  outputChannel: OutputChannelLike,
  options: InitializationFlowOptions
): Promise<void> {
  outputChannel.appendLine(`[INIT] commitSmith.initializeRepo invoked for ${repoRoot}`);
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CommitSmith: configuring workspace',
      cancellable: false
    },
    async () =>
      initializeRepository({
        root: repoRoot,
        log: (message) => outputChannel.appendLine(message)
      })
  );

  for (const step of result.steps) {
    const status = step.changed ? 'updated' : 'unchanged';
    outputChannel.appendLine(`[INIT][summary] ${step.id}: ${status} (${step.message})`);
  }

  if (result.status.needsInitialization) {
    vscode.window.showWarningMessage(
      'CommitSmith setup completed with warnings. Review the output log for details.'
    );
  } else {
    vscode.window.showInformationMessage('CommitSmith setup complete.');
    await offerCodexBootstrap(context, repoRoot, outputChannel, { force: options.origin === 'manual-command' });
  }
}
