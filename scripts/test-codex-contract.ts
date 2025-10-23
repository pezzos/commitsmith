#!/usr/bin/env node

import { strict as assert } from "node:assert";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore accessing private Node internals for test stubbing
import Module from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

interface StubWorkspaceConfig {
  [key: string]: unknown;
}

interface CodexCliRecord {
  readonly argv: string[];
  readonly rawPayload?: string;
  readonly request?: {
    operation?: "commit" | "fix";
    model?: string;
  };
  readonly behavior?: string;
}

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

const logEntries: string[] = [];
const telemetryEvents: any[] = [];
const recordedArtifacts: any[] = [];
const fallbackEvents: unknown[] = [];

const fixtureBinary = path.resolve(
  __dirname,
  "./fixtures/codex-fake/codex.js",
);

const configStore: StubWorkspaceConfig = {
  "codex.model": "gpt-5-codex",
  "codex.reasoningLevel": "medium",
  "codex.binaryPath": fixtureBinary,
  "codex.extraArgs": "--profile contract-tests",
  "codex.serenaOverride": "",
  "message.style": "conventional",
  "codex.mcpWhitelist": [],
};

const originalLoad = (Module as any)._load;

function installVscodeStub(): void {
  (Module as any)._load = function mockedLoad(
    request: string,
    parent: unknown,
    isMain: boolean,
  ) {
    if (request === "vscode") {
      return {
        EventEmitter,
        ProgressLocation: {
          Notification: "notification",
        },
        window: {
          createOutputChannel() {
            return {
              appendLine: (value: string) => logEntries.push(value),
              dispose() {},
            };
          },
          withProgress: async (_options: unknown, task: any) =>
            task({
              report: () => {},
            }),
        },
        workspace: {
          getConfiguration(namespace: string) {
            if (namespace !== "commitSmith") {
              throw new Error(
                `Unexpected config namespace: ${namespace}`,
              );
            }
            return {
              get<T>(key: string, defaultValue: T): T {
                return (configStore[key] as T) ?? defaultValue;
              },
            };
          },
          onDidChangeConfiguration() {
            return { dispose() {} };
          },
        },
      };
    }

    if (request === "./telemetry") {
      return require("../dist/telemetry.js");
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}

function restoreLoad(): void {
  (Module as any)._load = originalLoad;
}

async function ensureFixtureExecutable(): Promise<void> {
  await fs.chmod(fixtureBinary, 0o755).catch(() => {});
}

async function readCodexRecord(
  recordPath: string,
): Promise<CodexCliRecord> {
  const raw = await fs.readFile(recordPath, "utf8");
  return JSON.parse(raw) as CodexCliRecord;
}

function telemetryByName(name: string): any[] {
  return telemetryEvents.filter((event) => event?.name === name);
}

async function main(): Promise<void> {
  await ensureFixtureExecutable();
  installVscodeStub();

  try {
    const codexModule = await import(
      path.resolve(__dirname, "../dist/codex.js")
    );
    const telemetryModule = await import(
      path.resolve(__dirname, "../dist/telemetry.js")
    );
    const {
      generateCommitMessage,
      generateFix,
      onCodexOfflineFallback,
      __codexTestUtils,
    } = codexModule;

    const telemetrySubscription = telemetryModule.onTelemetryEvent(
      (event: unknown) => telemetryEvents.push(event),
    );
    const fallbackSubscription = onCodexOfflineFallback(
      (event: unknown) => fallbackEvents.push(event),
    );

    __codexTestUtils?.resetCodexCompatibilityForTest?.();

    // Positive commit (read-only sandbox)
    {
      const recordPath = path.join(
        os.tmpdir(),
        `codex-fake-${Date.now()}-commit.json`,
      );
      process.env.CODEX_FAKE_RECORD = recordPath;
      process.env.CODEX_FAKE_BEHAVIOR = "auto";

      const artifactCountBefore = recordedArtifacts.length;
      const telemetryAdoptionBefore = telemetryByName(
        "codexCli.adoption",
      ).length;
      const telemetryStdinBefore = telemetryByName(
        "codexCli.stdinWrite",
      ).length;

      const message = await generateCommitMessage(
        {
          current: [
            { message: "feat: contract test", file: "src/app.ts" },
          ],
          meta: {},
        },
        {
          recordArtifact: async (artifact: any) => {
            recordedArtifacts.push(artifact);
          },
          log: (entry: string) => logEntries.push(entry),
        },
      );

      assert.equal(
        message,
        "feat: contract test\n\n- feat: contract test",
      );
      const record = await readCodexRecord(recordPath);
      assert.equal(
        record.argv[0],
        "exec",
        "CLI should invoke codex exec with positional command",
      );
      assert.equal(
        record.argv[1],
        "--json",
        "CLI should enable JSON output flag immediately after exec",
      );
      const sandboxIndex = record.argv.indexOf("--sandbox");
      assert.notEqual(sandboxIndex, -1);
      assert.equal(record.argv[sandboxIndex + 1], "read-only");
      const modelIndex = record.argv.indexOf("--model");
      assert.notEqual(modelIndex, -1);
      assert.equal(record.argv[modelIndex + 1], "gpt-5-codex");
      const profileIndex = record.argv.indexOf("--profile");
      assert.notEqual(profileIndex, -1);
      assert.equal(record.argv[profileIndex + 1], "contract-tests");

      assert.ok(record.request);
      assert.equal(record.request?.operation, "commit");

      assert.equal(
        recordedArtifacts.length,
        artifactCountBefore + 1,
        "Exactly one journal artifact should be recorded for commit flow",
      );

      assert(
        telemetryByName("codexCli.adoption").length >
          telemetryAdoptionBefore,
        "Commit flow should emit adoption telemetry",
      );
      assert(
        telemetryByName("codexCli.stdinWrite").length >
          telemetryStdinBefore,
        "Commit flow should emit stdin write telemetry",
      );
      assert(
        logEntries.some((entry) =>
          entry.includes("prompt write completed"),
        ),
        "Prompt timing log should be present",
      );

      await fs.unlink(recordPath).catch(() => {});
      delete process.env.CODEX_FAKE_RECORD;
      delete process.env.CODEX_FAKE_BEHAVIOR;
    }

    __codexTestUtils?.resetCodexCompatibilityForTest?.();

    // Positive fix (workspace-write sandbox)
    {
      const recordPath = path.join(
        os.tmpdir(),
        `codex-fake-${Date.now()}-fix.json`,
      );
      process.env.CODEX_FAKE_RECORD = recordPath;

      const artifactCountBefore = recordedArtifacts.length;
      const telemetryAdoptionBefore = telemetryByName(
        "codexCli.adoption",
      ).length;
      const telemetryStdinBefore = telemetryByName(
        "codexCli.stdinWrite",
      ).length;

      const patch = await generateFix(
        {
          filePath: "src/example.ts",
          errorMessage: "lint failure",
          step: "tests",
        },
        {
          recordArtifact: async (artifact: any) => {
            recordedArtifacts.push(artifact);
          },
          log: (entry: string) => logEntries.push(entry),
        },
      );

      assert.equal(patch.kind, "unified-diff");
      assert.match(patch.diff, /--- a\/src\/example.ts/);
      const record = await readCodexRecord(recordPath);
      const sandboxIndex = record.argv.indexOf("--sandbox");
      assert.notEqual(sandboxIndex, -1);
      assert.equal(record.argv[sandboxIndex + 1], "workspace-write");

      assert.equal(
        recordedArtifacts.length,
        artifactCountBefore + 1,
        "Exactly one journal artifact should be recorded for fix flow",
      );
      assert(
        telemetryByName("codexCli.adoption").length >
          telemetryAdoptionBefore,
        "Fix flow should emit adoption telemetry",
      );
      assert(
        telemetryByName("codexCli.stdinWrite").length >
          telemetryStdinBefore,
        "Fix flow should emit stdin write telemetry",
      );

      await fs.unlink(recordPath).catch(() => {});
      delete process.env.CODEX_FAKE_RECORD;
    }

    __codexTestUtils?.resetCodexCompatibilityForTest?.();

    // Negative scenario: CLI emits result without proper schema
    {
      const recordPath = path.join(
        os.tmpdir(),
        `codex-fake-${Date.now()}-negative.json`,
      );
      process.env.CODEX_FAKE_RECORD = recordPath;
      process.env.CODEX_FAKE_BEHAVIOR = "fail-no-schema";

      let failureCaught = false;
      try {
        await generateCommitMessage(
          {
            current: [
              { message: "feat: failure path", file: "src/app.ts" },
            ],
            meta: {},
          },
          {
            recordArtifact: async (artifact: any) => {
              recordedArtifacts.push(artifact);
            },
            log: (entry: string) => logEntries.push(entry),
          },
        );
      } catch (error) {
        failureCaught = true;
        assert(
          (error as Error).message.includes("codex-cli-commit.v1"),
          "Error should reference schema validation failure",
        );
      }
      assert(failureCaught, "Failure path should throw");
      assert(
        !logEntries.some((entry) =>
          entry.includes(
            "CLI provided a commit message before failing",
          ),
        ),
        "Heuristic fallback must not trigger",
      );

      await fs.unlink(recordPath).catch(() => {});
      delete process.env.CODEX_FAKE_RECORD;
      delete process.env.CODEX_FAKE_BEHAVIOR;
    }

    telemetrySubscription.dispose();
    fallbackSubscription.dispose();
  } finally {
    restoreLoad();
  }

  console.info("Codex CLI contract tests passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
