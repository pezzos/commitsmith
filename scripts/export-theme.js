#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");

const workspacePath = process.cwd();
const cliCandidates = [
  process.env.COMMITSMITH_VSCODE_CLI,
  process.env.VSCODE_CLI,
  process.env.CODE_BIN,
  "code",
].filter(Boolean);

if (cliCandidates.length === 0) {
  console.error(
    "No VS Code CLI binary found. Set COMMITSMITH_VSCODE_CLI or ensure `code` is on your PATH.",
  );
  process.exit(1);
}

async function main() {
  for (const command of cliCandidates) {
    if (await supportsCommandOption(command)) {
      const exitCode = await launchCli(command, true);
      if (exitCode === 0) {
        process.exit(0);
        return;
      }
      console.warn(
        `VS Code CLI '${command}' exited with code ${exitCode}. Trying next candidate...`,
      );
    }
  }

  const fallback = cliCandidates[0];
  const exitCode = await launchCli(fallback, false);
  if (exitCode !== 0) {
    console.error(
      "Unable to trigger the CommitSmith theme export automatically. Run 'CommitSmith: Export Theme Snapshot' inside VS Code.",
    );
  }
  process.exit(exitCode);
}

function supportsCommandOption(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--help"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", () => resolve(false));
    child.on("close", () => {
      resolve(output.includes("--command"));
    });
  });
}

function launchCli(command, useCommand) {
  return new Promise((resolve) => {
    const args = ["--reuse-window"];
    const env = { ...process.env };
    if (useCommand) {
      args.push("--command", "commitSmith.exportTheme", workspacePath);
      console.log(
        `Launching '${command}' to run CommitSmith theme export command...`,
      );
    } else {
      env.COMMITSMITH_AUTO_EXPORT_THEME = "1";
      args.push(workspacePath);
      console.log(
        `'${command}' does not support --command. Launching workspace with auto-export fallback...`,
      );
      console.log(
        "If the snapshot does not update automatically, run 'CommitSmith: Export Theme Snapshot' inside VS Code.",
      );
    }
    const child = spawn(command, args, {
      stdio: "inherit",
      env,
    });
    child.on("error", (error) => {
      console.error(
        `Failed to launch VS Code CLI (${command}): ${error.message}`,
      );
      resolve(1);
    });
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
