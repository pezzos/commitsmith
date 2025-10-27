#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import url from "node:url";
import { withVscodeMock } from "./test-utils/mock-vscode.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

const mock = withVscodeMock(undefined, {
  workspace: {
    getConfiguration: () => ({
      get(key, defaultValue) {
        if (key === "lint.command") {
          return "fake-lint";
        }
        if (key === "lint.enabled") {
          return true;
        }
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
const { InfraError, UserError } = await import(
  path.join(distPath, "shared/types.js")
);

console.info("Running lint step controller tests...");

await runSuccessScenario();
await runUserErrorScenario();
await runInfraErrorScenario();
await runTruncationScenario();

mock.restore();
console.info("Lint step controller tests passed");

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
  return { controller, notifier, stateStore, messages, gate };
}

async function runSuccessScenario() {
  const { controller, notifier, stateStore } = createHarness();
  controller.executeCommand = async (...args) => {
    const buffer = args[3];
    buffer.append("lint clean\n");
    buffer.close();
  };
  await controller.handleRunStep("lint");
  controller.dispose();

  assert.deepEqual(notifier.started, ["lint"]);
  assert.equal(notifier.finished.length, 1);
  const status = stateStore.state.stepStatus?.lint;
  assert(status);
  assert.equal(status.status, "success");
  assert.equal(status.blocking, false);
  assert.deepEqual(status.summary, {
    kind: "success",
    errorCount: 0,
  });
}

async function runUserErrorScenario() {
  const { controller, notifier, stateStore } = createHarness();
  controller.executeCommand = async () => {
    throw new UserError("Lint exited with code 1");
  };
  await controller.handleRunStep("lint");
  controller.dispose();

  assert.equal(notifier.errors.length, 1);
  const status = stateStore.state.stepStatus?.lint;
  assert(status);
  assert.equal(status.status, "error");
  assert.equal(status.blocking, true);
  assert.equal(
    status.message,
    "Fix issues in your code (1 blocking issue)",
  );
  assert.equal(status.tooltip, "Fix issues in your code");
  assert.deepEqual(status.summary, { kind: "error", errorCount: 1 });
}

async function runInfraErrorScenario() {
  const { controller, notifier, stateStore } = createHarness();
  controller.executeCommand = async () => {
    throw new InfraError("Missing binary");
  };
  await controller.handleRunStep("lint");
  controller.dispose();

  assert.equal(notifier.errors.length, 1);
  const status = stateStore.state.stepStatus?.lint;
  assert(status);
  assert.equal(status.status, "error");
  assert.equal(status.blocking, true);
  assert.equal(status.message, "Missing dependency or tool");
  assert.equal(status.tooltip, "Missing dependency or tool");
  assert.deepEqual(status.summary, { kind: "error" });
}

async function runTruncationScenario() {
  const { controller, messages } = createHarness();
  controller.executeCommand = async (...args) => {
    const buffer = args[3];
    for (let index = 0; index < 600; index += 1) {
      buffer.append(`row-${index}\n`);
    }
    buffer.close();
  };
  await controller.handleRunStep("lint");
  controller.dispose();

  const truncatedEvents = messages.filter(
    (message) =>
      message.type === "APPEND_LOG" &&
      message.payload?.step === "lint" &&
      message.payload?.truncated === true &&
      typeof message.payload?.chunk === "string" &&
      message.payload.chunk.includes("… truncated"),
  );
  assert.ok(truncatedEvents.length >= 1);
}
