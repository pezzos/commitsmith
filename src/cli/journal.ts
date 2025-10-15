import process from 'node:process';
import { addEntry, initializeJournal, JournalOptions } from '../journal';

function printHelp(): void {
  console.log('Usage: commit-smith journal --append "<entry>"');
  console.log('Appends a new entry to the AI commit journal managed by CommitSmith.');
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

  await initializeJournal(options);
  await addEntry(entry, options);
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
