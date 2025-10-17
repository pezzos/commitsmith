#!/usr/bin/env node

import Module from "node:module";

(async () => {
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return {
        EventEmitter: class {
          #listeners = new Set();
          event(listener) {
            this.#listeners.add(listener);
            return {
              dispose: () => this.#listeners.delete(listener),
            };
          }
          fire(value) {
            for (const listener of this.#listeners) {
              listener(value);
            }
          }
        },
        workspace: {
          getConfiguration: () => ({
            get: (_key, fallback) => fallback,
          }),
          onDidChangeConfiguration: () => ({ dispose() {} }),
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const pipeline = await import("../dist/pipeline.js");
    const exportsExist = ["runPipeline"].every(
      (key) => typeof pipeline[key] === "function",
    );
    if (!exportsExist) {
      throw new Error("Pipeline exports missing expected functions");
    }
    console.info("Pipeline smoke test passed");
  } finally {
    Module._load = originalLoad;
  }
})();
