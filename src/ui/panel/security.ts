import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { getConfig, onDidChangeConfig } from "../../config";

const MASK_REPLACEMENT = "••••";

function compilePatterns(patterns: readonly string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const candidate of patterns) {
    let source = candidate;
    let flags = "g";
    if (source.startsWith("(?i)")) {
      source = source.slice(4);
      if (!flags.includes("i")) {
        flags += "i";
      }
    }
    try {
      compiled.push(new RegExp(source, flags));
    } catch {
      // Skip invalid user-specified regex.
    }
  }
  return compiled;
}

export class SecretMasker implements vscode.Disposable {
  private patterns: RegExp[];
  private readonly disposable: vscode.Disposable;

  constructor() {
    const config = getConfig();
    this.patterns = compilePatterns(config.logMaskPatterns);
    this.disposable = onDidChangeConfig((next) => {
      this.patterns = compilePatterns(next.logMaskPatterns);
    });
  }

  mask(value: string): string {
    let masked = value;
    for (const pattern of this.patterns) {
      masked = masked.replace(pattern, MASK_REPLACEMENT);
    }
    return masked;
  }

  dispose(): void {
    this.disposable.dispose();
  }
}

export function createNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

export function createContentSecurityPolicy(
  webview: vscode.Webview,
  nonce: string,
): string {
  const source = webview.cspSource;
  return [
    "<meta http-equiv=\"Content-Security-Policy\"",
    `content="default-src 'none';`,
    ` img-src ${source};`,
    ` style-src ${source};`,
    ` font-src ${source};`,
    ` connect-src ${source};`,
    ` script-src 'nonce-${nonce}';`,
    `">`,
  ].join("");
}

export function toWebviewResource(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  ...pathSegments: string[]
): vscode.Uri {
  const uri = vscode.Uri.joinPath(extensionUri, ...pathSegments);
  return webview.asWebviewUri(uri);
}
