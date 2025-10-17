import Module from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Creates a Codex CLI mock that intercepts `child_process.spawn` calls.
 * Consumers can queue JSONL responses or custom handlers to simulate CLI behaviour.
 */
export function createCodexCliMock() {
  const handlers = [];
  const spawnInvocations = [];
  const requests = [];
  let installed = false;
  let originalLoad;
  let resolver;

  function install(customResolver) {
    if (installed) {
      throw new Error("Codex CLI mock already installed.");
    }
    installed = true;
    resolver = customResolver;
    originalLoad = Module._load;
    Module._load = function mockedLoad(request, parent, isMain) {
      if (
        request === "child_process" ||
        request === "node:child_process"
      ) {
        const childProcessModule = originalLoad.call(
          this,
          request,
          parent,
          isMain,
        );
        return { ...childProcessModule, spawn };
      }

      if (typeof resolver === "function") {
        const resolved = resolver(request, parent, isMain);
        if (resolved !== undefined) {
          return resolved;
        }
      }

      return originalLoad.call(this, request, parent, isMain);
    };
  }

  function uninstall() {
    if (!installed) {
      return;
    }
    Module._load = originalLoad;
    installed = false;
    resolver = undefined;
    handlers.length = 0;
  }

  function spawn(command, args) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = () => {
      child.emit("close", 1);
      return true;
    };

    spawnInvocations.push({
      command,
      args: Array.isArray(args) ? [...args] : [],
    });

    let requestBuffer = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      requestBuffer += chunk;
    });
    stdin.on("end", () => {
      const payload =
        requestBuffer.trim().length > 0
          ? JSON.parse(requestBuffer)
          : null;
      requests.push(payload);
      const handler = handlers.shift();
      if (!handler) {
        io().respond();
        return;
      }
      handler(io(), payload);
    });
    stdin.on("finish", () => {
      stdin.emit("end");
    });

    const io = () => ({
      stdout,
      stderr,
      child,
      respond(events = [], options = {}) {
        const { exitCode = 0, stderrText } = options;
        if (Array.isArray(events) && !stdout.writableEnded) {
          for (const event of events) {
            stdout.write(`${JSON.stringify(event)}\n`);
          }
        }
        if (!stdout.writableEnded) {
          stdout.end();
        }
        if (stderrText && !stderr.writableEnded) {
          stderr.write(stderrText);
        }
        if (!stderr.writableEnded) {
          stderr.end();
        }
        setImmediate(() => child.emit("close", exitCode));
      },
      error(message = "Codex CLI failed", exitCode = 1) {
        if (message) {
          stderr.write(message);
        }
        stderr.end();
        stdout.end();
        setImmediate(() => child.emit("close", exitCode));
      },
      emitError(err) {
        stderr.end();
        stdout.end();
        setImmediate(() => child.emit("error", err));
      },
    });

    return child;
  }

  function queueHandler(handler) {
    handlers.push(handler);
  }

  function queueResponse(events, options = {}) {
    handlers.push((io) => {
      io.respond(events, options);
    });
  }

  function queueError(message, exitCode = 1) {
    handlers.push((io) => {
      io.error(message, exitCode);
    });
  }

  function queueMissingBinary(message = "ENOENT: codex") {
    handlers.push((io) => {
      const error = new Error(message);
      error.code = "ENOENT";
      io.emitError(error);
    });
  }

  return {
    install,
    uninstall,
    queueHandler,
    queueResponse,
    queueError,
    queueMissingBinary,
    spawnInvocations,
    requests,
  };
}
