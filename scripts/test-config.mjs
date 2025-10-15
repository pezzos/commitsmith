#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import Module from 'node:module';
import path from 'node:path';
import url from 'node:url';

const defaults = {
  format: 'npm run format:fix',
  typecheck: 'npm run typecheck',
  tests: 'npm test -- -w',
  pipelineEnable: true,
  pipelineMaxAttempts: 2,
  pipelineAbortOnFailure: true,
  commitPushAfter: false,
  messageStyle: 'conventional',
  messageEnforce72: true,
  jiraFromBranch: true,
  codexModel: 'gpt-5-codex',
  codexEndpoint: 'http://localhost:9999',
  codexTimeoutMs: 10000
};

const configurationStore = new Map();

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
  }
};

const moduleOverride = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return moduleOverride.call(this, request, parent, isMain);
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../dist');
try {
  const { getConfig } = await import(path.join(distPath, 'config.js'));

  const configDefaults = getConfig();

  assert.equal(configDefaults.formatCommand, defaults.format);
  assert.equal(configDefaults.typecheckCommand, defaults.typecheck);
  assert.equal(configDefaults.testsCommand, defaults.tests);
  assert.equal(configDefaults.pipelineEnable, defaults.pipelineEnable);
  assert.equal(configDefaults.pipelineMaxAiFixAttempts, defaults.pipelineMaxAttempts);
  assert.equal(configDefaults.pipelineAbortOnFailure, defaults.pipelineAbortOnFailure);
  assert.equal(configDefaults.commitPushAfter, defaults.commitPushAfter);
  assert.equal(configDefaults.messageStyle, defaults.messageStyle);
  assert.equal(configDefaults.messageEnforce72, defaults.messageEnforce72);
  assert.equal(configDefaults.jiraFromBranch, defaults.jiraFromBranch);
  assert.equal(configDefaults.codexModel, defaults.codexModel);
  assert.equal(configDefaults.codexEndpoint, defaults.codexEndpoint);
  assert.equal(configDefaults.codexTimeoutMs, defaults.codexTimeoutMs);

  configurationStore.set('message.style', 'plain');
  configurationStore.set('pipeline.maxAiFixAttempts', 3);
  configurationStore.set('codex.timeoutMs', 5000);

  const configOverrides = getConfig();

  assert.equal(configOverrides.messageStyle, 'plain');
  assert.equal(configOverrides.pipelineMaxAiFixAttempts, 3);
  assert.equal(configOverrides.codexTimeoutMs, 5000);

  configurationStore.set('pipeline.maxAiFixAttempts', -1);
  configurationStore.set('codex.timeoutMs', 0);

  const configInvalid = getConfig();

  assert.equal(configInvalid.pipelineMaxAiFixAttempts, defaults.pipelineMaxAttempts);
  assert.equal(configInvalid.codexTimeoutMs, defaults.codexTimeoutMs);

  console.info('Config tests passed');
} finally {
  Module._load = moduleOverride;
}
