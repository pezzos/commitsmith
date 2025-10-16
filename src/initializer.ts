import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initializeJournal, readJournal } from './journal';
import { ensureJournalWorkflowSection, hasJournalWorkflowSection } from './agents';

const JOURNAL_FILENAME = '.ai-commit-journal.yml';
const GITIGNORE_FILENAME = '.gitignore';

export interface InitializationStatus {
  readonly journalReady: boolean;
  readonly gitignoreReady: boolean;
  readonly guidanceReady: boolean;
  readonly needsInitialization: boolean;
}

export type InitializationStepId = 'journal' | 'gitignore' | 'guidance';

export interface InitializationStepResult {
  readonly id: InitializationStepId;
  readonly changed: boolean;
  readonly message: string;
}

export interface InitializeRepositoryOptions {
  readonly root: string;
  readonly log?: (message: string) => void;
}

export interface InitializeRepositoryResult {
  readonly steps: InitializationStepResult[];
  readonly status: InitializationStatus;
}

export async function getInitializationStatus(root: string): Promise<InitializationStatus> {
  const [journalReady, gitignoreReady, guidanceReady] = await Promise.all([
    isJournalReady(root),
    isGitignoreReady(root),
    isGuidanceReady(root)
  ]);

  return {
    journalReady,
    gitignoreReady,
    guidanceReady,
    needsInitialization: !(journalReady && gitignoreReady && guidanceReady)
  };
}

export async function initializeRepository(options: InitializeRepositoryOptions): Promise<InitializeRepositoryResult> {
  const { root, log } = options;
  const writeLog = log ?? (() => undefined);

  writeLog(`[INIT] Checking CommitSmith prerequisites at ${root}`);
  const status = await getInitializationStatus(root);
  const steps: InitializationStepResult[] = [];
  writeLog(
    `[INIT] Initial status -> journal:${status.journalReady} gitignore:${status.gitignoreReady} guidance:${status.guidanceReady}`
  );

  if (!status.journalReady) {
    await initializeJournal({ root });
    steps.push({
      id: 'journal',
      changed: true,
      message: 'Created .ai-commit-journal.yml with default schema.'
    });
    writeLog('[INIT][journal] Created .ai-commit-journal.yml.');
  } else {
    steps.push({
      id: 'journal',
      changed: false,
      message: 'Journal already present.'
    });
    writeLog('[INIT][journal] Journal already present.');
  }

  const gitignoreResult = await ensureGitignoreRule(root);
  steps.push(gitignoreResult);
  writeLog(`[INIT][gitignore] ${gitignoreResult.message}`);

  const guidanceResult = await ensureGuidance(root);
  steps.push(guidanceResult);
  writeLog(`[INIT][guidance] ${guidanceResult.message}`);

  const updatedStatus = await getInitializationStatus(root);
  writeLog(
    `[INIT] Final status -> journal:${updatedStatus.journalReady} gitignore:${updatedStatus.gitignoreReady} guidance:${updatedStatus.guidanceReady} needsInitialization:${updatedStatus.needsInitialization}`
  );

  return {
    steps,
    status: updatedStatus
  };
}

async function isJournalReady(root: string): Promise<boolean> {
  const journalPath = path.join(root, JOURNAL_FILENAME);
  try {
    await fs.access(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  try {
    await readJournal({ root, createIfMissing: false });
    return true;
  } catch (error) {
    throw new Error(`CommitSmith journal invalid: ${(error as Error).message}`);
  }
}

async function isGitignoreReady(root: string): Promise<boolean> {
  const gitignorePath = path.join(root, GITIGNORE_FILENAME);
  try {
    const content = await fs.readFile(gitignorePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === JOURNAL_FILENAME);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    return false;
  }
}

async function isGuidanceReady(root: string): Promise<boolean> {
  const agentsPath = path.join(root, 'AGENTS.md');
  try {
    const content = await fs.readFile(agentsPath, 'utf8');
    return hasJournalWorkflowSection(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    return false;
  }
}

async function ensureGitignoreRule(root: string): Promise<InitializationStepResult> {
  const gitignorePath = path.join(root, GITIGNORE_FILENAME);
  let content = '';
  try {
    content = await fs.readFile(gitignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const hasRule = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === JOURNAL_FILENAME);

  if (hasRule) {
    return {
      id: 'gitignore',
      changed: false,
      message: '.gitignore already contains .ai-commit-journal.yml.'
    };
  }

  const newline = detectLineEnding(content);
  let updated = content;
  if (updated.length > 0 && !updated.endsWith('\n') && !updated.endsWith('\r')) {
    updated += newline;
  }
  updated += JOURNAL_FILENAME;
  updated += newline;

  await fs.writeFile(gitignorePath, updated, 'utf8');

  return {
    id: 'gitignore',
    changed: true,
    message: 'Ensured .gitignore ignores .ai-commit-journal.yml.'
  };
}

async function ensureGuidance(root: string): Promise<InitializationStepResult> {
  const result = await ensureJournalWorkflowSection(root);
  return {
    id: 'guidance',
    changed: result.changed,
    message: result.message
  };
}

function detectLineEnding(content: string): string {
  if (content.includes('\r\n')) {
    return '\r\n';
  }
  if (content.includes('\r')) {
    return '\r';
  }
  return '\n';
}
