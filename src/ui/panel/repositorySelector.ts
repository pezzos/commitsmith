import * as vscode from "vscode";
import { RepositorySnapshot } from "../../shared/types";

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state?: {
    readonly HEAD?: { readonly name?: string | null };
  };
}

interface GitAPI {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  readonly onDidChangeState?: vscode.Event<void>;
  readonly onDidChangeSelectedRepository?: vscode.Event<
    GitRepository | undefined
  >;
  readonly selectedRepository?: GitRepository;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: number): GitAPI;
}

function tryGetGitApi(): GitAPI | undefined {
  const gitExtension =
    vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!gitExtension) {
    return undefined;
  }
  const extension = gitExtension.isActive
    ? gitExtension
    : undefined;
  if (!extension) {
    void gitExtension.activate();
  }
  const api = gitExtension.exports?.getAPI?.(1);
  return api;
}

export class RepositorySelector implements vscode.Disposable {
  private readonly emitter =
    new vscode.EventEmitter<RepositorySnapshot | null>();
  readonly onDidChange = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private gitApi: GitAPI | undefined;
  private current: RepositorySnapshot | null = null;

  constructor() {
    this.gitApi = tryGetGitApi();
    this.refresh();
    if (this.gitApi) {
      this.disposables.push(
        this.gitApi.onDidOpenRepository(() => this.refresh()),
        this.gitApi.onDidCloseRepository(() => this.refresh()),
      );
      if (this.gitApi.onDidChangeSelectedRepository) {
        this.disposables.push(
          this.gitApi.onDidChangeSelectedRepository(() =>
            this.refresh(),
          ),
        );
      }
      if (this.gitApi.onDidChangeState) {
        this.disposables.push(
          this.gitApi.onDidChangeState(() => this.refresh()),
        );
      }
    }
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this.refresh(),
      ),
    );
  }

  get active(): RepositorySnapshot | null {
    return this.current;
  }

  refresh(): void {
    const snapshot = this.computeSnapshot();
    if (
      snapshot?.rootUri.toString() !==
        this.current?.rootUri.toString() ||
      snapshot?.branch !== this.current?.branch
    ) {
      this.current = snapshot;
      this.emitter.fire(this.current);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.emitter.dispose();
  }

  private computeSnapshot(): RepositorySnapshot | null {
    const selected = this.gitApi?.selectedRepository;
    if (selected) {
      return {
        rootUri: selected.rootUri,
        name: selected.rootUri.path.split("/").pop() ?? "repo",
        branch: selected.state?.HEAD?.name ?? undefined,
      };
    }

    const repositories = this.gitApi?.repositories ?? [];
    if (repositories.length === 1) {
      const repo = repositories[0];
      return {
        rootUri: repo.rootUri,
        name: repo.rootUri.path.split("/").pop() ?? "repo",
        branch: repo.state?.HEAD?.name ?? undefined,
      };
    }

    return null;
  }
}
