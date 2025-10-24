import { promises as fs } from "node:fs";
import path from "node:path";

const JOURNAL_WORKFLOW_HEADING = "## CommitSmith Journal Workflow";
const JOURNAL_WORKFLOW_SLUG = "commitsmith-journal-workflow";

export interface AgentsGuidanceResult {
  readonly changed: boolean;
  readonly message: string;
}

export function hasJournalWorkflowSection(contents: string): boolean {
  const headingRegex = /^##\s+CommitSmith Journal Workflow\s*$/m;
  return headingRegex.test(contents);
}

export async function ensureJournalWorkflowSection(
  root: string,
): Promise<AgentsGuidanceResult> {
  const agentsPath = path.join(root, "AGENTS.md");

  let contents = "";
  try {
    contents = await fs.readFile(agentsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (hasJournalWorkflowSection(contents)) {
    return {
      changed: false,
      message:
        "Journal workflow guidance already present in AGENTS.md.",
    };
  }

  const sectionLines = [
    JOURNAL_WORKFLOW_HEADING,
    `<!-- slug: ${JOURNAL_WORKFLOW_SLUG} -->`,
    "",
    "CommitSmith relies on `.ai-commit-journal.yml` to store Codex-authored change summaries. Run the initializer command `CommitSmith: Initialize CommitSmith` (`commitSmith.initializeRepo`) if this file is missing.",
    "> These instructions describe the human workflow. Automated Codex runs in read-only sandboxes must not attempt to execute `commit-smith` commands; they should only produce the requested outputs while humans record journal entries.",
    "",
    "At the end of each task, Codex MUST append journal entries via the CLI (CommitSmith never self-appends). Include at least one `--file <path>` flag (repeat for every impacted file) and add `--meta key=value` flags to capture scope, tickets, or other context when available:",
    "```bash",
    'commit-smith journal --append "feat: add payment retries" --file src/payments/retries.ts --file src/payments/utils.ts --meta scope=payments --meta ticket=T123',
    "# or, if you prefer invoking the bundled script:",
    'node ./bin/commit-smith.js journal --append "feat: add payment retries" --file src/payments/retries.ts --file src/payments/utils.ts --meta scope=payments --meta ticket=T123',
    "```",
    "Prefer the bundled script in this repository to avoid npm cache or sandbox issues. If you need to fall back to `npx`, set a writable cache (for example `npm_config_cache=.npm-cache`) so it succeeds in restricted environments.",
    "",
    "Keep the `meta` section fresh with `--meta key=value` updates. Common keys include `scope`, `ticket`, `ticketFromBranch` (use `true`/`false`), and `style`, but feel free to add others when they provide useful context.",
    "",
    "Re-run the initializer after repo resets or whenever `.ai-commit-journal.yml`, `.gitignore`, or this guidance disappears.",
    "",
  ];

  const prefix =
    contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  const separator = contents.trim().length > 0 ? "\n\n" : "";
  let updated = contents;
  if (prefix) {
    updated += prefix;
  }
  if (separator) {
    updated += separator;
  }
  updated += sectionLines.join("\n");
  if (!updated.endsWith("\n")) {
    updated += "\n";
  }

  await fs.writeFile(agentsPath, updated, "utf8");

  return {
    changed: true,
    message:
      "Added CommitSmith journal workflow guidance to AGENTS.md.",
  };
}

export const AgentsGuidance = {
  JOURNAL_WORKFLOW_HEADING,
  JOURNAL_WORKFLOW_SLUG,
  ensureJournalWorkflowSection,
  hasJournalWorkflowSection,
};
