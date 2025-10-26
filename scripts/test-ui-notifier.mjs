#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import url from "node:url";
import { withVscodeMock } from "./test-utils/mock-vscode.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

const bridgeMessages = [];
const telemetryEvents = [];

const mock = withVscodeMock(undefined, {});
const { messages } = mock;

const { CommitSmithNotifier } = await import(
  path.join(distPath, "ui/panel/notifier.js")
);

const bridge = {
  postMessage(message) {
    bridgeMessages.push(message);
  },
};

const telemetry = {
  track(event, properties) {
    telemetryEvents.push({ event, properties });
  },
};

function resetMocks() {
  bridgeMessages.length = 0;
  telemetryEvents.length = 0;
  messages.warning.reset();
  messages.information.reset();
  messages.error.reset();
}

console.info("Running CommitSmith notifier unit tests...");

resetMocks();
const notifier = new CommitSmithNotifier(bridge, telemetry);
notifier.stepStarted("format");
assert.equal(notifier.statusItem.text, "CommitSmith: Running Format");
assert.equal(bridgeMessages.length, 1);
assert.equal(bridgeMessages[0].payload.step, "format");
assert.equal(bridgeMessages[0].payload.status, "running");
assert.deepEqual(telemetryEvents[0], {
  event: "step_started",
  properties: { step: "format" },
});

resetMocks();
notifier.showAlreadyRunning("format");
notifier.showAlreadyRunning("format");
const warningCalls = messages.warning.getCalls();
assert.equal(warningCalls.length, 1);
assert.equal(
  warningCalls[0].message,
  "Format already running—wait for it to finish.",
);
assert.equal(
  notifier.statusItem.text,
  "CommitSmith: Format already running",
);

resetMocks();
const telemetryNotifier = new CommitSmithNotifier(bridge, telemetry);
telemetryNotifier.telemetryEnabled = false;
telemetryNotifier.stepStarted("tests");
telemetryNotifier.stepFinished("tests", {
  step: "tests",
  status: "success",
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  blocking: false,
});
assert.equal(telemetryEvents.length, 0);

mock.restore();

console.info("CommitSmith notifier unit tests passed");
