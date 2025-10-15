#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const outputLogs = [];
const recordedCommits = [];
let pushAttempts = 0;

class EventEmitter {
  #listeners = new Set();

  event(listener) {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  fire(value) {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }
}

const configStore = new Map([
  ['pipeline.enable', true],
  ['pipeline.maxAiFixAttempts', 0],
  ['pipeline.abortOnFailure', true],
  ['commit.pushAfter', false],
  ['message.style', 'conventional']
]);

const vscodeStub = {
  EventEmitter,
  Uri: {
    file(fsPath) {
      return { fsPath };
    }
  },
  window: {
    createOutputChannel() {
      return { appendLine: (line) => outputLogs.push(line) };
    },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined
  },
  workspace: {
    getConfiguration(namespace) {
      if (namespace !== 'commitSmith') {
        throw new Error(`Unexpected configuration namespace: ${namespace}`);
      }
      return {
        get(key, fallback) {
          return configStore.has(key) ? configStore.get(key) : fallback;
        }
      };
    },
    onDidChangeConfiguration() {
      return { dispose() {} };
    }
  }
};

const pipelineOutcomes = [];

const moduleLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }

  if (request.endsWith('codex') || request.endsWith('codex.js')) {
    return {
      generateCommitMessage: async () => {
        throw new Error('Codex offline');
      }
    };
  }

  if (request.endsWith('pipeline') || request.endsWith('pipeline.js')) {
    return {
      runPipeline: async () => {
        if (pipelineOutcomes.length > 0) {
          return pipelineOutcomes.shift();
        }
        return { status: 'completed', suppressAutoPush: false };
      }
    };
  }

  return moduleLoad.call(this, request, parent, isMain);
};

const repoDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-offline-'));
const journalPath = path.join(repoDir, '.ai-commit-journal.yml');

try {
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'offline@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Offline Tester'], { cwd: repoDir });

  await writeFile(journalPath, 'current:\n  - "feat: add offline fallback"\n', 'utf8');

  const stagedFiles = ['src/index.ts', 'src/util/helpers.ts', 'README.md', 'docs/overview.md'];
  for (const file of stagedFiles) {
    const filePath = path.join(repoDir, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '// test content\n', 'utf8');
  }
  await execFileAsync('git', ['add', 'src/index.ts', 'src/util/helpers.ts', 'README.md', 'docs/overview.md'], { cwd: repoDir });

  pipelineOutcomes.push({ status: 'completed', suppressAutoPush: false });

  const repo = {
    rootUri: vscodeStub.Uri.file(repoDir),
    async add() {},
    async addDot() {},
    async commit(message) {
      recordedCommits.push(message);
    },
    async push() {
      pushAttempts += 1;
    }
  };

  const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/workflows/forgeCommit.js');
  const { forgeCommitFromJournal } = await import(modulePath);

  const result = await forgeCommitFromJournal({
    repo,
    log: (message) => outputLogs.push(message),
    promptDecision: async () => 'abort'
  });
  assert.equal(result.status, 'commit-success');
  assert.equal(pushAttempts, 0);
  assert.equal(recordedCommits.length, 1);

  const fallbackMessage = recordedCommits[0];
  const messageLines = fallbackMessage.split('\n').map((line) => line.trim()).filter(Boolean);
  const subjectLine = messageLines[0];
  assert.match(subjectLine, /^chore\([^\)]+\): commit updated files \[offline mode\]$/);

  const listedFiles = messageLines.slice(1).map((line) => line.replace(/^-\s+/, ''));
  const expectedFiles = [...stagedFiles].sort((a, b) => a.localeCompare(b)).slice(0, 3);
  assert.equal(listedFiles.length, expectedFiles.length);
  const normalizeOrder = (arr) => [...arr].sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(normalizeOrder(listedFiles), normalizeOrder(expectedFiles));

  assert.ok(outputLogs.some((line) => line.includes('[OFFLINE ⚠️] Codex unavailable')));
  assert.ok(outputLogs.some((line) => line.includes('[OFFLINE ✅] Commit created with offline fallback message.')));

  await execFileAsync('git', ['reset', 'HEAD', '--', '.'], { cwd: repoDir });
  await execFileAsync('git', ['clean', '-fd'], { cwd: repoDir });
  await writeFile(journalPath, 'current:\n  - "chore: retry commit offline"\n', 'utf8');

  const retryFiles = ['lib/service.ts', 'docs/api.md'];
  for (const file of retryFiles) {
    const filePath = path.join(repoDir, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '// retry content\n', 'utf8');
  }
  await execFileAsync('git', ['add', 'lib/service.ts', 'docs/api.md'], { cwd: repoDir });

  pipelineOutcomes.push({
    status: 'commit-anyway',
    suppressAutoPush: true,
    commitAnnotation: '[pipeline failed at tests: see OUTPUT > CommitSmith]'
  });
  configStore.set('commit.pushAfter', true);

  const retryResult = await forgeCommitFromJournal({
    repo,
    log: (message) => outputLogs.push(message),
    promptDecision: async () => 'abort'
  });

  assert.equal(retryResult.status, 'commit-warning');
  assert.equal(recordedCommits.length, 2);
  assert.equal(pushAttempts, 0, 'Auto push should remain suppressed during commit-anyway fallback');

  const retryMessage = recordedCommits[1];
  assert.ok(
    retryMessage.includes('[pipeline failed at tests: see OUTPUT > CommitSmith]'),
    'Pipeline annotation missing from fallback commit'
  );

  console.info('Offline fallback tests passed');
} finally {
  Module._load = moduleLoad;
  await rm(repoDir, { recursive: true, force: true });
}
