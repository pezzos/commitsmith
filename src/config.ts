import type { Disposable, Event, ExtensionContext } from "vscode";

const CONFIG_NAMESPACE = "commitSmith";

const MESSAGE_STYLES = ["conventional", "plain"] as const;
type MessageStyle = (typeof MESSAGE_STYLES)[number];

const CODEX_MODELS = ["gpt-5", "gpt-5-codex"] as const;
type CodexModel = (typeof CODEX_MODELS)[number];

const CODEX_REASONING_LEVELS = ["low", "medium", "high"] as const;
type CodexReasoningLevel = (typeof CODEX_REASONING_LEVELS)[number];

export interface CommitSmithConfig {
  readonly outputShowDebug: boolean;
  readonly formatCommand: string;
  readonly formatEnabled: boolean;
  readonly typecheckCommand: string;
  readonly typecheckEnabled: boolean;
  readonly testsCommand: string;
  readonly testsEnabled: boolean;
  readonly pipelineEnable: boolean;
  readonly pipelineRequireChecks: boolean;
  readonly pipelineMaxAiFixAttempts: number;
  readonly pipelineAbortOnFailure: boolean;
  readonly commitPushAfter: boolean;
  readonly messageStyle: MessageStyle;
  readonly messageEnforce72: boolean;
  readonly jiraFromBranch: boolean;
  readonly codexModel: CodexModel;
  readonly codexReasoningLevel: CodexReasoningLevel;
  readonly codexBinaryPath: string | null;
  readonly codexExtraArgs: string[];
  readonly codexSerenaOverride: string | null;
  readonly codexTimeoutMs: number;
  readonly codexSerenaTimeoutMs: number;
  readonly codexMcpWhitelist: readonly string[];
  readonly validationAllowOverride: boolean;
  readonly logMaskPatterns: readonly string[];
  readonly uiEnableKeybindings: boolean;
}

const DEFAULTS: CommitSmithConfig = {
  outputShowDebug: false,
  formatCommand: "npm run format:fix",
  formatEnabled: true,
  typecheckCommand: "npm run typecheck",
  typecheckEnabled: true,
  testsCommand: "npm test -- -w",
  testsEnabled: true,
  pipelineEnable: true,
  pipelineRequireChecks: false,
  pipelineMaxAiFixAttempts: 2,
  pipelineAbortOnFailure: true,
  commitPushAfter: false,
  messageStyle: "conventional",
  messageEnforce72: true,
  jiraFromBranch: true,
  codexModel: "gpt-5-codex",
  codexReasoningLevel: "low",
  codexBinaryPath: null,
  codexExtraArgs: [],
  codexSerenaOverride: null,
  codexTimeoutMs: 120_000,
  codexSerenaTimeoutMs: 180_000,
  codexMcpWhitelist: [],
  validationAllowOverride: true,
  logMaskPatterns: [
    "(?i)api[_-]?key\\s*=\\s*([a-z0-9-_]{16,})",
    "(?i)secret\\s*=\\s*([a-z0-9/+]{24,})",
    "\\b[A-Za-z0-9_-]{40,}\\b",
  ],
  uiEnableKeybindings: true,
};

interface ConfigEmitter<T> {
  readonly event: Event<T>;
  fire(value: T): void;
  dispose(): void;
}

class SimpleEventEmitter<T> implements ConfigEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event: Event<T>;

  constructor() {
    this.event = (listener, thisArgs, disposables) => {
      const target =
        typeof thisArgs === "undefined"
          ? listener
          : listener.bind(thisArgs);
      this.listeners.add(target);
      const disposable: Disposable = {
        dispose: () => {
          this.listeners.delete(target);
        },
      };
      if (Array.isArray(disposables)) {
        disposables.push(disposable);
      }
      return disposable;
    };
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

function createConfigEmitter<T>(): ConfigEmitter<T> {
  const vscodeModule = tryRequireVscode();
  if (vscodeModule?.EventEmitter) {
    const { EventEmitter } = vscodeModule;
    if (typeof EventEmitter === "function") {
      try {
        return new EventEmitter<T>();
      } catch {
        // Running under tests where the vscode shim does not expose
        // EventEmitter as a constructible value.
      }
    }
  }

  return new SimpleEventEmitter<T>();
}

const configChangeEmitter = createConfigEmitter<CommitSmithConfig>();

export const onDidChangeConfig = configChangeEmitter.event;

function createDefaultConfig(): CommitSmithConfig {
  return {
    ...DEFAULTS,
    codexExtraArgs: [...DEFAULTS.codexExtraArgs],
    codexMcpWhitelist: [...DEFAULTS.codexMcpWhitelist],
    logMaskPatterns: [...DEFAULTS.logMaskPatterns],
  };
}

export function initializeConfigWatcher(
  context: ExtensionContext,
): void {
  const vscodeModule = tryRequireVscode();
  const workspace = vscodeModule?.workspace;

  if (
    !workspace ||
    typeof workspace.onDidChangeConfiguration !== "function"
  ) {
    return;
  }

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_NAMESPACE)) {
        configChangeEmitter.fire(getConfig());
      }
    }),
  );
}

export function getConfig(): CommitSmithConfig {
  const vscodeModule = tryRequireVscode();
  const workspace = vscodeModule?.workspace;

  if (
    !workspace ||
    typeof workspace.getConfiguration !== "function"
  ) {
    return createDefaultConfig();
  }

  const settings = workspace.getConfiguration(CONFIG_NAMESPACE);

  if (!settings || typeof settings.get !== "function") {
    return createDefaultConfig();
  }

  return {
    outputShowDebug: settings.get<boolean>(
      "output.showDebug",
      DEFAULTS.outputShowDebug,
    ),
    formatCommand: settings.get<string>(
      "format.command",
      DEFAULTS.formatCommand,
    ),
    formatEnabled: settings.get<boolean>(
      "format.enabled",
      DEFAULTS.formatEnabled,
    ),
    typecheckCommand: settings.get<string>(
      "typecheck.command",
      DEFAULTS.typecheckCommand,
    ),
    typecheckEnabled: settings.get<boolean>(
      "typecheck.enabled",
      DEFAULTS.typecheckEnabled,
    ),
    testsCommand: settings.get<string>(
      "tests.command",
      DEFAULTS.testsCommand,
    ),
    testsEnabled: settings.get<boolean>(
      "tests.enabled",
      DEFAULTS.testsEnabled,
    ),
    pipelineEnable: settings.get<boolean>(
      "pipeline.enable",
      DEFAULTS.pipelineEnable,
    ),
    pipelineRequireChecks: settings.get<boolean>(
      "pipeline.requireChecks",
      DEFAULTS.pipelineRequireChecks,
    ),
    pipelineMaxAiFixAttempts: clampMinimum(
      settings.get<number>(
        "pipeline.maxAiFixAttempts",
        DEFAULTS.pipelineMaxAiFixAttempts,
      ),
      0,
      DEFAULTS.pipelineMaxAiFixAttempts,
      "commitSmith.pipeline.maxAiFixAttempts",
    ),
    pipelineAbortOnFailure: settings.get<boolean>(
      "pipeline.abortOnFailure",
      DEFAULTS.pipelineAbortOnFailure,
    ),
    commitPushAfter: settings.get<boolean>(
      "commit.pushAfter",
      DEFAULTS.commitPushAfter,
    ),
    messageStyle: coerceMessageStyle(
      settings.get<string>("message.style"),
      DEFAULTS.messageStyle,
    ),
    messageEnforce72: settings.get<boolean>(
      "message.enforce72",
      DEFAULTS.messageEnforce72,
    ),
    jiraFromBranch: settings.get<boolean>(
      "jira.fromBranch",
      DEFAULTS.jiraFromBranch,
    ),
    codexModel: coerceCodexModel(
      settings.get<string>("codex.model"),
      DEFAULTS.codexModel,
    ),
    codexReasoningLevel: coerceCodexReasoningLevel(
      settings.get<string>("codex.reasoningLevel"),
      DEFAULTS.codexReasoningLevel,
    ),
    codexBinaryPath: settings.get<string | null>(
      "codex.binaryPath",
      DEFAULTS.codexBinaryPath,
    ),
    codexExtraArgs: parseCliArgs(
      settings.get<string>("codex.extraArgs", ""),
    ),
    codexSerenaOverride: parseSerenaOverride(
      settings.get<string>("codex.serenaOverride", ""),
    ),
    codexTimeoutMs: clampMinimum(
      settings.get<number>(
        "codex.timeoutMs",
        DEFAULTS.codexTimeoutMs,
      ),
      1_000,
      DEFAULTS.codexTimeoutMs,
      "commitSmith.codex.timeoutMs",
    ),
    codexSerenaTimeoutMs: clampMinimum(
      settings.get<number>(
        "codex.serenaTimeoutMs",
        DEFAULTS.codexSerenaTimeoutMs,
      ),
      1_000,
      DEFAULTS.codexSerenaTimeoutMs,
      "commitSmith.codex.serenaTimeoutMs",
    ),
    codexMcpWhitelist: parseStringArray(
      settings.get<string[]>("codex.mcpWhitelist", [
        ...DEFAULTS.codexMcpWhitelist,
      ]),
    ),
    validationAllowOverride: settings.get<boolean>(
      "validation.allowOverride",
      DEFAULTS.validationAllowOverride,
    ),
    logMaskPatterns: parseStringArray(
      settings.get<string[]>("logs.maskPatterns", [
        ...DEFAULTS.logMaskPatterns,
      ]),
    ),
    uiEnableKeybindings: settings.get<boolean>(
      "ui.enableKeybindings",
      DEFAULTS.uiEnableKeybindings,
    ),
  };
}

function tryRequireVscode(): typeof import("vscode") | undefined {
  try {
    return require("vscode") as typeof import("vscode");
  } catch {
    return undefined;
  }
}

function clampMinimum(
  value: number,
  minimum: number,
  fallback: number,
  key: string,
): number {
  if (Number.isNaN(value) || value < minimum) {
    console.warn(
      `${key} must be >= ${minimum}. Falling back to default value ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

function coerceMessageStyle(
  value: string | undefined,
  fallback: MessageStyle,
): MessageStyle {
  if (!value) {
    return fallback;
  }
  if ((MESSAGE_STYLES as readonly string[]).includes(value)) {
    return value as MessageStyle;
  }
  console.warn(
    `commitSmith.message.style must be one of ${MESSAGE_STYLES.join(", ")}. Falling back to ${fallback}.`,
  );
  return fallback;
}

function coerceCodexModel(
  value: string | undefined,
  fallback: CodexModel,
): CodexModel {
  if (value && (CODEX_MODELS as readonly string[]).includes(value)) {
    return value as CodexModel;
  }
  if (value) {
    console.warn(
      `commitSmith.codex.model must be one of ${CODEX_MODELS.join(", ")}. Falling back to ${fallback}.`,
    );
  }
  return fallback;
}

function coerceCodexReasoningLevel(
  value: string | undefined,
  fallback: CodexReasoningLevel,
): CodexReasoningLevel {
  if (
    value &&
    (CODEX_REASONING_LEVELS as readonly string[]).includes(value)
  ) {
    return value as CodexReasoningLevel;
  }
  if (value) {
    console.warn(
      `commitSmith.codex.reasoningLevel must be one of ${CODEX_REASONING_LEVELS.join(", ")}. Falling back to ${fallback}.`,
    );
  }
  return fallback;
}

function parseCliArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const parts = value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const sanitized: string[] = [];
  const bannedFlags = new Set(["--dry-run", "--prompt-file"]);
  const warnedFlags = getWarnedCodexFlags();

  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    const lower = token.toLowerCase();

    if (
      lower.startsWith("--prompt-file=") ||
      bannedFlags.has(lower)
    ) {
      const warningKey = lower.startsWith("--prompt-file")
        ? "--prompt-file"
        : lower;
      if (!warnedFlags.has(warningKey)) {
        warnedFlags.add(warningKey);
        console.warn(
          `[CommitSmith] Removing deprecated Codex CLI flag "${token}" from commitSmith.codex.extraArgs.`,
        );
      }
      if (lower === "--prompt-file" && index + 1 < parts.length) {
        // Skip the value passed to --prompt-file <path>
        index += 1;
      }
      continue;
    }

    sanitized.push(token);
  }

  return sanitized;
}

function parseStringArray(
  value: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function parseSerenaOverride(
  value: string | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const warnedCodexFlags = new Set<string>();

function getWarnedCodexFlags(): Set<string> {
  return warnedCodexFlags;
}

export const __configTestUtils = {
  resetCodexExtraArgsWarningsForTest() {
    warnedCodexFlags.clear();
  },
};
