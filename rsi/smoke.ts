import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDriver } from '../adapters/driver/index.js';
import { atomicWrite } from '../skill/files.js';
import { runCycle } from './loop.js';
import type { CaseResult, Evaluator, HarnessConfig } from './loop.js';

export interface RsiSmokeOptions { headless?: boolean; maxMutations?: number; historyLimit?: number }
/** Real browser proof on a loopback-only, credential-free fixture; no model calls. */
export async function rsiSmoke(outputDir: string, options: RsiSmokeOptions = {}): Promise<unknown> {
  if ((options.maxMutations ?? 2) < 2) throw new Error('The promotion/rejection demo requires a mutation budget of at least two');
  const workspace = join(resolve(outputDir), `smoke-${randomUUID()}`);
  await mkdir(join(workspace, 'rsi'), { recursive: true, mode: 0o700 });
  const before: HarnessConfig = { selector: '#obsolete-credential', timeoutMs: 500, paceMs: 0 };
  await atomicWrite(join(workspace, 'rsi', 'harness.json'), `${JSON.stringify(before, null, 2)}\n`);
  const screenshots: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    if (path !== '/fast-one' && path !== '/fast-two' && path !== '/slow') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><head><title>Owned local RSI fixture</title></head>
<body><h1>Authorized local browser fixture</h1><button id="reveal">Reveal fixture credential</button>
<script>document.querySelector('#reveal').addEventListener('click', () => {
  setTimeout(() => { const result = document.createElement('div'); result.id = 'credential';
  result.textContent = 'local-fixture-credential-not-a-provider-key'; document.body.append(result); }, ${path === '/slow' ? 5_000 : 0});
}, {once: true});</script></body></html>`);
  });
  try {
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', listening.reject); listening.resolve(); });
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback fixture did not acquire a TCP address');
    const origin = `http://127.0.0.1:${address.port}`;
    const evaluate: Evaluator = async ({ harness, cases, evidenceDir }) => {
      const results: CaseResult[] = [];
      for (const item of cases) {
        const profile = await mkdtemp(join(tmpdir(), 'freeapi-rsi-profile-'));
        try {
          const driver = await createDriver('playwright', {
            allowedOrigins: [origin], headless: options.headless ?? true, profilePath: profile,
            timeoutMs: harness.timeoutMs, paceMs: harness.paceMs,
          });
          try {
            const started = performance.now();
            let result: CaseResult;
            try {
              await driver.goto(`${origin}/${item.id}`);
              await driver.click('#reveal');
              const credential = await driver.read(harness.selector);
              if (credential !== 'local-fixture-credential-not-a-provider-key') throw new Error('Fixture credential mismatch');
              result = { caseId: item.id, success: true, elapsedMs: performance.now() - started, humanInterventions: 0 };
            } catch (error) {
              result = {
                caseId: item.id, success: false, elapsedMs: performance.now() - started, humanInterventions: 0,
                failure: harness.selector !== '#credential'
                  ? { kind: 'selector', message: `Fixture selector failed: ${String(error)}`, selectorFallback: '#credential' }
                  : { kind: 'timeout', message: `Fixture delayed result exceeded wait: ${String(error)}`, suggestedMs: harness.timeoutMs * 2 },
              };
            }
            const screenshotPath = join(evidenceDir, `${item.id}.png`);
            screenshots.push(await driver.screenshot(screenshotPath));
            results.push(result);
          } finally { await driver.close(); }
        } finally { await rm(profile, { recursive: true, force: true }); }
      }
      return results;
    };
    const cycle = await runCycle({
      workspace,
      cases: [{ id: 'fast-one' }, { id: 'fast-two' }, { id: 'slow' }],
      evaluate, maxMutations: 2, historyLimit: options.historyLimit,
      // Ignore wall-clock jitter for this proof: unchanged success is a tied score,
      // so a longer timeout that still cannot reveal the slow case is rejected.
      weights: { successRate: 100, medianTimeToKeySeconds: 0, humanInterventions: 10 },
    });
    const promoted = cycle.probes.find(probe => probe.outcome === 'promoted');
    const rejected = cycle.probes.find(probe => probe.outcome === 'rejected');
    assert.ok(promoted, 'Real browser smoke must demonstrate a promotion');
    assert.ok(rejected, 'Real browser smoke must demonstrate a rejected candidate');
    assert.equal(promoted.mutation.field, 'selector');
    assert.equal(rejected.mutation.field, 'timeoutMs');
    assert.ok(promoted.candidate && promoted.candidate.score > promoted.baseline.score);
    assert.equal(cycle.final.timeoutMs, before.timeoutMs);
    const after = JSON.parse(await readFile(join(workspace, 'rsi', 'harness.json'), 'utf8')) as HarnessConfig;
    assert.deepEqual(after, cycle.final);
    const proof = {
      implementation: cycle.implementation, workspace, fixtureOrigin: origin,
      before, after, promoted, rejected, screenshots,
      evidencePath: cycle.evidencePath, cycle,
      safety: { loopbackOnly: true, temporaryProfiles: true, providerAccountsUsed: false, paidModelCalls: 0 },
    };
    await atomicWrite(join(workspace, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
    return proof;
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      const stopped = Promise.withResolvers<void>();
      server.close(error => error ? stopped.reject(error) : stopped.resolve());
      await stopped.promise;
    }
  }
}
