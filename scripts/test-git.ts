#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

interface StubLog {
  repo?: string;
  action: string;
  files?: unknown;
  message?: string;
  value?: string;
}

const stubLogs: StubLog[] = [];

const repo1 = createStubRepository('repo-1');
const repo2 = createStubRepository('repo-2');

let activeRepository: ReturnType<typeof createStubRepository> | undefined = repo2;
let repositories = [repo1, repo2];

const originalLoad = Module._load;
(Module._load as unknown as (request: string, parent: Module | null, isMain: boolean) => unknown) = function mockedLoad(
  request,
  parent,
  isMain
) {
  if (request === 'vscode') {
    return {
      extensions: {
        getExtension: () => ({
          isActive: true,
          exports: {
            getAPI: () => ({ repositories, activeRepository })
          },
          activate: async () => {}
        })
      },
      window: {
        createOutputChannel() {
          return { appendLine: (value: string) => stubLogs.push({ action: 'log', value }) };
        }
      },
      Uri: {
        file: (fsPath: string) => ({ fsPath })
      }
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

try {
  const gitModule = await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/utils/git'));

  const repo = await gitModule.getRepo();
  assert.equal(repo.rootUri.fsPath, '/fake/repo-2');

  await gitModule.stageModified(repo);
  await gitModule.stageModified(repo, ['fileA.ts']);
  await gitModule.commit(repo, 'feat: add stub');
  await gitModule.push(repo);

  const repo2Actions = stubLogs.filter((entry) => entry.repo === 'repo-2').map((entry) => entry.action);
  assert.deepEqual(repo2Actions, ['addDot', 'add', 'commit', 'push']);

  const stageAllCall = stubLogs.find((entry) => entry.repo === 'repo-2' && entry.action === 'addDot');
  assert.ok(stageAllCall, 'Expected stageModified to stage all files when no list provided');

  const selectiveAdd = stubLogs.find(
    (entry) => entry.repo === 'repo-2' && entry.action === 'add' && Array.isArray(entry.files) && entry.files.length === 1
  );
  assert.ok(selectiveAdd);
  const firstFile = (selectiveAdd?.files as Array<{ fsPath: string }>)[0];
  assert.equal(firstFile.fsPath, '/fake/repo-2/fileA.ts');

  activeRepository = undefined;
  repositories = [repo1];

  let noActiveError = false;
  try {
    await gitModule.getRepo();
  } catch (error) {
    noActiveError = true;
    assert.match((error as Error).message, /active Git repository/i);
  }
  assert.equal(noActiveError, true, 'Expected getRepo to fail when no active repository is selected');

  console.info('Git util tests passed');
} finally {
  Module._load = originalLoad;
}

function createStubRepository(name: string) {
  return {
    rootUri: { fsPath: `/fake/${name}` },
    add: async (files?: unknown) => {
      stubLogs.push({ repo: name, action: 'add', files });
    },
    addDot: async () => {
      stubLogs.push({ repo: name, action: 'addDot' });
    },
    commit: async (message: string) => {
      stubLogs.push({ repo: name, action: 'commit', message });
    },
    push: async () => {
      stubLogs.push({ repo: name, action: 'push' });
    }
  };
}
