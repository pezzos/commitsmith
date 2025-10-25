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

  fire = (value) => {
    for (const listener of this.#listeners) {
      try {
        listener(value);
      } catch {
        // Tests do not expect listeners to throw, ignore to keep the shim simple.
      }
    }
  };

  dispose = () => {
    this.#listeners.clear();
  };
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

function isCancellationToken(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    typeof value.isCancellationRequested === "boolean" ||
    typeof value.onCancellationRequested === "function"
  );
}

function isQuickPickOptions(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(value, "canPickMany") ||
    Object.prototype.hasOwnProperty.call(value, "placeHolder") ||
    Object.prototype.hasOwnProperty.call(value, "matchOnDescription") ||
    Object.prototype.hasOwnProperty.call(value, "matchOnDetail") ||
    Object.prototype.hasOwnProperty.call(value, "title") ||
    Object.prototype.hasOwnProperty.call(value, "onDidSelectItem")
  );
}

function normalizeQuickPickArgs(optionsOrToken, tokenMaybe) {
  if (isCancellationToken(optionsOrToken) && !isQuickPickOptions(optionsOrToken)) {
    return { options: {}, token: optionsOrToken };
  }
  return {
    options: optionsOrToken || {},
    token: tokenMaybe && isCancellationToken(tokenMaybe) ? tokenMaybe : undefined,
  };
}

function toQuickPickArray(items) {
  if (Array.isArray(items)) {
    return items.slice();
  }
  if (items === undefined || items === null) {
    return [];
  }
  if (typeof items === "string") {
    return [items];
  }
  if (typeof items[Symbol.iterator] === "function") {
    return Array.from(items);
  }
  return [items];
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value.slice();
  }
  if (value === undefined) {
    return [];
  }
  return [value];
}

function normalizeSingleSelection(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : undefined;
  }
  return value;
}

function notifyQuickPickSelection(options, selection, canPickMany) {
  if (!options || typeof options.onDidSelectItem !== "function") {
    return;
  }
  if (canPickMany) {
    for (const item of selection) {
      options.onDidSelectItem(item);
    }
  } else if (selection !== undefined) {
    options.onDidSelectItem(selection);
  }
}

async function resolveQueuedResult(value, context) {
  if (typeof value === "function") {
    return await value(context);
  }
  return await value;
}

function createTerminalManager() {
  const entries = [];
  const create = (arg) => {
    const options =
      typeof arg === "string"
        ? { name: arg }
        : typeof arg === "object" && arg !== null
          ? { ...arg }
          : {};
    const terminal = {
      name: options.name || "",
      creationOptions: options,
      sentCommands: [],
      showCalls: [],
      exitStatus: undefined,
      disposed: false,
      sendText(text = "", addNewLine = true) {
        this.sentCommands.push({ text, addNewLine });
      },
      show(preserveFocusOrOptions) {
        this.showCalls.push(
          preserveFocusOrOptions === undefined
            ? {}
            : preserveFocusOrOptions,
        );
      },
      hide() {},
      dispose() {
        if (this.disposed) {
          return;
        }
        this.disposed = true;
        if (!this.exitStatus) {
          this.exitStatus = { code: 0 };
        }
      },
    };
    entries.push({ terminal, options });
    return terminal;
  };

  return {
    create,
    getEntries() {
      return entries.map(({ terminal, options }) => ({
        terminal,
        options,
      }));
    },
    reset() {
      entries.length = 0;
    },
  };
}

const PROGRESS_LOCATION = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};

function createProgressManager() {
  const calls = [];

  const withProgress = async (options, task) => {
    const normalizedOptions =
      options && typeof options === "object" ? { ...options } : {};
    const call = {
      options: normalizedOptions,
      reports: [],
      lastMessage: undefined,
      lastIncrement: undefined,
      result: undefined,
    };
    calls.push(call);

    const reporter = {
      report(value) {
        let normalized = {};
        if (value && typeof value === "object") {
          normalized = { ...value };
        } else if (typeof value === "string") {
          normalized = { message: value };
        }
        call.reports.push(normalized);
        if (Object.prototype.hasOwnProperty.call(normalized, "message")) {
          call.lastMessage = normalized.message;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, "increment")) {
          call.lastIncrement = normalized.increment;
        }
      },
    };

    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => createDisposable(),
    };

    const result = await Promise.resolve(task(reporter, token));
    call.result = result;
    return result;
  };

  return {
    withProgress,
    getCalls() {
      return calls.map((call) => ({
        options: call.options,
        reports: call.reports.slice(),
        lastMessage: call.lastMessage,
        lastIncrement: call.lastIncrement,
        result: call.result,
      }));
    },
    reset() {
      calls.length = 0;
    },
  };
}

function isMessageOptions(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (typeof value.title === "string") {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(value, "modal") ||
    Object.prototype.hasOwnProperty.call(value, "detail")
  );
}

function normalizeMessageItems(items) {
  const flattened = [];
  for (const entry of items) {
    if (entry === undefined || entry === null) {
      continue;
    }
    if (Array.isArray(entry)) {
      for (const nested of entry) {
        if (nested !== undefined && nested !== null) {
          flattened.push(nested);
        }
      }
      continue;
    }
    flattened.push(entry);
  }
  return flattened;
}

function normalizeMessageArgs(args) {
  let options;
  let rest = args;
  if (rest.length > 0 && isMessageOptions(rest[0])) {
    options = rest[0];
    rest = rest.slice(1);
  }
  return {
    options,
    items: normalizeMessageItems(rest),
  };
}

function createMessageController(kind) {
  const queue = [];
  const calls = [];
  return {
    dequeue() {
      return queue.shift();
    },
    enqueueResult(value) {
      queue.push({ type: "result", value });
    },
    resetQueue() {
      queue.length = 0;
    },
    record(call) {
      calls.push({ kind, ...call });
    },
    takeCalls() {
      return calls.slice();
    },
    clearCalls() {
      calls.length = 0;
    },
  };
}

function createMessageApi(controller) {
  return {
    setNextResult: (result) => controller.enqueueResult(result),
    reset: () => {
      controller.resetQueue();
      controller.clearCalls();
    },
    clearQueue: () => controller.resetQueue(),
    clearCalls: () => controller.clearCalls(),
    getCalls: () => controller.takeCalls(),
  };
}

function createShowMessage(controller) {
  const showMessage = async function showMessage(message, ...args) {
    const { options, items } = normalizeMessageArgs(args);
    controller.record({
      message,
      options: options || {},
      items,
    });

    const queued = controller.dequeue();
    if (queued && queued.type === "result") {
      return await resolveQueuedResult(queued.value, {
        message,
        options,
        items,
      });
    }

    if (items.length === 0) {
      return undefined;
    }

    return items[0];
  };

  return Object.assign(showMessage, {
    __setNextResult(result) {
      controller.enqueueResult(result);
    },
    __reset() {
      controller.resetQueue();
      controller.clearCalls();
    },
  });
}

function createQuickPickController() {
  const queue = [];
  return {
    dequeue() {
      return queue.shift();
    },
    enqueueResult(value) {
      queue.push({ type: "result", value });
    },
    enqueueCancel() {
      queue.push({ type: "cancel" });
    },
    reset() {
      queue.length = 0;
    },
  };
}

function createShowQuickPick(controller) {
  const showQuickPick = async function showQuickPick(itemsInput, optionsOrToken, tokenMaybe) {
    if (itemsInput === undefined || itemsInput === null) {
      return undefined;
    }

    const { options, token } = normalizeQuickPickArgs(optionsOrToken, tokenMaybe);
    const resolvedItems = await Promise.resolve(itemsInput);
    if (resolvedItems === undefined || resolvedItems === null) {
      return undefined;
    }
    const items = toQuickPickArray(resolvedItems);

    if (token) {
      if (token.isCancellationRequested) {
        return undefined;
      }
      if (typeof token.onCancellationRequested === "function") {
        let cancelled = false;
        const disposable = token.onCancellationRequested(() => {
          cancelled = true;
        });
        if (cancelled) {
          if (disposable && typeof disposable.dispose === "function") {
            disposable.dispose();
          }
          return undefined;
        }
      }
    }

    const queued = controller.dequeue();
    if (queued && queued.type === "cancel") {
      return undefined;
    }

    let selection;
    if (queued && queued.type === "result") {
      selection = await resolveQueuedResult(queued.value, { items, options });
    } else if (options.canPickMany) {
      selection = items.slice();
    } else if (items.length > 0) {
      selection = items[0];
    }

    if (selection === undefined) {
      return undefined;
    }

    if (options.canPickMany) {
      const normalizedMany = ensureArray(selection);
      notifyQuickPickSelection(options, normalizedMany, true);
      return normalizedMany;
    }

    const normalizedSingle = normalizeSingleSelection(selection);
    if (normalizedSingle === undefined) {
      return undefined;
    }
    notifyQuickPickSelection(options, normalizedSingle, false);
    return normalizedSingle;
  };

  return Object.assign(showQuickPick, {
    __setNextResult(result) {
      controller.enqueueResult(result);
    },
    __simulateCancel() {
      controller.enqueueCancel();
    },
    __reset() {
      controller.reset();
    },
  });
}

export function createVscodeMock(options = {}) {
  const {
    tempDir = process.cwd(),
    registeredCommands = [],
    overrides = {},
  } = options;

  const workspaceState = createMemento();
  const globalState = createMemento();
  const quickPickController = createQuickPickController();
  const showQuickPick = createShowQuickPick(quickPickController);
  const infoMessageController = createMessageController("info");
  const warningMessageController = createMessageController("warning");
  const errorMessageController = createMessageController("error");
  const showInformationMessage = createShowMessage(infoMessageController);
  const showWarningMessage = createShowMessage(warningMessageController);
  const showErrorMessage = createShowMessage(errorMessageController);
  const terminalManager = createTerminalManager();
  const progressManager = createProgressManager();
  const commandHandlers = new Map();

  const vscodeModule = {
    EventEmitter: ShimEventEmitter,
    Uri: {
      file: (fsPath) => ({ fsPath }),
    },
    commands: {
      registerCommand: (id, handler) => {
        registeredCommands.push(id);
        if (typeof handler === "function") {
          commandHandlers.set(id, handler);
        } else {
          commandHandlers.set(id, undefined);
        }
        return createDisposable(() => {
          commandHandlers.delete(id);
        });
      },
      async executeCommand(id, ...args) {
        const handler = commandHandlers.get(id);
        if (typeof handler !== "function") {
          return undefined;
        }
        return await handler(...args);
      },
    },
    StatusBarAlignment: {
      Left: 1,
      Right: 2,
    },
    QuickPickItemKind: {
      Separator: -1,
    },
    ProgressLocation: PROGRESS_LOCATION,
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
      terminals: [],
      createTerminal: (options) => terminalManager.create(options),
      setStatusBarMessage: () => createDisposable(),
      onDidCloseTerminal: () => createDisposable(),
      showInformationMessage,
      showWarningMessage,
      showErrorMessage,
      showQuickPick,
      withProgress: (options, task) =>
        progressManager.withProgress(options, task),
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
    quickPick: {
      setNextResult: (result) => quickPickController.enqueueResult(result),
      cancelNext: () => quickPickController.enqueueCancel(),
      reset: () => quickPickController.reset(),
    },
    messages: {
      information: createMessageApi(infoMessageController),
      warning: createMessageApi(warningMessageController),
      error: createMessageApi(errorMessageController),
    },
    terminals: {
      getEntries: () => terminalManager.getEntries(),
      reset: () => terminalManager.reset(),
    },
    progress: {
      getCalls: () => progressManager.getCalls(),
      reset: () => progressManager.reset(),
    },
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
