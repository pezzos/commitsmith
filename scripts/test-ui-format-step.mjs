#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import url from "node:url";
import { EventEmitter } from "node:events";
import { withVscodeMock } from "./test-utils/mock-vscode.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

const mock = withVscodeMock(undefined, {
  workspace: {
    getConfiguration: () => ({
      get(key, defaultValue) {
        if (key === "format.command") {
          return "fake-format";
        }
        if (key === "format.enabled") {
          return true;
        }
        if (key === "codex.timeoutMs") {
          return 60_000;
        }
        if (key === "codex.serenaTimeoutMs") {
          return 60_000;
        }
        return defaultValue;
      },
    }),
  },
});

class InMemoryMemento {
  constructor() {
    this.store = new Map();
  }
  get(key, defaultValue) {
    return this.store.has(key) ? this.store.get(key) : defaultValue;
  }
  async update(key, value) {
    if (typeof value === "undefined") {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }
}

const { CommitSmithStateStore } = await import(
  path.join(distPath, "ui/panel/stateStore.js")
);
const { StepController } = await import(
  path.join(distPath, "ui/panel/stepController.js")
);
const { StepExecutionGate } = await import(
  path.join(distPath, "ui/panel/executionGate.js")
);
const { UserError, TimeoutError } = await import(
  path.join(distPath, "shared/types.js")
);

console.info("Running format step controller tests...");

await runSuccessScenario();
await runFailureScenario();
await runTimeoutScenario();

mock.restore();
console.info("Format step controller tests passed");

function createNotifierStub() {
  return {
    started: [],
    finished: [],
    errors: [],
    stepStarted(step) {
      this.started.push(step);
    },
    stepFinished(_step, event) {
      this.finished.push(event);
    },
    showStepError(step, message) {
      this.errors.push({ step, message });
    },
    showAlreadyRunning() {},
    showLowConfidenceWarning() {},
    resetToIdle() {},
  };
}

function createHarness() {
  const messages = [];
  const bridge = {
    postMessage(message) {
      messages.push(message);
    },
    onDidReceiveMessage() {
      return { dispose() {} };
    },
  };
  const stateStore = new CommitSmithStateStore(new InMemoryMemento());
  const gate = new StepExecutionGate();
  const notifier = createNotifierStub();
  const controller = new StepController({
    stateStore,
    bridge,
    gate,
    repositorySelector: {
      active: {
        rootUri: { fsPath: process.cwd() },
      },
    },
    notifier,
  });
  return { controller, notifier, stateStore, messages };
}

async function runSuccessScenario() {
  const { controller, notifier, stateStore, messages } =
    createHarness();
  controller.executeCommand = async (...args) => {
    const buffer = args[3];
    buffer.append("formatted file\n");
    buffer.close();
  };
  await controller.handleRunStep("format");
  controller.dispose();

  assert.deepEqual(notifier.started, ["format"]);
  assert.equal(notifier.finished.length, 1);
  const status = stateStore.state.stepStatus?.format;
  assert(status);
  assert.equal(status.status, "success");
  assert.equal(status.blocking, false);
  assert.equal(status.tooltip, status.message);
  assert.deepEqual(status.summary, {
    kind: "success",
    errorCount: 0,
  });
  const log = messages
    .filter((msg) => msg.type === "APPEND_LOG")
    .map((msg) => msg.payload.chunk)
    .join("");
  assert.ok(log.includes("formatted"));
}

async function runFailureScenario() {
  const { controller, notifier, stateStore } = createHarness();
  controller.executeCommand = async () => {
    throw new UserError("Formatter exited with code 2");
  };
  await controller.handleRunStep("format");
  controller.dispose();

  assert.equal(notifier.errors.length, 1);
  assert.ok(/code 2/.test(notifier.errors[0].message));
  const status = stateStore.state.stepStatus?.format;
  assert(status);
  assert.equal(status.status, "error");
  assert.equal(status.blocking, true);
}

async function runTimeoutScenario() {
  const { controller, notifier, stateStore } = createHarness();
  controller.executeCommand = async () => {
    throw new TimeoutError("Format timed out after 60s", 60_000);
  };
  await controller.handleRunStep("format");
  controller.dispose();

  assert.equal(notifier.errors.length, 1);
  const timeoutMessage = notifier.errors[0].message;
  assert.ok(/timed out/.test(timeoutMessage), timeoutMessage);
  const status = stateStore.state.stepStatus?.format;
  assert(status);
  assert.equal(status.status, "error");
  assert.equal(status.blocking, true);
}
