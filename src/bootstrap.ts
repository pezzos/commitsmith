import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { OutputChannelLike } from './output';

const STATE_KEY_PREFIX = 'commitSmith.codexBootstrap.';
const TERMINAL_NAME = 'CommitSmith Codex Onboarding';
const SESSION_PROMPTED_ROOTS = new Set<string>();

type BootstrapPreference = 'accepted' | 'dismissed';

interface OfferOptions {
  readonly force?: boolean;
}

export async function offerCodexBootstrap(
  context: vscode.ExtensionContext,
  repoRoot: string,
  outputChannel: OutputChannelLike,
  options?: OfferOptions
): Promise<void> {
  const key = stateKey(repoRoot);
  const preference = context.workspaceState.get<BootstrapPreference | undefined>(key);
  if (!options?.force) {
    if (preference === 'dismissed' || preference === 'accepted') {
      return;
    }
    if (SESSION_PROMPTED_ROOTS.has(repoRoot)) {
      return;
    }
  }

  const agentsExists = await hasAgentsGuidance(repoRoot);
  if (!agentsExists) {
    outputChannel.appendLine('[INIT][codex] Skipping Codex onboarding prompt; AGENTS.md not found.');
    return;
  }

  SESSION_PROMPTED_ROOTS.add(repoRoot);

  const message =
    'Codex can preload the CommitSmith journal workflow guidance from AGENTS.md. Run the Codex onboarding prompt now?';
  const selection = await vscode.window.showInformationMessage(
    message,
    'Run Codex Onboarding',
    'Later',
    "Don't remind me"
  );

  if (!selection) {
    return;
  }
  if (selection === 'Run Codex Onboarding') {
    await executeCodexBootstrap(context, repoRoot, outputChannel);
    return;
  }
  if (selection === "Don't remind me") {
    await context.workspaceState.update(key, 'dismissed');
  }
}

export async function executeCodexBootstrap(
  context: vscode.ExtensionContext,
  repoRoot: string,
  outputChannel: OutputChannelLike
): Promise<void> {
  const key = stateKey(repoRoot);
  const agentsExists = await hasAgentsGuidance(repoRoot);
  if (!agentsExists) {
    vscode.window.showWarningMessage('AGENTS.md is missing; run CommitSmith initialization first.');
    outputChannel.appendLine('[INIT][codex] Bootstrap skipped because AGENTS.md is missing.');
    return;
  }

  const terminal = getOrCreateTerminal(repoRoot);
  terminal.show(true);

  const prompt =
    'Read AGENTS.md and adopt the "CommitSmith Journal Workflow" guidance. Confirm you will run `commit-smith journal --append "<entry>"` (with any needed `--meta key=value` flags to keep scope, ticket, ticketFromBranch, and style up to date) after every task and rerun `CommitSmith: Initialize CommitSmith` if the journal, .gitignore entry, or guidance are missing. Reply ACKNOWLEDGED when ready.';
  const command = `codex --cd ${shellQuote(repoRoot)} -p ${shellQuote(prompt)}`;
  terminal.sendText(command, true);

  outputChannel.appendLine('[INIT][codex] Launched Codex onboarding prompt in the integrated terminal.');
  SESSION_PROMPTED_ROOTS.add(repoRoot);
  await context.workspaceState.update(key, 'accepted');
}

function stateKey(repoRoot: string): string {
  return `${STATE_KEY_PREFIX}${repoRoot}`;
}

async function hasAgentsGuidance(repoRoot: string): Promise<boolean> {
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  try {
    await fs.access(agentsPath);
    return true;
  } catch {
    return false;
  }
}

function getOrCreateTerminal(repoRoot: string): vscode.Terminal {
  const existing = vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_NAME);
  if (existing) {
    existing.sendText(`cd ${shellQuote(repoRoot)}`, true);
    return existing;
  }
  return vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd: repoRoot
  });
}

function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
