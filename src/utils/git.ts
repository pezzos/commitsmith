import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from '../types/git';
import type { API as GitApi, GitExtension } from './internal/git';
import { getInitializationStatus } from '../initializer';

const OUTPUT_CHANNEL_NAME = 'CommitSmith';

type OutputChannel = {
  appendLine(value: string): void;
};

let outputChannel: OutputChannel | undefined;
let repositoryWarningShown = false;
let initializationReminderShown = false;

const GIT_RESOLUTION_TIMEOUT_MS = 20000;
const GIT_RESOLUTION_INTERVAL_MS = 2000;

export async function getRepo(): Promise<GitRepository> {
  const workspaceHasGit = await workspaceHasGitRepository();
  logInfo(`[git] workspaceHasGit=${workspaceHasGit}`);

  const repository = await resolveRepositoryWithRetry();
  if (!repository) {
    if (workspaceHasGit) {
      const message =
        'CommitSmith is waiting for the Git extension to finish loading this workspace. Try again in a few seconds.';
      logInfo('[git] Git extension not ready after waiting for repositories.');
      if (!repositoryWarningShown) {
        repositoryWarningShown = true;
        void vscode.window
          .showWarningMessage(message, 'Retry', 'Initialize CommitSmith')
          .then((selection) => {
            if (selection === 'Initialize CommitSmith') {
              void vscode.commands.executeCommand('commitSmith.initializeRepo');
            }
            if (selection === 'Retry') {
              repositoryWarningShown = false;
              void getRepo().catch(() => {
                // Swallow; follow-up warnings already handled.
              });
            }
          });
      }
      throw new Error('Git extension not ready yet.');
    }

    const actionableMessage =
      'CommitSmith needs an initialized Git repository. Open a folder that already contains a .git directory or run “Git: Initialize Repository”.';
    logError('No Git repository detected in the current workspace.');
    if (!repositoryWarningShown) {
      repositoryWarningShown = true;
      void vscode.window.showErrorMessage(actionableMessage, 'Initialize Repository').then((selection) => {
        if (selection === 'Initialize Repository') {
          void vscode.commands.executeCommand('git.init');
        }
      });
    }
    throw new Error(actionableMessage);
  }

  logInfo(`[git] Using repository at ${repository.rootUri.fsPath}`);
  void remindInitializationIfNeeded(repository).catch((error) => {
    logError('Failed to check CommitSmith initialization status', error);
  });
  return repository;
}

export async function stageModified(repo: GitRepository, files?: string[]): Promise<void> {
  try {
    if (files && files.length > 0) {
      const uris = files.map((file) => {
        const absolute = path.isAbsolute(file) ? file : path.join(repo.rootUri.fsPath, file);
        return vscode.Uri.file(absolute);
      });
      await repo.add(uris);
    } else {
      await repo.addDot();
    }
  } catch (error) {
    logError('Failed to stage changes', error);
    throw error;
  }
}

export async function commit(repo: GitRepository, message: string): Promise<void> {
  if (!message.trim()) {
    throw new Error('Commit message must not be empty.');
  }

  try {
    await repo.commit(message, { all: false });
  } catch (error) {
    logError('Commit failed', error);
    throw error;
  }
}

export async function push(repo: GitRepository): Promise<void> {
  try {
    await repo.push();
  } catch (error) {
    logError('Push failed', error);
    throw error;
  }
}

async function resolveRepository(): Promise<GitRepository | undefined> {
  const gitApi = await getGitApi();
  if (!gitApi) {
    return undefined;
  }

  const repo = gitApi.activeRepository ?? gitApi.repositories[0];
  logInfo(
    `[git] resolveRepository -> active=${
      gitApi.activeRepository?.rootUri.fsPath ?? 'none'
    } repositories=${gitApi.repositories.map((entry) => entry.rootUri.fsPath).join(',') || '[]'}`
  );
  return repo;
}

async function getGitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    logError('Unable to find the VS Code Git extension.');
    return undefined;
  }

  if (!extension.isActive) {
    logInfo('[git] Activating VS Code Git extension…');
    await extension.activate();
    logInfo('[git] VS Code Git extension activated.');
  }

  try {
    return extension.exports.getAPI(1);
  } catch (error) {
    logError('Failed to obtain Git API export', error);
    return undefined;
  }
}

function logError(message: string, error?: unknown): void {
  const channel = getOutputChannel();
  const suffix = error instanceof Error ? `: ${error.message}` : '';
  channel.appendLine(`[CommitSmith][git] ${message}${suffix}`);
}

function logInfo(message: string): void {
  const channel = getOutputChannel();
  channel.appendLine(`[CommitSmith][git] ${message}`);
}

function getOutputChannel(): OutputChannel {
  if (outputChannel) {
    return outputChannel;
  }

  outputChannel = vscode.window?.createOutputChannel?.(OUTPUT_CHANNEL_NAME) ?? {
    appendLine: (value: string) => console.error(value)
  };

  return outputChannel;
}

async function resolveRepositoryWithRetry(): Promise<GitRepository | undefined> {
  const deadline = Date.now() + GIT_RESOLUTION_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() <= deadline) {
    attempt += 1;
    const repo = await resolveRepository();
    if (repo) {
      if (attempt > 1) {
        logInfo(`[git] Repository resolved after ${attempt} attempts.`);
      }
      return repo;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    logInfo(`[git] No repository yet (attempt ${attempt}); retrying in ${GIT_RESOLUTION_INTERVAL_MS / 1000}s.`);
    await delay(GIT_RESOLUTION_INTERVAL_MS);
  }
  return undefined;
}

async function workspaceHasGitRepository(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const gitPath = path.join(folder.uri.fsPath, '.git');
    try {
      await fs.access(gitPath);
      logInfo(`[git] Detected .git directory at ${gitPath}`);
      return true;
    } catch {
      // Continue checking other folders.
    }
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function remindInitializationIfNeeded(repository: GitRepository): Promise<void> {
  if (initializationReminderShown) {
    return;
  }

  try {
    const status = await getInitializationStatus(repository.rootUri.fsPath);
    if (!status.needsInitialization) {
      return;
    }

    initializationReminderShown = true;
    const message =
      'CommitSmith setup is incomplete for this repository. Initialize CommitSmith to create the journal, .gitignore entry, and agent guidance.';
    void vscode.window.showInformationMessage(message, 'Initialize CommitSmith').then((selection) => {
      if (selection === 'Initialize CommitSmith') {
        void vscode.commands.executeCommand('commitSmith.initializeRepo');
      }
    });
  } catch (error) {
    logError('Unable to determine CommitSmith initialization status', error);
  }
}
