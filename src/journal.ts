import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv, { ValidateFunction } from 'ajv';

export interface JournalMeta {
  readonly ticketFromBranch?: boolean;
  readonly scope?: string;
  readonly style?: string;
  readonly ticket?: string;
  readonly [key: string]: unknown;
}

export interface JournalData {
  current: string[];
  meta?: JournalMeta;
}

export interface JournalOptions {
  readonly root?: string;
  readonly createIfMissing?: boolean;
}

export interface JournalMetaUpdate {
  readonly [key: string]: unknown;
}

const JOURNAL_FILENAME = '.ai-commit-journal.yml';
const DEFAULT_JOURNAL: JournalData = { current: [], meta: {} };

let validator: ValidateFunction<JournalData> | undefined;

export function getJournalPath(options?: JournalOptions): string {
  const root = options?.root ?? process.cwd();
  return path.resolve(root, JOURNAL_FILENAME);
}

export async function initializeJournal(options?: JournalOptions): Promise<void> {
  const journalPath = getJournalPath(options);
  try {
    await fs.access(journalPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
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
    throw new Error(`Existing journal failed validation: ${(error as Error).message}`);
  }
}

export async function readJournal(options?: JournalOptions): Promise<JournalData> {
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
      if (nodeError.code === 'ENOENT') {
        return { current: [], meta: {} };
      }
      throw error;
    }
  }

  let rawContent: string;
  try {
    rawContent = await fs.readFile(journalPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read journal at ${journalPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(rawContent) ?? {};
  } catch (error) {
    throw new Error(`Journal file contains invalid YAML: ${(error as Error).message}`);
  }

  const schemaValidator = getValidator();
  if (!schemaValidator(parsed)) {
    const issues = schemaValidator.errors?.map((entry) => `${entry.instancePath || '/'} ${entry.message}`).join(', ');
    throw new Error(`Journal schema validation failed${issues ? `: ${issues}` : ''}`);
  }

  const data: JournalData = {
    current: Array.isArray(parsed.current) ? [...parsed.current] : [],
    meta: sanitizeMeta(parsed.meta)
  };

  return data;
}

export async function addEntry(entry: string, options?: JournalOptions): Promise<void> {
  if (!entry || !entry.trim()) {
    throw new Error('Journal entry text must be a non-empty string.');
  }

  const journalPath = getJournalPath(options);
  const journal = await readJournal(options);
  journal.current.push(entry.trim());
  await writeJournal(journal, journalPath);
}

export async function updateJournalMeta(metaUpdates: JournalMetaUpdate, options?: JournalOptions): Promise<void> {
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

export async function clearCurrent(options?: JournalOptions): Promise<void> {
  const journalPath = getJournalPath(options);
  const journal = await readJournal(options);
  journal.current = [];
  await writeJournal(journal, journalPath);
}

async function writeJournal(data: JournalData, journalPath: string): Promise<void> {
  const payload: JournalData = {
    current: [...data.current],
    meta: sanitizeMeta(data.meta)
  };

  const schemaValidator = getValidator();
  if (!schemaValidator(payload)) {
    const issues = schemaValidator.errors?.map((entry) => `${entry.instancePath || '/'} ${entry.message}`).join(', ');
    throw new Error(`Cannot write invalid journal payload${issues ? `: ${issues}` : ''}`);
  }

  const serialized = YAML.stringify(payload);
  await fs.writeFile(journalPath, serialized, 'utf8');
}

function sanitizeMeta(meta: unknown): JournalMeta | undefined {
  if (!meta || typeof meta !== 'object') {
    return {};
  }
  return { ...(meta as Record<string, unknown>) };
}

function getValidator(): ValidateFunction<JournalData> {
  if (!validator) {
    validator = createValidator();
  }
  return validator;
}

function createValidator(): ValidateFunction<JournalData> {
  const schemaPath = path.resolve(__dirname, '..', 'assets', 'schema', 'ai-commit-journal.schema.json');
  let schema: unknown;
  try {
    const schemaContent = readFileSync(schemaPath, 'utf8');
    schema = JSON.parse(schemaContent);
  } catch (error) {
    throw new Error(`Unable to read journal schema: ${(error as Error).message}`);
  }

  const ajv = new Ajv({ allErrors: true, useDefaults: true });
  return ajv.compile<JournalData>(schema as any);
}
