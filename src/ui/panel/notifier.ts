import * as vscode from "vscode";
import { TelemetryReporter } from "../telemetryReporter";
import { getConfig, onDidChangeConfig } from "../../config";
import { StepId, StepStatusEvent } from "../../shared/types";

type ToastKind = "info" | "warning" | "error";

const STATUS_TEMPLATES = {
  idle: "CommitSmith: Ready",
  running: (step: StepId): string =>
    `CommitSmith: Running ${describeStep(step)}`,
  success: "CommitSmith: ✅ All checks passed",
  error: (step: StepId): string =>
    `CommitSmith: ❌ ${describeStep(step)} failed`,
  lowConfidence: "CommitSmith: ⚠️ Low confidence message",
  alreadyRunning: (step: StepId): string =>
    `CommitSmith: ${describeStep(step)} already running`,
};

const TOAST_THROTTLE_MS = 750;

interface PendingToast {
  readonly message: string;
  readonly kind: ToastKind;
}

export class CommitSmithNotifier implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;
  private lastToastTimestamp = 0;
  private pendingToast: PendingToast | null = null;
  private readonly telemetry: TelemetryReporter;
  private telemetryEnabled: boolean;
  private readonly telemetryDisposable: vscode.Disposable;
  private readonly bridge: {
    postMessage: (message: { type: "STEP_STATUS"; payload: StepStatusEvent }) => void;
  };

  constructor(
    bridge: {
      postMessage: (message: { type: "STEP_STATUS"; payload: StepStatusEvent }) => void;
    },
    telemetry: TelemetryReporter,
  ) {
    this.bridge = bridge;
    this.telemetry = telemetry;
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
    );
    this.statusItem.text = STATUS_TEMPLATES.idle;
    this.statusItem.show();
    this.telemetryEnabled = getConfig().telemetryEnabled ?? true;
    this.telemetryDisposable = onDidChangeConfig((config) => {
      this.telemetryEnabled = config.telemetryEnabled ?? true;
    });
  }

  stepStarted(step: StepId): void {
    const payload: StepStatusEvent = {
      step,
      status: "running",
      blocking: true,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.setStatus(STATUS_TEMPLATES.running(step));
    this.publishStepStatus(payload);
    this.track("step_started", { step });
  }

  stepFinished(step: StepId, event: StepStatusEvent): void {
    this.publishStepStatus(event);
    const template =
      event.status === "success"
        ? STATUS_TEMPLATES.success
        : STATUS_TEMPLATES.error(step);
    this.setStatus(template);
    this.track("step_finished", {
      step,
      success: event.status === "success",
    });
  }

  showAlreadyRunning(step: StepId): void {
    const message = `${describeStep(step)} already running—wait for it to finish.`;
    this.queueToast({ kind: "warning", message });
    this.setStatus(STATUS_TEMPLATES.alreadyRunning(step));
  }

  showLowConfidenceWarning(): void {
    this.setStatus(STATUS_TEMPLATES.lowConfidence);
    this.queueToast({ kind: "warning", message: "Codex returned a low-confidence message." });
  }

  resetToIdle(): void {
    this.setStatus(STATUS_TEMPLATES.idle);
  }

  dispose(): void {
    this.statusItem.dispose();
    this.telemetryDisposable.dispose();
  }

  private publishStepStatus(event: StepStatusEvent): void {
    this.bridge.postMessage({
      type: "STEP_STATUS",
      payload: event,
    });
  }

  private queueToast(toast: PendingToast): void {
    const now = Date.now();
    if (now - this.lastToastTimestamp < TOAST_THROTTLE_MS) {
      return;
    }
    this.showToast(toast);
  }

  private showToast(toast: PendingToast): void {
    this.lastToastTimestamp = Date.now();
    this.pendingToast = null;
    switch (toast.kind) {
      case "warning":
        void vscode.window.showWarningMessage(toast.message);
        break;
      case "error":
        void vscode.window.showErrorMessage(toast.message);
        break;
      default:
        void vscode.window.showInformationMessage(toast.message);
        break;
    }
  }

  private setStatus(text: string): void {
    this.statusItem.text = text;
  }

  private track(event: string, properties: Record<string, unknown>): void {
    if (!this.telemetryEnabled) {
      return;
    }
    this.telemetry.track(event, properties);
  }
}

function describeStep(step: StepId): string {
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
