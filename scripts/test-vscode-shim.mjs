#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import { createVscodeMock } from "./test-utils/mock-vscode.js";

const registeredCommands = [];
const tempDir = path.resolve("tmp/vscode-shim-test");
const { vscode, context } = createVscodeMock({
  tempDir,
  registeredCommands,
});

const statusLeft = vscode.StatusBarAlignment.Left;
const statusRight = vscode.StatusBarAlignment.Right;
assert.equal(typeof statusLeft, "number");
assert.equal(typeof statusRight, "number");
assert.notEqual(statusLeft, statusRight);

const statusBarItem = vscode.window.createStatusBarItem();
statusBarItem.text = "Hello";
statusBarItem.tooltip = "World";
statusBarItem.show();
statusBarItem.hide();
statusBarItem.dispose();

const statusDisposable = vscode.window.setStatusBarMessage("test");
assert.equal(typeof statusDisposable.dispose, "function");
statusDisposable.dispose();

const terminalDisposable = vscode.window.onDidCloseTerminal(() => {});
assert.equal(typeof terminalDisposable.dispose, "function");
terminalDisposable.dispose();

const config = vscode.workspace.getConfiguration();
assert.equal(config.get("unknown.setting", "fallback"), "fallback");

for (const hook of [
  "onDidSaveTextDocument",
  "onDidChangeTextDocument",
  "onDidChangeWorkspaceFolders",
]) {
  const disposable = vscode.workspace[hook](() => {});
  assert.equal(typeof disposable.dispose, "function");
  disposable.dispose();
}

const commandDisposable = vscode.commands.registerCommand(
  "commitSmith.test",
  () => {},
);
assert.deepEqual(registeredCommands, ["commitSmith.test"]);
commandDisposable.dispose();

assert.equal(context.subscriptions.length, 0);
context.subscriptions.push({ dispose() {} });
assert.equal(context.subscriptions.length, 1);

await context.workspaceState.update("lane", "fast");
assert.equal(context.workspaceState.get("lane", "guarded"), "fast");
await context.globalState.update("pref", true);
assert.equal(context.globalState.get("pref", false), true);

console.info("VS Code shim tests passed");
