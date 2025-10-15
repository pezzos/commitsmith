#!/usr/bin/env node

(async () => {
  const pipeline = await import('../dist/pipeline.js');
  const exportsExist = ['runPipeline'].every((key) => typeof pipeline[key] === 'function');
  if (!exportsExist) {
    throw new Error('Pipeline exports missing expected functions');
  }
  console.info('Pipeline smoke test passed');
})();
