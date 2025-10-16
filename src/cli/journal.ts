import process from 'node:process';
import { addEntry, initializeJournal, JournalOptions, updateJournalMeta } from '../journal';

function printHelp(): void {
  console.log('Usage: commit-smith journal --append "<entry>" [--meta key=value ...]');
  console.log('Appends a new entry to the AI commit journal managed by CommitSmith and optionally updates metadata.');
}

async function handleJournalCommand(args: string[], options?: JournalOptions): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const appendIndex = args.indexOf('--append');
  if (appendIndex === -1) {
    throw new Error('Missing --append argument.');
  }

  const entry = args[appendIndex + 1];
  if (!entry) {
    throw new Error('No journal entry provided after --append.');
  }

  const metaUpdates = parseMetaUpdates(args);

  await initializeJournal(options);
  await addEntry(entry, options);
  if (Object.keys(metaUpdates).length > 0) {
    await updateJournalMeta(metaUpdates, options);
  }
  console.log('✔ Appended entry to .ai-commit-journal.yml');
}

export async function runCli(argv = process.argv.slice(2), options?: JournalOptions): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }

  const [command, ...rest] = argv;
  if (command !== 'journal') {
    throw new Error(`Unknown command: ${command}`);
  }

  await handleJournalCommand(rest, options);
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`CommitSmith CLI failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}

function parseMetaUpdates(args: string[]): Record<string, unknown> {
  const metaEntries: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--meta') {
      continue;
    }
    const value = args[i + 1];
    if (!value) {
      throw new Error('Missing key=value payload after --meta.');
    }
    const separatorIndex = value.indexOf('=');
    if (separatorIndex === -1) {
      throw new Error('Meta updates must be provided as key=value.');
    }
    const key = value.slice(0, separatorIndex).trim();
    const raw = value.slice(separatorIndex + 1);
    if (!key) {
      throw new Error('Meta key must be a non-empty string.');
    }
    metaEntries[key] = raw;
  }
  return metaEntries;
}
