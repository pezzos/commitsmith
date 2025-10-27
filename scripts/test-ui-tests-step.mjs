#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import url from "node:url";
import { promises as fs } from "node:fs";
import { withVscodeMock } from "./test-utils/mock-vscode.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

const mock = withVscodeMock(undefined, {
  workspace: {
    getConfiguration: () => ({
      get(key, defaultValue) {
        if (key === "tests.command") {
          return "fake-tests";
        }
        if (key === "tests.enabled") {
          return true;
        }
        if (key === "codex.timeoutMs") {
          return 900_000;
        }
        if (key === "codex.serenaTimeoutMs") {
          return 900_000;
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
const { TimeoutError } = await import(
  path.join(distPath, "shared/types.js")
);

console.info("Running tests step controller tests...");

await runSummaryScenario();
await runTimeoutScenario();
await verifyRerunControlsMarkup();

mock.restore();
console.info("Tests step controller tests passed");

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

function createHarness(options = {}) {
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
  const orchestrator = options.orchestrator ?? {
    async runTests(onLog) {
      onLog("running suites…\n");
      onLog("Tests: 3 passed, 3 total\n");
      const now = new Date().toISOString();
      return {
        success: true,
        blocking: false,
        startedAt: now,
        finishedAt: now,
        stepSummary: {
          kind: "success",
          errorCount: 0,
          warningCount: 0,
        },
        summary: {
          total: 3,
          passed: 3,
          failed: 0,
          durationMs: 1_234,
        },
      };
    },
  };
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
    orchestrator,
  });
  return { controller, notifier, stateStore, messages, gate };
}

async function runSummaryScenario() {
  const { controller, notifier, stateStore, messages } =
    createHarness();
  await controller.handleRunStep("tests");
  controller.dispose();

  assert.deepEqual(notifier.started, ["tests"]);
  assert.equal(notifier.finished.length, 1);
  const status = stateStore.state.stepStatus?.tests;
  assert(status);
  assert.equal(status.status, "success");
  assert.equal(status.blocking, false);
  assert(status.testSummary);
  assert.equal(status.testSummary.total, 3);
  assert.equal(status.testSummary.passed, 3);
  assert.equal(status.testSummary.failed, 0);
  const log = messages
    .filter((msg) => msg.type === "APPEND_LOG")
    .map((msg) => msg.payload.chunk)
    .join("");
  assert(
    /\nTest summary: { total: 3, passed: 3, failed: 0, durationMs: 1234 }\n/.test(
      log,
    ),
    "Test summary should be appended to log output",
  );
  const statusEvents = messages.filter(
    (msg) => msg.type === "STEP_STATUS",
  );
  assert.ok(statusEvents.length >= 2);
  const completed = statusEvents.find(
    (event) => event.payload?.status === "success",
  );
  assert(completed?.payload.testSummary);
}

async function runTimeoutScenario() {
  const { controller, notifier, stateStore } = createHarness({
    orchestrator: {
      async runTests() {
        throw new TimeoutError("Tests timed out after 900s", 900_000);
      },
    },
  });
  await controller.handleRunStep("tests");
  controller.dispose();

  assert.equal(notifier.errors.length, 1);
  const status = stateStore.state.stepStatus?.tests;
  assert(status);
  assert.equal(status.status, "error");
  assert.equal(status.blocking, true);
  assert.ok(
    /timeout/i.test(status.message ?? ""),
    "Timeout message should surface in status event",
  );
  assert.equal(status.testSummary, undefined);
}

async function verifyRerunControlsMarkup() {
  const panelJs = await fs.readFile(
    path.resolve(__dirname, "../media/panel.js"),
    "utf8",
  );
  assert.ok(
    /role === "rerun-failed"/.test(panelJs),
    "Rerun failed button should remain disabled in panel script",
  );
  const viewProviderSource = await fs.readFile(
    path.resolve(__dirname, "../src/ui/panel/viewProvider.ts"),
    "utf8",
  );
  assert.ok(
    /data-role="rerun-failed"[\s\S]*title="Runs only failed targets \(coming soon\)"/.test(
      viewProviderSource,
    ),
    "Rerun failed button should keep placeholder tooltip",
  );
}
