import * as vscode from "vscode";
import { StepId } from "../../shared/types";

interface GateState {
  readonly activeStep: StepId | null;
}

interface GateRejection {
  readonly step: StepId;
  readonly activeStep: StepId;
}

export class StepExecutionGate implements vscode.Disposable {
  private activeStep: StepId | null = null;
  private readonly stateEmitter =
    new vscode.EventEmitter<GateState>();
  private readonly rejectionEmitter =
    new vscode.EventEmitter<GateRejection>();

  readonly onDidChange = this.stateEmitter.event;
  readonly onDidReject = this.rejectionEmitter.event;

  tryEnter(step: StepId): boolean {
    if (this.activeStep && this.activeStep !== step) {
      this.rejectionEmitter.fire({
        step,
        activeStep: this.activeStep,
      });
      return false;
    }
    if (this.activeStep === step) {
      this.rejectionEmitter.fire({
        step,
        activeStep: this.activeStep,
      });
      return false;
    }

    this.activeStep = step;
    this.stateEmitter.fire({ activeStep: this.activeStep });
    return true;
  }

  exit(step: StepId): void {
    if (this.activeStep !== step) {
      return;
    }
    this.activeStep = null;
    this.stateEmitter.fire({ activeStep: null });
  }

  dispose(): void {
    this.stateEmitter.dispose();
    this.rejectionEmitter.dispose();
  }
}
