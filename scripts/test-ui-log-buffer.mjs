#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import url from "node:url";
import { withVscodeMock } from "./test-utils/mock-vscode.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

const mock = withVscodeMock(undefined, {});
const events = [];
const bridge = {
  postMessage(message) {
    events.push(message);
  },
};

const { StepLogBuffer } = await import(
  path.join(distPath, "ui/panel/logBuffer.js")
);

console.info("Running log buffer unit tests...");

const buffer = new StepLogBuffer("format", bridge, {
  mask(value) {
    return value.replace(/secret/gi, "***");
  },
});
buffer.reset();
assert.equal(events.length, 1);
assert.equal(events[0].payload.reset, true);

for (let index = 0; index < 5; index += 1) {
  buffer.append(`line-${index} secret\n`);
}
buffer.close();
const combinedChunk = events
  .slice(1)
  .map((event) => event.payload.chunk)
  .join("");
assert.ok(combinedChunk.includes("line-0"));
assert.ok(!combinedChunk.includes("secret"));

const bigBuffer = new StepLogBuffer("format", bridge, {
  mask: (value) => value,
});
bigBuffer.reset();
const startIndex = events.length;
for (let index = 0; index < 600; index += 1) {
  bigBuffer.append(`row-${index}\n`);
}
bigBuffer.close();
const truncatedEvents = events.slice(startIndex).filter(
  (message) =>
    message.payload.truncated === true &&
    typeof message.payload.chunk === "string" &&
    message.payload.chunk.includes("… truncated"),
);
assert.ok(truncatedEvents.length >= 1);

mock.restore();

console.info("Log buffer unit tests passed");
