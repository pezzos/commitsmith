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
        if (key === "typecheck.command") {
          return "fake-typecheck";
        }
        if (key === "typecheck.enabled") {
          return true;
        }
        if (key === "codex.timeoutMs") {
          return 600_000;
        }
        if (key === "codex.serenaTimeoutMs") {
          return 600_000;
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

console.info("Running typecheck step controller tests...");

await runTimeoutScenario();
await runPaginationScenario();
await verifyCancelButtonMarkup();

mock.restore();
console.info("Typecheck step controller tests passed");

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
    async runTypecheck(onLog) {
      onLog("default log\n");
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

async function runTimeoutScenario() {
  const { controller, stateStore, notifier } = createHarness({
    orchestrator: {
      async runTypecheck() {
        throw new TimeoutError(
          "Typecheck timed out after 600s",
          600_000,
        );
      },
    },
  });
  await controller.handleRunStep("typecheck");
  controller.dispose();

  assert.equal(notifier.errors.length, 1);
  const status = stateStore.state.stepStatus?.typecheck;
  assert(status);
  assert.equal(status.status, "error");
  assert.equal(status.message, "Exceeded 600s timeout—rerun");
  assert.equal(status.tooltip, "Exceeded 600s timeout—rerun");
}

async function runPaginationScenario() {
  const { controller, messages } = createHarness({
    orchestrator: {
      async runTypecheck(onLog) {
        for (let index = 0; index < 120; index += 1) {
          onLog(`line-${index}\n`);
        }
        const startedAt = new Date().toISOString();
        const finishedAt = new Date().toISOString();
        return {
          success: true,
          blocking: false,
          startedAt,
          finishedAt,
          stepSummary: {
            kind: "success",
            errorCount: 0,
            warningCount: 0,
          },
        };
      },
    },
  });
  await controller.handleRunStep("typecheck");

  const historyPage = controller
    .getLogBuffer("typecheck")
    .getHistory(undefined, 50);
  assert.ok(Array.isArray(historyPage.entries));

  const initialLength = messages.length;
  controller.handleLogHistoryRequest("typecheck", undefined);
  const historyMessages = messages
    .slice(initialLength)
    .filter((message) => message.type === "LOG_HISTORY");

  assert.ok(historyMessages.length >= 1);
  const latest = historyMessages[historyMessages.length - 1];
  assert(latest.payload.entries.length <= 50);
  const hashes = new Set(
    latest.payload.entries.map((entry) => entry.hash),
  );
  assert.equal(
    hashes.size,
    latest.payload.entries.length,
    "Log history entries must be unique by hash",
  );

  controller.dispose();
}

async function verifyCancelButtonMarkup() {
  const file = await fs.readFile(
    path.resolve(__dirname, "../src/ui/panel/viewProvider.ts"),
    "utf8",
  );
  assert.ok(
    /data-role="cancel-step"[\s\S]*title="\${section\.cancelTooltip \?\? \"Cancel not supported\"}"/.test(
      file,
    ),
    "Typecheck cancel button should be disabled with tooltip",
  );
  assert.ok(
    /data-role="load-more-logs"/.test(file),
    "Typecheck step should render load more logs control",
  );
}
