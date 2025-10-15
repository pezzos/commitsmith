#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import http from 'node:http';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

interface StubWorkspaceConfig {
  [key: string]: unknown;
}

const configStore: StubWorkspaceConfig = {
  'codex.model': 'gpt-5-codex-test',
  'codex.timeoutMs': 5000
};

const logEntries: string[] = [];
const fallbackEvents: unknown[] = [];

class EventEmitter<T> {
  #listeners = new Set<(value: T) => void>();

  event = (listener: (value: T) => void) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value: T) {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }
}

const moduleLoad = Module._load;
(Module._load as unknown as (request: string, parent: Module | null, isMain: boolean) => unknown) = function mockedLoad(
  request,
  parent,
  isMain
) {
  if (request === 'vscode') {
    return {
      EventEmitter,
      window: {
        createOutputChannel() {
          return { appendLine: (value: string) => logEntries.push(value) };
        }
      },
      workspace: {
        getConfiguration(namespace: string) {
          if (namespace !== 'commitSmith') {
            throw new Error(`Unexpected config namespace ${namespace}`);
          }
          return {
            get<T>(key: string, defaultValue: T): T {
              return (configStore[key] as T) ?? defaultValue;
            }
          };
        },
        onDidChangeConfiguration() {
          return { dispose() {} };
        }
      }
    };
  }
  return moduleLoad.call(this, request, parent, isMain);
};

function defaultHandler(req: http.IncomingMessage, res: http.ServerResponse, body: any) {
  if (req.method === 'POST' && req.url === '/commit') {
    if (shouldFailNextRequest) {
      shouldFailNextRequest = false;
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'unavailable' }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: `Commit: ${(body.payload?.journal?.current ?? []).join(', ')}` }));
    return;
  }

  if (req.method === 'POST' && req.url === '/fix') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        diff: `--- a/${body.payload?.filePath}\n+++ b/${body.payload?.filePath}\n@@\n-${body.payload?.errorMessage}\n+fixed`,
        meta: { producedBy: 'codex-test', step: body.payload?.step }
      })
    );
    return;
  }

  res.statusCode = 404;
  res.end();
}

let requestHandler = defaultHandler;

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.statusCode = 404;
    return res.end();
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

  requestHandler(req, res, body);
});

let shouldFailNextRequest = false;

await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as http.AddressInfo).port;
configStore['codex.endpoint'] = `http://127.0.0.1:${port}`;

try {
  const codexModule = await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/codex'));
  const { generateCommitMessage, generateFix, onCodexOfflineFallback } = codexModule;

  const fallbackSubscription = onCodexOfflineFallback((event: unknown) => fallbackEvents.push(event));

  const message = await generateCommitMessage({ current: ['feat: add tests'], meta: {} });
  assert.equal(message, 'Commit: feat: add tests');

  const patch = await generateFix({ filePath: 'src/app.ts', errorMessage: 'lint failure', step: 'tests' });
  assert.equal(patch.kind, 'unified-diff');
  assert.match(patch.diff, /--- a\/src\/app.ts/);
  assert.equal(patch.meta?.producedBy, 'codex-test');
  assert.equal(patch.meta?.step, 'tests');

  requestHandler = (req, res, body) => {
    if (req.method === 'POST' && req.url === '/fix') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          diff: `--- /dev/null\n+++ b/${body.payload?.filePath}\n@@\n+${body.payload?.errorMessage}`,
          meta: { producedBy: 'codex-test', step: body.payload?.step }
        })
      );
      return;
    }

    defaultHandler(req, res, body);
  };

  const createPatch = await generateFix({ filePath: 'src/new-file.ts', errorMessage: 'missing file', step: 'format' });
  assert.match(createPatch.diff, /--- \/dev\/null/);
  assert.match(createPatch.diff, /\+\+\+ b\/src\/new-file.ts/);

  requestHandler = (req, res, body) => {
    if (req.method === 'POST' && req.url === '/fix') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          diff: `--- a/${body.payload?.filePath}\n+++ /dev/null\n@@\n-${body.payload?.errorMessage}\n-fixed`
        })
      );
      return;
    }

    defaultHandler(req, res, body);
  };

  const deletePatch = await generateFix({ filePath: 'src/old-file.ts', errorMessage: 'remove file' });
  assert.match(deletePatch.diff, /\+\+\+ \/dev\/null/);

  requestHandler = (req, res, body) => {
    if (req.method === 'POST' && req.url === '/fix') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          diff: '--- a/../secret\n+++ b/../secret\n@@\n-test\n+test'
        })
      );
      return;
    }

    defaultHandler(req, res, body);
  };

  let invalidDiffThrown = false;
  try {
    await generateFix({ filePath: 'src/app.ts', errorMessage: 'lint failure', step: 'format' });
  } catch (err) {
    invalidDiffThrown = true;
    assert.match((err as Error).message, /repository-relative/);
  }
  assert.equal(invalidDiffThrown, true);
  requestHandler = defaultHandler;

  shouldFailNextRequest = true;
  let failureCaught = false;
  try {
    await generateCommitMessage({ current: ['feat: failure'], meta: {} });
  } catch (error) {
    failureCaught = true;
    assert.match((error as Error).message, /HTTP/);
  }
  assert.equal(failureCaught, true);
  assert.equal(fallbackEvents.length > 0, true);
  const fallbackEvent = fallbackEvents[0] as { reason: string; status?: number };
  assert.equal(fallbackEvent.reason, 'http');
  assert.equal(fallbackEvent.status, 503);

  fallbackSubscription.dispose();

  assert.equal(logEntries.length > 0, true);
  console.info('Codex client tests passed');
} finally {
  server.close();
  Module._load = moduleLoad;
}
