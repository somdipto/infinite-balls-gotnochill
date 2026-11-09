import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { atomicWrite } from '../skill/files.js';
import { upstreamFixture } from './upstream.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(root, 'bin', 'skill.mjs');
const temporary = await mkdtemp(join(tmpdir(), 'freeapi-cli-smoke-'));
const upstream = await upstreamFixture();
const checks: string[] = [];
let proxyChild: ReturnChild | undefined;
interface ReturnChild { child: ChildProcessWithoutNullStreams; exit: Promise<number | null>; configured: Promise<string>; output: () => string }

function launch(args: string[], input?: string): ReturnChild {
  const child = spawn(process.execPath, [binary, ...args], { cwd: temporary, env: { ...process.env, HOME: temporary, FREEAPI_VAULT_KEY: undefined }, stdio: ['pipe', 'pipe', 'pipe'] });
  const { promise: exit, resolve: done, reject: failed } = Promise.withResolvers<number | null>();
  const { promise: configured, resolve: ready } = Promise.withResolvers<string>();
  let output = ''; let pending = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString(); output += text; pending += text;
    const lines = pending.split('\n'); pending = lines.pop() ?? '';
    for (const line of lines) { try { const event: unknown = JSON.parse(line); if (event && typeof event === 'object' && 'cause' in event && event.cause === 'configured' && 'baseUrl' in event && typeof event.baseUrl === 'string') ready(event.baseUrl); } catch { /* non-event output is retained */ } }
  });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.once('error', failed); child.once('exit', done);
  child.stdin.end(input);
  return { child, exit, configured, output: () => output };
}

async function command(args: string[], input?: string): Promise<string> {
  const result = launch(args, input);
  const code = await result.exit;
  assert.equal(code, 0, `CLI ${args[0]} failed: ${result.output()}`);
  return result.output();
}

try {
  await command(['install']); await command(['install']);
  checks.push('fresh-directory install is idempotent');
  const config = { version: 1, proxy: { port: 0 }, request: { maxWaitMs: 1500, timeoutMs: 10000 }, quotaPollMs: 500 };
  await atomicWrite(join(temporary, 'skill.config.yaml'), stringify(config));
  const recipe = { version: 1, name: 'third-fixture', authClass: 'existing-key', signupUrl: upstream.baseUrl, keysUrl: upstream.baseUrl, apiBaseUrl: `${upstream.baseUrl}/v1`, defaultModel: 'free/fixture', freeModelIds: ['free/fixture'], requiredModelPrefix: 'free/', quotaProbe: null, limits: { resetUtcHour: 0 }, riskNotes: ['Loopback-only synthetic smoke fixture'] };
  await atomicWrite(join(temporary, 'platforms/third-fixture.yaml'), stringify(recipe));
  await command(['run', '--platform', 'third-fixture', '--dry']);
  checks.push('third platform loaded from YAML only');
  const importOutput = await command(['import-key', '--platform', 'third-fixture', '--account', 'owner', '--stdin'], upstream.acceptedKey);
  assert.ok(!importOutput.includes(upstream.acceptedKey));
  await command(['resume', '--platform', 'third-fixture']);
  checks.push('stdin credential import and resumable local configuration');
  proxyChild = launch(['run', '--platform', 'third-fixture']);
  const { promise: deadline, reject: timeout } = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout(new Error('CLI proxy failed to configure')), 15000);
  let baseUrl: string;
  try { baseUrl = await Promise.race([proxyChild.configured, deadline, proxyChild.exit.then(() => { throw new Error('CLI proxy exited before ready'); })]); }
  finally { clearTimeout(timer); }
  const token = await readFile(join(temporary, '.freeapi/proxy.token'), 'utf8');
  const complete = async (model = 'free/fixture') => fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'fixture' }] }) });
  const response = await complete(); assert.equal(response.status, 200); assert.ok((await response.text()).includes('fixture-ok'));
  checks.push('actual CLI starts authenticated loopback proxy and serves completion');
  const denied = await complete('paid/fixture'); assert.equal(denied.status, 400); await denied.text();
  checks.push('paid-model request denied before upstream');
  upstream.acceptedKey = 'sk-fixture-authorized-0002';
  await command(['import-key', '--platform', 'third-fixture', '--account', 'owner', '--stdin'], upstream.acceptedKey);
  const hot = await complete(); assert.equal(hot.status, 200); await hot.text();
  assert.equal(upstream.observations.at(-1)?.authorization, `Bearer ${upstream.acceptedKey}`);
  checks.push('same-account credential replaced without restarting proxy or client');
  upstream.responses.push({ status: 429, retryAfter: '1' });
  const limited = await complete(); assert.equal(limited.status, 200); await limited.text();
  const recent = upstream.observations.slice(-2); assert.ok(recent[0] && recent[1] && recent[1].at - recent[0].at >= 990);
  checks.push('429 Retry-After honored before successful same-key retry');
  upstream.stream = true;
  const stream = await complete(); const reader = stream.body?.getReader(); assert.ok(reader);
  const first = await reader.read(); assert.ok(new TextDecoder().decode(first.value).includes('first')); assert.ok(!new TextDecoder().decode(first.value).includes('[DONE]'));
  let rest = ''; for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); } assert.ok(rest.includes('[DONE]'));
  upstream.stream = false;
  checks.push('SSE streamed before upstream completion');
  upstream.responses.push({ status: 402 });
  const exhausted = await complete(); assert.equal(exhausted.status, 503); assert.ok((await exhausted.text()).includes('capacity_unavailable'));
  checks.push('402 without near reset reports honest bounded capacity failure');
  const inventory = await readFile(join(temporary, '.freeapi/vault/credentials.md'), 'utf8');
  assert.ok(!inventory.includes(upstream.acceptedKey)); assert.ok(!proxyChild.output().includes(upstream.acceptedKey));
  const evidence = { ok: true, checks, providerAccountsUsed: false, realProviderClaimsVerified: false };
  await atomicWrite(join(root, 'artifacts', 'smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (proxyChild) { proxyChild.child.kill('SIGTERM'); await proxyChild.exit; }
  await upstream.close();
  await rm(temporary, { recursive: true, force: true });
}
