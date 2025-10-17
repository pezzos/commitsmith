#!/usr/bin/env node

import { strict as assert } from "node:assert";
import Module from "node:module";
import path from "node:path";
import url from "node:url";

const defaults = {
  format: "npm run format:fix",
  formatEnabled: true,
  typecheck: "npm run typecheck",
  typecheckEnabled: true,
  tests: "npm test -- -w",
  testsEnabled: true,
  pipelineEnable: true,
  pipelineMaxAttempts: 2,
  pipelineAbortOnFailure: true,
  commitPushAfter: false,
  messageStyle: "conventional",
  messageEnforce72: true,
  jiraFromBranch: true,
  codexModel: "gpt-5-codex",
  codexReasoningLevel: "low",
  codexBinaryPath: null,
  codexExtraArgs: [],
  codexTimeoutMs: 120_000,
  codexSerenaTimeoutMs: 180_000,
  codexMcpWhitelist: [],
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
      if (namespace !== "commitSmith") {
        throw new Error(
          `Unexpected configuration namespace: ${namespace}`,
        );
      }
      return {
        get(key, fallback) {
          return configurationStore.has(key)
            ? configurationStore.get(key)
            : fallback;
        },
      };
    },
    onDidChangeConfiguration() {
      return { dispose() {} };
    },
  },
};

const moduleOverride = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return moduleOverride.call(this, request, parent, isMain);
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");
try {
  const { getConfig } = await import(
    path.join(distPath, "config.js")
  );

  const configDefaults = getConfig();

  assert.equal(configDefaults.formatCommand, defaults.format);
  assert.equal(configDefaults.formatEnabled, defaults.formatEnabled);
  assert.equal(configDefaults.typecheckCommand, defaults.typecheck);
  assert.equal(
    configDefaults.typecheckEnabled,
    defaults.typecheckEnabled,
  );
  assert.equal(configDefaults.testsCommand, defaults.tests);
  assert.equal(configDefaults.testsEnabled, defaults.testsEnabled);
  assert.equal(
    configDefaults.pipelineEnable,
    defaults.pipelineEnable,
  );
  assert.equal(
    configDefaults.pipelineMaxAiFixAttempts,
    defaults.pipelineMaxAttempts,
  );
  assert.equal(
    configDefaults.pipelineAbortOnFailure,
    defaults.pipelineAbortOnFailure,
  );
  assert.equal(
    configDefaults.commitPushAfter,
    defaults.commitPushAfter,
  );
  assert.equal(configDefaults.messageStyle, defaults.messageStyle);
  assert.equal(
    configDefaults.messageEnforce72,
    defaults.messageEnforce72,
  );
  assert.equal(
    configDefaults.jiraFromBranch,
    defaults.jiraFromBranch,
  );
  assert.equal(configDefaults.codexModel, defaults.codexModel);
  assert.equal(
    configDefaults.codexReasoningLevel,
    defaults.codexReasoningLevel,
  );
  assert.equal(
    configDefaults.codexBinaryPath,
    defaults.codexBinaryPath,
  );
  assert.deepEqual(
    configDefaults.codexExtraArgs,
    defaults.codexExtraArgs,
  );
  assert.equal(
    configDefaults.codexTimeoutMs,
    defaults.codexTimeoutMs,
  );
  assert.equal(
    configDefaults.codexSerenaTimeoutMs,
    defaults.codexSerenaTimeoutMs,
  );
  assert.deepEqual(
    configDefaults.codexMcpWhitelist,
    defaults.codexMcpWhitelist,
  );

  configurationStore.set("message.style", "plain");
  configurationStore.set("pipeline.maxAiFixAttempts", 3);
  configurationStore.set("format.enabled", false);
  configurationStore.set("typecheck.enabled", false);
  configurationStore.set("tests.enabled", false);
  configurationStore.set("codex.extraArgs", "--profile stage");
  configurationStore.set("codex.model", "gpt-5");
  configurationStore.set("codex.reasoningLevel", "high");
  configurationStore.set("codex.timeoutMs", 150000);
  configurationStore.set("codex.serenaTimeoutMs", 200000);
  configurationStore.set("codex.mcpWhitelist", ["github", "serena"]);

  const configOverrides = getConfig();

  assert.equal(configOverrides.messageStyle, "plain");
  assert.equal(configOverrides.pipelineMaxAiFixAttempts, 3);
  assert.equal(configOverrides.formatEnabled, false);
  assert.equal(configOverrides.typecheckEnabled, false);
  assert.equal(configOverrides.testsEnabled, false);
  assert.deepEqual(configOverrides.codexExtraArgs, [
    "--profile",
    "stage",
  ]);
  assert.equal(configOverrides.codexModel, "gpt-5");
  assert.equal(configOverrides.codexReasoningLevel, "high");
  assert.equal(configOverrides.codexTimeoutMs, 150000);
  assert.equal(configOverrides.codexSerenaTimeoutMs, 200000);
  assert.deepEqual(configOverrides.codexMcpWhitelist, [
    "github",
    "serena",
  ]);

  configurationStore.set("pipeline.maxAiFixAttempts", -1);
  configurationStore.set("codex.extraArgs", "");
  configurationStore.set("codex.timeoutMs", 500);
  configurationStore.set("codex.serenaTimeoutMs", 0);
  configurationStore.set("codex.mcpWhitelist", [123, ""]);
  configurationStore.set("codex.model", "unsupported");
  configurationStore.set("codex.reasoningLevel", "extreme");

  const configInvalid = getConfig();

  assert.equal(
    configInvalid.pipelineMaxAiFixAttempts,
    defaults.pipelineMaxAttempts,
  );
  assert.deepEqual(
    configInvalid.codexExtraArgs,
    defaults.codexExtraArgs,
  );
  assert.equal(configInvalid.codexTimeoutMs, defaults.codexTimeoutMs);
  assert.equal(
    configInvalid.codexSerenaTimeoutMs,
    defaults.codexSerenaTimeoutMs,
  );
  assert.deepEqual(
    configInvalid.codexMcpWhitelist,
    defaults.codexMcpWhitelist,
  );
  assert.equal(configInvalid.codexModel, defaults.codexModel);
  assert.equal(
    configInvalid.codexReasoningLevel,
    defaults.codexReasoningLevel,
  );

  console.info("Config tests passed");
} finally {
  Module._load = moduleOverride;
}
