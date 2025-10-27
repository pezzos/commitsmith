import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import Ajv, { ValidateFunction } from "ajv";

export interface JournalEntry {
  readonly file?: string;
  readonly message: string;
  readonly ts?: string;
  readonly source?: "codex" | "pipeline" | "manual";
  readonly metadata?: Record<string, unknown>;
}

export interface JournalMeta {
  readonly ticketFromBranch?: boolean;
  readonly scope?: string;
  readonly style?: string;
  readonly ticket?: string;
  readonly [key: string]: unknown;
}

export interface JournalData {
  current: JournalEntry[];
  meta?: JournalMeta;
}

export interface JournalOptions {
  readonly root?: string;
  readonly createIfMissing?: boolean;
}

export interface JournalMetaUpdate {
  readonly [key: string]: unknown;
}

const JOURNAL_FILENAME = ".ai-commit-journal.yml";
const DEFAULT_JOURNAL: JournalData = { current: [], meta: {} };

let validator: ValidateFunction<JournalData> | undefined;

export function getJournalPath(options?: JournalOptions): string {
  const root = options?.root ?? process.cwd();
  return path.resolve(root, JOURNAL_FILENAME);
}

export async function initializeJournal(
  options?: JournalOptions,
): Promise<void> {
  const journalPath = getJournalPath(options);
  try {
    await fs.access(journalPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      if (options?.createIfMissing === false) {
        return;
      }
      await writeJournal(DEFAULT_JOURNAL, journalPath);
      return;
    }
    throw error;
  }

  try {
    await readJournal({ ...options, createIfMissing: false });
  } catch (error) {
    if (options?.createIfMissing === false) {
      throw new Error(
        `Existing journal failed validation: ${(error as Error).message}`,
      );
    }

    const reason =
      error instanceof Error ? error.message : String(error);
    logJournalWarning(
      `Existing journal invalid; resetting (reason: ${reason})`,
    );
    await writeJournal(DEFAULT_JOURNAL, journalPath);
  }
}

export async function readJournal(
  options?: JournalOptions,
): Promise<JournalData> {
  const createIfMissing = options?.createIfMissing ?? true;
  if (createIfMissing) {
    await initializeJournal(options);
  }
  const journalPath = getJournalPath(options);
  if (!createIfMissing) {
    try {
      await fs.access(journalPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return { current: [], meta: {} };
      }
      throw error;
    }
  }

  let rawContent: string;
  try {
    rawContent = await fs.readFile(journalPath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read journal at ${journalPath}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(rawContent) ?? {};
  } catch (error) {
    throw new Error(
      `Journal file contains invalid YAML: ${(error as Error).message}`,
    );
  }

  const schemaValidator = getValidator();
  if (!schemaValidator(parsed)) {
    const issues = schemaValidator.errors
      ?.map(
        (entry) => `${entry.instancePath || "/"} ${entry.message}`,
      )
      .join(", ");
    throw new Error(
      `Journal schema validation failed${issues ? `: ${issues}` : ""}`,
    );
  }

  const parsedCurrent = Array.isArray(
    (parsed as { current?: unknown }).current,
  )
    ? ((parsed as { current?: unknown }).current as unknown[])
    : [];
  const currentEntries = normalizeJournalEntries(parsedCurrent);

  return {
    current: currentEntries,
    meta: sanitizeMeta((parsed as { meta?: unknown }).meta),
  };
}

export async function addEntry(
  entry: string | JournalEntry,
  options?: JournalOptions,
): Promise<void> {
  const journalPath = getJournalPath(options);
  const journal = await readJournal(options);
  const normalized = normalizeEntry(entry);
  if (!normalized) {
    throw new Error(
      "Journal entry must include a non-empty message.",
    );
  }
  journal.current = [...journal.current, normalized];
  await writeJournal(journal, journalPath);
}

export async function updateJournalMeta(
  metaUpdates: JournalMetaUpdate,
  options?: JournalOptions,
): Promise<void> {
  const keys = Object.keys(metaUpdates);
  if (keys.length === 0) {
    return;
  }

  const journalPath = getJournalPath(options);
  const journal = await readJournal(options);
  const currentMeta = sanitizeMeta(journal.meta);
  const merged = { ...currentMeta } as Record<string, unknown>;
  for (const key of keys) {
    merged[key] = metaUpdates[key];
  }
  journal.meta = merged as JournalMeta;
  await writeJournal(journal, journalPath);
}

export async function clearCurrent(
  options?: JournalOptions,
): Promise<void> {
  const journalPath = getJournalPath(options);
  const journal = await readJournal(options);
  journal.current = [];
  await writeJournal(journal, journalPath);
}

async function writeJournal(
  data: JournalData,
  journalPath: string,
): Promise<void> {
  const payload: JournalData = {
    current: serializeEntries(data.current),
    meta: sanitizeMeta(data.meta),
  };

  const schemaValidator = getValidator();
  if (!schemaValidator(payload)) {
    const issues = schemaValidator.errors
      ?.map(
        (entry) => `${entry.instancePath || "/"} ${entry.message}`,
      )
      .join(", ");
    throw new Error(
      `Cannot write invalid journal payload${issues ? `: ${issues}` : ""}`,
    );
  }

  const serialized = YAML.stringify(payload);
  await fs.writeFile(journalPath, serialized, "utf8");
}

function normalizeEntry(entry: unknown): JournalEntry | undefined {
  if (typeof entry === "string") {
    const message = entry.trim();
    if (message.length === 0) {
      return undefined;
    }
    return { message };
  }

  if (!entry || typeof entry !== "object") {
    return undefined;
  }

  const rawMessage = (entry as { message?: unknown }).message;
  const rawFile = (entry as { file?: unknown }).file;
  const rawTs = (entry as { ts?: unknown }).ts;
  const rawSource = (entry as { source?: unknown }).source;
  const rawMetadata = (entry as { metadata?: unknown }).metadata;
  if (typeof rawMessage !== "string") {
    return undefined;
  }
  const message = rawMessage.trim();
  if (message.length === 0) {
    return undefined;
  }

  const file =
    typeof rawFile === "string" && rawFile.trim().length > 0
      ? rawFile.trim()
      : undefined;

  const ts =
    typeof rawTs === "string" && rawTs.trim().length > 0
      ? rawTs.trim()
      : undefined;
  const source =
    rawSource === "codex" ||
    rawSource === "pipeline" ||
    rawSource === "manual"
      ? rawSource
      : undefined;
  const metadata =
    rawMetadata && typeof rawMetadata === "object"
      ? { ...(rawMetadata as Record<string, unknown>) }
      : undefined;

  return {
    message,
    ...(file ? { file } : {}),
    ...(ts ? { ts } : {}),
    ...(source ? { source } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeJournalEntries(entries: unknown[]): JournalEntry[] {
  const result: JournalEntry[] = [];
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}

function serializeEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is JournalEntry => Boolean(entry));
}

function sanitizeMeta(meta: unknown): JournalMeta | undefined {
  if (!meta || typeof meta !== "object") {
    return {};
  }
  return { ...(meta as Record<string, unknown>) };
}

function logJournalWarning(message: string): void {
  const formatted = `[CommitSmith][journal] ${message}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- dynamic require avoids VS Code dependency in tests
    const outputModule =
      require("./output") as typeof import("./output");
    outputModule.getOutputChannel().appendLine(formatted);
  } catch {
    console.warn(formatted);
  }
}

function getValidator(): ValidateFunction<JournalData> {
  if (!validator) {
    validator = createValidator();
  }
  return validator;
}

function createValidator(): ValidateFunction<JournalData> {
  const schemaPath = path.resolve(
    __dirname,
    "..",
    "assets",
    "schema",
    "ai-commit-journal.schema.json",
  );
  let schema: unknown;
  try {
    const schemaContent = readFileSync(schemaPath, "utf8");
    schema = JSON.parse(schemaContent);
  } catch (error) {
    throw new Error(
      `Unable to read journal schema: ${(error as Error).message}`,
    );
  }

  const ajv = new Ajv({ allErrors: true, useDefaults: true });
  return ajv.compile<JournalData>(schema as any);
}
