import * as vscode from "vscode";
import { getConfig, onDidChangeConfig } from "../../config";
import {
  CommitSmithStateStore,
  CommitSmithUIBridge,
  CommitSmithViewProvider,
  RepositorySelector,
  StepExecutionGate,
} from ".";
import { StepId } from "../../shared/types";

const COMMAND_OPEN_PANEL = "commitSmith.openPanel";
const COMMAND_RUN_FORMAT = "commitSmith.runFormat";
const COMMAND_RUN_LINT = "commitSmith.runLint";
const COMMAND_RUN_TYPECHECK = "commitSmith.runTypecheck";
const COMMAND_RUN_TESTS = "commitSmith.runTests";
const COMMAND_ASK_CODEX_REVIEW =
  "commitSmith.askCodexReview";
const COMMAND_ADD_MANUAL_NOTE = "commitSmith.addManualNote";
const COMMAND_COMMIT_AND_PUSH = "commitSmith.commitAndPush";
const CONTEXT_KEY_KEYBINDINGS = "commitSmith:uiKeybindingsEnabled";

const STEP_DISPLAY_ORDER: StepId[] = [
  "format",
  "lint",
  "typecheck",
  "tests",
  "codexReview",
];

const PLACEHOLDER_MESSAGE =
  "CommitSmith UI scaffolding is active. This command will be fully wired in upcoming slices.";

export interface UiInfrastructure {
  readonly stateStore: CommitSmithStateStore;
  readonly bridge: CommitSmithUIBridge;
  readonly gate: StepExecutionGate;
  readonly repositorySelector: RepositorySelector;
}

export function initializeUiInfrastructure(
  context: vscode.ExtensionContext,
): UiInfrastructure {
  const stateStore = new CommitSmithStateStore(
    context.workspaceState,
  );
  const gate = new StepExecutionGate();
  const repositorySelector = new RepositorySelector();
  const bridge = new CommitSmithUIBridge({
    extensionUri: context.extensionUri,
    rootAssets: ["media"],
  });

  context.subscriptions.push(
    stateStore,
    gate,
    repositorySelector,
    bridge,
  );

  const viewProvider = new CommitSmithViewProvider(context, {
    stateStore,
    bridge,
    gate,
    repositorySelector,
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CommitSmithViewProvider.viewType,
      viewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );

  registerCommands(context);
  syncKeybindingContext();
  context.subscriptions.push(
    onDidChangeConfig(() => {
      syncKeybindingContext();
    }),
  );

  gate.onDidReject(({ step, activeStep }) => {
    const friendlyStep = formatStepLabel(step);
    const activeLabel = formatStepLabel(activeStep);
    void vscode.window.showWarningMessage(
      `${friendlyStep} cannot start while ${activeLabel} is running.`,
    );
  });

  return {
    stateStore,
    gate,
    repositorySelector,
    bridge,
  };
}

function registerCommands(
  context: vscode.ExtensionContext,
): void {
  const focusViewCommand =
    "workbench.view.extension.commitSmith";
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN_PANEL, () =>
      vscode.commands.executeCommand(focusViewCommand),
    ),
  );
  const placeholderCommands = [
    COMMAND_RUN_FORMAT,
    COMMAND_RUN_LINT,
    COMMAND_RUN_TYPECHECK,
    COMMAND_RUN_TESTS,
    COMMAND_ASK_CODEX_REVIEW,
    COMMAND_ADD_MANUAL_NOTE,
    COMMAND_COMMIT_AND_PUSH,
  ];
  for (const command of placeholderCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        void vscode.window.showInformationMessage(
          PLACEHOLDER_MESSAGE,
        );
      }),
    );
  }
}

function syncKeybindingContext(): void {
  const config = getConfig();
  void vscode.commands.executeCommand(
    "setContext",
    CONTEXT_KEY_KEYBINDINGS,
    config.uiEnableKeybindings,
  );
}

function formatStepLabel(step: StepId): string {
  switch (step) {
    case "format":
      return "Format";
    case "lint":
      return "Lint";
    case "typecheck":
      return "Typecheck";
    case "tests":
      return "Tests";
    case "codexReview":
      return "Codex Review";
    default:
      return step;
  }
}

export function getStepDisplayOrder(): readonly StepId[] {
  return STEP_DISPLAY_ORDER;
}
