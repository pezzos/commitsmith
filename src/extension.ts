import { promisify } from "node:util";
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import {
  initializeConfigWatcher,
  onDidChangeConfig,
  getConfig,
} from "./config";
import { getRepo } from "./utils/git";
import { forgeCommitFromJournal } from "./workflows/forgeCommit";
import { performDryRun } from "./workflows/dryRun";
import {
  runPipeline,
  PipelineDecisionEvent,
  PipelineDecision,
  PipelineLane,
  PipelineStepId,
  StepLifecycleEvent,
  StepResult,
} from "./pipeline";
import { initializeJournal, clearCurrent } from "./journal";
import {
  getInitializationStatus,
  initializeRepository,
} from "./initializer";
import { onCodexOfflineFallback } from "./codex";
import {
  offerCodexBootstrap,
  executeCodexBootstrap,
} from "./bootstrap";
import {
  getOutputChannel,
  isVscodeOutputChannel,
  OutputChannelLike,
} from "./output";
import { GitRepository } from "./types/git";
import {
  hasAcknowledgedFastLaneReminder,
  recordFastLaneReminderAcknowledged,
} from "./preferences";

const execFileAsync = promisify(execFile);
const PIPELINE_STEPS: PipelineStepId[] = [
  "format",
  "typecheck",
  "tests",
];
const COMMAND_GENERATE = "commitSmith.generateFromJournal";
const COMMAND_CLEAR = "commitSmith.clearJournal";
const COMMAND_INSTALL_HOOKS = "commitSmith.installHooks";
const COMMAND_INITIALIZE = "commitSmith.initializeRepo";
const COMMAND_DRY_RUN = "commitSmith.dryRun";
const COMMAND_BOOTSTRAP = "commitSmith.codexBootstrap";
const COMMAND_SHOW_CHECKS = "commitSmith.pipeline.showChecks";
const WORKSPACE_STATE_PIPELINE_LANE = "commitSmith.pipeline.lane";
const COMMAND_CHOOSE_PIPELINE_LANE =
  "commitSmith.pipeline.chooseLane";
const COMMAND_TOGGLE_PIPELINE_LANE =
  "commitSmith.pipeline.toggleLane";
const COMMAND_RUN_FORMAT_CHECK = "commitSmith.pipeline.runFormat";
const COMMAND_RUN_TYPECHECK = "commitSmith.pipeline.runTypecheck";
const COMMAND_RUN_TESTS = "commitSmith.pipeline.runTests";
const STEP_DISPLAY_LABELS: Record<PipelineStepId, string> = {
  format: "Formatter",
  typecheck: "Typecheck",
  tests: "Tests",
};
const MANUAL_COMMANDS: Record<
  PipelineStepId,
  { command: string; detail: string }
> = {
  format: {
    command: "npm run format:fix",
    detail: "Prepare formatter fixes manually.",
  },
  typecheck: {
    command: "npm run typecheck",
    detail: "Run project type checks manually.",
  },
  tests: {
    command: "npm run test:all",
    detail: "Execute full test suite manually.",
  },
};

class PipelineLaneController implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;
  private current: PipelineLane;
  private readonly changeEmitter =
    new vscode.EventEmitter<PipelineLane>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      101,
    );
    this.statusItem.command = COMMAND_CHOOSE_PIPELINE_LANE;
    const stored = context.workspaceState.get<PipelineLane>(
      WORKSPACE_STATE_PIPELINE_LANE,
    );
    if (stored) {
      this.current = stored;
    } else {
      const config = getConfig();
      this.current = config.pipelineRequireChecks
        ? "guarded"
        : "fast";
    }
    this.render();
    this.statusItem.show();
  }

  get lane(): PipelineLane {
    return this.current;
  }

  async setLane(lane: PipelineLane): Promise<void> {
    if (this.current === lane) {
      return;
    }
    this.current = lane;
    await this.context.workspaceState.update(
      WORKSPACE_STATE_PIPELINE_LANE,
      lane,
    );
    this.render();
    const message =
      lane === "guarded"
        ? "CommitSmith guarded lane enabled – formatter/typecheck/test will run."
        : "CommitSmith fast lane enabled – heavy checks skipped unless required.";
    void vscode.window.setStatusBarMessage(message, 4000);
    this.changeEmitter.fire(this.current);
  }

  async promptForLane(): Promise<void> {
    const items: Array<
      vscode.QuickPickItem & { lane: PipelineLane }
    > = [
      {
        label: this.current === "fast" ? "✓ Fast lane" : "Fast lane",
        description: "Skip formatter/typecheck/test unless required.",
        lane: "fast",
      },
      {
        label:
          this.current === "guarded"
            ? "✓ Guarded lane"
            : "Guarded lane",
        description:
          "Always run formatter/typecheck/test before commit.",
        lane: "guarded",
      },
    ];
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: "Select CommitSmith pipeline lane",
    });
    if (!selection) {
      return;
    }
    await this.setLane(selection.lane);
  }

  async toggleLane(): Promise<void> {
    const nextLane: PipelineLane =
      this.current === "fast" ? "guarded" : "fast";
    await this.setLane(nextLane);
  }

  dispose(): void {
    this.statusItem.dispose();
    this.changeEmitter.dispose();
  }

  private render(): void {
    if (this.current === "guarded") {
      this.statusItem.text = "$(shield) Guarded lane";
      this.statusItem.tooltip =
        "CommitSmith guarded lane: formatter/typecheck/test run before commits. Click to change.";
    } else {
      this.statusItem.text = "$(rocket) Fast lane";
      this.statusItem.tooltip =
        "CommitSmith fast lane: heavy checks are skipped by default. Click to change.";
    }
  }
}

type ManualReminderAction = vscode.MessageItem & {
  manualStep?: PipelineStepId;
  suppress?: boolean;
};

interface CheckQuickPickItem extends vscode.QuickPickItem {
  mode: "run" | "manual" | "separator";
  step?: PipelineStepId | "all";
  manualStep?: PipelineStepId;
}

class ManualCheckReminder {
  private pending?: Promise<void>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onManualCommand: (step: PipelineStepId) => void,
  ) {}

  async maybeShow(lane: PipelineLane): Promise<void> {
    if (lane !== "fast") {
      return;
    }
    if (hasAcknowledgedFastLaneReminder(this.context.globalState)) {
      return;
    }
    if (this.pending) {
      await this.pending;
      return;
    }
    this.pending = this.showReminder();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async showReminder(): Promise<void> {
    const message =
      "CommitSmith fast lane is active. Formatter, typecheck, and test checks are skipped automatically. Run them manually when you need validation.";
    const actions: ManualReminderAction[] = [
      {
        title: MANUAL_COMMANDS.format.command,
        manualStep: "format",
      },
      {
        title: MANUAL_COMMANDS.typecheck.command,
        manualStep: "typecheck",
      },
      {
        title: MANUAL_COMMANDS.tests.command,
        manualStep: "tests",
      },
      {
        title: "Don't remind me again",
        isCloseAffordance: true,
        suppress: true,
      },
    ];
    const selection =
      await vscode.window.showInformationMessage<ManualReminderAction>(
        message,
        ...actions,
      );
    await recordFastLaneReminderAcknowledged(
      this.context.globalState,
    );
    if (selection?.manualStep) {
      this.onManualCommand(selection.manualStep);
    }
  }
}

type CheckState = "idle" | "running" | "success" | "failure";

interface CheckStatus {
  state: CheckState;
  stale: boolean;
  updatedAt?: number;
  durationMs?: number;
  message?: string;
  reason?: string;
}

class PipelineCheckScheduler implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;
  private readonly statuses = new Map<PipelineStepId, CheckStatus>();
  private readonly stepRuns = new Map<
    PipelineStepId,
    Promise<void>
  >();
  private pendingAll?: Promise<void>;
  private lastSignature?: string;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingChangeTimer: NodeJS.Timeout | undefined;
  private manualCommandTerminal: vscode.Terminal | undefined;
  private readonly reminder: ManualCheckReminder;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: OutputChannelLike,
    private readonly laneController: PipelineLaneController,
  ) {
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusItem.command = COMMAND_SHOW_CHECKS;
    for (const step of PIPELINE_STEPS) {
      this.statuses.set(step, { state: "idle", stale: true });
    }
    this.renderSummary();
    this.statusItem.show();

    this.reminder = new ManualCheckReminder(context, (step) =>
      this.prepareManualCommand(step),
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() => {
        this.schedulePotentialChange("file saved");
      }),
      vscode.workspace.onDidChangeTextDocument(() => {
        this.schedulePotentialChange("file changed");
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.markStale("workspace changed");
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === this.manualCommandTerminal) {
          this.manualCommandTerminal = undefined;
        }
      }),
    );
  }

  dispose(): void {
    if (this.pendingChangeTimer) {
      clearTimeout(this.pendingChangeTimer);
      this.pendingChangeTimer = undefined;
    }
    if (this.manualCommandTerminal) {
      this.manualCommandTerminal.dispose();
      this.manualCommandTerminal = undefined;
    }
    this.statusItem.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  initialize(): void {
    void this.handleLaneChange(
      this.laneController.lane,
      "activation",
    );
  }

  async handleLaneChange(
    lane: PipelineLane,
    reason: string,
  ): Promise<void> {
    try {
      await this.reminder.maybeShow(lane);
    } catch (error) {
      this.log(
        `[CHECKS] Unable to show fast lane reminder: ${
          (error as Error).message
        }.`,
      );
    }
    if (lane === "guarded") {
      await this.handlePotentialChange(reason);
    } else {
      this.markStale(`lane set to ${lane}`);
    }
  }

  async runStep(step: PipelineStepId, reason: string): Promise<void> {
    const existing = this.stepRuns.get(step);
    if (existing) {
      this.log(
        `[CHECKS] ${STEP_DISPLAY_LABELS[step]} already running; skipping duplicate request (${reason}).`,
      );
      return existing;
    }
    const task = this.executeStep(step, reason).finally(() => {
      this.stepRuns.delete(step);
      this.renderSummary();
    });
    this.stepRuns.set(step, task);
    await task;
  }

  async runAll(reason: string): Promise<void> {
    if (this.pendingAll) {
      this.log(
        `[CHECKS] Batch run already scheduled; coalescing request (${reason}).`,
      );
      return this.pendingAll;
    }
    const run = this.executeAll(reason).finally(() => {
      this.pendingAll = undefined;
    });
    this.pendingAll = run;
    await run;
  }

  async showQuickPick(): Promise<void> {
    const items: CheckQuickPickItem[] = [
      {
        mode: "run",
        label: "$(sync) Run All Checks",
        description:
          "Queue formatter/typecheck/test in the background.",
        step: "all",
      },
      ...PIPELINE_STEPS.map<CheckQuickPickItem>((step) => {
        const status = this.statuses.get(step)!;
        return {
          mode: "run",
          label: `${this.iconFor(step)} ${STEP_DISPLAY_LABELS[step]}`,
          description: this.descriptionFor(step),
          step,
          detail: status.stale
            ? "Stale – rerun recommended."
            : status.state === "idle"
              ? "No recent run."
              : undefined,
        };
      }),
      {
        mode: "separator",
        kind: vscode.QuickPickItemKind.Separator,
        label: "Manual commands",
      },
      ...PIPELINE_STEPS.map<CheckQuickPickItem>((step) => ({
        mode: "manual",
        manualStep: step,
        label: `$(terminal) ${MANUAL_COMMANDS[step].command}`,
        description: MANUAL_COMMANDS[step].detail,
        detail:
          "Inserts the command into a terminal without running it automatically.",
      })),
    ];
    const selection =
      await vscode.window.showQuickPick<CheckQuickPickItem>(items, {
        placeHolder: "CommitSmith pipeline checks",
      });
    if (!selection) {
      return;
    }
    if (selection.mode === "manual" && selection.manualStep) {
      this.prepareManualCommand(selection.manualStep);
      return;
    }
    if (selection.mode !== "run") {
      return;
    }
    if (selection.step === "all") {
      await this.runAll("manual quick pick");
      return;
    }
    await this.runStep(
      selection.step as PipelineStepId,
      "manual quick pick",
    );
  }

  markStale(reason: string): void {
    let updated = false;
    for (const [step, status] of this.statuses.entries()) {
      if (status.state === "running") {
        continue;
      }
      if (!status.stale) {
        this.statuses.set(step, { ...status, stale: true });
        updated = true;
      }
    }
    if (updated) {
      this.log(`[CHECKS] Marked check results stale (${reason}).`);
      this.renderSummary();
    }
  }

  private prepareManualCommand(step: PipelineStepId): void {
    const manual = MANUAL_COMMANDS[step];
    const terminal = this.ensureManualCommandTerminal();
    terminal.show(true);
    terminal.sendText(manual.command, false);
    this.log(
      `[CHECKS] Prepared manual command for ${STEP_DISPLAY_LABELS[step]}: ${manual.command}`,
    );
    void vscode.window.setStatusBarMessage(
      `CommitSmith manual command ready: ${manual.command}`,
      5000,
    );
  }

  private ensureManualCommandTerminal(): vscode.Terminal {
    if (
      this.manualCommandTerminal &&
      this.manualCommandTerminal.exitStatus === undefined
    ) {
      return this.manualCommandTerminal;
    }
    this.manualCommandTerminal = vscode.window.createTerminal({
      name: "CommitSmith Manual Checks",
    });
    return this.manualCommandTerminal;
  }

  private schedulePotentialChange(reason: string): void {
    if (this.pendingChangeTimer) {
      clearTimeout(this.pendingChangeTimer);
    }
    this.pendingChangeTimer = setTimeout(() => {
      this.pendingChangeTimer = undefined;
      void this.handlePotentialChange(reason);
    }, 750);
  }

  private async handlePotentialChange(reason: string): Promise<void> {
    const lane = this.laneController.lane;
    let repoSignature: string | undefined;
    try {
      const repo = await getRepo();
      repoSignature = await this.computeSignature(
        repo.rootUri.fsPath,
      );
    } catch (error) {
      this.log(
        `[CHECKS] Unable to inspect repository (${(error as Error).message}).`,
      );
    }

    const changed =
      typeof repoSignature === "string" &&
      repoSignature !== this.lastSignature;

    if (lane === "guarded") {
      if (changed || this.statusesHaveStale()) {
        await this.runAll(reason);
        if (repoSignature) {
          this.lastSignature = repoSignature;
        }
      }
    } else {
      if (changed) {
        this.lastSignature = repoSignature;
        this.markStale(reason);
      }
    }
  }

  private statusesHaveStale(): boolean {
    return PIPELINE_STEPS.some(
      (step) => this.statuses.get(step)?.stale ?? true,
    );
  }

  private async executeAll(reason: string): Promise<void> {
    this.log(
      `[CHECKS] Queuing formatter/typecheck/test (${reason}).`,
    );
    for (const step of PIPELINE_STEPS) {
      await this.runStep(step, `batch: ${reason}`);
    }
  }

  private async executeStep(
    step: PipelineStepId,
    reason: string,
  ): Promise<void> {
    const status = this.statuses.get(step)!;
    if (status.state === "running") {
      return;
    }
    this.statuses.set(step, {
      ...status,
      state: "running",
      stale: false,
      message: `Running (${reason})`,
    });
    this.renderSummary();

    let repo: GitRepository | undefined;
    try {
      repo = await getRepo();
    } catch (error) {
      this.statuses.set(step, {
        state: "failure",
        stale: true,
        message: (error as Error).message,
        updatedAt: Date.now(),
      });
      this.renderSummary();
      vscode.window.showErrorMessage(
        `CommitSmith ${STEP_DISPLAY_LABELS[step]} check failed: ${(error as Error).message}`,
      );
      return;
    }

    const start = Date.now();
    try {
      const friendlyName = STEP_DISPLAY_LABELS[step];
      this.log(
        `[CHECKS] Starting ${friendlyName} (reason: ${reason}).`,
      );
      const outcome = await runPipeline({
        repo,
        lane: "guarded",
        limitToSteps: [step],
        hooks: {
          onLog: (message: string) =>
            this.outputChannel.appendLine(message),
          onStepStart: () => {
            /* already handled */
          },
        },
      });
      const success =
        outcome.status === "completed" ||
        outcome.status === "commit-anyway";
      const durationMs = Date.now() - start;
      if (success) {
        this.statuses.set(step, {
          state: "success",
          stale: false,
          updatedAt: Date.now(),
          durationMs,
          message:
            outcome.status === "commit-anyway"
              ? "Completed with warnings."
              : "Completed successfully.",
          reason,
        });
        this.log(
          `[CHECKS] ${friendlyName} completed in ${(durationMs / 1000).toFixed(1)}s.`,
        );
      } else {
        this.statuses.set(step, {
          state: "failure",
          stale: true,
          updatedAt: Date.now(),
          durationMs,
          message: `Check aborted (${outcome.status}).`,
          reason,
        });
        this.log(
          `[CHECKS] ${friendlyName} failed (${outcome.status}).`,
        );
      }
    } catch (error) {
      const durationMs = Date.now() - start;
      this.statuses.set(step, {
        state: "failure",
        stale: true,
        updatedAt: Date.now(),
        durationMs,
        message: (error as Error).message,
        reason,
      });
      this.log(
        `[CHECKS] ${STEP_DISPLAY_LABELS[step]} failed: ${(error as Error).message}`,
      );
      vscode.window.showErrorMessage(
        `CommitSmith ${STEP_DISPLAY_LABELS[step]} check failed: ${(error as Error).message}`,
      );
    } finally {
      if (repo) {
        try {
          this.lastSignature = await this.computeSignature(
            repo.rootUri.fsPath,
          );
        } catch {
          // ignore signature failures
        }
      }
      this.renderSummary();
    }
  }

  private renderSummary(): void {
    const parts = PIPELINE_STEPS.map((step) => this.iconFor(step));
    this.statusItem.text = `Checks: ${parts.join(" ")}`;
    const lines = PIPELINE_STEPS.map((step) => {
      const label = STEP_DISPLAY_LABELS[step];
      const status = this.statuses.get(step)!;
      const stateText =
        status.state === "running"
          ? "Running"
          : status.state === "success"
            ? "Succeeded"
            : status.state === "failure"
              ? "Failed"
              : "Idle";
      const staleText = status.stale ? " (stale)" : "";
      const when = status.updatedAt
        ? ` • ${this.relativeTime(status.updatedAt)}`
        : "";
      const message = status.message ? ` – ${status.message}` : "";
      return `${label}: ${stateText}${staleText}${when}${message}`;
    });
    lines.push(
      "",
      "Manual commands:",
      ...PIPELINE_STEPS.map(
        (step) =>
          `${STEP_DISPLAY_LABELS[step]} → ${MANUAL_COMMANDS[step].command}`,
      ),
    );
    this.statusItem.tooltip = lines.join("\n");
  }

  private iconFor(step: PipelineStepId): string {
    const status = this.statuses.get(step)!;
    switch (status.state) {
      case "running":
        return "$(sync~spin)";
      case "success":
        return status.stale ? "✅⌛" : "✅";
      case "failure":
        return "❌";
      case "idle":
      default:
        return status.stale ? "○⌛" : "○";
    }
  }

  private descriptionFor(step: PipelineStepId): string {
    const status = this.statuses.get(step)!;
    const state =
      status.state === "running"
        ? "Running"
        : status.state === "success"
          ? "Succeeded"
          : status.state === "failure"
            ? "Failed"
            : "Idle";
    const stale = status.stale ? " (stale)" : "";
    const time = status.updatedAt
      ? ` • ${this.relativeTime(status.updatedAt)}`
      : "";
    return `${state}${stale}${time}`;
  }

  private relativeTime(timestamp: number): string {
    const delta = Date.now() - timestamp;
    const minutes = Math.round(delta / 60000);
    if (minutes <= 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    return `${hours}h ago`;
  }

  private async computeSignature(repoRoot: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v2", "--branch"],
      { cwd: repoRoot },
    );
    return stdout;
  }

  private log(message: string): void {
    this.outputChannel.appendLine(message);
  }
}
export function activate(context: vscode.ExtensionContext): void {
  initializeConfigWatcher(context);

  const outputChannel = getOutputChannel();
  if (isVscodeOutputChannel(outputChannel)) {
    context.subscriptions.push(outputChannel);
  }

  const laneController = new PipelineLaneController(context);
  context.subscriptions.push(laneController);
  const scheduler = new PipelineCheckScheduler(
    context,
    outputChannel,
    laneController,
  );
  context.subscriptions.push(scheduler);
  laneController.onDidChange((lane) => {
    void scheduler.handleLaneChange(lane, "lane change");
  });

  const codexFallbackDisposable = onCodexOfflineFallback((event) => {
    const reason =
      event.reason === "timeout"
        ? "Codex request timed out"
        : event.reason === "network"
          ? "Codex request failed"
          : `Codex request returned status ${event.status ?? "unknown"}`;
    outputChannel.appendLine(`[CODEX ⚠️] ${reason}`);
    vscode.window.showWarningMessage(
      `CommitSmith fallback: ${reason}`,
    );
  });
  context.subscriptions.push(codexFallbackDisposable);

  const configSubscription = onDidChangeConfig((updated) => {
    outputChannel.appendLine(
      `[CONFIG] Updated pipeline configuration: ${JSON.stringify(updated)}`,
    );
  });
  context.subscriptions.push(configSubscription);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_GENERATE, () =>
      handleGenerateFromJournal(
        outputChannel,
        laneController,
        scheduler,
      ),
    ),
    vscode.commands.registerCommand(
      COMMAND_CLEAR,
      handleClearJournal,
    ),
    vscode.commands.registerCommand(
      COMMAND_INSTALL_HOOKS,
      handleInstallHooks,
    ),
    vscode.commands.registerCommand(COMMAND_DRY_RUN, () =>
      handleDryRun(outputChannel),
    ),
    vscode.commands.registerCommand(COMMAND_INITIALIZE, () =>
      handleInitializeRepo(context, outputChannel),
    ),
    vscode.commands.registerCommand(COMMAND_BOOTSTRAP, () =>
      handleCodexBootstrap(context, outputChannel),
    ),
    vscode.commands.registerCommand(
      COMMAND_CHOOSE_PIPELINE_LANE,
      () => laneController.promptForLane(),
    ),
    vscode.commands.registerCommand(
      COMMAND_TOGGLE_PIPELINE_LANE,
      () => laneController.toggleLane(),
    ),
    vscode.commands.registerCommand(COMMAND_SHOW_CHECKS, () =>
      scheduler.showQuickPick(),
    ),
    vscode.commands.registerCommand(COMMAND_RUN_FORMAT_CHECK, () =>
      scheduler.runStep("format", "manual command"),
    ),
    vscode.commands.registerCommand(COMMAND_RUN_TYPECHECK, () =>
      scheduler.runStep("typecheck", "manual command"),
    ),
    vscode.commands.registerCommand(COMMAND_RUN_TESTS, () =>
      scheduler.runStep("tests", "manual command"),
    ),
  );

  scheduler.initialize();
  void promptForInitializationIfNeeded(context, outputChannel);
}

export function deactivate(): void {
  // Disposables are tracked in activate.
}

async function handleGenerateFromJournal(
  outputChannel: OutputChannelLike,
  laneController: PipelineLaneController,
  scheduler: PipelineCheckScheduler,
): Promise<void> {
  try {
    const repo = await getRepo();
    await initializeJournal({ root: repo.rootUri.fsPath });

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CommitSmith: forging commit",
        cancellable: false,
      },
      async () =>
        forgeCommitFromJournal({
          repo,
          journalRoot: repo.rootUri.fsPath,
          log: (message) => outputChannel.appendLine(message),
          promptDecision: (event) => promptForDecision(event),
          pipelineLane: laneController.lane,
        }),
    );

    switch (result.status) {
      case "empty":
        vscode.window.showInformationMessage(
          "CommitSmith journal is empty – nothing to forge.",
        );
        return;
      case "pipeline-aborted":
        scheduler.markStale("pipeline aborted");
        vscode.window.showErrorMessage(
          `CommitSmith aborted: ${result.failedStep ? `Pipeline failed at ${result.failedStep}.` : "Pipeline stopped."}`,
        );
        return;
      case "commit-warning":
        scheduler.markStale("commit warning");
        if ("commitAnnotation" in result && result.commitAnnotation) {
          outputChannel.appendLine(
            `[COMMIT ⚠️] ${result.commitAnnotation}`,
          );
        }
        if (result.pushFailed) {
          vscode.window.showWarningMessage(
            "Commit completed with warnings. Push failed; check Output panel.",
          );
        } else {
          vscode.window.showWarningMessage(
            "Commit completed with warnings. Review the output log.",
          );
        }
        return;
      case "commit-success":
        scheduler.markStale("commit success");
        if (result.pushFailed) {
          vscode.window.showWarningMessage(
            "Commit succeeded, but push failed. Check the output log.",
          );
        } else {
          vscode.window.showInformationMessage(
            "CommitSmith forged your commit successfully.",
          );
        }
        return;
      case "error":
        scheduler.markStale("commit error");
        vscode.window.showErrorMessage(
          `CommitSmith failed: ${result.message}`,
        );
        return;
    }
  } catch (error) {
    outputChannel.appendLine(`[ERROR] ${(error as Error).message}`);
    scheduler.markStale("commit failure");
    vscode.window.showErrorMessage(
      `CommitSmith failed: ${(error as Error).message}`,
    );
  }
}

async function handleClearJournal(): Promise<void> {
  try {
    const repo = await getRepo();
    await clearCurrent({ root: repo.rootUri.fsPath });
    vscode.window.showInformationMessage(
      "CommitSmith journal cleared.",
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to clear journal: ${(error as Error).message}`,
    );
  }
}

function handleInstallHooks(): void {
  vscode.window.showInformationMessage(
    "CommitSmith hooks installation is coming soon.",
  );
}

async function handleInitializeRepo(
  context: vscode.ExtensionContext,
  outputChannel: OutputChannelLike,
): Promise<void> {
  try {
    const repo = await getRepo({
      suppressInitializationReminder: true,
    });
    await runInitializationFlow(
      context,
      repo.rootUri.fsPath,
      outputChannel,
      { origin: "manual-command" },
    );
  } catch (error) {
    const message = (error as Error).message;
    outputChannel.appendLine(`[INIT][error] ${message}`);
    vscode.window.showErrorMessage(
      `CommitSmith initialization failed: ${message}`,
    );
  }
}

async function handleCodexBootstrap(
  context: vscode.ExtensionContext,
  outputChannel: OutputChannelLike,
): Promise<void> {
  try {
    const repo = await getRepo({
      suppressInitializationReminder: true,
    });
    await executeCodexBootstrap(
      context,
      repo.rootUri.fsPath,
      outputChannel,
    );
  } catch (error) {
    const message = (error as Error).message;
    outputChannel.appendLine(`[BOOTSTRAP][error] ${message}`);
    vscode.window.showErrorMessage(
      `Codex onboarding failed: ${message}`,
    );
  }
}

async function handleDryRun(
  outputChannel: OutputChannelLike,
): Promise<void> {
  try {
    const repo = await getRepo();

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CommitSmith: dry run",
        cancellable: false,
      },
      async () =>
        performDryRun({
          repo,
          log: (message) => outputChannel.appendLine(message),
          promptDecision: (event) => promptForDecision(event),
        }),
    );

    switch (result.status) {
      case "empty":
        vscode.window.showInformationMessage(
          "CommitSmith journal is empty – nothing to simulate.",
        );
        return;
      case "aborted":
        vscode.window.showWarningMessage(
          `Dry run aborted ${result.failedStep ? `at ${result.failedStep}` : ""}. Artefacts saved to ${result.folder}.`,
        );
        return;
      case "completed":
        vscode.window.showInformationMessage(
          `Dry run completed. Artefacts saved to ${result.folder}.`,
        );
        return;
      case "error":
        vscode.window.showErrorMessage(
          `CommitSmith dry run failed: ${result.message}`,
        );
        return;
    }
  } catch (error) {
    outputChannel.appendLine(`[ERROR] ${(error as Error).message}`);
    vscode.window.showErrorMessage(
      `CommitSmith dry run failed: ${(error as Error).message}`,
    );
  }
}

async function promptForDecision(
  event: PipelineDecisionEvent,
): Promise<PipelineDecision> {
  const choice = await vscode.window.showWarningMessage(
    `CommitSmith: ${event.step} is still failing after retries.`,
    { modal: true },
    "Commit anyway",
    "Retry step",
    "Abort pipeline",
  );

  if (choice === "Commit anyway") {
    return "commitAnyway";
  }
  if (choice === "Retry step") {
    return "retry";
  }
  return "abort";
}

async function promptForInitializationIfNeeded(
  context: vscode.ExtensionContext,
  outputChannel: OutputChannelLike,
): Promise<void> {
  try {
    const repo = await getRepo({
      suppressInitializationReminder: true,
    });
    const status = await getInitializationStatus(repo.rootUri.fsPath);
    if (!status.needsInitialization) {
      await offerCodexBootstrap(
        context,
        repo.rootUri.fsPath,
        outputChannel,
      );
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      "CommitSmith needs to finish its workspace setup before journal workflows can run.",
      "Initialize CommitSmith",
      "Later",
    );

    if (choice === "Initialize CommitSmith") {
      await runInitializationFlow(
        context,
        repo.rootUri.fsPath,
        outputChannel,
        { origin: "activation" },
      );
    }
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("CommitSmith journal invalid")) {
      outputChannel.appendLine(`[INIT][error] ${message}`);
      vscode.window.showErrorMessage(
        `CommitSmith initialization failed: ${message}`,
      );
    }
    // Git repository unavailable or other issue; ignore otherwise.
  }
}

interface InitializationFlowOptions {
  readonly origin: "activation" | "manual-command";
}

async function runInitializationFlow(
  context: vscode.ExtensionContext,
  repoRoot: string,
  outputChannel: OutputChannelLike,
  options: InitializationFlowOptions,
): Promise<void> {
  outputChannel.appendLine(
    `[INIT] commitSmith.initializeRepo invoked for ${repoRoot}`,
  );
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "CommitSmith: configuring workspace",
      cancellable: false,
    },
    async () =>
      initializeRepository({
        root: repoRoot,
        log: (message) => outputChannel.appendLine(message),
      }),
  );

  for (const step of result.steps) {
    const status = step.changed ? "updated" : "unchanged";
    outputChannel.appendLine(
      `[INIT][summary] ${step.id}: ${status} (${step.message})`,
    );
  }

  if (result.status.needsInitialization) {
    vscode.window.showWarningMessage(
      "CommitSmith setup completed with warnings. Review the output log for details.",
    );
  } else {
    vscode.window.showInformationMessage(
      "CommitSmith setup complete.",
    );
    await offerCodexBootstrap(context, repoRoot, outputChannel, {
      force: options.origin === "manual-command",
    });
  }
}
