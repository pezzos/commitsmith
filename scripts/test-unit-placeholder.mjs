#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../dist');
const initializerModule = await import(path.join(distPath, 'initializer.js'));
const journalModule = await import(path.join(distPath, 'journal.js'));
const agentsModule = await import(path.join(distPath, 'agents.js'));

const { getInitializationStatus, initializeRepository } = initializerModule;
const { initializeJournal } = journalModule;
const { ensureJournalWorkflowSection } = agentsModule;

console.info('Running initialization unit tests...');

const baseDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-init-'));

let status = await getInitializationStatus(baseDir);
assert.equal(status.journalReady, false);
assert.equal(status.gitignoreReady, false);
assert.equal(status.guidanceReady, false);
assert.equal(status.needsInitialization, true);

const firstRun = await initializeRepository({ root: baseDir, log: () => {} });
assert.equal(firstRun.status.needsInitialization, false);
assert.equal(firstRun.status.journalReady, true);
assert.equal(firstRun.status.gitignoreReady, true);
assert.equal(firstRun.status.guidanceReady, true);
assert.equal(firstRun.steps.length, 3);
assert.ok(firstRun.steps.some((step) => step.changed === true));

const journalPath = path.join(baseDir, '.ai-commit-journal.yml');
const generatedJournal = await readFile(journalPath, 'utf8');
assert.equal(generatedJournal, 'current: []\nmeta: {}\n');

const gitignorePath = path.join(baseDir, '.gitignore');
const generatedGitignore = await readFile(gitignorePath, 'utf8');
assert.match(generatedGitignore, /\.ai-commit-journal\.yml/);

const generatedAgents = await readFile(path.join(baseDir, 'AGENTS.md'), 'utf8');
assert.match(generatedAgents, /^##\s+CommitSmith Journal Workflow/m);
assert.match(generatedAgents, /commitsmith-journal-workflow/);
const headingOccurrences = generatedAgents.split('## CommitSmith Journal Workflow').length - 1;
assert.equal(headingOccurrences, 1);

const secondRun = await initializeRepository({ root: baseDir, log: () => {} });
assert.equal(secondRun.status.needsInitialization, false);
for (const step of secondRun.steps) {
  assert.equal(step.changed, false);
}
const gitignoreAfterSecondRun = await readFile(gitignorePath, 'utf8');
assert.equal(generatedGitignore, gitignoreAfterSecondRun);
const journalAfterSecondRun = await readFile(journalPath, 'utf8');
assert.equal(generatedJournal, journalAfterSecondRun);

// Journal detection
const journalDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-init-journal-'));
await writeFile(path.join(journalDir, '.ai-commit-journal.yml'), 'current: []\nmeta: {}\n', 'utf8');
status = await getInitializationStatus(journalDir);
assert.equal(status.journalReady, true);
assert.equal(status.gitignoreReady, false);
assert.equal(status.guidanceReady, false);

// gitignore detection
const gitignoreDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-init-ignore-'));
await writeFile(path.join(gitignoreDir, '.gitignore'), '.ai-commit-journal.yml\n', 'utf8');
status = await getInitializationStatus(gitignoreDir);
assert.equal(status.gitignoreReady, true);
assert.equal(status.journalReady, false);
assert.equal(status.guidanceReady, false);

// Guidance detection
const guidanceDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-init-guidance-'));
await writeFile(
  path.join(guidanceDir, 'AGENTS.md'),
  '## CommitSmith Journal Workflow\n<!-- slug: commitsmith-journal-workflow -->\n',
  'utf8'
);
status = await getInitializationStatus(guidanceDir);
assert.equal(status.guidanceReady, true);
assert.equal(status.journalReady, false);
assert.equal(status.gitignoreReady, false);

// Invalid journal should surface error without changing file
const invalidDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-init-invalid-'));
const invalidJournalPath = path.join(invalidDir, '.ai-commit-journal.yml');
await writeFile(invalidJournalPath, 'current: 123\n', 'utf8');
let invalidError;
try {
  await initializeRepository({ root: invalidDir, log: () => {} });
} catch (error) {
  invalidError = error;
}
assert.ok(invalidError instanceof Error);
assert.match(invalidError.message, /journal/i);
const invalidJournalContents = await readFile(invalidJournalPath, 'utf8');
assert.equal(invalidJournalContents, 'current: 123\n');
let gitignoreExists = true;
try {
  await access(path.join(invalidDir, '.gitignore'));
} catch (error) {
  if (error && error.code === 'ENOENT') {
    gitignoreExists = false;
  } else {
    throw error;
  }
}
assert.equal(gitignoreExists, false);

// initializeJournal should validate without rewriting invalid files
let initializeJournalError;
try {
  await initializeJournal({ root: invalidDir });
} catch (error) {
  initializeJournalError = error;
}
assert.ok(initializeJournalError instanceof Error);
assert.match(initializeJournalError.message, /Existing journal failed validation/i);
const invalidJournalAfterHelper = await readFile(invalidJournalPath, 'utf8');
assert.equal(invalidJournalAfterHelper, 'current: 123\n');

// gitignore CRLF preservation and idempotency
const crlfDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-init-crlf-'));
const crlfGitignorePath = path.join(crlfDir, '.gitignore');
await writeFile(crlfGitignorePath, 'dist\r\nbuild\r\n', 'utf8');
const crlfFirst = await initializeRepository({ root: crlfDir, log: () => {} });
assert.equal(crlfFirst.status.needsInitialization, false);
const crlfGitignore = await readFile(crlfGitignorePath, 'utf8');
assert.ok(crlfGitignore.includes('.ai-commit-journal.yml'));
assert.ok(crlfGitignore.includes('\r\n'));
assert.equal(crlfGitignore.replace(/\r\n/g, '').includes('\n'), false);
const journalOccurrences = crlfGitignore.split('.ai-commit-journal.yml').length - 1;
assert.equal(journalOccurrences, 1);
const crlfSecond = await initializeRepository({ root: crlfDir, log: () => {} });
for (const step of crlfSecond.steps) {
  if (step.id === 'gitignore') {
    assert.equal(step.changed, false);
  }
}
const crlfGitignoreAfter = await readFile(crlfGitignorePath, 'utf8');
assert.equal(crlfGitignore, crlfGitignoreAfter);

// agents guidance writer idempotency
const agentsDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-agents-'));
const firstAgents = await ensureJournalWorkflowSection(agentsDir);
assert.equal(firstAgents.changed, true);
const agentsContent = await readFile(path.join(agentsDir, 'AGENTS.md'), 'utf8');
assert.match(agentsContent, /^##\s+CommitSmith Journal Workflow/m);
const secondAgents = await ensureJournalWorkflowSection(agentsDir);
assert.equal(secondAgents.changed, false);
const agentsContentAfter = await readFile(path.join(agentsDir, 'AGENTS.md'), 'utf8');
assert.equal(agentsContent, agentsContentAfter);

console.info('Initialization unit tests passed');
