#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import url from "node:url";
import { withVscodeMock } from "./test-utils/mock-vscode.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

const mock = withVscodeMock(undefined, {});

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
const { OfflineError } = await import(
  path.join(distPath, "shared/types.js")
);

console.info("Running Codex review controller tests...");

await runSuccessScenario();
await runOfflineFallbackScenario();
await verifyGatePreventsConcurrentRuns();

mock.restore();

console.info("Codex review controller tests passed");

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
    async askCodexReview() {
      return {
        success: true,
        text: "Document new API surface and expand regression coverage.",
        confidence: 0.74,
        ts: new Date().toISOString(),
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

async function runSuccessScenario() {
  const reviewText =
    "Codex spotlights missing tests and suggests tightening input validation.";
  const reviewTs = "2025-01-01T05:00:00.000Z";
  const { controller, notifier, stateStore, messages } =
    createHarness({
      orchestrator: {
        async askCodexReview() {
          return {
            success: true,
            text: reviewText,
            confidence: 0.82,
            ts: reviewTs,
          };
        },
      },
    });

  await controller.handleRunStep("codexReview");

  assert.equal(notifier.started.length, 1);
  assert.equal(notifier.finished.length, 1);

  const status = stateStore.state.stepStatus?.codexReview;
  assert(status);
  assert.equal(status.status, "success");
  assert.equal(status.message, "Review ready");
  assert.equal(status.blocking, false);

  const review = stateStore.state.codexReview;
  assert(review);
  assert.equal(review.source, "codex");
  assert.equal(review.text, reviewText);
  assert.ok(Math.abs(review.confidence - 0.82) < 1e-6);
  assert.equal(review.ts, reviewTs);

  const journal = stateStore.state.journalEntries;
  assert.equal(journal.length, 1);
  assert.equal(journal[0].source, "codex");
  assert.equal(journal[0].text, reviewText);
  assert.equal(journal[0].message, reviewText);
  assert.equal(journal[0].metadata?.confidence, 0.82);

  const reviewMessages = messages.filter(
    (msg) => msg.type === "REVIEW_RESULT",
  );
  assert.equal(reviewMessages.length, 1);
  assert.equal(reviewMessages[0].payload.text, reviewText);

  const journalMessages = messages.filter(
    (msg) => msg.type === "JOURNAL_UPDATE",
  );
  assert.equal(journalMessages.length, 1);
  assert.equal(journalMessages[0].payload.length, 1);

  controller.dispose();
}

async function runOfflineFallbackScenario() {
  const { controller, notifier, stateStore, messages } =
    createHarness({
      orchestrator: {
        async askCodexReview() {
          throw new OfflineError("Codex unavailable");
        },
      },
    });

  await controller.handleRunStep("codexReview");

  assert.equal(notifier.started.length, 1);
  assert.equal(notifier.finished.length, 1);
  assert.equal(notifier.errors.length, 0);

  const status = stateStore.state.stepStatus?.codexReview;
  assert(status);
  assert.equal(status.status, "success");
  assert.equal(status.message, "Using fallback guidance");
  assert.equal(stateStore.state.offline, true);

  const review = stateStore.state.codexReview;
  assert(review);
  assert.equal(review.source, "heuristic");
  assert.equal(review.confidence, null);
  assert.ok(review.text.includes("Codex is offline"));

  const journal = stateStore.state.journalEntries;
  assert.equal(journal.length, 0);

  const reviewMessages = messages.filter(
    (msg) => msg.type === "REVIEW_RESULT",
  );
  assert.equal(reviewMessages.length, 1);
  assert.equal(reviewMessages[0].payload.source, "heuristic");

  const journalMessages = messages.filter(
    (msg) => msg.type === "JOURNAL_UPDATE",
  );
  assert.equal(journalMessages.length, 0);

  controller.dispose();
}

async function verifyGatePreventsConcurrentRuns() {
  let release;
  const orchestrator = {
    askCodexReview() {
      return new Promise((resolve) => {
        release = () =>
          resolve({
            success: true,
            text: "Gate check",
            confidence: null,
            ts: new Date().toISOString(),
          });
      });
    },
  };

  const { controller, notifier } = createHarness({ orchestrator });

  const firstRun = controller.handleRunStep("codexReview");
  await nextTick();
  await controller.handleRunStep("codexReview");
  assert.equal(notifier.started.length, 1);

  if (!release) {
    throw new Error("Gate release handler not initialized");
  }
  release();
  await firstRun;

  assert.equal(notifier.finished.length, 1);
  controller.dispose();
}

function nextTick() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
