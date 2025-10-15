export interface CodexCommitMessageRequest {
  readonly journal: unknown;
}

export interface CodexCommitMessageResponse {
  readonly message: string;
}

export async function generateCommitMessage(
  _request: CodexCommitMessageRequest
): Promise<CodexCommitMessageResponse> {
  throw new Error('Codex integration not implemented yet.');
}

export async function generateFix(_payload: unknown): Promise<unknown> {
  throw new Error('Codex integration not implemented yet.');
}
