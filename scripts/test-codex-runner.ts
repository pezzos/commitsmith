#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore accessing private Node internals for test stubbing
import Module from "node:module";

const moduleLoad = (Module as any)._load as (
  request: string,
  parent: Module | null,
  isMain: boolean,
) => unknown;

(Module as any)._load = function mockedLoad(
  request: string,
  parent: Module | null,
  isMain: boolean,
) {
  if (request === "vscode") {
    class EventEmitter<T> {
      #listeners = new Set<(value: T) => void>();
      event = (listener: (value: T) => void) => {
        this.#listeners.add(listener);
        return { dispose: () => this.#listeners.delete(listener) };
      };
      fire(value: T) {
        for (const listener of this.#listeners) {
          listener(value);
        }
      }
    }

    return {
      EventEmitter,
      window: {
        createOutputChannel() {
          return { appendLine() {} };
        },
      },
      workspace: {
        getConfiguration() {
          return {
            get<T>(_key: string, defaultValue: T): T {
              return defaultValue;
            },
          };
        },
        onDidChangeConfiguration() {
          return { dispose() {} };
        },
      },
    };
  }

  return moduleLoad.call(this, request, parent, isMain);
};

async function main(): Promise<void> {
  const codexModule = await import(
    path.resolve(__dirname, "../dist/codex.js")
  );
  const {
    resolveCodexBinaryForTest,
    looksLikeAuthErrorForTest,
    looksLikeMissingBinaryForTest,
  } = codexModule.__codexTestUtils;

  const originalCodexPathEnv = process.env.CODEX_PATH;
  const originalPathEnv = process.env.PATH;
  const originalPathextEnv = process.env.PATHEXT;

  assert.equal(
    resolveCodexBinaryForTest("/usr/local/bin/codex"),
    "/usr/local/bin/codex",
  );
  assert.equal(
    resolveCodexBinaryForTest("  /opt/codex-cli  "),
    "/opt/codex-cli",
  );

  process.env.CODEX_PATH = "/tmp/codex-cli";
  assert.equal(resolveCodexBinaryForTest(null), "/tmp/codex-cli");

  delete process.env.CODEX_PATH;

  process.env.PATH =
    path.delimiter === ";" ? "C:\\nonexistent" : "/nonexistent";
  const resolvedWithoutPath = resolveCodexBinaryForTest(null);
  if (
    process.platform === "darwin" &&
    existsSync("/opt/homebrew/bin/codex")
  ) {
    assert.equal(resolvedWithoutPath, "/opt/homebrew/bin/codex");
  } else {
    assert.equal(resolvedWithoutPath, "codex");
  }

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-runner-"),
  );
  const fakeBinaryName =
    process.platform === "win32" ? "codex.cmd" : "codex";
  const fakeBinaryPath = path.join(tempDir, fakeBinaryName);
  await fs.writeFile(fakeBinaryPath, "#!/usr/bin/env sh\necho codex");
  if (process.platform !== "win32") {
    await fs.chmod(fakeBinaryPath, 0o755);
  }

  process.env.PATH = `${tempDir}${path.delimiter}${originalPathEnv ?? ""}`;
  if (process.platform === "win32") {
    process.env.PATHEXT = ".CMD;.EXE";
  }
  const resolvedFromPath = resolveCodexBinaryForTest(null);
  assert.equal(
    resolvedFromPath,
    process.platform === "win32"
      ? path.join(tempDir, "codex.cmd")
      : path.join(tempDir, "codex"),
  );

  if (typeof originalCodexPathEnv === "string") {
    process.env.CODEX_PATH = originalCodexPathEnv;
  } else {
    delete process.env.CODEX_PATH;
  }

  if (typeof originalPathEnv === "string") {
    process.env.PATH = originalPathEnv;
  } else {
    delete process.env.PATH;
  }
  if (typeof originalPathextEnv === "string") {
    process.env.PATHEXT = originalPathextEnv;
  } else {
    delete process.env.PATHEXT;
  }

  await fs.rm(tempDir, { recursive: true, force: true });

  assert(looksLikeAuthErrorForTest("Authentication required"));
  assert(looksLikeAuthErrorForTest("token expired"));
  assert.equal(looksLikeAuthErrorForTest("all clear"), false);

  assert(looksLikeMissingBinaryForTest("command not found"));
  assert(looksLikeMissingBinaryForTest("ENOENT: codex"));
  assert.equal(
    looksLikeMissingBinaryForTest("some other error"),
    false,
  );

  console.info("Codex CLI runner helpers tests passed");
}

void main().finally(() => {
  (Module as any)._load = moduleLoad;
});
