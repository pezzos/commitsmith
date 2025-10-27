import * as vscode from "vscode";
import {
  CommitSmithStateStore,
  CommitSmithUIBridge,
  RepositorySelector,
  StepExecutionGate,
} from ".";
import { StepId } from "../../shared/types";
import { StateSnapshot, UiIncomingMessage } from "./bridge";

const VIEW_ID = "commitSmith.panel";

type SectionId =
  | `step.${StepId}`
  | "journal"
  | "manual"
  | "commit";

interface UiInfrastructureDeps {
  readonly stateStore: CommitSmithStateStore;
  readonly bridge: CommitSmithUIBridge;
  readonly gate: StepExecutionGate;
  readonly repositorySelector: RepositorySelector;
}

const STEP_SECTIONS: Array<{
  readonly step: StepId;
  readonly label: string;
  readonly description: string;
  readonly buttonLabel: string;
  readonly supportsCancel?: boolean;
  readonly cancelTooltip?: string;
  readonly supportsLogPagination?: boolean;
}> = [
  {
    step: "format",
    label: "Format",
    description: "Run formatter scripts before committing.",
    buttonLabel: "Run Format",
  },
  {
    step: "lint",
    label: "Lint",
    description: "Check code style and lint rules.",
    buttonLabel: "Run Lint",
  },
  {
    step: "typecheck",
    label: "Typecheck",
    description: "Execute the project type checking command.",
    buttonLabel: "Run Typecheck",
    supportsCancel: true,
    cancelTooltip: "Cancel not supported",
    supportsLogPagination: true,
  },
  {
    step: "tests",
    label: "Tests",
    description: "Run the automated test suite.",
    buttonLabel: "Run Tests",
  },
  {
    step: "codexReview",
    label: "Codex Review",
    description: "Request Codex insights before committing.",
    buttonLabel: "Ask Codex Review",
  },
];

export class CommitSmithViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewType = VIEW_ID;

  private webviewView: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: UiInfrastructureDeps,
  ) {
    this.disposables.push(
      this.deps.stateStore.onDidChange(() => this.sendState()),
      this.deps.repositorySelector.onDidChange(() =>
        this.sendState(),
      ),
      this.deps.bridge.onDidReceiveMessage((message) => {
        void this.handleMessage(message);
      }),
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this.webviewView = webviewView;
    this.deps.bridge.attach(webviewView);
    this.deps.bridge.render(webviewView, (nonce) =>
      this.renderDocument(webviewView.webview, nonce),
    );
    this.sendState();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async handleMessage(
    message: UiIncomingMessage,
  ): Promise<void> {
    switch (message.type) {
      case "SET_SECTION_COLLAPSED": {
        const next = {
          ...this.deps.stateStore.get("collapsedSections"),
          [message.payload.sectionId]:
            message.payload.collapsed,
        };
        await this.deps.stateStore.update(
          "collapsedSections",
          next,
        );
        break;
      }
      case "UPDATE_DRAFT_MESSAGE": {
        await this.deps.stateStore.update(
          "draftMessage",
          message.payload.value,
        );
        break;
      }
      case "UPDATE_DRAFT_NOTE": {
        await this.deps.stateStore.update(
          "draftNote",
          message.payload.value,
        );
        break;
      }
      case "ALLOW_SKIP": {
        const next = {
          ...this.deps.stateStore.get("skippable"),
          [message.payload.step]: message.payload.allowed,
        };
        await this.deps.stateStore.update("skippable", next);
        break;
      }
      case "UPDATE_NOTE_OPT_OUT": {
        await this.deps.stateStore.update(
          "manualNoteOptOut",
          message.payload.value,
        );
        break;
      }
      case "UPDATE_PUSH_AFTER": {
        await this.deps.stateStore.update(
          "pushAfterCommit",
          message.payload.value,
        );
        break;
      }
      default:
        break;
    }
  }

  private sendState(): void {
    const snapshot: StateSnapshot = {
      ...this.deps.stateStore.state,
      repositoryAvailable:
        this.deps.repositorySelector.active !== null,
    };
    this.deps.bridge.postMessage({
      type: "STATE_SYNC",
      payload: snapshot,
    });
  }

  private renderDocument(
    _webview: vscode.Webview,
    nonce: string,
  ): { head: string; body: string } {
    const cssUri = this.requireResource("media/panel.css");
    const jsUri = this.requireResource("media/panel.js");
    return {
      head: `<link rel="stylesheet" href="${cssUri}">`,
      body: `
  <div class="cs-root" data-focus-start>
    <div class="cs-offline-banner" role="status" aria-live="polite" hidden data-element="offline-banner">
      <span class="cs-offline-icon" aria-hidden="true">⚠️</span>
      <span class="cs-offline-text">Codex is currently offline. CommitSmith will fall back to local heuristics.</span>
    </div>
    <div class="cs-overlay" data-element="repo-overlay" hidden>
      <span>Select a repository to run CommitSmith</span>
    </div>
    <div class="cs-content" data-element="content">
      ${this.renderStepSections()}
      ${this.renderJournalSection()}
      ${this.renderManualNoteSection()}
      ${this.renderCommitSection()}
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
    `,
    };
  }

  private renderStepSections(): string {
    return `
    <section class="cs-section" aria-label="Pipeline checks">
      <header class="cs-section-header">
        <h2 class="cs-section-title">Checks</h2>
      </header>
      <div class="cs-section-body">
        ${STEP_SECTIONS.map((section) =>
          this.renderStepCard(section),
        ).join("\n")}
      </div>
    </section>
    `;
  }

  private renderStepCard(section: {
    readonly step: StepId;
    readonly label: string;
    readonly description: string;
    readonly buttonLabel: string;
    readonly supportsCancel?: boolean;
    readonly cancelTooltip?: string;
    readonly supportsLogPagination?: boolean;
  }): string {
    const sectionId: SectionId = `step.${section.step}`;
    const cancelControl = section.supportsCancel
      ? `
              <button
                class="cs-button cs-button--secondary"
                type="button"
                data-role="cancel-step"
                data-step-id="${section.step}"
                data-requires-repo
                disabled
                aria-disabled="true"
                title="${section.cancelTooltip ?? "Cancel not supported"}"
              >
                Cancel
              </button>`
      : "";
    const logPaginationControl = section.supportsLogPagination
      ? `
          <button
            class="cs-button cs-button--link"
            type="button"
            data-role="load-more-logs"
            data-step-id="${section.step}"
            disabled
            aria-disabled="true"
            title="Load earlier log entries"
          >
            Load more logs
          </button>`
      : "";
    return `
      <article class="cs-step-card" data-section-id="${sectionId}">
        <header class="cs-step-header">
          <button
            class="cs-section-toggle"
            type="button"
            data-action="toggle-section"
            data-section-id="${sectionId}"
            aria-expanded="true"
            aria-controls="${sectionId}-content"
          >
            <span class="cs-step-title">${section.label}</span>
            <span class="cs-step-description">${section.description}</span>
          </button>
          <span class="cs-status-chip" data-role="status-chip" data-step-id="${section.step}" aria-live="polite">Idle</span>
        </header>
        <div class="cs-step-content" id="${sectionId}-content">
          <div class="cs-step-actions">
            <div class="cs-step-actions__buttons">
              <button
                class="cs-button"
                type="button"
                data-role="run-step"
                data-step-id="${section.step}"
                data-requires-repo
              >
                ${section.buttonLabel}
              </button>
              <button
                class="cs-button cs-button--secondary"
                type="button"
                data-role="rerun-last"
                data-step-id="${section.step}"
                data-requires-repo
                disabled
              >
                Rerun last
              </button>
              <button
                class="cs-button"
                type="button"
                data-role="rerun-failed"
                data-step-id="${section.step}"
                data-requires-repo
                disabled
                title="Runs only failed targets (coming soon)"
              >
                Rerun failed only
              </button>
              ${cancelControl}
            </div>
            <label class="cs-checkbox">
              <input
                type="checkbox"
                data-role="skip-step"
                data-step-id="${section.step}"
              />
              Allow skip
            </label>
          </div>
          <div class="cs-log-container">
            <div class="cs-log" data-role="log" data-step-id="${section.step}" data-empty="true" tabindex="0">
              Logs will appear here once this step runs.
            </div>
            ${logPaginationControl}
          </div>
        </div>
      </article>
    `;
  }

  private renderJournalSection(): string {
    return `
      <section
        class="cs-section"
        data-section-id="journal"
        aria-label="Recent journal entries"
      >
        <header class="cs-section-header">
          <button
            class="cs-section-toggle"
            type="button"
            data-action="toggle-section"
            data-section-id="journal"
            aria-expanded="true"
            aria-controls="journal-content"
          >
            <span class="cs-section-title">Journal</span>
            <span class="cs-section-subtitle">Codex, pipeline, and manual notes</span>
          </button>
        </header>
        <div class="cs-section-body" id="journal-content">
          <ul class="cs-journal-list" data-role="journal-list" tabindex="0">
            <li class="cs-journal-empty">Journal entries will appear here.</li>
          </ul>
          <button
            class="cs-button cs-button--link"
            type="button"
            data-role="journal-load-more"
          >
            Load more
          </button>
        </div>
      </section>
    `;
  }

  private renderManualNoteSection(): string {
    return `
      <section
        class="cs-section"
        data-section-id="manual"
        aria-label="Manual note"
      >
        <header class="cs-section-header">
          <button
            class="cs-section-toggle"
            type="button"
            data-action="toggle-section"
            data-section-id="manual"
            aria-expanded="true"
            aria-controls="manual-content"
          >
            <span class="cs-section-title">Manual Note</span>
            <span class="cs-section-subtitle">Add context to CommitSmith journal</span>
          </button>
        </header>
        <div class="cs-section-body" id="manual-content">
          <label class="cs-field">
            <span class="cs-field-label">Note</span>
            <textarea
              class="cs-textarea"
              rows="3"
              data-role="manual-note"
              data-requires-repo
            ></textarea>
          </label>
          <div class="cs-field-footer">
            <span class="cs-counter" data-role="manual-counter">0 / 500</span>
            <label class="cs-checkbox">
              <input
                type="checkbox"
                data-role="note-opt-out"
              />
              Do not add notes to next commit
            </label>
          </div>
          <button
            class="cs-button"
            type="button"
            data-role="add-note"
            data-requires-repo
          >
            Add note
          </button>
        </div>
      </section>
    `;
  }

  private renderCommitSection(): string {
    return `
      <section
        class="cs-section"
        data-section-id="commit"
        aria-label="Commit message"
      >
        <header class="cs-section-header">
          <button
            class="cs-section-toggle"
            type="button"
            data-action="toggle-section"
            data-section-id="commit"
            aria-expanded="true"
            aria-controls="commit-content"
          >
            <span class="cs-section-title">Commit</span>
            <span class="cs-section-subtitle">Prepare Conventional Commit message</span>
          </button>
        </header>
        <div class="cs-section-body" id="commit-content">
          <label class="cs-field">
            <span class="cs-field-label">Commit message</span>
            <textarea
              class="cs-textarea"
              rows="4"
              data-role="commit-message"
              placeholder="Enter a message or run Codex/heuristics"
              data-requires-repo
            ></textarea>
          </label>
          <div class="cs-field-footer">
          <span class="cs-counter" data-role="commit-counter">0 / 72</span>
          <label class="cs-checkbox">
            <input
              type="checkbox"
              data-role="push-after"
              data-requires-repo
            />
            Push after commit
          </label>
          </div>
          <button
            class="cs-button cs-button--primary"
            type="button"
            data-role="commit"
            data-requires-repo
          >
            Commit &amp; Push
          </button>
        </div>
      </section>
    `;
  }

  private requireResource(path: string): string {
    const uri = this.deps.bridge.toResourceUri(path);
    if (!uri) {
      throw new Error(`Unable to resolve resource: ${path}`);
    }
    return uri.toString();
  }
}
