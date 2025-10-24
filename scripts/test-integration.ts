#!/usr/bin/env node

import { strict as assert } from "node:assert";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
// @ts-expect-error Shim is authored in plain ESM and exports runtime helpers only.
import { withVscodeMock } from "./test-utils/mock-vscode.js";

const tempDir = mkdtempSync(
  path.join(os.tmpdir(), "commit-smith-int-"),
);
process.chdir(tempDir);

const registeredCommands: string[] = [];

const mock = withVscodeMock(
  (request: string) => {
    if (request.endsWith("./config")) {
      return {
        getConfig: () => ({
          formatCommand: "echo format",
          typecheckCommand: "echo typecheck",
          testsCommand: "echo tests",
          pipelineEnable: true,
          pipelineMaxAiFixAttempts: 0,
          pipelineAbortOnFailure: true,
          commitPushAfter: false,
          messageStyle: "conventional",
          messageEnforce72: true,
          jiraFromBranch: true,
          codexModel: "gpt-5-codex",
          codexBinaryPath: null,
          codexExtraArgs: [],
        }),
        initializeConfigWatcher: () => {},
        onDidChangeConfig: () => ({ dispose() {} }),
      };
    }

    if (request.endsWith("./journal")) {
      return {
        initializeJournal: async () => {},
        readJournal: async () => ({
          current: [
            { message: "feat: test", file: "src/example.ts" },
          ],
          meta: {},
        }),
        clearCurrent: async () => {},
      };
    }

    if (request.endsWith("./utils/git")) {
      return {
        getRepo: async () => ({
          rootUri: { fsPath: tempDir },
        }),
        commit: async () => {},
        push: async () => {},
      };
    }

    if (request.endsWith("./codex")) {
      const emitter = new mock.vscode.EventEmitter<unknown>();
      return {
        generateCommitMessage: async () => "test commit",
        onCodexOfflineFallback: emitter.event.bind(emitter),
      };
    }

    if (request.endsWith("./workflows/forgeCommit")) {
      return {
        forgeCommitFromJournal: async () => ({
          status: "commit-success",
          pushFailed: false,
        }),
      };
    }

    if (request.endsWith("./workflows/dryRun")) {
      return {
        performDryRun: async () => ({
          status: "completed",
          folder: path.join(tempDir, "artifacts"),
        }),
      };
    }

    return undefined;
  },
  { tempDir, registeredCommands },
);

async function main(): Promise<void> {
  try {
    // @ts-expect-error Compiled extension ships without .d.ts files.
    const extension = await import("../dist/extension.js");
    extension.activate(mock.context);

    const expected = [
      "commitSmith.generateFromJournal",
      "commitSmith.clearJournal",
      "commitSmith.installHooks",
      "commitSmith.dryRun",
    ];

    for (const command of expected) {
      assert.ok(
        registeredCommands.includes(command),
        `Command ${command} was not registered.`,
      );
    }

    console.info("Integration tests passed");
  } finally {
    mock.restore();
  }
}

void main();
