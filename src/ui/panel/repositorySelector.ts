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

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: number): GitAPI;
}

interface GitApiSnapshot {
  readonly api?: GitAPI;
  readonly activation?: Promise<GitAPI | undefined>;
}

function resolveGitApi(): GitApiSnapshot {
  try {
    const gitExtension =
      vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!gitExtension) {
      return {};
    }
    if (gitExtension.isActive) {
      try {
        const api = gitExtension.exports?.getAPI?.(1);
        return { api };
      } catch (error) {
        console.warn(
          "[CommitSmith] Git extension exports unavailable.",
          error,
        );
        return {};
      }
    }

    const activation = Promise.resolve(
      gitExtension.activate(),
    )
      .then<GitAPI | undefined>((exports) => {
        try {
          return exports?.getAPI?.(1);
        } catch (error) {
          console.warn(
            "[CommitSmith] Git extension activation completed but API unavailable.",
            error,
          );
          return undefined;
        }
      })
      .catch((error) => {
        console.warn(
          "[CommitSmith] Failed to activate Git extension.",
          error,
        );
        return undefined;
      });

    return { activation };
  } catch (error) {
    console.warn(
      "[CommitSmith] Exception while resolving Git extension.",
      error,
    );
    return {};
  }
}

export class RepositorySelector implements vscode.Disposable {
  private readonly emitter =
    new vscode.EventEmitter<RepositorySnapshot | null>();
  readonly onDidChange = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly gitDisposables: vscode.Disposable[] = [];
  private gitApi: GitAPI | undefined;
  private current: RepositorySnapshot | null = null;

  constructor() {
    this.initializeGitIntegration();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this.refresh(),
      ),
    );
  }

  get active(): RepositorySnapshot | null {
    return this.current;
  }

  private deriveRepositoryName(uri: vscode.Uri | undefined): string {
    const pathLike = uri?.path ?? uri?.fsPath;
    if (!pathLike) {
      return "repo";
    }

    const segments = pathLike.split(/[\\/]/).filter(Boolean);
    return segments.pop() ?? "repo";
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
    this.disposeGitListeners();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.emitter.dispose();
  }

  private computeSnapshot(): RepositorySnapshot | null {
    const selected = this.gitApi?.selectedRepository;
    if (selected) {
      return {
        rootUri: selected.rootUri,
        name: this.deriveRepositoryName(selected.rootUri),
        branch: selected.state?.HEAD?.name ?? undefined,
      };
    }

    const repositories = this.gitApi?.repositories ?? [];
    if (repositories.length === 1) {
      const repo = repositories[0];
      return {
        rootUri: repo.rootUri,
        name: this.deriveRepositoryName(repo.rootUri),
        branch: repo.state?.HEAD?.name ?? undefined,
      };
    }

    return null;
  }

  private initializeGitIntegration(): void {
    const snapshot = resolveGitApi();
    if (snapshot.api) {
      this.attachGitApi(snapshot.api);
      this.refresh();
      return;
    }

    if (snapshot.activation) {
      void snapshot.activation.then((api) => {
        if (!api) {
          this.refresh();
          return;
        }
        this.attachGitApi(api);
        this.refresh();
      });
      return;
    }

    this.refresh();
  }

  private attachGitApi(api: GitAPI): void {
    this.gitApi = api;
    this.disposeGitListeners();
    const { onDidOpenRepository, onDidCloseRepository } = api;
    if (typeof onDidOpenRepository === "function") {
      this.gitDisposables.push(onDidOpenRepository(() => this.refresh()));
    }
    if (typeof onDidCloseRepository === "function") {
      this.gitDisposables.push(onDidCloseRepository(() => this.refresh()));
    }
    if (api.onDidChangeSelectedRepository) {
      this.gitDisposables.push(
        api.onDidChangeSelectedRepository(() => this.refresh()),
      );
    }
    if (api.onDidChangeState) {
      this.gitDisposables.push(
        api.onDidChangeState(() => this.refresh()),
      );
    }
  }

  private disposeGitListeners(): void {
    for (const disposable of this.gitDisposables.splice(0)) {
      disposable.dispose();
    }
  }
}
