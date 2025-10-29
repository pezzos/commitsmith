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
  | "checks"
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
    supportsLogPagination: true,
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
          [message.payload.sectionId]: message.payload.collapsed,
        };
        await this.deps.stateStore.update("collapsedSections", next);
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
    // Local shim that mirrors the VS Code Webview UI Toolkit controls we rely on.
    const toolkitUri = this.requireResource("media/toolkit-shim.js");
    const jsUri = this.requireResource("media/panel.js");
    return {
      head: [
        `<link rel="stylesheet" href="${cssUri}">`,
        `<script type="module" nonce="${nonce}" src="${toolkitUri}"></script>`,
      ].join(""),
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
      ${this.renderSections()}
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
    `,
    };
  }

  private renderSections(): string {
    return [
      this.renderChecksSection(),
      this.renderJournalSection(),
      this.renderManualNoteSection(),
      this.renderCommitSection(),
    ].join("\n");
  }

  private renderChecksSection(): string {
    return `
      <section
        class="cs-section"
        data-section-id="checks"
        aria-label="Pipeline checks"
      >
        <button
          class="cs-section-header"
          type="button"
          data-action="toggle-section"
          data-section-id="checks"
          aria-expanded="true"
          aria-controls="checks-content"
        >
          <span class="cs-section-twistie" aria-hidden="true"></span>
          <span class="cs-section-title">Checks</span>
        </button>
        <div class="cs-section-body" id="checks-content">
          <p class="cs-section-subtitle">Pipeline steps and status</p>
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
              <vscode-button
                appearance="secondary"
                data-role="cancel-step"
                data-step-id="${section.step}"
                data-requires-repo
                disabled
                aria-disabled="true"
                title="${section.cancelTooltip ?? "Cancel not supported"}"
              >
                Cancel
              </vscode-button>`
      : "";
    const logPaginationControl = section.supportsLogPagination
      ? `
          <vscode-button
            appearance="secondary"
            data-role="load-more-logs"
            data-step-id="${section.step}"
            disabled
            aria-disabled="true"
            title="Load earlier log entries"
          >
            Load more logs
          </vscode-button>`
      : "";
    const codexReviewPanel =
      section.step === "codexReview"
        ? `
          <div class="cs-review" data-role="codex-review" data-source="codex">
            <div class="cs-review-meta">
              <span class="cs-badge cs-review-source" data-role="codex-source">AI</span>
              <span class="cs-review-confidence" data-role="codex-confidence" hidden></span>
              <time class="cs-review-timestamp" data-role="codex-timestamp" hidden></time>
            </div>
            <p class="cs-review-text" data-role="codex-review-text" aria-live="polite">
              Ask Codex Review to see insights here.
            </p>
          </div>`
        : "";
    return `
      <article class="cs-step-card" data-section-id="${sectionId}">
        <header class="cs-step-header">
          <button
            class="cs-section-toggle cs-section-toggle--step"
            type="button"
            data-action="toggle-section"
            data-section-id="${sectionId}"
            aria-expanded="true"
            aria-controls="${sectionId}-content"
          >
            <span class="cs-section-chevron" aria-hidden="true"></span>
            <span class="cs-step-text">
              <span class="cs-step-title">${section.label}</span>
              <span class="cs-step-description">${section.description}</span>
            </span>
          </button>
          <span class="cs-status-chip" data-role="status-chip" data-step-id="${section.step}" aria-live="polite">Idle</span>
        </header>
          <div class="cs-step-content" id="${sectionId}-content">
            <div class="cs-step-actions">
              <div class="cs-step-actions__buttons">
                <vscode-button
                  data-role="run-step"
                  data-step-id="${section.step}"
                  data-requires-repo
                >
                  ${section.buttonLabel}
                </vscode-button>
                <vscode-button
                  appearance="secondary"
                  data-role="rerun-last"
                  data-step-id="${section.step}"
                  data-requires-repo
                  disabled
                >
                  Rerun last
                </vscode-button>
                <vscode-button
                  data-role="rerun-failed"
                  data-step-id="${section.step}"
                  data-requires-repo
                  disabled
                  title="Runs only failed targets (coming soon)"
                >
                  Rerun failed only
                </vscode-button>
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
            ${codexReviewPanel}
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
        <button
          class="cs-section-header"
          type="button"
          data-action="toggle-section"
          data-section-id="journal"
          aria-expanded="true"
          aria-controls="journal-content"
        >
          <span class="cs-section-twistie" aria-hidden="true"></span>
          <span class="cs-section-title">Journal</span>
        </button>
        <div class="cs-section-body" id="journal-content">
          <p class="cs-section-subtitle">Codex, pipeline, and manual notes</p>
          <ul class="cs-journal-list" data-role="journal-list" tabindex="0">
            <li class="cs-journal-empty">Journal entries will appear here.</li>
          </ul>
          <vscode-button
            appearance="secondary"
            data-role="journal-load-more"
            disabled
            aria-disabled="true"
          >
            Load more
          </vscode-button>
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
        <button
          class="cs-section-header"
          type="button"
          data-action="toggle-section"
          data-section-id="manual"
          aria-expanded="true"
          aria-controls="manual-content"
        >
          <span class="cs-section-twistie" aria-hidden="true"></span>
          <span class="cs-section-title">Manual Note</span>
        </button>
        <div class="cs-section-body" id="manual-content">
          <p class="cs-section-subtitle">Add context to CommitSmith journal</p>
          <label class="cs-field">
            <span class="cs-field-label">Note</span>
            <vscode-text-area
              id="manual-note-input"
              rows="3"
              data-role="manual-note"
              data-requires-repo
            ></vscode-text-area>
          </label>
          <p
            class="cs-field-message"
            data-role="manual-error"
            hidden
            aria-live="polite"
          ></p>
          <div class="cs-field-footer">
            <span class="cs-counter" data-role="manual-counter">0 / 500</span>
            <vscode-checkbox data-role="note-opt-out">
              Do not add notes to next commit
            </vscode-checkbox>
          </div>
          <vscode-button
            data-role="add-note"
            data-requires-repo
          >
            Add note
          </vscode-button>
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
        <button
          class="cs-section-header"
          type="button"
          data-action="toggle-section"
          data-section-id="commit"
          aria-expanded="true"
          aria-controls="commit-content"
        >
          <span class="cs-section-twistie" aria-hidden="true"></span>
          <span class="cs-section-title">Commit</span>
        </button>
        <div class="cs-section-body" id="commit-content">
          <p class="cs-section-subtitle">Prepare Conventional Commit message</p>
          <label class="cs-field">
            <span class="cs-field-label">Commit message</span>
            <vscode-text-area
              id="commit-message-input"
              rows="4"
              data-role="commit-message"
              placeholder="Enter a message or run Codex/heuristics"
              data-requires-repo
            ></vscode-text-area>
          </label>
          <div class="cs-field-footer">
            <span class="cs-counter" data-role="commit-counter">0 / 72</span>
            <vscode-checkbox
              data-role="push-after"
              data-requires-repo
            >
              Push after commit
            </vscode-checkbox>
          </div>
          <vscode-button
            appearance="primary"
            data-role="commit"
            data-requires-repo
          >
            Commit &amp; Push
          </vscode-button>
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
