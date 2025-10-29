import { createHash } from "crypto";

import type { JournalEntry } from "../../shared/types";

export const JOURNAL_PAGE_SIZE = 50;

export type JournalEntryWithHash = JournalEntry & {
  readonly hash: string;
};

export function ensureJournalEntryHash(
  entry: JournalEntry,
): JournalEntryWithHash {
  const normalizedText =
    typeof entry.text === "string" ? entry.text.trim() : "";
  const normalizedMessage =
    typeof entry.message === "string"
      ? entry.message.trim()
      : undefined;
  const normalizedSource =
    entry.source === "pipeline" || entry.source === "manual"
      ? entry.source
      : "codex";
  const normalizedMetadata =
    entry.metadata && typeof entry.metadata === "object"
      ? { ...entry.metadata }
      : undefined;
  const normalizedTs =
    typeof entry.ts === "string" && entry.ts.length > 0
      ? entry.ts
      : undefined;
  const base: JournalEntry = {
    ...entry,
    source: normalizedSource,
    text: normalizedText,
    ...(normalizedMessage ? { message: normalizedMessage } : {}),
    ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}),
    ...(normalizedTs ? { ts: normalizedTs } : {}),
  };
  const existingHash =
    typeof entry.hash === "string" && entry.hash.length > 0
      ? entry.hash
      : undefined;
  const hash = existingHash ?? computeJournalEntryHash(base);
  return { ...base, hash };
}

export function computeJournalEntryHash(entry: JournalEntry): string {
  const payload = {
    source: entry.source,
    ts: entry.ts ?? "",
    text: entry.text,
    message: entry.message ?? "",
    metadata: canonicalize(entry.metadata ?? null),
  };
  return createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function dedupeJournalEntries(
  entries: readonly JournalEntryWithHash[],
): JournalEntryWithHash[] {
  const map = new Map<string, JournalEntryWithHash>();
  for (const entry of entries) {
    if (!map.has(entry.hash)) {
      map.set(entry.hash, entry);
    }
  }
  return sortJournalEntries(Array.from(map.values()));
}

export function sortJournalEntries(
  entries: readonly JournalEntryWithHash[],
): JournalEntryWithHash[] {
  return [...entries].sort((a, b) => {
    const aTime = safeTimestampMs(a.ts);
    const bTime = safeTimestampMs(b.ts);
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    return a.hash.localeCompare(b.hash);
  });
}

export function applyManualNotesToDraft(
  draft: string,
  notes: readonly JournalEntryWithHash[],
  optOut: boolean,
): string {
  const base = stripManualNotesBlock(draft);
  if (optOut) {
    return base;
  }
  const sanitized = notes
    .slice()
    .sort((a, b) => safeTimestampMs(a.ts) - safeTimestampMs(b.ts))
    .map((entry) => sanitizeManualNote(entry.text))
    .filter((text) => text.length > 0);
  if (sanitized.length === 0) {
    return base;
  }
  const block = [
    "Notes:",
    ...sanitized.map((text) => `- ${text}`),
  ].join("\n");
  if (base.length === 0) {
    return block;
  }
  return `${base}\n\n${block}`;
}

function sanitizeManualNote(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripManualNotesBlock(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  const lines = value.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "Notes:") {
      start = index;
      break;
    }
  }
  if (start === -1) {
    return value.trimEnd();
  }
  let end = start + 1;
  let hasBullet = false;
  while (end < lines.length) {
    const current = lines[end];
    const trimmed = current.trim();
    if (trimmed.startsWith("- ")) {
      hasBullet = true;
      end += 1;
      continue;
    }
    if (trimmed === "") {
      end += 1;
    }
    break;
  }
  if (!hasBullet) {
    return value.trimEnd();
  }
  const before = lines.slice(0, start);
  while (
    before.length > 0 &&
    before[before.length - 1].trim() === ""
  ) {
    before.pop();
  }
  const after = lines.slice(end);
  const remainder = [...before, ...after].join("\n").trimEnd();
  if (remainder.includes("Notes:")) {
    return stripManualNotesBlock(remainder);
  }
  return remainder;
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(
      value as Record<string, unknown>,
    ).sort(([a], [b]) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const [key, v] of entries) {
      normalized[key] = canonicalize(v);
    }
    return normalized;
  }
  return null;
}

function safeTimestampMs(ts: string | undefined): number {
  if (!ts) {
    return 0;
  }
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}
