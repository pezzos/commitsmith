import { promises as fs } from 'node:fs';
import path from 'node:path';

const JOURNAL_WORKFLOW_HEADING = '## CommitSmith Journal Workflow';
const JOURNAL_WORKFLOW_SLUG = 'commitsmith-journal-workflow';

export interface AgentsGuidanceResult {
  readonly changed: boolean;
  readonly message: string;
}

export function hasJournalWorkflowSection(contents: string): boolean {
  const headingRegex = /^##\s+CommitSmith Journal Workflow\s*$/m;
  return headingRegex.test(contents);
}

export async function ensureJournalWorkflowSection(root: string): Promise<AgentsGuidanceResult> {
  const agentsPath = path.join(root, 'AGENTS.md');

  let contents = '';
  try {
    contents = await fs.readFile(agentsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (hasJournalWorkflowSection(contents)) {
    return {
      changed: false,
      message: 'Journal workflow guidance already present in AGENTS.md.'
    };
  }

  const sectionLines = [
    JOURNAL_WORKFLOW_HEADING,
    `<!-- slug: ${JOURNAL_WORKFLOW_SLUG} -->`,
    '',
    'CommitSmith relies on `.ai-commit-journal.yml` to store Codex-authored change summaries. Run the initializer command `CommitSmith: Initialize Repository` (`commitSmith.initializeRepo`) when you first open or reset a repository so the journal, ignore rules, and guidance stay in sync.',
    '',
    'Codex appends journal entries via the CLI:',
    '```bash',
    'codex journal --append "feat: add payment retries"',
    '```',
    '',
    'Re-run the initializer whenever `.ai-commit-journal.yml`, the ignore rules, or this guidance is lost — for example after deleting workspace files or recloning the repository.',
    ''
  ];

  const prefix = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
  const separator = contents.trim().length > 0 ? '\n\n' : '';
  let updated = contents;
  if (prefix) {
    updated += prefix;
  }
  if (separator) {
    updated += separator;
  }
  updated += sectionLines.join('\n');
  if (!updated.endsWith('\n')) {
    updated += '\n';
  }

  await fs.writeFile(agentsPath, updated, 'utf8');

  return {
    changed: true,
    message: 'Added CommitSmith journal workflow guidance to AGENTS.md.'
  };
}

export const AgentsGuidance = {
  JOURNAL_WORKFLOW_HEADING,
  JOURNAL_WORKFLOW_SLUG,
  ensureJournalWorkflowSection,
  hasJournalWorkflowSection
};
