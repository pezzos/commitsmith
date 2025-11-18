#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_DIR = path.resolve(__dirname, "../docs/vscode/src/vs/platform/theme");
const OUTPUT_FILE = path.resolve(__dirname, "../media/theme-tokens.json");

const registerColorRegex = /registerColor\(\s*['"]([^'"\\]+)['"]/g;

function toCssVariableName(token) {
  const normalized = token.replace(/\./g, "-");
  return `--vscode-${normalized}`;
}

function walk(dir, visitor) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visitor);
    } else if (entry.isFile()) {
      visitor(full);
    }
  }
}

const tokens = new Set();

walk(SOURCE_DIR, (file) => {
  if (!file.endsWith(".ts")) {
    return;
  }
  const contents = fs.readFileSync(file, "utf8");
  let match;
  while ((match = registerColorRegex.exec(contents))) {
    tokens.add(toCssVariableName(match[1]));
  }
});

const sorted = Array.from(tokens).sort();
const json = JSON.stringify(sorted, null, 2) + "\n";
fs.writeFileSync(OUTPUT_FILE, json, "utf8");
console.log(`Extracted ${sorted.length} theme tokens to ${path.relative(process.cwd(), OUTPUT_FILE)}`);
