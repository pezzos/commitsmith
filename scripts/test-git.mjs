#!/usr/bin/env node

import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * @typedef {{
 *   repo?: string;
 *   action: string;
 *   files?: unknown;
 *   message?: string;
 *   value?: string;
 * }} StubLog
 */

/** @type {StubLog[]} */
const stubLogs = [];

const repo1 = createStubRepository("repo-1");
const repo2 = createStubRepository("repo-2");

/** @type {ReturnType<typeof createStubRepository> | undefined} */
let activeRepository = repo2;
/** @type {ReturnType<typeof createStubRepository>[]} */
let repositories = [repo1, repo2];

const originalLoad = Module._load;
Module._load = /** @type {typeof Module._load} */ (
  function mockedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return {
        extensions: {
          getExtension: () => ({
            isActive: true,
            exports: {
              getAPI: () => ({ repositories, activeRepository }),
            },
            activate: async () => {},
          }),
        },
        window: {
          createOutputChannel() {
            return {
              appendLine(value) {
                stubLogs.push({ action: "log", value });
              },
            };
          },
          async showWarningMessage() {
            return undefined;
          },
          async showErrorMessage() {
            return undefined;
          },
          async showInformationMessage() {
            return undefined;
          },
        },
        workspace: {
          workspaceFolders: [
            { uri: { fsPath: "/fake/repo-1" } },
            { uri: { fsPath: "/fake/repo-2" } },
          ],
        },
        Uri: {
          file(fsPath) {
            return { fsPath };
          },
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  }
);

try {
  const moduleUrl = pathToFileURL(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../dist/utils/git.js",
    ),
  ).href;

  const gitModule = await import(moduleUrl);
  const git = /** @type {{
   *  getRepo: Function;
   *  stageModified: Function;
   *  commit: Function;
   *  push: Function;
   *  __setGitResolutionForTests?: Function;
   * }} */ (gitModule.default ?? gitModule);

  git.__setGitResolutionForTests?.(50, 5);

  const repo = await git.getRepo();
  assert.equal(repo.rootUri.fsPath, "/fake/repo-2");

  await git.stageModified(repo);
  await git.stageModified(repo, ["fileA.ts"]);
  await git.commit(repo, "feat: add stub");
  await git.push(repo);

  const repo2Actions = stubLogs
    .filter((entry) => entry.repo === "repo-2")
    .map((entry) => entry.action);
  assert.deepEqual(repo2Actions, ["addDot", "add", "commit", "push"]);

  const stageAllCall = stubLogs.find(
    (entry) => entry.repo === "repo-2" && entry.action === "addDot",
  );
  assert.ok(
    stageAllCall,
    "Expected stageModified to stage all files when no list provided",
  );

  const selectiveAdd = stubLogs.find(
    (entry) =>
      entry.repo === "repo-2" &&
      entry.action === "add" &&
      Array.isArray(entry.files) &&
      entry.files.length === 1,
  );
  assert.ok(selectiveAdd);
  const firstFile = /** @type {{ fsPath: string }[]} */ (
    selectiveAdd?.files
  )[0];
  assert.equal(firstFile.fsPath, "/fake/repo-2/fileA.ts");

  activeRepository = undefined;
  repositories = [];

  let noRepoError = false;
  try {
    await git.getRepo();
  } catch (error) {
    noRepoError = true;
    assert.match(
      /** @type {Error} */ (error).message,
      /CommitSmith needs an initialized Git repository/i,
    );
  }
  assert.equal(
    noRepoError,
    true,
    "Expected getRepo to fail when no Git repositories are available",
  );

  console.info("Git util tests passed");
} finally {
  Module._load = originalLoad;
}

function createStubRepository(name) {
  return {
    rootUri: { fsPath: `/fake/${name}` },
    async add(files) {
      stubLogs.push({ repo: name, action: "add", files });
    },
    async addDot() {
      stubLogs.push({ repo: name, action: "addDot" });
    },
    async commit(message) {
      stubLogs.push({ repo: name, action: "commit", message });
    },
    async push() {
      stubLogs.push({ repo: name, action: "push" });
    },
  };
}
