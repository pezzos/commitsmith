import * as vscode from "vscode";
import { getConfig, onDidChangeConfig } from "../../config";
import {
  CommitSmithStateStore,
  CommitSmithNotifier,
  CommitSmithUIBridge,
  CommitSmithViewProvider,
  RepositorySelector,
  StepExecutionGate,
} from ".";
import { StepController } from "./stepController";
import { UiTelemetryReporter } from "../telemetryReporter";
import { onCodexOfflineFallback, checkCodexHealth } from "../../codex";
import { StepId, StepStatusEvent } from "../../shared/types";
import { createPanelOrchestrator } from "./panelOrchestrator";

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
  readonly notifier: CommitSmithNotifier;
}

export function initializeUiInfrastructure(
  context: vscode.ExtensionContext,
): UiInfrastructure {
  const stateStore = new CommitSmithStateStore(
    context.workspaceState,
  );
  currentStateStore = stateStore;
  const gate = new StepExecutionGate();
  const repositorySelector = new RepositorySelector();
  const bridge = new CommitSmithUIBridge({
    extensionUri: context.extensionUri,
    rootAssets: ["media"],
  });
  const telemetryReporter = new UiTelemetryReporter();
  const notifier = new CommitSmithNotifier(bridge, telemetryReporter);
  const orchestrator = createPanelOrchestrator(repositorySelector);
  const stepController = new StepController({
    stateStore,
    bridge,
    gate,
    repositorySelector,
    notifier,
    orchestrator,
  });

  context.subscriptions.push(
    stateStore,
    gate,
    repositorySelector,
    bridge,
    notifier,
    stepController,
    {
      dispose: () => {
        if (currentStateStore === stateStore) {
          currentStateStore = undefined;
        }
      },
    },
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

  registerCommands(context, {
    bridge,
    gate,
    notifier,
  });
  syncKeybindingContext();
  context.subscriptions.push(
    onDidChangeConfig(() => {
      syncKeybindingContext();
    }),
  );

  gate.onDidReject(({ activeStep }) => {
    notifier.showAlreadyRunning(activeStep);
  });

  const offlinePing = setInterval(() => {
    void refreshOfflineState();
  }, 30_000);
  context.subscriptions.push({
    dispose: () => clearInterval(offlinePing),
  });

  context.subscriptions.push(
    onCodexOfflineFallback(() => {
      void setOffline(true);
    }),
  );

  void refreshOfflineState();

  return {
    stateStore,
    gate,
    repositorySelector,
    bridge,
    notifier,
  };
}

function registerCommands(
  context: vscode.ExtensionContext,
  deps: {
    bridge: CommitSmithUIBridge;
    gate: StepExecutionGate;
    notifier: CommitSmithNotifier;
  },
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
        const step = mapCommandToStep(command);
        if (step && deps.gate.tryEnter(step)) {
          const now = new Date();
          const running: StepStatusEvent = {
            step,
            status: "running",
            blocking: false,
            startedAt: now.toISOString(),
            endedAt: null,
            message: "Placeholder execution",
          };
          deps.notifier.stepStarted(step);
          deps.bridge.postMessage({
            type: "STEP_STATUS",
            payload: running,
          });
          const finished: StepStatusEvent = {
            ...running,
            status: "success",
            blocking: false,
            endedAt: new Date().toISOString(),
            message: "Placeholder complete",
          };
          deps.notifier.stepFinished(step, finished);
          deps.bridge.postMessage({
            type: "STEP_STATUS",
            payload: finished,
          });
          deps.gate.exit(step);
        } else if (!step) {
          void vscode.window.showInformationMessage(
            PLACEHOLDER_MESSAGE,
          );
        }
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

async function setOffline(value: boolean): Promise<void> {
  const store = currentStateStore;
  if (!store) {
    return;
  }
  if (store.get("offline") === value) {
    return;
  }
  await store.update("offline", value);
}

let currentStateStore: CommitSmithStateStore | undefined;

async function refreshOfflineState(): Promise<void> {
  try {
    const healthy = await checkCodexHealth();
    await setOffline(!healthy);
  } catch {
    await setOffline(true);
  }
}

function mapCommandToStep(command: string): StepId | undefined {
  switch (command) {
    case COMMAND_RUN_FORMAT:
      return "format";
    case COMMAND_RUN_LINT:
      return "lint";
    case COMMAND_RUN_TYPECHECK:
      return "typecheck";
    case COMMAND_RUN_TESTS:
      return "tests";
    case COMMAND_ASK_CODEX_REVIEW:
      return "codexReview";
    default:
      return undefined;
  }
}
