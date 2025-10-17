#!/usr/bin/env node

import { strict as assert } from "node:assert";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore accessing private Node internals for test stubbing
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore test helper has no type declarations
import { createCodexCliMock } from "./test-utils/mock-codex-cli.js";

interface StubWorkspaceConfig {
  [key: string]: unknown;
}

interface CodexCliRequest {
  readonly model: string;
  readonly operation: "commit" | "fix";
  readonly payload: any;
}

const configStore: StubWorkspaceConfig = {
  "codex.model": "gpt-5-codex",
  "codex.reasoningLevel": "medium",
  "codex.binaryPath": "mock-codex",
  "codex.extraArgs": "--profile tests",
  "codex.serenaOverride":
    '{command="serena-mock",args=["--project","/tmp/mock"],optional=true}',
  "message.style": "conventional",
};

const logEntries: string[] = [];
const fallbackEvents: unknown[] = [];
const recordedArtifacts: any[] = [];

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

function queueDefaultCommit(
  mock: ReturnType<typeof createCodexCliMock>,
) {
  mock.queueHandler((io: any, request: CodexCliRequest) => {
    const journal = request?.payload?.context?.journal ?? {};
    const entries = Array.isArray(journal.current)
      ? journal.current.map((entry: any) =>
          typeof entry === "string" ? entry : (entry?.message ?? ""),
        )
      : [];
    io.respond(
      [
        { type: "log", message: `commit entries=${entries.length}` },
        {
          type: "result",
          payload: { message: `Commit: ${entries.join(", ")}` },
        },
      ],
      { exitCode: 0 },
    );
  });
}

function queueDefaultFix(
  mock: ReturnType<typeof createCodexCliMock>,
) {
  mock.queueHandler((io: any, request: CodexCliRequest) => {
    const context = request?.payload?.context ?? {};
    const filePath = context.filePath ?? "unknown";
    const errorMessage = context.errorMessage ?? "failure";
    const diff = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@",
      `-${errorMessage}`,
      "+fixed",
    ].join("\n");
    io.respond(
      [
        { type: "reasoning", message: `fixing ${filePath}` },
        {
          type: "result",
          payload: {
            diff,
            meta: { producedBy: "codex-test", step: context.step },
          },
        },
      ],
      { exitCode: 0 },
    );
  });
}

function assertSingleLog(
  substring: string,
  startIndex: number,
): void {
  const slice = logEntries.slice(startIndex);
  const matches = slice.filter((line) => line.includes(substring));
  assert.equal(
    matches.length,
    1,
    `Expected exactly one log containing "${substring}" after index ${startIndex}, found ${matches.length}`,
  );
}

async function main(): Promise<void> {
  const cliMock = createCodexCliMock();
  const originalLoad = (Module as any)._load;
  cliMock.install((request: string) => {
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
    return undefined;
  });

  try {
    const codexModule = await import(
      path.resolve(__dirname, "../dist/codex.js")
    );
    const {
      generateCommitMessage,
      generateFix,
      onCodexOfflineFallback,
    } = codexModule;

    const fallbackSubscription = onCodexOfflineFallback(
      (event: unknown) => fallbackEvents.push(event),
    );
    const codexOptions = {
      recordArtifact: async (artifact: any) => {
        recordedArtifacts.push(artifact);
      },
    };

    queueDefaultCommit(cliMock);
    const commitLogStart = logEntries.length;
    const message = await generateCommitMessage(
      {
        current: [
          { message: "feat: add tests", file: "src/index.ts" },
        ],
        meta: {},
      },
      codexOptions,
    );
    assert.equal(message, "Commit: feat: add tests");
    assert.equal(cliMock.requests.length >= 1, true);
    assert.equal(
      cliMock.requests[0]?.payload?.schema,
      "codex-cli-commit.v1",
    );
    assert.match(
      cliMock.requests[0]?.payload?.prompt ?? "",
      /schema codex-cli-commit\.v1/,
    );
    assert.equal(recordedArtifacts[0].kind, "commit");
    assert.equal(
      recordedArtifacts[0].schemaId,
      "codex-cli-commit.v1",
    );
    assert.ok(Array.isArray(recordedArtifacts[0].rawEvents));
    assertSingleLog("[Codex] exec commit", commitLogStart);
    assertSingleLog("commit entries=1", commitLogStart);

    queueDefaultFix(cliMock);
    const fixLogStart = logEntries.length;
    const patch = await generateFix(
      {
        filePath: "src/app.ts",
        errorMessage: "lint failure",
        step: "tests",
      },
      codexOptions,
    );
    assert.equal(patch.kind, "unified-diff");
    assert.match(patch.diff, /--- a\/src\/app.ts/);
    assert.equal(patch.meta?.producedBy, "codex-test");
    assert.equal(patch.meta?.step, "tests");
    assert.equal(recordedArtifacts[1].kind, "fix");
    assert.equal(recordedArtifacts[1].schemaId, "codex-cli-fix.v1");
    assert.equal(recordedArtifacts[1].context.step, "tests");
    assertSingleLog("[Codex] exec fix", fixLogStart);
    assertSingleLog("fixing src/app.ts", fixLogStart);

    cliMock.queueHandler((io: any, request: CodexCliRequest) => {
      const context = request.payload?.context ?? {};
      const diff = [
        "--- /dev/null",
        `+++ b/${context.filePath}`,
        "@@",
        `+${context.errorMessage}`,
      ].join("\n");
      io.respond(
        [
          { type: "log", message: "creating file" },
          {
            type: "result",
            payload: {
              diff,
              meta: { producedBy: "codex-test", step: context.step },
            },
          },
        ],
        { exitCode: 0 },
      );
    });

    const createLogStart = logEntries.length;
    const createPatch = await generateFix(
      {
        filePath: "src/new-file.ts",
        errorMessage: "missing file",
        step: "format",
      },
      codexOptions,
    );
    assert.match(createPatch.diff, /--- \/dev\/null/);
    assert.match(createPatch.diff, /\+\+\+ b\/src\/new-file.ts/);
    assertSingleLog("[Codex] exec fix", createLogStart);
    assertSingleLog("creating file", createLogStart);

    cliMock.queueHandler((io: any, request: CodexCliRequest) => {
      const context = request.payload?.context ?? {};
      const diff = [
        `--- a/${context.filePath}`,
        "+++ /dev/null",
        "@@",
        `-${context.errorMessage}`,
        "-fixed",
      ].join("\n");
      io.respond([{ type: "result", payload: { diff } }]);
    });

    const deletePatch = await generateFix(
      { filePath: "src/old-file.ts", errorMessage: "remove file" },
      codexOptions,
    );
    assert.match(deletePatch.diff, /\+\+\+ \/dev\/null/);

    cliMock.queueHandler((io: any) => {
      io.respond([
        {
          type: "result",
          payload: {
            diff: "--- a/../secret\n+++ b/../secret\n@@\n-test\n+test",
          },
        },
      ]);
    });

    let invalidDiffThrown = false;
    try {
      await generateFix(
        {
          filePath: "src/app.ts",
          errorMessage: "lint failure",
          step: "format",
        },
        codexOptions,
      );
    } catch (err) {
      invalidDiffThrown = true;
      assert.match(
        (err as Error).message,
        /parent directory traversals/,
      );
    }
    assert.equal(invalidDiffThrown, true);

    cliMock.queueError("authentication required");

    let failureCaught = false;
    const priorFallbacks = fallbackEvents.length;
    const authLogStart = logEntries.length;
    try {
      await generateCommitMessage(
        {
          current: [
            { message: "feat: failure", file: "src/index.ts" },
          ],
          meta: {},
        },
        codexOptions,
      );
    } catch (error) {
      failureCaught = true;
      assert.match(
        (error as Error).message,
        /authentication required/,
      );
    }
    assert.equal(failureCaught, true);
    assert.equal(fallbackEvents.length, priorFallbacks + 1);
    const fallbackEvent = fallbackEvents.at(-1) as { reason: string };
    assert.equal(fallbackEvent.reason, "network");
    assert(
      logEntries.some((entry) =>
        entry.includes("authentication required"),
      ),
    );
    assertSingleLog("[Codex] exec commit", authLogStart);

    cliMock.queueMissingBinary();
    const missingPriorFallbacks = fallbackEvents.length;
    let missingCaught = false;
    const missingLogStart = logEntries.length;
    try {
      await generateCommitMessage(
        {
          current: [
            { message: "feat: missing", file: "src/index.ts" },
          ],
          meta: {},
        },
        codexOptions,
      );
    } catch (error) {
      missingCaught = true;
      assert.match(
        (error as Error).message,
        /binary "mock-codex" was not found/,
      );
    }
    assert.equal(missingCaught, true);
    assert.equal(fallbackEvents.length, missingPriorFallbacks + 1);
    assert(
      logEntries.some((entry) => entry.includes("Install the CLI")),
    );
    assertSingleLog("[Codex] exec commit", missingLogStart);

    cliMock.queueHandler((io: any) => {
      io.respond([
        {
          type: "result",
          payload: { meta: { producedBy: "codex-test" } },
        },
      ]);
    });

    let schemaFailureCaught = false;
    const schemaPriorFallbacks = fallbackEvents.length;
    const schemaLogStart = logEntries.length;
    try {
      await generateCommitMessage(
        {
          current: [
            {
              message: "feat: invalid schema",
              file: "src/index.ts",
            },
          ],
          meta: {},
        },
        codexOptions,
      );
    } catch (error) {
      schemaFailureCaught = true;
      assert.match((error as Error).message, /codex-cli-commit\.v1/);
      assert.match((error as Error).message, /response\.message/);
    }
    assert.equal(schemaFailureCaught, true);
    assert.equal(fallbackEvents.length, schemaPriorFallbacks + 1);
    const lastArtifact = recordedArtifacts.at(-1);
    assert.equal(lastArtifact.kind, "commit");
    assert.equal(
      lastArtifact.error?.issues?.[0]?.path,
      "response.message",
    );
    assertSingleLog("[Codex] exec commit", schemaLogStart);

    fallbackSubscription.dispose();

    assert.equal(cliMock.spawnInvocations.length >= 3, true);
    const firstInvocation = cliMock.spawnInvocations[0];
    assert.equal(firstInvocation.command, "mock-codex");
    assert(firstInvocation.args.includes("--json"));
    assert(firstInvocation.args.includes("--sandbox"));
    assert(firstInvocation.args.includes("workspace-write"));
    assert(firstInvocation.args.includes("--profile"));
    assert(firstInvocation.args.includes("tests"));
    assert(
      firstInvocation.args.includes(
        'mcp_servers.serena={command="serena-mock",args=["--project","/tmp/mock"],optional=true}',
      ),
    );
    assert.deepEqual(firstInvocation.args.slice(-2), [
      "-c",
      'reasoning.level="medium"',
    ]);
    assert(logEntries.length > 0);

    console.info("Codex client tests passed");
  } finally {
    cliMock.uninstall();
    (Module as any)._load = originalLoad;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
