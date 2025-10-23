#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);

function writeRecord(recordPath, data) {
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // best-effort recording; ignore failures
  }
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`${process.env.CODEX_FAKE_VERSION ?? "codex 0.6.0"}\n`);
  process.exit(0);
}

const behavior = process.env.CODEX_FAKE_BEHAVIOR ?? "auto";
const recordPath =
  process.env.CODEX_FAKE_RECORD ??
  path.join(os.tmpdir(), "codex-fake-record.json");

const stdinChunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinChunks.push(chunk);
});

process.stdin.on("error", (error) => {
  writeRecord(recordPath, {
    argv: args,
    error: error.message,
    phase: "stdin-error",
  });
  process.stderr.write(`stdin error: ${error.message}\n`);
  process.exit(1);
});

process.stdin.on("end", () => {
  const rawPayload = stdinChunks.join("");
  let request;
  try {
    request = rawPayload.length > 0 ? JSON.parse(rawPayload) : null;
  } catch (error) {
    request = null;
    process.stderr.write(
      `failed to parse payload: ${
        (error instanceof Error && error.message) || String(error)
      }\n`,
    );
  }

  writeRecord(recordPath, {
    argv: args,
    rawPayload,
    request,
    behavior,
  });

  if (behavior === "fail-no-schema") {
    process.stdout.write(
      `${JSON.stringify({
        type: "result",
        payload: { note: "Missing schema metadata" },
      })}\n`,
    );
    process.exit(0);
    return;
  }

  if (behavior === "exit-error") {
    process.stderr.write("codex-fake instructed to fail\n");
    process.exit(2);
    return;
  }

  const operation = request?.operation ?? "commit";
  const model = request?.model ?? "gpt-5-codex";
  process.stdout.write(
    `${JSON.stringify({
      type: "log",
      message: `codex-fake operation=${operation} model=${model}`,
    })}\n`,
  );

  if (operation === "commit") {
    const entries =
      request?.payload?.context?.journal?.current ??
      request?.payload?.journal?.current ??
      [];
    const firstMessage =
      (Array.isArray(entries) && entries[0]?.message) || "no-entry";
    process.stdout.write(
      `${JSON.stringify({
        type: "result",
        payload: { message: `Commit: ${firstMessage}` },
      })}\n`,
    );
    process.exit(0);
    return;
  }

  if (operation === "fix") {
    const step = request?.payload?.context?.step ?? null;
    const filePath =
      request?.payload?.context?.filePath ?? "src/example.ts";
    process.stdout.write(
      `${JSON.stringify({
        type: "result",
        payload: {
          diff: [
            `--- a/${filePath}`,
            `+++ b/${filePath}`,
            "@@",
            "-console.log('bad');",
            "+console.log('good');",
          ].join("\n"),
          meta: { producedBy: "codex-fake", step },
        },
      })}\n`,
    );
    process.exit(0);
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "error",
      message: `Unsupported operation ${operation}`,
    })}\n`,
  );
  process.exit(1);
});
