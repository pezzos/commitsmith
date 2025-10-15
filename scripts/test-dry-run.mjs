#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const execFileAsync = (file, args, options) =>
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

const outputLines = [];
const configurationStore = new Map([
  ['format.command', 'npm run format:fix'],
  ['typecheck.command', "node -e \"console.log('typecheck ok')\""],
  ['tests.command', "node -e \"console.log('tests ok')\""]
]);

class EventEmitter {
  #listeners = new Set();

  event = (listener) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value) {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }
}

const vscodeStub = {
  EventEmitter,
  Uri: {
    file(fsPath) {
      return { fsPath };
    }
  },
  workspace: {
    getConfiguration(namespace) {
      if (namespace !== 'commitSmith') {
        throw new Error(`Unexpected configuration namespace: ${namespace}`);
      }
      return {
        get(key, fallback) {
          return configurationStore.has(key) ? configurationStore.get(key) : fallback;
        }
      };
    },
    onDidChangeConfiguration() {
      return { dispose() {} };
    }
  },
  window: {
    createOutputChannel() {
      return {
        appendLine(value) {
          outputLines.push(value);
        }
      };
    }
  }
};

const noopDisposable = { dispose() {} };
const codexStub = {
  async generateCommitMessage() {
    return 'stub commit message';
  },
  async generateFix() {
    return {
      kind: 'unified-diff',
      diff: ['--- a/file.txt', '+++ b/file.txt', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    };
  },
  onCodexOfflineFallback: () => noopDisposable
};

const moduleOverride = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  if (request.endsWith(`${path.sep}codex.js`) || request.endsWith(`${path.sep}codex`)) {
    return codexStub;
  }
  return moduleOverride.call(this, request, parent, isMain);
};

const repoDir = await mkdtemp(path.join(os.tmpdir(), 'commit-smith-dry-run-'));
const git = (args) => execFileAsync('git', args, { cwd: repoDir });

try {
  await git(['init']);
  await git(['config', 'user.email', 'dryrun@example.com']);
  await git(['config', 'user.name', 'CommitSmith DryRun']);

  const packageJson = {
    name: 'commit-smith-dry-run-fixture',
    version: '1.0.0',
    scripts: {
      'format:fix': "node -e \"console.log('format fix executed')\""
    }
  };

  await writeFile(path.join(repoDir, 'package.json'), JSON.stringify(packageJson, null, 2));
  await writeFile(path.join(repoDir, '.gitignore'), '.commit-smith/\n');
  const journalPath = path.join(repoDir, '.ai-commit-journal.yml');
  const journalContent = ['current:', '  - feat: verify dry-run workflow', 'meta:', '  scope: dry-run-test'].join('\n');
  await writeFile(journalPath, `${journalContent}\n`);

  await git(['add', '.']);
  await git(['commit', '-m', 'chore: initialise dry-run fixture']);

  const beforeJournal = await readFile(journalPath, 'utf8');

  const repo = {
    rootUri: vscodeStub.Uri.file(repoDir),
    async add() {},
    async addDot() {},
    async commit() {},
    async push() {}
  };

  const modulePath = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../dist/workflows/dryRun.js');
  const { performDryRun } = await import(modulePath);

  assert.equal(typeof performDryRun, 'function', 'performDryRun export not found');

  const logLines = [];
  const result = await performDryRun({
    repo,
    log: (message) => logLines.push(message),
    promptDecision: async () => 'abort'
  });

  assert.equal(result.status, 'completed', `Expected completed status, received ${result.status}`);
  assert.ok(result.folder, 'Expected result.folder to be provided for completed dry run');

  const afterJournal = await readFile(journalPath, 'utf8');
  assert.equal(afterJournal, beforeJournal, 'Dry run should not mutate the journal');

  const status = await git(['status', '--porcelain']);
  assert.equal(status.stdout.trim(), '', 'Dry run must not leave git workspace dirty');

  const folderStats = await stat(result.folder);
  assert.ok(folderStats.isDirectory(), 'Dry run should emit artefacts directory');

  const artefacts = await readdir(result.folder);
  assert.ok(artefacts.includes('COMMIT_MESSAGE.md'), 'Expected COMMIT_MESSAGE.md artefact');
  assert.ok(artefacts.includes('summary.json'), 'Expected summary.json artefact');

  const commitMessage = await readFile(path.join(result.folder, 'COMMIT_MESSAGE.md'), 'utf8');
  assert.equal(commitMessage.trim(), 'stub commit message', 'Dry run should store generated commit message');

  const summary = JSON.parse(await readFile(path.join(result.folder, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'completed', 'summary.json should reflect completed status');

  const formatSkipLog = outputLines.find((line) => line.includes('[FORMAT ⏭️]'));
  assert.ok(formatSkipLog?.includes('No non-mutating variant found for "npm run format:fix".'), 'Skip reason should be logged');

  const dryRunLog = logLines.find((line) => line.startsWith('[DRY-RUN 📦]'));
  assert.ok(dryRunLog, 'Dry run should announce artefact location');

  console.info('Dry-run workflow integration test passed');
} finally {
  Module._load = moduleOverride;
  await rm(repoDir, { recursive: true, force: true });
}
