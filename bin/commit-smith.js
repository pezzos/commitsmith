#!/usr/bin/env node

const { runCli } = require('../dist/cli/journal.js');

runCli(process.argv.slice(2)).catch((error) => {
  console.error(`CommitSmith CLI failed: ${error.message}`);
  process.exitCode = 1;
});
