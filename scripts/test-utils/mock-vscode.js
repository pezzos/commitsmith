import Module from "node:module";

function createDisposable(onDispose) {
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (typeof onDispose === "function") {
        try {
          onDispose();
        } catch {
          // Ignore listener errors in test shims.
        }
      }
    },
  };
}

class ShimEventEmitter {
  #listeners = new Set();

  event = (listener) => {
    this.#listeners.add(listener);
    return createDisposable(() => this.#listeners.delete(listener));
  };

  fire(value) {
    for (const listener of this.#listeners) {
      try {
        listener(value);
      } catch {
        // Tests do not expect listeners to throw, ignore to keep the shim simple.
      }
    }
  }
}

function createMemento() {
  const store = new Map();
  return {
    get(key, defaultValue) {
      return store.has(key) ? store.get(key) : defaultValue;
    },
    async update(key, value) {
      if (typeof value === "undefined") {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
  };
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object") {
    return target;
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof target[key] === "object" &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function createVscodeMock(options = {}) {
  const {
    tempDir = process.cwd(),
    registeredCommands = [],
    overrides = {},
  } = options;

  const workspaceState = createMemento();
  const globalState = createMemento();

  const vscodeModule = {
    EventEmitter: ShimEventEmitter,
    commands: {
      registerCommand: (id) => {
        registeredCommands.push(id);
        return createDisposable();
      },
    },
    StatusBarAlignment: {
      Left: 1,
      Right: 2,
    },
    window: {
      createOutputChannel: () => ({
        appendLine() {},
        dispose() {},
      }),
      createStatusBarItem: () => ({
        command: undefined,
        text: "",
        tooltip: "",
        show() {},
        hide() {},
        dispose() {},
      }),
      setStatusBarMessage: () => createDisposable(),
      onDidCloseTerminal: () => createDisposable(),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    extensions: {
      getExtension: () => ({
        isActive: true,
        exports: {
          getAPI: () => ({
            repositories: [
              {
                rootUri: { fsPath: tempDir },
                add: async () => {},
                addDot: async () => {},
                commit: async () => {},
                push: async () => {},
              },
            ],
          }),
        },
        activate: async () => {},
      }),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: tempDir } }],
      getConfiguration: () => ({
        get: (_key, defaultValue) => defaultValue,
      }),
      onDidChangeConfiguration: () => createDisposable(),
      onDidSaveTextDocument: () => createDisposable(),
      onDidChangeTextDocument: () => createDisposable(),
      onDidChangeWorkspaceFolders: () => createDisposable(),
    },
  };

  deepMerge(vscodeModule, overrides);

  const context = {
    subscriptions: [],
    workspaceState,
    globalState,
  };

  return {
    vscode: vscodeModule,
    context,
    registeredCommands,
  };
}

export function withVscodeMock(resolver, options = {}) {
  const originalLoad = Module._load;
  const mock = createVscodeMock(options);

  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return mock.vscode;
    }

    if (typeof resolver === "function") {
      const resolved = resolver(request, parent, isMain);
      if (resolved !== undefined) {
        return resolved;
      }
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return {
    ...mock,
    restore() {
      Module._load = originalLoad;
    },
  };
}
