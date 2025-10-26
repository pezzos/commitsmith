import * as vscode from "vscode";
import {
  AppendLogEvent,
  CodexReviewResult,
  JournalEntry,
  StepId,
  StepStatusEvent,
} from "../../shared/types";
import { PersistedUiState } from "./stateStore";
import {
  createContentSecurityPolicy,
  createNonce,
  SecretMasker,
  toWebviewResource,
} from "./security";

export type UiIncomingMessage =
  | {
      readonly type: "RUN_STEP";
      readonly payload: { step: StepId };
    }
  | {
      readonly type: "ALLOW_SKIP";
      readonly payload: { step: StepId; allowed: boolean };
    }
  | {
      readonly type: "ADD_MANUAL_NOTE";
      readonly payload: { text: string };
    }
  | {
      readonly type: "REQUEST_JOURNAL_PAGE";
      readonly payload: { cursor?: string };
    }
  | {
      readonly type: "COMMIT_AND_PUSH";
      readonly payload: { message: string; push: boolean };
    }
  | {
      readonly type: "ACKNOWLEDGE_WARNING";
      readonly payload: { warning: string };
    };

export type UiOutgoingMessage =
  | { readonly type: "STATE_SYNC"; readonly payload: PersistedUiState }
  | { readonly type: "STEP_STATUS"; readonly payload: StepStatusEvent }
  | { readonly type: "APPEND_LOG"; readonly payload: AppendLogEvent }
  | { readonly type: "JOURNAL_UPDATE"; readonly payload: JournalEntry[] }
  | { readonly type: "REVIEW_RESULT"; readonly payload: CodexReviewResult }
  | {
      readonly type: "ERROR";
      readonly payload: { category: string; message: string };
    };

interface BridgeOptions {
  readonly extensionUri: vscode.Uri;
  readonly rootAssets: readonly string[];
}

const FLUSH_INTERVAL_MS = 100;

export class CommitSmithUIBridge implements vscode.Disposable {
  private webviewView: vscode.WebviewView | undefined;
  private readonly queue: UiOutgoingMessage[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly masker: SecretMasker;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly incomingEmitter =
    new vscode.EventEmitter<UiIncomingMessage>();
  private readonly errorEmitter =
    new vscode.EventEmitter<Error>();

  readonly onDidReceiveMessage = this.incomingEmitter.event;
  readonly onDidError = this.errorEmitter.event;

  constructor(private readonly options: BridgeOptions) {
    this.masker = new SecretMasker();
  }

  attach(view: vscode.WebviewView): void {
    this.disposeWebview();
    this.webviewView = view;
    const { webview } = view;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.options.extensionUri, "media"),
        ...this.options.rootAssets.map((relative) =>
          vscode.Uri.joinPath(
            this.options.extensionUri,
            relative,
          ),
        ),
      ],
    };
    this.disposables.push(
      webview.onDidReceiveMessage(
        (raw) => this.handleIncoming(raw),
        undefined,
        this.disposables,
      ),
    );
    this.ensureFlushLoop();
  }

  render(
    view: vscode.WebviewView,
    body: string,
  ): { nonce: string } {
    const nonce = createNonce();
    const { webview } = view;
    const csp = createContentSecurityPolicy(webview, nonce);
    webview.html = [
      "<!DOCTYPE html>",
      "<html lang=\"en\">",
      "<head>",
      "<meta charset=\"UTF-8\">",
      csp,
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\" />",
      "</head>",
      "<body>",
      body,
      "</body>",
      "</html>",
    ].join("");
    return { nonce };
  }

  toResourceUri(path: string): vscode.Uri | undefined {
    const segments = path.split("/").filter(Boolean);
    if (!this.webviewView) {
      return undefined;
    }
    return toWebviewResource(
      this.webviewView.webview,
      this.options.extensionUri,
      ...segments,
    );
  }

  postMessage(message: UiOutgoingMessage): void {
    this.queue.push(this.maskOutgoing(message));
    this.ensureFlushLoop();
  }

  dispose(): void {
    this.disposeWebview();
    this.masker.dispose();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.incomingEmitter.dispose();
    this.errorEmitter.dispose();
  }

  private handleIncoming(raw: unknown): void {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const message = raw as UiIncomingMessage;
    if (typeof message.type !== "string") {
      return;
    }
    try {
      this.incomingEmitter.fire(message);
    } catch (error) {
      if (error instanceof Error) {
        this.errorEmitter.fire(error);
      } else {
        this.errorEmitter.fire(
          new Error("Unhandled bridge error"),
        );
      }
    }
  }

  private ensureFlushLoop(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (!this.webviewView) {
      return;
    }
    if (this.queue.length === 0) {
      return;
    }
    const { webview } = this.webviewView;
    const pending = this.queue.splice(0);
    for (const message of pending) {
      try {
        await webview.postMessage(message);
      } catch (error) {
        if (error instanceof Error) {
          this.errorEmitter.fire(error);
        }
      }
    }
  }

  private maskOutgoing(
    message: UiOutgoingMessage,
  ): UiOutgoingMessage {
    if (message.type === "APPEND_LOG") {
      return {
        ...message,
        payload: {
          ...message.payload,
          chunk: this.masker.mask(message.payload.chunk),
        },
      };
    }
    if (message.type === "REVIEW_RESULT" && message.payload.text) {
      return {
        ...message,
        payload: {
          ...message.payload,
          text: this.masker.mask(message.payload.text),
        },
      };
    }
    return message;
  }

  private disposeWebview(): void {
    if (!this.webviewView) {
      return;
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.webviewView = undefined;
  }
}
