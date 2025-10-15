#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import Module from 'node:module';

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'commit-smith-int-'));
process.chdir(tempDir);

const registeredCommands: string[] = [];

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

const moduleLoad = Module._load;
(Module._load as unknown as (request: string, parent: Module | null, isMain: boolean) => unknown) = function override(
  request,
  parent,
  isMain
) {
  if (request === 'vscode') {
    return {
      EventEmitter,
      commands: {
        registerCommand: (id: string, _cb: (...args: unknown[]) => unknown) => {
          registeredCommands.push(id);
          return { dispose() {} };
        }
      },
      window: {
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        showInformationMessage: () => Promise.resolve(undefined),
        showWarningMessage: () => Promise.resolve(undefined)
      },
      extensions: {
        getExtension: () => ({
          isActive: true,
          exports: {
            getAPI: () => ({ repositories: [{ rootUri: { fsPath: tempDir }, add: async () => {}, addDot: async () => {}, commit: async () => {}, push: async () => {} }] })
          },
          activate: async () => {}
        })
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: tempDir } }],
        getConfiguration: () => ({
          get: (_key: string, defaultValue: unknown) => defaultValue
        }),
        onDidChangeConfiguration: () => ({ dispose() {} })
      }
    };
  }

  if (request.endsWith('./config')) {
    return {
      getConfig: () => ({
        formatCommand: 'echo format',
        typecheckCommand: 'echo typecheck',
        testsCommand: 'echo tests',
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
      getRepo: async () => ({
        rootUri: { fsPath: tempDir }
      }),
      commit: async () => {},
      push: async () => {}
    };
  }

  if (request.endsWith('./codex')) {
    const emitter = new EventEmitter<unknown>();
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

  return moduleLoad.call(this, request, parent, isMain);
};

try {
  const extension = await import('../dist/extension.js');
  const context = { subscriptions: [] as { dispose(): void }[] } as any;
  extension.activate(context);

  const expected = [
    'commitSmith.generateFromJournal',
    'commitSmith.clearJournal',
    'commitSmith.installHooks',
    'commitSmith.dryRun'
  ];

  for (const command of expected) {
    assert.ok(registeredCommands.includes(command), `Command ${command} was not registered.`);
  }

  console.info('Integration tests passed');
} finally {
  Module._load = moduleLoad;
}
