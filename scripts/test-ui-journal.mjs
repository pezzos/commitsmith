#!/usr/bin/env node

import { strict as assert } from "node:assert";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

const {
  ensureJournalEntryHash,
  dedupeJournalEntries,
  applyManualNotesToDraft,
} = await import(path.join(distPath, "ui/panel/journalUtils.js"));

console.info("Running journal utility tests...");

const manualEntryRaw = {
  ts: "2024-01-10T12:00:00Z",
  source: "manual",
  text: "  Added context   ",
};
const hashedManual = ensureJournalEntryHash(manualEntryRaw);
assert.equal(hashedManual.text, "Added context");
assert.ok(hashedManual.hash);

const duplicateHash = ensureJournalEntryHash({
  ts: manualEntryRaw.ts,
  source: manualEntryRaw.source,
  text: manualEntryRaw.text,
});
assert.equal(hashedManual.hash, duplicateHash.hash);

const pipelineEntry = ensureJournalEntryHash({
  ts: "2024-01-09T10:00:00Z",
  source: "pipeline",
  text: "Ran pipeline",
});

const deduped = dedupeJournalEntries([
  hashedManual,
  pipelineEntry,
  hashedManual,
]);
assert.equal(deduped.length, 2);
assert.equal(deduped[0].hash, hashedManual.hash);

const olderNote = ensureJournalEntryHash({
  ts: "2024-01-01T08:00:00Z",
  source: "manual",
  text: "First note",
});
const newerNote = ensureJournalEntryHash({
  ts: "2024-01-02T09:00:00Z",
  source: "manual",
  text: "Second note\nwith newline",
});

const mergedDraft = applyManualNotesToDraft(
  "feat: add workflow",
  [newerNote, olderNote],
  false,
);
assert.equal(
  mergedDraft,
  "feat: add workflow\n\nNotes:\n- First note\n- Second note with newline",
);

const updatedDraft = applyManualNotesToDraft(
  mergedDraft,
  [olderNote],
  false,
);
assert.equal(
  updatedDraft,
  "feat: add workflow\n\nNotes:\n- First note",
);

const optOutDraft = applyManualNotesToDraft(
  updatedDraft,
  [olderNote],
  true,
);
assert.equal(optOutDraft, "feat: add workflow");

console.info("Journal utility tests passed");
