#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const tempDir = path.dirname(fileURLToPath(import.meta.url));
const registeredCommands = [];

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

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      EventEmitter,
      commands: {
        registerCommand: (id) => {
          registeredCommands.push(id);
          return { dispose() {} };
        }
      },
      window: {
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined
      },
      extensions: {
        getExtension: () => ({
          isActive: true,
          exports: {
            getAPI: () => ({
              repositories: [
                {
                  rootUri: { fsPath: tempDir },
                  add: async () => {},
                  addDot: async () => {},
                  commit: async () => {},
                  push: async () => {}
                }
              ]
            })
          },
          activate: async () => {}
        })
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: tempDir } }],
        getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue }),
        onDidChangeConfiguration: () => ({ dispose() {} })
      }
    };
  }

  if (request.endsWith('./config')) {
    return {
      getConfig: () => ({
        formatCommand: 'npm run format:fix',
        typecheckCommand: 'npm run typecheck',
        testsCommand: 'npm test -- -w',
        pipelineEnable: true,
        pipelineMaxAiFixAttempts: 0,
        pipelineAbortOnFailure: true,
        commitPushAfter: false,
        messageStyle: 'conventional',
        messageEnforce72: true,
        jiraFromBranch: true,
        codexModel: 'gpt-5-codex',
        codexEndpoint: 'http://localhost:9999',
        codexTimeoutMs: 10000
      }),
      initializeConfigWatcher: () => {},
      onDidChangeConfig: () => ({ dispose() {} })
    };
  }

  if (request.endsWith('./journal')) {
    return {
      initializeJournal: async () => {},
      readJournal: async () => ({ current: ['feat: test'], meta: {} }),
      clearCurrent: async () => {}
    };
  }

  if (request.endsWith('./utils/git')) {
    return {
      getRepo: async () => ({ rootUri: { fsPath: tempDir } }),
      commit: async () => {},
      push: async () => {}
    };
  }

  if (request.endsWith('./codex')) {
    const emitter = new EventEmitter();
    return {
      generateCommitMessage: async () => 'test commit',
      onCodexOfflineFallback: emitter.event.bind(emitter)
    };
  }

  if (request.endsWith('./workflows/forgeCommit')) {
    return {
      forgeCommitFromJournal: async () => ({ status: 'commit-success', pushFailed: false })
    };
  }

  if (request.endsWith('./workflows/dryRun')) {
    return {
      performDryRun: async () => ({ status: 'completed', folder: tempDir })
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = await import('../dist/extension.js');
  extension.activate({ subscriptions: [] });

  const expected = [
    'commitSmith.generateFromJournal',
    'commitSmith.clearJournal',
    'commitSmith.installHooks',
    'commitSmith.dryRun'
  ];

  for (const command of expected) {
    assert(registeredCommands.includes(command), `Command ${command} not registered`);
  }

  console.info('Integration tests passed');
} finally {
  Module._load = originalLoad;
}
