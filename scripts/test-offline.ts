#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import Module from 'node:module';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = (file: string, args: string[], options: { cwd: string }) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        (error as Error & { stdout?: string; stderr?: string }).stdout = stdout;
        (error as Error & { stdout?: string; stderr?: string }).stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const outputLogs: string[] = [];
const recordedCommits: string[] = [];
let pushAttempts = 0;

class EventEmitter<T> {
  #listeners = new Set<(value: T) => void>();

  event = (listener: (value: T) => void) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value: T) {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }
}

const configStore = new Map<string, unknown>([
  ['pipeline.enable', true],
  ['pipeline.maxAiFixAttempts', 0],
  ['pipeline.abortOnFailure', true],
  ['commit.pushAfter', false]
]);

const vscodeStub = {
  EventEmitter,
  Uri: {
    file(fsPath: string) {
      return { fsPath };
    }
  },
  window: {
    createOutputChannel() {
      return { appendLine: (line: string) => outputLogs.push(line) };
    },
    showWarningMessage() {
      return Promise.resolve(undefined);
    },
    showInformationMessage() {
      return Promise.resolve(undefined);
    },
    showErrorMessage() {
      return Promise.resolve(undefined);
    }
  },
  workspace: {
    getConfiguration(namespace: string) {
      if (namespace !== 'commitSmith') {
        throw new Error(`Unexpected configuration namespace: ${namespace}`);
      }
      return {
        get<T>(key: string, fallback: T): T {
          return (configStore.get(key) as T) ?? fallback;
        }
      };
    },
    onDidChangeConfiguration() {
      return { dispose() {} };
    }
  }
};

const pipelineOutcomes: Array<{ status: 'completed' | 'commit-anyway'; suppressAutoPush: boolean; commitAnnotation?: string }> =
  [];

const moduleLoad = Module._load;
(Module._load as unknown as (request: string, parent: Module | null, isMain: boolean) => unknown) = function mockedLoad(
  request,
  parent,
  isMain
) {
  if (request === 'vscode') {
    return vscodeStub;
  }

  if (request.endsWith('/codex') || request.endsWith('/codex.ts') || request.endsWith('/codex.js')) {
    return {
      generateCommitMessage: async () => {
        throw new Error('Codex offline');
      }
    };
  }

  if (request.endsWith('/pipeline') || request.endsWith('/pipeline.ts') || request.endsWith('/pipeline.js')) {
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

try {
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'offline@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Offline Tester'], { cwd: repoDir });

  const journalPath = path.join(repoDir, '.ai-commit-journal.yml');
  await writeFile(journalPath, `current:\n  - feat: add offline fallback\n`, 'utf8');

  const stagedFiles = ['src/index.ts', 'src/util/helpers.ts', 'README.md', 'docs/overview.md'];
  for (const file of stagedFiles) {
    const fullPath = path.join(repoDir, file);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, '// test content\n', 'utf8');
  }

  await execFileAsync(
    'git',
    ['add', 'src/index.ts', 'src/util/helpers.ts', 'README.md', 'docs/overview.md'],
    { cwd: repoDir }
  );

  pipelineOutcomes.push({ status: 'completed', suppressAutoPush: false });

  const repo = {
    rootUri: vscodeStub.Uri.file(repoDir),
    async add() {},
    async addDot() {},
    async commit(message: string) {
      recordedCommits.push(message);
    },
    async push() {
      pushAttempts += 1;
    }
  };

  const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/workflows/forgeCommit');
  const { forgeCommitFromJournal } = await import(modulePath);

  const result = await forgeCommitFromJournal({
    repo,
    log: (message) => outputLogs.push(message),
    promptDecision: async () => 'abort'
  });

  assert.equal(result.status, 'commit-success');
  assert.equal(pushAttempts, 0);
  assert.ok(recordedCommits.length === 1, 'expected a single commit to be recorded');

  const [message] = recordedCommits;
  assert.ok(
    message.startsWith('chore(src): commit updated files [offline mode]'),
    `fallback commit subject mismatched: ${message}`
  );
  const lines = message.split('\n').map((line) => line.trim());
  assert.ok(lines.includes('- src/index.ts'), 'expected staged file listing in fallback body');
  assert.ok(lines.includes('- src/util/helpers.ts'), 'expected staged file listing in fallback body');
  assert.ok(lines.includes('- README.md'), 'expected staged file listing in fallback body');
  assert.ok(!lines.includes('- docs/overview.md'), 'fallback body should include at most three files');

  assert.ok(
    outputLogs.some((line) => line.includes('[OFFLINE ⚠️] Codex unavailable')),
    'expected offline warning log to be emitted'
  );
  assert.ok(
    outputLogs.some((line) => line.includes('[OFFLINE ✅] Commit created with offline fallback message.')),
    'expected offline success log'
  );

  // Prepare second run: commit-anyway outcome with annotation
  await execFileAsync('git', ['reset', 'HEAD', '--', '.'], { cwd: repoDir });
  await execFileAsync('git', ['clean', '-fd'], { cwd: repoDir });
  await writeFile(journalPath, `current:\n  - chore: retry commit offline\n`, 'utf8');

  const secondFiles = ['lib/service.ts', 'docs/api.md'];
  for (const file of secondFiles) {
    const fullPath = path.join(repoDir, file);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, '// offline test\n', 'utf8');
  }
  await execFileAsync('git', ['add', 'lib/service.ts', 'docs/api.md'], { cwd: repoDir });

  pipelineOutcomes.push({
    status: 'commit-anyway',
    suppressAutoPush: true,
    commitAnnotation: '[pipeline failed at tests: see OUTPUT > CommitSmith]'
  });

  const secondResult = await forgeCommitFromJournal({
    repo,
    log: (message) => outputLogs.push(message),
    promptDecision: async () => 'abort'
  });

  assert.equal(secondResult.status, 'commit-warning');
  assert.equal(recordedCommits.length, 2);
  const secondMessage = recordedCommits[1];
  assert.ok(
    secondMessage.includes('[pipeline failed at tests: see OUTPUT > CommitSmith]'),
    'expected pipeline annotation to be appended to fallback commit message'
  );

  console.info('Offline fallback tests passed');
} finally {
  Module._load = moduleLoad;
  await rm(repoDir, { recursive: true, force: true });
}
