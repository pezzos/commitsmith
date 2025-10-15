import * as vscode from 'vscode';

const CONFIG_NAMESPACE = 'commitSmith';

const MESSAGE_STYLES = ['conventional', 'plain'] as const;
type MessageStyle = (typeof MESSAGE_STYLES)[number];

export interface CommitSmithConfig {
  readonly formatCommand: string;
  readonly typecheckCommand: string;
  readonly testsCommand: string;
  readonly pipelineEnable: boolean;
  readonly pipelineMaxAiFixAttempts: number;
  readonly pipelineAbortOnFailure: boolean;
  readonly commitPushAfter: boolean;
  readonly messageStyle: MessageStyle;
  readonly messageEnforce72: boolean;
  readonly jiraFromBranch: boolean;
  readonly codexModel: string;
  readonly codexEndpoint: string;
  readonly codexTimeoutMs: number;
}

const DEFAULTS: CommitSmithConfig = {
  formatCommand: 'npm run format:fix',
  typecheckCommand: 'npm run typecheck',
  testsCommand: 'npm test -- -w',
  pipelineEnable: true,
  pipelineMaxAiFixAttempts: 2,
  pipelineAbortOnFailure: true,
  commitPushAfter: false,
  messageStyle: 'conventional',
  messageEnforce72: true,
  jiraFromBranch: true,
  codexModel: 'gpt-5-codex',
  codexEndpoint: 'http://localhost:9999',
  codexTimeoutMs: 10000
};

const configChangeEmitter = new vscode.EventEmitter<CommitSmithConfig>();

export const onDidChangeConfig = configChangeEmitter.event;

export function initializeConfigWatcher(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_NAMESPACE)) {
        configChangeEmitter.fire(getConfig());
      }
    })
  );
}

export function getConfig(): CommitSmithConfig {
  const settings = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

  return {
    formatCommand: settings.get<string>('format.command', DEFAULTS.formatCommand),
    typecheckCommand: settings.get<string>('typecheck.command', DEFAULTS.typecheckCommand),
    testsCommand: settings.get<string>('tests.command', DEFAULTS.testsCommand),
    pipelineEnable: settings.get<boolean>('pipeline.enable', DEFAULTS.pipelineEnable),
    pipelineMaxAiFixAttempts: clampMinimum(
      settings.get<number>('pipeline.maxAiFixAttempts', DEFAULTS.pipelineMaxAiFixAttempts),
      0,
      DEFAULTS.pipelineMaxAiFixAttempts,
      'commitSmith.pipeline.maxAiFixAttempts'
    ),
    pipelineAbortOnFailure: settings.get<boolean>('pipeline.abortOnFailure', DEFAULTS.pipelineAbortOnFailure),
    commitPushAfter: settings.get<boolean>('commit.pushAfter', DEFAULTS.commitPushAfter),
    messageStyle: coerceMessageStyle(settings.get<string>('message.style'), DEFAULTS.messageStyle),
    messageEnforce72: settings.get<boolean>('message.enforce72', DEFAULTS.messageEnforce72),
    jiraFromBranch: settings.get<boolean>('jira.fromBranch', DEFAULTS.jiraFromBranch),
    codexModel: settings.get<string>('codex.model', DEFAULTS.codexModel),
    codexEndpoint: settings.get<string>('codex.endpoint', DEFAULTS.codexEndpoint),
    codexTimeoutMs: clampMinimum(
      settings.get<number>('codex.timeoutMs', DEFAULTS.codexTimeoutMs),
      1,
      DEFAULTS.codexTimeoutMs,
      'commitSmith.codex.timeoutMs'
    )
  };
}

function clampMinimum(value: number, minimum: number, fallback: number, key: string): number {
  if (Number.isNaN(value) || value < minimum) {
    console.warn(`${key} must be >= ${minimum}. Falling back to default value ${fallback}.`);
    return fallback;
  }
  return value;
}

function coerceMessageStyle(value: string | undefined, fallback: MessageStyle): MessageStyle {
  if (value && (MESSAGE_STYLES as readonly string[]).includes(value)) {
    return value as MessageStyle;
  }
  console.warn(`commitSmith.message.style must be one of ${MESSAGE_STYLES.join(', ')}. Falling back to ${fallback}.`);
  return fallback;
}
