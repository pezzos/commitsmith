import path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from '../types/git';
import type { API as GitApi, GitExtension } from './internal/git';

const OUTPUT_CHANNEL_NAME = 'CommitSmith';

type OutputChannel = {
  appendLine(value: string): void;
};

let outputChannel: OutputChannel | undefined;

export async function getRepo(): Promise<GitRepository> {
  const repository = await resolveRepository();
  if (!repository) {
    throw new Error('No active Git repository was found in the current workspace.');
  }

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

  return gitApi.activeRepository;
}

async function getGitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    logError('Unable to find the VS Code Git extension.');
    return undefined;
  }

  if (!extension.isActive) {
    await extension.activate();
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

function getOutputChannel(): OutputChannel {
  if (outputChannel) {
    return outputChannel;
  }

  outputChannel = vscode.window?.createOutputChannel?.(OUTPUT_CHANNEL_NAME) ?? {
    appendLine: (value: string) => console.error(value)
  };

  return outputChannel;
}
