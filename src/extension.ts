import * as vscode from 'vscode';
import { getConfig, initializeConfigWatcher, onDidChangeConfig } from './config';

const HELLO_COMMAND_ID = 'commitSmith.helloWorld';

export function activate(context: vscode.ExtensionContext): void {
  initializeConfigWatcher(context);

  const disposable = vscode.commands.registerCommand(HELLO_COMMAND_ID, () => {
    const config = getConfig();
    vscode.window.showInformationMessage(
      `CommitSmith is ready to forge commits using ${config.messageStyle} messages.`
    );
  });

  const configSubscription = onDidChangeConfig((updated) => {
    console.log('CommitSmith configuration updated', updated);
  });

  context.subscriptions.push(disposable, configSubscription);
}

export function deactivate(): void {
  // No-op: resources are disposed via subscriptions.
}
