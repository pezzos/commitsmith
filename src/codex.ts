import * as vscode from 'vscode';
import { getConfig } from './config';
import { JournalData } from './journal';

export type PipelineStep = 'format' | 'typecheck' | 'tests';

export interface FixContext {
  readonly filePath: string;
  readonly errorMessage: string;
  readonly codeSnippet?: string;
  readonly step?: PipelineStep;
}

export type AIPatch = {
  kind: 'unified-diff';
  diff: string;
  meta?: {
    producedBy?: string;
    step?: PipelineStep;
    note?: string;
  };
};

export type CodexOfflineFallbackReason = 'timeout' | 'network' | 'http';

export interface CodexOfflineFallbackEvent {
  readonly reason: CodexOfflineFallbackReason;
  readonly status?: number;
  readonly error?: Error;
}

const OUTPUT_CHANNEL_NAME = 'CommitSmith';

const offlineFallbackEmitter = new vscode.EventEmitter<CodexOfflineFallbackEvent>();
export const onCodexOfflineFallback = offlineFallbackEmitter.event;

export async function generateCommitMessage(journal: JournalData): Promise<string> {
  const payload = { journal };
  const response = await postJson<CommitResponse>('/commit', payload);

  if (!response.message || typeof response.message !== 'string') {
    throw new Error('Codex commit response did not include a commit message.');
  }

  return response.message.trim();
}

export async function generateFix(context: FixContext): Promise<AIPatch> {
  const response = await postJson<FixResponse>('/fix', context);
  const { diff, meta } = response;

  validateUnifiedDiff(diff);

  return {
    kind: 'unified-diff',
    diff,
    meta
  };
}

interface CommitResponse {
  readonly message: string;
}

interface FixResponse {
  readonly diff: string;
  readonly meta?: AIPatch['meta'];
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const config = getConfig();
  const endpoint = buildEndpointUrl(config.codexEndpoint, path);
  const requestBody = {
    model: config.codexModel,
    payload
  };

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.codexTimeoutMs);
  const requestStartedAt = Date.now();

  log(`[Codex] POST ${endpoint.pathname} model=${config.codexModel}`);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    const elapsed = Date.now() - requestStartedAt;
    log(`[Codex] Response ${response.status} (${elapsed}ms)`);

    if (!response.ok) {
      throw new CodexHttpError(response.status, `HTTP ${response.status}`);
    }

    const data = (await response.json()) as T;
    return data;
  } catch (error) {
    handleRequestError(error as Error);
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function validateUnifiedDiff(diff: unknown): asserts diff is string {
  if (typeof diff !== 'string' || diff.trim().length === 0) {
    throw new Error('Codex returned an empty diff.');
  }

  const headerMatch = diff.match(/^---\s+(?<from>\S+)\n\+\+\+\s+(?<to>\S+)/);
  if (!headerMatch || !headerMatch.groups) {
    throw new Error('Codex diff output is missing standard headers.');
  }

  const { from, to } = headerMatch.groups;
  const fromInfo = normalizeDiffPath(from, 'a');
  const toInfo = normalizeDiffPath(to, 'b');

  if (fromInfo?.containsTraversal || fromInfo?.isAbsolute) {
    throw new Error('Codex diff paths must not contain parent directory traversals or absolute paths.');
  }

  if (toInfo?.containsTraversal || toInfo?.isAbsolute) {
    throw new Error('Codex diff paths must not contain parent directory traversals or absolute paths.');
  }
}

function normalizeDiffPath(
  value: string,
  expectedPrefix: 'a' | 'b'
): { containsTraversal: boolean; isAbsolute: boolean } | null {
  if (value === '/dev/null') {
    return null;
  }

  if (!value.startsWith(`${expectedPrefix}/`)) {
    throw new Error('Codex diff must use repository-relative paths with a/ and b/ prefixes or /dev/null.');
  }

  const pathPart = value.slice(2);
  return {
    containsTraversal: pathPart.includes('..'),
    isAbsolute: pathPart.startsWith('/')
  };
}

function buildEndpointUrl(endpoint: string, path: string): URL {
  try {
    return new URL(path, endpoint);
  } catch (error) {
    throw new Error(`Invalid Codex endpoint: ${(error as Error).message}`);
  }
}

function handleRequestError(error: Error): void {
  if (error instanceof CodexHttpError) {
    offlineFallbackEmitter.fire({ reason: 'http', status: error.status, error });
  } else if (error.name === 'AbortError') {
    offlineFallbackEmitter.fire({ reason: 'timeout', error });
  } else {
    offlineFallbackEmitter.fire({ reason: 'network', error });
  }
  log(`[Codex] Request failed: ${error.message}`);
}

function log(message: string): void {
  const channel = getOutputChannel();
  channel.appendLine(message);
}

let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return outputChannel;
}

class CodexHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'CodexHttpError';
  }
}
