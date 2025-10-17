#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");
const journalModule = await import(path.join(distPath, "journal.js"));
const cliModule = await import(path.join(distPath, "cli/journal.js"));

const {
  initializeJournal,
  readJournal,
  addEntry,
  clearCurrent,
  getJournalPath,
} = journalModule;
const { runCli } = cliModule;

const tmpDir = await mkdtemp(
  path.join(os.tmpdir(), "commit-smith-journal-"),
);

await initializeJournal({ root: tmpDir });

let journal = await readJournal({ root: tmpDir });
assert.deepEqual(journal.current, []);
assert.deepEqual(journal.meta, {});

await addEntry("feat: first entry", { root: tmpDir });
journal = await readJournal({ root: tmpDir });
assert.equal(journal.current.length, 1);
assert.equal(journal.current[0], "feat: first entry");

await clearCurrent({ root: tmpDir });
journal = await readJournal({ root: tmpDir });
assert.deepEqual(journal.current, []);

const journalPath = getJournalPath({ root: tmpDir });
const invalidYaml = "current: 123";
await writeFile(journalPath, invalidYaml, "utf8");

let validationFailed = false;
try {
  await readJournal({ root: tmpDir });
} catch (error) {
  validationFailed = true;
  assert.match(error.message, /validation failed/i);
}

assert.equal(validationFailed, true);

// Restore valid journal for cleanliness
await initializeJournal({ root: tmpDir });

await runCli(
  [
    "journal",
    "--append",
    "chore: add meta sample",
    "--meta",
    "ticketFromBranch=true",
    "--meta",
    "attempts=3",
    "--meta",
    "scope=operations",
  ],
  { root: tmpDir },
);

journal = await readJournal({ root: tmpDir });
assert.equal(
  journal.current[journal.current.length - 1],
  "chore: add meta sample",
);
assert.equal(journal.meta?.ticketFromBranch, true);
assert.equal(journal.meta?.attempts, 3);
assert.equal(journal.meta?.scope, "operations");
assert.equal(typeof journal.meta?.attempts, "number");
assert.equal(typeof journal.meta?.ticketFromBranch, "boolean");

console.info("Journal tests passed");
