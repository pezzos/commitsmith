#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import { createVscodeMock } from "./test-utils/mock-vscode.js";

const registeredCommands = [];
const tempDir = path.resolve("tmp/vscode-shim-test");
const { vscode, context, quickPick, messages, terminals, progress } =
  createVscodeMock({
    tempDir,
    registeredCommands,
  });

const statusLeft = vscode.StatusBarAlignment.Left;
const statusRight = vscode.StatusBarAlignment.Right;
assert.equal(typeof statusLeft, "number");
assert.equal(typeof statusRight, "number");
assert.notEqual(statusLeft, statusRight);

const uri = vscode.Uri.file("/tmp/example");
assert.deepEqual(uri, { fsPath: "/tmp/example" });

assert.equal(
  vscode.QuickPickItemKind.Separator,
  -1,
  "QuickPickItemKind.Separator should be defined",
);

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

assert.equal(typeof vscode.window.showQuickPick, "function");

const quickPickItems = [
  { label: "First pick", value: 1 },
  { label: "Second pick", value: 2 },
];

const singleSelectCalls = [];
const singleSelection = await vscode.window.showQuickPick(
  quickPickItems,
  {
    onDidSelectItem: (item) => {
      singleSelectCalls.push(item);
    },
  },
);
assert.deepEqual(singleSelection, quickPickItems[0]);
assert.deepEqual(singleSelectCalls, [quickPickItems[0]]);

quickPick.setNextResult(quickPickItems[1]);
const overrideSelection =
  await vscode.window.showQuickPick(quickPickItems);
assert.deepEqual(overrideSelection, quickPickItems[1]);

const multiSelectCalls = [];
const multiSelection = await vscode.window.showQuickPick(
  quickPickItems,
  {
    canPickMany: true,
    onDidSelectItem: (item) => {
      multiSelectCalls.push(item);
    },
  },
);
assert.deepEqual(multiSelection, quickPickItems);
assert.deepEqual(multiSelectCalls, quickPickItems);

quickPick.cancelNext();
const cancelledSelection =
  await vscode.window.showQuickPick(quickPickItems);
assert.equal(cancelledSelection, undefined);

quickPick.setNextResult(() => [quickPickItems[1]]);
const multiOverride = await vscode.window.showQuickPick(
  quickPickItems,
  {
    canPickMany: true,
  },
);
assert.deepEqual(multiOverride, [quickPickItems[1]]);

quickPick.reset();
const undefinedItemsSelection =
  await vscode.window.showQuickPick(undefined);
assert.equal(undefinedItemsSelection, undefined);

const warningPromise = vscode.window.showWarningMessage("Beware!");
assert.equal(typeof warningPromise.then, "function");
assert.equal(await warningPromise, undefined);

const infoItems = [
  { title: "Primary", id: "primary" },
  { title: "Secondary", id: "secondary" },
];
const infoSelection = await vscode.window.showInformationMessage(
  "Choose lane action",
  ...infoItems,
);
assert.deepEqual(infoSelection, infoItems[0]);

messages.information.setNextResult(infoItems[1]);
const queuedInfoSelection =
  await vscode.window.showInformationMessage(
    "Queued choice",
    ...infoItems,
  );
assert.deepEqual(queuedInfoSelection, infoItems[1]);

const warningSelection = await vscode.window.showWarningMessage(
  "Danger ahead?",
  { modal: true },
  "Abort",
  "Retry",
);
assert.equal(warningSelection, "Abort");
const warningCalls = messages.warning.getCalls();
assert.ok(Array.isArray(warningCalls));
const lastWarningCall = warningCalls[warningCalls.length - 1];
assert.equal(lastWarningCall.message, "Danger ahead?");
assert.equal(lastWarningCall.options.modal, true);
assert.deepEqual(lastWarningCall.items, ["Abort", "Retry"]);

messages.warning.setNextResult("Retry");
const queuedWarningSelection = await vscode.window.showWarningMessage(
  "Danger ahead?",
  { modal: true },
  "Abort",
  "Retry",
);
assert.equal(queuedWarningSelection, "Retry");

messages.error.setNextResult(undefined);
const errorSelection = await vscode.window.showErrorMessage(
  "Something broke",
  { modal: true },
  "Dismiss",
);
assert.equal(errorSelection, undefined);
const errorCalls = messages.error.getCalls();
assert.equal(errorCalls[errorCalls.length - 1].options.modal, true);
messages.error.reset();

const mockCommandId = "commitSmith.mockCommand";
const mockCommandDisposable = vscode.commands.registerCommand(
  mockCommandId,
  (a, b) => a + b,
);
const commandResult = await vscode.commands.executeCommand(
  mockCommandId,
  2,
  3,
);
assert.equal(commandResult, 5);
mockCommandDisposable.dispose();
const missingHandlerResult = await vscode.commands.executeCommand(
  mockCommandId,
  1,
  1,
);
assert.equal(missingHandlerResult, undefined);

assert.equal(typeof vscode.window.createTerminal, "function");
const manualTerminal = vscode.window.createTerminal({
  name: "CommitSmith Manual Checks",
});
assert.equal(manualTerminal.name, "CommitSmith Manual Checks");
manualTerminal.show({ preserveFocus: true });
manualTerminal.sendText("echo ready", true);
manualTerminal.sendText("npm run test", false);
assert.deepEqual(manualTerminal.showCalls, [{ preserveFocus: true }]);
assert.deepEqual(manualTerminal.sentCommands, [
  { text: "echo ready", addNewLine: true },
  { text: "npm run test", addNewLine: false },
]);
manualTerminal.dispose();
assert.deepEqual(manualTerminal.exitStatus, { code: 0 });
const createdTerminals = terminals.getEntries();
const lastTerminal = createdTerminals[createdTerminals.length - 1];
assert.equal(lastTerminal.options.name, "CommitSmith Manual Checks");
assert.equal(lastTerminal.terminal.disposed, true);

assert.ok(Array.isArray(vscode.window.terminals));
assert.equal(
  vscode.window.terminals.find(() => true),
  undefined,
);

assert.equal(typeof vscode.ProgressLocation.Notification, "number");
const progressResult = await vscode.window.withProgress(
  {
    location: vscode.ProgressLocation.Notification,
    title: "Guard progress",
  },
  async (reporter, token) => {
    assert.equal(token.isCancellationRequested, false);
    reporter.report("Starting");
    reporter.report({ message: "Halfway", increment: 50 });
    return "complete";
  },
);
assert.equal(progressResult, "complete");
const progressCalls = progress.getCalls();
const lastProgressCall = progressCalls[progressCalls.length - 1];
assert.equal(lastProgressCall.options.title, "Guard progress");
assert.equal(
  lastProgressCall.options.location,
  vscode.ProgressLocation.Notification,
);
assert.deepEqual(lastProgressCall.reports[0], {
  message: "Starting",
});
assert.equal(lastProgressCall.lastMessage, "Halfway");
assert.equal(lastProgressCall.lastIncrement, 50);
assert.equal(lastProgressCall.result, "complete");

console.info("VS Code shim tests passed");
