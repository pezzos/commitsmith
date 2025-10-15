import type * as vscode from 'vscode';

export interface GitExtension {
  getAPI(version: 1): API;
}

export interface API {
  readonly activeRepository: Repository | undefined;
  readonly repositories: Repository[];
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  add(paths: vscode.Uri | ReadonlyArray<vscode.Uri>): Promise<void>;
  addDot(): Promise<void>;
  commit(message: string, options?: { all?: boolean }): Promise<void>;
  push(remote?: string, branch?: string, setUpstream?: boolean): Promise<void>;
}
