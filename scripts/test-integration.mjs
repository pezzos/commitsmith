#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withVscodeMock } from "./test-utils/mock-vscode.js";

const tempDir = path.dirname(fileURLToPath(import.meta.url));
const registeredCommands = [];

const { restore, context, vscode } = withVscodeMock(
  (request) => {
    if (request.endsWith("./config")) {
      return {
        getConfig: () => ({
          formatCommand: "npm run format:fix",
          typecheckCommand: "npm run typecheck",
          testsCommand: "npm test -- -w",
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
        getRepo: async () => ({ rootUri: { fsPath: tempDir } }),
        commit: async () => {},
        push: async () => {},
      };
    }

    if (request.endsWith("./codex")) {
      const emitter = new vscode.EventEmitter();
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
          folder: tempDir,
        }),
      };
    }

    return undefined;
  },
  { tempDir, registeredCommands },
);

try {
  const extension = await import("../dist/extension.js");
  extension.activate(context);

  const expected = [
    "commitSmith.generateFromJournal",
    "commitSmith.clearJournal",
    "commitSmith.installHooks",
    "commitSmith.dryRun",
  ];

  for (const command of expected) {
    assert(
      registeredCommands.includes(command),
      `Command ${command} not registered`,
    );
  }

  console.info("Integration tests passed");
} finally {
  restore();
}
