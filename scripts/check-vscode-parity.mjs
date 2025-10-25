#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVscodeMock } from "./test-utils/mock-vscode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const distDir = path.join(repoRoot, "dist");
const srcDir = path.join(repoRoot, "src");
const ignoredUsagePrefixes = new Set([
  "vscode.MessageItem",
  "vscode.QuickPickItem",
  "vscode.OutputChannel",
]);

async function listFilesByExtension(dir, extensions) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesByExtension(fullPath, extensions)));
    } else if (
      entry.isFile() &&
      extensions.some((ext) => entry.name.endsWith(ext))
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectShimPaths() {
  const { vscode } = createVscodeMock();
  const paths = new Set(["vscode"]);
  const visited = new Set();

  function traverse(value, currentPath) {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    if (visited.has(value)) {
      return;
    }
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      const nextPath = `${currentPath}.${key}`;
      paths.add(nextPath);
      if (typeof child === "object") {
        traverse(child, nextPath);
      }
    }
    if (Array.isArray(value)) {
      for (const method of ["find", "map", "filter"]) {
        paths.add(`${currentPath}.${method}`);
      }
    }
  }

  traverse(vscode, "vscode");
  return paths;
}

async function collectVscodeUsages() {
  const usages = new Set();

  async function scanFile(file, regex) {
    const content = await readFile(file, "utf8");
    const matches = content.matchAll(regex);
    for (const match of matches) {
      const raw = match[0];
      const startIndex = match.index ?? 0;
      const charBefore =
        startIndex > 0 ? content[startIndex - 1] : undefined;
      if (charBefore === "'" || charBefore === '"' || charBefore === "`") {
        continue;
      }
      const lineStart = content.lastIndexOf("\n", startIndex - 1) + 1;
      const beforeSegment = content.slice(lineStart, startIndex);
      const trimmedBefore = beforeSegment.trimEnd();
      const lastTokenMatch = trimmedBefore.match(/(\S+)\s*$/);
      const lastToken = lastTokenMatch ? lastTokenMatch[1] : "";
      const shouldSkipForTypeContext =
        trimmedBefore.endsWith(":") ||
        trimmedBefore.endsWith("<") ||
        ["implements", "extends", "as", "type", "interface"].includes(
          lastToken,
        );
      if (shouldSkipForTypeContext) {
        continue;
      }
      const normalized = raw.replace(/<.*$/, "");
      usages.add(normalized);
    }
  }

  let analyzed = false;
  const tsFiles = await listFilesByExtension(srcDir, [".ts", ".tsx"]);
  if (tsFiles.length > 0) {
    const tsRegex = /vscode(?:\.[A-Za-z0-9_]+)+/g;
    for (const file of tsFiles) {
      await scanFile(file, tsRegex);
    }
    analyzed = true;
  }

  try {
    await stat(distDir);
    const jsFiles = await listFilesByExtension(distDir, [
      ".js",
      ".mjs",
      ".cjs",
    ]);
    const jsRegex = /vscode(?:\.[A-Za-z0-9_]+)+/g;
    for (const file of jsFiles) {
      await scanFile(file, jsRegex);
    }
    analyzed = analyzed || jsFiles.length > 0;
  } catch {
    console.warn(
      "[vscode-shim][warning] dist/ directory missing; parity check falling back to src/ scan only.",
    );
  }

  if (!analyzed) {
    console.warn(
      "[vscode-shim][warning] No source files scanned; ensure src/ or dist/ contains runtime code.",
    );
  }

  return usages;
}

async function main() {
  const shimPaths = collectShimPaths();
  const usedPaths = await collectVscodeUsages();

  const missing = [];
  for (const usage of usedPaths) {
    if (ignoredUsagePrefixes.has(usage)) {
      continue;
    }
    if (!shimPaths.has(usage)) {
      missing.push(usage);
    }
  }

  if (missing.length > 0) {
    console.warn(
      "[vscode-shim][warning] Detected VS Code APIs without shim coverage:",
    );
    for (const path of missing.sort()) {
      console.warn(`  - ${path}`);
    }
    console.warn(
      "[vscode-shim][warning] Update scripts/test-utils/mock-vscode.js and scripts/test-vscode-shim.mjs to cover new APIs.",
    );
  } else if (usedPaths.size > 0) {
    console.log(
      "[vscode-shim] No missing VS Code API usages detected (warning mode).",
    );
  } else {
    console.log(
      "[vscode-shim] No VS Code API usages found in dist/; ensure build artifacts are present.",
    );
  }
}

await main();
